# -*- coding: utf-8 -*-
"""JVM 子进程桥 — 加载 TVBox JAR spider 并暴露 JSON-RPC 五方法接口。

架构对标项目已有的 PythonBridge（python-bridge.js）与 mpv IPC：
- 常驻 JVM 子进程（`java -jar spider-runner.jar <jar-path>`）
- 换行分隔 JSON 请求/响应
- 崩溃指数退避重启

关键设计：JarBridge 按 jar 文件共享，不按站点。
同一 jar 文件（如 fm.jar）的所有 csp_XXX 站点共用一个 JVM 子进程，
SpiderRunner 在 params.class_name 中接收目标类名，避免每个站点派生 JVM。
"""
import json
import os
import re
import shutil
import base64
import hashlib
import socket
import subprocess
import threading
import time
import logging
from collections import OrderedDict
from urllib.parse import urljoin


import hoststate
from runtime.errors import RuntimeError as RuntimeContractError
from runtime.contracts import current_runtime_request
import http_client
import java_probe

logger = logging.getLogger('yuki.jar')


class JarProxyBody:
    """JVM ProxyStream 的 file-like 客体。

    JVM 控制帧只返回一次性 loopback 端口；真正的视频字节在这里按 read(size)
    拉取，因此 FastAPI/Starlette 不会把整部网盘视频缓存在 Python 内存。
    """

    def __init__(self, host, port, token, connect_timeout=15):
        self._socket = socket.create_connection((host, int(port)), timeout=connect_timeout)
        self._socket.settimeout(None)
        self._file = self._socket.makefile('rb')
        self._closed = False
        self._socket.sendall((str(token) + '\n').encode('ascii'))

    def read(self, size=-1):
        if self._closed:
            return b''
        if size is None or size < 0:
            chunks = []
            while True:
                chunk = self._file.read(64 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return b''.join(chunks)
        return self._file.read(size)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._file.close()
        except Exception:
            pass
        try:
            self._socket.close()
        except Exception:
            pass

    @property
    def closed(self):
        return self._closed

CALL_TIMEOUT = 60


def _runtime_budget_seconds(default=CALL_TIMEOUT):
    request = current_runtime_request()
    if request is None:
        return float(default)
    request.raise_if_cancelled()
    return max(0.001, min(float(default), request.remaining_ms / 1000.0))
_id_lock = threading.Lock()
_id_counter = 0


def _next_id():
    global _id_counter
    with _id_lock:
        _id_counter += 1
        return _id_counter


def _runtime_trace_fields():
    try:
        from runtime.contracts import current_runtime_request
        request = current_runtime_request()
        if request is not None:
            return {
                'requestId': request.request_id,
                'playSessionId': request.play_session_id,
            }
    except Exception:
        pass
    return {'requestId': '', 'playSessionId': ''}


def _is_md5(s):
    return len(s) == 32 and all(c in '0123456789abcdefABCDEF' for c in s)


# P1-4：SpiderRunner.seedCookieFiles 把 quark/uc/bili/189/diy 五个网盘 Cookie
# 明文写入 ~/.yuki/jar-cache/TVBox/*_cookie.txt（FongMi 蜘蛛读取登录态的约定
# 路径）。优雅退出由 Java shutdown hook 的 deleteCacheDir 清理；但 Windows 的
# TerminateProcess 不执行 hook——强杀（超时/写失败/崩溃重启）后必须由本侧
# 补删，否则登录态永久残留用户主目录。只删 TVBox 子目录下的 cookie 文件，
# 不动 jar-cache 里内容寻址的 jar 缓存；清理失败静默吞掉，绝不影响主流程。
# 路径必须与 Java 侧 cacheRoot()（user.home/.yuki/jar-cache/TVBox）逐层一致：
# Java 读 System.getProperty("user.home")，不受 YUKI_CACHE_DIR 影响，因此这里
# 不能用 hoststate.get_cache_dir()（默认多一层 cache/，清理会恒空转）。
_JVM_COOKIE_DIR = os.path.join(os.path.expanduser('~'), '.yuki', 'jar-cache', 'TVBox')
_cookie_cleanup_lock = threading.Lock()

# H-1：Java 侧 seedCookieFiles（jar-runner/SpiderRunner.java:526-550）写的是
# **裸名**文件（固定文件名，位于所有 JVM 共享的 TVBox/ 目录），不是带 jar
# 摘要的名字——此前按 jar 清理只构造 `{basename}_{sha1}_cookie.txt`，永远
# 命中不了 Java 实际写出的文件，P1-4 的强杀清理实质落空。裸名文件全局共享，
# 清理它必须满足前提：目标 JVM 已确认退出，且注册表中同 jar 再无其它存活桥。
_BARE_JVM_COOKIE_NAMES = (
    'quark_cookie.txt', 'uc_cookie.txt', 'bili_cookie.txt',
    '189_cookie.txt', 'diy_cookie.txt',
)


def cleanup_jvm_cookie_files(jar_path='', bare=False):
    """清理 TVBox/*_cookie.txt 明文登录态（幂等，可并发调用）。

    - 不传 jar_path：全局兜底（应用退出等场景，此时不应有存活 JVM）——清理
      目录内所有 ``*_cookie.txt``；
    - 传 jar_path 且 bare=False：只清理「该 jar 专属」的摘要名文件
      （``{basename}_{sha1}_cookie.txt``，与 _download_jar_locked 的缓存命名
      同构）。多 jar 并存时 TVBox/cookie 目录是所有 JVM 共享的，摘要名清理
      不会误伤其他 jar 的登录态；
    - 传 jar_path 且 bare=True：追加清理上面五个**裸名**文件——只有裸名清理
      能命中 Java 实际写出的文件（H-1）。裸名文件全局共享，该模式仅允许在
      强杀路径、确认目标 JVM 已死且同 jar 无其它存活桥时使用（见
      :meth:`JarBridge._cleanup_cookie_files_after_kill`）。

    TVBox 生态 jar 同名极多（spider.jar），文件名用「basename + 路径短摘要」
    做标识。清理失败静默吞掉——宁少删，不误删存活 JVM 的登录态，绝不影响
    主流程。
    """
    with _cookie_cleanup_lock:
        try:
            if not os.path.isdir(_JVM_COOKIE_DIR):
                return
            names = set()
            if jar_path:
                base = os.path.basename(jar_path).lower()
                digest = hashlib.sha1(jar_path.encode('utf-8', 'replace')).hexdigest()[:10]
                names.add(f'{base}_{digest}_cookie.txt')
                if bare:
                    names.update(_BARE_JVM_COOKIE_NAMES)
            else:
                # 全局兜底：清理所有 jar 的 cookie 文件（应用退出等场景）
                try:
                    for name in os.listdir(_JVM_COOKIE_DIR):
                        if name.lower().endswith('_cookie.txt'):
                            names.add(name)
                except OSError:
                    return
                if not names:
                    return
            for name in names:
                try:
                    os.remove(os.path.join(_JVM_COOKIE_DIR, name))
                except OSError:
                    pass
        except Exception:
            pass


def _reap(proc):
    """等强杀的子进程真正退出（H-1：裸名 cookie 清理的前置条件）。

    TerminateProcess 是异步的——kill() 返回不代表进程已消失，Java 侧可能仍
    持有 TVBox/cookie 文件句柄（Windows 上句柄未释放时删除会静默失败）。
    上限 3s；超时放弃等待（后续裸名清理仍执行，幂等删除无害）。测试注入的
    proc 替身没有 poll/wait 语义时按「已退出」处理，跳过等待。
    """
    try:
        try:
            proc.wait(timeout=3.0)
        except Exception:
            pass
        for _ in range(100):
            try:
                if proc.poll() is not None:
                    return
            except Exception:
                return
            time.sleep(0.03)
    except Exception:
        pass


# vendor 资产根：开发模式为仓库根 vendor/，打包模式为 resources/vendor/
# （经 hoststate.resources_root 解析——冻结产物里 __file__ 在 _internal/ 下，
# 向上一级是 exe 目录，那里没有 vendor，直接拼路径会全部落空）
DEFAULT_RUNNER_JAR = os.path.join(hoststate.vendor_dir(), 'spider-runner.jar')

# dex2jar 工具（转换 Android DEX 为 JVM .class）
DEX2JAR_JAR = os.path.join(
    hoststate.vendor_dir(), 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
DEXDEPS_DIR = os.path.join(hoststate.vendor_dir(), 'dexdeps')

# jar 蜘蛛（夸克/FongMi 系）以自身 cwd 为基准写运行时状态（DuoDuo/.quark 含登录
# Cookie、FM/、VOX/、TVBox/ 等）。JVM 不设 cwd 会继承后端进程 cwd —— 历史上曾
# 因此把 Cookie 写进仓库工作区。固定到缓存目录下，并迁移历史遗留状态。
JAR_RUNTIME_STATE_DIRS = ('DuoDuo', 'FM', 'VOX', 'TVBox', 'TV')
_jar_runtime_dir_cache = None
_jar_runtime_dir_lock = threading.Lock()


def get_jar_runtime_dir():
    global _jar_runtime_dir_cache
    if _jar_runtime_dir_cache:
        return _jar_runtime_dir_cache
    with _jar_runtime_dir_lock:
        if _jar_runtime_dir_cache:
            return _jar_runtime_dir_cache
        d = os.path.join(hoststate.get_cache_dir(), 'jar-runtime')
        try:
            os.makedirs(d, exist_ok=True)
            legacy_base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            for name in JAR_RUNTIME_STATE_DIRS:
                src = os.path.join(legacy_base, name)
                dst = os.path.join(d, name)
                if os.path.isdir(src) and not os.path.exists(dst):
                    shutil.move(src, dst)
        except Exception:
            logger.exception('jar runtime dir migrate failed')
        _jar_runtime_dir_cache = d
        return d

def _scan_jar_ports(jar_path):
    """扫 jar 内容里的 127.0.0.1:<port> 字面量（任务二·机制B）。

    jar 是 zip：DEX/class 均在条目内（可能压缩），逐条解压扫描；
    非 zip（裸 dex）直接扫字节。返回端口集合（1024-65535）。
    """
    import zipfile
    pat = re.compile(rb'127\.0\.0\.1:(\d{4,5})')
    ports = set()

    def _scan(blob):
        for m in pat.finditer(blob):
            p = int(m.group(1))
            if 1024 <= p <= 65535:
                ports.add(p)

    try:
        with zipfile.ZipFile(jar_path) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > (8 << 20):
                    continue
                try:
                    _scan(z.read(info.filename))
                except Exception:
                    continue
    except Exception:
        try:
            with open(jar_path, 'rb') as f:
                _scan(f.read(8 << 20))
        except OSError:
            pass
    return ports


def classify_jar_compatibility(jar_path):
    """按可观测字节特征给 JAR/DEX 做 L0-L4 兼容性分级。

    这是加载前的诊断，不把猜测当成成功：L2/L3/L4 仍允许进入 Runner，
    但会在报告中明确指出可能需要 Android/WebView/原生/DRM 能力。
    """
    import zipfile

    signals = set()
    has_dex = False
    has_native = False

    def scan(blob):
        nonlocal has_native
        lowered = bytes(blob).lower()
        if b'android/webkit' in lowered or b'android.app' in lowered:
            signals.add('android-ui-or-webview')
        if (b'android/view' in lowered or b'android/widget' in lowered
                or b'android/content/context' in lowered):
            signals.add('android-api')
        if any(token in lowered for token in (b'widevine', b'playready', b'drm', b'media-drms')):
            signals.add('drm-or-device-license')
        if b'.so' in lowered or b'libjnidispatch' in lowered or b'jnidispatch' in lowered:
            has_native = True
            signals.add('native-library')

    try:
        with zipfile.ZipFile(jar_path) as archive:
            names = archive.namelist()
            has_dex = any(name.lower().endswith('.dex') for name in names)
            has_native = any(name.lower().endswith(('.so', '.aar')) for name in names)
            if has_dex:
                signals.add('dex')
            if has_native:
                signals.add('native-library')
            for info in archive.infolist():
                if info.is_dir() or info.file_size > (8 << 20):
                    continue
                try:
                    scan(archive.read(info.filename))
                except Exception:
                    continue
    except Exception:
        try:
            with open(jar_path, 'rb') as f:
                raw = f.read(8 << 20)
                if raw[:4] == b'dex\n':
                    has_dex = True
                    signals.add('dex')
                scan(raw)
        except OSError:
            signals.add('unreadable')

    if 'drm-or-device-license' in signals:
        level = 'L4'
    elif has_native or 'native-library' in signals:
        level = 'L3'
    elif 'android-ui-or-webview' in signals:
        level = 'L2'
    elif has_dex or 'android-api' in signals:
        level = 'L1'
    else:
        level = 'L0'
    return {
        'level': level,
        'signals': sorted(signals),
        'hasDex': bool(has_dex),
        'hasNative': bool(has_native),
    }


# 全局 jar 桥缓存：key = jar_path → JarBridge 实例
_jar_bridges = {}
_jar_bridges_lock = threading.Lock()
# 全局 JVM LRU：key = jar_path → 最近使用时间戳（monotonic）。
# OrderedDict 维护访问顺序（move_to_end 刷新），淘汰时从头部（最久未用）取。
# 与 _jar_bridges 同步维护，全部改动都在 _jar_bridges_lock 下。
_jar_lru = OrderedDict()

# 全局 JVM 子进程数量上限：每 JVM 约 1.5GB，配置多仓合并后可能有 10+ 不同 jar，
# 无上限会 OOM。默认 3，可用 YUKI_MAX_JVM / YUKI_MAX_JAR_PROCESSES 覆盖，clamp 到 1-8。
# 注意：dex2jar 的临时 java 进程是 subprocess.run 短暂进程，不受此限制。
_MAX_JVM_DEFAULT = 3


def _max_jvm():
    """懒读环境变量得到 JVM 上限，clamp 到 [1, 8]。无效/未设置回落到默认 3。"""
    raw = os.environ.get('YUKI_MAX_JVM') or os.environ.get('YUKI_MAX_JAR_PROCESSES')
    if raw:
        try:
            val = int(str(raw).strip())
        except (TypeError, ValueError):
            val = _MAX_JVM_DEFAULT
    else:
        val = _MAX_JVM_DEFAULT
    return max(1, min(8, val))


def _touch_jar_lru(jar_path):
    """刷新 jar_path 的 LRU 位置（标记为最近使用）。须在 _jar_bridges_lock 下调用。"""
    if jar_path in _jar_lru:
        _jar_lru.move_to_end(jar_path)
    else:
        _jar_lru[jar_path] = True


def _evict_jvm_if_needed_locked():
    """在插入全新 jar_path 前，若已达上限则选出可淘汰的桥并从缓存摘除。

    须在 _jar_bridges_lock 下调用；返回被摘除的 bridge（调用方须在释放
    _jar_bridges_lock 后再对其 destroy()，因为 destroy() 会重入该锁且会
    阻塞 ~1s 等 JVM 优雅退出）。无需淘汰时返回 None。

    淘汰策略：
    - 从 LRU 头部（最久未用）遍历，尝试非阻塞获取其 _call_lock；
      获取成功说明该桥当前无活跃调用，可安全淘汰；获取失败说明正在 call，跳过。
    - 找到后从 _jar_bridges/_jar_lru 摘除并返回。
    - 若所有桥都在忙（无一可淘汰），抛 L3_RUNTIME_BUSY 而非无限等待。
    """
    limit = _max_jvm()
    if len(_jar_bridges) < limit:
        return None
    logger.warning('JVM limit (%d) reached, evicting LRU jar (current=%d)',
                   limit, len(_jar_bridges))
    for old_jar in list(_jar_lru.keys()):
        victim = _jar_bridges.get(old_jar)
        if victim is None:
            # LRU 与桥缓存不一致（理论上不该发生），清理孤儿条目
            _jar_lru.pop(old_jar, None)
            continue
        if not victim._call_lock.acquire(blocking=False):
            continue  # 正在被调用，跳过
        try:
            logger.info('evicting idle LRU jar %s to free JVM slot',
                        os.path.basename(old_jar))
            _jar_bridges.pop(old_jar, None)
            _jar_lru.pop(old_jar, None)
        finally:
            victim._call_lock.release()
        return victim
    # 所有桥都在忙——池已耗尽，拒绝而非阻塞
    raise RuntimeContractError(
        'L3_RUNTIME_BUSY',
        runtime='jar',
        raw_error='jvm pool exhausted, all jvm busy',
    )

# jar 下载/转换锁：key = jar_url → Lock（并发构建同一 jar 时串行化下载与 dex2jar）
_jar_download_locks = {}
_jar_download_locks_guard = threading.Lock()


def _jar_download_lock(url):
    with _jar_download_locks_guard:
        return _jar_download_locks.setdefault(url, threading.Lock())


# 已告警过的 jar 源（按 URL 去重）：download_jar 是**按站点**调用，而 TVBox 配置里
# 几十个 csp_ 站点常共用一个 spider jar——不去重会刷几十条相同 WARNING 把真问题埋掉。
_jar_integrity_warned = set()


# jar 下载完整性策略（high#11）：jar 会被 JVM 当作代码执行（任意代码执行），
# 仅魔数校验挡不住 MITM/篡改 → RCE。默认严格模式：jar 源必须 https 且必须
# 携带 md5 校验值，二者缺一即拒绝下载执行。确需兼容明文 http/无 md5 的存量
# 配置时，可显式 opt-in 宽松模式（环境变量，与 YUKI_CONFIG_BLOCK_PRIVATE_NETWORK
# 同一注入通道——由 Electron 主进程经 python-bridge extraEnv 设置）：
#   YUKI_JAR_INSECURE_SOURCES=1
# 选择环境变量而非设置项：该开关由用户配置文件/命令行显式给出，是部署者
# 的显式决定；且与本文件既有 YUKI_MAX_JVM 等读取通道一致，不引入新的配置面。
_INSECURE_SOURCE_VALUES = ('1', 'true', 'yes')


def _allow_insecure_jar_sources():
    """宽松模式显式 opt-in 才返回 True（默认 False = 严格模式）。"""
    return os.environ.get('YUKI_JAR_INSECURE_SOURCES', '').strip().lower() \
        in _INSECURE_SOURCE_VALUES


def _assert_jar_source_integrity(jar_url, md5):
    """严格模式校验 jar 源的传输与完整性前提；不满足直接拒绝。

    - 必须 https：明文 http 源可被 MITM 实时替换任意代码，md5 校验也会被
      连同响应一起替换，毫无保护意义；
    - 必须带 md5：无校验值时内容篡改无法察觉。
    """
    if _allow_insecure_jar_sources():
        return
    scheme = str(jar_url or '').split(':', 1)[0].lower()
    if scheme != 'https':
        raise ValueError(
            '[L3:jar] insecure jar source rejected (strict mode): '
            f'jar 在 JVM 内任意代码执行，jar 源必须为 https（当前 {scheme or "无协议"}: {jar_url}）。'
            '如确认接受风险，可设置环境变量 YUKI_JAR_INSECURE_SOURCES=1 显式放宽')
    if not md5:
        raise ValueError(
            '[L3:jar] unverified jar source rejected (strict mode): '
            f'jar 源必须携带 md5 校验值（在配置 URL 后追加 ;md5，当前 {jar_url}）。'
            '如确认接受风险，可设置环境变量 YUKI_JAR_INSECURE_SOURCES=1 显式放宽')


def _warn_jar_integrity_once(jar_url):
    """无 md5 的 jar 源记一次完整性告警（每进程每 URL 一次）。"""
    if jar_url in _jar_integrity_warned:
        return
    _jar_integrity_warned.add(jar_url)
    if jar_url.split(':', 1)[0].lower() == 'http':
        logger.warning('jar 源为明文 http 且未提供 md5 校验（存在被篡改/MITM 风险，'
                       '建议改用 https 或在配置中追加 ;md5）: %s', jar_url)
    else:
        logger.warning('jar 源未提供 md5 校验（完整性不可验证，建议配置追加 ;md5）: %s', jar_url)


class JarBridge:
    """按 jar 文件共享的 JVM 子进程桥。同一 jar 的所有 csp_XXX 站点共用一个 JVM 进程。

    线程安全：同一时刻只允许一个 call 在途（跨站点的并发请求由业务层串到线程池，
    这里避免并发写 stdin 破坏 JSON-RPC 流）。等待者队列按 FIFO 依次取锁。
    """

    @staticmethod
    def get_or_create(jar_path, runner_jar=None):
        """获取或创建 jar_path 对应的桥实例（全局单例，受 YUKI_MAX_JVM 上限约束）。"""
        runner_jar = runner_jar or DEFAULT_RUNNER_JAR
        jar_path = os.path.normpath(os.path.realpath(jar_path))
        victim = None
        with _jar_bridges_lock:
            b = _jar_bridges.get(jar_path)
            if b is not None:
                _touch_jar_lru(jar_path)
                return b
            # 达到上限先选出可淘汰的空闲桥（持锁期间只摘除，真正 destroy 在锁外）
            victim = _evict_jvm_if_needed_locked()
            # 任务二·机制B：jar 加载期预启动其硬编码的本地代理端口，
            # 避免首次播放才补监听（首连失败）
            if os.environ.get('YUKI_WORKER_CONTROL_ONLY') != '1':
                try:
                    import go_proxy
                    for p in _scan_jar_ports(jar_path):
                        go_proxy.ensure_listener(p)
                except Exception:
                    pass
            report = classify_jar_compatibility(jar_path)
            logger.info('jar compatibility %s: %s', os.path.basename(jar_path), report)
            b = JarBridge(jar_path, runner_jar=runner_jar)
            _jar_bridges[jar_path] = b
            _touch_jar_lru(jar_path)
        # 锁外再真正销毁被淘汰的桥，避免在 _jar_bridges_lock 内重入阻塞 ~1s
        if victim is not None:
            try:
                victim.destroy()
            except Exception:
                pass
        return b

    @staticmethod
    def destroy_all():
        """销毁所有 JVM 子进程（应用退出 / 配置热重载时调用）。

        与 `_evict_jvm_if_needed_locked` 同一模式：持 `_jar_bridges_lock` 只摘除
        实例，真正 destroy 一律在锁外逐个进行——`destroy()` 内部要重新获取同一把
        `_jar_bridges_lock`（从全局缓存移除自己），而该锁不可重入，锁内直接
        destroy 会永久死锁（问题 #6：退出与热重载两条路径都走这里）。
        """
        with _jar_bridges_lock:
            bridges = list(_jar_bridges.values())
            _jar_bridges.clear()
            _jar_lru.clear()
        for b in bridges:
            try:
                b.destroy()
            except Exception:
                pass

    # ------------------------------------------------------------ 静态工具

    @staticmethod
    def runner_jar_path():
        """返回内置 spider-runner.jar 路径（开发/打包一致）。"""
        return DEFAULT_RUNNER_JAR

    @staticmethod
    def norm_jar_src(api):
        """把 config.api / config.spider（http 地址，可带 ;md5）规范为 (jar_url, md5, class_name)。

        TVBox / FongMi 生态中 jar 源的常见形态（分号分隔）：
        - 'https://x/y/csp_MaoYan.jar'                       → 无校验
        - 'https://x/y/csp_MaoYan.jar;abc123...'             → 2 段：url;md5
        - 'https://x/y/spider.jar;md5;abc123...'             → 3 段：url;md5标记;md5值（FongMi 标准）
        分号后的段里，'md5' 字面标记与空段忽略，取第一个 32 位十六进制作为校验值。
        返回 (jar_url, md5, class_name)；无法识别（非 http）返回 ('', '', '')。
        """
        s = str(api or '').strip()
        md5 = ''
        if ';' in s:
            parts = [p.strip() for p in s.split(';')]
            s = parts[0]
            for seg in parts[1:]:
                if not seg or seg.lower() == 'md5':
                    continue  # 跳过空段与 'md5' 字面标记
                if _is_md5(seg):
                    md5 = seg.lower()
                    break
        if not s.startswith('http'):
            return '', '', ''
        jar_url = s
        base = s.split('?')[0].rstrip('/').split('/')[-1]
        if base.lower().endswith('.jar'):
            name = base[:-4]
        else:
            name = base
        class_name = name if name.startswith('csp_') else 'csp_' + name
        return jar_url, md5, class_name

    @staticmethod
    def download_jar(jar_url, md5='', site_key='', jar_dir=None, portable_only=False):
        """下载 jar 到本地缓存目录（幂等，带 md5 校验），返回本机路径。

        若下载的 jar 包含 Android DEX（classes.dex），自动转换为 JVM .class jar
        并缓存，返回转换后的路径。
        按 URL 加锁：站点构建并发化后同一 jar 可能被多线程同时下载/转换。
        """
        with _jar_download_lock(jar_url):
            return JarBridge._download_jar_locked(
                jar_url, md5, site_key, jar_dir, portable_only=portable_only)

    @staticmethod
    def _download_jar_locked(jar_url, md5='', site_key='', jar_dir=None,
                             portable_only=False):
        import hashlib
        jar_dir = jar_dir or os.path.join(hoststate.get_cache_dir(), 'jar')
        try:
            os.makedirs(jar_dir, exist_ok=True)
        except OSError:
            pass
        # M-13：内容寻址——文件名带 URL 哈希前缀。TVBox 生态大量 jar 同名
        # （spider.jar），按裸文件名缓存会让不同源互相顶替/错用。
        base = os.path.basename(jar_url.split('?')[0]) or f'{site_key or "spider"}.jar'
        fname = hashlib.sha1(jar_url.encode('utf-8')).hexdigest()[:10] + '_' + base
        dest = os.path.join(jar_dir, fname)
        # 完整性校验（high#11）：默认严格模式必须 https + md5，缺一即拒绝下载
        # 执行（见 _assert_jar_source_integrity）。宽松模式（YUKI_JAR_INSECURE_
        # SOURCES=1）下退回旧行为：仅醒目告警不拒绝，供诊断页/用户感知（同一
        # URL 每进程只记一次）。
        if not md5:
            _warn_jar_integrity_once(jar_url)
        _assert_jar_source_integrity(jar_url, md5)
        if os.path.isfile(dest):
            if not md5 or _file_md5(dest) == md5:
                JarBridge._require_available_runtime(dest, site_key, portable_only)
                return JarBridge._ensure_jvm_compatible(dest, md5)
        raw = requests_get_jar(jar_url)
        if not raw or len(raw) < 4:
            raise ValueError(f'[L3:jar] jar download empty: {jar_url}')
        # 内容魔数校验：TVBox 生态 jar 常伪装成 .jpg/.png/.bin（防直链），
        # 必须以内容判断而非后缀。zip 魔数 PK\x03\x04 或 raw dex（dex\n035）。
        if not (raw[:2] == b'PK' or raw[:4] == b'dex\n'):
            raise ValueError(f'[L3:jar] downloaded content is not a jar archive (magic check failed): {jar_url}')
        if md5 and hashlib.md5(raw).hexdigest() != md5:
            raise ValueError(f'[L3:jar] jar md5 mismatch: {jar_url}')
        with open(dest, 'wb') as f:
            f.write(raw)
        JarBridge._require_available_runtime(dest, site_key, portable_only)
        return JarBridge._ensure_jvm_compatible(dest, md5)

    @staticmethod
    def _require_available_runtime(jar_path, site_key='', portable_only=False):
        """保留旧调用接口；桌面端统一允许进入 dex2jar/JVM 尝试路径。"""
        return

    @staticmethod
    def proxy_java_args():
        """读取系统代理（http_client 收编版），生成 JVM 代理系统属性参数列表。

        JVM 内蜘蛛的网络请求（okhttp / HttpURLConnection）默认直连，被墙站点
        （github 等）全部失败；注入 http(s).proxyHost/Port 后 okhttp 经
        ProxySelector.getDefault()、HttpURLConnection 经系统属性自动走代理。
        系统代理未启用或无可用地址时返回 []（保持直连）。
        """
        try:
            addr = http_client.system_proxy_addr()
            if not addr:
                return []
            host, port = addr
            if not host or not port:
                return []
            return [
                '-Dhttp.proxyHost=' + host,
                '-Dhttp.proxyPort=' + str(port),
                '-Dhttps.proxyHost=' + host,
                '-Dhttps.proxyPort=' + str(port),
            ]
        except Exception:
            return []

    @staticmethod
    def runtime_java_args():
        """把 FongMi ``com.github.catvod.Proxy`` 指向 PC 本机代理端口。

        该属性与上游站点的 HTTP 出站代理不同：前者是 JAR 生成播放 URL 时
        使用的本地数据面地址，必须始终存在，即使系统没有配置网络代理。
        鉴权 token 不在命令行注入（进程列表可读），见 :meth:`runtime_java_env`。
        """
        # FongMi 的 Proxy.getUrl() 应该命中 FastAPI `/proxy` 调度器，才能
        # 执行最近 JAR 的静态 Proxy；只有后端尚未绑定控制端口时才退回
        # 9978（该端口仍由 go_proxy 负责旧的直链/夸克协议）。
        try:
            port = int(hoststate.get_port() or 0)
        except Exception:
            port = 0
        if port <= 0:
            try:
                import go_proxy
                port = int(getattr(go_proxy, 'PORT', 9978))
            except Exception:
                port = 9978
        return [
            '-Dyuki.proxyHost=127.0.0.1',
            '-Dyuki.proxyPort=' + str(port),
        ]

    @staticmethod
    def runtime_java_env():
        """JVM 子进程专用环境变量（low#7）：proxyToken 经 JAVA_TOOL_OPTIONS 注入。

        此前 token 以 `-Dyuki.proxyToken=...` 命令行参数传 JVM，本机任意进程
        可从进程列表读到命令行（token 可控 /proxy 数据面）。JAVA_TOOL_OPTIONS
        是 JVM 官方文档支持的环境变量注入通道：HotSpot 启动时把其中的选项当作
        命令行**前置**选项处理，-D 定义照常生效（jar-runner 的 Proxy stub 仍读
        System.getProperty("yuki.proxyToken")，协议不变）——而环境变量只对
        子进程自身可见，不再落进程列表。代价：JVM 会在 stderr 打一行
        「Picked up JAVA_TOOL_OPTIONS: ...」（含 token），_ensure_alive 的
        pump_err 线程按前缀过滤该行，避免 token 落日志。无 token 返回 {}。
        """
        try:
            token = str(hoststate.get_token() or '')
        except Exception:
            token = ''
        if not token:
            return {}
        opts = '-Dyuki.proxyToken=' + token
        existing = os.environ.get('JAVA_TOOL_OPTIONS', '').strip()
        return {'JAVA_TOOL_OPTIONS': (existing + ' ' + opts).strip()}

    @staticmethod
    def apply_jar_patches(jar_path):
        """应用已知 jar 字节码补丁（如蜘蛛失效 CSS 选择器修复），返回实际应加载的 jar 路径。

        补丁产出 `xxx.patched.jar`（不动源文件，避免与运行中 JVM 的句柄冲突）；
        patched 文件存在且不早于源文件时直接复用。无补丁命中时返回原路径。
        """
        try:
            from jar_patch import SELECTOR_PATCHES, METHODREF_PATCHES, patch_jar
            if not jar_path or not os.path.isfile(jar_path):
                return jar_path
            try:
                import zipfile
                with zipfile.ZipFile(jar_path) as z:
                    names = set(z.namelist())
            except Exception:
                return jar_path
            needed = set(SELECTOR_PATCHES) | set(METHODREF_PATCHES)
            if not any(p in names for p in needed):
                return jar_path
            patched_path = (jar_path[:-4] + '.patched.jar') if jar_path.lower().endswith('.jar') else (jar_path + '.patched.jar')
            if os.path.isfile(patched_path) and os.path.getmtime(patched_path) >= os.path.getmtime(jar_path):
                # 原子写（M-4）兜底：patched.jar 理论上由 tmp+os.replace 产出，
                # 不会留半截文件；但历史版本是直接 'w' 写目标，崩溃残留的坏 jar
                # mtime 反而比源文件新——这里校验 zip 完整性，坏产物重打不复用。
                try:
                    import zipfile
                    with zipfile.ZipFile(patched_path) as z:
                        if z.testzip() is None:
                            return patched_path
                except Exception:
                    pass
                logger.warning('patched jar %s corrupt (stale crash residue?), re-patching',
                               os.path.basename(patched_path))
            changed = patch_jar(jar_path, patched_path, SELECTOR_PATCHES)
            if not changed:
                return jar_path
            logger.info('jar patches applied to %s: %s', os.path.basename(jar_path), changed)
            return patched_path
        except Exception as e:
            logger.warning('jar patch failed for %s: %s', jar_path, e)
            return jar_path

    @staticmethod
    def _ensure_jvm_compatible(jar_path, md5=''):
        """检查 jar 是否含 DEX；如果是，转为 JVM .class jar 并缓存。"""
        if not os.path.isfile(jar_path):
            return jar_path
        report = classify_jar_compatibility(jar_path)
        if report.get('level') in ('L2', 'L3', 'L4'):
            logger.warning('jar %s compatibility %s (%s)',
                           os.path.basename(jar_path), report.get('level'),
                           ', '.join(report.get('signals') or []))
        # 快速检查：zip 中是否有 classes.dex
        import zipfile
        try:
            with zipfile.ZipFile(jar_path) as z:
                names = z.namelist()
                has_dex = any(n.endswith('.dex') for n in names)
                if not has_dex:
                    return JarBridge.apply_jar_patches(jar_path)  # 已经是标准 JVM jar
        except Exception:
            return jar_path
        # 需要转换：jvm 缓存路径 = 原路径去掉 .jar 加 -jvm.jar
        base = jar_path.rsplit('.', 1)[0]
        jvm_path = base + '-jvm.jar'
        tmp_jvm_path = base + '-jvm.jar.tmp'
        # M-14：源 jar 更新（md5 变化重新下载）后，旧转换产物必须失效——
        # 否则永远加载旧版类，表现为"更新配置不生效"
        if os.path.isfile(jvm_path) and os.path.getmtime(jvm_path) >= os.path.getmtime(jar_path):
            return JarBridge.apply_jar_patches(jvm_path)
        # 用 dex2jar 转换
        d2j_jar = DEX2JAR_JAR
        if not os.path.isfile(d2j_jar):
            # 尝试找 lib 目录下的所有 jar（老版本结构）
            d2j_dir = os.path.dirname(os.path.dirname(DEX2JAR_JAR))
            lib_dir = os.path.join(d2j_dir, 'lib')
            if os.path.isdir(lib_dir):
                cp = [os.path.join(lib_dir, f) for f in os.listdir(lib_dir) if f.endswith('.jar')]
                main_class = 'com.googlecode.dex2jar.tools.Dex2jarCmd'
            else:
                logger.error('dex2jar not found at %s, cannot convert DEX jar %s', d2j_jar, jar_path)
                raise RuntimeContractError(
                    'L3_RUNTIME_INIT_FAILED',
                    runtime='jar',
                    raw_error=f'dex2jar tools not found for converting DEX jar: {os.path.basename(jar_path)}',
                )
        else:
            cp = [d2j_jar]
            # 加上 lib 下其他 jar（依赖）
            d2j_dir = os.path.dirname(os.path.dirname(DEX2JAR_JAR))
            lib_dir = os.path.join(d2j_dir, 'lib')
            if os.path.isdir(lib_dir):
                for f in os.listdir(lib_dir):
                    if f.endswith('.jar') and f != 'dex-tools-v2.4.jar':
                        cp.append(os.path.join(lib_dir, f))
            main_class = 'com.googlecode.dex2jar.tools.Dex2jarCmd'
        java_bin = java_probe.find_java()
        if not java_bin:
            logger.error('no java runtime for dex2jar, cannot convert DEX jar %s', jar_path)
            raise RuntimeContractError(
                'L3_RUNTIME_INIT_FAILED',
                runtime='jar',
                raw_error=f'Java runtime not found for dex2jar conversion: {os.path.basename(jar_path)}',
            )
        classpath = os.pathsep.join(cp)
        # 先输出到临时文件，完成后原子重命名；若失败或异常立即清理临时文件
        if os.path.isfile(tmp_jvm_path):
            try:
                os.remove(tmp_jvm_path)
            except OSError:
                pass
        cmd = [java_bin, '-cp', classpath, main_class, '-o', tmp_jvm_path, jar_path]
        try:
            # creationflags：GUI 宿主下隐藏 java 子进程的控制台窗口（闪黑窗）
            r = subprocess.run(cmd, capture_output=True, timeout=120,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if r.returncode != 0:
                err_msg = r.stderr.decode('utf-8', 'replace')[:300]
                logger.error('dex2jar failed for %s (exit code %d): %s', jar_path, r.returncode, err_msg)
                raise RuntimeContractError(
                    'L3_RUNTIME_INIT_FAILED',
                    runtime='jar',
                    raw_error=f'dex2jar conversion failed (code {r.returncode}): {err_msg}',
                )
            if os.path.isfile(tmp_jvm_path):
                os.replace(tmp_jvm_path, jvm_path)
                logger.info('dex2jar ok: %s -> %s', os.path.basename(jar_path), os.path.basename(jvm_path))
                return JarBridge.apply_jar_patches(jvm_path)
            raise RuntimeContractError(
                'L3_RUNTIME_INIT_FAILED',
                runtime='jar',
                raw_error=f'dex2jar output missing: {os.path.basename(jvm_path)}',
            )
        except subprocess.TimeoutExpired as te:
            logger.error('dex2jar timed out for %s after 120s', jar_path)
            raise RuntimeContractError(
                'L3_RUNTIME_TIMEOUT',
                runtime='jar',
                raw_error=f'dex2jar conversion timed out after 120s: {os.path.basename(jar_path)}',
            ) from te
        except RuntimeContractError:
            raise
        except Exception as e:
            logger.error('dex2jar exception for %s: %s', jar_path, e)
            raise RuntimeContractError(
                'L3_RUNTIME_INIT_FAILED',
                runtime='jar',
                raw_error=f'dex2jar conversion error: {e}',
            ) from e
        finally:
            if os.path.isfile(tmp_jvm_path):
                try:
                    os.remove(tmp_jvm_path)
                except OSError:
                    pass

    @staticmethod
    def map_class_name(jar_path, api_class_name):
        """把 TVBox 类名（csp_XXX）映射到 jar 中的实际全限定名。

        标准 TVBox jar 中类位于 com.github.catvod.spider.XXX。
        若 jar 中有该路径的类，返回映射后的全名；否则原样返回 api。
        """
        name = api_class_name
        if name.startswith('csp_'):
            candidate = 'com.github.catvod.spider.' + name[4:]
            try:
                import zipfile
                with zipfile.ZipFile(jar_path) as z:
                    if candidate.replace('.', '/') + '.class' in z.namelist():
                        return candidate
            except Exception:
                pass
        return name

    def __init__(self, jar_path, runner_jar=None, class_name=''):
        self.jar_path = jar_path
        # 默认类名（SpiderRunner 启动时预加载用；请求时可用 params.class_name 覆盖）
        self.class_name = class_name
        self.runner_jar = runner_jar or DEFAULT_RUNNER_JAR
        # M-12：构造即建锁（此前类体里有两个 __init__，生效的那个没有锁，
        # call() 懒初始化在并发首调时会各建各的锁、同时写 stdin 破坏协议流）
        self._call_lock = threading.RLock()  # 可重入锁；auto-init 内部再 call 不阻塞
        self.proc = None
        self._lock = threading.Lock()
        self._pending = {}
        self._buf = b''
        self._last_error = ''
        # M-27a：连续失败计数——需要重新拉起（崩溃/启动失败/被 kill）一律 +1，
        # 成功调用清零，>3 拒绝再拉起（取代原先会被 _kill_proc 重置的 _started/_restart_count）
        self._crash_count = 0
        # destroy() 置位：置位后 _ensure_alive 拒绝再拉起 JVM（防止销毁后
        # 残留引用的 call() 把"孤儿桥"重新孵化出来）
        self._destroyed = False

    # ------------------------------------------------------------ 进程管理

    def _ensure_alive(self):
        """确保 JVM 子进程就绪；返回 bool。

        对 DEX 转换后的 jar（名称含 -jvm），自动添加 vendor/dexdeps/ 下的
        依赖库（okhttp3、org.json、kotlin等）到 classpath，以 -cp 模式启动。
        SpiderRunner 只接收 jar_path 作为 CLI 参数，className 在每次请求的 params 中传递。
        """
        with self._lock:
            # destroy() 后拒绝再拉起：销毁是终态，残留引用 call() 不能孵化孤儿 JVM
            if self._destroyed:
                self._last_error = 'jar bridge destroyed'
                return False
            if self.proc and self.proc.poll() is None:
                return True
            # 需要重新拉起（进程已死 / 上次启动失败 / 被 kill）：一律计入崩溃
            # 计数，成功调用才会清零——杜绝坏 jar 无限重启循环（M-27a）
            self.proc = None
            self._crash_count += 1
            if self._crash_count > 3:
                self._last_error = 'jar restart limit exceeded (3)'
                return False
            time.sleep(min(1.0 * self._crash_count, 5.0))
            java_bin = java_probe.find_java()
            if not java_bin:
                self._last_error = 'no-java-runtime'
                return False
            if not os.path.isfile(self.runner_jar):
                self._last_error = f'missing spider-runner.jar at {self.runner_jar}'
                return False
            if not os.path.isfile(self.jar_path):
                self._last_error = f'jar not found: {self.jar_path}'
                return False

            # 判断是否为 DEX 转换后的 jar（需要 dexdeps；含补丁产物 -jvm.patched.jar）
            needs_deps = '-jvm' in self.jar_path.lower()
            proxy_args = JarBridge.proxy_java_args() + JarBridge.runtime_java_args()
            # low#7：proxyToken 经 JAVA_TOOL_OPTIONS 注入（进程列表不可见），
            # 而非 -D 命令行参数。
            jvm_env = {**os.environ, **JarBridge.runtime_java_env()}
            if needs_deps and os.path.isdir(DEXDEPS_DIR):
                deps = [os.path.join(DEXDEPS_DIR, f) for f in os.listdir(DEXDEPS_DIR) if f.endswith('.jar')]
                if deps:
                    cp = os.pathsep.join([self.runner_jar] + deps)
                    # SpiderRunner: <jar_path> <class_name> — className 作为占位符
                    args = [java_bin, '-noverify'] + proxy_args + ['-cp', cp, 'SpiderRunner',
                            self.jar_path, self.class_name or 'default']
                else:
                    args = [java_bin, '-jar'] + proxy_args + [self.runner_jar, self.jar_path, self.class_name or 'default']
            else:
                args = [java_bin, '-jar'] + proxy_args + [self.runner_jar, self.jar_path, self.class_name or 'default']
            try:
                proc = subprocess.Popen(
                    args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=get_jar_runtime_dir(), env=jvm_env,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
            except Exception as e:
                self._last_error = f'java spawn: {e}'
                return False
            self.proc = proc

            def pump_err():
                try:
                    for line in proc.stderr:
                        text = line.decode('utf-8', 'replace').rstrip()
                        if not text:
                            continue
                        # JAVA_TOOL_OPTIONS 会被 JVM 以「Picked up ...」回显到
                        # stderr（内容含 proxyToken），不得落日志（low#7）。
                        if text.lstrip().startswith('Picked up JAVA_TOOL_OPTIONS'):
                            logger.info('[jar:%s] <java-tool-options picked up>', self.class_name)
                            continue
                        logger.info('[jar:%s] %s', self.class_name, text)
                except Exception:
                    pass
            threading.Thread(target=pump_err, daemon=True).start()
            threading.Thread(target=self._read_loop, daemon=True).start()
            # 等待 runner 就绪：空行首响应（~1s）
            try:
                for _ in range(50):
                    if proc.poll() is not None:
                        # 进程已退出（启动时崩溃），收集 stderr 日志
                        try:
                            err = proc.stderr.read(2000).decode('utf-8', 'replace')
                            # 过滤 JAVA_TOOL_OPTIONS 回显行（含 proxyToken，不落日志）
                            err = '\n'.join(
                                ln for ln in err.splitlines()
                                if not ln.lstrip().startswith('Picked up JAVA_TOOL_OPTIONS'))
                            if err:
                                logger.warning('jar %s exited on startup: %s', self.class_name, err[:200])
                        except Exception:
                            pass
                        self._last_error = 'jar process exited on startup'
                        return False
                    time.sleep(0.05)
            except Exception:
                pass
            return True

    def _read_loop(self):
        proc = self.proc
        try:
            while proc and proc.poll() is None:
                line = proc.stdout.readline()
                if not line:
                    break
                self._on_line(line)
        except Exception:
            pass
        finally:
            # 只有在 self.proc 仍然是同一个进程时才 reject pending
            # 避免旧进程的 _read_loop 线程在新进程启动后误清 _pending
            if self.proc is proc:
                self._reject_all(RuntimeError('jar process exited'))

    def _on_line(self, line):
        try:
            text = line.decode('utf-8', 'replace').strip()
            if not text:
                return
            msg = json.loads(text)
        except (ValueError, UnicodeDecodeError):
            return
        rid = msg.get('id')
        if rid is None:
            return
        with self._lock:
            p = self._pending.pop(rid, None)
        if not p:
            return
        resolve, reject = p
        if 'error' in msg:
            reject(RuntimeError(str(msg.get('error', {}).get('message', 'jar error'))))
        elif 'proxy' in msg:
            # 静态 JAR Proxy 的响应是控制帧 + 独立 socket 描述符；不能只取
            # 常规 JSON-RPC 的 result 字段。
            resolve(msg)
        else:
            resolve(msg.get('result', ''))

    def _reject_all(self, err):
        with self._lock:
            pend = list(self._pending.values())
            self._pending.clear()
        for resolve, reject in pend:
            reject(err)

    # ------------------------------------------------------------ 调用

    def call(self, method, *args, class_name='', pan_cookies=None):
        """同步调用，返回 result（JSON 字符串）；失败抛异常。

        参数映射：与 JarSpider._call 对齐，全为 Python 原生类型，
        自动序列化为 JSON params dict。class_name 传给 SpiderRunner 实例化具体蜘蛛。
        pan_cookies：网盘 Cookie 配置（{quark: ...}），注入 SpiderRunner 供网盘蜘蛛使用。

        同一 jar 共享的 JVM 进程同时只允许一个调用在途（_call_lock 串行化），
        防止并发写 stdin 破坏 JSON-RPC 流。进程崩溃时自动重启一次并重试。
        """
        # 排队观测（C3）：JVM 按桥串行，高并发下等待时长是"是否需要按站点
        # 拆桥/JVM 池"的数据依据。P95 持续 > 2s 再考虑动架构。
        wait_started = time.monotonic()
        budget = _runtime_budget_seconds()
        deadline = wait_started + budget
        if not self._call_lock.acquire(timeout=budget):
            raise TimeoutError('[L3:jar] deadline expired while queued for jar worker')
        try:
            waited = time.monotonic() - wait_started
            if waited > 2.0:
                logger.info('[jar:%s] call queued %.1fs before lock (method=%s)',
                            self.jar_path and os.path.basename(self.jar_path), waited, method)
            return self._call_inner(
                method, *args, class_name=class_name,
                pan_cookies=pan_cookies, deadline=deadline)
        finally:
            self._call_lock.release()

    def _call_inner(self, method, *args, class_name='', pan_cookies=None, deadline=None):
        deadline = deadline or (time.monotonic() + _runtime_budget_seconds())
        if not self._ensure_alive():
            raise RuntimeError(f'[L3:jar] {self._last_error or "jar bridge unavailable"}')
        request = current_runtime_request()
        if request is not None:
            request.raise_if_cancelled()
        # 构建 params dict
        params = {}
        m = method
        if method == 'init':
            params['ext'] = str(args[0]) if args else ''
        elif method == 'homeContent':
            params['filter'] = bool(args[0]) if args else False
        elif method == 'homeVideoContent':
            params['pg'] = str(args[0]) if args else '1'
        elif method == 'categoryContent':
            params['tid'] = str(args[0]) if len(args) > 0 else ''
            params['pg'] = str(args[1]) if len(args) > 1 else '1'
            params['filter'] = bool(args[2]) if len(args) > 2 else False
            params['extend'] = args[3] if len(args) > 3 and isinstance(args[3], dict) else {}
        elif method == 'detailContent':
            ids = args[0] if len(args) > 0 else []
            params['ids'] = list(ids) if isinstance(ids, (list, tuple)) else [str(ids)]
        elif method == 'searchContent':
            params['key'] = str(args[0]) if args else ''
            params['quick'] = bool(args[1]) if len(args) > 1 else False
            params['pg'] = str(args[2]) if len(args) > 2 else '1'
        elif method == 'playerContent':
            params['flag'] = str(args[0]) if args else ''
            params['id'] = str(args[1]) if len(args) > 1 else ''
            params['vipFlags'] = list(args[2]) if len(args) > 2 and isinstance(args[2], (list, tuple)) else []
        elif method == '__json_ext':
            params['key'] = str(args[0]) if args else ''
            params['jxs'] = dict(args[1]) if len(args) > 1 and isinstance(args[1], dict) else {}
            params['url'] = str(args[2]) if len(args) > 2 else ''
        elif method == 'proxy':
            # 兼容旧的站点级 Spider.proxy(String)；无 siteKey 的静态
            # com.github.catvod.spider.Proxy 走 call_proxy()，避免把 Map
            # 当成字符串塞进实例方法。
            params['param'] = str(args[0]) if args else '{}'
        elif method == 'liveContent':
            # 审查 M-6：SpiderRunner 侧反射调用对任意方法名开放（handle/invoke），
            # paramNames 对 liveContent 显式映射 {'url'}（jar-runner/SpiderRunner.java
            # paramNames）。此前未分派一律 ValueError→None，直播源静默全灭。
            params['url'] = str(args[0]) if args else ''
        elif method == 'action':
            # SpiderRunner paramNames 显式映射 action → {'action'}；TVBox 契约
            # 传 JSON 字符串（JarSpider.action 已 json.dumps）。
            params['action'] = str(args[0]) if args else ''
        elif method == 'isVideoFormat':
            # SpiderRunner 无显式签名表条目，按其兜底位置名 arg0 传参。
            params['arg0'] = str(args[0]) if args else ''
        elif method == 'manualVideoCheck':
            pass  # 无参方法（stub Spider.manualVideoCheck()）
        elif method == 'destroy':
            pass
        else:
            raise ValueError(f'[L3:jar] unknown jar method {method}')

        # 注入 class_name 让 SpiderRunner 知道实例化哪个蜘蛛
        if class_name:
            params['class_name'] = class_name
        # 注入网盘 Cookie 配置（SpiderRunner 提取后不传给蜘蛛方法）
        if pan_cookies:
            params['pan_cookies'] = pan_cookies

        rid = _next_id()
        req = json.dumps({'id': rid, **_runtime_trace_fields(),
                          'method': m, 'params': params}, ensure_ascii=False) + '\n'
        fut = threading.Event()
        result = {}

        def resolve(v):
            result['v'] = v
            fut.set()

        def reject(e):
            result['e'] = e
            fut.set()

        with self._lock:
            self._pending[rid] = (resolve, reject)
        try:
            self.proc.stdin.write(req.encode('utf-8'))
            self.proc.stdin.flush()
        except Exception as e:
            with self._lock:
                self._pending.pop(rid, None)
            # 进程已死（写失败）→ 自动重启一次并重试
            logger.warning('jar write failed (process dead?), restarting bridge: %s', e)
            try:
                self._kill_proc()
            except Exception:
                pass
            if not self._ensure_alive():
                raise RuntimeError(f'[L3:jar] {self._last_error or "jar bridge unavailable after restart"}')
            with self._lock:
                self._pending[rid] = (resolve, reject)
            try:
                self.proc.stdin.write(req.encode('utf-8'))
                self.proc.stdin.flush()
            except Exception as e2:
                with self._lock:
                    self._pending.pop(rid, None)
                raise RuntimeError(f'[L3:jar] jar write after restart failed: {e2}')
        if not fut.wait(max(0.001, deadline - time.monotonic())):
            with self._lock:
                self._pending.pop(rid, None)
            # JVM 内请求可能死循环/阻塞（如网盘 Cookie 等待、站点响应挂起）。
            # 超时后强制重启 JVM 进程，避免卡死整个桥（同一 jar 的所有站点共用此进程）。
            try:
                self._kill_proc()
            except Exception:
                pass
            raise TimeoutError(f'[L3:jar] jar {method} timeout (bridge restarted)')
        if 'e' in result:
            raise result['e']
        self._crash_count = 0   # M-27a：调用成功视为进程健康，清零崩溃计数
        # 成功调用刷新 LRU，避免被淘汰
        try:
            with _jar_bridges_lock:
                _touch_jar_lru(self.jar_path)
        except Exception:
            pass
        return result.get('v')

    def call_proxy(self, params=None, class_name='', pan_cookies=None):
        """调用 jar 级静态 ``com.github.catvod.spider.Proxy.proxy(Map)``。

        返回 :class:`proxy_contract.ProxyResult`。小响应直接是 bytes；JAR
        返回 ``InputStream`` 时，JVM 控制帧只携带 loopback socket 描述符，
        body 由 ``JarProxyBody`` 按块读取。调用仍复用同一 JVM 的串行锁，
        但视频主体不会经过 JSON-RPC stdout。
        """
        return self._call_proxy_with_mode(
            params, class_name=class_name, pan_cookies=pan_cookies,
            return_descriptor=False)

    def call_proxy_descriptor(self, params=None, class_name='', pan_cookies=None):
        """返回 Proxy 流的 loopback 描述符，供 Supervisor 控制 Worker 使用。

        Worker 不连接也不搬运视频主体；父进程收到描述符后直接连接 JVM 的
        一次性数据 socket，保持控制面与数据面分离。
        """
        return self._call_proxy_with_mode(
            params, class_name=class_name, pan_cookies=pan_cookies,
            return_descriptor=True)

    def _call_proxy_with_mode(self, params=None, class_name='', pan_cookies=None,
                              return_descriptor=False):
        wait_started = time.monotonic()
        budget = _runtime_budget_seconds()
        deadline = wait_started + budget
        if not self._call_lock.acquire(timeout=budget):
            raise TimeoutError('[L3:jar] deadline expired while queued for jar proxy')
        try:
            waited = time.monotonic() - wait_started
            if waited > 2.0:
                logger.info('[jar:%s] proxy queued %.1fs',
                            self.jar_path and os.path.basename(self.jar_path), waited)
            return self._call_proxy_inner(
                params or {}, class_name=class_name,
                pan_cookies=pan_cookies, deadline=deadline,
                return_descriptor=return_descriptor)
        finally:
            self._call_lock.release()

    def _call_proxy_inner(self, params, class_name='', pan_cookies=None,
                          deadline=None, return_descriptor=False):
        from proxy_contract import ProxyResult

        deadline = deadline or (time.monotonic() + _runtime_budget_seconds())
        if not self._ensure_alive():
            raise RuntimeError(f'[L3:jar] {self._last_error or "jar bridge unavailable"}')
        request = current_runtime_request()
        if request is not None:
            request.raise_if_cancelled()
        request_params = dict(params or {})
        request_params['__static_proxy'] = True
        if class_name:
            request_params['class_name'] = class_name
        if pan_cookies:
            request_params['pan_cookies'] = pan_cookies

        rid = _next_id()
        req = json.dumps({'id': rid, **_runtime_trace_fields(),
                          'method': 'proxy', 'params': request_params},
                         ensure_ascii=False, default=str) + '\n'
        fut = threading.Event()
        result = {}

        def resolve(v):
            result['v'] = v
            fut.set()

        def reject(e):
            result['e'] = e
            fut.set()

        with self._lock:
            self._pending[rid] = (resolve, reject)
        try:
            self.proc.stdin.write(req.encode('utf-8'))
            self.proc.stdin.flush()
        except Exception as e:
            with self._lock:
                self._pending.pop(rid, None)
            logger.warning('jar proxy write failed, restarting bridge: %s', e)
            self._kill_proc()
            if not self._ensure_alive():
                raise RuntimeError(f'[L3:jar] {self._last_error or "jar bridge unavailable after restart"}')
            with self._lock:
                self._pending[rid] = (resolve, reject)
            try:
                self.proc.stdin.write(req.encode('utf-8'))
                self.proc.stdin.flush()
            except Exception as e2:
                with self._lock:
                    self._pending.pop(rid, None)
                raise RuntimeError(f'[L3:jar] jar proxy write after restart failed: {e2}')

        if not fut.wait(max(0.001, deadline - time.monotonic())):
            with self._lock:
                self._pending.pop(rid, None)
            self._kill_proc()
            raise TimeoutError('[L3:jar] jar proxy timeout (bridge restarted)')
        if 'e' in result:
            raise result['e']
        msg = result.get('v')
        if not isinstance(msg, dict) or not isinstance(msg.get('proxy'), dict):
            raise RuntimeError('[L3:jar] invalid static proxy response')
        info = msg['proxy']
        status = int(info.get('status', 200) or 200)
        mime = str(info.get('mime') or 'application/octet-stream')
        headers = {str(k): str(v) for k, v in (info.get('headers') or {}).items()
                   if v is not None}
        stream = info.get('stream')
        if return_descriptor:
            self._crash_count = 0
            try:
                with _jar_bridges_lock:
                    _touch_jar_lru(self.jar_path)
            except Exception:
                pass
            return {
                '__yuki_proxy__': True,
                'status': status,
                'mime': mime,
                'headers': headers,
                'stream': stream if isinstance(stream, dict) else None,
                'body': info.get('body') or '',
            }
        close = None
        if isinstance(stream, dict) and stream.get('port') and stream.get('token'):
            body = JarProxyBody(stream.get('host') or '127.0.0.1', stream['port'],
                                stream['token'])
            close = body.close
        else:
            encoded = info.get('body') or ''
            try:
                body = base64.b64decode(encoded, validate=False)
            except Exception as e:
                raise RuntimeError(f'[L3:jar] invalid proxy body: {e}') from e
        self._crash_count = 0
        try:
            with _jar_bridges_lock:
                _touch_jar_lru(self.jar_path)
        except Exception:
            pass
        return ProxyResult(status=status, mime=mime, body=body,
                           headers=headers, close=close)

    def _kill_proc(self):
        """强制结束当前 JVM 子进程（写失败/崩溃后重启前调用）。

        M-27a：不再重置任何崩溃计数——需要重新拉起时 _ensure_alive 统一计数，
        否则超时/写失败路径会绕过"最多重启 3 次"上限形成无限循环。
        """
        with self._lock:
            proc = self.proc
            self.proc = None
            pending = list(self._pending.values())
            self._pending.clear()
        for _resolve, reject in pending:
            try:
                reject(RuntimeError('jar process restarted'))
            except Exception:
                pass
        if proc:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.kill()
            except OSError:
                pass  # Windows 上已退出的进程 kill 会抛 Errno 22
            except Exception:
                pass
            _reap(proc)
            for pipe in (getattr(proc, 'stdout', None), getattr(proc, 'stderr', None)):
                try:
                    if pipe:
                        pipe.close()
                except Exception:
                    pass
        # P1-4：TerminateProcess 不执行 Java shutdown hook，强杀后网盘
        # Cookie 文件（TVBox/*_cookie.txt）无人清理，这里补删（幂等、
        # 优雅路径重复删除无害）。裸名清理（H-1）：只命中本桥已死且同 jar
        # 无其它存活桥时的裸名文件；多 jar 并存绝不误删其他 JVM 的登录态。
        self._cleanup_cookie_files_after_kill()

    def _cleanup_cookie_files_after_kill(self):
        """H-1：确认目标 JVM 已死且同 jar 无其它存活桥后清理裸名 cookie 文件。

        Java 侧 seedCookieFiles 写的是**裸名**文件（quark_cookie.txt 等五个
        固定名，SpiderRunner.java:531-537），此前按 jar 只清理摘要名，永远
        命中不了 → 强杀后明文登录态残留。裸名文件被所有 JVM 共享，只有在这
        两个前提下才允许清理（失败静默，不影响主流程）：
        1. 本桥 proc 已确认终止（_kill_proc / destroy 强杀路径各自先
           _reap/等待退出）；
        2. 全局注册表 _jar_bridges 中同 jar 再无其它存活桥（注册表按 jar_path
           建键，同 jar 至多一个条目；若是替代本桥的新桥且其 JVM 活着，说明
           该 jar 的登录态仍被使用）。
        """
        try:
            with _jar_bridges_lock:
                other = _jar_bridges.get(self.jar_path)
                if other is not None and other is not self \
                        and getattr(other, 'proc', None) is not None:
                    if other.proc.poll() is None:
                        return
            cleanup_jvm_cookie_files(self.jar_path, bare=True)
        except Exception:
            pass

    # ------------------------------------------------------------ 生命周期

    def destroy(self):
        """进程级关停（M-17）：发 __shutdown 让 SpiderRunner 走正常退出
        （shutdown hook 会清理 cookie 缓存目录），1s 未退则强杀。

        显式关停清零崩溃计数（用户/热重载主动行为，非崩溃）。

        并发安全（审查 M-17）：先取 `_call_lock`（阻塞等待在途调用完成，
        destroy 语义允许等待），保证关停不会插在 `_call_inner` 写 stdin 与
        读响应之间破坏 JSON-RPC 协议流；等待中的 call() 排队者用
        `_call_lock.acquire(timeout=budget)` 排队，锁被 destroy 长期持有的
        期间会按各自 budget 超时快速失败，不会无限挂起。
        """
        with self._call_lock:
            # 逐个 reject 仍在 _pending 的等待者（_read_loop 只在进程退出时
            # reject，这里的显式拒绝让超时等待者立即感知关停，而不是等 1s
            # 强杀后 _read_loop 的兜底——期间也不再有新请求能写 stdin）。
            self._reject_all(RuntimeError('[L3:jar] jar bridge destroyed'))
            self._destroyed = True
            with self._lock:
                proc = self.proc
                self.proc = None
                self._pending.clear()
                self._crash_count = 0
        # 先从全局缓存移除，避免关停中被 get_or_create 再次取走
        with _jar_bridges_lock:
            _jar_bridges.pop(self.jar_path, None)
            _jar_lru.pop(self.jar_path, None)
        if proc:
            try:
                proc.stdin.write(json.dumps({'id': -1, 'method': '__shutdown'}).encode('utf-8') + b'\n')
                proc.stdin.flush()
            except Exception:
                pass
            exited_gracefully = False
            try:
                proc.wait(timeout=1.0)
                exited_gracefully = True
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
                # P1-4：优雅退出失败转强杀时，Java hook 大概率未执行，补删
                # cookie 文件（优雅成功时 hook 已清理，此处重复删除无害）。
                # 裸名清理（H-1）前提：先确认进程真正退出（_reap），且同 jar
                # 无其它存活桥（_jar_bridges 中本桥已先行摘除）。
                _reap(proc)
            finally:
                for pipe in (getattr(proc, 'stdin', None), getattr(proc, 'stdout', None),
                             getattr(proc, 'stderr', None)):
                    try:
                        if pipe:
                            pipe.close()
                    except Exception:
                        pass
            if not exited_gracefully:
                self._cleanup_cookie_files_after_kill()


# ------------------------------------------------------------ 文件工具

def _file_md5(path):
    import hashlib
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


# jar 下载体积上限：TVBox 生态 spider jar（含 DEX 转换产物）普遍在几 MB～几十 MB，
# 极端全功能 jar 上百 MB；512MB 已远超真实负载，仅拦「无上限全量入内存」的最坏情况。
MAX_JAR_DOWNLOAD_BYTES = 512 * 1024 * 1024

# jar 下载跳转上限：与 http_client.fetch_follow_redirects / 配置层 MAX_REDIRECTS 同档。
_MAX_JAR_REDIRECTS = 5


def requests_get_jar(url, timeout=30):
    """下载 jar 二进制（手动逐跳跟随重定向；走共享连接池与双来源代理）。

    H-2：jar 会在 JVM 内反射执行（等价任意代码），传输必须校验 TLS。
    C2.5（问题 #9）：requests 的 `allow_redirects=True` 会绕过逐跳守卫——
    公网源 302 到内网同样必须被拦。这里改为手动跟随，每一跳都过 `guard_url`
    （策略机制与配置层完全一致：默认桌面策略放行本机/内网引用，
    `YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1` 打开严格 SSRF 防护后同步生效），
    响应体流式限长（`MAX_JAR_DOWNLOAD_BYTES`）后一次落内存，供魔数/md5 校验
    与落盘。

    信任根：第一跳是用户给定的 jar 源，其自身 origin 即信任根（内网 NAS 上的
    jar 直下在严格模式下仍可用）；重定向目标不继承信任——它是远端响应派生的
    地址，公网源 302 到内网必须在跟随前被拒。
    """
    current = http_client._guard_hop(url, kind='site', trust_root=url)
    hdr = {'User-Agent': http_client.DEFAULT_UA}
    for _ in range(_MAX_JAR_REDIRECTS + 1):
        rsp = http_client._send('GET', current, timeout=timeout, allow_redirects=False,
                                headers=hdr, verify=True, stream=True)
        if rsp is None:
            raise ValueError(f'[L3:jar] jar download empty: {url}')
        if rsp.status_code in http_client._REDIRECT_STATUSES and 'Location' in rsp.headers:
            current = http_client._guard_hop(urljoin(current, rsp.headers['Location']),
                                             kind='site', trust_redirect=True)
            continue
        rsp.raise_for_status()
        raw = http_client._read_capped(rsp, MAX_JAR_DOWNLOAD_BYTES)
        return raw
    raise ValueError(f'too many redirects (>{_MAX_JAR_REDIRECTS}): {url}')
