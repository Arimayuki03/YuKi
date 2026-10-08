/**
 * detail.js — 统一详情页（合并 CatVod 与 Bangumi 详情，仿 Kazumi InfoPage 设计）
 *
 * 布局：
 *  - 头部：封面 + 标题/元信息 + 收藏/标记按钮
 *  - 页签：概览 | 分集 | 选集讨论 | 吐槽 | 角色 | 制作 | 关联
 *  - 概览：可收起简介 + 播放源/选集
 *  - 其他页签：Bangumi 数据（仅当匹配到 Bangumi 时显示）
 */
/* global $, doAction, escHtml, stripHtml, normalizePic, warnToast, showLoading, hideLoading, registerEsc, openDialog, closeDialog, App, Player, Records, abortCoverFill, Kazumi, FavHub, bangumiCover, bangumiCoverImg, bangumiResizeUrl, bangumiWebUrl, localCacheGet, localCachePeek, localCacheSet, localCacheDel, BgmRate, replayClass, staggerEnter, fmtCommentTimeFull, commentTsMs, SettingsSnapshot, DetailSnap, skeletonHtml */

const DETAIL_TABS = ['概览', '分集', '选集讨论', '吐槽', '角色', '制作', '关联'];

/** 详情内容缓存（T74）：site|vodId → vod。迁移到 localStorage 持久缓存（cache.js），
 *  重复打开 / 重启即时上屏免重新拉取。TTL 见各写入点；纳入设置页「清理缓存」。
 *  TTL 30min 与后端 mem_cache 的 spider:detail（1800s）对齐——前端缓存过期回源时
 *  后端大概率仍命中，两级缓存同周期避免「前端过期但后端也没了」的重复回源。
 *  SWR（stale-while-revalidate）：条目落盘 TTL 30min 过期后**不删除**（cache.js
 *  peek 侧支持读陈旧条目），30min~7 天窗口内再次打开用陈旧数据秒开整页 + 后台
 *  校准（_swrRevalidate）；超 7 天才真正作废回源。 */
const DETAIL_CACHE_TTL = 30 * 60 * 1000;
// SWR 垫场上限：缓存写入后 7 天内都可作为「陈旧垫场」秒开（追更间隔远小于此，
// 后台校准秒级补齐新鲜度）；超 7 天的条目按未命中处理（信息时效风险大于秒开收益）。
const DETAIL_SWR_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const DETAIL_VOD_CACHE_PREFIX = 'detail::vod::v1::';       // + site|vodId → CatVod 详情
const DETAIL_BGMEXTRA_CACHE_PREFIX = 'detail::bgmextra::v1::'; // + bgmId → {comments,characters,staff,relations}
const DETAIL_BGMEXTRA_TTL = 30 * 60 * 1000;                // Bangumi 角色/制作/关联/吐槽 30 分钟

// 评分入口补查等待上限（ms）：转圈超过此时长先无预填开窗，晚到数据后台合并——
// 弱网/接口挂起时用户不必苦等弹窗（防「点击后转圈好久」回归的保险丝）
const RATE_FETCH_TIMEOUT_MS = 4000;

// A-28 收藏态双查降频：详情页打开时 Bangumi 收藏「缓存回填 + force 回源对账」不再
// 无条件双发，force 对账仅在距上次对账超过 A-28_COL_RECONCILE_TTL，或自上次对账后
// 发生过收藏写操作（_colReconcileDirty 置脏）时进行。写操作广播中心是 records.js
// FavHub（recSet('favorites') 内 changed()），detail.init() 已订阅——置脏挂在同一
// 订阅回调上；本应用内写路径（setBangumiCollection/remove/打点/Records.setFavTag）
// 均乐观更新收藏缓存或经 FavHub 广播，故非 force 窗口内用户看到的是写入后的最新态。
const A_28_COL_RECONCILE_TTL = 5 * 60 * 1000;              // force 对账最小间隔（5 分钟）

/** A-28：是否应该做一次 force 收藏对账（模块级共享：与实例无关，全应用一个节奏）。 */
function _detailColForceDue() {
    const last = Number(Detail._colReconcileTs) || 0;
    if (Detail._colReconcileDirty) return true;              // 写操作置脏：立即对账
    return (Date.now() - last) >= A_28_COL_RECONCILE_TTL;    // 超过 5min 窗口：对账一次
}
/** A-28：force 对账发起成功后记录时间戳并清脏标记（所有调用点统一走这里）。 */
function _detailColMarkReconciled() {
    Detail._colReconcileTs = Date.now();
    Detail._colReconcileDirty = false;
}

/** A-27：快照读改写隔离——SettingsSnapshot.get()/getFresh() 命中路径返回快照引用
 *  本体，调用方要就地修改（lastSourceMap 读改写）时必须先深拷贝。直读回退路径
 *  （settingsGet 已在 preload 深拷贝）也统一走一遍拷贝，语义收敛为「拿到独立副本」。 */
function _cloneSnap(snap) {
    try { return structuredClone(snap); } catch (e) {
        try { return JSON.parse(JSON.stringify(snap)); } catch (e2) { return snap; }
    }
}

/** 读 localStorage 详情缓存（未命中/无 helper 返回 null）。 */
function _detailCacheGet(prefix, key) {
    if (typeof localCacheGet !== 'function' || !key) return null;
    try { return localCacheGet(prefix + key); } catch (e) { return null; }
}
/** 写 localStorage 详情缓存（空值不落盘，无 helper 静默跳过）。
 *  详情类条目显式走大池（B-10 opts.pool:'big'）：detail vod 整包（vod_play_url
 *  可达数百 KB）与 bgmextra（吐槽 100 条 + 角色卡）本就是大条目，混在小池会被
 *  本批新增的高频小写入（列表快照/封面补拉/分集缓存，每次点卡片都在写）按 LRU
 *  快速挤出——表现为「以前 10 分钟内重开必命中秒开，现在频繁 miss 回源转圈」。
 *  大池 3MB 独立记账，详情条目互斥驱逐，命中率恢复到单池时代水平。 */
function _detailCacheSet(prefix, key, value, ttl) {
    if (typeof localCacheSet !== 'function' || !key || value == null) return;
    try { localCacheSet(prefix + key, value, ttl, { pool: 'big' }); } catch (e) { /* 缓存失败忽略 */ }
}

/** 失败态空区一行式 HTML（A-03）：错误文案 + 重试按钮，复用既有 .tip-line /
 *  md-btn md-btn-tonal 样式不新造视觉。retryFn 由各调用点给全局 id 绑定监听，
 *  这里只负责拼装，避免「请求失败」被渲染成「暂无数据」迷惑用户（网络错误 ≠ 空列表）。 */
function _detailRetryHtml(message, retryAttr) {
    return `<div class="tip-line detail-retry-line"><span>${escHtml(String(message))}</span>`
        + `<button type="button" ${retryAttr} class="md-btn md-btn-tonal md-btn-sm">重试</button></div>`;
}

/** 统一骨架占位（A-02 第二阶段接线）：8 处「加载中」.tip-line 文本占位换成
 *  common.js skeletonHtml 的对应形态（hero/card/comment）。fallback 文案是
 *  沙箱/异常兜底：skeletonHtml 未加载（单测 VM 桩只载 detail.js）或运行时异常时
 *  回落原 .tip-line 文本——保证占位永不中断渲染主流程（与 skeletonHtml 自身的
 *  「静默兜底」口径一致）。错误态不走这里：_bgmExtraFailed 判定优先于骨架。 */
function _detailSkeleton(kind, opts, fallbackText) {
    try {
        if (typeof skeletonHtml === 'function') return skeletonHtml(kind, opts);
    } catch (e) { /* 骨架拼装异常回落文本占位 */ }
    return `<div class="tip-line">${escHtml(String(fallbackText || '加载中…'))}</div>`;
}

/** A-30：两个 lain 图床 URL 是否为「同一张图的不同尺寸变体」。
 *  lain 封面有两种形态，同一张图的尺寸差异体现在不同位置：
 *   - API 形式 .../r/{宽}/pic/cover/l/{路径} → 尺寸由 r 宽度承担（large 无 r 前缀）；
 *   - 裸路径 .../pic/cover/{lcmgs}/{路径}   → 尺寸由段字母承担。
 *  归一化：剥 r 前缀、段字母统一为 l，剩下的 {主机}/{路径} 即图的身份指纹。
 *
 *  存在意义：详情页 hero 用 large 变体，而列表卡（快照来源）用 card/common 变体，
 *  两者逐字必然不同——旧 keepSnapCover 只做全等比较，导致「快照封面沿用」防闪机制
 *  在 Bangumi 路径上从未生效（每次完整 render 都换 URL 重走代理链 → 占位→显示→闪）。
 *  非 lain 域名（CatVod 源/第三方图床）不存在尺寸变体语义，一律按不等处理。 */
