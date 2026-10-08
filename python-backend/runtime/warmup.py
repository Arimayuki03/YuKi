# -*- coding: utf-8 -*-
"""B-11 Worker 预热：消除「后端就绪但首点某源仍卡 1-3s」。

背景（优化.md 批次 B-2 表格 B-11）：runtime/supervisor.py 是惰性 spawn——
SupervisedRunner 构造时只建 Supervisor 对象，子进程（Python worker/QuickJS/
JVM）在首次 call() 走 _start_locked 时才 spawn，且要过 booted 启动屏障 +
Job attach + ready 握手（jar 源还要在 Worker 内起 JVM + 加载 jar + 执行
spider.init），首请求要等 spawn + boot 全程，JAR 源尤其长。

预热路径：对候选站点的 SupervisedRunner 发一次空 ``homeContent``（走
``runner._invoke``，与真实请求同一调用链）。Supervisor 的 Worker 是**同站点
复用**的（_start_locked 对「process 存活 + connection 健康」早退，见
supervisor.py:279），预热触发的 spawn + boot 只付一次，之后真实首请求直接
复用热 Worker。

节流（优化.md 原话「实测内存峰值后决策」）：预热**串行**逐源进行，源与源
之间间隔 :data:`SITE_GAP_SECONDS`，绝不同时拉满 8 worker——同时 spawn 上限
8 个子进程/JVM 的内存峰值正是要避免的。全局 Worker 上限（_GLOBAL_LRU，总
8 / jar 3）由 supervisor 自己兜底：若预热与其他路径合计超限，超出的预热
请求只会排队/失败并被静默吞掉，不会挤掉在跑的 Worker。

「上次用过的站点」数据来源：lastSourceMap / recentWatches 都只落在渲染层
Electron settings（后端进程读不到，且两者语义分别是「详情页线路索引」与
播放记录），后端没有现成的跨重启「最近使用源」记录。因此用近似来源：
**站点列表前 N 个可请求站点**（FongMi/TVBox 配置里 sites 数组顺序即作者
排的推荐顺序，首页默认展示的正是前几个），N 默认 3（保守起步，上限 8
worker 之内；可用 YUKI_WARMUP_SITES 环境变量覆盖，0 = 关闭预热）。

失败静默（如实语义）：预热只是「提前踩坑」，任何失败（网络/熔断/进程崩溃/
配置热重载）都不影响任何功能——异常被捕获并留 DEBUG/INFO 日志，预热超时走
``probe=True`` 通道不杀 Worker、不记熔断。但「不影响功能」≠「零可观测」：
日志与指标照常产生，只是不再影响熔断记账，也不会向用户报错。
"""
from __future__ import annotations

import logging
import os
import threading
import time

logger = logging.getLogger('yuki.runtime.warmup')

# schedule_warmup 在途去重（L7）：键为 ``(id(sites), 首个站点对象 id)``，
# 值持有 sites 的**强引用**——在途期间对象不可回收，id 不可能被新对象复用，
# 不会把新配置的调度误判成重复。热重载会重建 Site 实例，首个站点对象 id
# 变化即代表新配置（详见 schedule_warmup docstring）。server.py 的两个调度
# 点（配置导入/自动重载 + 启动期磁盘恢复）在启动期会先后各调一次、传同一
# 集合对象——不去重会并发起多份预热线程（重复请求第三方站点 + 日志噪音）。
_pending_lock = threading.Lock()
_pending_warmups: dict[tuple[int, int], object] = {}

# 预热站点数上限（保守起步：N=3 在全局 8 worker 上限内，即使加上预热期间
# 用户真实点击的其他源也不会把池挤爆）。环境变量 YUKI_WARMUP_SITES 可覆盖，
# 0 = 显式关闭预热。
DEFAULT_WARMUP_SITES = 3
# 每源预热之间的间隔：串行 + 间隔把 spawn 摊开，避免内存峰值瞬时拉高。
SITE_GAP_SECONDS = 0.5
# 配置恢复完成后的延迟：避开启动期带宽竞争（磁盘缓存恢复刚结束、渲染端
# 首页请求可能正打进来），也给用户真实首操作留抢先窗口。
START_DELAY_SECONDS = 2.5
# 单源预热的绝对预算（毫秒）：与真实 homeContent 的默认 deadline（15s）持平。
# 预热走的是与真实请求同一 Supervisor.call 链，预算更短只会让慢源预热永远
# 白付一次 spawn+boot（超时路径 probe=True 已不杀 worker/不记熔断，M2），
# 与真实 deadline 持平才能把「预热命中慢源」的价值做实。
WARMUP_DEADLINE_MS = 15000


