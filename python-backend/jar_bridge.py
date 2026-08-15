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
import subprocess
import threading
import time
import logging

import requests

import java_probe

logger = logging.getLogger('vpc.jar')

# 从版本串行首解析主版本数字段（如 '17.0.10' → 17，'21-ea' → 21）
_MAJOR_RE = re.compile(r'^\s*(\d+)')

CALL_TIMEOUT = 20

# 单蜘蛛连续超时达到此次数即会话级停用（熔断）：同 jar 内同一个 class_name
# 连续 2 次超时后不再派发 JVM 调用，直到手动重建 JarBridge 实例。
_BRIDGE_MAX_TIMEOUTS = 2
_id_lock = threading.Lock()
_id_counter = 0


def _next_id():
    global _id_counter
    with _id_lock:
        _id_counter += 1
        return _id_counter


def _is_md5(s):
    return len(s) == 32 and all(c in '0123456789abcdefABCDEF' for c in s)


# [SpiderDebug] 常规噪音行（高频刷屏、无信号价值）：仅 debug 级。
_SPIDER_DEBUG_NOISE = (
    'setToken', 'UC开始尝试', '获取Cookie', '使用默认Cookie',
)
# 异常/错误/堆栈信号词：warning 级。
_SPIDER_WARN_MARKERS = (
    'getShareInfo', 'share_id', 'is not a string',
    'Exception', 'Error', ' at ',
)
# 疑似敏感值的 k=v 连接符，用于脱敏兜底。
_SPIDER_SECRET_KEYS = ('token', 'cookie', 'pus', 'passwd', 'secret', 'password', 'key=')


def _looks_sensitive(text):
    """判断行是否疑似携带长敏感值（无标签长 token 形态或敏感 key）。

    匹配两种形态：
    1. k=v 且 value 是长度 >= 7、不含空格的连续串（如 token=abcdefgh1234）；
    2. 行文本中出现 token/cookie/passwd/secret 等敏感关键词。
    """
    if any(k in text for k in _SPIDER_SECRET_KEYS):
        return True
    # k=v 且 value 连续无空格长度 >= 7
    for seg in text.split():
        if '=' not in seg:
            continue
        k, _, v = seg.partition('=')
        if k and v and not v.strip() and len(v) >= 7:
            return True
        # 形如 key=value 且 value 无空格连续 >= 7（即使带引号包裹）
        vv = v.strip('"\'')
        if k and vv and len(vv) >= 7 and ' ' not in vv:
            return True
    return False


def _redact_line(text):
    """脱敏兜底：把疑似敏感 k=v 的值替换为 [REDACTED]。"""
    out = []
    for seg in text.split():
        if '=' in seg:
            k, _, v = seg.partition('=')
            vv = v.strip('"\'')
            if k and len(vv) >= 7 and ' ' not in vv:
                seg = k + '=[REDACTED]'
        out.append(seg)
    return ' '.join(out)


def _classify_stderr_line(text):
    """对 JVM stderr 单行做日志分级并脱敏，返回 (logging level, 输出文本)。

    规则（保持 [jar:%s] 前缀由调用方拼接）：
    - 脱敏兜底优先：疑似敏感值 → debug 级且脱敏，绝不进 INFO。
    - 常规 [SpiderDebug] 噪音（setToken / UC开始尝试 / 获取Cookie / 使用默认Cookie / 纯进度）→ debug。
    - 异常/错误/堆栈（getShareInfo / share_id / is not a string / Exception / Error / ' at '）→ warning。
    - 其余普通行 → info。
    """
    if _looks_sensitive(text):
        return logging.DEBUG, _redact_line(text)
    if any(m in text for m in _SPIDER_DEBUG_NOISE):
        return logging.DEBUG, text
    if any(m in text for m in _SPIDER_WARN_MARKERS):
        return logging.WARNING, text
    return logging.INFO, text


DEFAULT_RUNNER_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'spider-runner.jar')

# dex2jar 工具（转换 Android DEX 为 JVM .class）
DEX2JAR_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
DEXDEPS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'dexdeps')

