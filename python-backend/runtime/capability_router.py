# -*- coding: utf-8 -*-
"""C2.4 能力路由（Capability Router）。

站点条目 → 运行时的判定此前散落在 `config.py::_build_site` 的 if/elif 链和
`runtime/health.py::infer_site_health` 两处，两边规则不完全一致，且「下载后才知道
是不是 Android JAR」这一步没有独立的判定入口——JAR 分级结论只能靠抛异常表达。
本模块把判定收成两步纯函数：

* :func:`route_site` —— 只看配置字段，给出下载前的路由结论；
* :func:`refine_with_jar` —— 拿到 JAR 字节分级报告后细化到 JVM / dex2jar 回退。

路由顺序（任务书 C2.4）：

1. CMS HTTP 接口（type 0/1）        → CMS Worker
2. api 指向 ``.py``                 → Python Worker
3. api 指向 ``.js`` 或 type=4       → QuickJS Worker；命中 drpy 标记则标记 unsupported
4. ``csp_`` / ``.jar`` + portable   → JVM JAR Worker
5. ``csp_`` / ``.jar`` + Dex/native → dex2jar/JVM 回退
6. 其余                             → unsupported，且**不尝试任何运行时**

Android-only 的 JAR 仍会先做字节分级，但桌面端统一允许进入 dex2jar/JVM；缺少
Android 能力时由实际 Worker 返回可诊断的运行时错误。
"""
from dataclasses import dataclass, field

from .health import android_worker_enabled

# 运行时 → Worker 种类。'' 表示当前宿主没有可用 Worker。
WORKERS = {
    'cms': 'cms',
    'python': 'python',
    'js': 'quickjs',
    'jar': 'jvm-jar',
    'android': 'android',
    'unsupported': '',
}

# 分级：C0 无法运行 / C1 桌面可运行 / C2 需要 Android 运行时。
COMPATIBILITY = {
    'cms': 'C1', 'python': 'C1', 'js': 'C1', 'jar': 'C1',
    'android': 'C2', 'unsupported': 'C0',
}

DRPY_MARKERS = ('drpy', 'dr_py', 'drpys')

# 这些字节信号表示普通 JVM 可能缺类/缺库（android.* 存根、.so、DRM 组件），
# 但桌面端仍允许进入 dex2jar/JVM 回退，由实际调用结果决定是否可用。
ANDROID_ONLY_SIGNALS = frozenset({
    'android-api', 'android-ui-or-webview', 'native-library', 'drm-or-device-license',
})


@dataclass
class RouteDecision:
    """一次路由结论。既写入 SiteHealth，也进兼容报告。"""

    site_key: str = ''
    site_type: int = -1
    runtime: str = 'unsupported'
    worker: str = ''
    compatibility: str = 'C0'
    rule: str = 'R6-unsupported'
    reason: str = ''
    error_code: str = ''
    needs_jar: bool = False
    jar_level: str = ''
    jar_signals: list = field(default_factory=list)
    has_dex: bool = False
    has_native: bool = False
    details: dict = field(default_factory=dict)

    @property
    def supported(self):
        return bool(self.worker) and not self.error_code

    def to_dict(self):
        payload = {
            'siteKey': self.site_key,
            'type': int(self.site_type),
            'runtime': self.runtime,
            'worker': self.worker,
            'compatibility': self.compatibility,
            'rule': self.rule,
            'reason': self.reason,
            'supported': bool(self.supported),
        }
        if self.error_code:
            payload['errorCode'] = self.error_code
        if self.jar_level:
            payload['jarLevel'] = self.jar_level
        if self.jar_signals:
            payload['jarSignals'] = list(self.jar_signals)
        if self.has_dex or self.has_native:
            payload['hasDex'] = bool(self.has_dex)
            payload['hasNative'] = bool(self.has_native)
        if self.details:
            payload['details'] = dict(self.details)
        return payload


def _decide(site_key, site_type, runtime, rule, reason, **extra):
    return RouteDecision(
        site_key=site_key, site_type=site_type, runtime=runtime,
        worker=WORKERS.get(runtime, ''), compatibility=COMPATIBILITY.get(runtime, 'C0'),
        rule=rule, reason=reason, **extra)


