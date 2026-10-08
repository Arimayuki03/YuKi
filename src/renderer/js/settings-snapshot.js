/**
 * settings-snapshot.js — 设置内存快照层（A-27：主链路 settingsGet IPC 收口）
 *
 * 背景与定位：
 *   详情页 load()、playSelected 与播放器起播链路（player.js play()）串行 await
 *   settingsGet IPC 多次，起播路径每帧 3 次串行 IPC 往返增加首帧延迟。本模块把
 *   「主链路读设置」从逐次 IPC 收口为一次全量快照 + 内存直读。
 *
 * 与 preload.js 3s TTL 缓存的两层语义（不打架论证）：
 *   - preload 层（src/preload/preload.js:12-17）：settingsGet 的 3 秒写穿透缓存，
 *     职责是「同一次交互内的连续读合并」，跨交互/主进程侧直写在 TTL 后自愈——
 *     它是**短时合并层**，无法支撑主链路「长驻内存」语义（3s 过期后每帧仍走 IPC）。
 *   - 本快照层：职责是「渲染层长驻内存 + 显式失效」，首读经 preload.settingsGet
 *     拉**全量**（一次 IPC，preload 内部又落在 yuki:settings-get），之后一律内存直读，
 *     只在 invalidate() 后的第一次读才再次穿透。快照层不重复调 IPC，所以 preload
 *     的 3s TTL 对它无影响；而快照命中路径完全绕开 preload，TTL 也不再消耗。
 *   - 分层读链：调用方 → SettingsSnapshot.get()（内存）→ preload TTL 缓存（兜底合并）
 *     → yuki:settings-get IPC → 主进程 settings.all()（权威）。两层各管一段，
 *     失效方向一致（自上而下穿透），不存在「快照引用了 preload 旧缓存」的循环：
 *     快照仅在首读/失效后读一次 preload，之后与 preload 解耦。
 *
 * 失效通道（既有「事件 + 轮询」口径的落地）：
 *   docs/ARCHITECTURE.md §2 的「事件 + 轮询」双通道针对的是**配置自动重载**
 *   （yuki:config-reloaded），主进程对 settings-set 本身没有广播通道（preload API
 *   清单被 tests/js/preload-contract.test.js 钉死，禁改）。因此失效按「渲染层写入
 *   自知」实现，三保险：
 *   ① 写失效：设置页/kazumi.js 等经 yuki.settingsSet 的写入都汇聚在 DOM 的 change
 *      事件上（开关/输入框 value 变更），document 级**冒泡段**委托监听（监听段选择
 *      论证见 _bindInvalidation）。监听触发时页面 change handler 已发出 settingsSet
 *      但尚未落盘——失效与落盘**解耦**（M11）：change 信号先抬写世代（旧快照/旧在
 *      途读立即失去「新鲜」资格），再以一次 no-op echo 写（__snapSettle，键在主进程
 *      settings-set 白名单外被直接忽略）作 IPC fence——渲染层→主进程 IPC 保序，
 *      echo resolve ⟹ 此前所有写请求已被主进程处理、preload 写穿透缓存已刷新——
 *      此刻才 invalidate()；写在途期间 get/getFresh 等 settle 链结束后才穿透读。
 *      主进程对话框直写键（mpvPath/cacheDir/dlDir/anime4k 等）不经渲染层 DOM，
 *      走②兜底。
 *   ② 兜底失效：本模块提供 ageMs()/age 超过兜底时限（90s，参考主进程 assetStatus
 *      60s 探测缓存量级）后下一次 get() 自动穿透重拉。低频写场景（优化.md 风险
 *      登记口径）下短暂不一致可接受，兜底时限只是收敛上界。
 *   ③ 强刷：getFresh() 供「改完立即读」的精确场景，绕过快照直读并回填缓存。
 *
 * 沙箱兼容：测试 VM 只加载本文件时 window 无 yuki/未挂 DOM——所有依赖点
 * typeof 守卫降级为直读 settingsGet（行为与改造前完全一致）；change 派发时
 * settingsSet 缺失/同步抛错则退化为立即失效（try 守卫，不向派发方冒泡）。
 */