# 全局 jar 桥缓存：key = jar_path → JarBridge 实例
_jar_bridges = {}
_jar_bridges_lock = threading.Lock()


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
            b = JarBridge(jar_path, runner_jar=runner_jar)
            _jar_bridges[jar_path] = b
            return b

    @staticmethod
    def destroy_all():
        """销毁所有 JVM 子进程（应用退出时调用）。"""
        with _jar_bridges_lock:
            for b in _jar_bridges.values():
                try:
                    b.destroy()
                except Exception:
                    pass
            _jar_bridges.clear()

    def __init__(self, jar_path, runner_jar=None, class_name=''):
        self.jar_path = jar_path
        # 默认类名（SpiderRunner 启动时预加载用；请求时可用 params.class_name 覆盖）
        self.class_name = class_name
        self.runner_jar = runner_jar or DEFAULT_RUNNER_JAR
        self._call_lock = threading.RLock()  # 可重入锁；auto-init 内部再 call 不阻塞
        self.proc = None
        self._lock = threading.Lock()
        self._pending = {}
        self._buf = b''
        self._last_error = ''
        self._started = False
        self._restart_count = 0

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
    def download_jar(jar_url, md5='', site_key='', jar_dir=None):
        """下载 jar 到本地缓存目录（幂等，带 md5 校验），返回本机路径。

        若下载的 jar 包含 Android DEX（classes.dex），自动转换为 JVM .class jar
        并缓存，返回转换后的路径。
        """
        import hashlib
        jar_dir = jar_dir or os.path.join(os.path.expanduser('~'), '.video-pc', 'cache', 'jar')
        try:
            os.makedirs(jar_dir, exist_ok=True)
        except OSError:
            pass
        fname = os.path.basename(jar_url.split('?')[0]) or f'{site_key or "spider"}.jar'
        dest = os.path.join(jar_dir, fname)
        if os.path.isfile(dest):
            if not md5 or _file_md5(dest) == md5:
                return JarBridge._ensure_jvm_compatible(dest, md5)
        raw = requests_get_jar(jar_url)
        if not raw or len(raw) < 4:
            raise ValueError(f'jar download empty: {jar_url}')
        if md5 and hashlib.md5(raw).hexdigest() != md5:
            raise ValueError(f'jar md5 mismatch: {jar_url}')
        with open(dest, 'wb') as f:
            f.write(raw)
        return JarBridge._ensure_jvm_compatible(dest, md5)

    @staticmethod
    def _ensure_jvm_compatible(jar_path, md5=''):
        """检查 jar 是否含 DEX；如果是，转为 JVM .class jar 并缓存。"""
        if not os.path.isfile(jar_path):
            return jar_path
        # 快速检查：zip 中是否有 classes.dex
        import zipfile
        try:
            with zipfile.ZipFile(jar_path) as z:
                names = z.namelist()
                has_dex = any(n.endswith('.dex') for n in names)
                if not has_dex:
                    return jar_path  # 已经是标准 JVM jar
        except Exception:
            return jar_path
        # 需要转换：jvm 缓存路径 = 原路径去掉 .jar 加 -jvm.jar
        base = jar_path.rsplit('.', 1)[0]
        jvm_path = base + '-jvm.jar'
        if os.path.isfile(jvm_path):
            return jvm_path
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
                logger.warning('dex2jar not found at %s, skipping DEX conversion', d2j_jar)
                return jar_path
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
            logger.warning('no java runtime for dex2jar, skipping DEX conversion')
            return jar_path
        classpath = os.pathsep.join(cp)
        cmd = [java_bin, '-cp', classpath, main_class, '-o', jvm_path, jar_path]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=120)
            if r.returncode != 0:
                logger.warning('dex2jar failed: %s', r.stderr.decode('utf-8', 'replace')[:200])
                return jar_path
            if os.path.isfile(jvm_path):
                logger.info('dex2jar ok: %s -> %s', os.path.basename(jar_path), os.path.basename(jvm_path))
                return jvm_path
        except Exception as e:
            logger.warning('dex2jar exception: %s', e)
        return jar_path

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
        self.proc = None
        self._lock = threading.Lock()
        self._pending = {}
        self._buf = b''
        self._last_error = ''
        self._started = False
        self._restart_count = 0
        # 会话级熔断状态：同 jar 内按 class_name 统计。_timeout_counts 记录连续超时次数，
        # 达到 _BRIDGE_MAX_TIMEOUTS 时把 class_name 加入 _disabled_classes，之后直接拒绝
        # 该 class_name 的调用（不再起 JVM），避免蜘蛛反复卡死拖垮整个 jar 桥。
        # _kill_proc 进程重启不清空这两项，只有销毁实例才复位。
        self._disabled_classes = set()
        self._timeout_counts = {}
        # 缓存解析出的 java 主版本（None = 未探测）
        self._java_major = None

    # ------------------------------------------------------------ 进程管理

    @staticmethod
    def _parse_major_version(version):
        """从 ''17.0.10'' / ''1.8.0_292'' / ''9'' / ''21-ea'' 解析 java 主版本；无法解析返回 None。

        Java 8 及更早版本号以 ''1.'' 开头（1.8 = 8），9 起（含 prerelease 如 21-ea）
        直接以主版本开篇。返回整数主版本（8、9、11、17、21...），供 -noverify 开关判断。
        """
        if not version:
            return None
        version = str(version).strip()
        if version.startswith('1.'):
            # 1.8.0_292 → 8
            first = version.split('.')
            if len(first) > 1 and first[1].isdigit():
                return int(first[1])
            return None
        # 17.0.10 / 9 / 21-ea → 取行首连续数字
        m = _MAJOR_RE.match(version)
        return int(m.group(1)) if m else None

    def _java_major_version(self):
        """读取当前 JVM 的主版本并缓存；无法获取返回 None。"""
        if self._java_major is not None:
            return self._java_major
        # 优先用 java_probe 已探测缓存的版本号
        v = java_probe.java_version()
        if not v:
            java_bin = java_probe.find_java()
            if java_bin:
                try:
                    r = subprocess.run(
                        [java_bin, '-version'], capture_output=True, text=True, timeout=10,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                    )
                    text = (r.stderr or r.stdout or '')
                    m = re.search(r'version\s+"([^"]+)"', text)
                    v = m.group(1) if m else ''
                except Exception:
                    v = ''
        major = self._parse_major_version(v)
        # None 也缓存，避免每次探测都重跑 java -version
        self._java_major = major
        return major

    def _ensure_alive(self):
        """确保 JVM 子进程就绪；返回 bool。

        对 DEX 转换后的 jar（名称含 -jvm），自动添加 vendor/dexdeps/ 下的
        依赖库（okhttp3、org.json、kotlin等）到 classpath，以 -cp 模式启动。
        SpiderRunner 只接收 jar_path 作为 CLI 参数，className 在每次请求的 params 中传递。
        """
        with self._lock:
            if self.proc and self.proc.poll() is None:
                self._restart_count = 0  # 进程存活，重置重启计数
                return True
            # 旧进程已死，清理引用（不再 kill，进程已退出）
            if self.proc:
                self.proc = None
            if self._started:
                # 已崩过，指数退避重试，最多 3 次
                self._restart_count += 1
                if self._restart_count > 3:
                    self._last_error = 'jar restart limit exceeded (3)'
                    return False
                time.sleep(1.0 * self._restart_count)
            self._started = True
            # 注意：_restart_count 不在启动成功前重置，
            # 启动失败时由 _ensure_alive 调用者（_kill_proc）负责清理
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

            # 判断是否为 DEX 转换后的 jar（需要 dexdeps）
            needs_deps = '-jvm.jar' in self.jar_path.lower()
            if needs_deps and os.path.isdir(DEXDEPS_DIR):
                deps = [os.path.join(DEXDEPS_DIR, f) for f in os.listdir(DEXDEPS_DIR) if f.endswith('.jar')]
                if deps:
                    cp = os.pathsep.join([self.runner_jar] + deps)
                    # SpiderRunner: <jar_path> <class_name> — className 作为占位符
                    # -noverify 仅对 Java 8 及更早（主版本 < 9）附加；JDK 9+ 已移除该开关，
                    # 传了反而打印 deprecation 警告，未来 JDK 会直接拒绝。
                    args = [java_bin]
                    major = self._java_major_version()
                    if major is not None and major < 9:
                        args.append('-noverify')
                    args += ['-cp', cp, 'SpiderRunner', self.jar_path, self.class_name or 'default']
                else:
                    args = [java_bin, '-jar', self.runner_jar, self.jar_path, self.class_name or 'default']
            else:
                args = [java_bin, '-jar', self.runner_jar, self.jar_path, self.class_name or 'default']
            try:
                proc = subprocess.Popen(
                    args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
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
                        level, out = _classify_stderr_line(text)
                        logger.log(level, '[jar:%s] %s', self.class_name, out)
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
        # 懒初始化 _call_lock（兼容旧版 .pyc 缓存）
        lock = getattr(self, '_call_lock', None)
        if lock is None:
            lock = threading.RLock()
            self._call_lock = lock
        with lock:  # 每实例串行化：跨站点并发 call 排队执行
            return self._call_inner(method, *args, class_name=class_name, pan_cookies=pan_cookies)

    def _call_inner(self, method, *args, class_name='', pan_cookies=None):
        # 熔断：该 class_name 已被会话级停用（连续超时判定），直接拒绝，不起 JVM。
        if class_name and class_name in self._disabled_classes:
            raise RuntimeError(
                f'spider disabled: {class_name} (多次连续超时，已停用该 jar 蜘蛛，需重建桥实例)')
        if not self._ensure_alive():
            raise RuntimeError(self._last_error or 'jar bridge unavailable')
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
        elif method == 'destroy':
            pass
        else:
            raise ValueError(f'unknown jar method {method}')

        # 注入 class_name 让 SpiderRunner 知道实例化哪个蜘蛛
        if class_name:
            params['class_name'] = class_name
        # 注入网盘 Cookie 配置（SpiderRunner 提取后不传给蜘蛛方法）
        if pan_cookies:
            params['pan_cookies'] = pan_cookies

        rid = _next_id()
        req = json.dumps({'id': rid, 'method': m, 'params': params}, ensure_ascii=False) + '\n'
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
                raise RuntimeError(self._last_error or 'jar bridge unavailable after restart')
            with self._lock:
                self._pending[rid] = (resolve, reject)
            try:
                self.proc.stdin.write(req.encode('utf-8'))
                self.proc.stdin.flush()
            except Exception as e2:
                with self._lock:
                    self._pending.pop(rid, None)
                raise RuntimeError(f'jar write after restart failed: {e2}')
        if not fut.wait(CALL_TIMEOUT):
            with self._lock:
                self._pending.pop(rid, None)
                # 熔断：累加该 class_name 的连续超时计数，达阈值即停用。
                # 只有超时事件递增；_kill_proc 进程重启不清零（会话级停用）。
                if not class_name:
                    class_name = self.class_name
                n = self._timeout_counts.get(class_name, 0) + 1
                self._timeout_counts[class_name] = n
                disabled = n >= _BRIDGE_MAX_TIMEOUTS
                if disabled:
                    self._disabled_classes.add(class_name)
            # JVM 内请求可能死循环/阻塞（如网盘 Cookie 等待、站点响应挂起）。
            # 超时后强制重启 JVM 进程，避免卡死整个桥（同一 jar 的所有站点共用此进程）。
            try:
                self._kill_proc()
            except Exception:
                pass
            if disabled:
                logger.warning(
                    'jar spider disabled after %s consecutive timeouts: %s (class: %s)',
                    n, self.jar_path, class_name)
            raise TimeoutError(
                f'jar {method} timeout (bridge restarted); spider disabled={disabled}')
        if 'e' in result:
            raise result['e']
        # 本次调用成功完成，清零该 class_name 的连续超时计数（非连续则不触发熔断）。
        with self._lock:
            if class_name:
                self._timeout_counts.pop(class_name, None)
        return result.get('v')

    def _kill_proc(self):
        """强制结束当前 JVM 子进程（写失败/崩溃后重启前调用）。"""
        with self._lock:
            proc = self.proc
            self.proc = None
            self._started = False
            self._pending.clear()
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

    # ------------------------------------------------------------ 生命周期

    def destroy(self):
        with self._lock:
            proc = self.proc
            self.proc = None
            self._pending.clear()
        if proc:
            try:
                proc.kill()
            except Exception:
                pass
        # 从全局缓存中移除
        with _jar_bridges_lock:
            _jar_bridges.pop(self.jar_path, None)


# ------------------------------------------------------------ 文件工具

def _file_md5(path):
    import hashlib
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def requests_get_jar(url, timeout=30):
    """下载 jar 二进制（跟重定向）。"""
    rsp = requests.get(url, allow_redirects=True, timeout=timeout, verify=False)
    rsp.raise_for_status()
    return rsp.content