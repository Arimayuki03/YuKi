/**
 * async-session.js — 异步会话并发控制（对齐 Kazumi AsyncSession / AsyncSerialQueue / AsyncSingleFlight）
 *
 * 场景：隐藏窗口解析、网络探测等异步操作需要「同 key 并发去重」或「串行不重入」时，
 * 用这两个工具避免各自手写状态机。
 *
 * - AsyncSingleFlight.run(key, fn)：同一 key 的并发调用只执行一次，其余复用同一 Promise；
 *   完成（含失败）后清掉缓存，下次同 key 重新执行。
 * - AsyncSerialQueue.push(fn)：FIFO 串行队列，前一个完成后才跑下一个；前一个失败不影响后续。
 */
class AsyncSingleFlight {
    constructor() {
        this._inflight = new Map(); // key -> Promise
    }

    /**
     * @param {string} key 去重键
     * @param {Function} fn 实际执行函数（返回 Promise）
     * @returns {Promise} 本次调用与同 key 在途调用共享的结果
     */
    run(key, fn) {
        const k = String(key);
        if (this._inflight.has(k)) return this._inflight.get(k);
        const p = Promise.resolve().then(() => fn());
        this._inflight.set(k, p);
        // 无论成功失败都释放，保证下次同 key 重新执行
        p.then(() => this._inflight.delete(k), () => this._inflight.delete(k));
        return p;
    }

    /** 某 key 是否正在执行。 */
    has(key) { return this._inflight.has(String(key)); }

    /** 在途任务数。 */
    size() { return this._inflight.size; }

    /** 清除全部在途状态（不中断已启动的任务，仅不再共享结果）。 */
    clear() { this._inflight.clear(); }
}

class AsyncSerialQueue {
    constructor() {
        this._tail = Promise.resolve();
    }

    /**
     * @param {Function} fn 串行执行的任务（返回 Promise）
     * @returns {Promise} 本次任务的最终结果
     */
    push(fn) {
        const run = this._tail.then(() => fn());
        // 尾巴吞掉失败，避免单个任务出错卡死整条链
        this._tail = run.then(() => undefined, () => undefined);
        return run;
    }
}

module.exports = { AsyncSingleFlight, AsyncSerialQueue };