(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;

    /** 失效 fence 的 no-op 写键：在主进程 settings-set 白名单（M-1）之外 → 直接忽略不落盘 */
    const SNAP_SETTLE_KEY = '__snapSettle';

    let _snap = null;      // 全量快照（settingsGet 返回的对象，只读消费）
    let _snapAt = 0;       // 快照建立时间戳（兜底过期判定用）
    let _snapToken = 0;    // 快照安装时的写世代：与 _writeToken 漂移即视为旧（M11 世代守卫）
    let _writeToken = 0;   // 写世代（L41/审查3.3 inflight 世代标记）：每次写信号 ++ 且永不复用。
                           // 「写入开始 inflight=true、settle 后 false」的世代化表达：世代落后
                           // 即写仍在途，其前建立的快照/在途读都不得当作新鲜值复用。
    let _writesInflight = 0;              // 在途写信号计数（>0 = 有写未过 fence）
    let _settleChain = Promise.resolve(); // 最近一次写信号的 settle 链（fence resolve → invalidate）
    let _inflight = null;  // 在途穿透读 { token, promise }：并发首读合并 + 世代一致性校验
    const FALLBACK_MAX_AGE = 90000; // 兜底失效时限（90s）：无写失效信号时的陈旧上界

    /**
     * 穿透读一次全量（读失败不缓存，保持「下次再试」语义）。
     * 回填有世代守卫：起读后若有新写信号（token 漂移），本次读不含该写入，
     * 不得污染快照（其返回值仍交给调用方——其发起读时该写入尚未发生，语义自洽）。
     */
    async function _refresh() {
        const token = _writeToken; // 起读世代
        const all = await root.yuki.settingsGet();
        const snap = all || {};
        if (token === _writeToken) {
            _snap = snap;
            _snapAt = Date.now();
            _snapToken = token;
        }
        return snap;
    }

    /** 发起/复用一次穿透读：在途读仅当世代一致（起读后无新写信号）才可复用。 */
    function _pierce() {
        if (_inflight && _inflight.token === _writeToken) return _inflight.promise;
        const token = _writeToken;
        let p;
        p = _refresh().finally(() => {
            if (_inflight && _inflight.promise === p) _inflight = null; // 身份比对：防误清后继新槽
        });
        _inflight = { token, promise: p };
        return p;
    }

    /**
     * 主链路读设置：快照命中同步回内存对象，未命中穿透一次。
     * 返回 Promise（调用方以 await 消费——即便命中也是已决微任务，链路语义不变）；
     * 命中时直接返回快照引用本体，调用方只做字段读取（s.autoNext 等），不存在
     * 写回路径；需要就地修改的场景（lastSourceMap 读改写）由调用方 _clone。
     */
    async function get() {
        // 旧快照弃用两线：兜底超龄；写世代漂移（写信号已到，旧值不得再当新鲜值返回）
        if (_snap && ((Date.now() - _snapAt) > FALLBACK_MAX_AGE || _snapToken !== _writeToken)) {
            _snap = null;
        }
        if (_snap) return _snap;
        if (_writesInflight > 0) {
            // 写在途：等 settle fence（落盘 + preload 写穿透刷新）后再穿透，杜绝
            // 「读请求发出时写入尚未落盘」的半新半旧窗口（M11）。
            const chain = _settleChain;
            await chain;
            return get(); // settle 后重走全部守卫（期间可能有并发读回填/新写信号）
        }
        return _pierce();
    }

    /**
     * 清快照：设置写入后调用，下一次 get() 重新穿透。
     * M16：失效必须同时抬写世代——只清 _snap/_snapAt 时，在途穿透读完成后
     * `token === _writeToken` 判定成立，会把旧数据回填快照，抹掉本次失效。
     * 抬世代使在途穿透读结果失去回填资格；_onWrite 的 .then(invalidate) 多抬
     * 一次无副作用（世代只要求单调，不要求精确对应写入次数）。
     */
    function invalidate() {
        _writeToken += 1;
        _snap = null;
        _snapAt = 0;
    }

    /** 强刷：绕过快照直读（改完立即读的精确场景），并回填缓存。 */
    async function getFresh() {
        invalidate();
        if (_writesInflight > 0) {
            const chain = _settleChain;
            await chain; // 写在途：同样等落盘 fence，不拿旧值充当新鲜（M11/审查3.3）
        }
        return _pierce();
    }

    /** 快照年龄（ms）：无快照时返回 null。测试/诊断用。 */
    function ageMs() {
        return _snap ? (Date.now() - _snapAt) : null;
    }

    /**
     * 写信号处理（change 冒泡到 document，after-change：页面 handler 已发出 settingsSet）：
     *   1. 抬写世代：旧快照与旧世代在途读立即失去「新鲜」资格（读取侧守卫生效）；
     *   2. 以 echo 写作 IPC fence：settingsSet 走 invoke 无缓存、必有一次往返，且渲染层
     *      →主进程消息保序 ⟹ echo resolve 时页面写已落盘、preload 写穿透已刷新；
     *      echo 键在白名单外被主进程忽略，零副作用（仅 preload 缓存多一个无人读的键）；
     *   3. fence resolve 后才 invalidate——失效动作移到落盘之后（.then），消除
     *      「失效早于落盘」的毫秒级竞态（M11）。fence 失败（IPC 异常）同样失效兜底，
     *      收敛回旧行为，不向 change 派发方冒泡。
     * 为何不直接等页面那次 settingsSet：contextBridge 暴露的 yuki 只读、页面各处
     * 直调 window.yuki.settingsSet，本模块无法观测其 promise（页面/preload 禁改），
     * echo fence 是不改协作方的等价时序保证。
     */
    function _onWrite() {
        _writeToken += 1;
        _writesInflight += 1;
        let echo = null;
        try {
            echo = root.yuki.settingsSet(SNAP_SETTLE_KEY, null);
        } catch (e) {
            echo = null; // 沙箱降级：yuki/settingsSet 缺失或同步抛错 → 退化为立即失效
        }
        const settled = Promise.resolve(echo).then(invalidate, invalidate);
        settled.finally(() => { _writesInflight -= 1; });
        // 累积链（非覆盖）：等待方要等**所有**已发写信号 settle，后写接在前写之后，
        // 防止并发写下后写 settle 先返回、早写仍在途时 get() 重入空转。
        _settleChain = _settleChain.then(() => settled, () => settled);
        return settled;
    }

    /**
     * 失效信号绑定（M11 统一口径：监听段 = document 冒泡段，实现与注释一致）。
     * 为何冒泡段足够：change 在 input/select/textarea 上原生冒泡，设置页全部写入都
     * 发生在控件 change handler 内（panels.js/kazumi.js），一个 document 冒泡段委托
     * 即可覆盖全部控件写入（password/textarea 同覆盖）——不存在需要 capture 截获的
     * 不冒泡 change 源。
     * 为何不用 capture：
     *   - capture 在目标 change handler **之前**触发，此刻 settingsSet 尚未发出、
     *     无写可等，与「等落盘后再失效」的 fence 时序根本相悖；
     *   - capture 段不受目标侧 stopPropagation 影响，会对「被 UI 吞掉、实际未发生
     *     写入」的 change 也发信号；冒泡段 after-change 与「写入确实发生」对齐。
     * 残余风险登记：若未来 UI 对 change 调 stopPropagation，冒泡段会漏失效——
     * 由②90s 兜底与③getFresh 收敛（头部注释口径）。
     */
    function _bindInvalidation() {
        const doc = (typeof document !== 'undefined') ? document : null;
        if (!doc || !doc.addEventListener) return;
        // 收窄信号源：document 冒泡段会收到大量**与设置无关**的 change——
        // 切源（home #site-select）、换直播源（live #live-select）、下载排序
        // （downloads #dl-sort，只写 localStorage）、分集全选（detail
        // #ep-check-all，纯 UI）、推荐标签（popular #popular-tags）、Bangumi
        // 筛选草稿（bangumi-search #bgm-season-select/日期/评分）、代理开关
        // （panels #set_proxy_enable，只做表单展开；注意它并未被下方选择器排除
        // ——控件在 #view-settings 内，切换会白发一次 fence IPC 与抬世代，代价
        // 可接受）、日志来源翻页（panels
        // #log-source）。把这些也算作设置写入的代价：①每次白发一次 __snapSettle
        // fence IPC + 一次全量 settingsGet 重拉，正好落在「切源后立即进详情/起播」
        // 这类主链路上；②抬 _writeToken 后 _writesInflight>0，get() 必须先 await
        // _settleChain 再穿透——首帧读设置从「内存直读」退化成「等一次 IPC 往返 +
        // 一次全量 IPC」，比改造前更慢。只认设置容器内的控件。
        doc.addEventListener('change', (evt) => {
            const t = evt && evt.target;
            // 无法判定来源时（桩 DOM/无 closest）按写入处理，不改变既有语义
            if (!t || typeof t.closest !== 'function') { _onWrite(); return; }
            if (!t.closest('#view-settings, [data-setting-key]')) return;
            _onWrite();
        }, false); // 显式冒泡段（第三参 false）
    }

    _bindInvalidation();

    const SettingsSnapshot = { get, getFresh, invalidate, ageMs };
    root.SettingsSnapshot = SettingsSnapshot;
    const ns = root.YUKI || {};
    ns.settingsSnapshot = SettingsSnapshot;
    root.YUKI = ns;
})();