function _detailSameCoverPicture(a, b) {
    const ua = String(a || '');
    const ub = String(b || '');
    if (!ua || !ub) return false;
    if (ua === ub) return true;
    // A-36：先解包本项目自己的封面代理再比较。
    // 背景（收藏/历史详情页「封面刷新一下」的真因）：列表卡封面存在两种形态——
    //   · 推荐/时间表/搜索卡走 vodCoverImg 直连 lain 就是这个地址；
    //   · 收藏/历史卡（recCard）对 Bangumi 图走 bangumiCoverImg → 本地代理包装
    //     `${backend.base}/kazumi/cover?token=...&url=<encodeURIComponent(origin)>`。
    // _snapFieldsFromCard 刻意「原样捕获」卡片正在显示的 URL，于是收藏入口写进
    // DetailSnap 的 pic 是代理串。而完整 render 的结果封面是 lain 直连 large，
    // 二者主机名分别是 127.0.0.1 与 lain.bgm.tv —— 下方 lainRe 闸门直接判否，
    // keepSnapCover 从未生效，hero 每次都换新 URL 的 <img>（基态 opacity:0 再淡入）
    // = 用户看到的「封面刷新一下」。
    // 修正：比较前先把代理 URL 还原成它里面包着的那个 origin URL，两个 covers
    // 随即回到「lain 直连 card ↔ lain 直连 large」这一已被正确处理的情形。
    // 只认自家的 /kazumi/cover 端点（带 url 参数），其余原样返回。
    const unwrapProxy = (u) => {
        const s = String(u || '');
        if (!s || !/\/kazumi\/cover(\?|#|$)/i.test(s)) return s;
        try {
            const q = s.slice(s.indexOf('?') + 1).split('#')[0];
            const hit = /(?:^|&)url=([^&]+)/.exec(q);
            if (!hit) return s;
            return decodeURIComponent(hit[1]) || s;
        } catch (e) { return s; } // 解码失败（畸形百分号转义）：按不等处理更安全
    };
    const ua2 = unwrapProxy(ua);
    const ub2 = unwrapProxy(ub);
    if (ua2 === ub2) return true;
    // 只认 lain 图床（官方/镜像域）：只有它有可归一化的尺寸变体。
    // 镜像根域名可配置（lain.{根域名}，默认 bangumi.vip），不能写死域名列表——
    // 用 lain.<任意主机名> 的形态判定，再由下方「路径指纹相同」保证确为同图
    // （不同图床恰好同路径的概率可忽略，且误判的最坏后果只是沿用一张已缓存的
    // 同构图，不会出错图）。
    const lainRe = /^(https?:\/\/)?lain\.[^/]+\//i;
    if (!lainRe.test(ua2) || !lainRe.test(ub2)) return false;
    // 顺序与锚点都有依赖（剥离会改变开头字符，后续正则的前置 `/` 会失配）：
    // ① 先剥 r 宽度前缀（剥主机后 URL 以 `r/400/...` 开头，前置 `/` 不再成立）；
    // ② 再剥 lain 主机（官方/镜像同图）；
    // ③ 尺寸段统一为 l：此时 URL 以 `pic/cover/{字母}/` 开头，无前导 `/`，
    //    故用 `(^|\/)pic\/cover\/` 双锚点匹配（直接写 `\/pic\/cover\/` 会漏）。
    const norm = (u) => String(u)
        .replace(/^https?:\/\//i, '')
        .replace(/\/r\/\d+(?=\/pic\/cover\/)/i, '')        // 剥 r 宽度前缀（先于剥主机）
        .replace(/^lain\.[a-z0-9.-]+\//i, '')              // 剥 lain 主机（官方/镜像同图）
        .replace(/(^|\/)pic\/cover\/[a-z](\/)/i, '$1pic/cover/l$2'); // 尺寸段统一为 l
    return norm(ua2) === norm(ub2);
}

/** 快照 vod 半渲染态（A-01 第二阶段）：DetailSnap 命中时把快照四字段（pic/name/
 *  remarks/year）构造成最小 vod 形状，render() 无 sources 即可先出 hero。字段名
 *  对齐 CatVod vod 字段（vod_pic/vod_name/vod_remarks/vod_year），metaLine 与
 *  render 现有分支零改动直读；site/vodId 由调用方（open()）已写入实例状态。 */
function _detailSnapVod(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const vod = {};
    if (snap.pic) vod.vod_pic = String(snap.pic);
    if (snap.name) vod.vod_name = String(snap.name);
    if (snap.remarks) vod.vod_remarks = String(snap.remarks);
    if (snap.year) vod.vod_year = String(snap.year);
    return (vod.vod_pic || vod.vod_name) ? vod : null;
}

/** 快照 bgm 半渲染态（Bangumi 路径，与 _detailSnapVod 同手法）：openBangumi()
 *  命中列表快照时构造最小 bgm 形状（id/name_cn/images），render() 以 hasBgm=true
 *  版面先出 hero——快照封面是列表卡正在显示的 origin URL（bangumiCoverImg 缺省
 *  card 口径下 URL 逐字不变），bangumiInfo 返回后整页覆盖。subjectId 由调用方注入
 *  （DetailSnap 快照结构零改动，不必为 bgm 路径扩字段）。操作行按钮的点击 handler
 *  均读实例态（_bgmId/vodName 已在 openBangumi 先行写入），半渲染期即真实可用。 */
function _detailSnapBgm(snap, subjectId) {
    if (!snap || typeof snap !== 'object') return null;
    const bgm = { id: String(subjectId || '') };
    if (snap.name) bgm.name_cn = String(snap.name);
    if (snap.pic) bgm.images = { large: String(snap.pic) };
    bgm.tags = []; bgm.rating = {}; bgm.collection = {};
    return bgm.id && (bgm.name_cn || bgm.images) ? bgm : null;
}

/** 收藏状态图标：对齐 Kazumi CollectButton 的官方映射（lib/bean/widget/collect_button.dart
 *  getIconByInt——1在看=favorite 2想看=star_rounded 3搁置=pending_actions 4看过=done
 *  5抛弃=heart_broken 未追=favorite_border；Kazumi 内部编号与 Bangumi API 编号不同，
 *  此处按状态语义对齐到本项目的 Bangumi 口径）。SVG path 取自 Material Icons Round
 *  字体字形（24 viewBox，currentColor 随按钮着色）。 */
const DETAIL_COL_ICON_PATHS = {
    favorite: 'M13.36 20.11C12.61 20.81 11.44 20.81 10.64 20.11L10.55 20.02C5.3 15.28 1.88 12.14 2.02 8.3C2.06 6.56 2.95 4.97 4.36 3.98C6.98 2.2 10.22 3.05 12.0 5.11C13.78 3.05 17.02 2.2 19.64 3.98C21.05 4.97 21.94 6.56 21.98 8.3C22.12 12.14 18.7 15.28 13.45 20.06L13.36 20.11Z',
    star_rounded: 'M12.0 17.25 16.17 19.78C16.92 20.25 17.86 19.55 17.62 18.7L16.55 13.97L20.2 10.78C20.86 10.22 20.53 9.14 19.64 9.05L14.81 8.62L12.94 4.17C12.56 3.38 11.44 3.38 11.06 4.17L9.19 8.62L4.36 9.05C3.47 9.09 3.14 10.22 3.8 10.78L7.45 13.97L6.38 18.7C6.14 19.55 7.08 20.25 7.83 19.78L12.0 17.25Z',
    pending_actions: 'M18.0 3.0H14.81C14.39 1.83 13.31 0.98 12.0 0.98C10.69 0.98 9.61 1.83 9.19 3.0H6.0C4.92 3.0 3.98 3.89 3.98 5.02V20.02C3.98 21.09 4.92 21.98 6.0 21.98H12.09C11.53 21.42 11.06 20.77 10.69 20.02H6.0V5.02H8.02V6.0C8.02 7.08 8.91 8.02 9.98 8.02H14.02C15.09 8.02 15.98 7.08 15.98 6.0V5.02H18.0V10.08C18.7 10.17 19.36 10.41 20.02 10.69V5.02C20.02 3.89 19.08 3.0 18.0 3.0ZM12.0 5.02C11.44 5.02 11.02 4.55 11.02 3.98C11.02 3.47 11.44 3.0 12.0 3.0C12.56 3.0 12.98 3.47 12.98 3.98C12.98 4.55 12.56 5.02 12.0 5.02ZM17.02 12.0C14.25 12.0 12.0 14.25 12.0 17.02C12.0 19.78 14.25 21.98 17.02 21.98C19.78 21.98 21.98 19.78 21.98 17.02C21.98 14.25 19.78 12.0 17.02 12.0ZM18.28 18.98 16.64 17.34C16.55 17.25 16.5 17.11 16.5 17.02V14.53C16.5 14.25 16.69 14.02 16.97 14.02C17.25 14.02 17.48 14.25 17.48 14.53V16.78L18.98 18.28C19.17 18.52 19.17 18.8 18.98 19.03C18.8 19.22 18.47 19.22 18.28 18.98Z',
    done: 'M9.0 16.22 5.48 12.7C5.11 12.33 4.5 12.33 4.08 12.7C3.7 13.08 3.7 13.69 4.08 14.11L8.3 18.28C8.67 18.7 9.33 18.7 9.7 18.28L20.3 7.69C20.67 7.31 20.67 6.7 20.3 6.28C19.92 5.91 19.31 5.91 18.89 6.28L9.0 16.22Z',
    heart_broken: 'M19.55 3.94C17.67 2.67 15.47 2.77 13.78 3.7L12.0 9.0H13.64C14.34 9.0 14.81 9.66 14.62 10.31L12.8 16.36C12.7 16.64 12.28 16.55 12.33 16.27L12.98 9.98H11.34C10.69 9.98 10.17 9.38 10.36 8.72L11.53 4.64C9.7 2.91 6.7 2.3 4.27 4.03C2.81 5.06 2.02 6.7 2.02 8.48C1.97 12.28 5.53 15.19 10.64 19.78C11.44 20.48 12.56 20.48 13.36 19.78C18.33 15.38 22.22 12.23 21.98 8.2C21.89 6.47 21.0 4.92 19.55 3.94Z',
    favorite_border: 'M19.64 3.98C17.02 2.2 13.78 3.05 12.0 5.11C10.22 3.05 6.98 2.2 4.36 3.98C2.95 4.97 2.06 6.56 2.02 8.3C1.88 12.14 5.3 15.28 10.55 20.06L10.64 20.11C11.39 20.81 12.56 20.81 13.36 20.11L13.45 20.02C18.7 15.28 22.12 12.14 21.98 8.25C21.94 6.56 21.05 4.97 19.64 3.98ZM12.09 18.56 12.0 18.66 11.91 18.56C7.12 14.25 3.98 11.39 3.98 8.48C3.98 6.52 5.48 5.02 7.5 5.02C9.05 5.02 10.55 6.0 11.06 7.36H12.94C13.45 6.0 14.95 5.02 16.5 5.02C18.52 5.02 20.02 6.52 20.02 8.48C20.02 11.39 16.88 14.25 12.09 18.56Z',
    // 评分/吐槽按钮（对齐 Kazumi 评分对话框主图标 Icons.edit_note_rounded）
    edit_note: 'M14.016 11.016C14.016 11.531 13.547 12.0 12.984 12.0H3.984C3.469 12.0 3.0 11.531 3.0 11.016C3.0 10.453 3.469 9.984 3.984 9.984H12.984C13.547 9.984 14.016 10.453 14.016 11.016ZM3.0 6.984C3.0 7.547 3.469 8.016 3.984 8.016H12.984C13.547 8.016 14.016 7.547 14.016 6.984C14.016 6.469 13.547 6.0 12.984 6.0H3.984C3.469 6.0 3.0 6.469 3.0 6.984ZM9.984 15.0C9.984 14.438 9.562 14.016 9.0 14.016H3.984C3.469 14.016 3.0 14.438 3.0 15.0C3.0 15.562 3.469 15.984 3.984 15.984H9.0C9.562 15.984 9.984 15.562 9.984 15.0ZM18.0 12.891 18.703 12.141C19.125 11.766 19.734 11.766 20.109 12.141L20.859 12.891C21.234 13.266 21.234 13.875 20.859 14.297L20.109 15.0L18.0 12.891ZM17.297 13.594 12.141 18.75C12.047 18.844 12.0 18.938 12.0 19.078V20.484C12.0 20.766 12.234 21.0 12.516 21.0H13.922C14.062 21.0 14.156 20.953 14.25 20.859L19.406 15.703L17.297 13.594Z',
};
// key 双口径：本地 tag（want/watching/seen/hold/dropped/''）与 Bangumi type
// （1想看 2看过 3在看 4搁置 5抛弃；-1/''=未收藏），单按钮两条同步路径共用
const DETAIL_COL_ICON_KEY = {
    none: 'favorite_border', '': 'favorite_border', '-1': 'favorite_border',
    want: 'star_rounded', 1: 'star_rounded',
    watching: 'favorite', 3: 'favorite',
    seen: 'done', 2: 'done',
    hold: 'pending_actions', 4: 'pending_actions',
    dropped: 'heart_broken', 5: 'heart_broken',
};
const _detailIconSvg = (d, cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
/** 收藏状态图标 HTML（未知 key 回退未收藏空心心形）。 */
function detailColStateIcon(key) {
    return _detailIconSvg(DETAIL_COL_ICON_PATHS[DETAIL_COL_ICON_KEY[key] || 'favorite_border'], 'detail-col-state-svg');
}

/** 集按钮悬浮提示（A-17）：用集名做 title，不再暴露原始播放地址。
 *  集名缺失时按集下标兜底「第 N 集」（1 起，与集数展示习惯一致），
 *  三处 .ep-btn 渲染点（CatVod 弹窗 ×2、分集页签）共用。 */
function epBtnTitle(ep, idx) {
    const name = String((ep && ep.name) || '').trim();
    return escHtml(name || `第 ${idx + 1} 集`);
}
/** 评分/吐槽按钮图标（批注笔，对齐 Kazumi 评分对话框 Icons.edit_note_rounded）。 */
const DETAIL_RATE_ICON_HTML = _detailIconSvg(DETAIL_COL_ICON_PATHS.edit_note, 'detail-rate-svg');

// A-10：封面/角色浮层退场隐藏延迟（ms）：等 .float-out 淡出播完再摘 .show。
// 单一来源：与 src/renderer/css/ui.css 中 floatOut/@keyframes（~2871 行，
// var(--dur-fast)=150ms）同步维护，CSS 侧有互指注释（手法同 LOADING_MASK_DELAY_MS）。
const FLOAT_OUT_MS = 150;

// 详情页延迟转圈（CatVod load）：detailContent 命中后端 mem_cache（30min TTL）
// 或本地 vod 缓存时常 <50ms 返回，立即 showLoading + hideLoading（淡出再固定
// 160ms）反而让用户「看见一下转圈」。延迟 200ms 再上遮罩——快请求完成即取消，
// 慢源照常显示；200ms 与 A-02 骨架先行配合，骨架本身已提供「在加载」反馈。
const DETAIL_LOADING_DELAY_MS = 200;

/** 定时器间接层（A-34 测试可达性）：render 层脚本在 node:vm 沙箱里由单测加载，
 *  沙箱 context 捕获的是**加载那一刻**的宿主 setTimeout 引用，事后 `t.mock.timers`
 *  替换全局也影响不到沙箱内已捕获的引用（实测确认），于是宽限期推不动、测试只能
 *  真等 200ms。改走单一挂点后，单测替换这一个变量即可驱动全部宽限期/延迟遮罩，
 *  生产路径仍是指向宿主 setTimeout 的零开销转发。
 *
 *  生产路径仍是指向宿主 setTimeout 的零开销转发。
 *
 *  声明用 let 是有意的：单测在 node:vm 沙箱里加载本文件后，只有可重新赋值的
 *  绑定才能被替换成 fake timer（const 绑定无法从外部改写）。注释与 CI 用法：
 *  生产代码不得改写这两个变量，注入仅对测试开放。 */
let _detailSetTimeout = (fn, ms) => setTimeout(fn, ms);
let _detailClearTimeout = (h) => clearTimeout(h);

/** 延迟显示详情加载遮罩：返回收尾函数——请求完成时调用；遮罩未触发则只取消
 *  定时器（hideLoading 对不可见遮罩本就是 no-op，调用统一收口避免调用点分支）。 */
function _detailDelayedLoading() {
    const t = _detailSetTimeout(() => showLoading(), DETAIL_LOADING_DELAY_MS);
    // 「取消定时器」与「隐藏遮罩」必须可分开控制：过期世代的收尾若不取消定时器，
    // 那个 200ms 定时器之后仍会 showLoading()，而新请求可能压根没有遮罩可收
    // （如 B 走了快照半渲染路径，endLoading=null）→ 遮罩永久残留。
    // hide=true 时才隐藏遮罩（仅当本请求仍是最新世代）；定时器无论如何都要清。
    return (hide = true) => {
        _detailClearTimeout(t);
        if (hide) hideLoading();
    };
}

/** 首屏宽限期（A-34）：Promise.race 到期的定时器 abstraction。
 *  抽取成函数而非在调用点直接 new Promise，是为了让两处首屏 Race（CatVod
 *  detailContent / Bangumi bangumiInfo）共用同一份「不清定时器即泄漏」的收尾
 *  语义——宽限期比请求先到时（正常分支），resolve 后定时器仍在，不 clear 会让
 *  本应在后台继续跑的请求多挂一个无用定时器到宏任务队列。 */
function _graceTimeout(ms) {
    let t = null;
    const p = new Promise((resolve) => {
        t = _detailSetTimeout(() => resolve(false), ms);
    });
    p.__clear = () => { if (t) _detailClearTimeout(t); };
    return p;
}

/** 刷新按钮 v2：复位刷新钮可视态（摘 spinner + 还原图标 + 摘禁用/aria-busy）。
 *  按钮已静态移到返回按钮右侧（#detail-body 外，整页 render 不重建它），
 *  点击处理与复位共用；el 缺失（理论不可达，健壮兜底）静默跳过。 */
function resetRefreshBtn(el) {
    if (!el) el = document.getElementById('detail-refresh');
    if (!el) return;
    el.disabled = false;
    el.removeAttribute('aria-busy');
    const $el = $(el);
    $el.find('.yuki-tr-spinner').remove();
    $el.find('svg').show();
}

const Detail = {
    site: '',
    vodId: '',
    backView: 'home',
    _backStack: [],   // 详情页内嵌跳转（如关联→新详情页）的回退栈，存上一详情页的恢复快照
    _reloadInProgress: false, // 详情刷新进行中（刷新按钮 v2）：重入 open()/openBangumi() 不压栈
    sources: [],
    activeSource: 0,
    _epDesc: false,
    _bgmEpDesc: false,
    _bgmSelectMode: false,  // Bangumi 分集多选模式（默认关，点「多选」显示勾选框+全选）
    _epSelectMode: false,   // CatVod 分集多选模式
    _commentDesc: true,     // 吐槽排序：false=正序（时间旧→新），true=倒序（时间新→旧，默认）
    _charFilter: 'main',    // 角色筛选：main=主角+配角（默认）/lead/support/minor/all
    _staffFilter: 'all',    // 制作职业筛选：_staffJobCategories 的 key（默认全部）
    _commentLimit: 20,      // 吐槽当前展示条数（下拉加载递增）
    _commentTotal: 0,       // 吐槽真实总数（next.bgm total，与分页无关；0=未知，回退已加载数）
    _charCommentDesc: true, // 角色吐槽排序默认倒序（同番剧吐槽）
    _epComments: [],        // 选集评论（当前选中集；next.bgm /p1/episodes/{id}/comments）
    _epCommentsEpisodeId: 0, // 当前集对应的 Bangumi episode_id（防集号歧义：SP/OP/ED 同号）
    _epCommentsDesc: true,  // 选集评论排序（同吐槽默认倒序；外层「切正/倒序」按钮）
    _epGridDesc: true,      // 选集弹层格网排列方向（独立于评论排序；弹层内小图标）
    _epCommentsLoading: false,
    _epCommentsGen: 0,      // 选集评论加载世代：切换番剧/集数作废在途请求
    _epCommentsPreload: null, // openBangumi 分集预取接续预取的第 1 集评论 {sid, eid, list}：
                              // 页签首开直接命中零等待（切集/切番剧由 sid/eid 校验防串）
    _escBound: false,
    _lastVod: null,
    _vod: null,
    _bgmInfo: null,      // Bangumi 匹配到的信息
    _bgmId: null,         // Bangumi subject ID
    _kazumiOrigin: null,  // Kazumi 搜索来源（{site:'kazumi:规则名', src:结果URL}）：「开始观看」默认回到该源；非 Kazumi 搜索进入为 null
    _activeTab: '概览',
    _descCollapsed: true, // 简介折叠态（默认收起三行；点「展开全部」看全文）
    _tagsExpanded: false, // 概览 Bangumi 标签展开状态（默认只展示前 13 个，点「展开全部」看全部）
    _comments: [],
    _characters: [],
    _staff: [],
    _relations: [],
    _bgmEps: null,      // Bangumi 分集列表（分集/选集讨论页签共用；_renderBgmEpisodes/_ensureBgmEpisodes 写入）
    _bgmEpGen: 0,        // Bangumi 分集加载世代：_renderBgmEpisodes 每次重入自增（切正/倒序重入、换片重建），
                         // 作废在途的旧请求结果——审查2.3：同世代双飞竞态下慢 reject 会覆盖先到的成功网格
    _bgmExtraLoaded: false,
    // A-29：逐路「已加载」标志（角色/制作/关联）。三路不再共用 _bgmExtraLoaded——
    // 该标志在吐槽路（最快，通常 ~1s）到达时即置真，而角色路要并发补全角色中文名
    // （N 个角色 = N 次详情请求，长番剧实测 8~22s）。共用期间切到角色/制作/关联
    // 页签会穿过骨架判定、数组仍是空的 → 渲染成「暂无角色信息/暂无制作人员信息/
    // 暂无关联番剧」，数据随后到达也只在页签内重绘一次（用户看到的就是「数据太多
    // 反而显示暂无」）。逐路标志让每页签等到自己那一路真正 settle（成功或失败）
    // 才出内容，慢路只影响自己，快路照常秒出。
    _bgmExtraRouteLoaded: { comments: false, characters: false, staff: false, relations: false },
    _bgmExtraFailed: { comments: false, characters: false, staff: false, relations: false }, // A-03：各路子请求失败态（true=该路网络失败，非「无数据」）
    /** A-29：某路是否已 settle（成功返回或已判失败）——页签据此决定骨架/内容/错误态。
     *  新开详情或换片时三路标志复位（见下方复位点），与 _bgmExtraFailed 同生命周期。 */
    _bgmRouteSettled(route) {
        return !!(this._bgmExtraRouteLoaded && this._bgmExtraRouteLoaded[route]);
    },
    _bgmExtraGen: 0,     // Bangumi 补充数据加载世代：每次导航/重载自增，作废在途的旧 subject 异步结果
    _loadGen: 0,         // 详情主请求世代（P2-4）：load()/openBangumi() 共用同一详情页状态，
                         // 每次入口自增；await 返回后不一致即丢弃，防 A→B 乱序写出混合收藏条目
    _snapHeroBgm: false, // A-01（Bangumi 路径）：openBangumi 快照半渲染进行中（openBangumi 置位、
                         // render({snapHeroBgm}) 内消费即复位、finally 前兜底复位）
    // A-28 收藏态双查降频：上次 force 收藏对账时间戳 + 写操作脏标记（模块级共享状态，
    // 语义见顶部 A_28_COL_RECONCILE_TTL 注释；挂在 Detail 上便于测试注入/读取）
    _colReconcileTs: 0,
    _colReconcileDirty: false,

    init() {
        if (this._escBound) return;
        this._escBound = true;
        // 订阅收藏变更（Kazumi CollectButton 模式：状态变更后自动刷新按钮高亮）
        if (typeof FavHub !== 'undefined' && FavHub.onChanged) {
            this._unsubFav = FavHub.onChanged(() => {
                // A-28：任何收藏写操作（recSet('favorites') → FavHub.changed）都置脏，
                // 下次打开详情页立即 force 对账（绕过 5min 窗口），保证写后立即一致
                this._colReconcileDirty = true;
                if (typeof App === 'undefined' || App.currentView !== 'detail') return;
                this._refreshLocalCol();
                // 播放逐集记账（Favorites.updateProgress → recSet）也会走到这里：
                // 详情页开着时本地观看进度行随之实时刷新
                this._refreshLocalProgress();
                // 同步刷新 Bangumi 收藏按钮高亮（如有匹配）
                if (this._bgmId && typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                    Kazumi._applyBangumiColState(this._bgmId);
                }
            });
        }
        $('#detail-back').on('click', () => this.back());
        // 刷新按钮 v2：图标钮移到返回按钮右侧（index.html 静态节点，在 #detail-body
        // 之外——原挂在 #detail-body 委托链收不到事件，改与 #detail-back 同款直绑）。
        // 防抖保留：刷新期间 disabled + aria-busy + yuki-tr-spinner 环（A-21 手法），
        // disabled 期间连点无效。按钮不再被整页 render 重建（已移出 #detail-body），
        // spinner/禁用态需异步复位：_refreshDetail 透传重入 load(true)/openBangumi()
        // 的 promise，其 resolve 即请求收尾（含 loading 提示隐藏与整页渲染），届时复位。
        $('#detail-refresh').on('click', () => {
            const el = document.getElementById('detail-refresh');
            if (!el || el.disabled) return;
            const $btn = $(el);
            el.disabled = true;
            el.setAttribute('aria-busy', 'true');
            $btn.prepend('<span class="yuki-tr-spinner" aria-hidden="true"></span>');
            $btn.find('svg').hide(); // 小图标钮让位：spinner 顶替图标位，复位时还原
            let p;
            try {
                p = this._refreshDetail();
            } catch (err) {
                resetRefreshBtn(el); // 同步异常兜底复位，防按钮永久卡在禁用态
                return;
            }
            Promise.resolve(p).catch(() => {}).then(() => resetRefreshBtn(el));
        });
        $('#detail-body')
            .on('click', '.play-src', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this.selectSource(idx);
            })
            .on('click', '.ep-btn', (e) => {
                const el = $(e.currentTarget);
                const idx = parseInt(el.data('idx'), 10);
                this._playEpisode(idx);
            })
            .on('click', '.detail-cover img', (e) => {
                // A-30：沿用快照封面时 hero 显示的是列表卡那张（多为 400px 变体），
                // 放大必须升到 large 变体——否则点开放大得到的是降采样小图。
                // data-big 由 render() 在沿用分支写入，非沿用分支无该属性（src 本身
                // 已是 large/代理链），与评论头像的 data-big 同口径。
                const el = e.currentTarget;
                const big = (el && el.getAttribute && el.getAttribute('data-big')) || '';
                this._openCoverFloat(big || $(el).attr('src'));
            })
            // 吐槽/选集讨论评论图点击放大（头像 + BBCode [img] 内嵌图统一委托；
            // #detail-tab-content 在 #detail-body 内，委托链覆盖全部评论页签）。
            // stopPropagation：防冒泡到 kazumi.js 的 #detail-body img 泛化放大
            // （src 取大图口径，与泛化分支的 src 直取不同，需先到先得）
            .on('click', '.detail-comment-avatar, .detail-comment-inline-img', (e) => {
                e.stopPropagation();
                const el = e.currentTarget;
                const src = el.getAttribute('data-big') || el.getAttribute('src');
                if (src) this._openCoverFloat(src);
            })
            .on('click', '.ep-check', (e) => {
                e.stopPropagation();
                $(e.currentTarget).toggleClass('checked');
                this._syncDlBar();
            })
            .on('click', '.ep-dl-one', (e) => {
                e.stopPropagation();
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this._downloadEps(this.sources[this.activeSource], [idx]);
            })
            .on('change', '#ep-check-all', (e) => {
                $('#ep-list .ep-check').toggleClass('checked', e.currentTarget.checked);
                this._syncDlBar();
            })
            .on('click', '#ep-dl-selected', () => this.downloadSelected())
            .on('click', '#ep-order', () => this.toggleEpOrder())
            .on('click', '#ep-play-selected', () => this.playSelected())
            .on('click', '.detail-col-btn', (e) => {
                const tag = String($(e.currentTarget).data('tag') || '');
                this.setLocalCollection(tag);
                // 单按钮下拉模式：选中后收起六态列表（与 Bangumi 收藏菜单交互一致）
                $(e.currentTarget).closest('.detail-local-col-menu').hide();
            })
            // 标签切换
            .on('click', '.detail-tab', (e) => {
                const tab = String($(e.currentTarget).data('tab') || '');
                if (tab) this._switchTab(tab);
            })
            // 简介收起/展开（A-12）：纯展示切换，只 toggle .collapsed class + 按钮文案
            // 局部更新，不再走 _renderOverview() 全量重建——重建整个概览会闪屏，
            // 且 #detail-tab-content 整体换内容导致滚动位置跳变（展开/收起视口漂移）。
            .on('click', '#detail-desc-toggle', (e) => {
                e.stopPropagation();
                this._descCollapsed = !this._descCollapsed;
                // 口径与 _renderOverview 一致：按钮仅在简介超三行时渲染，存在即可 toggle；
                // class/state 双参形式与 :157 ep-check 用法一致。
                $(e.currentTarget).closest('.detail-desc-wrap')
                    .find('.detail-desc').toggleClass('collapsed', this._descCollapsed);
                $(e.currentTarget).text(this._descCollapsed ? '展开全部' : '收起');
            })
            // Bangumi 标签展开全部/收起（仅切换展示数量，不动标签点击筛选）
            .on('click', '#detail-tags-toggle', (e) => {
                e.stopPropagation();
                this._tagsExpanded = !this._tagsExpanded;
                this._renderOverview();
            })
            // Kazumi 源弹窗
            .on('click', '#detail-kazumi-src', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', this.site, this.vodId);
                }
            })
            // Bangumi 收藏同步（统一详情页 T74）：六态列表内的状态按钮
            .on('click', '.kazumi-col-btn', async (e) => {
                const btn = $(e.currentTarget);
                // 单按钮模式：点击「当前状态」按钮 = 展开六态列表
                if (btn.attr('id') === 'detail-col-current') {
                    const menu = btn.closest('.detail-col-wrap').find('.detail-col-menu');
                    const show = !menu.is(':visible');
                    $('.detail-col-menu').not(menu).hide();
                    menu.toggle(show);
                    e.stopPropagation();
                    return;
                }
                // 本地收藏单按钮（CatVod 源，Bangumi 同款交互）：展开六态列表
                if (btn.attr('id') === 'detail-local-col-current') {
                    const menu = btn.closest('.detail-local-col-wrap').find('.detail-local-col-menu');
                    const show = !menu.is(':visible');
                    $('.detail-col-menu').not(menu).hide();
                    menu.toggle(show);
                    e.stopPropagation();
                    return;
                }
                const id = String(btn.closest('.kazumi-col-btns').data('id') || '');
                const val = parseInt(btn.data('type'), 10);
                const nm = this.vodName || '';
                if (!id || typeof Kazumi === 'undefined') return;
                // 选中后收起弹出列表
                btn.closest('.detail-col-menu').hide();
                if (val < 0) {
                    if (await Kazumi.removeBangumiCollection(id, nm)) Kazumi._applyBangumiColState(id);
                    // 同步移除本地收藏（时间表筛选依赖 bangumiId）
                    if (typeof Records !== 'undefined' && this._bgmId) {
                        const fav = await Records.isFavorite('bangumi', id);
                        if (fav) await Records.toggleFavorite({ site: 'bangumi', vodId: id, name: nm, bangumiId: id, bangumi: true });
                    }
                } else if (await Kazumi.setBangumiCollection(id, val)) {
                    Kazumi._applyBangumiColState(id);
                    // 同步写入本地收藏（时间表筛选依赖 favorites 中的 bangumiId）
                    if (typeof Records !== 'undefined') {
                        const tagMap = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
                        const tag = tagMap[val] || 'want';
                        const pic = (this._bgmInfo && this._bgmInfo.images && bangumiCover(this._bgmInfo.images, 'card')) || '';
                        await Records.setFavTag({ site: 'bangumi', vodId: id, name: nm, pic, siteName: 'Bangumi', bangumiId: id, bangumi: true }, tag);
                    }
                }
                // 收藏变更由 Favorites.changed（recSet 内触发）统一广播：
                // 详情页收藏按钮、我的收藏页、时间表过滤集合据此自动刷新。
            })
            // 收藏状态弹出列表：点其他区域收起（含本地收藏菜单，同一容器 class 口径）
            .on('click', (e) => {
                if (!$(e.target).closest('.detail-col-wrap').length) $('.detail-col-menu').hide();
                // 选集讨论长列表弹层：点弹层外收起（弹层自身点击由 stopPropagation 拦下）
                if (!$(e.target).closest('.ep-comments-picker').length) $('.ep-comments-grid').hide();
            })
            // 跳源站网页（CatVod 详情，与「↗ Bangumi 页」同位）：URL 由 _siteWebUrl
            // 从站点 api 推导（scheme://host/），非 http(s) 不渲染按钮，此处双重校验
            .on('click', '#detail-catvod-web', () => {
                const u = this._siteWebUrl();
                if (!/^https?:\/\//i.test(u)) { warnToast('该源未配置网页地址'); return; }
                window.open(u, '_blank'); // 主进程转系统浏览器
            })
            // 开始观看（Kazumi 源，Bangumi-only 详情）：经 Kazumi 搜索进入时
            // （_kazumiOrigin）默认直达该源解析剧集；其余进入路径打开全源选源弹窗
            .on('click', '#detail-kazumi-start', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    const origin = this._kazumiOrigin;
                    Kazumi.openSourceDialog(this.vodName || '', origin ? origin.site : 'kazumi', origin ? origin.src : '');
                }
            })
            // 评分/吐槽/标签（T80）：hero 操作行按钮 → BgmRate 对话框（打分+吐槽+标签合并提交）。
            // 点击转圈等待 fetchCurrent 补查当前评分/吐槽/标签，正常返回后带预填开窗；
            // 超过 RATE_FETCH_TIMEOUT_MS（弱网/接口挂起）不再苦等——先无预填开窗，
            // 晚到的补查结果经 BgmRate.mergeFetched 合并进已开的对话框（用户已编辑/
            // 已切番剧则丢弃）。防连点：转圈期间按钮禁用（首个 await 前同步置位，无
            // 竞态窗口），二次点击直接忽略；成功/超时/失败三路径 finally 复位按钮并
            // 摘 spinner。spinner 复用 translate-bubble 的既有环（transform-only 动画
            // + 令牌色，符合 DESIGN.md 动效契约，零新增 CSS）。
            // 热门标签建议取条目公共标签 _bgmInfo.tags（[{name,count}] → name 数组）。
            // 提交成功后 BgmRate 内部广播 FavHub.changed + 通知本页乐观刷新吐槽列表。
            .on('click', '#detail-bgm-rate', async (e) => {
                if (typeof BgmRate === 'undefined') { warnToast('评分组件未加载'); return; }
                const sid = String(this._bgmId || '');
                if (!sid) { warnToast('缺少 Bangumi 条目 ID'); return; }
                const $btn = $(e.currentTarget);
                if ($btn.prop('disabled')) return;
                $btn.prop('disabled', true).attr('aria-busy', 'true')
                    .prepend('<span class="yuki-tr-spinner" aria-hidden="true"></span>');
                // 一次补查两处消费：race 竞速开窗 + 超时后的晚到合并（不重发请求）。
                // fetchCurrent 内部吞网络错误，catch 兜 _getBangumiToken 抛错等路径。
                const fetching = BgmRate.fetchCurrent(sid, null);
                let cur = null;
                try {
                    cur = await Promise.race([
                        fetching,
                        new Promise((resolve) => setTimeout(() => resolve(null), RATE_FETCH_TIMEOUT_MS)),
                    ]);
                } catch (err) { /* 失败按无预填处理 */ }
                finally {
                    $btn.prop('disabled', false).removeAttr('aria-busy')
                        .find('.yuki-tr-spinner').remove();
                }
                BgmRate.openRateDialog({
                    subjectId: sid,
                    name: this.vodName || '',
                    rate: cur ? cur.rate : null,
                    comment: cur ? cur.comment : '',
                    tags: cur ? cur.tags : undefined,
                    popularTags: (this._bgmInfo && Array.isArray(this._bgmInfo.tags))
                        ? this._bgmInfo.tags.map((t) => (t && typeof t === 'object') ? t.name : t) : [],
                });
                // 超时开窗：同一次在途补查晚到后合并（未编辑且条目未切走才生效）。
                // 必须带上本次会话号——同一条目关掉重开后，第一次的迟到响应否则会
                // 覆盖第二次会话里用户刚填的内容（只按 subjectId 判归属会串台）。
                if (!cur) {
                    const fetchId = BgmRate._lastFetchId;
                    fetching.then((late) => { BgmRate.mergeFetched(sid, late, fetchId); }).catch(() => {});
                }
            })
            // 一键跳转 Bangumi 条目页（系统浏览器）。URL 拼自 _bgmId（数字字符白名单校验，
            // 防注入）：openBangumi 详情必然有 _bgmId；CatVod 详情匹配到 Bangumi 时才有按钮。
            // 目标域由 bangumiWebUrl 决定——「条目页跳转跟随镜像」开启时走镜像站，否则官方 bgm.tv。
            .on('click', '#detail-bgm-open', () => {
                const sid = String(this._bgmId || '');
                if (!sid || !/^\d+$/.test(sid)) { warnToast('缺少 Bangumi 条目 ID'); return; }
                window.open(bangumiWebUrl(sid), '_blank'); // 主进程转系统浏览器
            })
            // 开始播放（CatVod 源详情头部，与「开始观看」同位置）：打开线路+集数弹窗（T79）
            .on('click', '#detail-catvod-start', () => {
                this._catvodStartPlay();
            })
            // 标签点击：按 Bangumi 标签精确筛选番剧（非关键词搜索，任务四 4.2）
            .on('click', '.kazumi-tag', (e) => {
                const tag = String($(e.currentTarget).data('tag') || '');
                if (!tag) return;
                if (typeof Kazumi !== 'undefined' && Kazumi.openBangumiTagResult) {
                    Kazumi.openBangumiTagResult(tag);
                }
            })
            // A-22 键盘可达性：Enter/Space 激活与 click 同一逻辑。委托统一挂在
            // #detail-body 现有委托链上（而非 _render* 内的 per-render 绑定）——
            // 重渲染不丢绑定，也不触碰各渲染函数中他人并发编辑的区域。
            // 逻辑与对应 click 处理器同口径复刻（原 handler 为匿名箭头函数，
            // 无法直接复用）；Space 的 e.preventDefault 防滚动页面。
            // Esc 不经过这里：app.js 全局 keydown 仅转发 Escape 给 common.js
            // dispatchEsc（按视图派发，焦点元素不拦截），两者互不影响。
            .on('keydown', '.detail-tab', (e) => {
                if (!this._kbdActivate(e)) return;
                const tab = String($(e.currentTarget).data('tab') || '');
                if (tab) this._switchTab(tab);
            })
            .on('keydown', '.kazumi-tag', (e) => {
                if (!this._kbdActivate(e)) return;
                const tag = String($(e.currentTarget).data('tag') || '');
                if (!tag) return;
                if (typeof Kazumi !== 'undefined' && Kazumi.openBangumiTagResult) {
                    Kazumi.openBangumiTagResult(tag);
                }
            })
            .on('keydown', '[data-char-filter]', (e) => {
                if (!this._kbdActivate(e)) return;
                this._charFilter = String($(e.currentTarget).data('char-filter') || 'main');
                this._renderCharacters();
            })
            .on('keydown', '[data-staff-filter]', (e) => {
                if (!this._kbdActivate(e)) return;
                this._staffFilter = String($(e.currentTarget).data('staff-filter') || 'all');
                this._renderStaff();
            })
            .on('keydown', '.bgm-ep-item', (e) => {
                if (!this._kbdActivate(e)) return;
                // 键盘焦点只能落在 .bgm-ep-item 本体（.ep-check 无 tabindex 不可聚焦），
                // 无需 click 路径的 ep-check 冒泡守卫
                const title = this.vodName || '';
                if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(title, 'kazumi', '');
                }
            })
            .on('keydown', '.detail-char-card', (e) => {
                if (!this._kbdActivate(e)) return;
                const cid = String($(e.currentTarget).data('char-id') || '');
                if (cid) this._openCharacterDetail(cid);
            })
            .on('keydown', '.detail-relation[data-rel-id]', (e) => {
                if (!this._kbdActivate(e)) return;
                const id = String($(e.currentTarget).data('rel-id') || '');
                if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) Kazumi.openBangumiInfoPage(id);
            });
        registerEsc(() => {
            if (App.currentView === 'detail') { this.back(); return true; }
            return false;
        });
        // CatVod 选源选集弹窗（T79）：委托挂在弹窗自身容器上——弹窗是 body 直属节点，
        // 不在 #detail-body 内部，挂在 #detail-body 的委托永远匹配不到（「点开弹窗
        // 无法操作」的根因）。点线路只切弹窗内展示；点集起播并关窗（多选/下载仍留
        // 在「分集」页签）。
        $('#catvod-play-dialog-body')
            .on('click', '.catvod-play-src', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this._catvodDialogSelectSource(idx);
            })
            .on('click', '.catvod-ep-btn', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                closeDialog('catvodPlayDialog');
                this._playEpisode(idx);
            });
        // 页签栏吸顶位：尽量靠上。标准模式贴窗口顶（0）；无边框模式顶部 32px
        // 是窗口拖拽带（-webkit-app-region:drag 吞点击且层级更高），吸顶位压在
        // 其下 1px 处（33）。写入 CSS 变量供 .detail-tabs 的 sticky top 消费，
        // _stickTop() 与其保持同一数值来源。
        const stickTop = document.body.classList.contains('frameless') ? 33 : 0;
        document.documentElement.style.setProperty('--tabs-stick-top', stickTop + 'px');
        // 页签栏吸顶状态检测：功能栏滚到吸顶位后加 tabs-stuck，CSS 据此展开
        // 向上遮罩——滚动内容不再从功能栏上方穿过（需求：吸顶后上方不显示
        // 任何内容）。passive 监听每帧仅一次布局读取。
        const viewEl = document.getElementById('view-detail');
        if (viewEl && !this._stuckBound) {
            this._stuckBound = true;
            viewEl.addEventListener('scroll', () => {
                const bar = viewEl.querySelector('.detail-tabs');
                if (!bar) return;
                bar.classList.toggle('tabs-stuck', bar.getBoundingClientRect().top <= this._stickTop() + 1);
            }, { passive: true });
        }
    },

    /** 功能栏吸顶位（视口内 y）：标准模式贴窗口顶（0）；无边框模式顶部 32px
     *  拖拽带吞点击，压在其下 1px（33）。与 init 写入的 --tabs-stick-top 一致。 */
    _stickTop() {
        return document.body.classList.contains('frameless') ? 33 : 0;
    },

    open(site, vodId, fallbackName) {
        if (!site || !vodId) { warnToast('缺少站点或视频 ID'); return; }
        abortCoverFill();
        // 嵌套跳转（已在详情页时再打开新详情）：压栈当前快照，返回时恢复，而非跳回根视图。
        // 返回栈修复：刷新路径的重入（_refreshDetail → open/load）是本页原地更新，
        // 不是嵌套跳转——压栈会把当前页快照叠进栈里，之后一次 back() 恢复的仍是
        // 同一部影片的旧快照，用户回不到上级视图。_reloadInProgress 期间跳过压栈。
        if (App.currentView === 'detail' && !this._reloadInProgress) {
            this._backStack.push(this._snapshot());
        } else if (!this._reloadInProgress) {
            this._backStack = [];
            this.backView = App.currentView;
        }
        this.site = site;
        this.vodId = vodId;
        this.vodName = fallbackName || '';
        this._kazumiOrigin = null; // CatVod 详情无 Kazumi 搜索来源概念（防上次 Bangumi 详情残留）
        this.sources = [];   // 换片复位线路：残留 sources 会在快照半渲染时串台
                             // （hero「播放信息」显示上一部影片的线路数）
        this.activeSource = 0;
        this._vod = null;
        this._lastVod = null;
        this._bgmInfo = null;
        this._bgmId = null;
        // A-29：逐路标志同步复位（换片 → 三页签回到骨架，不再沿用上一部番剧的 settle 态）
        this._bgmExtraRouteLoaded = { comments: false, characters: false, staff: false, relations: false };
        this._bgmExtraFailed = { comments: false, characters: false, staff: false, relations: false }; // A-03：换片复位失败态
        this._activeTab = '概览';
        // 多选状态不跨页面残留（T79）：单例标志此前退出详情后仍保留，重进任意
        // 详情页直接回到多选态；每次打开重置为普通模式
        this._bgmSelectMode = false;
        this._epSelectMode = false;
        // A-01 第二阶段（快照先渲染）：详情 vod 缓存未命中时读列表快照，命中则
        // 立即用快照渲染 hero（封面+标题+meta 的半渲染态，无 sources/无线路区），
        // detailContent 返回后由 load() 以详情结果为权威数据整页覆盖（结果优先，
        // 快照仅四展示字段垫场）。快照读取失败静默——纯优化不影响主流程。
        // 命中详情 vod 缓存（load() 免网络）时跳过半渲染：马上出完整版面，无需垫场。
        this._snapHeroShown = false;
        this._detailDataPending = false; // A-35：详情结果是否在途（占位播放按钮的点击反馈口径）
        this._snapCoverShown = ''; // 快照封面沿用基准重置（CatVod 路径不消费，防跨类型残留）
        // 「同步直出」判定（M-syncrender）：详情 vod 缓存命中（非过期）时 load()
        // 免网络，把缓存值直接递给 load()，让它在本调用栈内完成状态写入与
        // render——open() → load() 之间没有 await/宏任务边界，骨架与延迟转圈两
        // 条占位路径根本不会执行，点开卡片的同一帧即见完整详情（旧实现 load 先
        // 写骨架、再 await 设置恢复线路，缓存命中也要闪一帧骨架再出内容）。
        // 只认非过期条目：SWR 陈旧垫场仍走原异步路径（语义是「先垫场后校准」，
        // 且校准覆盖渲染需要 skipPageAnim 口径，同步直出会破坏该时序）。
        let syncVod = null;
        try {
            const peeked = (typeof localCachePeek === 'function')
                ? localCachePeek(DETAIL_VOD_CACHE_PREFIX + String(site) + '|' + String(vodId)) : null;
            if (peeked && peeked.value && !peeked.expired) syncVod = peeked.value;
        } catch (e) { syncVod = null; }
        if (typeof DetailSnap !== 'undefined' && DetailSnap.get) {
            try {
                const snap = DetailSnap.get(String(site), String(vodId));
                const snapVod = _detailSnapVod(snap);
                const hasCached = !!syncVod;
                if (snapVod && !hasCached) {
                    this._snapHeroVod = snapVod; // 半渲染态 vod（load() 到达后清掉）
                    this._snapHeroShown = true;  // 供 load() 跳过文本占位 + 新测试断言
                    this._detailDataPending = true; // A-35：占位播放按钮期间点击给「稍候」提示
                    this.vodName = this.vodName || snapVod.vod_name || '';
                    App.showView('detail'); // 视图可能尚未切换，确保 hero 可见
                    this.render({ snapHero: true });
                }
            } catch (e) { this._snapHeroShown = false; this._detailDataPending = false; }
        }
        this._snapHeroVod = null; // 半渲染已上屏/未命中都清引用：唯一数据源回到 load()
        App._detailOpening = true; // 标记「新开详情」：app.js 据此把详情记忆归属到来源分支（恢复展示不写）
        App.showView('detail');
        this.load(null, syncVod);
    },

    /** 打开 Bangumi-only 详情（时间表/推荐/收藏/Bangumi 搜索进入，T74 统一详情页）。
     *  无 CatVod 源；以「开始观看」（Kazumi 规则源）为主播放入口。
     *  kazumiOrigin：Kazumi 搜索结果进入时携带的默认源（{site, src}），
     *  「开始观看」优先直达该源解析剧集，免重新全源检索。 */
    async openBangumi(subjectId, fallbackName, kazumiOrigin) {
        if (!subjectId) { warnToast('缺少 Bangumi ID'); return; }
        if (typeof Kazumi === 'undefined') { warnToast('Kazumi 引擎不可用'); return; }
        abortCoverFill();
        // 嵌套跳转：已在详情页（如从关联页点番剧）时压栈快照，返回恢复上一详情页而非根视图。
        // 返回栈修复：刷新（_refreshDetail）重入 openBangumi 时不再压栈——见 open() 同注释。
        if (App.currentView === 'detail' && !this._reloadInProgress) {
            this._backStack.push(this._snapshot());
        } else if (!this._reloadInProgress) {
            this._backStack = [];
            this.backView = App.currentView;
        }
        this.site = '';
        this.vodId = String(subjectId);
        this.vodName = fallbackName || '';
        this._kazumiOrigin = (kazumiOrigin && String(kazumiOrigin.site || '').startsWith('kazumi:') && kazumiOrigin.src)
            ? { site: String(kazumiOrigin.site), src: String(kazumiOrigin.src) } : null;
        // 清掉上一次 CatVod 详情残留的 vod（T4）：否则 toggleFav 会写出 site:'' 的错误收藏，
        // 且 _lastVod 残留会串入上一部影片的封面/源名。
        this._vod = null;
        this._lastVod = null;
        this._bgmInfo = null;
        this._bgmId = String(subjectId);
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._resetEpComments();
        this._bgmExtraLoaded = false;
        // A-29：逐路标志同步复位（openBangumi 换片）
        this._bgmExtraRouteLoaded = { comments: false, characters: false, staff: false, relations: false };
        this._bgmExtraFailed = { comments: false, characters: false, staff: false, relations: false }; // A-03：换片复位失败态
        this._activeTab = '概览';
        // 多选状态不跨页面残留（同 open()）
        this._bgmSelectMode = false;
        this._epSelectMode = false;
        App._detailOpening = true; // 标记「新开详情」：app.js 据此把详情记忆归属到来源分支（恢复展示不写）
        App.showView('detail');
        // P2-4：与 load() 共用同一世代变量（两者写同一份详情页状态），
        // 快速连续打开 CatVod 详情 ↔ Bangumi 详情时旧响应同样作废
        const gen = ++this._loadGen;
        // A-01（Bangumi 路径）：bgmInfo 缓存未命中时读列表快照，立即用快照渲染
        // hasBgm 版面 hero（封面=列表卡正在显示的 URL，bangumiCoverImg 缺省 card 口径
        // 逐字不变 → 浏览器缓存零网络秒出；标题/页签照常）。bangumiInfo 返回后整页
        // 覆盖（结果优先）。缓存命中（millisecond 级返回出完整版面）时跳过半渲染，
        // 与 CatVod 路径（open() 读详情 vod 缓存命中即跳快照）同一口径。快照读取
        // 失败静默——纯优化不影响主流程。半渲染态不上延迟转圈（与 load() 快照路径
        // 同理：hero+骨架已是加载反馈，再叠居中转圈是纯干扰）。
        let snapBgmShown = false;
        let infoCacheHit = false;
        // 快照封面沿用基准重置：必须在读快照/半渲染 render 之前（半渲染 render 内
        // 会记下本片封面 URL 供完整 render 比对；放在 render 之后会把刚记的又清掉）
        this._snapCoverShown = '';
        try {
            infoCacheHit = !!(typeof Kazumi.peekCachedBangumiInfo === 'function'
                && Kazumi.peekCachedBangumiInfo(subjectId));
        } catch (e) { infoCacheHit = false; }
        if (!infoCacheHit && typeof DetailSnap !== 'undefined' && DetailSnap.get) {
            try {
                const snapBgm = _detailSnapBgm(DetailSnap.get('', String(subjectId)), subjectId);
                if (snapBgm) {
                    this._bgmInfo = snapBgm; // 半渲染态 bgm（bangumiInfo 到达后覆盖）
                    this._snapHeroBgm = true; // render() 走半渲染口径（副作用延后）
                    this.render({ snapHeroBgm: true });
                    snapBgmShown = true;
                }
            } catch (e) { /* 快照是优化，失败静默 */ }
        }
        this._snapHeroBgm = false;
        // A-34 首屏宽限期（Bangumi，与 CatVod load() 同口径同阈值）：
        // bangumiInfo 命中 30min localStorage 缓存时毫秒级返回，快到不该显示任何中间
        // 态——此时本函数尚未向页面写过东西，第一次绘制就是完整版面（封面+标题+评分+
        // meta 同时到位）；超过宽限期才落到渐进路径（写 hero 骨架，数据迟到后整页覆盖）。
        // 顺序依赖：请求必须先发出、且与宽限期赛跑**之后**才决定要不要写占位——占位
        // 写在 race 之前的话，快速与慢速两条路径都会先闪一屏骨架，宽限期就白设了。
        // 延迟转圈同理顺延到 race 之后（<200ms 返回的请求连转圈都不该看见）。
        // race 的是同一个 promise，剩余等待继续后台跑，绝不重发第二次请求。
        const reqP = Kazumi.bangumiInfo(subjectId); // 30 分钟缓存
        const graceP = _graceTimeout(DETAIL_LOADING_DELAY_MS);
        // L42：__clear 放 finally——await race 抛出时定时器也能被清掉
        let withinGrace;
        try {
            withinGrace = await Promise.race([reqP.then(() => true), graceP]);
        } finally {
            graceP.__clear(); // 无论胜负都清定时器，别留到宏任务队列
        }
        let endLoading = null;
        if (!withinGrace) {
            // 慢请求才补延迟遮罩与 hero 骨架；快照半渲染态不上遮罩（见下）
            endLoading = snapBgmShown ? null : _detailDelayedLoading();
            if (!snapBgmShown) $('#detail-body').html(_detailSkeleton('hero', null, '正在载入详情…')); // A-02：详情主体 hero 骨架
        }
        try {
            this._bgmInfo = await reqP; // 同一个 promise：数据在此真正到位（已在途则立刻兑现）
            if (gen !== this._loadGen) return; // 已切到别的详情，旧响应丢弃
            if (!this._bgmInfo) { warnToast('Bangumi 详情载入失败'); if (endLoading) endLoading(); this.back(); return; }
            if (!this.vodName) this.vodName = this._bgmInfo.name_cn || this._bgmInfo.name || '';
            this.sources = []; // 无 CatVod 线路
            // 原位覆盖不重播入场动画：快照半渲染 hero 刚播完 detail-page-anim 三级
            // 上浮（封面/标题已稳定在位），完整 render 是对**正在显示的版面**的数据
            // 覆盖——再挂 .detail-page-anim 会把整个 hero 从 opacity:0 重新淡入上浮，
            // 封面/评分/操作行集体闪一下（URL 沿用只解决图片重载，解决不了动画重播）。
            // skipPageAnim（A-26 同参）：新内容原位就位，仅页签内容保留 .tab-enter 淡入。
            // 无快照路径（骨架/无半渲染）维持原状播完整入场——骨架到内容是形态切换，
            // 入场动画正是该场景的过渡反馈。
            this.render(snapBgmShown ? { skipPageAnim: true } : undefined);
            // 分集预取（后台，不阻塞渲染）：「分集/选集讨论」页签首开常驻骨架
            // 等一次 bangumiEpisodes 往返。预取结果写 _bgmEps 并落 30min
            // localStorage 缓存（kazumi.js bangumiEpisodes 自带缓存写），用户随后
            // 切页签直接命中零等待。世代守卫：预取返回时已换番剧则丢弃。
            // 选集讨论提速（二段）：分集列表到手后**就地接续预取第一集（正片）评论**
            // ——页签打开的真实等待是「分集列表 → 评论」两段串行网络（next.bgm 往返
            // 各 ~0.5-2s），只预取列表时首开评论仍要白等第二段。第 1 集是页签默认
            // 选中集（_renderEpComments 的 cur 回退口径），结果写 _epCommentsPreload，
            // 页签打开直接命中零骨架。用户先切了别的集也无碍：预取仅按 sid+第1集
            // 缓存，pickEp 的正常请求不受影响（_loadEpComments 世代守卫照旧）。
            const epGen = this._bgmExtraGen;
            Kazumi.bangumiEpisodes(subjectId).then((epsData) => {
                if (gen !== this._loadGen || epGen !== this._bgmExtraGen) return; // 已换番剧
                const list = ((epsData && epsData.data) || []).slice();
                if (list.length && !Array.isArray(this._bgmEps)) this._bgmEps = list;
                // 接续预取第 1 集评论（失败静默：页签打开时正常请求路径兜底）
                const first = list.find((ep) => ep && Number(ep.type) === 0) || list[0];
                if (first && first.id) {
                    const eid = Number(first.id);
                    Kazumi.bangumiEpisodeComments(eid).then((cmt) => {
                        if (gen !== this._loadGen || epGen !== this._bgmExtraGen) return; // 已换番剧
                        this._epCommentsPreload = { sid: String(subjectId), eid, list: Array.isArray(cmt) ? cmt : [] };
                    }).catch(() => { /* 预取失败静默 */ });
                }
            }).catch(() => { /* 预取失败静默：页签打开时自会重试 */ });
        } catch (e) {
            if (gen !== this._loadGen) return; // 已切到别的详情，旧错误不覆盖新页面
            warnToast('Bangumi 详情载入失败');
            this.back();
        } finally {
            // 新请求的 loading 不被旧请求收尾；快照半渲染态未上遮罩（endLoading=null），
            // 半渲染 hero 已被完整版面（或失败 back 路径）覆盖，无需单独收尾
            if (endLoading && gen === this._loadGen) endLoading();
        }
    },

    /** 保存当前详情页关键状态，用于嵌套跳转的回退恢复（关联→新详情→返回原详情）。 */
    _snapshot() {
        return {
            site: this.site, vodId: this.vodId, vodName: this.vodName,
            _vod: this._vod, _bgmId: this._bgmId, _bgmInfo: this._bgmInfo,
            _kazumiOrigin: this._kazumiOrigin,
            _activeTab: this._activeTab, sources: this.sources, activeSource: this.activeSource,
            // A-25：嵌套返回全程停留在 #view-detail 内（视图不切换），App._scrollPos
            // 不介入（app.js 对 detail 还固定回顶），滚动位置只能靠快照自持
            scrollTop: (() => {
                const el = document.getElementById('view-detail');
                return el ? el.scrollTop : 0;
            })(),
        };
    },

    /** 从快照恢复详情页：无需重拉，直接重渲染。返回 false 表示栈为空。 */
    async _restore(snapshot) {
        if (!snapshot) return false;
        Object.assign(this, snapshot);
        // A-30：恢复的详情可能是「CatVod 版面 + 后补匹配在途」的中间态——嵌套跳转
        // （关联→新详情）会把后补流程作废（新详情 _loadGen 自增），返回恢复后若不
        // 重新发起，恢复页将永远停留在 CatVod 版面（开关开启时语义回归）。重发一次：
        // 快照已有 _bgmId（匹配已完成）走原路径；CatVod 快照（无 _bgmId）且开关开启
        // 才重新后补，与首次 load 的产出等价。
        this._bgmDefer = undefined;
        // 嵌套返回自增主请求世代：嵌套打开番剧（关联→新详情）期间旧详情的主请求
        // 仍在途，返回恢复后若不自增，慢响应会带着过期世代比对通过，把旧影片的
        // _vod/sources 覆盖到刚恢复的页面上（与 load()/openBangumi() 同一守卫口径）
        this._loadGen++;
        this._bgmExtraGen++; // 作废在途的上一部番剧补充数据加载，防返回后旧结果叠加渲染（多余卡片/闪烁）
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._resetEpComments();
        this._bgmExtraLoaded = false;
        // A-29：逐路标志同步复位（嵌套返回恢复上一详情）
        this._bgmExtraRouteLoaded = { comments: false, characters: false, staff: false, relations: false };
        this._bgmExtraFailed = { comments: false, characters: false, staff: false, relations: false }; // A-03：换片复位失败态
        App.showView('detail'); // 嵌套返回时 currentView 已是 detail：视图不切换，App._scrollPos 不介入（A-25）
        // A-26：嵌套返回是「回到刚离开的页面」，重播 hero→页签→内容三级入场
        // 只会拖慢返回手感；给 render() 传标记跳过 .detail-page-anim 挂载，
        // 仅保留页签内容 .tab-enter 淡入。快照 scrollTop 在 render 后回写（A-25）。
        this.render({ skipPageAnim: true, scrollTop: snapshot.scrollTop });
        if (this._bgmId) {
            this._loadBgmExtra();
            // 嵌套返回恢复的 Bangumi 详情同样做进度对账（CatVod 快照无 _bgmId，走本地进度行）
            // A-28：对账走共享降频入口——缓存回填恒发（快速上屏），force 仅按阈值/脏标记
            if (typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                Kazumi._applyBangumiColState(this._bgmId);
                this._reconcileBangumiCol();
            }
        } else if (this._vod) {
            this._refreshLocalProgress(); // 嵌套返回恢复的 CatVod 详情：回填本地进度行
            // A-30：恢复页是 CatVod 版面（快照时刻匹配未完成/被嵌套跳转作废）——
            // 开关开启时重新发起后补匹配，产出与首次 load 等价；开关关闭零变化
            if (await this._catvodBgmMatchEnabled() && typeof Kazumi !== 'undefined') {
                this._deferredBgmMatch(this._loadGen, this._vod);
            }
        }
        return true;
    },

    /** 嵌套跳转回退：优先从栈上恢复上一详情页（关联→新详情→返回原详情），
     *  栈空时再回到外部进入视图（home/search/timeline 等）。 */
    async back() {
        if (this._backStack && this._backStack.length) {
            const prev = this._backStack.pop();
            // _restore 是 async：必须 await 后判断结果，真值判断 Promise 恒真，守卫成死代码
            if (await this._restore(prev)) return;
        }
        App.showView(this.backView || 'home');
    },

    /** CatVod 详情页自动匹配 Bangumi 数据开关（T74：设置 → CatVod源设置，默认关）。
     *  A-27：load() 主链路点，改走 SettingsSnapshot 内存快照——catvodBgmMatch 只在
     *  设置页写入（panels.js:2081，写后经 document change 委托 invalidate 快照），
     *  快照语义与「每次 IPC 拿最新」等价；SettingsSnapshot 未加载时（沙箱测试）
     *  回退直读 settingsGet，行为不变。 */
    async _catvodBgmMatchEnabled() {
        try {
            const s = (typeof SettingsSnapshot !== 'undefined')
                ? await SettingsSnapshot.get() : ((await window.yuki.settingsGet()) || {});
            return s.catvodBgmMatch === true;
        } catch (e) { return false; }
    },

    /** A-10：封面放大/角色详情浮层统一关闭：挂 .float-out 播淡出，FLOAT_OUT_MS 后
     *  摘 .show（对齐 common.js closeDialog 的 .dlg-out + 延迟 hide 手法，含
     *  clearTimeout 防重复关闭时定时器叠发；no-anim 下动画被禁，退场仍是延迟
     *  复位，不影响关闭时机）。Esc 由 common.js dispatchEsc 直摘 .show，走遮罩
     *  基态 opacity 过渡同样淡出（common.js 禁改，无需也不能介入）。
     *  A-32：摘 .show 后 .float-out 不再摘除——退场末态（opacity:0）已显式固化在
     *  ui.css 的 #cover-float.float-out / #char-float.float-out 规则上，遮罩淡出
     *  不依赖 floatOut both 的动画填充保活。旧两步定时器方案存在帧偏移竞态：CSS
     *  过渡/动画比类变更晚一帧起播，第二档定时器按语句时刻计可能抢在遮罩淡出收尾
     *  前摘类，末态随类丢失、面板在遮罩淡出半途闪回不透明（即关闭闪烁）。
     *  .float-out 的复位统一收口在 _showDetailFloat 重开时。 */
    _hideDetailFloat(el) {
        if (!el || !el.classList.contains('show')) return;
        clearTimeout(el._floatOutT);
        el.classList.add('float-out');
        el._floatOutT = setTimeout(() => {
            el.classList.remove('show');
            el._floatOutT = null;
        }, FLOAT_OUT_MS);
    },

    /** A-10：打开浮层前清退场遗留（对齐 openDialog 的 clearTimeout + 摘 .dlg-out，
     *  防退场动画进行中重开被延迟复位误藏）。 */
    _showDetailFloat(el) {
        if (!el) return;
        clearTimeout(el._floatOutT);
        el._floatOutT = null;
        el.classList.remove('float-out');
        el.classList.add('show');
    },

    /** 图片放大浮层「保存图片」：文件名从 URL 提取，交主进程弹系统保存对话框 +
     * 拉图写盘（渲染层 fetch 跨域图片受 CORS 限制）。结果 toast 反馈。 */
    async _saveImageAs(src) {
        let name = 'image';
        try { name = decodeURIComponent(String(src).split('/').pop().split('?')[0]) || 'image'; } catch (e) { /* ignore */ }
        if (!/\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i.test(name)) name += '.jpg';
        try {
            const r = await window.yuki.saveImage(src, name);
            if (r && r.ok) warnToast(`已保存图片：${name}`);
            else if (r && r.reason !== 'cancelled') warnToast('保存图片失败');
        } catch (e) { warnToast('保存图片失败'); }
    },

    /** 封面放大浮层工具栏重置：缩放回 1、旋转归 0（打开新图/点复位时调用）。 */
    _resetCoverFloatTransform() {
        const wrap = document.getElementById('cover-float');
        if (!wrap) return;
        const img = wrap.querySelector('img');
        if (img) { img.style.width = ''; img.style.transform = ''; }
        this._coverZoom = 1;
        this._coverRotate = 0;
    },

    /** 封面放大浮层：按当前 zoom/rotate 应用 img transform。缩放乘旋转
     * （rotate 在前 scale 在后，效果与先转后放一致）；正交角度下无需平移补偿。 */
    _applyCoverFloatTransform() {
        const wrap = document.getElementById('cover-float');
        if (!wrap) return;
        const img = wrap.querySelector('img');
        if (img) img.style.transform = `rotate(${this._coverRotate || 0}deg) scale(${this._coverZoom == null ? 1 : this._coverZoom})`;
    },

    _openCoverFloat(src) {
        if (!src) return;
        let wrap = document.getElementById('cover-float');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'cover-float';
            // 图包一层 .cover-float-stage：floatIn 入场动画的 transform:none 终态会
            // 覆盖 img 自身 transform（旋转/缩放丢一步），动画与操作 transform 分层互不踩
            wrap.innerHTML = '<div class="cover-float-stage"><img referrerpolicy="no-referrer" alt=""></div>'
                + '<div class="cover-float-toolbar">'
                + '<button type="button" data-cf="zoom-out" title="缩小">−</button>'
                + '<button type="button" data-cf="zoom-in" title="放大">+</button>'
                + '<button type="button" data-cf="reset" title="复位缩放与旋转">⟳ 复位</button>'
                + '<button type="button" data-cf="rot-left" title="向左旋转 90°">↺</button>'
                + '<button type="button" data-cf="rot-right" title="向右旋转 90°">↻</button>'
                + '<span class="cover-float-sep"></span>'
                + '<button type="button" data-cf="save" title="保存图片到本地">⬇ 保存</button>'
                + '<button type="button" data-cf="copy" title="复制图片地址">⧉ 复制地址</button>'
                + '<button type="button" data-cf="close" title="关闭 (Esc)">✕</button>'
                + '</div>';
            document.body.appendChild(wrap);
            // 点遮罩空白处关闭；点图本身不关（图上可能想右键/拖拽查看）。
            // stopPropagation：工具栏/stage 内点击不冒泡到遮罩关闭分支
            wrap.addEventListener('click', (ev) => {
                if (ev.target.closest('.cover-float-toolbar')) return; // 按钮分支处理
                if (ev.target.closest('.cover-float-stage')) return;   // 点图不关浮层
                this._hideDetailFloat(wrap);
            });
            wrap.addEventListener('click', (ev) => {
                const btn = ev.target.closest('.cover-float-toolbar button');
                if (!btn) return;
                const act = btn.getAttribute('data-cf');
                const img = wrap.querySelector('img');
                if (act === 'close') { this._hideDetailFloat(wrap); return; }
                if (act === 'save') { this._saveImageAs(img.src); return; }
                if (act === 'copy') {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(img.src).then(() => warnToast('已复制图片地址'), () => warnToast('复制失败'));
                    } else warnToast('复制失败');
                    return;
                }
                if (act === 'reset') { this._resetCoverFloatTransform(); return; }
                if (act === 'rot-left') { this._coverRotate = (this._coverRotate || 0) - 90; this._applyCoverFloatTransform(); return; }
                if (act === 'rot-right') { this._coverRotate = (this._coverRotate || 0) + 90; this._applyCoverFloatTransform(); return; }
                if (act === 'zoom-in' || act === 'zoom-out') {
                    this._coverZoom = Math.max(0.2, Math.min(8, (this._coverZoom == null ? 1 : this._coverZoom) * (act === 'zoom-in' ? 1.2 : 1 / 1.2)));
                    this._applyCoverFloatTransform();
                }
            });
            // 滚轮缩放：累积进 _coverZoom（与按钮缩放同一状态源），连续滚不跳变
            wrap.addEventListener('wheel', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this._coverZoom = Math.max(0.2, Math.min(8, (this._coverZoom == null ? 1 : this._coverZoom) * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
                this._applyCoverFloatTransform();
            }, { passive: false });
            // 右键：保存图片（原「另存」改走主进程保存对话框，CORS 免疫）
            wrap.addEventListener('contextmenu', (ev) => {
                ev.preventDefault();
                const img = wrap.querySelector('img');
                if (img.src) this._saveImageAs(img.src);
            });
        }
        const img = wrap.querySelector('img');
        img.removeAttribute('style');
        this._resetCoverFloatTransform(); // 每次打开清上一张的缩放/旋转遗留
        // 换图防串影：img 节点常驻复用，直接换 src 时上一张已解码的图会一直亮到
        // 新图加载完成（网速慢时「先闪现上一张再换新图」）。src 变更才摘 .loaded
        // （基态 opacity:0 且基态 transition 无 opacity，旧图立即隐没，见 ui.css
        // #cover-float img），新图 load/error 或缓存命中（complete 已真）再挂回淡入；
        // 旧的一次性监听显式摘除防多次换图累积；同图重开不动 loaded，避免无谓灭亮。
        if (img.getAttribute('src') !== src) {
            img.classList.remove('loaded');
            if (img._cfShow) { img.removeEventListener('load', img._cfShow); img.removeEventListener('error', img._cfShow); }
            const show = () => {
                img.removeEventListener('load', show);
                img.removeEventListener('error', show);
                img._cfShow = null;
                img.classList.add('loaded');
            };
            img._cfShow = show;
            img.addEventListener('load', show);
            img.addEventListener('error', show);
            img.src = src;
            if (img.complete && img.naturalWidth) show();
        }
        this._showDetailFloat(wrap); // A-10：清退场遗留后再亮层，防重开被误藏
    },

    async load(force, presetVod) {
        // P2-4：主请求世代守卫——open() 只改引用不重置世代，快速 A→B 打开时
        // 慢的 A 响应回来若继续写状态会产出 site/vodId 取 B、vod_name/vod_pic
        // 取 A 的混合收藏条目。入口自增，await 返回后比对，不一致即丢弃。
        const gen = ++this._loadGen;
        // M-syncrender：open() 已用非过期缓存预置数据（syncVod）——本调用栈内
        // 直接完成渲染，不写骨架、不上延迟转圈（两处占位路径都拿不到执行机会，
        // 页面在点开卡片的同一帧即为完整版面）。
        if (presetVod) {
            try {
                this._vod = presetVod;
                if (presetVod.vod_name) this.vodName = presetVod.vod_name;
                this.sources = this.parsePlay(presetVod);
                this.activeSource = 0;
                this.render();
                this._restoreLastSource().then(() => {
                    // 线路记忆晚到只在「恢复出的线路 ≠ 默认 0」时局部补渲染：
                    // 异步窗口内用户可能已换片/换页签，render 前核验仍是本片。
                    if (gen === this._loadGen && this.site && this._vod === presetVod && this.activeSource) {
                        if (this._activeTab === '分集') this._renderTabContent();
                        else this._refreshLocalProgress();
                    }
                }).catch(() => {});
                // A-30 口径补齐：同步直出与常规路径一样发起后台 Bangumi 匹配
                // （开关开启时），匹配完成后 hero 区局部替换，首屏不被阻塞
                if (await this._catvodBgmMatchEnabled() && typeof Kazumi !== 'undefined') {
                    if (gen === this._loadGen) this._deferredBgmMatch(gen, presetVod);
                }
            } catch (e) { /* 预置渲染失败回落常规网络路径 */ }
            return;
        }
        // 延迟转圈：命中本地/后端缓存时常 <50ms，立即上遮罩会闪一下转圈；
        // 快照半渲染态（_snapHeroShown）不弹全局转圈：hero（封面/标题已可见）
        // + 页签区骨架本身就是加载反馈，再叠一个居中转圈是纯干扰——慢请求的
        // 进度反馈降级为骨架自身的存在。无快照时才用延迟遮罩（hero 骨架是静态
        // 灰块，长等待需要转圈确认「没卡死」）。
        // A-34：遮罩与 hero 骨架都推迟到「确认这次请求真的慢」之后（见下方 race），
        // 不能再无条件先上——否则快速请求也会先把遮罩/骨架闪一遍。
        let endLoading = null;
        try {
            // T74：命中缓存直接复用，避免重复打开重复拉详情（localStorage 持久缓存，重启仍有效）
            // B-13 衍生（详情页手动刷新）：force=true 跳过本地缓存读 + 请求带 refresh=1，
            // 后端 _cached_spider_content 对 refresh 的语义是「跳过读但仍回写」，确定性的按需新鲜度。
            // SWR（stale-while-revalidate）：TTL 过期的缓存条目不再作废——过期未超
            // DETAIL_SWR_MAX_AGE 的条目**立即整页渲染**（重复打开秒开，不转圈），
            // 后台静默回源校准；回源结果与缓存一致（片名/备注/线路数/集数全同）时
            // 零重渲染，有差异（追更出新集等）才覆盖重写。前端 TTL 内直接用缓存
            // 不回源；过期超 SWR 上限或无缓存才走同步网络（转圈等待，与旧版一致）。
            // 注：TTL 内的新鲜缓存条目已由 open() 在同步直出分支消费（presetVod），
            // 正常不会进到这里；此分支保留兜底（直接调 load() 的调用点：_refreshDetail
            // 的重试等）与 force/SWR 语义。
            const cacheKey = String(this.site) + '|' + String(this.vodId);
            let vod = null;
            let data = null;
            let swrPending = false; // 已用陈旧缓存上屏、后台校准在途
            // 注意：命中判断只能走非破坏性的 localCachePeek——localCacheGet
            // 会在发现过期时立即删除条目，先用它试「新鲜读」会把 stale 条目删掉，
            // 紧随的 peek 只能拿到 null，SWR 分支永远不可达（整段 SWR 白写）。
            if (!force && typeof localCachePeek === 'function') {
                const cached = localCachePeek(DETAIL_VOD_CACHE_PREFIX + cacheKey);
                if (cached && cached.value) {
                    if (!cached.expired) {
                        vod = cached.value; // TTL 内：直接用，零网络
                    } else if ((Date.now() - (cached.at || 0)) <= DETAIL_SWR_MAX_AGE) {
                        vod = cached.value; // 过期 ≤7 天：陈旧垫场
                        swrPending = true;  // 后台校准
                    }
                }
            } else if (!force) {
                vod = _detailCacheGet(DETAIL_VOD_CACHE_PREFIX, cacheKey);
            }
            if (!vod) {
                // 无缓存 / force / 陈旧超上限：同步网络（延迟转圈兜底反馈）
                //
                // A-34 首屏宽限期（CatVod）：请求发出后先让它跑 DETAIL_LOADING_DELAY_MS
                // 毫秒——若在宽限期内返回，本函数尚未向页面写过任何东西，**第一次绘制
                // 就是完整版面**（0.2.6 同款「打开即见」，且封面与文字同时到位）；超过
                // 宽限期才落到渐进路径（写 hero 骨架，数据迟到后再整页覆盖）。
                // 动机：v0.2.6 之所以「打开即显示」是因为它把整条 await 链串完才画第一
                // 帧，快速到达的请求因此从未被人看见「加载态」。第二阶段把首帧前移后，
                // 快速请求也会先闪一屏残缺的快照 hero 再被整页覆盖——多一次绘制、多一
                // 次视觉切换，主观上比 v0.2.6 更慢。宽限期让「该快的时候不放中间态」，
                // 慢源仍享受渐进显示。
                // 用 Promise.race 而非 await 后再判断，是为了让**同一次**请求的剩余等待
                // 继续在后台跑，绝不重发第二个请求：
                //   - 宽限期赢（数据已到）→ 不写任何占位，直接走下方正常渲染；
                //   - 宽限期输（数据未到）→ 写 hero 骨架，随后 await 同一个 promise。
                // 「宽限期 <-> DETAIL_LOADING_DELAY_MS」刻意与延迟转圈同阈值：快到不给
                // 中间态的请求，也不该看到转圈，两条路径保持同一口径。
                const reqP = doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]), refresh: force ? '1' : '' });
                const graceP = _graceTimeout(DETAIL_LOADING_DELAY_MS);
                // L42：__clear 放 finally——await race 抛出时定时器也能被清掉
                let withinGrace;
                try {
                    withinGrace = await Promise.race([reqP.then(() => true), graceP]);
                } finally {
                    graceP.__clear(); // 无论胜负都清定时器，别留到宏任务队列
                }
                if (!withinGrace) {
                    // 请求真的慢：此时才上延迟遮罩与 hero 骨架（快路径已整页直出，
                    // 不会走到这里，因此两边都不会白闪）。
                    // 顺序固定：先遮罩（200ms 后再真显示），再骨架；快照半渲染态不
                    // 上遮罩，也不覆盖已显示的快照 hero（覆盖等于把「封面先出」归零）。
                    if (!this._snapHeroShown) endLoading = _detailDelayedLoading();
                    if (!this._snapHeroShown) {
                        $('#detail-body').html(_detailSkeleton('hero', null, '载入中…')); // A-02：详情主体 hero 骨架
                    }
                }
                data = await reqP; // 同一个 promise：数据在此真正到位（已在途则立刻兑现）
                vod = (data && data.list && data.list[0]) || null;
                if (vod) _detailCacheSet(DETAIL_VOD_CACHE_PREFIX, cacheKey, vod, DETAIL_CACHE_TTL);
            }
            if (gen !== this._loadGen) return; // 已切到别的详情，旧响应丢弃
            if (!vod) {
                // #11：data.error 为第三方源回传内容，进 .html() 前必须 escHtml
                const err = data && data.error ? `（${escHtml(String(data.error).slice(0, 120))}）` : '';
                this._snapHeroShown = false;
                this._detailDataPending = false; // 结果未到但请求已终态：占位按钮不再「稍候」
                $('#detail-body').html(`<div class="tip-line">未取得详情${err}</div>`);
                return;
            }
            if (vod.vod_name) this.vodName = vod.vod_name;
            // A-01 快照合并（详情结果优先）：实现走「半渲染垫场 + 结果到达整页覆盖」——
            // 快照先行半渲染占位，detailContent 结果到达后整页重绘； remarks/year 等
            // 卡片字段在结果缺失时由半渲染垫场数据兜底显示，线路/简介/导演演员等
            // 全量字段永远以 detailContent 结果为权威（快照是 2h TTL 的垫场数据）。
            // 注：此处并无字段级 merge——「合并」指垫场与结果两段展示的覆盖关系。
            // 半渲染在显示标记先行快照（1087 置 false 前取值）：供下方 render 决定
            // 是否跳过入场动画（原位覆盖不重播，防封面/标题二次闪现）。
            const snapHeroWasShown = this._snapHeroShown;
            this._snapHeroShown = false; // 半渲染态结束：结果到达，后续 render 是完整版面
            this._detailDataPending = false; // A-35：线路已解析，播放按钮不再走「稍候」分支
            this._vod = vod;
            this.sources = this.parsePlay(vod);
            this.activeSource = 0;
            // M-syncrender：线路记忆恢复（一次设置读取，冷启动为 IPC 往返）不再
            // 阻塞首屏——先以默认线路渲染，恢复在后台完成后仅当恢复了非默认线路
            // 才局部补渲染分集页签/进度行。旧实现把这次 await 串在网络/缓存读取
            // 与 render 之间，缓存命中路径白白多等一帧。
            this.render(snapHeroWasShown ? { skipPageAnim: true } : undefined);
            this._restoreLastSource().then(() => {
                if (gen === this._loadGen && this.activeSource) {
                    if (this._activeTab === '分集') this._renderTabContent();
                    else this._refreshLocalProgress();
                }
            }).catch(() => {});
            // SWR 后台校准：不阻塞渲染（render 已完成），世代守卫防换片串写。
            // 校准请求不带 refresh（后端 30min 会话缓存仍可命中，回源成本低）；
            // 与缓存一致则静默丢弃，有差异覆盖重写（追更可见）。
            if (swrPending) this._swrRevalidate(gen, cacheKey);
            if (await this._catvodBgmMatchEnabled() && typeof Kazumi !== 'undefined') {
                this._deferredBgmMatch(gen, vod);
            }
        } catch (e) {
            if (gen !== this._loadGen) return; // 已切到别的详情，旧错误不覆盖新页面
            // A-03：失败不再只是死提示——补重试入口，重入 load()（世代守卫已就绪，
            // 旧响应不会污染新请求）。快照半渲染态一并收口（失败页替代垫场 hero，
            // 重试成功后重入 load 正常出全量版面）
            this._snapHeroShown = false;
            this._detailDataPending = false; // 请求已终态（失败）：占位按钮不再「稍候」
            $('#detail-body').html(`<div class="tip-line">${escHtml('详情载入失败')}</div>`
                + `<div class="tip-line" style="padding-top:0"><button type="button" id="detail-load-retry" class="md-btn md-btn-tonal md-btn-sm">重试</button></div>`);
            $('#detail-load-retry').on('click', () => this.load());
            warnToast('详情载入失败');
        } finally {
            // 延迟遮罩收尾：定时器**无条件**取消（否则过期世代的定时器稍后仍会
            // showLoading，而新请求可能根本没有对应的 endLoading 去收它，遮罩就
            // 永久残留）；是否隐藏遮罩则只在仍是最新世代时为 true——A→B 快速切换
            // 时旧请求的收尾不得隐藏新请求刚按 200ms 阈值显示的遮罩。
            // 快照半渲染态未上遮罩（endLoading=null），无需收尾。
            if (endLoading) endLoading(gen === this._loadGen);
        }
    },

    /** SWR 后台校准（load 过期缓存垫场路径专用）：静默回源取最新详情，与已上屏
     *  的陈旧数据比对——一致（片名/备注/线路集数指纹全同）则零动作（避免无谓
     *  重渲染打断浏览），有差异则覆写缓存并整页重渲染（追更出新集等可见）。
     *  世代守卫：校准期间已换片（_loadGen 变）则丢弃；失败静默（陈旧页保持
     *  可用，下次打开重新校准）。 */
    async _swrRevalidate(gen, cacheKey) {
        try {
            const rsp = await doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]) });
            if (gen !== this._loadGen) return; // 校准期间已换片/返回
            const fresh = (rsp && rsp.list && rsp.list[0]) || null;
            if (!fresh) return; // 回源失败/空：保留陈旧页（下次打开再校准）
            _detailCacheSet(DETAIL_VOD_CACHE_PREFIX, cacheKey, fresh, DETAIL_CACHE_TTL);
            const old = this._vod;
            const same = old && old.vod_name === fresh.vod_name
                && (old.vod_remarks || '') === (fresh.vod_remarks || '')
                && (old.vod_play_url || '') === (fresh.vod_play_url || '');
            if (same) return; // 无更新：陈旧页即最新，零重渲染
            if (String(this.site) + '|' + String(this.vodId) !== cacheKey) return; // 双保险
            this._vod = fresh;
            this.sources = this.parsePlay(fresh);
            this.activeSource = 0;
            // 原地数据更新：与整页覆盖路径不同，这里必须带 skipPageAnim + 保留
            // 滚动位置——重挂 .detail-page-anim 会让 hero/页签/内容三级上浮重播，
            // 用户正看分集或吐槽时整页动画闪一下还可能跳位。
            const _viewEl = document.getElementById('view-detail');
            const _top = _viewEl ? _viewEl.scrollTop : 0;
            await this._restoreLastSource();
            if (gen !== this._loadGen) return; // 恢复期间已换片：不再覆盖新页面
            this.render({ skipPageAnim: true, scrollTop: _top });
        } catch (e) { /* 校准失败静默：陈旧页继续可用 */ }
    },

    /** B-13 衍生（详情页手动刷新）：详情 hero 的「刷新」按钮入口。全应用唯一没有
     *  用户可控 force 旁路的内容页补齐——首页有 #home-refresh、播放重连带 refresh=1。
     *  - CatVod 版面：清 detail::vod::v1:: 本地缓存条目 → load(true) 跳缓存读并让
     *    后端 _cached_spider_content 跳读回源（refresh 语义：跳读仍回写）。
     *  - Bangumi-only 版面（openBangumi）：清 detail::bgminfo::v1:: 本地缓存条目后
     *    重入 openBangumi（bangumiInfo 的 30min localStorage 缓存读才会真正回源）。
     *  - 不清 detail::bgmextra::（评论/角色等慢频数据，30min 窗口可接受）与
     *    kazumi_bgm_eps::（Bangumi 分集 30min）：追更主战场是 CatVod sources，
     *    慢频数据保持稳定缓存命中率。
     *  调用方（init 事件委托）负责防抖（disabled 期间忽略），此处只做纯数据动作。 */
    _refreshDetail() {
        // 返回栈修复：置位刷新标记——刷新是本页原地更新，重入的 openBangumi/load(true)
        // 不得压栈/清栈（否则一次返回恢复的是刷新前旧快照，永远回不到上级视图）。
        // 压栈判断只存在于 open()/openBangumi() 的同步段：调用表达式求值即执行完毕，
        // 故 finally 立即复位——标志不跨 await 存活，刷新在途的嵌套跳转（关联卡片）
        // 仍正常压栈。返回 promise 供点击处理复位 spinner/禁用态。
        this._reloadInProgress = true;
        try {
            // Bangumi-only：site 为空。清 bangumiInfo 缓存条目后重入 openBangumi 恢复页面
            if (!this.site) {
                const sid = String(this._bgmId || this.vodId || '');
                if (!sid) return Promise.resolve();
                if (typeof localCacheDel === 'function') {
                    try { localCacheDel('detail::bgminfo::v1::' + sid); } catch (e) { /* ignore */ }
                }
                // 透传 _kazumiOrigin：刷新重入若丢失该参数，恢复页面后「开始观看」
                // 会失去 Kazumi 搜索来源记忆（退化为全源选源弹窗）
                return this.openBangumi(sid, this.vodName, this._kazumiOrigin);
            }
            // CatVod：清该条目的详情缓存 → load(true)（force 跳本地缓存读并让请求带 refresh=1）
            if (typeof localCacheDel === 'function') {
                try { localCacheDel(DETAIL_VOD_CACHE_PREFIX + String(this.site) + '|' + String(this.vodId)); } catch (e) { /* ignore */ }
            }
            return this.load(true);
        } finally {
            this._reloadInProgress = false;
        }
    },

    parsePlay(vod) {
        const froms = String(vod.vod_play_from || '').split('$$$').filter(Boolean);
        const urls = String(vod.vod_play_url || '').split('$$$');
        return froms.map((from, i) => ({
            from,
            episodes: String(urls[i] || '').split('#').filter(Boolean).map((e) => {
                const idx = e.indexOf('$');
                return idx > 0 ? { name: e.slice(0, idx), url: e.slice(idx + 1) } : { name: e, url: e };
            }),
        })).filter((s) => s.episodes.length);
    },

    metaLine(vod) {
        const bits = [vod.type_name, vod.vod_year, vod.vod_area, vod.vod_remarks].filter(Boolean);
        return bits.join(' · ');
    },

    /** 放送星期：从放送日期推算（subject 详情接口不含 air_weekday，日历接口才有）。
     *  非法/缺失日期返回空串。1=周一 … 7=周日（与 Bangumi air_weekday 口径一致）。 */
    _airWeekday(dateStr) {
        const s = String(dateStr || '').trim();
        const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (!m) return '';
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (Number.isNaN(d.getTime())) return '';
        return '周' + '日一二三四五六'[d.getDay()];
    },

    /** 总话数与完结态：eps>0 时返回 {eps, finished}。完结判定：Bangumi 无显式
     *  完结字段，以「有总话数 + 放送日期已过（今日 > 放送日 + eps 周）」近似——
     *  放送日期缺失时只显示总话数不显示完结。 */
    _episodesState(bgm) {
        const eps = Number(bgm && (bgm.eps || bgm.total_episodes)) || 0;
        if (!eps) return null;
        const dateStr = String((bgm && (bgm.date || bgm.air_date)) || '').trim();
        let finished = false;
        if (dateStr) {
            const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            if (m) {
                const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
                if (!Number.isNaN(start.getTime())) {
                    // 每周更新一话：放送日 + eps 周后放完（留 3 天余量容忍拖更统计口径）
                    const end = start.getTime() + eps * 7 * 86400000 + 3 * 86400000;
                    finished = Date.now() > end;
                }
            }
        }
        return { eps, finished };
    },

    render(opts) {
        // A-01 第二阶段：快照半渲染态（opts.snapHero）——open() 命中列表快照时
        // 临时把快照 vod 挂到 this._vod 渲染 hero-only 版面（无 sources/无线路区），
        // 渲染后立即还原：实例态 _vod/sources 保持 null/[]，权威数据仍由 load()
        // 独占写入（快照字段绝不落实例态，防收藏/分享等下游读到垫场数据）。
        // _snapHeroVod 已在 open() 经 _detailSnapVod 校验为 vod 形状，此处直接取用
        // （勿再过 _detailSnapVod 二次映射——其入参是快照形状，vod 形状会被判空）。
        const snapHeroVod = (opts && opts.snapHero && this._snapHeroVod) || null;
        if (snapHeroVod) this._vod = snapHeroVod;
        // A-01（Bangumi 路径）：openBangumi() 快照半渲染（this._snapHeroBgm 已在
        // 调用前置位，_bgmInfo 已挂最小 bgm 形状）。与 CatVod 快照路径同款：仅 hero
        // 垫场，页签区骨架、_loadBgmExtra/收藏对账等副作用全部延后到 bangumiInfo
        // 到达后的完整 render——半渲染期 _bgmInfo 是最小形状，评分摘要/收藏菜单
        // 渲染出来也是残缺占位，不渲染更干净。
        const snapHeroBgm = !!(opts && opts.snapHeroBgm && this._snapHeroBgm);
        if (snapHeroBgm) this._snapHeroBgm = false;
        this._lastVod = this._vod || null;
        const vod = this._vod;
        const bgm = this._bgmInfo;
        const hasBgm = !!this._bgmId;
        // 详情封面：Bangumi 封面走 bangumiCoverImg（/kazumi/cover 本地代理 + 磁盘缓存
        // + 镜像兜底链，B-08 跨重启命中——直连 lain 图床被墙/慢时 hero 封面长时间空白；
        // size='large' 保持详情大图口径）；bgm 无封面时回落源封面 vod_pic（可能是任意
        // 图床，CatVod 源无白名单代理，保持 vodCoverImg 直连）。占位图兜底由链尾承担。
        // 快照半渲染态封面走 vodCoverImg 直连：URL 就是列表卡此刻正在显示的那张图
        // （浏览器 HTTP 缓存必然命中，零网络秒出）；代理链/large 变体属于完整 render
        // 口径（后端 B-08 磁盘缓存兜底），半渲染期不引入额外网络变量。
        // A-01 快照封面沿用（防「显示→占位→恢复」闪变）：半渲染 hero 的封面 URL 在
        // openBangumi 快照路径记入 _snapCoverShown；bangumiInfo 到达整页 render 时若
        // 结果封面与快照封面是同一 URL（时间表/推荐卡直连 origin 的常态），继续用
        // vodCoverImg 直连——URL 未变浏览器缓存秒出，换代理链反而要重走一次代理
        // （URL 变了 → 新 img opacity:0 → 旧图已被 innerHTML 替换 → 视觉上占位闪一下
        // 再恢复）。非同 URL（Kazumi 搜索卡的代理 URL 快照，token 每次重启变）不沿用，
        // 正常走代理链（后端磁盘缓存按 origin 键命中）。
        const cover = (bgm && bgm.images && bangumiCover(bgm.images, 'detail'))
            || (vod && vod.vod_pic) || '';
        // A-30：判定放宽为「同一张图」而非「URL 逐字相同」。列表卡用 card 变体、
        // 详情 hero 用 large 变体，两者逐字必然不同（r/400 vs 无 r 前缀、段字母
        // c vs l），旧全等比较使沿用机制在 Bangumi 路径上从未生效——完整 render
        // 每次都换代理链 URL → 新 img opacity:0 重载 → 占位→显示→闪一下。
        // 同图时沿用**快照 URL 直连**（浏览器缓存秒出、零网络、零重绘），大图需求
        // 交给点击放大（_openCoverFloat 走 large 变体）与半渲染期的后台预热承担。
        // M-coverkeep（CatVod 路径接入）：CatVod 快照半渲染（snapHero 分支）同样
        // 记入 _snapCoverShown——detailContent 结果的 vod_pic 与列表卡封面是同一
        // origin 图（CMS 源 vod_pic 列表/详情同源），沿用快照 URL 直连后 hero 封面
        // URL 逐字不变，配合 render() 的同图节点搬移实现结果覆盖零闪变。半渲染期
        // 走 vodCoverImg 直连（= 列表卡正在显示的 URL，浏览器缓存必然命中），完整
        // render 有 keepSnapCover 时继续直连，无 则回落 bangumiCoverImg 代理链/large。
        const keepSnapCover = !!(snapHeroBgm === false && this._snapCoverShown
            && cover && _detailSameCoverPicture(cover, this._snapCoverShown));
        if (snapHeroBgm || (snapHeroVod && vod)) this._snapCoverShown = cover; // 半渲染记下 URL 供完整 render 比对
        // 沿用分支渲染**快照 URL**（= 列表卡正在显示的那张，浏览器 HTTP 缓存必然
        // 命中）；不能用 cover（large 变体 = 另一个 URL，仍会走一次网络并闪变）。
        // 旧实现两 URL 全等时二者无差别，放宽为「同图」后必须显式取快照 URL。
        const snapCoverUrl = keepSnapCover ? this._snapCoverShown : cover;
        // 沿用分支补 data-big=large 变体：hero 现在是列表卡小图，点击放大必须升到
        // 大图（否则放大得到降采样图）。vodCoverImg 无该参数位，按约定在首个属性后
        // 就地注入（与评论头像 data-big 同口径，点击处读它优先于 src）。
        const _withBig = (html, bigUrl) => (bigUrl
            ? html.replace(/^<img\s/, `<img data-big="${escHtml(bigUrl)}" `)
            : html);
        // bangumiResizeUrl 属 common.js 全局（单测沙箱可能未注入该桩，如
        // detail-bgm-snap 的 loadAll）——缺失时退回 cover 本身，绝不让大图
        // 推导炸掉整页 render（封面沿用只是优化，不能成为渲染失败面）。
        const _bigOf = (u) => {
            try { return (typeof bangumiResizeUrl === 'function' ? bangumiResizeUrl(u, 'large') : '') || u; }
            catch (e) { return u; }
        };
        const bigCover = keepSnapCover ? _bigOf(cover) : '';
        const coverImgHtml = (bgm && bgm.images && cover)
            ? ((snapHeroBgm || keepSnapCover)
                ? _withBig(vodCoverImg(snapCoverUrl, true), bigCover)
                : bangumiCoverImg(cover, true, 'large'))
            // 纯 CatVod（无 bgm）：沿用分支用快照 URL 直连（零闪变），否则 vodCoverImg 直连 vod_pic
            : ((keepSnapCover && snapCoverUrl) ? _withBig(vodCoverImg(snapCoverUrl, true), bigCover) : vodCoverImg(cover, true));
        const name = bgm ? (bgm.name_cn || bgm.name || (vod && vod.vod_name) || this.vodName) : ((vod && vod.vod_name) || this.vodName);
        // 中文名为标题时，原名（日文/英文）作右下角小字副标题；同名则不重复展示
        const origName = (bgm && name !== bgm.name && bgm.name) ? bgm.name : '';
        const airWeek = bgm ? this._airWeekday(bgm.date || bgm.air_date) : '';
        // 话数进放送行：放送 2026-07-06 周一 · 12话 [已完结]（与话数同一行）。
        // 日期/星期/话数为服务端受控格式；platform/type_name 为远端字段需 escHtml，
        // 完结徽标的 span 依赖 meta 以 HTML 直拼，故各分段在此处分别转义。
        const epState = bgm ? this._episodesState(bgm) : null;
        const meta = bgm
            ? [
                bgm.date || bgm.air_date
                    ? escHtml(`放送 ${bgm.date || bgm.air_date}${airWeek ? ` ${airWeek}` : ''}${epState ? ` · ${epState.eps}话` : ''}`)
                        + (epState && epState.finished ? ' <span class="detail-eps-finished">已完结</span>' : '')
                    : '',
                bgm.platform ? escHtml(bgm.platform) : '',
                bgm.type_name ? escHtml(bgm.type_name) : '',
            ].filter(Boolean).join(' · ')
            // CatVod 分支：metaLine 各段是第三方 CMS 源回传字段（#11 口径），
            // 拼串后必须整体转义——插入点是 .html()，漏转义即 HTML 注入
            : escHtml(this.metaLine(vod || {}));
        // A-34 meta 行加载/空态双口径（A-35 复用为「详情结果是否在途」的总标志）：
        // 半渲染态下 meta 各段（放送日期/平台/类型、CatVod 的年份/地区/类型/备注）
        // 大多还没到，旧实现一律渲染成「暂无更多信息」——与「这部片子确实没有 meta
        // 数据」逐字相同，1-3s 后又被真数据覆盖，等于先报错再自我纠正。改与播放信息
        // 行同口径（「线路加载中…」/「暂无播放线路」）：数据未到说「加载中」，确认
        // 无数据才说「暂无」。播放按钮同理在此期间也必须占位（见 _catvodStartHtml）。
        const dataPending = !!(snapHeroVod || snapHeroBgm);
        const people = [
            vod && vod.vod_director ? `导演：${escHtml(vod.vod_director)}` : '',
            vod && vod.vod_actor ? `演员：${escHtml(vod.vod_actor)}` : '',
        ].filter(Boolean).join('<span class="detail-people-sep">·</span>');
        const localFrag = vod ? this._localColHtml() : '';
        // 封面进度徽章已删除（话数/完结信息在头部 meta 行展示，封面重复展示嫌挤）
        // 操作行布局对齐 Bangumi 范式：匹配到 Bangumi 时 Bangumi 操作行在上、
        // 本地收藏+网页按钮成行置下（两套收藏体系并存）；纯 CatVod 时单行
        // [▶ 开始播放][本地收藏][↗ 网页]（_catvodStartHtml 内嵌 localFrag）。
        const bgmColHtml = this._bangumiColHtml(bgm);
        const heroActions = bgmColHtml
            ? bgmColHtml + (localFrag
                ? `<div class="kazumi-watch-row detail-watch-row-plain">${localFrag}${this._catvodWebBtnHtml()}</div>`
                : '')
                : this._catvodStartHtml(localFrag, dataPending);
        // 刷新按钮 v2：hero 操作行不再内挂刷新钮——按钮已静态移到返回按钮右侧
        // （index.html .detail-topbar），重渲染 hero 不会冲掉它，也无需任何补挂。
        // A-01 半渲染态尾标（详情结果到达后被整页 render 覆盖，无需摘除逻辑）：
        // 页签内容区先垫骨架，用户滚动到页签区也不见空白。形态用 desc（简介
        // 卡片）而非 card 网格——概览页签的真实内容是简介段落，占位与结果
        // 形态一致（旧 card 网格占位到达后变成文本卡，视觉形态跳变）。
        // Bangumi 快照半渲染同口径（此时无简介数据，概览垫同形态骨架）。
        const tabContentHtml = (snapHeroVod || snapHeroBgm)
            ? _detailSkeleton('desc', { count: 6 }, '载入中…')
            : '';
        let html = `
        <div class="detail-head detail-hero ${hasBgm ? 'detail-hero-bangumi' : 'detail-hero-catvod'}">
            <div class="detail-cover detail-hero-cover">${coverImgHtml}</div>
            <div class="detail-info detail-hero-info">
                <div class="detail-kicker">${hasBgm ? 'BANGUMI 详情' : '影片详情'}</div>
                <h1 class="detail-title">${escHtml(name)}${origName ? `<span class="detail-title-orig">${escHtml(origName)}</span>` : ''}</h1>
                <div class="detail-meta">${meta || (dataPending ? '信息加载中…' : '暂无更多信息')}</div>
                ${people ? `<div class="detail-people">${people}</div>` : ''}
                ${hasBgm ? this._bangumiStatsHtml(bgm) : `<div class="detail-catvod-facts">
                    <span class="detail-fact-label">播放信息</span>
                    <span class="detail-fact-value">${this.sources.length ? `${this.sources.length} 条线路 · 共 ${this.sources[0].episodes.length} 集`
                        // A-01 半渲染态：详情结果未到 ≠ 无源——展示「加载中」而非误导性「暂无播放线路」
                        : (snapHeroVod ? '线路加载中…' : '暂无播放线路')}</span>
                </div>`}
                ${hasBgm ? '' : this._watchProgressBarHtml('detail-local-progress')}
                <div class="detail-hero-actions">${heroActions}</div>
            </div>
        </div>`;
        // 页签栏（A-22：span 非原生可聚焦，补 tabindex="0" 配合 keydown 委托）
        const tabs = DETAIL_TABS.map((t) => `<span class="detail-tab ${t === this._activeTab ? 'active' : ''}" data-tab="${t}" tabindex="0" role="tab" aria-selected="${t === this._activeTab ? 'true' : 'false'}">${t}</span>`).join('');
        // 吸顶锚点哨兵：零高度静态元素紧贴页签栏前。不能用页签栏自身的
        // offsetTop 测吸顶锚点——Chromium 对已吸顶的 sticky 元素返回含粘性
        // 位移的布局位（滚得越深数值越虚增），会导致切页签永远停在原位。
        html += `<div id="detail-tabs-sentinel" aria-hidden="true"></div><div class="detail-tabs class-tabs" role="tablist" aria-label="详情内容">${tabs}</div>`;
        html += `<div id="detail-tab-content" class="detail-content" role="tabpanel">${tabContentHtml}</div>`;
        // detail-page-anim：hero/页签/内容分级上浮入场（CSS 按非毛玻璃门控）。
        // innerHTML 替换不清除容器类，每次打开详情/嵌套返回都会重播一次入场动画。
        // A-26：嵌套返回（_restore 路径）不重播三级入场——不挂 .detail-page-anim
        // 且摘掉可能的残留，只保留页签内容 .tab-enter 淡入；直接打开详情
        // （load/openBangumi）不传 opts，仍播完整三级入场，行为不变。
        const pageAnim = !(opts && opts.skipPageAnim);
        const $body = pageAnim ? $('#detail-body').addClass('detail-page-anim')
            : $('#detail-body').removeClass('detail-page-anim'); // A-26：恢复路径摘 class（残留也会重播入场）
        // 封面同图节点搬移（M-coverkeep）：数据到达后的整页覆盖若换上了同一张图
        // （快照半渲染封面 → detailContent 结果封面同图；SWR 校准重渲染封面未变；
        // bgm 后补匹配沿用 vod_pic 等），旧 hero 的 <img> 已解码且 opacity:1 常亮，
        // 而 .html() 产出的新 <img> 基态 opacity:0 + loaded 淡入——即使 URL 逐字相同、
        // 浏览器缓存秒出，也会先空 1-2 帧再淡入，视觉即「已显示的封面闪一下占位
        // 再恢复」。此处先记下旧封面节点，html() 替换后若新 hero 里是同一张图
        // （_detailSameCoverPicture 归一化比对，快照 card 变体 ↔ 结果 large 变体
        // 也可判同图），就把旧节点原位搬回（replaceWith 移动节点：位图/加载态/
        // opacity 全保留，零网络零空窗）。非同图（真换了封面）不搬，正常走淡入。
        const prevCoverImg = document.getElementById('detail-body')
            ? document.getElementById('detail-body').querySelector('.detail-hero-cover img') : null;
        $body.html(html);
        try {
            const newCoverImg = document.getElementById('detail-body')
                ? document.getElementById('detail-body').querySelector('.detail-hero-cover img') : null;
            if (prevCoverImg && newCoverImg && prevCoverImg !== newCoverImg
                && prevCoverImg.src && newCoverImg.src
                && _detailSameCoverPicture(prevCoverImg.src, newCoverImg.src)
                && prevCoverImg.complete && prevCoverImg.naturalWidth) {
                newCoverImg.replaceWith(prevCoverImg);
            }
        } catch (e) { /* 搬移失败静默：新节点照常走淡入 */ }
        // A-25：嵌套返回回写快照滚动位置。_restore 全程停在 #view-detail 内
        // （视图不切换，App._scrollPos 不介入；app.js 对 detail 固定回顶也不触发——
        // showView 时 name === currentView，双 rAF 恒写 0），滚动位置只能靠快照自持。
        // 同帧同步赋值：html() 已替换 DOM，此刻赋值在渲染管线取布局前完成，无双 rAF
        // 空窗；随后 _clampDetailScroll 钳制越界，防新内容变矮时先画一帧越界内容。
        const restoreTop = opts && Number.isFinite(opts.scrollTop)
            ? Math.max(0, opts.scrollTop) : null;
        if (restoreTop !== null) {
            const viewEl = document.getElementById('view-detail');
            if (viewEl) viewEl.scrollTop = restoreTop;
        }
        this._clampDetailScroll();
        this._refreshLocalCol();
        // A-01 半渲染态（M7）：页签区已垫 desc 骨架（tabContentHtml），跳过页签渲染——
        // 否则 _renderOverview 拿快照 vod 得不出简介/标签，立即以「暂无概览信息」
        // 误导性空态覆盖骨架（详情结果未到 ≠ 无数据）。快照页签仅展示 hero。
        // Bangumi 快照半渲染同口径（_bgmInfo 是最小形状，简介/标签/吐槽皆未加载）。
        if (!snapHeroVod && !snapHeroBgm) this._renderTabContent();
        // 本地观看进度行（CatVod 源）：从收藏条目 progress 回填「看到第 N 集 / 共 M 集」
        // A-01 半渲染态不回填：进度行是展示细节，详情结果到达后整页 render 自然补齐
        if (!hasBgm && vod && !snapHeroVod) this._refreshLocalProgress();
        // A-01 半渲染态收尾：还原实例态（快照 vod 仅在本次渲染作用域内生效），
        // _lastVod 同步回真实值——防收藏/分享/进度等下游读到垫场数据。
        // Bangumi 路径的 _bgmInfo 不还原：openBangumi 的 await 正在用 this._bgmInfo
        // 承载半渲染 hero，权威数据由其覆盖赋值（结果到达前正是快照本身）。
        if (snapHeroVod) {
            this._vod = null;
            this._lastVod = null;
        }
        // 后台加载 Bangumi 补充数据
        // A-01（Bangumi 半渲染）：_loadBgmExtra/收藏对账延后到 bangumiInfo 到达后的
        // 完整 render——半渲染期 _bgmId 已就位，若在此发起，1-3s 后完整 render 会再
        // 发一轮（四路请求 ×2），且半渲染世代下晚到的吐槽数据会写到快照版面。
        if (hasBgm && !snapHeroBgm) {
            this._loadBgmExtra();
            if (typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                // 先用缓存即时回填收藏高亮；A-28 后不再无条件 force 回源对账：
                // 仅距上次对账超 5min 或写操作置脏时才回源（_reconcileBangumiCol）。
                // 缓存 6h TTL 内 ep_status 可能落后（他设备打点/换设备），force 回源
                // 成功后进度行按远端重算；非 force 窗口内的陈旧属可接受口径（见方法注释）
                Kazumi._applyBangumiColState(this._bgmId);
                this._reconcileBangumiCol();
            }
        }
        // A-01（Bangumi 半渲染）大图预热：半渲染 hero 封面是列表卡正在显示的 URL
        // （浏览器缓存秒出），详情完整 render 用 large 变体代理链——后台先按 large
        // 变体预热（快照 URL 是 lain 域名时推导 large 变体；否则直接用 images.large，
        // 走代理磁盘缓存/官方 CDN）。bangumiInfo 到达整页 render 时图片多已进浏览器
        // 缓存，大图无缝续显零闪变。半渲染无封面（快照缺 pic）时跳过。
        if (snapHeroBgm && bgm && bgm.images) {
            const raw = (bgm.images && bgm.images.large) || '';
            const warmUrl = cover && /^(https?:\/\/)?lain\.[^/]+\//i.test(cover)
                ? bangumiResizeUrl(cover, 'large') || raw
                : raw;
            if (warmUrl) {
                const warm = new Image();
                warm.referrerPolicy = 'no-referrer';
                warm.src = warmUrl;
            }
        }
    },

    /** A-28 收藏态双查降频：按需 force 收藏对账（render() 与 _restore() 共用入口）。
     *  force 条件（_detailColForceDue）：距上次对账 > 5min，或自上次对账后发生过
     *  收藏写操作（FavHub 广播置脏）。缓存回填路径（_applyBangumiColState 非 force）
     *  不动——快速上屏语义保持。
     *  最终一致性口径：非 force 窗口内若另一端（他设备/WebDAV 同步）改了收藏，
     *  用户看到的是本地缓存态，属 5min 窗口内可接受陈旧（低频写场景）；写后一致
     *  由两层保障：①本应用写路径乐观更新缓存（setBangumiCollection/打点写
     *  _bgmColCache，remove 作废缓存）立即生效；②FavHub 广播置脏 → 下次打开强制
     *  对账兜底。发起前先清脏/记时间戳：对账请求本身可能失败（返回 null 不回写
     *  有效数据），若置脏留到下次会导致每次打开都 force——一次尝试即消耗本次
     *  「该对账」机会，失败场景下次按 5min 窗口重试，防持续失败时每开必打。 */
    _reconcileBangumiCol() {
        if (!this._bgmId || typeof Kazumi === 'undefined' || !Kazumi._applyBangumiColState) return;
        if (!_detailColForceDue()) return;   // 5min 窗口内且无写操作：跳过 force（走缓存）
        _detailColMarkReconciled();
        Kazumi._applyBangumiColState(this._bgmId, { force: true });
    },

    /** A-30 Bangumi 匹配「先渲染后补」状态机：
     *  _bgmDefer = undefined       未进入后补流程（openBangumi 直开 / 开关关闭 / 未初始化）
     *  _bgmDefer = { gen, vod }    匹配在途（「匹配中」）——gen 是发起本次匹配的详情世代
     *  _bgmDefer = null            后补已结束（已到达并应用 / 匹配失败 / 被世代作废）
     *  由 load() 开关开启时置为在途态；旧副本异步返回时按 gen 比对自弃。
     *  挂在 Detail 上便于测试注入/断言（同 _colReconcileTs 手法）。 */
    _bgmDefer: undefined,

    /** A-30：后台 Bangumi 匹配（原 load() render 前的两段串行整体后移）。
     *  匹配（getBangumiMatch/bangumiSearch 兜底）→ bangumiInfo 两段串行完成后，
     *  经世代守卫核验仍属当前详情页，才把 _bgmId/_bgmInfo 写入共享状态并做 hero
     *  区局部替换（_applyDeferredBgm）。失败（匹配失败/详情失败）静默收场：CatVod
     *  版面已是完整可用形态，不 toast 不重渲染（与原「匹配失败不影响详情」口径一致）。 */
    async _deferredBgmMatch(gen, vod) {
        this._bgmDefer = { gen, vod }; // 进入「匹配中」：后补在途
        try {
            const name = vod.vod_name || this.vodName;
            let match = null;
            if (typeof Kazumi.getBangumiMatch === 'function') match = await Kazumi.getBangumiMatch(name);
            else if (Kazumi.bangumiSearch) {
                const bgmResults = await Kazumi.bangumiSearch(name);
                if (bgmResults && bgmResults.length && bgmResults[0].id) match = { id: bgmResults[0].id };
            }
            if (gen !== this._loadGen) return; // 匹配期间已切详情：丢弃，状态机停在这里由新 load 收口
            if (match && match.id) {
                const info = await Kazumi.bangumiInfo(match.id);
                if (gen !== this._loadGen) return; // 详情拉取期间已切详情：同样丢弃
                this._bgmId = match.id;
                // bangumiInfo 失败（内部 catch → null）不写 _bgmId：与原同步链一致——
                // _bgmId 有值而 _bgmInfo=null 的混合态在原实现里只在「详情拉取失败」
                // 出现且由 render 回退兜底；后补路径更保守：无有效数据不进局部替换。
                if (info) {
                    this._bgmInfo = info;
                    if (info.name_cn || info.name) {
                        // 仅当详情页标题仍是 CatVod 原名（无 Bangumi 中文名可展示）时
                        // 补齐 vodName——收藏/分享等下游以此为准，与原同步链口径一致
                        if (!this.vodName || this.vodName === (vod.vod_name || '')) {
                            this.vodName = info.name_cn || info.name;
                        }
                    }
                    this._applyDeferredBgm();
                } else {
                    this._bgmId = null;
                }
            }
        } catch (e) { /* Bangumi 匹配失败不影响详情（CatVod 版面已可用） */ }
        finally {
            // 仅当仍是本世代发起的后补时才收口「已结束」；期间又开了新详情（gen 失配）
            // 时 _bgmDefer 属于新详情的匹配流程，不得覆盖
            if (this._bgmDefer && this._bgmDefer.gen === gen) this._bgmDefer = null;
        }
    },

    /** A-30：Bangumi 数据到达后 hero 区局部替换（不改 render() 主体）。
     *  只替换受影响区块——hero 根容器的 Bangumi/CatVod class、kicker、标题、
     *  meta 行、统计区（评分/排名/收藏人数）、操作行（Bangumi 收藏/评分行 +
     *  本地收藏并排）——页签栏/页签内容/进度行不重建，用户滚动与交互状态零扰动。
     *  局部替换后执行与 render() hasBgm 分支逐项等价的回填动作（清单见方法尾部注释）。 */
    _applyDeferredBgm() {
        const bgm = this._bgmInfo;
        if (!bgm || !bgm.id || !this._vod) return;
        const $hero = $('#detail-body .detail-hero');
        if (!$hero.length) return; // 页面已被整页 render 重绘（含 hero）或处于异常态：不动
        const $info = $hero.find('.detail-hero-info');
        if (!$info.length) return;
        // hero 根 class 切换（detail-hero-bangumi ↔ detail-hero-catvod）：CSS 背景与
        // 布局口径随 class 走，与整页 render 的 hasBgm 分支产出一致
        $hero.removeClass('detail-hero-catvod').addClass('detail-hero-bangumi');
        $info.find('.detail-kicker').html('BANGUMI 详情');
        const name = bgm.name_cn || bgm.name || (this._vod && this._vod.vod_name) || this.vodName;
        const origName = (name !== bgm.name && bgm.name) ? bgm.name : '';
        $info.find('.detail-title').html(`${escHtml(name)}${origName ? `<span class="detail-title-orig">${escHtml(origName)}</span>` : ''}`);
        // meta 行 + 统计区 + 操作行：与 render() hasBgm=true 产出同模板（复用同批渲染函数）
        const airWeek = this._airWeekday(bgm.date || bgm.air_date);
        const epState = this._episodesState(bgm);
        const meta = [
            bgm.date || bgm.air_date
                ? escHtml(`放送 ${bgm.date || bgm.air_date}${airWeek ? ` ${airWeek}` : ''}${epState ? ` · ${epState.eps}话` : ''}`)
                    + (epState && epState.finished ? ' <span class="detail-eps-finished">已完结</span>' : '')
                : '',
            bgm.platform ? escHtml(bgm.platform) : '',
            bgm.type_name ? escHtml(bgm.type_name) : '',
        ].filter(Boolean).join(' · ');
        // A-34：此处 bgm 已到手，meta 为空即真无数据，用「暂无」而非「加载中」
        $info.find('.detail-meta').html(meta || '暂无更多信息');
        $info.find('.detail-catvod-facts').replaceWith(this._bangumiStatsHtml(bgm));
        const $progress = $('#detail-body .detail-local-progress');
        if ($progress.length) $progress.remove(); // 本地进度行随统计区迁移（hasBgm 版面无本行）
        const localFrag = this._localColHtml();
        const bgmColHtml = this._bangumiColHtml(bgm);
        const heroActions = bgmColHtml
            ? bgmColHtml + (localFrag
                ? `<div class="kazumi-watch-row detail-watch-row-plain">${localFrag}${this._catvodWebBtnHtml()}</div>`
                : '')
            : localFrag ? `<div class="kazumi-watch-row detail-watch-row-plain">${localFrag}${this._catvodWebBtnHtml()}</div>` : '';
        $info.find('.detail-hero-actions').html(heroActions);
        // —— 与 render() hasBgm=true 分支逐项等价回填清单 ——
        // 1) 本地收藏态回填（操作行含 _localColHtml 单按钮，需对齐本地收藏缓存）
        this._refreshLocalCol();
        // 2) Bangumi 收藏高亮缓存回填 + 按需 force 对账（A-28 共享入口，与 render 同口径）
        if (typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
            Kazumi._applyBangumiColState(this._bgmId);
            this._reconcileBangumiCol();
        }
        // 3) 后台加载 Bangumi 补充数据（吐槽/角色/制作/关联页签数据源）
        this._loadBgmExtra();
        // 4) 当前激活页签是「概览」时刷新页签内容：_renderOverview 读 _bgmInfo 产出
        //    Bangumi 简介/标签；其余页签（分集等）CatVod 数据未变不重绘，切页签时
        //    各渲染器实时读状态自然对齐（不在这里整页 _renderTabContent，保滚动）
        if (this._activeTab === '概览') this._renderOverview();
    },

    /** 本地收藏按钮（CatVod 源）：与 Bangumi 收藏单按钮同款交互——按钮内含状态图标 +
     *  当前状态文案，点击弹出六态列表，选中即写本地收藏并收起。
     *  资源片段模式（只渲染按钮本体，不含行容器）：纯 CatVod 详情时由
     *  _catvodStartHtml 并入操作行；匹配 Bangumi 时 render() 补包一层行容器。
     *  按钮用独立 id #detail-local-col-current，避免与 Bangumi 收藏按钮
     *  #detail-col-current 的委托/高亮（kazumi.js _applyBangumiColState）互相干扰。 */
    _localColHtml() {
        return `<span class="detail-col-wrap detail-local-col-wrap">
            <button type="button" id="detail-local-col-current" class="md-btn md-btn-sm kazumi-col-btn" title="选择本地收藏状态">
                ${detailColStateIcon('')}<span class="detail-col-label">未收藏</span>
            </button>
            <div class="detail-col-menu detail-local-col-menu" style="display:none;">
                <div class="kazumi-col-btns detail-local-col-btns">
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="">${detailColStateIcon('')}未收藏</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="want">${detailColStateIcon('want')}想看</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="watching">${detailColStateIcon('watching')}在看</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="seen">${detailColStateIcon('seen')}看过</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="hold">${detailColStateIcon('hold')}搁置</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="dropped">${detailColStateIcon('dropped')}抛弃</button>
                </div>
            </div>
        </span>`;
    },

    /** Bangumi 评分摘要：评分、星级、排名、1-10 分人数分布 + 收藏人数共用一组 hero 指标。
     *  （话数/完结已并入头部放送行，不在统计区重复展示。） */
    _bangumiStatsHtml(bgm) {
        const rating = (bgm && bgm.rating) || {};
        const score = Number(rating.score) || 0;
        const votes = Number(rating.total) || 0;
        const rank = Number(rating.rank) || 0;
        const stars = score
            ? `<span class="bi-stars" aria-label="${escHtml(String(score))} 分（满分 10 分）"><span class="bi-stars-bg">★★★★★</span><span class="bi-stars-fill" style="width:${Math.round(Math.max(0, Math.min(10, score)) * 10)}%">★★★★★</span></span>`
            : '<span class="detail-score-empty">暂无评分</span>';
        // 收藏人数（Bangumi collection 统计：想看/在看/看过）
        const col = (bgm && bgm.collection) || {};
        const fmt = (n) => escHtml(Number(n || 0).toLocaleString('zh-CN'));
        const colHtml = (col.wish || col.doing || col.collect)
            ? `<div class="detail-stat-collections">
                ${col.wish ? `<span class="detail-col-item" title="想看人数">⭐ 想看 ${fmt(col.wish)}</span>` : ''}
                ${col.doing ? `<span class="detail-col-item" title="在看人数">▶ 在看 ${fmt(col.doing)}</span>` : ''}
                ${col.collect ? `<span class="detail-col-item" title="看过人数">✓ 看过 ${fmt(col.collect)}</span>` : ''}
            </div>`
            : '';
        const count = rating.count;
        let histogram = '';
        if (count && typeof count === 'object') {
            const values = [];
            for (let i = 1; i <= 10; i++) values.push(Number(count[i] || count[String(i)] || 0));
            if (values.some((v) => v > 0)) {
                const max = Math.max(1, ...values);
                histogram = `<div class="bi-hist" title="评分分布（1-10 分人数）" aria-label="评分分布">${values.map((value, i) =>
                    `<div class="bi-hist-col"><div class="bi-hist-bar" style="height:${Math.max(4, Math.round(value / max * 100))}%" title="${i + 1} 分：${value} 人"></div><span class="bi-hist-lb">${i + 1}</span></div>`
                ).join('')}</div>`;
            }
        }
        return `<div class="detail-bgm-stats">
            <div class="detail-stat-score">
                <span class="detail-stat-label">评分</span>
                <div class="detail-stat-score-line"><strong>${score ? escHtml(String(score)) : '—'}</strong>${stars}</div>
                <span class="detail-stat-note">${votes ? `${escHtml(votes.toLocaleString('zh-CN'))} 人评分` : '暂无评分人数'}</span>
            </div>
            <div class="detail-stat-rank"><span class="detail-stat-label">Bangumi 排名</span><strong>${rank ? `#${escHtml(String(rank))}` : '—'}</strong>${rank ? '' : '<span class="detail-stat-note">暂无排名</span>'}</div>
            ${histogram}
            ${colHtml}
            ${this._watchProgressBarHtml()}
        </div>`;
    },

    /** 观看进度条行（方案 C）：细进度条 + 「看到第 N 话（集）/ 共 M 话（集）」。
     *  默认隐藏；回填逻辑（Bangumi 走 _applyBangumiColState、CatVod 走
     *  _refreshLocalProgress）查到进度后填条宽与文案并点亮。
     *  extraClass：附加定位 class（CatVod 场景传 detail-local-progress，
     *  挂在播放信息下方独立行；Bangumi 场景不传，挂统计区底部 grid-column:1/-1）。 */
    _watchProgressBarHtml(extraClass) {
        return `<div class="detail-watch-progress ${extraClass || ''}" style="display:none;">
            <div class="detail-watch-progress-track"><div class="detail-watch-progress-fill"></div></div>
            <span class="detail-watch-progress-text tip-line pad0"></span>
        </div>`;
    },

    /** Bangumi 操作行（统一详情页，T74/T80）。
     *  收藏单按钮（无独立容器）：按钮内含状态图标 + 当前状态文案，点击
     *  弹出六态列表供选择，选中即同步 Bangumi 并收起；按钮置于「开始观看」右侧。
     *  「评分 / 吐槽」（批注笔图标）恒在；「在 Bangumi 打开」转系统浏览器。
     *  观看进度行（看到第 N 话）由 _applyBangumiColState 回填。 */
    _bangumiColHtml(bgm) {
        if (!bgm || !bgm.id) return '';
        const hasRules = typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules();
        const startBtn = hasRules
            ? `<button type="button" id="detail-kazumi-start" class="md-btn md-btn-filled md-btn-sm"><span class="detail-button-mark">▶</span>开始观看</button>`
            : '';
        return `<div class="kazumi-watch-row detail-watch-row-plain">
            ${startBtn}
            <span class="detail-col-wrap">
                <button type="button" id="detail-col-current" class="md-btn md-btn-sm kazumi-col-btn" data-type="-1" title="选择 Bangumi 收藏状态">
                    ${detailColStateIcon('-1')}<span class="detail-col-label">未收藏</span>
                </button>
                <div class="detail-col-menu" style="display:none;">
                    <div class="kazumi-col-btns" data-id="${escHtml(bgm.id)}">
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="-1">${detailColStateIcon('-1')}未收藏</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="1">${detailColStateIcon(1)}想看</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="3">${detailColStateIcon(3)}在看</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="2">${detailColStateIcon(2)}看过</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="4">${detailColStateIcon(4)}搁置</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="5">${detailColStateIcon(5)}抛弃</button>
                    </div>
                </div>
            </span>
            <button type="button" id="detail-bgm-rate" class="md-btn md-btn-sm" title="评分 / 吐槽 / 标签（同步到 Bangumi）">${DETAIL_RATE_ICON_HTML}评分 / 吐槽</button>
            <button type="button" id="detail-bgm-open" class="md-btn md-btn-sm" title="在系统浏览器打开 Bangumi 条目页（跳转目标随设置「条目页跳转跟随镜像」）">↗ Bangumi 页</button>
        </div>`;
    },

    /** CatVod 详情页 hero 操作行（无 Bangumi 匹配时）：[▶ 开始播放][本地收藏][↗ 网页]。
     *  「开始播放」与 Kazumi 源「开始观看」同位置/同样式（#detail-kazumi-start
     *  的视觉口径），点击打开选源选集弹窗（T79，对齐 Bangumi「开始观看」引导范式）；
     *  「↗ 网页」与 Bangumi 行「↗ Bangumi 页」同位置，跳源站网页（_siteWebUrl）。
     *  开始播放仅在有可用线路/选集时渲染（无线路时概览已有「暂无播放线路」提示）；
     *  localFrag 为 _localColHtml 的收藏按钮片段（始终并入本行）。 */
    /** CatVod 操作行：[▶ 开始播放][本地收藏][↗ 网页]。
     *  pending（A-35）：详情结果未到、线路尚未解析时为 true —— 此时 sources 为空，
     *  旧逻辑按 `!hasPlay` 直接不渲染按钮，结果整行要等 detailContent 返回才出现，
     *  用户看到的是「先一串文字，过一会儿才长出播放按钮」的布局跳动。改为半渲染期
     *  渲染**禁用态按钮**（位置/尺寸与真实按钮一致），点击提示等待而非静默无反应；
     *  结果到达后的整页 render 由同一 DOM 位置替换成可用按钮，零布局跳动。
     *  为何是禁用而不是隐藏：占位按钮先占好位，数据到达时是「原地可用」，而非「凭
     *  空插入」——后者会把下方既有内容整体顶下去。 */
    _catvodStartHtml(localFrag, pending) {
        const frag = localFrag || '';
        const src = this.sources[this.activeSource];
        const hasPlay = !!(this.sources.length && src && src.episodes.length);
        const webBtn = this._catvodWebBtnHtml();
        if (!hasPlay && !frag && !webBtn && !pending) return '';
        return `<div class="kazumi-watch-row detail-watch-row-plain">
            ${hasPlay
        ? `<button type="button" id="detail-catvod-start" class="md-btn md-btn-filled md-btn-sm"><span class="detail-button-mark">▶</span>开始播放</button>`
        : (pending
            ? `<button type="button" id="detail-catvod-start" class="md-btn md-btn-filled md-btn-sm" aria-busy="true"><span class="detail-button-mark">▶</span>开始播放</button>`
            : '')}
            ${frag}
            ${webBtn}
        </div>`;
    },

    /** 「↗ 网页」按钮（CatVod 源详情）：与 Bangumi 行「↗ Bangumi 页」同位置/同样式。
     *  仅在 _siteWebUrl 推导得出源站首页时渲染（spider 类源返回空 → 无按钮）。 */
    _catvodWebBtnHtml() {
        return this._siteWebUrl()
            ? `<button type="button" id="detail-catvod-web" class="md-btn md-btn-sm" title="在系统浏览器打开源站网页">↗ 网页</button>`
            : '';
    },

    /** 当前 CatVod 源的网页首页地址：由站点 api URL 推导（scheme://host[:port]/）。
     *  cms/jar 类源的 api 部署在源站域名下，跳其首页即「源站网页」；spider 类
     *  （js/py）api 可能只是资源地址，推导不出 http(s) 首页时返回空串（不渲染按钮）。
     *  仅拼 scheme+host，丢弃 path/query/credentials，URL 解析失败返回空串。 */
    _siteWebUrl() {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === this.site);
            const api = String((s && s.api) || '');
            if (!/^https?:\/\//i.test(api)) return '';
            const u = new URL(api);
            return `${u.protocol}//${u.host}/`;
        } catch (e) { return ''; }
    },

    /** 「开始播放」点击行为（T79）：打开「线路+集数」单页弹窗——线路与集数同屏，
     *  默认选中当前（lastSourceMap 记忆/第 0 条）线路，点任一集即起播并关窗。
     *  与 Bangumi「开始观看」→ openSourceDialog 的引导范式对齐；区别在于 catvod
     *  详情加载时线路与全集已同步在手（vod_play_from/vod_play_url），无需搜索步骤，
     *  因此单屏即可完成选择。弹窗内点线路只切弹窗内集数展示（activeSource 同步 +
     *  _saveLastSource 记忆），不动「分集」页签的 DOM；起播仍统一走 _playEpisode
     *  （Player.play 的队列/外部主播放器/失败换线路等行为对弹窗入口同样生效）。 */
    _catvodStartPlay() {
        const src = this.sources[this.activeSource];
        if (!this.sources.length || !src || !src.episodes.length) {
            // A-35：半渲染期（详情结果在途）点击占位按钮 → 明确告知在等待，而非
            // 复用「暂无可播放线路」这个会被随后到达的数据推翻的误报
            if (this._detailDataPending) {
                warnToast('正在加载线路信息，请稍候…');
                return;
            }
            warnToast('暂无可播放的线路或选集');
            return;
        }
        this._openCatvodPlayDialog();
    },

    /** 渲染并打开 CatVod 选源选集弹窗。 */
    _openCatvodPlayDialog() {
        const body = $('#catvod-play-dialog-body');
        if (!body.length) return;
        const cur = this.activeSource;
        const src = this.sources[cur];
        if (!src) return;
        $('#catvod-play-dialog-title').text(`选择线路与集数 · ${this.vodName || ''}`);
        // 线路按钮组：复用「分集」页签的 .play-src 视觉口径；弹窗内独立 data 域
        // （.catvod-play-src）避免与页签里的 .play-src 委托互相干扰。
        const srcBtns = this.sources.map((s, i) =>
            `<button type="button" class="play-src catvod-play-src ${i === cur ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} <span class="play-src-count">${s.episodes.length}</span></button>`).join('');
        // 集数网格：复用 .ep-btn 视觉口径（不含下载/勾选——弹窗只做选集起播），
        // 按 _epDesc 记忆的顺序展示，与「分集」页签口径一致。
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        const epBtns = order.map((i) => {
            const ep = src.episodes[i];
            return `<button type="button" class="ep-btn catvod-ep-btn" data-idx="${i}" title="${epBtnTitle(ep, i)}"><span class="ep-name">${escHtml(ep.name)}</span></button>`;
        }).join('');
        body.html(`<div class="catvod-play-sheet">
            <div class="detail-source-label">线路</div>
            <div class="play-srcs">${srcBtns}</div>
            <div class="detail-source-label">集数</div>
            <div class="ep-grid catvod-play-eps">${epBtns}</div>
        </div>`);
        openDialog('catvodPlayDialog');
    },

    /** 弹窗内点线路：切弹窗集数展示并同步 activeSource + 记忆（lastSourceMap），
     *  不触碰「分集」页签 DOM（该页签下次渲染时按 activeSource 自然对齐）。 */
    _catvodDialogSelectSource(idx) {
        if (idx < 0 || idx >= this.sources.length || idx === this.activeSource) return;
        // A-19 勾选一致性：弹窗换线路同样改变 activeSource，页签残留勾选会错指
        // 新线路的集（同 selectSource 注释）；这里静默清空并把多选态复位——弹窗
        // 路径不抢 toast（页签下次渲染自然干净），只保证「界面勾选 = 可操作快照」
        $('#detail-tab-content .ep-check').removeClass('checked');
        if (this._epSelectMode) {
            this._epSelectMode = false;
            $('#detail-tab-content .ep-dl-bar').addClass('ep-dl-bar-hidden');
            $('#detail-tab-content #ep-list').removeClass('selecting');
            $('#ep-multi').text('多选');
            $('#ep-check-all').prop('checked', false);
            this._syncDlBar();
        }
        this.activeSource = idx;
        $('#catvod-play-dialog-body .catvod-play-src').removeClass('active');
        $(`#catvod-play-dialog-body .catvod-play-src[data-idx="${idx}"]`).addClass('active');
        // 换线路重渲染弹窗集数网格（每条线路的集名/集数独立）
        const src = this.sources[idx];
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        const epBtns = order.map((i) => {
            const ep = src.episodes[i];
            return `<button type="button" class="ep-btn catvod-ep-btn" data-idx="${i}" title="${epBtnTitle(ep, i)}"><span class="ep-name">${escHtml(ep.name)}</span></button>`;
        }).join('');
        $('#catvod-play-dialog-body .catvod-play-eps').html(epBtns);
        // A-18 换线路交叉淡入：弹窗内集数网格整段重绘后同样重触发纯 opacity
        // 淡入（epGridIn），与「分集」页签换线路同一过渡口径；CSS 端门控
        const dlgGrid = $('#catvod-play-dialog-body .catvod-play-eps')[0];
        if (dlgGrid) replayClass(dlgGrid, 'ep-grid-in');
        this._saveLastSource();
    },

    _renderTabContent() {
        this._unbindCommentPageScroll(); // 离开吐槽页签时摘除页面滚动续拉监听
        if (this._activeTab === '概览') this._renderOverview();
        else if (this._activeTab === '分集') this._renderEpisodes();
        else if (this._activeTab === '角色') this._renderCharacters();
        else if (this._activeTab === '制作') this._renderStaff();
        else if (this._activeTab === '吐槽') this._renderComments();
        else if (this._activeTab === '选集讨论') this._renderEpComments();
        else if (this._activeTab === '关联') this._renderRelations();
    },

    _switchTab(tab) {
        if (tab === this._activeTab) return;
        this._activeTab = tab;
        $('#detail-body .detail-tab').removeClass('active').attr('aria-selected', 'false');
        $(`#detail-body .detail-tab[data-tab="${tab}"]`).addClass('active').attr('aria-selected', 'true');
        // 交换前先捕获吸顶区间状态：_swapTabContent 内的钳制可能中途改变滚动位，
        // 交换后再据捕获结果落位，避免落位被跳过
        const deep = this._isBelowTabsStick();
        this._swapTabContent(() => this._renderTabContent());
        // 吸顶状态下切页签：内容落到功能栏底边之下（含 24px 间距预留）。
        // 功能栏由 sticky 钉在原像素、上方被遮罩覆盖——唯一可见变化是栏下换装
        this._snapToTabsStick(deep);
    },

    /** A-22 键盘可达性共用判定：仅 Enter/Space 放行（激活语义）。放行时
     *  e.preventDefault()——Space 默认滚动页面必须拦下，Enter 无害但一并统一。
     *  返回 false 表示非激活键（含 Esc：不在此触碰，由 dispatchEsc 全局派发），
     *  调用方直接 return 忽略。 */
    _kbdActivate(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return false;
        e.preventDefault();
        return true;
    },

    /** 吸顶滚动位下限：哨兵布局顶 - 吸顶位。静态哨兵不受 sticky 粘性位移污染
     *  （已吸顶的元素自身 offsetTop 会包含位移，不可用）。-1 表示页签未挂载。 */
    _tabsStickFloor() {
        const sentinel = document.getElementById('detail-tabs-sentinel');
        return sentinel ? Math.max(0, sentinel.offsetTop - this._stickTop()) : -1;
    },

    /** 视口当前是否处于吸顶区间（切页签/数据到达前捕获，防中途钳制干扰）。 */
    _isBelowTabsStick() {
        const viewEl = document.getElementById('view-detail');
        const floor = this._tabsStickFloor();
        return !!(viewEl && floor >= 0 && viewEl.scrollTop >= floor);
    },

    /** 吸顶状态下让页签内容完整显示在功能栏之下（force=交换前已处于吸顶区间）。
     *  落位目标按渲染后的实测内容文档位反推：内容首行 = 吸顶位 + 功能栏实测
     *  高度 + 24px 间距预留——不依赖任何假定尺寸（功能栏高度/间距变化自校正），
     *  卡片不会被功能栏遮挡；结果与吸顶阈值取大以维持钉住态和遮罩覆盖。
     *  同步单帧赋值，无平滑动画即无中间位移。 */
    _snapToTabsStick(force) {
        const viewEl = document.getElementById('view-detail');
        const bar = viewEl && viewEl.querySelector('.detail-tabs');
        const contentEl = document.getElementById('detail-tab-content');
        if (!viewEl || !bar || !contentEl || !contentEl.isConnected) return;
        const floor = this._tabsStickFloor();
        if (!force && !(floor >= 0 && viewEl.scrollTop >= floor)) return;
        const contentDocY = contentEl.getBoundingClientRect().top
            - viewEl.getBoundingClientRect().top + viewEl.scrollTop;
        const target = Math.max(floor,
            contentDocY - (this._stickTop() + bar.offsetHeight + 24));
        const max = viewEl.scrollHeight - viewEl.clientHeight;
        viewEl.scrollTop = Math.max(0, Math.min(target, max));
    },

    /** 同步收敛滚动越界。innerHTML 替换后内容变矮时 Chromium 要到下一次布局才
     *  钳制 scrollTop，表现为先画一帧越界内容再跳回——页签「画面抖动」的来源之一。
     *  在同一帧内显式钳制即可消除该跳变（配合 #view-detail 的 overflow-anchor:none，
     *  滚动位置只由这里决定，避免浏览器锚定与高度过渡叠加二次位移）。
     *  A-25：_restore 回写 scrollTop 后同样立即调用——恢复页内容可能比离开时
     *  更矮（快照 scrollTop 越界），同帧钳到合法区间。 */
    _clampDetailScroll() {
        const viewEl = document.getElementById('view-detail');
        if (!viewEl) return;
        const max = viewEl.scrollHeight - viewEl.clientHeight;
        if (viewEl.scrollTop > max) viewEl.scrollTop = Math.max(0, max);
    },

    /** 页签内容交换：同步替换 + 滚动越界钳制 + 新内容轻量淡入。
     *  刻意不做高度补间——高度过渡会让页面其余板块随内容伸缩而位移（违背
     *  「点页签板块位置不变」），且毛玻璃下带 backdrop-filter 的卡片被逐帧
     *  改尺寸会反复重建模糊采样层，表现为撕裂闪烁（同 T54 成因）。
     *  动画仅保留新内容自身的淡入上浮（CSS 端按非毛玻璃门控）。 */
    _swapTabContent(renderFn) {
        renderFn(); // 各页签渲染器同步写 DOM
        this._clampDetailScroll();
        const box = document.getElementById('detail-tab-content');
        if (!box || !box.isConnected) return;
        replayClass(box, 'tab-enter'); // 移除→强制 reflow→重挂（A-04 收口，原三段式内联）
    },

    _renderOverview() {
        const vod = this._vod;
        const bgm = this._bgmInfo;
        let html = '';
        // 简介（可收起）：默认收起三行（-webkit-line-clamp），点「展开全部」看全文；
        // 超三行简介显示切换按钮，极短简介（≤三行）不出按钮。
        const descText = bgm ? stripHtml(bgm.summary || '') : stripHtml((vod && vod.vod_content) || '');
        if (descText) {
            const overThreeLines = descText.length > 90; // 14px/24px 行高三行约 90 字
            const collapsed = overThreeLines && this._descCollapsed;
            html += `<section class="detail-overview-card detail-desc-wrap">
                <div class="detail-section-heading">简介</div>
                <div class="detail-desc ${collapsed ? 'collapsed' : ''}">${escHtml(descText)}</div>
                ${overThreeLines ? `<button type="button" id="detail-desc-toggle" class="md-btn md-btn-sm md-btn-tonal detail-desc-toggle">${collapsed ? '展开全部' : '收起'}</button>` : ''}
            </section>`;
        }
        // Bangumi 标签（含用户标记数量 t.count，仿 Kazumi ActionChip：标签名 + 主色数量）。
        // 默认全部展示（与简介同策略：默认分辨率下完整可见）；仅超长列表（>40 个）
        // 折叠到「收起」，标签点击筛选委托不受影响。
        if (bgm && Array.isArray(bgm.tags) && bgm.tags.length) {
            const overLong = bgm.tags.length > 40;
            const shown = (overLong && !this._tagsExpanded) ? bgm.tags.slice(0, 40) : bgm.tags;
            const chips = shown.map((t) => {
                if (t && typeof t === 'object') {
                    const tn = t.name || '';
                    const cnt = (t.count != null) ? Number(t.count) : 0;
                    if (!tn) return '';
                    return `<span class="kazumi-tag" data-tag="${escHtml(tn)}" tabindex="0" title="共 ${cnt} 人标记">${escHtml(tn)} <span class="kazumi-tag-count">${cnt}</span></span>`;
                }
                const tn = String(t || '');
                return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}" tabindex="0">${escHtml(tn)}</span>` : '';
            }).filter(Boolean).join('');
            if (chips) {
                let toggleBtn = '';
                if (overLong) {
                    toggleBtn = `<button type="button" id="detail-tags-toggle" class="kazumi-tags-toggle">${this._tagsExpanded ? '收起' : `展开全部（${bgm.tags.length - 40}）`}</button>`;
                }
                html += `<section class="detail-overview-card bangumi-info-tags"><div class="detail-section-heading">标签</div><div class="kazumi-tags-wrap">${chips}${toggleBtn}</div></section>`;
            }
        }
        if (!html) html = '<div class="detail-empty-state">暂无概览信息</div>';
        $('#detail-tab-content').html(`<div class="detail-overview-grid">${html}</div>`);
    },

    /** CatVod 线路/选集与 Bangumi-only 分集统一放在「分集」页签，避免概览区堆满播放控件。 */
    _renderEpisodes() {
        let html = '';
        if (!this.sources.length) {
            if (this._bgmId && this._bgmInfo) {
                html += `<section class="detail-episodes-panel detail-bgm-episodes-panel">
                    <div class="detail-section-head"><div><div class="detail-section-kicker">Bangumi 分集</div><h2 class="detail-section-title">选择集数</h2></div>
                        <span class="detail-head-actions">
                            <button type="button" id="bgm-ep-order" class="md-btn md-btn-tonal md-btn-sm">${this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                            <button type="button" id="bgm-ep-multi" class="md-btn md-btn-tonal md-btn-sm">多选</button>
                        </span></div>
                    <div class="ep-dl-bar ${this._bgmSelectMode ? '' : 'ep-dl-bar-hidden'}">
                        <label class="ep-dl-check-all"><input type="checkbox" id="bgm-ep-check-all">全选</label>
                        <span class="dl-spacer"></span>
                        <span class="ep-dl-count" id="bgm-ep-dl-count"></span>
                        <button type="button" id="bgm-ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
                        <button type="button" id="bgm-ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
                    </div>
                    <div id="bgm-ep-list" class="ep-grid kazumi-episode-grid ${this._bgmSelectMode ? 'selecting' : ''}"></div>
                </section>`;
                $('#detail-tab-content').html(html);
                $('#bgm-ep-multi').on('click', () => {
                    this._bgmSelectMode = !this._bgmSelectMode;
                    $('#bgm-ep-multi').text(this._bgmSelectMode ? '退出多选' : '多选');
                    $('#detail-tab-content .ep-dl-bar').toggleClass('ep-dl-bar-hidden', !this._bgmSelectMode);
                    $('#bgm-ep-list').toggleClass('selecting', this._bgmSelectMode);
                    if (!this._bgmSelectMode) { $('#bgm-ep-list .ep-check').removeClass('checked'); $('#bgm-ep-check-all').prop('checked', false); this._syncBgmDlBar(); }
                });
                $('#bgm-ep-order').on('click', () => {
                    this._bgmEpDesc = !this._bgmEpDesc;
                    // 有缓存时仅按新顺序重排已渲染节点（append 已有节点 = 移动位置），
                    // 不重新请求网络、不重建 DOM，避免切换顺序时闪烁；
                    // 无缓存（首次/数据未加载）才走完整渲染。
                    if (this._bgmEps && this._bgmEps.length) this._reorderBgmEpisodes();
                    else this._renderBgmEpisodes();
                });
                $('#bgm-ep-check-all').on('change', (e) => {
                    $('#bgm-ep-list .ep-check').toggleClass('checked', e.currentTarget.checked);
                    this._syncBgmDlBar();
                });
                $('#bgm-ep-play-selected').on('click', () => this._playBgmSelected());
                $('#bgm-ep-dl-selected').on('click', () => this._downloadBgmSelected());
                this._renderBgmEpisodes();
                return;
            }
            html = '<div class="detail-empty-state">该视频暂无播放源</div>';
            if (typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules()) {
                html += `<div class="kazumi-entry"><span>没有想看的源？</span><button type="button" id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button></div>`;
            }
            $('#detail-tab-content').html(html);
            return;
        }

        html += `<section class="detail-episodes-panel">
            <div class="detail-section-head"><div><div class="detail-section-kicker">CatVod 播放源</div><h2 class="detail-section-title">线路与选集</h2></div>
                <span class="detail-head-actions">
                    <button type="button" id="ep-order" class="md-btn md-btn-tonal md-btn-sm">${this._epDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                    <button type="button" id="ep-multi" class="md-btn md-btn-tonal md-btn-sm">多选</button>
                </span></div>
            <div class="detail-source-label">线路</div>
            <div class="play-srcs">${this.sources.map((s, i) =>
                `<button type="button" class="play-src ${i === this.activeSource ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} <span class="play-src-count">${s.episodes.length}</span></button>`).join('')}</div>
            ${typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules() ? `<div class="kazumi-entry"><span>没有想看的源？</span><button type="button" id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button></div>` : ''}
            <div class="ep-dl-bar ${this._epSelectMode ? '' : 'ep-dl-bar-hidden'}">
                <label class="ep-dl-check-all"><input type="checkbox" id="ep-check-all">全选</label>
                <span class="dl-spacer"></span>
                <span class="ep-dl-count" id="ep-dl-count"></span>
                <button type="button" id="ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
                <button type="button" id="ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
            </div>
            <div id="ep-list" class="ep-grid ${this._epSelectMode ? 'selecting' : ''}"></div>
        </section>`;
        $('#detail-tab-content').html(html);
        $('#ep-multi').on('click', () => {
            this._epSelectMode = !this._epSelectMode;
            $('#ep-multi').text(this._epSelectMode ? '退出多选' : '多选');
            $('#detail-tab-content .ep-dl-bar').toggleClass('ep-dl-bar-hidden', !this._epSelectMode);
            $('#ep-list').toggleClass('selecting', this._epSelectMode);
            if (!this._epSelectMode) { $('#ep-list .ep-check').removeClass('checked'); $('#ep-check-all').prop('checked', false); this._syncDlBar(); }
        });
        this.renderEpisodes();
    },

    /** Bangumi 分集切换顺序：复用已渲染的 .bgm-ep-item 节点按新顺序重排，不重建 DOM。 */
    _reorderBgmEpisodes() {
        const box = $('#bgm-ep-list');
        if (!box.length || !Array.isArray(this._bgmEps)) return;
        $('#bgm-ep-order').text(this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序');
        const byIdx = {};
        box.children('.bgm-ep-item').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!Number.isNaN(idx)) byIdx[idx] = this;
        });
        // 节点数与缓存不一致（如数据刷新/切换源后残留）→ 回退完整渲染，避免错位
        if (Object.keys(byIdx).length !== this._bgmEps.length) {
            this._renderBgmEpisodes();
            return;
        }
        let view = this._bgmEps.map((ep, i) => ({ ep, i }));
        if (this._bgmEpDesc) view.reverse();
        view.forEach(({ i }) => {
            const el = byIdx[i];
            if (el) box.append(el); // append 已有节点 = 移动到末尾，按新顺序排列
        });
        this._syncBgmDlBar();
    },

    /** 渲染 Bangumi 分集（统一详情页）：勾选框多选（样式对齐非 Kazumi 详情页），点击集打开选源播放/下载。 */
    async _renderBgmEpisodes() {
        const box = $('#bgm-ep-list');
        if (!box.length || !this._bgmId || typeof Kazumi === 'undefined') return;
        $('#bgm-ep-order').text(this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序');
        box.html(_detailSkeleton('episode', { count: 8 }, '载入中…')); // A-02：bgm 分集骨架（骨架高度匹配：episode 集格形态对齐真实 44px 行格网格，旧 card 形态差数倍高度致跳位）
        const gen = ++this._bgmEpGen; // 审查2.3：分集加载独立世代（不能复用 _bgmExtraGen——同番剧吐槽提交后的 3 秒重拉会自增它，借用会误杀在途分集请求，口径同 _ensureBgmEpisodes 的 sid 快照注释）；每次重入（含「切正序」重入）自增，作废同世代双飞里的旧慢请求
        try {
            const data = await Kazumi.bangumiEpisodes(this._bgmId);
            if (gen !== this._bgmEpGen) return; // 已重入/已换片：旧响应丢弃（防慢请求覆盖先到渲染的网格）
            let list = ((data && data.data) || []).slice();
            // 记录集序号（供下载按 sort 定位），倒序仅影响展示
            this._bgmEps = list;
            let view = list.map((ep, i) => ({ ep, i }));
            if (this._bgmEpDesc) view.reverse();
            box.html(view.length
                ? view.map(({ ep, i }) => {
                    const no = ep.sort || ep.ep || (i + 1);
                    const nm = ep.name_cn || ep.name || '';
                    const type = Number(ep.type) === 1 ? 'SP' : Number(ep.type) === 2 ? 'OP' : Number(ep.type) === 3 ? 'ED' : '';
                    return `<div class="kazumi-detail-ep bgm-ep-item" data-idx="${i}" tabindex="0">
                        <span class="ep-check" data-idx="${i}" title="勾选后可批量下载"></span>
                        <span class="kazumi-detail-ep-no">${escHtml(String(no))}</span>
                        <span class="kazumi-detail-ep-name">${escHtml(nm)}</span>
                        ${type ? `<span class="kazumi-detail-ep-type">${escHtml(type)}</span>` : ''}
                    </div>`;
                }).join('')
                : '<div class="tip-line">暂无分集信息</div>');
            // 分集异步回填使页签内容增高：同步钳制滚动，避免视口深处越界晚钳制跳动
            this._clampDetailScroll();
            // 勾选框：阻止冒泡，仅切换选中；点击集主体则打开选源播放
            box.find('.ep-check').on('click', (e) => {
                e.stopPropagation();
                $(e.currentTarget).toggleClass('checked');
                this._syncBgmDlBar();
            });
            box.find('.bgm-ep-item').on('click', (e) => {
                if ($(e.target).hasClass('ep-check')) return;
                const title = this.vodName || '';
                if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(title, 'kazumi', '');
                }
            });
            $('#bgm-ep-check-all').prop('checked', false);
            this._syncBgmDlBar();
        } catch (e) {
            // 审查2.3：reject 分支先比世代再比 isConnected。跨片切换时 box 已随
            // render 整体重建脱附文档（写它无害但无意义）；同世代双飞竞态下晚到
            // 的 reject 会覆盖先到的成功网格——世代不一致直接丢弃，一致且已脱附
            // 也不再渲染（重入自会新建节点）。
            if (gen !== this._bgmEpGen) return; // 重入/换片后的旧响应：直接丢弃
            if (box.length && box[0] && box[0].isConnected === false) return; // 节点已随 render 重建脱附：不写不可见节点
            // A-03：分集失败不再只是死提示——补重试入口，重入 _renderBgmEpisodes
            // 重拉分集（世代守卫复用 _bgmEpGen，旧响应按重入/换片作废）
            box.html(`<div class="tip-line">分集载入失败</div>`
                + `<div class="tip-line" style="padding-top:0"><button type="button" id="bgm-ep-retry" class="md-btn md-btn-tonal md-btn-sm">重试</button></div>`);
            $('#bgm-ep-retry').on('click', () => this._renderBgmEpisodes());
        }
    },

    _syncBgmDlBar() {
        const n = $('#bgm-ep-list .ep-check.checked').length;
        $('#bgm-ep-dl-count').text(n ? `已勾选 ${n} 集` : '');
        $('#bgm-ep-dl-selected').text(n ? `⬇ 下载勾选集（${n}）` : '⬇ 下载勾选集');
        $('#bgm-ep-play-selected').text(n ? `▶ 播放勾选集（${n}）` : '▶ 播放勾选集');
    },

    /** Bangumi 分集播放勾选集：Bangumi-only 无直链，打开 Kazumi 选源弹窗选源播放。 */
    _playBgmSelected() {
        const idxs = $('#bgm-ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要播放的集'); return; }
        const title = this.vodName || '';
        if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
            // 携带勾选下标：选源弹窗内选定源+线路后，播放器队列只包含勾选的子集
            Kazumi.openSourceDialog(title, 'kazumi', '', { playIndexes: idxs });
            warnToast(`选择 Kazumi 源与线路后将播放勾选的 ${idxs.length} 集`);
        }
    },

    /** Bangumi 分集多选下载：打开 Kazumi 选源弹窗，从选中源下载勾选集（弹窗内多选源+集完成实际下载）。 */
    async _downloadBgmSelected() {
        const idxs = $('#bgm-ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要下载的集'); return; }
        const title = this.vodName || '';
        if (!title || typeof Kazumi === 'undefined' || !Kazumi.openSourceDialog) { warnToast('无法打开选源'); return; }
        // Bangumi-only 无直链，需先从 Kazumi 源解析：打开选源弹窗并带上「下载模式 + 目标集下标」，
        // 用户选定源+线路后由弹窗按下标批量解析下载（kazumi.js 处理）。用 0 基下标定位线路对应集，
        // 比按集号文本匹配更可靠（修复只下载一集的 bug）。
        const eps = idxs.map((i) => this._bgmEps[i]).filter(Boolean);
        const epNos = eps.map((ep, k) => ep.sort || ep.ep || (idxs[k] + 1));
        Kazumi.openSourceDialog(title, 'kazumi', '', { downloadEpisodes: epNos, downloadIndexes: idxs, downloadTitle: title });
        warnToast(`选择 Kazumi 源与线路后将下载勾选的 ${idxs.length} 集`);
    },

    /** 吐槽计数文案：优先真实总数（next.bgm total，一次给出，与分页无关）；
     *  未知（旧后端/失败/裸数组回退）时回退「已加载数 + 未全载时 + 号」的旧口径。
     *  已加载 >= 真实总数时不再显示「+」（全部在屏）。 */
    _commentCountText() {
        const loaded = this._comments.length;
        const total = Number(this._commentTotal) || 0;
        if (total > 0) return `共 ${total} 条`;
        return `共 ${loaded} 条${this._commentAllLoaded ? '' : '+'}`;
    },

    _renderComments(append) {
        // 页签落点守卫：续拉响应返回时用户可能已切到其他页签（制作/角色/关联等），
        // 此时绝不能把评论写进内容区——否则会整块覆盖该页签的卡片（表现为卡片
        // 「画面割裂」成评论列表，回顶/快速滚动时在途请求落地尤易复现）。
        // 数据已并入 _comments，下次进入吐槽页签自然完整渲染。
        if (this._activeTab !== '吐槽') return;
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html(_detailSkeleton('comment', { count: 4, header: true }, '加载中…')); return; } // A-02：吐槽页签骨架（骨架高度匹配：header 垫计数胶囊+排序按钮工具条行，数据到达不再插入推挤）
        // A-03：吐槽路网络失败 ≠ 没有吐槽——渲染错误态 + 重试（乐观行追加场景
        // _bgmExtraFailed 已被重拉路径复位，此处只拦「首拉失败」）
        if (this._bgmExtraFailed && this._bgmExtraFailed.comments && !this._comments.length) {
            box.html(_detailRetryHtml('吐槽加载失败', 'id="detail-bgm-extra-retry"'));
            $('#detail-bgm-extra-retry').on('click', () => this._retryBgmExtra());
            return;
        }
        // 排序不依赖接口返回顺序（next.bgm 默认并非时间正序）：A-24 抽出
        // _commentSortedList（与排序切换的就地重排共用），语义不变。
        const list = this._commentSortedList();
        const keys = this._commentKeys(list);
        // 续拉增量分支：列表已在屏上时只插入新增行，不整表重绘。
        // 整表 box.html() 会重建全部头像 <img>（重新解码→闪烁）并造成滚动位置跳动。
        const listBox = append ? box.find('.detail-comment-list').first() : $();
        if (listBox.length && listBox.children('.detail-comment').length) {
            this._appendCommentRows(listBox[0], list, keys);
            box.find('.detail-comment-count')
                .text(this._commentCountText());
            this._updateCommentFooter(listBox[0]);
        } else {
            const rows = list.map((c, k) => Detail._commentRowHtml(c, keys[k])).join('');
            const foot = this._commentAllLoaded
                ? (this._comments.length ? '<div class="tip-line detail-comment-end">没有更多了</div>' : '')
                : '<div class="tip-line detail-comment-more">下拉加载更多…</div>';
            box.html(`<div class="detail-comment-toolbar">
                    <span class="detail-comment-count">${this._commentCountText()}</span>
                    <button type="button" id="detail-comment-order" class="md-btn md-btn-tonal md-btn-sm">${this._commentDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                </div>
                <div class="detail-comment-list">${rows || '<div class="tip-line">暂无吐槽</div>'}${foot}</div>`);
            // A-11：首屏前 N 条错峰入场（限量模式，N=STAGGER_MAX_IDX+1=8 封顶）；
            // 仅全量渲染分支布置——续拉增量行（_appendCommentRows）与排序切换
            // 就地重排（_reorderCommentRows）的行不带标记，不重播入场。
            staggerEnter(box.find('.detail-comment-list').first(), '.detail-comment', 8);
            $('#detail-comment-order').on('click', () => {
                this._commentDesc = !this._commentDesc;
                // A-24：排序切换不再整表重绘（旧实现 this._renderComments() 会
                // box.html() 重建全部行与头像 <img>，重新解码→闪烁 + 滚动位置跳动）。
                // 已渲染列表就地重排（节点复用，手法同 _appendCommentRows 的
                // data-key 增量渲染先例）；无已渲染列表时才走全量渲染分支。
                const cur = $('#detail-tab-content .detail-comment-list').first();
                if (cur.length && !this._reorderCommentRows(cur[0])) this._renderComments();
                else $('#detail-comment-order').text(this._commentDesc ? '⇅ 切正序' : '⇅ 切倒序');
            });
        }
        // 无内滚容器：与「制作」页签一致随详情页自然下延；滚动根（#view-detail）
        // 触底续拉（无条数上限）。每次渲染先解绑旧监听避免累积。
        this._unbindCommentPageScroll();
        const viewEl = document.getElementById('view-detail');
        if (viewEl && !this._commentAllLoaded) {
            this._onCommentPageScroll = () => {
                if (this._activeTab !== '吐槽') return;
                if (viewEl.scrollTop + viewEl.clientHeight >= viewEl.scrollHeight - 40) this._loadMoreComments();
            };
            viewEl.addEventListener('scroll', this._onCommentPageScroll);
        }
    },

    /** 吐槽列表排序（A-24 从 _renderComments 抽出）：按评论时间显式排序，
     *  false=正序（旧→新），true=倒序（新→旧）。排序纯前端（接口只管分页，
     *  无排序参数），排序切换不发请求；排序键共用 _commentTsMs。 */
    _commentSortedList() {
        return this._comments.slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0);
            const tb = Detail._commentTsMs(b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0);
            return this._commentDesc ? tb - ta : ta - tb;
        });
    },

    /**
     * 单条吐槽行 HTML（带 data-key 供增量更新做 DOM 复用）。
     * 从 _renderComments 抽出为纯函数：全量渲染与续拉增量插入共用同一模板。
     */
    _commentRowHtml(c, key) {
        const user = (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '';
        const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large))
            || c.avatar || '';
        const avatarBig = (c.user && c.user.avatar && (c.user.avatar.large || c.user.avatar.medium || c.user.avatar.small))
            || c.avatar || avatar;
        const text = c.comment || c.content || '';
        const ts = c.updatedAt || c.updated_at || c.createdAt || c.created_at || 0;
        const time = Detail._fmtCommentTimeFull(ts);
        const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
        const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
            const ru = (r.user && (r.user.nickname || r.user.username)) || r.username || r.nickname || '';
            const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large))
                || r.avatar || '';
            const raBig = (r.user && r.user.avatar && (r.user.avatar.large || r.user.avatar.medium || r.user.avatar.small))
                || r.avatar || ra;
            const rt = r.content || r.comment || '';
            const rts = r.createdAt || r.created_at || r.updatedAt || r.updated_at || 0;
            const rtime = Detail._fmtCommentTimeFull(rts);
            return `<div class="detail-comment-reply">
                    <div class="detail-comment-head">
                        ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" data-big="${escHtml(raBig)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                </div>`;
        }).join('')}</div>` : '';
        return `<div class="detail-comment"${key ? ` data-key="${escHtml(key)}"` : ''}>
                <div class="detail-comment-head">
                    ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" data-big="${escHtml(avatarBig)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                    <span class="detail-comment-user">${escHtml(user)}</span><span class="detail-comment-time">${escHtml(time)}</span>
                </div>
                <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                ${repliesHtml}
            </div>`;
    },

    /**
     * 吐槽稳定键：时间戳+用户+评分+正文长度+回复数。接口无评论 ID，用字段指纹代替；
     * 完全相同的重复条目按 _comments 原始顺序追加序号区分（与展示排序无关，跨渲染稳定）。
     * 返回与 list 对齐的 key 数组。
     */
    _commentKeys(list) {
        const base = (c) => [
            Detail._commentTsMs(c.updatedAt || c.updated_at || c.createdAt || c.created_at || 0),
            (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '',
            c.rate || 0,
            String(c.comment || c.content || '').length,
            Array.isArray(c.replies) ? c.replies.length : 0,
        ].join('|');
        const occ = new Map();
        const byObj = new Map();
        for (const c of this._comments) { // 原始数组顺序分配序号，不受当前排序方向影响
            const b = base(c);
            const n = (occ.get(b) || 0) + 1;
            occ.set(b, n);
            byObj.set(c, `${b}#${n}`);
        }
        return list.map((c) => byObj.get(c) || `${base(c)}#0`);
    },

    /**
     * 续拉增量插入：双指针把新排序结果合并进已渲染列表，只为新条目建节点，
     * 已有行（含头像）原样保留避免重载闪烁。旧列表是新列表的子集（数据只增不减）。
     */
    _appendCommentRows(container, list, keys) {
        const viewEl = document.getElementById('view-detail');
        // 锚点补偿避让：平滑回顶进行中、或视口已处首屏时跳过。
        // 回顶是用户明确的「去列表顶端」意图——正序模式下新续拉的更早评论本就属于顶端，
        // 此时应停在 scrollTop≈0 看新顶内容；若仍做锚点回拨会与回顶动画抢滚动条，造成画面割裂。
        const smoothToTop = !!(viewEl && viewEl._yukiSmoothTop);
        const nearTop = !!viewEl && viewEl.scrollTop <= viewEl.clientHeight;
        // 锚点：视口内第一可见行。若新行插在其上方，内容整体下移，事后按位移差回拨 scrollTop。
        let anchor = null;
        let anchorTop = 0;
        if (viewEl && !smoothToTop && !nearTop) {
            for (const el of container.querySelectorAll('.detail-comment')) {
                const r = el.getBoundingClientRect();
                if (r.bottom > 0) { anchor = el; anchorTop = r.top; break; }
            }
        }
        const existing = Array.from(container.querySelectorAll('.detail-comment'));
        const footEl = container.querySelector('.detail-comment-end, .detail-comment-more');
        const holder = document.createElement('div');
        let i = 0; // 指向尚未越过的旧行
        for (let k = 0; k < list.length; k++) {
            const key = keys[k];
            if (i < existing.length && existing[i].dataset.key === key) { i++; continue; }
            holder.innerHTML = Detail._commentRowHtml(list[k], key);
            const node = holder.firstElementChild;
            if (!node) continue;
            const ref = i < existing.length ? existing[i] : footEl; // 尾部提示行之前 / 列表末尾
            if (ref) container.insertBefore(node, ref); else container.appendChild(node);
            // 不推进 i：后续新条目仍可能排在同一旧行之前
        }
        // 滚动补偿：锚点行仍在文档中时，把它拉回原来的屏幕位置（上方插入场景）
        if (anchor && viewEl && anchor.isConnected) {
            const delta = anchor.getBoundingClientRect().top - anchorTop;
            if (Math.abs(delta) > 0.5) viewEl.scrollTop += delta;
        }
    },

    /** 原位更新列表尾部提示（下拉加载更多… ↔ 没更多了），不动已渲染的评论行。 */
    _updateCommentFooter(container) {
        const cur = container.querySelector('.detail-comment-end, .detail-comment-more');
        const want = this._commentAllLoaded
            ? (this._comments.length ? '<div class="tip-line detail-comment-end">没有更多了</div>' : '')
            : '<div class="tip-line detail-comment-more">下拉加载更多…</div>';
        if (!want) { if (cur) cur.remove(); return; }
        if (cur && cur.outerHTML === want) return;
        const holder = document.createElement('div');
        holder.innerHTML = want;
        const next = holder.firstElementChild;
        if (!next) return;
        if (cur) cur.replaceWith(next); else container.appendChild(next);
    },

    /** 解绑挂在详情页滚动根上的吐槽续拉监听（重渲染 / 切页签时调用）。 */
    _unbindCommentPageScroll() {
        const el = document.getElementById('view-detail');
        if (el && this._onCommentPageScroll) el.removeEventListener('scroll', this._onCommentPageScroll);
        this._onCommentPageScroll = null;
    },

    /**
     * A-24 吐槽排序切换就地重排：已渲染的 .detail-comment 行按新排序用
     * insertBefore/appendChild 移动节点，不重建。手法复用 _appendCommentRows 的
     * data-key 增量渲染先例（key 由 _commentKeys 按原始数组顺序分配，与展示排序
     * 无关、跨渲染稳定，可作节点身份依据）。节点复用天然保住 <img> 头像的已加载
     * 状态（不重新解码→不闪烁）与楼中楼（.detail-comment-replies 在行节点内部，
     * 随父节点整体移动，不拆散）。
     * @returns {boolean} true=已完成就地重排；false=无法就绪（如空表/键缺失），
     *          调用方回退整表渲染。
     */
    _reorderCommentRows(container) {
        const list = this._commentSortedList();
        if (!list.length) return false;
        const keys = this._commentKeys(list);
        const rows = Array.from(container.querySelectorAll('.detail-comment'));
        if (rows.length !== list.length) return false; // 分页未加载完≠坏数据：未渲染行不该被静默丢弃
        const byKey = new Map();
        for (const row of rows) {
            const key = row.dataset.key;
            // 同 key 重复行（理论不可能，防御）：身份映射不唯一则放弃就地重排
            if (!key || byKey.has(key)) return false;
            byKey.set(key, row);
        }
        // 移动 DOM（脱离再插入）会重启 CSS 动画：首屏错峰入场（A-11 stagger-in，
        // animation-delay 内 backwards 填充 opacity:0）若不摘除，排序切换时已可见
        // 的评论会先整批消失再按 45ms 步进重新淡入（M5 闪烁回归）。重排前统一摘除。
        for (const row of rows) {
            if (row.classList.contains('stagger-in')) {
                row.classList.remove('stagger-in');
                row.style.animationDelay = '';
            }
        }
        // 逐行归位：第 k 个位置放 keys[k] 的行。若目标行已在正确位置则跳过
        // （避免多余 DOM 移动），否则把它移动到前一行之后（或列表首位）。
        // 滚动锚定由浏览器对已定位节点的移动天然保持（节点未销毁重建）。
        let prev = null;
        for (let k = 0; k < list.length; k++) {
            const node = byKey.get(keys[k]);
            if (!node) return false; // 键不齐（异常态）：回退全量渲染
            if (node === prev || (prev ? node.previousElementSibling === prev : node === container.firstElementChild)) {
                prev = node;
                continue;
            }
            if (prev) prev.after(node);
            else container.insertBefore(node, container.firstElementChild);
            prev = node;
        }
        return true;
    },

    /** 渲染评论正文的 BBCode（Bangumi 吐槽为 BBCode 文本）。
     * 重点修复：[quote][b]某人[/b] ...[/quote] 是「回复某人」的引用块，
     * 原来仅 escHtml 直出会露出裸标签。此处先转义 HTML，再把常用 BBCode
     * 转成安全的行内标签；未知标签一律剥除以免残留。
     */
    _renderCommentBBCode(raw) {
        if (typeof raw !== 'string' || !raw) return '';
        let s = escHtml(raw);
        // 引用块（回复某人）：[quote]...[/quote] → 缩进引用样式；支持嵌套外层
        s = s.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi,
            (_m, inner) => `<span class="detail-comment-quote">${inner}</span>`);
        // 基础样式标签
        s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>');
        s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>');
        s = s.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>');
        s = s.replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>');
        s = s.replace(/\[mask\]([\s\S]*?)\[\/mask\]/gi, '<span class="detail-comment-mask">$1</span>');
        // 图片：[img]url[/img] → 表情/图片（限 http(s)）
        s = s.replace(/\[img\](https?:[^\[\]]+?)\[\/img\]/gi,
            '<img class="detail-comment-inline-img" src="$1" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display=\'none\'">');
        // 链接：[url=addr]text[/url] 与 [url]addr[/url]（限 http(s)，交主进程转系统浏览器）
        s = s.replace(/\[url=(https?:[^\]]+?)\]([\s\S]*?)\[\/url\]/gi,
            '<a href="$1" target="_blank" rel="noreferrer">$2</a>');
        s = s.replace(/\[url\](https?:[^\[\]]+?)\[\/url\]/gi,
            '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
        // 剥除其余不识别/带参数的 BBCode 标签（size/color 等），仅去标签保留内容
        s = s.replace(/\[\/?[a-z][a-z0-9]*(=[^\]]*)?\]/gi, '');
        // 换行还原
        s = s.replace(/\r?\n/g, '<br>');
        return s;
    },

    /** 评论时间（完整版）：YYYY-MM-DD HH:mm（用户要求：年月日 + 具体时间）。
     *  A-14 实现下沉 common.js（fmtCommentTimeFull），此处保留方法壳转发：
     *  Detail._fmtCommentTimeFull 的既有调用点沿用原入口，行为不变。 */
    _fmtCommentTimeFull(ts) {
        return fmtCommentTimeFull(ts);
    },

    /** 评论时间 → 毫秒时间戳（排序用）：实现下沉 common.js（commentTsMs），仅转发。 */
    _commentTsMs(ts) {
        return commentTsMs(ts);
    },

    /** 从角色 info 中提取中文名。优先级：
     *  1) 基本信息 infobox 里的「简体中文名」项（最准确）；
     *  2) 显式 name_cn 字段；
     *  3) infobox「别名」项里含「中文/简体」的值。
     *  infobox 可能为数组 [{key, value}] 或字符串（HTML）。 */
    _pickCharNameCn(info) {
        if (!info) return '';
        const ib = info.infobox;
        // 1) 基本信息里的「简体中文名」（精确 key 命中，优先级最高）
        if (Array.isArray(ib)) {
            for (const it of ib) {
                if (!it || typeof it !== 'object') continue;
                const k = String(it.key || '').trim();
                if (k === '简体中文名' || k === '简体中文' || k === '中文名') {
                    let v = it.value;
                    if (typeof v === 'string' && v.trim()) return v.trim();
                    if (Array.isArray(v)) {
                        const hit = v.find((x) => x && x.v);
                        if (hit && hit.v) return String(hit.v);
                    }
                }
            }
        }
        // 2) 显式 name_cn
        if (info.name_cn) return String(info.name_cn);
        if (!ib) return '';
        // 3) 别名项里的中文/简体值兜底
        if (Array.isArray(ib)) {
            for (const it of ib) {
                if (!it || typeof it !== 'object') continue;
                const k = String(it.key || '').toLowerCase();
                if (k === '别名' || k === 'alternate name' || k === 'alias') {
                    let v = it.value;
                    if (Array.isArray(v)) {
                        // [{k:'简体中文',v:'...'}] 形式
                        const cn = v.find((x) => x && (String(x.k || '').includes('中文') || String(x.k || '').includes('简体')));
                        if (cn && cn.v) return String(cn.v);
                        if (v[0] && v[0].v) return String(v[0].v);
                    }
                    if (typeof v === 'string') {
                        // "简体中文: 名称" 或纯名称
                        const m = v.match(/(?:简体)?中文\s*[:：]\s*([^\n;；\/、]+)/);
                        if (m) return m[1].trim();
                        return v.split(/[\n;；\/、]/)[0].trim();
                    }
                }
            }
        }
        return '';
    },

    /** 角色卡片 CV 文案：v0 接口 actors 为 [{name,name_cn?}]，部分镜像兼容 actor 字符串；
     *  多位 CV 用「/」连接，无 CV 返回空串（卡片不渲染该行）。 */
    _charCvText(c) {
        if (!c) return '';
        const names = (Array.isArray(c.actors) ? c.actors : [])
            .map((a) => (a && (a.name_cn || a.name)) ? String(a.name_cn || a.name).trim() : '')
            .filter(Boolean);
        if (names.length) return names.join(' / ');
        if (typeof c.actor === 'string' && c.actor.trim()) return c.actor.trim();
        return '';
    },

    /** 构建角色「基本信息」多行文本：名称类字段（简体中文名 → 第二中文名 → 日文名 → 别名 → 其它名）
     *  排到最前，其余 infobox 字段按原顺序跟随。数组值（如「别名」多条）展开为多行子项。
     *  infobox 项形如 {key, value}，value 可能是字符串或 [{k, v}]。 */
    _buildCharInfoStr(info) {
        if (!info || !Array.isArray(info.infobox)) return '';
        // 名称类字段展示优先级（越靠前越先展示）；未列出的字段按原顺序排在名称字段之后
        const NAME_ORDER = ['简体中文名', '第二中文名', '日文名', '别名', '英文名', '罗马字', '拼音', '昵称', '本名', '外文名'];
        const nameRank = (k) => {
            const i = NAME_ORDER.indexOf(k);
            return i === -1 ? NAME_ORDER.length + 1 : i;
        };
        // 保留原始顺序索引，供同优先级/非名称字段稳定排序
        const rows = info.infobox
            .map((it, idx) => ({ it, idx }))
            .filter(({ it }) => it && typeof it === 'object' && String(it.key || '').trim());
        rows.sort((a, b) => {
            const ra = nameRank(String(a.it.key).trim());
            const rb = nameRank(String(b.it.key).trim());
            if (ra !== rb) return ra - rb;
            return a.idx - b.idx; // 同级保持原顺序
        });
        const lines = [];
        for (const { it } of rows) {
            const key = String(it.key || '').trim();
            const v = it.value;
            if (Array.isArray(v)) {
                // 「别名」等多条：每条一行，子标签 k 存在时作「父key·子k」，否则仅父 key
                for (const x of v) {
                    if (!x || typeof x !== 'object' || !x.v) continue;
                    const sub = String(x.k || '').trim();
                    const label = sub ? `${key}·${sub}` : key;
                    lines.push(`${label}：${String(x.v).trim()}`);
                }
            } else if (typeof v === 'string' && v.trim()) {
                lines.push(`${key}：${v.trim()}`);
            }
        }
        return lines.join('\n');
    },

    _renderCharacters() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        // A-29：等**角色路自己** settle（不再共用 _bgmExtraLoaded——它在吐槽路到达
        // 时即置真，而角色路要并发补全中文名，长番剧慢得多。共用会把「还在加载」
        // 渲染成「暂无角色信息」，表现即「数据越多越显示暂无」）。
        if (!this._bgmRouteSettled('characters')) { box.html(_detailSkeleton('card', { count: 6 }, '加载中…')); return; } // A-02：角色网格骨架
        // A-03：角色路网络失败 ≠ 无数据——渲染错误态 + 重试，而非「暂无角色信息」
        if (this._bgmExtraFailed && this._bgmExtraFailed.characters) {
            box.html(_detailRetryHtml('角色信息加载失败', 'id="detail-bgm-extra-retry"'));
            $('#detail-bgm-extra-retry').on('click', () => this._retryBgmExtra());
            return;
        }
        if (!this._characters.length) { box.html('<div class="tip-line">暂无角色信息</div>'); return; }
        // 角色权重：主角在前（relation 优先，role_name 兜底），升序稳定排序
        const roleWeight = (role) => (
            /主角|MAIN|主役/i.test(role) ? 0
            : /配角|SUPPORT|次要/i.test(role) ? 1
            : /客串|CAME/i.test(role) ? 2
            : 3
        );
        // 角色筛选：main=主角+配角（默认），lead=主角，support=配角，minor=闲角（客串+其他），all=全部
        const FILTERS = [
            { key: 'main', label: '主要人物' },
            { key: 'lead', label: '主角' },
            { key: 'support', label: '配角' },
            { key: 'minor', label: '闲角' },
            { key: 'all', label: '全部' },
        ];
        if (!FILTERS.some((f) => f.key === this._charFilter)) this._charFilter = 'main';
        const cards = this._characters.slice().map((c) => {
            const orig = c.name || '';
            const cn = c.name_cn || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : ''; // 中文名打头，原名作副行（相同则不重复）
            const cv = this._charCvText(c);
            const role = String(c.relation || c.role_name || '');
            return {
                role,
                weight: roleWeight(role),
                html: `<div class="detail-char-card" data-char-id="${escHtml(c.id || '')}" tabindex="0" title="点击查看人物详情与吐槽">
                    <div class="detail-char-avatar-wrap">${(c.images && (c.images.medium || c.images.grid))
                        ? `<img class="detail-char-avatar" src="${escHtml(c.images.medium || c.images.grid)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.closest('.detail-char-avatar-wrap').classList.add('noimg');this.remove()">`
                        : '<span class="detail-char-noimg">🎭</span>'}</div>
                    <div class="detail-char-name">${escHtml(mainName)}</div>
                    ${subName ? `<div class="detail-char-name-cn">${escHtml(subName)}</div>` : ''}
                    ${cv ? `<div class="detail-char-cv">CV：${escHtml(cv)}</div>` : ''}
                    <div class="detail-char-role">${escHtml(role)}</div>
                </div>`,
            };
        });
        const matchFilter = (w) => {
            switch (this._charFilter) {
                case 'lead': return w === 0;
                case 'support': return w === 1;
                case 'minor': return w >= 2;
                case 'all': return true;
                default: return w <= 1; // main：主角 + 配角
            }
        };
        const shown = cards.filter((x) => matchFilter(x.weight));
        shown.sort((a, b) => a.weight - b.weight);
        const filterBar = `<div class="detail-filter-bar" role="tablist" aria-label="角色筛选">${FILTERS.map((f) =>
            `<span class="detail-filter-item ${f.key === this._charFilter ? 'active' : ''}" data-char-filter="${f.key}" tabindex="0" role="tab" aria-selected="${f.key === this._charFilter}">${f.label}</span>`).join('')}</div>`;
        box.html(`${filterBar}${shown.length ? `<div class="detail-char-grid">${shown.map((x) => x.html).join('')}</div>` : '<div class="tip-line">该分类下暂无角色</div>'}`);
        // A-11：角色卡错峰入场（容器模式，staggerEnter 先例同 playCardsEnter 的 cards-enter 机制）
        staggerEnter(box.find('.detail-char-grid'), '.detail-char-card');
        box.find('.detail-char-card').on('click', (e) => {
            e.stopPropagation(); // 避免冒泡到 kazumi.js 的 #detail-body img 放大浮层
            const cid = String($(e.currentTarget).data('char-id') || '');
            if (cid) this._openCharacterDetail(cid);
        });
        box.find('[data-char-filter]').on('click', (e) => {
            this._charFilter = String($(e.currentTarget).data('char-filter') || 'main');
            this._renderCharacters();
        });
    },

    /** 人物详情浮层（仿 Kazumi CharacterPage）：资料 + 吐槽，两页签切换。 */
    async _openCharacterDetail(characterId) {
        if (typeof Kazumi === 'undefined') return;
        let wrap = document.getElementById('char-float');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'char-float';
            document.body.appendChild(wrap);
            wrap.addEventListener('click', (ev) => { if (ev.target === wrap) this._hideDetailFloat(wrap); });
        }
        wrap.innerHTML = '<div class="char-float-panel"><div class="tip-line">载入中…</div></div>';
        this._showDetailFloat(wrap); // A-10：清退场遗留后再亮层（连开两个角色时重播入场动画）
        const panel = wrap.firstChild;
        try {
            const [info, comments] = await Promise.all([
                Kazumi.bangumiCharacter(characterId).catch(() => null),
                Kazumi.bangumiCharacterComments(characterId).catch(() => []),
            ]);
            if (!info) { panel.innerHTML = '<div class="char-float-head"><button class="char-float-close">✕</button></div><div class="tip-line">角色详情载入失败</div>'; this._bindCharFloat(wrap); return; }
            const img = bangumiCover(info.images, 'card');
            // 角色中文名：Bangumi 角色接口 name 字段为原名（日文），无独立 name_cn 字段；
            // 中文名通常嵌在 infobox 的「别名:简体中文」项里，提取出来作为副标题展示。
            const charNameCn = Detail._pickCharNameCn(info);
            // 基本信息：把名称类字段（简体中文名 → 第二中文名 → 日文名 → 别名…）排到最前，
            // 其余字段按原顺序跟随；数组值（如「别名」多条）展开为多行。
            const infoStr = Detail._buildCharInfoStr(info);
            const metaBits = [
                info.blood_type ? '血型 ' + info.blood_type : '',
                info.height ? '身高 ' + info.height + 'cm' : '',
                info.weight ? '体重 ' + info.weight + 'kg' : '',
            ].filter(Boolean).join(' · ');
            const cmtList = (comments || []);
            this._charComments = cmtList;
            panel.innerHTML = `
                <div class="char-float-head">
                    <div class="char-float-title">
                        <span class="char-float-name-main">${escHtml(info.name || '人物')}</span>
                        ${charNameCn && charNameCn !== (info.name || '') ? `<span class="char-float-name-cn">${escHtml(charNameCn)}</span>` : ''}
                    </div>
                    <button class="char-float-close" title="关闭">✕</button>
                </div>
                <div class="char-float-tabs class-tabs">
                    <span class="class-tab active" data-ctab="info">资料</span>
                    <span class="class-tab" data-ctab="comments">吐槽（${cmtList.length}）</span>
                    <button type="button" class="md-btn md-btn-tonal md-btn-sm char-cmt-order" style="display:none;">${this._charCommentDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                </div>
                <div class="char-float-body">
                    <div class="char-float-pane" data-cpane="info">
                        <div class="char-float-info-row">
                            ${img ? `<img class="char-float-img" src="${escHtml(img)}" referrerpolicy="no-referrer" title="点击放大查看" onerror="this.style.display='none'">` : ''}
                            <div class="char-float-info-text">
                                ${metaBits ? `<div class="char-float-meta">${escHtml(metaBits)}</div>` : ''}
                                ${infoStr ? `<div class="detail-section-heading">基本信息</div><div class="char-float-summary">${escHtml(infoStr)}</div>` : ''}
                                ${info.summary ? `<div class="detail-section-heading">角色简介</div><div class="char-float-summary">${escHtml(stripHtml(info.summary))}</div>` : (infoStr ? '' : '<div class="tip-line">暂无角色简介</div>')}
                            </div>
                        </div>
                    </div>
                    <div class="char-float-pane" data-cpane="comments" style="display:none;">
                        <div class="char-float-cmt-list"></div>
                    </div>
                </div>`;
            this._bindCharFloat(wrap);
            this._renderCharComments(panel);
            // 人物大图点击放大（复用封面全屏浮层，滚轮缩放）
            const bigImg = (info.images && (info.images.large || info.images.medium)) || img;
            $(panel).find('.char-float-img').css('cursor', 'zoom-in').on('click', (ev) => {
                ev.stopPropagation();
                if (bigImg) this._openCoverFloat(bigImg);
            });
        } catch (e) {
            panel.innerHTML = '<div class="char-float-head"><button class="char-float-close">✕</button></div><div class="tip-line">角色详情载入失败</div>';
            this._bindCharFloat(wrap);
        }
    },

    _bindCharFloat(wrap) {
        const panel = wrap.firstChild;
        $(panel).find('.char-float-close').off('click').on('click', () => this._hideDetailFloat(wrap));
        $(panel).find('.char-float-tabs .class-tab').off('click').on('click', (e) => {
            const t = String($(e.currentTarget).data('ctab') || 'info');
            $(panel).find('.char-float-tabs .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            $(panel).find('.char-float-pane').each(function () {
                this.style.display = ($(this).data('cpane') === t) ? '' : 'none';
            });
            // 排序按钮仅在「吐槽」页签显示（与左侧两个页签在同一行齐平）
            $(panel).find('.char-cmt-order').css('display', t === 'comments' ? '' : 'none');
        });
        $(panel).find('.char-cmt-order').off('click').on('click', () => {
            this._charCommentDesc = !this._charCommentDesc;
            $(panel).find('.char-cmt-order').text(this._charCommentDesc ? '⇅ 切正序' : '⇅ 切倒序');
            this._renderCharComments(panel);
        });
    },

    /** 渲染角色吐槽列表（支持排序切换；含用户头像、回复与完整时间）。 */
    _renderCharComments(panel) {
        // 与番剧吐槽一致：按时间显式排序（false=正序旧→新，true=倒序新→旧），不依赖接口返回顺序。
        const list = (this._charComments || []).slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.createdAt || a.created_at || a.updatedAt || a.updated_at || 0);
            const tb = Detail._commentTsMs(b.createdAt || b.created_at || b.updatedAt || b.updated_at || 0);
            return this._charCommentDesc ? tb - ta : ta - tb;
        });
        const html = list.length ? list.map((c) => {
            const user = (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '';
            const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large))
                || c.avatar || '';
            const avatarBig = (c.user && c.user.avatar && (c.user.avatar.large || c.user.avatar.medium || c.user.avatar.small))
                || c.avatar || avatar;
            const text = c.content || c.comment || '';
            const time = Detail._fmtCommentTimeFull(c.createdAt || c.created_at || c.updatedAt || c.updated_at || 0);
            const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
            const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
                const ru = (r.user && (r.user.nickname || r.user.username)) || r.username || r.nickname || '';
                const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large))
                    || r.avatar || '';
                const raBig = (r.user && r.user.avatar && (r.user.avatar.large || r.user.avatar.medium || r.user.avatar.small))
                    || r.avatar || ra;
                const rt = r.content || r.comment || '';
                const rtime = Detail._fmtCommentTimeFull(r.createdAt || r.created_at || r.updatedAt || r.updated_at || 0);
                return `<div class="detail-comment-reply">
                    <div class="detail-comment-head">
                        ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" data-big="${escHtml(raBig)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                </div>`;
            }).join('')}</div>` : '';
            return `<div class="detail-comment">
                <div class="detail-comment-head">
                    ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" data-big="${escHtml(avatarBig)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                    <span class="detail-comment-user">${escHtml(user)}</span><span class="detail-comment-time">${escHtml(time)}</span>
                </div>
                <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                ${repliesHtml}
            </div>`;
        }).join('') : '<div class="tip-line">暂无吐槽</div>';
        $(panel).find('.char-float-cmt-list').html(html);
        // 吐槽用户头像点击放大（复用封面全屏浮层）：优先用 data-big 的大图
        $(panel).find('.char-float-cmt-list .detail-comment-avatar').css('cursor', 'zoom-in').off('click.avatar').on('click.avatar', (ev) => {
            ev.stopPropagation();
            const el = ev.currentTarget;
            const big = el.getAttribute('data-big') || el.getAttribute('src');
            if (big) Detail._openCoverFloat(big);
        });
    },

    /** 制作职位重要性排序权重：数字越小越靠前。命中越靠前的关键词优先级越高。
     *  未收录职位统一排到已知职位之后（保持接口原有相对顺序）。 */
    _staffJobRank(jobs) {
        // 职位重要性排序表（从高到低）。含「监督」类需列全，避免「音响监督」被泛化「监督」误吞：
        // 对每个职位取「最长匹配关键词」的权重，长关键词优先，保证专项监督不会被顶到导演级。
        const ORDER = [
            '原作', '导演', '总监督', '监督', '系列构成', '脚本', '剧本',
            '分镜', '演出', '角色设定', '人物设定', '总作画监督', '作画监督',
            '美术监督', '美术设计', '色彩设计', '摄影监督', '音响监督', '音乐',
            '剪辑', '主题歌', '动画制作', '制作',
        ];
        const arr = Array.isArray(jobs) ? jobs : (jobs ? [jobs] : []);
        let best = ORDER.length; // 未知职位排在末尾
        for (const j of arr) {
            const s = String(j || '');
            let matchIdx = -1;
            let matchLen = 0;
            // 取最长匹配关键词，避免「音响监督/总作画监督」被短词「监督」抢占高优先级。
            for (let i = 0; i < ORDER.length; i++) {
                if (s.includes(ORDER[i]) && ORDER[i].length > matchLen) {
                    matchLen = ORDER[i].length;
                    matchIdx = i;
                }
            }
            if (matchIdx >= 0 && matchIdx < best) best = matchIdx;
        }
        return best;
    },

    /** 制作人员职业分类（筛选用）：每类一组关键词，人员任一职位命中即归入该类。
     *  分类表即筛选条顺序；未命中任何类的人员在「全部」下照常展示。 */
    _staffJobCategories: [
        { key: 'all', label: '全部' },
        { key: 'director', label: '导演/监督', kw: /导演|监督|演出|分镜|コンテ/ },
        { key: 'script', label: '脚本/系列构成', kw: /脚本|剧本|系列构成|構成|编剧/ },
        { key: 'chara', label: '角色/作画', kw: /角色设计|人物设定|キャラ|作画|总作画|原画/ },
        { key: 'art', label: '美术/音乐', kw: /美术|色彩|背景|音乐|音响|主题歌|OP|ED/ },
        { key: 'produce', label: '制作/企划', kw: /制作|企划|原作|出品|动画制作|制片人|プロデューサー/ },
    ],

    _renderStaff() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        // A-29：等**制作路自己** settle（同 _renderCharacters 口径）
        if (!this._bgmRouteSettled('staff')) { box.html(_detailSkeleton('card', { count: 6 }, '加载中…')); return; } // A-02：制作人员骨架
        // A-03：制作路网络失败 ≠ 无数据——渲染错误态 + 重试，而非「暂无制作人员信息」
        if (this._bgmExtraFailed && this._bgmExtraFailed.staff) {
            box.html(_detailRetryHtml('制作人员信息加载失败', 'id="detail-bgm-extra-retry"'));
            $('#detail-bgm-extra-retry').on('click', () => this._retryBgmExtra());
            return;
        }
        if (!this._staff.length) { box.html('<div class="tip-line">暂无制作人员信息</div>'); return; }
        // 职业分类筛选（默认全部）：key 归一化防脏值，选中类下只展示命中人员
        const cats = this._staffJobCategories;
        if (!cats.some((c) => c.key === this._staffFilter)) this._staffFilter = 'all';
        const jobArrOf = (s) => (Array.isArray(s.jobs) ? s.jobs : (s.jobs ? [s.jobs] : (s.relation ? [s.relation] : [])));
        const cur = cats.find((c) => c.key === this._staffFilter) || cats[0];
        const filtered = this._staff.filter((s) => {
            if (cur.key === 'all') return true;
            const jobs = jobArrOf(s).join(' ');
            return cur.kw.test(jobs);
        });
        // 按制作职位重要性从左到右排序（稳定排序：同权重保留接口原有顺序）。
        const sorted = filtered
            .map((s, i) => ({ s, i, rank: Detail._staffJobRank(s.jobs || s.relation) }))
            .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
            .map((x) => x.s);
        const filterBar = `<div class="detail-filter-bar" role="tablist" aria-label="制作人员职业筛选">${cats.map((c) =>
            `<span class="detail-filter-item ${c.key === this._staffFilter ? 'active' : ''}" data-staff-filter="${c.key}" tabindex="0" role="tab" aria-selected="${c.key === this._staffFilter}">${c.label}</span>`).join('')}</div>`;
        box.html(`${filterBar}${sorted.length ? `<div class="detail-staff-grid">${sorted.map((s) => {
            // 与 _staffJobRank 同口径：jobs 兼容数组 / 字符串 / 空值——镜像源可能返回
            // 字符串形态，直接 .join 会抛 TypeError 导致整个制作页签渲染失败
            const jobs = jobArrOf(s).join(' / ');
            // 中文名优先显示（若存在），否则用原名；副标题展示另一个名字。
            const cn = s.name_cn || (s.infobox && Detail._pickCharNameCn({ infobox: s.infobox })) || '';
            const orig = s.name || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : '';
            const img = (s.images && (s.images.medium || s.images.grid || s.images.small)) || '';
            return `<div class="detail-staff">
                ${img ? `<img class="detail-staff-avatar" src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : '<span class="detail-staff-noimg">👤</span>'}
                <div class="detail-staff-info">
                    <span class="detail-staff-jobs">${escHtml(jobs)}</span>
                    <span class="detail-staff-name">${escHtml(mainName)}</span>
                    ${subName ? `<span class="detail-staff-subname">${escHtml(subName)}</span>` : ''}
                </div>
            </div>`;
        }).join('')}</div>` : '<div class="tip-line">该分类下暂无制作人员</div>'}`);
        // A-11：制作人员卡错峰入场（容器模式）
        staggerEnter(box.find('.detail-staff-grid'), '.detail-staff');
        box.find('[data-staff-filter]').on('click', (e) => {
            this._staffFilter = String($(e.currentTarget).data('staff-filter') || 'all');
            this._renderStaff();
        });
    },

    _renderRelations() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        // A-29：等**关联路自己** settle（同 _renderCharacters 口径）
        if (!this._bgmRouteSettled('relations')) { box.html(_detailSkeleton('card', { count: 4 }, '加载中…')); return; } // A-02：关联作品骨架
        // A-03：关联路网络失败 ≠ 无数据——渲染错误态 + 重试，而非「暂无关联番剧」
        if (this._bgmExtraFailed && this._bgmExtraFailed.relations) {
            box.html(_detailRetryHtml('关联番剧加载失败', 'id="detail-bgm-extra-retry"'));
            $('#detail-bgm-extra-retry').on('click', () => this._retryBgmExtra());
            return;
        }
        box.html(this._relations.length ? `<div class="detail-relation-grid">${this._relations.map((r) => {
            const img = (r.images && (r.images.medium || r.images.grid || r.images.common || r.image)) || '';
            const name = r.name_cn || r.name || '';
            const subName = (r.name && r.name_cn && r.name !== r.name_cn) ? r.name : '';
            return `<div class="detail-relation" ${r.id ? `data-rel-id="${escHtml(r.id)}" tabindex="0"` : ''}>
                <div class="detail-relation-poster">${img ? `<img src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.closest('.detail-relation-poster').classList.add('noimg');this.remove()">` : '<span class="detail-relation-noimg">🎬</span>'}</div>
                <div class="detail-relation-info">
                    <span class="detail-relation-type">${escHtml(r.relation || '')}</span>
                    <span class="detail-relation-name">${escHtml(name)}</span>
                    ${subName ? `<span class="detail-relation-subname">${escHtml(subName)}</span>` : ''}
                </div>
            </div>`;
        }).join('')}</div>` : '<div class="tip-line">暂无关联番剧</div>');
        // A-11：关联卡错峰入场（容器模式）
        staggerEnter(box.find('.detail-relation-grid'), '.detail-relation');
        box.find('.detail-relation[data-rel-id]').on('click', (e) => {
            const el = $(e.currentTarget);
            const id = String(el.data('rel-id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) {
                // A-01（Bangumi 快照写入侧）：关联卡嵌套跳转同口径——点击时刻海报
                // 已显示，随快照垫场新详情页 hero（site='' 对齐 openBangumi）
                if (typeof DetailSnap !== 'undefined' && DetailSnap.put) {
                    const img = el.find('.detail-relation-poster img').first();
                    const src = String(img.attr('src') || '');
                    DetailSnap.put('', id, {
                        pic: src || undefined,
                        name: String(el.find('.detail-relation-name').first().text() || '').trim() || undefined,
                    });
                }
                Kazumi.openBangumiInfoPage(id);
            }
        });
    },

    async _loadBgmExtra(skipCache) {
        if (!this._bgmId || typeof Kazumi === 'undefined') return;
        const cacheKey = String(this._bgmId);
        const gen = ++this._bgmExtraGen; // 本次加载世代：导航/重载会自增，作废在途的旧 subject 结果
        // 命中 localStorage 持久缓存（角色/制作/关联/吐槽首屏 100 条）直接上屏，免四路并发网络。
        // skipCache=true：失败路后台重拉专用——必须真走网络覆盖，否则重拉会再次命中
        // 同一条缓存形成自递归（审查3.8b 修复时引入的坑，由回归测试 3.8b② 钉住）。
        const cached = skipCache ? null : _detailCacheGet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey);
        if (cached && typeof cached === 'object') {
            if (gen !== this._bgmExtraGen) return; // 已切到别的番剧，丢弃
            this._comments = Array.isArray(cached.comments) ? cached.comments : [];
            this._commentOffset = this._comments.length;
            this._commentAllLoaded = this._comments.length < 100;
            // 旧版本缓存无 total 字段：0 = 未知，计数文案回退已加载口径
            this._commentTotal = Number(cached.commentTotal) || 0;
            // 缓存里 total 只在首页请求时有意义（=远端总数）；续拉后的缓存快照
            // 同值写入，无碍。total 不大于已加载数且未全载时按未知处理更稳妥：
            // 全载判定已在 _commentAllLoaded，文案层 _commentCountText 自会处理
            this._characters = Array.isArray(cached.characters) ? cached.characters : [];
            this._staff = Array.isArray(cached.staff) ? cached.staff : [];
            this._relations = Array.isArray(cached.relations) ? cached.relations : [];
            // 审查3.8b：缓存条目带 failed 路列表（旧缓存无此字段 = 无失败）。
            // 命中含失败路的条目：先按缓存秒回（保留秒开语义），失败路失败态复位
            // 逻辑照旧触发页签错误态，同时后台重拉覆盖——否则部分失败落盘的条目
            // 会把「重试」短路成命中投毒缓存，30min 内无恢复路径。
            const cachedFailed = Array.isArray(cached.failed)
                ? { comments: cached.failed.includes('comments'), characters: cached.failed.includes('characters'), staff: cached.failed.includes('staff'), relations: cached.failed.includes('relations') }
                : { comments: false, characters: false, staff: false, relations: false };
            this._bgmExtraFailed = cachedFailed; // 命中含失败路条目：失败态照实复位（页签显示错误态而非伪装「暂无」）
            this._bgmExtraLoaded = true;
            // A-29：缓存命中即四路都有数据（含 partial 补齐后的完整条目）→ 逐路标志
            // 全部置位，页签不再回落到骨架。partial 半截条目由下方后台重拉补齐，
            // 期间这三路仍按「已 settle」显示缓存里已有的数据（不闪回骨架）。
            // 例外：partial 条目里三路是**空占位**（写入时它们还在途），占位为空
            // 时不能算 settle——否则页签会用空数组渲染「暂无…」，正是本修复要消灭
            // 的「数据还没到却显示暂无」。此时保持骨架，等后台重拉真正落数据。
            const partialHit = cached.partial === true;
            this._bgmExtraRouteLoaded = {
                comments: true,
                characters: !(partialHit && !this._characters.length),
                staff: !(partialHit && !this._staff.length),
                relations: !(partialHit && !this._relations.length),
            };
            // 缓存数据上屏走淡入。仅限四个 Bangumi 页签触发重渲染（_activeTab
            // 必为其中之一，_renderTabContent 派发到同一渲染器）；不重渲染
            // 概览/分集，避免重置分集多选等交互状态。吸顶区间内数据落位后
            // 内容保持在功能栏之下可见
            if (['吐槽', '选集讨论', '角色', '关联', '制作'].includes(this._activeTab)) {
                const deep = this._isBelowTabsStick();
                this._swapTabContent(() => this._renderTabContent());
                this._snapToTabsStick(deep);
            }
            // 审查3.8b：失败路后台重拉（skipCache 绕过命中分支直接走网络，重拉完成
            // 后整包覆盖缓存，failed 字段清空，恢复路径闭环）。
            // partial（仅吐槽先到即落盘的半截条目）同理必须补齐，否则三路空数组
            // 会被当成「该条目确实没有角色/制作/关联」，30min 内误报「暂无」。
            if (cachedFailed.comments || cachedFailed.characters || cachedFailed.staff
                || cachedFailed.relations || cached.partial === true) {
                this._loadBgmExtra(true);
            }
            return;
        }
        try {
            // A-03：四路子请求失败态分离记录。此前 .catch(() => []) 把网络失败伪装成
            // 「没有数据」，页签误显「暂无角色信息」；现在捕获失败原因，区分
            // 「请求失败」（错误态 + 重试）与「成功但空列表」（维持「暂无」文案）。
            // 吐槽先行解耦：bangumiCharacters 服务端会串行补全每个角色的中文名
            // （N 个角色 = N 次串行详情请求，可达数秒），Promise.all 等它齐才渲染
            // 会把吐槽/制作/关联一起拖住（吐槽页签长时间停在骨架）。改为吐槽路
            // 单独 await——先到先写先渲染；其余三路仍并发，到达后补渲染。
            // 世代守卫逐段生效，导航切换后旧响应任何一段都不再写状态。
            const failed = { comments: false, characters: false, staff: false, relations: false };
            const commentsPromise = Kazumi.bangumiComments(this._bgmId, 100, 0)
                .catch((e) => { failed.comments = true; console.warn('[detail] bangumiComments 加载失败 (bgmId=%s)', this._bgmId, e); return { list: [], total: 0 }; });
            const charsPromise = Kazumi.bangumiCharacters(this._bgmId)
                .catch((e) => { failed.characters = true; console.warn('[detail] bangumiCharacters 加载失败 (bgmId=%s)', this._bgmId, e); return []; });
            const staffPromise = Kazumi.bangumiStaff(this._bgmId)
                .catch((e) => { failed.staff = true; console.warn('[detail] bangumiStaff 加载失败 (bgmId=%s)', this._bgmId, e); return []; });
            const relationsPromise = Kazumi.bangumiRelations(this._bgmId)
                .catch((e) => { failed.relations = true; console.warn('[detail] bangumiRelations 加载失败 (bgmId=%s)', this._bgmId, e); return []; });
            // ① 吐槽先到先上屏（不被角色补全拖住）：写状态 → 落「仅吐槽」的缓存
            // bundle（characters/staff/relations 空数组占位，后到段覆盖重写）→
            // 当前页签是吐槽时立即重绘。
            const commentsRes = await commentsPromise;
            if (gen !== this._bgmExtraGen) return;
            this._bgmExtraFailed = { ...failed };
            const comments = (commentsRes && Array.isArray(commentsRes.list)) ? commentsRes.list : [];
            this._comments = comments;
            this._commentOffset = this._comments.length;   // 已加载偏移，供下拉续拉
            this._commentAllLoaded = this._comments.length < 100;
            this._commentTotal = Number(commentsRes && commentsRes.total) || 0; // 真实总数（远端 total）
            if (!this._characters.length) this._characters = [];
            this._bgmExtraLoaded = true;
            // A-29：吐槽路已 settle（先到先上屏）。角色/制作/关联**未**置位——它们
            // 还在途，页签继续显示骨架；否则会带着空数组渲染成「暂无…」。
            this._bgmExtraRouteLoaded.comments = true;
            if (this._comments.length) {
                // 仅吐槽先到：其余三路尚未 settle，此时落盘的 characters/staff/
                // relations 是空数组且**不在 failed 里**（它们没失败，只是还没回来）。
                // 若此刻导航/关闭/被新世代作废，完整覆盖永不发生 → 下次打开命中
                // 这条半截缓存，30 分钟内把角色/制作/关联误报成「暂无」。
                // 故额外落 partial=true：命中侧据此后台重拉补齐（不按失败态显示——
                // 这三路没失败，只是没跑完）。
                _detailCacheSet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey, {
                    comments: this._comments, characters: this._characters,
                    staff: this._staff, relations: this._relations,
                    commentTotal: this._commentTotal,
                    partial: true, // 半截条目：仅吐槽已 settle，命中需后台补齐
                    failed: Object.keys(failed).filter((k) => failed[k]), // 审查3.8b：失败路随包落盘，命中时触发后台重拉
                }, DETAIL_BGMEXTRA_TTL);
            }
            if (this._activeTab === '吐槽') {
                const deep = this._isBelowTabsStick();
                this._swapTabContent(() => this._renderTabContent());
                this._snapToTabsStick(deep);
            }
            // ② 角色/制作/关联三路并发续拉：全部到达后统一写入并重绘。
            // 与吐槽路相互独立——吐槽页签的显示不再等角色 name_cn 补全。
            const [chars, staff, relations] = await Promise.all([charsPromise, staffPromise, relationsPromise]);
            if (gen !== this._bgmExtraGen) return;
            this._bgmExtraFailed = { ...failed }; // 三路齐后失败态为最终值（含吐槽路）
            this._characters = chars || [];
            this._staff = staff || [];
            this._relations = relations || [];
            // A-29：三路齐活 —— 逐路标志置位。此处是角色/制作/关联页签从骨架切到
            // 内容的唯一时机（各自数据已落位，不会再出现「有数据却显示暂无」）。
            this._bgmExtraRouteLoaded.characters = true;
            this._bgmExtraRouteLoaded.staff = true;
            this._bgmExtraRouteLoaded.relations = true;
            // 落盘持久缓存（四类合并为一条；空 bundle 不缓存，交 _detailCacheSet 的空值守卫处理）。
            // 审查3.8b：落盘条件收紧——有失败路时也落盘但携带 failed 路列表（旧缓存
            // 无 failed 字段视同无失败），命中该条目时后台重拉覆盖，重试/重开不再被
            // 投毒缓存短路成「暂无数据」。全失败路全是空数据时仍不落盘。
            if (this._comments.length || this._characters.length || this._staff.length || this._relations.length) {
                _detailCacheSet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey, {
                    comments: this._comments, characters: this._characters,
                    staff: this._staff, relations: this._relations,
                    commentTotal: this._commentTotal,
                    partial: false, // 四路齐活：完整条目，命中无需重拉
                    failed: Object.keys(failed).filter((k) => failed[k]), // 审查3.8b：失败路列表（空数组 = 全成功）
                }, DETAIL_BGMEXTRA_TTL);
            }
            // 网络数据到达后重绘：与缓存命中分支同语义——仅四个 Bangumi 页签
            // 走动画式交换（淡入，消除「加载中→数据」两段跳变）；吸顶区间内
            // 数据落位后内容保持在功能栏之下可见
            if (['吐槽', '选集讨论', '角色', '关联', '制作'].includes(this._activeTab)) {
                const deep = this._isBelowTabsStick();
                this._swapTabContent(() => this._renderTabContent());
                this._snapToTabsStick(deep);
            }
        } catch (e) {
            // A-03：不再静默吞异常。Promise.all 外层抛错（理论上子请求已各自 catch，
            // 此处兜渲染/赋值类异常如 _detailCacheSet），至少落日志可观测；
            // 失败态按全失败处理，让页签显示错误态而非「暂无数据」。
            console.warn('[detail] _loadBgmExtra 整体异常 (bgmId=%s)', this._bgmId, e);
            if (gen === this._bgmExtraGen) {
                this._bgmExtraFailed = { comments: true, characters: true, staff: true, relations: true };
                this._bgmExtraLoaded = true;
                // A-29：兜底按全失败处理 → 四路均视为 settle（页签渲染错误态+重试，
                // 不再停在骨架上等一个永不到达的结果）
                this._bgmExtraRouteLoaded = { comments: true, characters: true, staff: true, relations: true };
                // 渲染交换自身再炸也不能让异常逸出（async 函数外无接手者），错误态
                // 已记录，用户下次切页签自然渲染；此处重绘只是尽力而为
                try {
                    if (['吐槽', '选集讨论', '角色', '关联', '制作'].includes(this._activeTab)) {
                        const deep = this._isBelowTabsStick();
                        this._swapTabContent(() => this._renderTabContent());
                        this._snapToTabsStick(deep);
                    }
                } catch (e2) { console.warn('[detail] _loadBgmExtra 错误态重绘失败', e2); }
            }
        }
    },

    /** A-03：用户点击「重试」显式重拉 Bangumi 补充数据。不走 _bgmExtraLoaded
     *  自动重拉（该标志语义为「本会话已尝试加载过」，失败也置真，防每次切页签
     *  都自动重拉）；重入 _loadBgmExtra 会自增 _bgmExtraGen，旧响应按世代守卫作废。
     *  L43：传 skipCache=true——失败路缓存若存在，重试会先命中旧失败结果无即时反馈。 */
    _retryBgmExtra() {
        this._bgmExtraLoaded = false;
        // A-29：重试期间逐路标志复位 → 页签回到骨架（否则错误态会一直挂着，
        // 用户点了重试却看不到任何加载反馈）
        this._bgmExtraRouteLoaded = { comments: false, characters: false, staff: false, relations: false };
        this._loadBgmExtra(true);
    },

    /** 下拉续拉更多吐槽（无条数上限，滚到底部继续加载）。 */
    async _loadMoreComments() {
        if (this._commentAllLoaded || this._commentLoading || !this._bgmId || typeof Kazumi === 'undefined') return;
        this._commentLoading = true;
        const gen = this._bgmExtraGen; // M-30c：评论续拉世代守卫
        try {
            const moreRes = await Kazumi.bangumiComments(this._bgmId, 100, this._commentOffset || 0).catch(() => ({ list: [], total: 0 }));
            const more = (moreRes && Array.isArray(moreRes.list)) ? moreRes.list : [];
            if (gen !== this._bgmExtraGen) return; // 已切到其他番剧，旧评论丢弃
            // 续拉响应里仍带远端总数：刷新 _commentTotal（远端可能新增了吐槽）
            const resTotal = Number(moreRes && moreRes.total) || 0;
            if (resTotal > 0) this._commentTotal = resTotal;
            if (more.length) {
                this._comments = this._comments.concat(more);
                this._commentOffset = (this._commentOffset || 0) + more.length;
                if (more.length < 100) this._commentAllLoaded = true;
                this._renderComments(true);
            } else {
                this._commentAllLoaded = true;
            }
        } finally {
            this._commentLoading = false;
        }
    },

    /** 吐槽乐观刷新（T80）：评分/吐槽提交成功后调用。
     *  next.bgm.tv 评论接口有索引延迟，提交后立刻重拉未必包含新吐槽——先乐观插入
     *  本地行（「我的吐槽 · 刚刚」）保证立即可见，再清缓存后台重拉合并去重：
     *  稳定键（_commentKeys 的时间戳+用户+评分+正文指纹）不同，真实行到达后靠
     *  ts/用户/正文近似匹配替换乐观行，避免同一吐槽显示两遍。
     *  @param {object} opts { subjectId, rate, comment } 提交内容 */
    async onBgmCommentSubmitted(opts) {
        const o = opts || {};
        const sid = String(o.subjectId || this._bgmId || '');
        if (!sid || sid !== String(this._bgmId || '')) return; // 已导航到别的番剧
        const text = String(o.comment || '').trim();
        // 1) 乐观插入（有吐槽正文才有可插的行；纯评分无正文时跳过，仅刷新）
        if (text && Array.isArray(this._comments)) {
            const optimistic = {
                user: { nickname: '我的吐槽' },
                comment: text,
                createdAt: Date.now(),
                _optimistic: true, // 重拉合并时识别替换；排序键与真实行不同
            };
            if (o.rate) optimistic.rate = Number(o.rate) || 0;
            this._comments = this._comments.concat([optimistic]);
            this._renderComments();
        }
        // 2) 清 bgmextra 持久缓存（30 分钟 TTL 会把旧吐槽顶回来）+ 后台重拉合并。
        //    延迟 3s 再拉：给站点索引一点消化时间，降低「重拉结果不含新吐槽」概率。
        if (typeof localCacheDel === 'function') {
            try { localCacheDel(DETAIL_BGMEXTRA_CACHE_PREFIX + sid); } catch (e) { /* ignore */ }
        }
        setTimeout(() => {
            // 世代守卫：延迟期间导航离开/切换番剧则放弃
            if (String(this._bgmId || '') !== sid) return;
            this._bgmExtraLoaded = false;
            this._bgmExtraFailed = { comments: false, characters: false, staff: false, relations: false }; // A-03：重拉前复位失败态
            this._loadBgmExtra().then(() => this._mergeOptimisticComments(sid, text));
        }, 3000);
    },

    /** 重拉完成后合并乐观行：真实数据里已能匹配到同正文吐槽（站点索引已生效）时
     *  移除乐观占位行，避免重复；重拉结果仍不含（索引延迟未过）则保留乐观行。 */
    _mergeOptimisticComments(sid, text) {
        if (String(this._bgmId || '') !== sid) return;
        if (!Array.isArray(this._comments) || !this._comments.length) return;
        const hasOptimistic = this._comments.some((c) => c && c._optimistic);
        if (!hasOptimistic) return;
        const t = String(text || '').trim();
        const realMatch = t && this._comments.some((c) => c && !c._optimistic
            && String(c.comment || c.content || '').trim() === t);
        if (realMatch) {
            this._comments = this._comments.filter((c) => !(c && c._optimistic));
            this._renderComments();
        }
        // 未匹配：保留乐观行（下次进入详情页/再刷新时 _loadBgmExtra 重拉，
        // 新数据不含 _optimistic 标记，乐观行随整表替换自然消失——见 _loadBgmExtra 写入路径）
    },

    // ---------------------------------------------------------------- 选集讨论（对齐 Kazumi EpisodeCommentsView）

    /** 选集评论状态复位（打开/切换番剧/嵌套恢复时调用）：清空评论与选中集，
     *  自增世代作废在途的旧集评论请求；连带清空分集列表缓存（跨番剧防串档：
     *  _bgmEps 属于上一个番剧，留着会在选集讨论/分集页签闪出旧数据）。 */
    _resetEpComments() {
        this._epComments = [];
        this._epCommentsEpisodeId = 0;
        this._epCommentsLoading = false;
        this._epCommentsGen++;
        // 换番剧必须一并作废分集请求世代：_bgmEpGen 此前只在 _renderBgmEpisodes
        // 重入时递增，于是上一部仍在途的分集请求能通过新番剧的世代检查，把旧列表
        // 写进新番剧的 _bgmEps——用户切到「选集讨论」直接看到串台的上一部列表。
        this._bgmEpGen++;
        this._bgmEps = null;
        this._epCommentsPreload = null; // 换番剧作废上一部的预取评论（预取侧另有世代守卫）
        // 跨会话记忆保留在 _epCommentsMemory（带 sid 归属），不在此清——
        // 重开同一番剧时 _renderEpComments 按 sid 恢复上次选中的集
    },

    /** 记住当前番剧的选集（pickEp 调用）：{sid, eid}，重开详情/弹层时恢复。
     *  只记最近一部：换番剧后旧记忆被新选择覆盖，sid 不匹配即作废。 */
    _rememberEpSelection(eid) {
        this._epCommentsMemory = { sid: String(this._bgmId || ''), eid: Number(eid) || 0 };
    },

    /** 定位「选集讨论」页签应展示的集：优先用户上次选中的集（同番剧内切页签回来
     *  保持选择），否则取第 1 集。分集列表未加载时先拉取（后端 30 分钟缓存，开销小）。
     *  返回目标集对象（_bgmEps 项）或 null。 */
    async _ensureBgmEpisodes() {
        if (!this._bgmId || typeof Kazumi === 'undefined') return null;
        if (Array.isArray(this._bgmEps) && this._bgmEps.length) return this._bgmEps;
        // 守卫用 _bgmId 快照而非 _bgmExtraGen：同番剧吐槽提交后的 3 秒重拉会自增
        // _bgmExtraGen，借用它会误杀在途的分集请求（重进页签才恢复）
        const sid = String(this._bgmId);
        try {
            const data = await Kazumi.bangumiEpisodes(this._bgmId);
            if (String(this._bgmId || '') !== sid) return null; // 已切到别的番剧
            const list = ((data && data.data) || []).slice();
            // 直接写入 _bgmEps：分集页签若尚未打开，之后打开也直接复用（同一份数据）
            if (list.length) this._bgmEps = list;
            return list.length ? list : null;
        } catch (e) {
            return null;
        }
    },

    /** 「选集讨论」页签渲染：集数选择器 + 排序切换 + 评论列表（楼中楼缩进）。
     *  数据流：集列表（_bgmEps）→ 选中集 episode_id → kazumiBangumiEpisodeComments。
     *  无 token 权限要求（只读公开数据）；无 Bangumi 匹配/无分集时按空态展示。 */
    async _renderEpComments() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (typeof Kazumi === 'undefined') { box.html('<div class="tip-line">Kazumi 引擎不可用</div>'); return; }
        // 无分集数据：先拉分集列表（选集讨论与「分集」页签共用 _bgmEps 缓存）
        if (!(Array.isArray(this._bgmEps) && this._bgmEps.length)) {
            box.html(_detailSkeleton('comment', { count: 2, header: true }, '载入分集列表中…')); // A-02：选集讨论骨架（骨架高度匹配：header 垫 ep-comments-head 控件行，等分集期间结构同真实页签）
            // await 前快照番剧身份：等待期间切到别的番剧（_bgmId 已变）时，在途
            // _ensureBgmEpisodes 会因内部 sid 守卫返回 null，被当成「该番剧无分集」——
            // 不复查身份就会把旧番剧的「暂无分集信息」覆盖新番剧已渲染好的页签内容
            const sid = String(this._bgmId || '');
            const eps = await this._ensureBgmEpisodes();
            if (this._activeTab !== '选集讨论') return; // 等待期间已切页签
            if (String(this._bgmId || '') !== sid) return; // 等待期间已切到别的番剧（与 _ensureBgmEpisodes 内部守卫同口径）
            if (!eps) { box.html('<div class="tip-line">暂无分集信息</div>'); return; }
        }
        // 选中集：跨会话记忆 > 当前实例状态 > 第 1 集。重开同一番剧（reset 清了
        // 实例态）按 sid 恢复上次选中的集（「点完集数再回来没有记忆」的修复）。
        // 以 episode_id 为主键（防 SP/OP/ED 与正片同号歧义）。
        const eps = this._bgmEps;
        const mem = this._epCommentsMemory;
        if (!Number(this._epCommentsEpisodeId) && mem && mem.sid === String(this._bgmId || '')) {
            this._epCommentsEpisodeId = Number(mem.eid) || 0;
        }
        let cur = eps.find((ep) => ep && ep.id && Number(ep.id) === Number(this._epCommentsEpisodeId));
        if (!cur) {
            cur = eps.find((ep) => ep && Number(ep.type) === 0) || eps[0];
            this._epCommentsEpisodeId = Number(cur.id || 0);
        }
        this._renderEpCommentsShell(cur);
        this._loadEpComments(cur);
    },

    /** 页签骨架渲染：集数选择器 + 工具栏（排序）+ 评论列表容器。
     *  切集/切排序只重绘对应部分，不动列表骨架。
     *  集数选择器统一为「第 N 集 / 共 M 集」按钮（与「切正序」同规格同字号、
     *  位于其左）+ 向下悬浮网格弹层：向下展开盖在评论列表上方，永不越过
     *  吸顶页签栏——页签内容区因入场动画 fill:both 形成层叠上下文，弹层
     *  z-index 出不去，向上展开会被页签栏截断；弹层限高滚轮滚动（仿颜文字
     *  面板），点选/点外收起（交互同收藏菜单）。head 自身提为堆叠上下文
     *  （见 ui.css .ep-comments-head 注释），防下方评论卡把弹层盖住。
     *  集号口径：显示用季内集号（ep）优先，sort 是跨季绝对集号（第二季起
     *  连续累计，8 集的季度可能 sort=71..78），直接用会显示「第 78 集/共 8 集」；
     *  ep 缺失或非数字才回退 sort，再回退位置序号。 */
    _renderEpCommentsShell(cur) {
        const box = $('#detail-tab-content');
        const eps = this._bgmEps || [];
        const epNo = (ep, i) => {
            const epn = Number((ep && ep.ep) || NaN);
            if (Number.isFinite(epn) && epn > 0) return String(epn);
            const sort = Number((ep && ep.sort) || NaN);
            if (Number.isFinite(sort) && sort > 0) return String(sort);
            return String(i + 1);
        };
        const curId = Number((cur && cur.id) || 0);
        const curName = (cur && (cur.name_cn || cur.name)) || '';
        const curIdx = Math.max(0, eps.findIndex((x) => Number(x && x.id) === curId));
        const curNo = epNo(cur, curIdx);
        const pickerBtnHtml = (ep) => `第 ${escHtml(epNo(ep, Math.max(0, eps.findIndex((x) => Number(x && x.id) === Number(ep && ep.id)))))} 集 / 共 ${eps.length} 集`;
        // 网格 cells：全集格（含 SP/OP/ED，以 type 徽标区分），当前集高亮按
        // _epCommentsEpisodeId 实时取（弹层内点选后重排仍高亮正确集）。
        // 弹层内小图标只切格网排列方向（独立状态 _epGridDesc），不动评论排序；
        // 外层「切正/倒序」只管评论列表——两控件语义分离，互不重写对方文案。
        // gridOrder()：按 _epGridDesc 给出当前方向的遍历序列（ep 与显示集号回退口径
        // 一致——倒序时位置序号也倒过来，与旧 gridCellsHtml 行为对齐）。
        const gridOrder = () => {
            const view = eps.map((ep, i) => ({ ep, i }));
            return this._epGridDesc ? view.reverse() : view;
        };
        const cellHtml = (ep, i) => {
            const eid = Number(ep && ep.id) || 0;
            const type = Number(ep && ep.type) === 1 ? 'SP' : Number(ep && ep.type) === 2 ? 'OP' : Number(ep && ep.type) === 3 ? 'ED' : '';
            return `<button type="button" class="ep-comments-cell${eid === Number(this._epCommentsEpisodeId) ? ' active' : ''}" data-eid="${eid}"
                title="${escHtml(String((ep && (ep.name_cn || ep.name)) || ''))}">${escHtml(epNo(ep, i))}${type ? `<i>${type}</i>` : ''}</button>`;
        };
        const gridCellsHtml = () => gridOrder().map(({ ep, i }) => cellHtml(ep, i)).join('');
        // A-23：格网 cells 节点重排（仿 _reorderBgmEpisodes / renderEpisodes 先例）——
        // 集格按 data-eid 复用现有 DOM 节点，按新顺序 append（append 已有节点 =
        // 移动位置），不整片 innerHTML 重写：几百集长番切方向/切集不再全量重建，
        // 弹层滚动位置因节点复用天然保留，格子上的 class 状态也随节点保留。
        // 缺格按需补建、多余/重复格移除；「切到不同番剧」的重建走 _renderEpCommentsShell
        // 整体重绘（cells 容器随骨架重建），此处容器里只会有 cellHtml 产物，纯增量安全。
        const syncGridCells = () => {
            const cellsBox = box.find('.ep-comments-grid-cells');
            if (!cellsBox.length) return;
            const dom = cellsBox[0];
            const byEid = {};
            const surplus = []; // 脏格：eid 不在当前分集表 / 重复 eid 的后者 → 移除
            for (const child of Array.from(dom.children)) {
                const eid = Number(child.getAttribute('data-eid')) || 0;
                if (!byEid[eid] && eps.some((ep) => Number(ep && ep.id) === eid)) byEid[eid] = child;
                else surplus.push(child);
            }
            surplus.forEach((el) => el.remove());
            gridOrder().forEach(({ ep, i }) => {
                const el = byEid[Number(ep && ep.id) || 0];
                if (el) dom.appendChild(el); // 移动已有节点到末尾 = 按新顺序排列
                else cellsBox.append($(cellHtml(ep, i)).get(0)); // 缺格按需补建
            });
        };
        const gridOrderLabel = () => (this._epGridDesc ? '↓ 倒序' : '↑ 正序');
        box.html(`<div class="ep-comments-head">
                <div class="ep-comments-title">第 ${escHtml(curNo)} 集讨论<span class="ep-comments-sub">${escHtml(curName)}</span></div>
                <span class="ep-comments-picker">
                    <button type="button" id="ep-comments-picker-btn" class="md-btn md-btn-tonal md-btn-sm">${pickerBtnHtml(cur)}</button>
                    <div class="ep-comments-grid" style="display:none;">
                        <div class="ep-comments-grid-bar">
                            <span class="ep-comments-grid-hint">共 ${eps.length} 集</span>
                            <button type="button" id="ep-comments-grid-order" class="ep-comments-grid-order" title="切换集数排列方向">${gridOrderLabel()}</button>
                        </div>
                        <div class="ep-comments-grid-jump">
                            <input type="text" id="ep-comments-jump-input" class="ep-comments-jump-input" inputmode="numeric"
                                maxlength="4" placeholder="集号，回车跳转">
                            <button type="button" id="ep-comments-jump-go" class="ep-comments-jump-go">跳转</button>
                            <span id="ep-comments-jump-err" class="ep-comments-jump-err" style="display:none;"></span>
                        </div>
                        <div class="ep-comments-grid-cells">${gridCellsHtml()}</div>
                    </div>
                </span>
                <button type="button" id="ep-comments-order" class="md-btn md-btn-tonal md-btn-sm">${this._epCommentsDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
            </div>
            <div class="ep-comments-list" id="ep-comments-list">${_detailSkeleton('comment', { count: 3, header: 'chip' }, '加载评论中…')}</div>`); // A-02：选集讨论页签内骨架（骨架高度匹配：chip 垫列表首行计数胶囊，页签头部已是真实 DOM）
        box.find('#ep-comments-order').on('click', () => {
            this._epCommentsDesc = !this._epCommentsDesc;
            $('#ep-comments-order').text(this._epCommentsDesc ? '⇅ 切正序' : '⇅ 切倒序');
            this._renderEpCommentsList();
        });
        // 切集公共动作：更新标题（含按钮文案）+ 重拉评论 + 记忆（跨重开恢复）。
        // 格网 cells 走节点重排（A-23，仿 _reorderBgmEpisodes）：只把高亮 class
        // 迁到新集格上——弹层只是 toggle 显隐（DOM 不重建），不同步的话下次点开
        // 仍是旧集高亮（「选中格子无变化」的根因）
        const pickEp = (eid) => {
            const ep = eps.find((x) => x && Number(x.id) === eid);
            if (!ep || eid === this._epCommentsEpisodeId) return false;
            this._epCommentsEpisodeId = eid;
            this._rememberEpSelection(eid);
            const nm = (ep.name_cn || ep.name) || '';
            const no = epNo(ep, Math.max(0, eps.findIndex((x) => Number(x && x.id) === eid)));
            box.find('.ep-comments-title').html(`第 ${escHtml(no)} 集讨论<span class="ep-comments-sub">${escHtml(nm)}</span>`);
            box.find('#ep-comments-picker-btn').html(pickerBtnHtml(ep));
            // 高亮迁移：直接在现有格子上切 class（复用节点，不重写 innerHTML）
            box.find('.ep-comments-grid-cells .ep-comments-cell').each(function () {
                this.classList.toggle('active', Number(this.getAttribute('data-eid')) === eid);
            });
            syncGridCells();
            box.find('#ep-comments-list').html(_detailSkeleton('comment', { count: 3, header: 'chip' }, '加载评论中…')); // A-02：切集重拉骨架（骨架高度匹配：chip 垫列表首行计数胶囊）
            this._loadEpComments(ep);
            return true;
        };
        // 网格：按钮开合弹层，点选后收起并同步按钮文案与高亮
        box.find('#ep-comments-picker-btn').on('click', (e) => {
            const grid = $(e.currentTarget).closest('.ep-comments-picker').find('.ep-comments-grid');
            grid.toggle(!grid.is(':visible'));
            e.stopPropagation();
        });
        // 弹层内排序切换小图标：只切格网排列方向（独立状态 _epGridDesc），
        // 不动评论排序、不重写外层按钮文案——两控件互不干扰。
        // A-23：方向切换改走节点重排（复用已有格子按新顺序移动），不再整片
        // innerHTML 重写——几百集长番不再全量重建，弹层滚动位置保留
        box.find('#ep-comments-grid-order').on('click', (e) => {
            e.stopPropagation();
            this._epGridDesc = !this._epGridDesc;
            $(e.currentTarget).text(gridOrderLabel());
            syncGridCells();
        });
        // 集号跳转：几百集的长番滚动翻找效率太低，输入集号（按显示集号口径
        // ep→sort 匹配）回车或点「跳转」直达。成功后收起错误提示、滚动到新
        // 高亮格（几千格也不迷路）；无匹配/非数字在行内提示，不打断输入。
        const showJumpErr = (msg) => {
            const err = box.find('#ep-comments-jump-err');
            err.text(msg).show();
            clearTimeout(this._epJumpErrTimer);
            this._epJumpErrTimer = setTimeout(() => err.hide(), 2500);
        };
        const jumpToNo = () => {
            const input = box.find('#ep-comments-jump-input');
            const raw = String(input.val() || '').trim();
            const num = Number(raw);
            if (!raw || !Number.isFinite(num) || num <= 0) { showJumpErr('请输入集号'); return; }
            const target = eps.find((ep, i) => epNo(ep, i) === raw);
            if (!target) { showJumpErr(`没有第 ${raw} 集`); return; }
            box.find('#ep-comments-jump-err').hide();
            const eid = Number(target.id) || 0;
            pickEp(eid);
            // 跳转成功收起弹层；target 命中但 pickEp 返回 false = 本就是当前集，仍收起
            box.find('.ep-comments-grid').hide();
            input.val('');
        };
        box.find('#ep-comments-jump-go').on('click', (e) => {
            e.stopPropagation();
            jumpToNo();
        });
        box.find('#ep-comments-jump-input').on('keydown', (e) => {
            e.stopPropagation(); // 防触发对话框 Esc/全局快捷键
            if (e.key === 'Enter') { e.preventDefault(); jumpToNo(); }
        });
        // 网格格子点选：委托挂在 .ep-comments-grid-cells 上——cells 内容会按需
        // 增删/重排（A-23 节点重排、首建补格），直接绑定会随旧节点一起被丢掉，
        // 导致重排后点格子无响应（「点了集数讨论不更新」）；委托容器不动，依旧生效
        box.find('.ep-comments-grid-cells').on('click', '.ep-comments-cell', (e) => {
            const el = $(e.currentTarget);
            const picked = pickEp(Number(el.data('eid') || 0));
            el.closest('.ep-comments-grid').hide();
            if (picked) el.closest('.ep-comments-picker').find('#ep-comments-picker-btn').html(pickerBtnHtml(eps.find((x) => Number(x && x.id) === Number(this._epCommentsEpisodeId))));
        });
    },

    /** 拉取选中集的评论（世代守卫：切集/切番剧作废在途请求）。
     *  选集讨论提速（三段消费）：openBangumi 主信息到达后已接续预取第 1 集评论
     *  （_epCommentsPreload，sid/eid 双校验），页签首开默认集直接消费预取结果——
     *  两段串行网络（分集列表 → next.bgm 评论）全部等在打开详情的那几秒里，
     *  点开页签即成品，不再见骨架转圈。未命中预取（切了别的集/预取未回/旧番剧）
     *  走原请求路径，行为不变。 */
    async _loadEpComments(ep) {
        const eid = Number((ep && ep.id) || this._epCommentsEpisodeId || 0);
        if (!eid || typeof Kazumi === 'undefined') return;
        const gen = ++this._epCommentsGen;
        const pre = this._epCommentsPreload;
        if (pre && pre.sid === String(this._bgmId || '') && Number(pre.eid) === eid
            && Array.isArray(pre.list)) {
            this._epComments = pre.list;   // 预取命中：零网络上屏（本地 localStorage 缓存 miss 时同样从这里受益）
            if (gen === this._epCommentsGen) this._epCommentsLoading = false;
            if (this._activeTab !== '选集讨论') return;
            this._renderEpCommentsList();
            return;
        }
        this._epCommentsLoading = true;
        try {
            const list = await Kazumi.bangumiEpisodeComments(eid);
            if (gen !== this._epCommentsGen) return; // 已切集/切番剧，旧结果丢弃
            this._epComments = Array.isArray(list) ? list : [];
        } catch (e) {
            if (gen !== this._epCommentsGen) return;
            this._epComments = [];
        } finally {
            if (gen === this._epCommentsGen) this._epCommentsLoading = false;
        }
        if (this._activeTab !== '选集讨论') return; // 页签已切走：数据已并入状态，回来时自然渲染
        this._renderEpCommentsList();
    },

    /** 评论列表渲染（全量重绘；切集/切排序调用）。楼中楼 replies 缩进展示，
     *  与吐槽页签的行结构同款视觉（头像/昵称/时间/BBCode 正文）。 */
    _renderEpCommentsList() {
        const listBox = $('#ep-comments-list');
        if (!listBox.length) return;
        const list = (this._epComments || []).slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.createdAt || a.created_at || a.updatedAt || 0);
            const tb = Detail._commentTsMs(b.createdAt || b.created_at || b.updatedAt || 0);
            return this._epCommentsDesc ? tb - ta : ta - tb;
        });
        if (!list.length) {
            listBox.html('<div class="tip-line ep-comments-empty">本集还没有讨论</div>');
            return;
        }
        const rows = list.map((c) => {
            const user = (c.user && (c.user.nickname || c.user.username)) || '';
            const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large)) || '';
            const avatarBig = (c.user && c.user.avatar && (c.user.avatar.large || c.user.avatar.medium || c.user.avatar.small)) || avatar;
            const text = c.content || c.comment || '';
            const time = Detail._fmtCommentTimeFull(c.createdAt || c.created_at || 0);
            const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
            const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
                const ru = (r.user && (r.user.nickname || r.user.username)) || '';
                const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large)) || '';
                const raBig = (r.user && r.user.avatar && (r.user.avatar.large || r.user.avatar.medium || r.user.avatar.small)) || ra;
                const rt = r.content || r.comment || '';
                const rtime = Detail._fmtCommentTimeFull(r.createdAt || r.created_at || 0);
                return `<div class="detail-comment-reply">
                        <div class="detail-comment-head">
                            ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" data-big="${escHtml(raBig)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                            <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                        </div>
                        <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                    </div>`;
            }).join('')}</div>` : '';
            return `<div class="detail-comment">
                    <div class="detail-comment-head">
                        ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" data-big="${escHtml(avatarBig)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(user)}</span><span class="detail-comment-time">${escHtml(time)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                    ${repliesHtml}
                </div>`;
        }).join('');
        listBox.html(`<div class="ep-comments-count">共 ${list.length} 条讨论</div>${rows}`);
        // 切集/切排序后内容高度变化：同步钳制滚动防越界跳动
        this._clampDetailScroll();
    },

    _siteName(key) {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === key);
            return (s && s.name) || key;
        } catch (e) { return key; }
    },

    async _refreshLocalCol() {
        if (typeof Records === 'undefined') return;
        const fav = await Records.isFavorite(this.site, this.vodId);
        const tag = fav ? await Records.getFavTag(this.site, this.vodId) : '';
        const cur = fav ? (tag || 'want') : '';
        const labels = { want: '想看', watching: '在看', seen: '看过', hold: '搁置', dropped: '抛弃' };
        $('#detail-body .detail-col-btn').removeClass('active');
        $(`#detail-body .detail-col-btn[data-tag="${cur}"]`).addClass('active');
        // 单按钮同款同步（Bangumi 收藏按钮 #detail-col-current 的回填口径）：
        // 当前态图标+文案写进按钮内 label；选中非空态时按钮高亮
        const single = $('#detail-local-col-current');
        if (single.length) {
            single.find('.detail-col-label').text(cur ? (labels[cur] || cur) : '未收藏');
            single.find('.detail-col-state-svg').replaceWith(detailColStateIcon(cur));
            single.toggleClass('active', !!cur);
        }
    },

    /** 本地观看进度条（CatVod 源详情，方案 C 同口径）：从通用观看进度表
     *  （Records.getWatchProgress，player.js 逐集记账写入，不依赖收藏——未收藏影片
     *  也有进度）回填细进度条 + 「看到第 N 集 / 共 M 集」。旧版本数据回退读收藏条目
     *  progress 字段（Favorites.getProgress 内部已做该回退）。无任何进度记录时隐藏；
     *  Bangumi 匹配详情无本行（进度走统计区底部 .detail-watch-progress）。
     *  播放中每集看完 → Favorites.updateProgress → FavHub/点名刷新本条。 */
    async _refreshLocalProgress() {
        const el = $('#detail-body .detail-local-progress');
        if (!el.length) return; // Bangumi 匹配详情无本行（进度走统计区进度条）
        const site = String(this.site || '');
        const vodId = String(this.vodId || '');
        let prog = null;
        try {
            if (typeof Records !== 'undefined' && Records.getWatchProgress) {
                prog = await Records.getWatchProgress(site, vodId);
            }
            // 通用表未命中（旧版本数据只有收藏条目字段）→ 回退收藏条目读取
            if (!prog && typeof Favorites !== 'undefined' && Favorites.getProgress) {
                prog = await Favorites.getProgress(site, vodId);
            }
        } catch (e) { /* 读失败按无进度隐藏 */ }
        // 竞态守卫：await 期间详情页已切到别的影片，旧进度不写新页面
        if (el.length && $('#detail-body .detail-local-progress').length === 0) return;
        const cur = Number(prog && prog.currentEp) || 0;
        if (!prog || cur <= 0) { el.hide(); return; }
        const total = Number(prog.totalEps) || (this.sources[0] && this.sources[0].episodes.length) || 0;
        // 条宽优先按集数比例（看完整季的比例语义），集数未知时退单集观看百分比
        const pct = (total > 0)
            ? Math.min(100, Math.round(cur / total * 100))
            : Math.min(100, Math.round(Number(prog.percent) || 0));
        el.find('.detail-watch-progress-fill').css('width', pct + '%');
        // 文案精简（用户口径）：1/12；集数未知时 N/?（单集观看百分比已并入条宽）
        el.find('.detail-watch-progress-text').text(total > 0 ? `${cur}/${total}` : `${cur}/?`);
        el.show();
    },

    /** 本地收藏六态设置（对齐 Bangumi 收藏交互）：空标签=移除收藏，其余=收藏并置状态。
     *  bangumiId 缺失时按片名搜索补齐（仅取 ID 供时间表筛选用，不替换封面/片名）。 */
    async setLocalCollection(tag) {
        const vod = this._lastVod;
        if (!vod || typeof Records === 'undefined') return;
        let bangumiId = (this._bgmId && String(this._bgmId)) || (this._bgmInfo && String(this._bgmInfo.id || '')) || '';
        // bangumiId 缺失时按片名搜索 Bangumi（仅取 ID 供时间表筛选用，不替换封面/片名）
        if (!bangumiId) {
            const name = vod.vod_name || this.vodName || '';
            if (name && typeof Kazumi !== 'undefined' && Kazumi.bangumiSearch) {
                try {
                    const bgmResults = await Kazumi.bangumiSearch(name);
                    if (bgmResults && bgmResults.length && bgmResults[0].id) {
                        bangumiId = String(bgmResults[0].id);
                    }
                } catch (e) { /* 匹配失败不影响收藏 */ }
            }
        }
        const entry = {
            site: this.site, vodId: this.vodId,
            name: vod.vod_name || this.vodName,
            pic: vod.vod_pic || '',
            remarks: vod.vod_remarks || '',
            siteName: this._siteName(this.site),
            bangumiId,
        };
        if (!tag) {
            const fav = await Records.isFavorite(this.site, this.vodId);
            if (fav) { await Records.toggleFavorite(entry); warnToast('已取消收藏'); }
        } else {
            await Records.setFavTag(entry, tag);
            const label = { want: '想看', watching: '在看', seen: '看过', hold: '搁置', dropped: '抛弃' }[tag] || tag;
            warnToast(`已收藏并标记为「${label}」`);
        }
                // 收藏变更由 FavHub.changed（recSet 内触发）统一广播：
                // 详情页收藏按钮（本对象订阅）、我的收藏页（My 订阅）、时间表据此自动刷新。
    },

    selectSource(idx) {
        if (idx < 0 || idx >= this.sources.length) return;
        this.activeSource = idx;
        $('#detail-tab-content .play-src').removeClass('active');
        $(`#detail-tab-content .play-src[data-idx="${idx}"]`).addClass('active');
        // 换线路先清空勾选：ep-btn 节点跨线路复用（renderEpisodes 只重排不重建），
        // 残留的 checked 会让批量播放/下载仍按旧线路的 data-idx 取新线路的集。
        // A-19 勾选保护：勾选集只存于 DOM（.ep-check.checked，无按线路的记忆结构，
        // 无法静默迁移/恢复），清空前计数，确有丢弃时 toast 告知——消除「勾选无声
        // 消失」的困惑；清空必须先于 renderEpisodes（节点复用），playSelected/
        // _downloadEps 均在点击时实时读 DOM，界面与快照始终一致。
        const checkedN = $('#detail-tab-content .ep-check.checked').length;
        $('#detail-tab-content .ep-check').removeClass('checked');
        if (checkedN > 0) warnToast(`已切换线路，原勾选的 ${checkedN} 集已清空`);
        this.renderEpisodes();
        // A-18 换线路交叉淡入：重排完成后对集网格容器重触发纯 opacity 淡入
        // （epGridIn），硬切变软过渡；CSS 端 html:not(.glass-on) 门控
        const epGrid = $('#ep-list')[0];
        if (epGrid) replayClass(epGrid, 'ep-grid-in');
        this._saveLastSource();
    },

    /** 记忆当前线路（lastSourceMap）：load()/换线路（selectSource、弹窗选线路）都会调用。
     *  A-27 防抖（300ms 合并）：快速连续换线路时每次写都是「读全量→改一项→写全量」，
     *  连续写只保留最后一次——合并后语义不变，还省掉中间帧的 IPC 往返。
     *  读走 getFresh 强刷：写前必须拿含其他影片记忆的最新全量，不能用可能已失效的快照。
     *  深拷贝经 _cloneSnap（SettingsSnapshot 命中路径返回引用本体，读改写需隔离）。
     *  未加载 SettingsSnapshot（沙箱测试）回退原直读路径，行为不变。 */
    async _saveLastSource() {
        if (!this.site || !this.vodId) return;
        // M8：调度时快照 site/vodId/activeSource 进闭包——回调（300ms 防抖）不再
        // 实时读实例态。防抖窗口内换片（A→B）时，旧回调用旧键写旧线路号，
        // 不读被新片覆盖的 this.*，也不得取消新片自己的写入。
        const site = this.site;
        const vodId = this.vodId;
        const activeSource = this.activeSource;
        const saveNow = async () => {
            // 跨片污染防线：调度后用户已切到别的影片（site/vodId 变）——本次写入
            // 丢弃（新片的 _saveLastSource 自会写入新片的记忆）。
            if (this.site !== site || this.vodId !== vodId) return;
            try {
                const s = (typeof SettingsSnapshot !== 'undefined')
                    ? _cloneSnap(await SettingsSnapshot.getFresh()) : ((await window.yuki.settingsGet()) || {});
                const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
                map[`${site}|${vodId}`] = activeSource;
                await window.yuki.settingsSet('lastSourceMap', map);
                // 审查.md 2.2：程序化 settingsSet 不经过设置页控件，不触发 DOM
                // change 委托——SettingsSnapshot 快照不失效，后续 get() 会拿到
                // 过期 lastSourceMap（_restoreLastSource 恢复出错误线路）。写成功
                // 后显式失效快照（getFresh 本身也会失效，此处覆盖直读回退路径）。
                if (typeof SettingsSnapshot !== 'undefined'
                    && SettingsSnapshot && typeof SettingsSnapshot.invalidate === 'function') {
                    SettingsSnapshot.invalidate();
                }
            } catch (e) { /* 保存失败不影响主流程 */ }
        };
        clearTimeout(this._saveLastSourceTimer); // 已有挂起写入：合并为最后一次（activeSource 已最新）
        this._saveLastSourceTimer = setTimeout(() => {
            this._saveLastSourceTimer = null;
            saveNow();
        }, 300);
    },

    async _restoreLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            // A-27：load() 主链路点，改走 SettingsSnapshot 快照（含 lastSourceMap 全量）。
            // 读改写需要独立副本，经 _cloneSnap 深拷贝防污染快照。
            const s = (typeof SettingsSnapshot !== 'undefined')
                ? _cloneSnap(await SettingsSnapshot.get()) : ((await window.yuki.settingsGet()) || {});
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            const idx = map[`${this.site}|${this.vodId}`];
            if (typeof idx === 'number' && idx >= 0 && idx < this.sources.length) {
                this.activeSource = idx;
            }
        } catch (e) { /* 读取失败使用默认值 */ }
    },

    async _playEpisode(idx) {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const ep = src.episodes[idx];
        if (!ep) return;
        // 播放失败只反馈当前线路的地址和错误，不自动切换其它线路；线路选择
        // 由用户手动完成，避免当前线路失败后悄悄播放了另一条线路。
        await Player.play(
            this.site, src.from, ep.url,
            this.vodName || '', ep.name,
            src.episodes, idx,
        );
    },

    toggleEpOrder() {
        this._epDesc = !this._epDesc;
        this.renderEpisodes();
    },

    renderEpisodes() {
        const src = this.sources[this.activeSource];
        const box = $('#ep-list');
        if (!src) return;
        $('#ep-order').text(this._epDesc ? '⇅ 切正序' : '⇅ 切倒序');
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        // 复用已渲染按钮按新顺序重排（append 已有节点 = 移动位置，不重建 DOM，
        // 避免切换顺序时列表清空重建导致的闪烁）；首次渲染或缺集才创建。
        const byIdx = {};
        box.children('.ep-btn').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!Number.isNaN(idx)) byIdx[idx] = this;
        });
        order.forEach((i) => {
            const ep = src.episodes[i];
            const existing = byIdx[i];
            if (existing) {
                box.append(existing);
                return;
            }
            box.append(`<button class="ep-btn" data-idx="${i}" title="${epBtnTitle(ep, i)}">` +
                `<span class="ep-check" data-idx="${i}" title="勾选后可批量播放/下载"></span>` +
                `<span class="ep-name">${escHtml(ep.name)}</span>` +
                `<span class="ep-dl-one" data-idx="${i}" title="下载本集">⬇</span></button>`);
        });
        // 源切换后残留的多余按钮（如上一线路集数更多）清理掉
        const keep = new Set(order);
        box.children('.ep-btn').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!keep.has(idx)) $(this).remove();
        });
        $('#ep-check-all').prop('checked', false);
        this._syncDlBar();
        this._applyEpHighlight(); // A-16：上次进度集高亮（清旧徽标 → 读进度表 → 上徽标）
    },

    /** A-16：「看到第 N 集」当前集高亮。先清旧徽标（ep-btn 节点跨线路/跨渲染复用，
     *  残留会标错集），再读通用观看进度表（与 _refreshLocalProgress 同键同源，
     *  不依赖收藏），给「上次看到的那集」（currentEp 1 起编号 → data-idx=N-1）加
     *  ep-hi 徽标与悬浮提示；无进度 / 集号超出当前线路集数 / 读失败 → 渲染零变化。
     *  仅 CatVod 集网格：Bangumi 分集页签只在无本地源时渲染，其观看进度走 RM-5
     *  远端上报、从不写 watchProgress 表，本地无进度可标。 */
    _applyEpHighlight() {
        const box = $('#ep-list');
        if (!box.length) return;
        const site = String(this.site || '');
        const vodId = String(this.vodId || '');
        if (!site || !vodId) return;
        // 清旧徽标：title 还原为纯集名（epBtnTitle 口径，无名集回退「第 N 集」）
        box.children('.ep-btn.ep-hi').each(function () {
            const el = $(this);
            el.removeClass('ep-hi');
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            const nm = el.find('.ep-name').text().trim() || (Number.isNaN(idx) ? '' : `第 ${idx + 1} 集`);
            if (nm) el.attr('title', nm);
        });
        const paint = (prog) => {
            const cur = Number(prog && prog.currentEp) || 0;
            if (cur <= 0) return; // 没看过：零变化
            const btn = $(`#ep-list .ep-btn[data-idx="${cur - 1}"]`);
            if (!btn.length) return; // 换线路后集号越界：宁缺勿错标
            btn.addClass('ep-hi');
            const nm = btn.find('.ep-name').text().trim() || `第 ${cur} 集`;
            btn.attr('title', `${nm} · 上次看到第 ${cur} 集`);
        };
        // 会话内缓存：切顺序/换线路重渲染时同步回放上次的进度，徽标不闪；
        // 后台仍重读一次，播放回来进度变了在下次渲染生效
        const key = site + '|' + vodId;
        const cached = (this._epHiCache && this._epHiCache.key === key) ? this._epHiCache.prog : undefined;
        if (cached) paint(cached);
        if (typeof Records === 'undefined' || !Records.getWatchProgress) return;
        // 竞态守卫（审查3.8a，口径同 _refreshLocalProgress）：await 期间已切到
        // 别的影片/线路时，迟到回调不写 _epHiCache、不高亮新页面的集网格
        Records.getWatchProgress(site, vodId).then((prog) => {
            if (String(this.site || '') !== site || String(this.vodId || '') !== vodId) return;
            this._epHiCache = { key, prog: prog || null };
            paint(prog);
        }).catch(() => { /* 读失败不高亮，不影响渲染 */ });
    },

    _syncDlBar() {
        const n = $('#ep-list .ep-check.checked').length;
        $('#ep-dl-count').text(n ? `已勾选 ${n} 集` : '');
        $('#ep-dl-selected').text(n ? `⬇ 下载勾选集（${n}）` : '⬇ 下载勾选集');
        $('#ep-play-selected').text(n ? `▶ 播放勾选集（${n}）` : '▶ 播放勾选集');
    },

    async playSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要播放的集'); return; }
        const eps = idxs.map((i) => src.episodes[i]).filter(Boolean);
        if (!eps.length) { warnToast('当前线路没有对应剧集'); return; }
        const first = eps[0];
        let autoNext = true;
        // A-27：主链路点，改走 SettingsSnapshot 快照。autoNext 只在设置页写入且
        // 写后触发快照失效，起播瞬间读快照与读 IPC 等价（用户不会边点播放边改设置）。
        try {
            const s = (typeof SettingsSnapshot !== 'undefined')
                ? await SettingsSnapshot.get() : ((await window.yuki.settingsGet()) || {});
            autoNext = s.autoNext !== false;
        } catch (e) { /* 读失败默认连播 */ }
        if (eps.length > 1) {
            warnToast(autoNext ? `已加入播放列表 ${eps.length} 集，将自动连播` : '自动连播已关闭，仅播放勾选的第一集');
        }
        await Player.play(this.site, src.from, first.url, this.vodName || '', first.name, eps, 0);
    },

    downloadSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要下载的集'); return; }
        this._downloadEps(src, idxs);
    },

    async _downloadEps(src, idxs) {
        if (!src || !idxs.length) return;
        showLoading();
        let added = 0, ffmpegMissing = false, ffmpegDownloading = false, failed = 0;
        let skipDownloading = 0, skipDone = 0; // 同源同集去重：已在队列/已下载的集数
        let seq = 0; // A-20 批量进度序号：idxs 是勾选集的原始索引、可能不连续，进度展示需独立计数
        for (const i of idxs) {
            // 逐集刷新遮罩文案反馈解析进度；showLoading 只更新既有遮罩文本，不重建 DOM
            seq++;
            showLoading(`解析下载地址 ${seq}/${idxs.length}…`);
            const ep = src.episodes[i];
            if (!ep) continue;
            const r = await this._resolveDownloadUrl(src.from, ep.url);
            if (!r) { failed++; continue; }
            const isM3u8 = /\.m3u8(\?|#|$)/i.test(r.url.split('?')[0]);
            // 无法从 URL 识别扩展名时默认 .mp4（多数流媒体直链无标准后缀）
            const ext = isM3u8 ? '.mp4' : (r.url.split('?')[0].match(/\.(mp4|flv|mov|mkv|webm|avi|ts)$/i) || [''])[0] || '.mp4';
            const out = `${this.vodName || '视频'} - ${ep.name}${ext}`;
            try {
                // ep* 为同源同集去重上下文：与边下边播共用「站点|剧名|集名」key，
                // 命中重复任务/已完成文件时主进程直接跳过，不再重复下载
                const res = await window.yuki.download.control(isM3u8 ? 'addHls' : 'add', {
                    uri: r.url, out, header: r.header,
                    epSite: this.site || '', epVodName: this.vodName || '', epName: ep.name || '',
                });
                if (res && res.ok) added++;
                else if (res && res.reason === 'already-downloading') skipDownloading++;
                else if (res && res.reason === 'already-done') skipDone++;
                else if (res && res.reason === 'ffmpeg-downloading') ffmpegDownloading = true;
                else if (res && res.reason === 'ffmpeg-missing') ffmpegMissing = true;
                else failed++;
            } catch (e) { failed++; }
        }
        hideLoading();
        const bits = [];
        if (added) bits.push(`已加入下载 ${added} 集，可在“下载”页查看`);
        if (skipDownloading) bits.push(`${skipDownloading} 集已在下载队列，跳过重复下载`);
        if (skipDone) bits.push(`${skipDone} 集已下载过，无需重复下载`);
        if (ffmpegDownloading) bits.push('ffmpeg 正在后台自动下载（约 90MB），完成后重试即可');
        if (ffmpegMissing) bits.push('ffmpeg 未就绪，部分 m3u8 切片流暂无法合成（启动时后台下载中，请稍后重试）');
        if (failed) bits.push(`${failed} 集取不到下载地址`);
        warnToast(bits.join('；') || '没有可下载的集');
    },

    async _resolveDownloadUrl(flag, url) {
        try {
            const vipFlags = (typeof Player !== 'undefined' && Player.getVipFlags)
                ? await Player.getVipFlags() : [];
            const rsp = await doAction('playerContent', {
                site: this.site, flag, id: url, vipFlags: JSON.stringify(vipFlags),
            });
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const u = data.url || url;
            const header = (data.header && typeof data.header === 'object') ? data.header : {};
            if (parseInt(data.parse, 10) !== 1) return { url: u, header };
            if (/\.(mp4|flv|mov|mkv|webm|ts|m3u8)(\?|#|$)/i.test(u.split('?')[0])) return { url: u, header };
            const r = await window.yuki.resolveParse(u);
            if (r && r.ok) return { url: r.url, header: { ...header, ...(r.header || {}) } };
            // page 型地址兜底：与播放链（player.js parse=1 分支）对齐——解析接口失败后
            // 用隐藏窗口嗅探页面自身播放器的媒体请求。此前手动下载缺这层兜底，page 源
            // 「播放可以、手动下载不了」（边下边播复用的是播放链已解析出的直链）。
            try {
                const cap = await window.yuki.captureDirect(u, false);
                if (cap && cap.ok && cap.url) {
                    return { url: cap.url, header: { ...header, ...(cap.header || {}) } };
                }
            } catch (e) { /* 嗅探失败按取不到地址 */ }
        } catch (e) { /* 单集失败不阻断批量 */ }
        return null;
    },
};

// kazumi.js 单按钮同步路径（Bangumi type 口径）复用状态图标映射：跨文件走 Detail 命名空间
Detail._colStateIcon = detailColStateIcon;

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.detail = Detail;
}(typeof window !== 'undefined' ? window : globalThis));
