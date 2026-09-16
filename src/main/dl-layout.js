/**
 * dl-layout.js — RM-1 下载产物番剧子目录布局
 *
 * 目标：同一部作品的所有集数落在 <下载目录>/<番剧名>/ 下，文件以「剧名 - 集名」命名，
 * 替代此前全部平铺在下载根目录的布局（且边下边播逐集链此前所有集共用
 * 「剧名.ext」文件名，同剧多集会互相覆盖）。
 *
 * - sanitizeSegment：Windows 路径段清洗（非法字符/保留名/尾点尾空格/长度/空串），纯函数可单测；
 * - resolveSeriesTaskLayout：给定 剧名/集名/旧 out 合成 { dir, file, folder }；信息不全
 *   返回 null（落引擎根目录，与旧行为一致——下载页手输 URL 无上下文）；
 * - relUnderRoot：绝对路径相对根目录的安全相对路径（越界返回 ''），供目录迁移
 *   保持两级结构与恢复入队校验共用。
 *
 * 仅新任务生效，存量平铺文件不迁移；去重键（站点|剧名|集名）不受布局影响。
 */
const path = require('path');

// 段长上限：为「下载根目录 + 番剧名 + 集名 + 扩展名」留出 MAX_PATH 余量
const DEFAULT_MAX_LEN = 80;
// Windows 保留设备名（含带扩展名形态，CON.mp4 在 Win32 命名空间同样非法）
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * 清洗一个路径段（文件夹名或文件名主体）。
 * @param {object} opts maxLen 截断上限；fallback 清洗后为空时的回退值（默认 ''）
 */
function sanitizeSegment(input, { maxLen = DEFAULT_MAX_LEN, fallback = '' } = {}) {
    let s = String(input ?? '');
    s = s.replace(/[\\/:*?"<>|]/g, '_');    // Windows 非法字符（含路径分隔符，防穿越）
    s = s.replace(/[\x00-\x1f\x7f]/g, '');  // 控制字符
    s = s.trim();
    // 截断（按码点，避免切开代理对）；先截断再去尾点，防止恰好截出尾点
    const chars = Array.from(s);
    if (chars.length > maxLen) s = chars.slice(0, maxLen).join('');
    s = s.replace(/[. ]+$/, '');            // Windows 路径段不允许尾部空格/点（'..' 由此清空）
    const reserved = s.match(WINDOWS_RESERVED_RE);
    if (reserved) s = reserved[1] + '_' + (reserved[2] || '');
    return s || String(fallback ?? '');
}

const SERIES_SEP = ' - ';

/**
 * 拼「<剧名> - <集名>」，超长时截剧名前缀而非集名尾部：整体交给
 * sanitizeSegment 尾部截断会把集号截掉，同剧多集产物被截成同名互相覆盖。
 * 剧名+分隔符完全放不下（集名本身近满段长）时放弃前缀保住集名可读。
 */
function withSeriesPrefix(folder, ep) {
    const budget = DEFAULT_MAX_LEN - SERIES_SEP.length - Array.from(ep).length;
    let prefix = '';
    if (budget > 0) {
        const chars = Array.from(folder);
        prefix = chars.length > budget
            ? chars.slice(0, budget).join('').replace(/[. ]+$/, '')   // 截断可能恰好止于点/空格
            : folder;
    }
    return prefix ? sanitizeSegment(`${prefix}${SERIES_SEP}${ep}`) : ep;
}

/**
 * 合成一个番剧子目录任务的布局。
 * @returns null：开关关 / 无 dlRoot / 无剧名 / 得不到可用文件名（调用方回退平铺旧逻辑）
 *          其余 { dir, file, folder }：dir=任务子目录绝对路径，file=清洗后的文件名
 */
function resolveSeriesTaskLayout({ dlRoot, enabled = true, vodName, epName, out } = {}) {
    if (enabled === false || !dlRoot || !String(vodName || '').trim()) return null;
    const folder = sanitizeSegment(vodName);
    if (!folder) return null;
    const dir = path.join(String(dlRoot), folder);
    const ext = path.extname(String(out || ''));
    let file = String(epName || '').trim() ? sanitizeSegment(epName) : '';
    if (file) {
        // 文件名带影片名：<剧名> - <集名><ext>——产物离开子目录（复制/移动/外部
        // 播放器recent）后仍可读；集名本身已含剧名（「剧名 第X集」形态源）不重复前缀。
        if (file !== folder && !file.startsWith(folder)) file = withSeriesPrefix(folder, file);
        file += ext;
    } else {
        // 集名缺失：回退旧 out 文件名（清洗后），保持无集名入口（如单集影片）可用
        file = sanitizeSegment(path.basename(String(out || '')));
    }
    if (!file) return null;
    return { dir, file, folder };
}

/**
 * 从任务产物路径推导展示名：产物落在 <dlRoot>/<剧名>/ 下一级（RM-1 布局）时
 * 返回「剧名 - 文件名」——此类任务文件名只含集名，下载列表只显示 basename
 * 会丢失影片名；平铺任务（根目录）返回 ''。BT 种子产物不做目录层级判断：
 * 一级目录时恰好凑出「种子名 - 文件名」可读形式（顺带生效），二级及以上返回 ''
 * （torrent 内部结构自带可读层级，强行前缀反而冗长）。
 * @param {object} opts dlRoot 下载根目录；files 产物绝对路径数组；name 当前显示名
 * @returns {string} 展示名；信息不足返回 ''（调用方回退原 name）
 */
function seriesDisplayName({ dlRoot, files, name } = {}) {
    const f = (files || []).find((x) => x && x !== '.');
    if (!f || !dlRoot) return '';
    const rel = relUnderRoot(dlRoot, f);
    if (!rel) return '';
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return '';
    const [folder, fileName] = parts;
    // 文件主名已含剧名时不重复前缀：单集影片（stem === folder）与集名缺失时
    // 落进子目录的旧 out 命名（「剧名 - xxx」形态）都会被前置命中
    const base = path.basename(String(name || fileName));
    if (!base) return '';
    const stem = base.slice(0, base.length - path.extname(base).length);
    // 新布局文件名自带「剧名 - 」前缀（resolveSeriesTaskLayout），同样命中此前缀判断，
    // 展示层不再二次叠加；存量仅集名的文件走下方补前缀分支。
    if (!stem || stem.startsWith(folder)) return base;
    return `${folder} - ${base}`;
}

/**
 * 绝对路径 p 相对 root 的安全相对路径；root 为空、p 越界或与 root 相同返回 ''
 * （调用方以 '' 表示「平铺/不可迁移」）。分隔符统一为本平台 path.sep。
 */
function relUnderRoot(root, p) {
    try {
        if (!root || !p) return '';
        const rel = path.relative(path.resolve(String(root)), path.resolve(String(p)));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
        return rel;
    } catch (e) { return ''; }
}

module.exports = { sanitizeSegment, resolveSeriesTaskLayout, relUnderRoot, seriesDisplayName, DEFAULT_MAX_LEN };
