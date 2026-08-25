'use strict';
/**
 * ext-watch — 外部播放器（PotPlayer/VLC 等）观看会话追踪。
 *
 * 借鉴内置 mpv 的「会话号 + 退出事件」架构：mpv 经 IPC 能查询实时进度，退出时把
 * pos/duration/wallWatched 回传渲染层记账；外部播放器是黑盒进程（detached spawn、
 * stdio ignore），唯一可观测的是进程生命周期。因此时长口径与 mpv 的 wallWatched
 * 一致——「播放器运行了多久就算多久」（墙钟），无法区分暂停/拖动/切集。
 * 渲染层收到 exit 载荷后复用 _writeWatch 全套统计链路：隐身模式/统计开关门槛、
 * 观看链去重、最近观看与历史写入都留在渲染层，保持单一出处不被绕过。
 *
 * 已知边界（注释即文档，不做代码兜底）：
 *  - VLC 开启「仅允许一个实例」时，新进程把地址转交既有实例后立即退出，wallSec < 15s
 *    会被渲染层短播过滤（不会误计，但该次也不计次）；PotPlayer 正常常驻可正常统计；
 *  - 应用退出时在播会话直接丢弃（与 mpv 会话行为一致，不做落盘兜底）；
 *  - 多集 m3u 队列整段会话只有一条墙钟，归账到起播点击的那一集（无法感知外部播放器内切集）。
 */

const { EventEmitter } = require('events');

class ExtWatchTracker extends EventEmitter {
    constructor() {
        super();
        this._seq = 0;     // 会话号分配器（单调递增；渲染层据此匹配元信息快照）
        this._live = null; // 至多一条在播会话：{sessionId, kind, execPath, titles, startedAt, pid, done}
    }

    /** 结清会话并广播 exit（幂等：child 'exit' 与显式收敛可能先后到达，只结一次）。 */
    _finalize(session) {
        if (!session || session.done) return;
        session.done = true;
        if (this._live === session) this._live = null;
        const wallSec = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
        this.emit('exit', {
            sessionId: session.sessionId,
            pid: session.pid || 0,
            kind: session.kind,
            titles: session.titles,
            wallSec,
        });
    }

    /**
     * 开始一条新会话，返回会话号。开账即显式结清上一条在播会话：killPrevExtPlayer
     * 的 taskkill 可能失败、非 Windows 平台也没有该收敛，不能依赖旧进程 'exit' 事件
     * 必然及时到来——显式结清保证任何时刻至多一条未结算会话，且旧会话墙钟按其真实
     * 起播时间计算，不会被新启动的时间点拉长。
     */
    beginSession({ kind, execPath, titles } = {}) {
        this._finalize(this._live);
        this._seq += 1;
        this._live = {
            sessionId: this._seq,
            kind: String(kind || ''),
            execPath: String(execPath || ''),
            titles: (Array.isArray(titles) ? titles : []).map((t) => String(t || '')),
            startedAt: Date.now(),
            pid: 0,
            done: false,
        };
        return this._live.sessionId;
    }

    /**
     * 绑定 spawn 出的 ChildProcess。detached + unref 只影响父进程事件循环的引用计数，
     * 不影响子进程 'exit'/'error' 事件的派发——应用存续期间退出必达。
     */
    attach(child) {
        const s = this._live;
        if (!s || s.done || !child) return;
        s.pid = child.pid || 0;
        child.once('exit', () => this._finalize(s));
        // spawn 失败（ENOENT/EACCES）通常只触发 'error' 不触发 'exit'：立即结清。
        // 否则残留的 live 会话会被下一次 beginSession 按超长墙钟误结算成几小时。
        child.once('error', () => this._finalize(s));
    }

    /** spawn 同步抛错等场景下取消会话：静默作废，不产生 exit 广播。 */
    cancel(sessionId) {
        const s = this._live;
        if (!s || s.sessionId !== sessionId) return;
        s.done = true;
        this._live = null;
    }
}

module.exports = { ExtWatchTracker, extWatch: new ExtWatchTracker() };