def warmup_site_count() -> int:
    """预热站点数 N：环境变量 YUKI_WARMUP_SITES（0 = 关闭），默认 3。"""
    raw = os.environ.get('YUKI_WARMUP_SITES')
    if raw:
        try:
            return max(0, min(8, int(str(raw).strip())))
        except (TypeError, ValueError):
            pass
    return DEFAULT_WARMUP_SITES


def _warmup_candidates(sites, count=None):
    """挑选预热候选：站点列表前 N 个「可请求」站点。

    上限取 ``count``（显式传入优先，供测试注入），缺省回落 env 上限
    :func:`warmup_site_count`。此前本函数内部固定读 env，调用方再 ``[:count]``
    截断一次，形成重复约束——显式注入的 count 被静默 min 掉。

    「可请求」= health.healthy（未建成/不兼容/被熔断冻结的站点预热必然
    失败，白付一次 spawn）。排除 ``hide`` 站点（首页/搜索隐藏，用户首点
    到达概率低）。``searchable``/``filterable`` 均为 False 的纯播放源同样
    跳过——但 homeContent 本身不依赖这两个标志，只在两者都显式关闭时才
    排除，避免过度筛选。
    """
    if count is None:
        try:
            n = warmup_site_count()
        except Exception:
            return []
    else:
        n = count
    if n <= 0:
        return []
    picked = []
    for site in list(getattr(sites, 'sites', None) or []):
        if len(picked) >= n:
            break
        if getattr(getattr(site, 'health', None), 'healthy', False) is not True:
            continue
        if getattr(site, 'hide', False):
            continue
        if not getattr(site, 'searchable', True) and not getattr(site, 'filterable', True):
            continue
        runner = getattr(site, 'runner', None)
        if runner is None or not callable(getattr(runner, 'homeContent', None)):
            continue
        picked.append(site)
    return picked


def _warmup_one(site) -> bool:
    """对单站点发一次空 homeContent。返回是否成功（仅用于日志）。

    走 ``runner._invoke('homeContent', False)``——与真实请求同一调用链
    （Supervisor.call → spawn/boot → Runner 派发），这是「预热 worker」的
    正确路径；绕开 app.py 的 JSON 包装层（预热不需要结果的 JSON 形态），
    也不进 _cached_spider_content（预热结果不落会话缓存，真实请求仍按缓存
    语义自己走一遍，避免预热结果污染缓存键）。

    预热请求经 ``bind_runtime_request`` 绑进 contextvar（SupervisedRunner
    的 request/cancel 语义从这里取值），request_id 不指定：预热请求与任何
    HTTP 请求无关联，用随机 id 即可。``probe=True``（M2）：预热是「提前踩坑」，
    超时后 supervisor 保留热 worker、熔断不记账——否则慢源（homeContent 天然
    超过预热预算）每次配置重载都白付一次预热、还会被累计熔断，真实请求反被
    L3_CIRCUIT_OPEN 拒绝。

    注意（2026-10-02）：预热跑在后台 daemon 线程里，持有的 Supervisor
    ``_lifecycle_lock`` 会与主线程的配置热替换互斥——config.py ``_apply()``
    原地换掉站点列表后同步调 ``runner.destroy()``，而 destroy 要先拿这把锁，
    此时本线程正持锁等 homeContent 响应（预算 15s）。预热 3 个源最坏能把
    ``/config/load`` 与自动重载卡住数十秒。故预热结束（含异常路径）必须显式
    ``request.cancel()``，让 supervisor 的 ``raise_if_cancelled`` 尽快放锁。
    """
    from runtime.contracts import RuntimeRequest, bind_runtime_request
    request = RuntimeRequest.create(
        site_key=site.key, method='homeContent', deadline_ms=WARMUP_DEADLINE_MS,
        probe=True)
    try:
        with bind_runtime_request(request):
            site.runner._invoke('homeContent', False)
    finally:
        # 主动结束预热请求：配置热替换要同步 destroy 旧 runner，卡在本线程
        # 持有的 _lifecycle_lock 上会把主线程（/config/load、自动重载）拖住。
        request.cancel('warmup-finished')
    return True


