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
import socket
import subprocess
import threading
import time
import logging


import hoststate
from runtime.errors import RuntimeError as RuntimeContractError
from runtime.android_policy import android_only_details
from runtime.contracts import current_runtime_request
from runtime.health import android_worker_enabled
import http_client
import java_probe

logger = logging.getLogger('vpc.jar')


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


DEFAULT_RUNNER_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'spider-runner.jar')

# dex2jar 工具（转换 Android DEX 为 JVM .class）
DEX2JAR_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
DEXDEPS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'dexdeps')

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
# jar 下载/转换锁：key = jar_url → Lock（并发构建同一 jar 时串行化下载与 dex2jar）
_jar_download_locks = {}
_jar_download_locks_guard = threading.Lock()


def _jar_download_lock(url):
    with _jar_download_locks_guard:
        return _jar_download_locks.setdefault(url, threading.Lock())


class JarBridge:
    """按 jar 文件共享的 JVM 子进程桥。同一 jar 的所有 csp_XXX 站点共用一个 JVM 进程。

    线程安全：同一时刻只允许一个 call 在途（跨站点的并发请求由业务层串到线程池，
    这里避免并发写 stdin 破坏 JSON-RPC 流）。等待者队列按 FIFO 依次取锁。
    """

    @staticmethod
    def get_or_create(jar_path, runner_jar=None):
        """获取或创建 jar_path 对应的桥实例（全局单例）。"""
        runner_jar = runner_jar or DEFAULT_RUNNER_JAR
        jar_path = os.path.normpath(os.path.realpath(jar_path))
        with _jar_bridges_lock:
            b = _jar_bridges.get(jar_path)
            if b is not None:
                return b
            # 任务二·机制B：jar 加载期预启动其硬编码的本地代理端口，
            # 避免首次播放才补监听（首连失败）
            if os.environ.get('VPC_WORKER_CONTROL_ONLY') != '1':
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
            return b

    @staticmethod
    def destroy_all():
        """销毁所有 JVM 子进程（应用退出时调用）。"""
        with _jar_bridges_lock:
            for b in list(_jar_bridges.values()):
                try:
                    b.destroy()
                except Exception:
                    pass
            _jar_bridges.clear()

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
        """已知 Android/Dex/native JAR 不得在无 Android Worker 时假装 PC 健康。"""
        if not portable_only or android_worker_enabled():
            return
        report = classify_jar_compatibility(jar_path)
        signals = set(report.get('signals') or [])
        requires_android = bool(
            report.get('hasDex') or report.get('hasNative') or
            signals.intersection({'android-api', 'android-ui-or-webview',
                                  'native-library', 'drm-or-device-license'}))
        if requires_android:
            raise RuntimeContractError(
                'L2_SITE_REQUIRES_ANDROID',
                site_key=site_key,
                runtime='android',
                details={**android_only_details(),
                    'compatibility': 'C2',
                    'jarLevel': report.get('level'),
                    'signals': sorted(signals),
                    'androidWorkerEnabled': False,
                },
            )

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
        args = [
            '-Dvpc.proxyHost=127.0.0.1',
            '-Dvpc.proxyPort=' + str(port),
        ]
        try:
            token = str(hoststate.get_token() or '')
        except Exception:
            token = ''
        if token:
            args.append('-Dvpc.proxyToken=' + token)
        return args

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
                return patched_path
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
            r = subprocess.run(cmd, capture_output=True, timeout=120)
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

    # ------------------------------------------------------------ 进程管理

    def _ensure_alive(self):
        """确保 JVM 子进程就绪；返回 bool。

        对 DEX 转换后的 jar（名称含 -jvm），自动添加 vendor/dexdeps/ 下的
        依赖库（okhttp3、org.json、kotlin等）到 classpath，以 -cp 模式启动。
        SpiderRunner 只接收 jar_path 作为 CLI 参数，className 在每次请求的 params 中传递。
        """
        with self._lock:
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
                    cwd=get_jar_runtime_dir(),
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
        elif method == 'proxy':
            # 兼容旧的站点级 Spider.proxy(String)；无 siteKey 的静态
            # com.github.catvod.spider.Proxy 走 call_proxy()，避免把 Map
            # 当成字符串塞进实例方法。
            params['param'] = str(args[0]) if args else '{}'
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
            return {
                '__vpc_proxy__': True,
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
            for pipe in (getattr(proc, 'stdout', None), getattr(proc, 'stderr', None)):
                try:
                    if pipe:
                        pipe.close()
                except Exception:
                    pass

    # ------------------------------------------------------------ 生命周期

    def destroy(self):
        """进程级关停（M-17）：发 __shutdown 让 SpiderRunner 走正常退出
        （shutdown hook 会清理 cookie 缓存目录），1s 未退则强杀。

        显式关停清零崩溃计数（用户/热重载主动行为，非崩溃）。
        """
        with self._lock:
            proc = self.proc
            self.proc = None
            self._pending.clear()
            self._crash_count = 0
        # 先从全局缓存移除，避免关停中被 get_or_create 再次取走
        with _jar_bridges_lock:
            _jar_bridges.pop(self.jar_path, None)
        if proc:
            try:
                proc.stdin.write(json.dumps({'id': -1, 'method': '__shutdown'}).encode('utf-8') + b'\n')
                proc.stdin.flush()
            except Exception:
                pass
            try:
                proc.wait(timeout=1.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            finally:
                for pipe in (getattr(proc, 'stdin', None), getattr(proc, 'stdout', None),
                             getattr(proc, 'stderr', None)):
                    try:
                        if pipe:
                            pipe.close()
                    except Exception:
                        pass


# ------------------------------------------------------------ 文件工具

def _file_md5(path):
    import hashlib
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def requests_get_jar(url, timeout=30):
    """下载 jar 二进制（跟重定向；走共享连接池与双来源代理）。

    H-2：jar 会在 JVM 内反射执行（等价任意代码），传输必须校验 TLS。
    """
    rsp = http_client.get(url, allow_redirects=True, timeout=timeout, verify=True)
    rsp.raise_for_status()
    return rsp.content
