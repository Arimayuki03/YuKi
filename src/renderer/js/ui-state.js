/**
 * ui-state.js — 页面 UI 状态持久化（切页/重启不回初始态）
 *
 * 各浏览页（首页/搜索/推荐/时间表/直播/我的）把「用户选择态」写入 localStorage，
 * 切换页面回来或重启应用后恢复原状，而不是回到默认初始值：
 *   - 首页：选中源、视图模式（全部/分类/搜索）、分类 id、页码、关键词
 *   - 搜索：激活页签、各页签关键词、最近一次结果快照（限量限时）
 *   - 推荐：标签筛选、页码；时间表：星期/季度/排序/收藏过滤/页码
 *   - 直播：选中的直播源（按 URL 认源，不随下拉重排漂移）、分组；我的：活动页签
 *
 * 设计要点：
 *   - 独立键前缀 yuki_uistate::，与 cache.js 的 yuki_cache:: 互不干扰；
 *     设置页「清理缓存」清 yuki_cache:: 命名空间时不误删 UI 状态。
 *   - 总开关：设置 → 外观 →「页面状态记忆」（isEnabled/setEnabled）。关闭后
 *     get/set 直接空转，各页回退初始态行为；已落盘数据保留，重开即恢复。
 *   - 只存轻量选择态（键值/页码），不存列表内容体（结果快照由 search.js 自行限量落盘）。
 *   - 全部读写 try/catch 静默失败：持久化是体验优化，绝不影响主流程。
 *   - 沙箱兼容：测试 VM 不加载本文件，调用方一律 `typeof UIState` 守卫降级为不持久化。
 */
(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;
    const NS = 'yuki_uistate::'; // 命名空间前缀

    // 总开关（设置 → 外观 → 页面状态记忆）：关闭后本模块不再读取/写入任何页面状态，
    // 各页回退「切页/重启回初始态」的旧行为。启动时由 app.js 按持久化设置同步一次，
    // 设置页切换时实时更新。默认开启。已落盘的状态保留不删——重新开启后自动恢复生效。
    let _enabled = true;

    function isEnabled() { return _enabled; }

    function setEnabled(v) { _enabled = v !== false; }

    function _ls() {
        try { return root.localStorage; } catch (e) { return null; }
    }

    /** 读取某页的持久化状态；总开关关闭/未存/损坏/环境不可用时返回 null。 */
    function get(key) {
        if (!_enabled) return null;
        const ls = _ls();
        if (!ls || !key) return null;
        let raw = null;
        try { raw = ls.getItem(NS + String(key)); } catch (e) { return null; }
        if (!raw) return null;
        try {
            const v = JSON.parse(raw);
            return (v && typeof v === 'object') ? v : null;
        } catch (e) {
            try { ls.removeItem(NS + String(key)); } catch (e2) { /* ignore */ }
            return null;
        }
    }

    /** 写入某页状态（整体覆盖式快照）。总开关关闭/失败静默放弃。 */
    function set(key, value) {
        if (!_enabled) return false;
        const ls = _ls();
        if (!ls || !key || !value || typeof value !== 'object') return false;
        try {
            ls.setItem(NS + String(key), JSON.stringify(value));
            return true;
        } catch (e) { return false; }
    }

    /** 删除某页状态（如用户显式重置该页）。不受总开关限制（清理动作应始终可执行）。 */
    function del(key) {
        const ls = _ls();
        if (!ls || !key) return;
        try { ls.removeItem(NS + String(key)); } catch (e) { /* ignore */ }
    }

    root.UIState = { get, set, del, isEnabled, setEnabled };
    root.YUKI = root.YUKI || {};
    root.YUKI.uiState = { get, set, del, isEnabled, setEnabled };
})();