def warmup_sites(sites, *, count=None, site_gap=SITE_GAP_SECONDS):
    """同步预热入口：串行对前 N 个候选站点各发一次空 homeContent。

    供测试直接调用（可注入 count/site_gap）；生产路径经 :func:`schedule_warmup`
    在后台线程里执行。单站点任何异常都吞掉（失败静默），只留 DEBUG 日志。
    """
    if count is None:
        count = warmup_site_count()
    if count <= 0:
        return 0
    # count 是唯一约束：_warmup_candidates 内部此前还独立读一次 env 上限再截断，
    # 于是显式注入的 count 被静默 min 掉（请求 20 只热 3，返回 ok 也等于 3，
    # 调用方无法察觉）。生产路径恒走 env 值所以无感，测试想覆盖默认 3 时必踩。
    candidates = _warmup_candidates(sites, count=count)
    if not candidates:
        logger.info('worker warmup skipped: no eligible sites')
        return 0
    ok = 0
    for index, site in enumerate(candidates):
        if index > 0 and site_gap > 0:
            time.sleep(site_gap)
        try:
            if _warmup_one(site):
                ok += 1
                logger.info('worker warmup ok: site=%s', site.key)
        except Exception as exc:  # 失败静默：预热不影响任何功能
            logger.debug('worker warmup failed: site=%s error=%s', site.key, exc)
    return ok


def schedule_warmup(sites, *, delay=START_DELAY_SECONDS):
    """配置恢复完成后调度预热：延迟 delay 秒后在后台 daemon 线程串行执行。

    供 server.py 在配置加载完成回调处一行接入。返回是否真正启动了预热线程
    （测试用）：对同一站点集合，**在途去重**——已调度未执行完成期间重复调用
    直接忽略并返回 False（server.py 有导入/自动重载与启动恢复两个调度点，
    启动期「恢复成功 + 主进程随后自动重载成功」会先后各调一次，不守卫会并发
    起多份预热）。去重键是 ``(id(sites), id(首个站点对象))``：两次调用传同一
    站点集合对象视为重复；热重载会重建 Site 实例，首个站点对象 id 变化即
    代表新配置，正常调度。
    预热仍自带失败静默，即便配置随后被热重载（旧站点对象销毁）也只会让预热
    请求失败并被吞掉。

    注意（2026-10-02）：仅用 ``id(sites)`` 在生产路径上不成立——server.py 的
    ``sites = SiteManager()`` 是**进程级单例**，config.py ``_apply()`` 用
    ``self.sites.sites[:] = ...`` 原地替换列表而不换 SiteManager 实例。于是
    「配置热重载后传新对象 → 正常调度」的语义从不生效，真正要重热的那一轮
    （新配置、新站点集合）会被判为重复丢掉，只有启动期第一次生效。故补上
    首个站点对象的 id 一起成键：热重载会重建 Site 实例，首个站点对象身份
    变化即视为新一轮；同批站点对象复用（未重载）时 id 不变，仍按重复去重。
    （不能直接用 ``id(sites.sites)``：``_apply()`` 对列表是原地切片赋值，
    列表对象身份恒定，做不出区分。）
    """
    if warmup_site_count() <= 0:
        return False
    site_list = getattr(sites, 'sites', None)
    with _pending_lock:
        # 第二分量取首个站点对象 id：热重载重建 Site 实例后 id 变化即新配置；
        # 空列表（无站点可预热）以 0 占位，同批仍去重。
        key = (id(sites), id(site_list[0]) if site_list else 0)
        if key in _pending_warmups:
            logger.debug('worker warmup already scheduled, skip duplicate')
            return False
        # 占位即持强引用：本批在途期间 sites 不可回收，id 无复用窗口
        _pending_warmups[key] = sites

    def _run():
        try:
            if delay > 0:
                time.sleep(delay)
            warmup_sites(sites)
        except Exception:  # 双保险：warmup_sites 内已逐源兜底
            logger.debug('worker warmup crashed', exc_info=True)
        finally:
            with _pending_lock:
                # 键由本批次写入且在途期间对象存活、id 无复用，按 key 清除即安全
                _pending_warmups.pop(key, None)

    thread = threading.Thread(target=_run, name='yuki-worker-warmup', daemon=True)
    try:
        thread.start()
    except Exception:
        # start 失败（如线程资源耗尽的 RuntimeError）时 _run 不会执行、其
        # finally 不会清占位——必须回滚，否则该键永久残留，进程内预热从此
        # 静默关闭（M2）。
        with _pending_lock:
            _pending_warmups.pop(key, None)
        raise
    return True