def _path_of(api):
    """取 URL/路径的最后一段（去 query/fragment），用于判定脚本类型。"""
    text = str(api or '').split('#', 1)[0].split('?', 1)[0]
    return text.rsplit('/', 1)[-1].lower()


def _script_kind(api):
    """``.py`` / ``.js`` 判定。

    FongMi 用 ``api.contains(".js")``，会把 ``config.json`` 误判为 JS（``.json``
    含 ``.js``）。这里按最后一段的后缀判定，同时保留 ``x.js.txt`` 这类伪装后缀
    （``.js.`` 形态）——伪装是 TVBox 生态常态，但 ``.json`` 不是伪装。
    """
    last = _path_of(api)
    if last.endswith('.py') or '.py.' in last:
        return 'py'
    if last.endswith('.js') or '.js.' in last:
        return 'js'
    return ''


def is_drpy(api, ext=''):
    """drpy 框架源识别。

    drpy 是独立的规则运行时（依赖 ``pdfa``/``pdfh``/``pdft`` 等宿主全局），不是
    CatVod JS 契约的子集。必须单独分类：混进 QuickJS 会在调用期报
    ``ReferenceError`` 并被误判为「JS 源写错了」。drpy 引擎（Node Worker）已
    移除，命中标记的站点固定路由到 unsupported，由诊断页给出准确原因。
    """
    blob = ('%s %s' % (api or '', ext if isinstance(ext, str) else '')).lower()
    return any(marker in blob for marker in DRPY_MARKERS)


def looks_like_jar(api):
    text = str(api or '')
    return text.startswith('csp_') or _path_of(text).endswith('.jar')


def route_site(item, *, api=None, ext='', site_key='', android_enabled=None):
    """下载前路由：只依据配置字段，不发起任何网络请求。

    `api` 可以传入已按最终配置 URL 解析过的绝对地址；缺省用条目原值。
    """
    data = dict(item or {})
    key = str(site_key or data.get('key') or '?')
    resolved_api = str(api if api is not None else (data.get('api') or ''))
    raw_type = data.get('type')
    try:
        # Gson 把 JSON `null` 映射成 int 默认值 0，`config_snapshot._as_int` 也是；
        # 这里若把 None 当非法，同一条目就会「字段矩阵说 type=0、路由说非法」。
        site_type = 0 if raw_type is None else int(raw_type)
    except (TypeError, ValueError):
        return _decide(key, -1, 'unsupported', 'R6-unsupported',
                       'type 字段不是整数，无法判定运行时',
                       error_code='L2_SITE_INVALID')
    if not resolved_api:
        return _decide(key, site_type, 'unsupported', 'R6-unsupported',
                       '站点缺少 api，无法判定运行时', error_code='L2_SITE_INVALID')

    # R1 CMS：type 0/1 是苹果 CMS 的 JSON/XML HTTP 接口，必须是 http(s)。
    if site_type in (0, 1):
        if not resolved_api.lower().startswith(('http://', 'https://')):
            return _decide(key, site_type, 'unsupported', 'R1-cms',
                           'CMS 站点的 api 必须是 http(s) 接口',
                           error_code='L2_SITE_INVALID')
        return _decide(key, site_type, 'cms', 'R1-cms', 'type %d → CMS HTTP 接口' % site_type)

    kind = _script_kind(resolved_api)

    # R2 Python：显式 .py（含伪装后缀）。
    if kind == 'py':
        return _decide(key, site_type, 'python', 'R2-python', 'api 指向 .py → Python Worker')

    # R3 JS / type=4：先识别 drpy（固定不支持），再进 QuickJS。
    if kind == 'js' or site_type == 4:
        if is_drpy(resolved_api, ext):
            # drpy 引擎已移除：识别后固定标记为不支持，避免混进 QuickJS
            # 报 ReferenceError 被误判为「JS 源写错了」。
            return _decide(
                key, site_type, 'unsupported', 'R6-unsupported',
                'drpy 规则源需要独立的 drpy 运行时，当前版本未支持',
                error_code='L2_SITE_UNSUPPORTED')
        return _decide(key, site_type, 'js', 'R3-quickjs',
                       'type=4 或 api 指向 .js → QuickJS Worker')

    # R4/R5 JAR：字节分级前只能确定「需要 JAR」，Android 与否由 refine_with_jar 决定。
    if looks_like_jar(resolved_api):
        return _decide(key, site_type, 'jar', 'R4-jvm-jar',
                       'csp_ 类名或 .jar 直链 → 需按 JAR 字节分级后路由',
                       needs_jar=True)

    # 残余 type=3：内联 Python 源码（无扩展名）走 Python Worker。
    if site_type == 3:
        return _decide(key, site_type, 'python', 'R2-python',
                       'type=3 且无脚本后缀 → 按内联/远程 Python 源处理')

    return _decide(key, site_type, 'unsupported', 'R6-unsupported',
                   'type %d 没有对应运行时契约，不猜测按 CMS 或 JS 处理' % site_type,
                   error_code='L2_SITE_UNSUPPORTED',
                   details={'androidWorkerEnabled': bool(
                       android_worker_enabled() if android_enabled is None else android_enabled)})


