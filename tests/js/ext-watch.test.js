'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExtWatchTracker } = require('../../src/main/ext-watch');

/** 最小 ChildProcess 替身：只实现 tracker 依赖的 once/emit，手动派发 exit/error。 */
class FakeChild {
    constructor(pid) {
        this.pid = pid;
        this._cbs = {};
    }

    once(ev, cb) {
        (this._cbs[ev] = this._cbs[ev] || []).push(cb);
        return this;
    }

    emit(ev) {
        for (const cb of (this._cbs[ev] || []).slice()) cb();
    }
}

test('beginSession 分配单调递增会话号', () => {
    const t = new ExtWatchTracker();
    const a = t.beginSession({ kind: 'vlc', execPath: '/usr/bin/vlc', titles: ['第01集'] });
    const b = t.beginSession({ kind: 'potplayer' });
    assert.equal(a, 1);
    assert.equal(b, 2);
});

test('attach 后进程退出广播一次 exit 载荷，重复 exit 不再触发', () => {
    const t = new ExtWatchTracker();
    const exits = [];
    t.on('exit', (info) => exits.push(info));
    const sid = t.beginSession({ kind: 'vlc', execPath: 'vlc.exe', titles: ['A', 'B'] });
    const child = new FakeChild(4242);
    t.attach(child);
    child.emit('exit');
    child.emit('exit'); // 双保险：幂等
    assert.equal(exits.length, 1);
    assert.equal(exits[0].sessionId, sid);
    assert.equal(exits[0].pid, 4242);
    assert.equal(exits[0].kind, 'vlc');
    assert.deepEqual(exits[0].titles, ['A', 'B']);
    assert.ok(Number.isInteger(exits[0].wallSec) && exits[0].wallSec >= 0);
});

test('开新会话显式结清上一条在播会话（旧 exit 只发一次）', () => {
    const t = new ExtWatchTracker();
    const exits = [];
    t.on('exit', (info) => exits.push(info));
    const oldSid = t.beginSession({ kind: 'vlc', titles: ['旧'] });
    const oldChild = new FakeChild(111);
    t.attach(oldChild);
    // taskkill 失败/非 win32 时旧进程 exit 可能不来：新会话开始必须先结清旧的
    const newSid = t.beginSession({ kind: 'potplayer', titles: ['新'] });
    assert.equal(exits.length, 1);
    assert.equal(exits[0].sessionId, oldSid);
    // 旧子进程随后才真正退出：不得重复结算
    oldChild.emit('exit');
    assert.equal(exits.length, 1);
    assert.ok(newSid > oldSid);
});

test('cancel 作废会话且不产生 exit 广播', () => {
    const t = new ExtWatchTracker();
    const exits = [];
    t.on('exit', (info) => exits.push(info));
    const sid = t.beginSession({ kind: 'vlc', titles: [] });
    t.cancel(sid);
    assert.deepEqual(exits, []);
    // 取消后可正常开新会话
    const next = t.beginSession({ kind: 'vlc', titles: [] });
    assert.equal(next, sid + 1);
});

test('spawn error（无 exit 事件）立即结清，避免残留会话被按超长墙钟误结算', () => {
    const t = new ExtWatchTracker();
    const exits = [];
    t.on('exit', (info) => exits.push(info));
    t.beginSession({ kind: 'vlc', titles: [] });
    const child = new FakeChild(0); // spawn 失败常无 pid
    t.attach(child);
    child.emit('error');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].pid, 0);
    // 结清后再次 attach 同一 child 的 exit 不应再触发任何广播
    child.emit('exit');
    assert.equal(exits.length, 1);
});
