/**
 * pan-qr-window.js — 夸克网盘扫码登录（官方页面方案）
 *
 * 原理：夸克 PC 网页版（https://pan.quark.cn/）落地页默认就渲染了
 * 「扫码登录」modal（QA 组件）。直接在主进程开一个 BrowserWindow 加载
 * 该页面，让官方 JS 在真实 Chromium 里完成完整登录流程：
 *   - 官方 fetchTokenLoop 生成 token + 渲染二维码
 *   - 用户用夸克 App 扫码 → 手机确认
 *   - 官方轮询拿到 ST → account/info 兑换 → 服务端下发全部 Cookie
 *     （含 __puus / __pus / b-user-id / __sdid 等，与浏览器登录完全一致）
 * 登录成功后（检测到 __puus 等关键 Cookie 或页面跳转到网盘页），
 * 从窗口 session 收割 Cookie，关闭窗口并返回。
 *
 * 为什么替代手动 API 方案：手动模拟（含 request_id 修正）已能完成
 * 登录，但 drive-pc 接口仍判定 guest（缺 __puus——该 Cookie 只在
 * 官方页面完整流程中由服务端下发）。官方页面方案 100% 复刻网页版，
 * Cookie 完整，网盘播放链路（jar 蜘蛛 + 7944 转发）即可打通。
 */
const { BrowserWindow, session } = require('electron');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PARTITION = 'quark-pan-login';
const LOGIN_URL = 'https://pan.quark.cn/';
// 登录成功判定：这些 Cookie 出现即认为已登录（__puus 为核心，__pus 兜底）
const SUCCESS_COOKIES = ['__puus', '__pus'];
const MAX_WAIT_MS = 5 * 60 * 1000; // 最长等待 5 分钟
const POLL_MS = 1000;

let win = null;
let resolveCb = null;
let rejectCb = null;
let pollTimer = null;
let startedAt = 0;
let settled = false;

function ses() {
    return session.fromPartition(PARTITION);
}

/** 收集 quark/uc 域 Cookie 为 header 字符串 */
async function collectCookies() {
    let cookies = [];
    try {
        cookies = await ses().cookies.get({});
    } catch (e) {
        return '';
    }
    const parts = [];
    for (const c of cookies) {
        const dom = String(c.domain || '').toLowerCase();
        if (dom.includes('quark.cn') || dom.includes('uc.cn')) {
            parts.push(`${c.name}=${c.value}`);
        }
    }
    return parts.join('; ');
}

/** 检查登录是否完成（关键 Cookie 是否齐全） */
async function isLoggedIn() {
    let cookies = [];
    try {
        cookies = await ses().cookies.get({});
    } catch (e) {
        return false;
    }
    const names = new Set(cookies.map((c) => c.name));
    // __puus 是网盘/CDN 核心认证 Cookie（登录后页面跳转网盘主页时才下发）；
    // 只拿到 __pus 不算完成——收割太早会导致 drive-pc 判定 guest、播放 412。
    return names.has('__puus');
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function settle(ok, result) {
    if (settled) return;
    settled = true;
    stopPoll();
    if (ok && resolveCb) resolveCb(result);
    if (!ok && rejectCb) rejectCb(new Error(result && result.message || '登录已取消'));
}

/** 打开官方登录窗口；成功 resolve({cookies})，取消/失败 reject。 */
function openLoginWindow() {
    return new Promise((resolve, reject) => {
        if (win) {
            reject(new Error('登录窗口已打开'));
            return;
        }
        resolveCb = resolve;
        rejectCb = reject;
        settled = false;
        startedAt = Date.now();

        // 清理旧 session（上次登录的 cookie 清掉，保证新会话干净）
        ses().clearStorageData().catch(() => {});

        win = new BrowserWindow({
            width: 460,
            height: 700,
            title: '夸克网盘扫码登录',
            backgroundColor: '#f3f6fe',
            autoHideMenuBar: true,
            webPreferences: {
                partition: PARTITION,
                contextIsolation: false,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        win.setMenuBarVisibility(false);
        win.loadURL(LOGIN_URL, { userAgent: UA });

        // 外链走系统浏览器
        win.webContents.setWindowOpenHandler(({ url }) => {
            const { shell } = require('electron');
            if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });
        // 用户手动关窗 = 取消
        win.on('closed', () => {
            win = null;
            if (!settled) settle(false, { message: '登录窗口已关闭' });
        });
        // 页面加载失败/崩溃提示
        win.webContents.on('did-fail-load', (_e, code, desc) => {
            if (!settled && code !== -3) console.warn('[pan-qr-window] load fail:', code, desc);
        });

        // 轮询 cookie 判断登录成功
        pollTimer = setInterval(async () => {
            try {
                if (await isLoggedIn()) {
                    const cookies = await collectCookies();
                    console.log('[pan-qr-window] login ok, cookie len:', cookies.split('; ').length);
                    settle(true, { cookies });
                    closeLoginWindow();
                    return;
                }
            } catch (e) { /* 忽略单次轮询错误 */ }
            if (Date.now() - startedAt > MAX_WAIT_MS) {
                settle(false, { message: '登录超时（5 分钟），请重试' });
                closeLoginWindow();
            }
        }, POLL_MS);
    });
}

/** 关闭登录窗口（幂等） */
function closeLoginWindow() {
    stopPoll();
    if (win) {
        const w = win;
        win = null;
        try { w.destroy(); } catch (e) { /* ignore */ }
    }
    if (!settled) settle(false, { message: '登录已取消' });
}

module.exports = { openLoginWindow, closeLoginWindow };