def refine_with_jar(decision, report, *, android_enabled=None):
    """拿到 JAR 字节分级后细化 R4/R5，并允许 Android/Dex/native 源回退 JVM。"""
    if decision is None or not decision.needs_jar:
        return decision
    data = dict(report or {})
    level = str(data.get('level') or '')
    signals = [str(v) for v in (data.get('signals') or [])]
    has_dex = bool(data.get('hasDex'))
    has_native = bool(data.get('hasNative'))
    handshake_enabled = android_worker_enabled() if android_enabled is None else bool(android_enabled)
    android_only = (has_dex or has_native or level in ('L2', 'L3', 'L4')
                    or bool(ANDROID_ONLY_SIGNALS.intersection(signals)))
    if android_only:
        return _decide(
            decision.site_key, decision.site_type, 'jar', 'R5-jvm-fallback',
            'JAR 分级 %s（%s）检测到 Android/Dex/native 特征，允许 dex2jar/JVM 回退；'
            '若运行时缺少 Android 能力，将返回实际运行时错误' %
            (level or 'L?', ','.join(signals) or 'dex/native'),
            needs_jar=True, jar_level=level, jar_signals=signals,
            has_dex=has_dex, has_native=has_native,
            details={
                'fallback': 'dex2jar/JVM',
                'androidOnly': True,
                'androidWorkerHandshake': handshake_enabled,
            })
    return _decide(
        decision.site_key, decision.site_type, 'jar', 'R4-jvm-jar',
        'JAR 分级 %s：无 Dex/native/Android 信号 → portable JVM Worker' % (level or 'L0'),
        needs_jar=True, jar_level=level, jar_signals=signals,
        has_dex=has_dex, has_native=has_native)


def capabilities_for(item, decision):
    """按条目声明与路由结论推导能力集合。

    开关语义与 C2.3 字段矩阵共用 :func:`config_snapshot.site_flag`：此前这里用
    `bool(value)`，`searchable=2`（FongMi 里 `isSearchable()` 为 false）会被算成可搜，
    于是同一条目在字段矩阵上不可搜、在能力集合里可搜，搜索请求发出去才失败。
    `filterable` 的默认值同样对齐矩阵（桌面端默认 1），避免两处默认不一致。
    """
    from .config_snapshot import site_flag

    data = dict(item or {})
    caps = ['home', 'detail', 'player', 'proxy']
    if site_flag(data.get('searchable'), 1):
        caps.append('search')
    if site_flag(data.get('quickSearch'), 1) and 'search' in caps:
        caps.append('quickSearch')
    if site_flag(data.get('filterable'), 1):
        caps.append('filter')
    if site_flag(data.get('changeable'), 1):
        caps.append('changeable')
    if decision is not None and decision.runtime == 'unsupported':
        return []
    return sorted(set(caps))
