// 组件测试：async-session.js（AsyncSingleFlight / AsyncSerialQueue）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { AsyncSingleFlight, AsyncSerialQueue } = require('../../src/main/async-session');

/** 可手动 resolve 的延迟 Promise。 */
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// ---------------------------------------------------------------- AsyncSingleFlight

test('singleFlight: 同 key 并发只执行一次，共享结果', async () => {
    const flight = new AsyncSingleFlight();
    let calls = 0;
    const d = deferred();
    const fn = () => { calls++; return d.promise; };

    const p1 = flight.run('k', fn);
    const p2 = flight.run('k', fn);
    const p3 = flight.run('k', fn);
    await Promise.resolve(); // run() 经微任务调 fn，先 flush 再断言
    assert.equal(calls, 1, '同 key 只应执行一次');
    assert.equal(flight.size(), 1);

    d.resolve('ok');
    assert.deepStrictEqual(await Promise.all([p1, p2, p3]), ['ok', 'ok', 'ok']);
    assert.equal(flight.size(), 0, '完成后应释放');
});

test('singleFlight: 不同 key 各自执行', async () => {
    const flight = new AsyncSingleFlight();
    const seen = [];
    const d1 = deferred(), d2 = deferred();
    const p1 = flight.run('a', () => { seen.push('a'); return d1.promise; });
    const p2 = flight.run('b', () => { seen.push('b'); return d2.promise; });
    await Promise.resolve();
    assert.deepStrictEqual(seen, ['a', 'b']);
    assert.equal(flight.size(), 2);
    d1.resolve(1); d2.resolve(2);
    assert.equal(await p1, 1);
    assert.equal(await p2, 2);
});

test('singleFlight: 完成后再次调用重新执行', async () => {
    const flight = new AsyncSingleFlight();
    let calls = 0;
    const p1 = flight.run('k', async () => { calls++; return 1; });
    assert.equal(await p1, 1);
    const p2 = flight.run('k', async () => { calls++; return 2; });
    assert.equal(await p2, 2);
    assert.equal(calls, 2);
});

test('singleFlight: 失败也共享且释放，下次重新执行', async () => {
    const flight = new AsyncSingleFlight();
    let calls = 0;
    const d = deferred();
    const p1 = flight.run('k', () => { calls++; return d.promise; });
    const p2 = flight.run('k', () => { calls++; return d.promise; });
    d.reject(new Error('boom'));
    await assert.rejects(p1, /boom/);
    await assert.rejects(p2, /boom/);
    assert.equal(calls, 1);
    assert.equal(flight.size(), 0);
    // 失败释放后，下一次可重新执行
    const p3 = flight.run('k', async () => { calls++; return 'again'; });
    assert.equal(await p3, 'again');
    assert.equal(calls, 2);
});

test('singleFlight: has/clear', async () => {
    const flight = new AsyncSingleFlight();
    const d = deferred();
    flight.run('k', () => d.promise);
    assert.equal(flight.has('k'), true);
    flight.clear();
    assert.equal(flight.has('k'), false);
    d.resolve();
});

// ---------------------------------------------------------------- AsyncSerialQueue

test('serialQueue: 任务串行按入队顺序执行', async () => {
    const q = new AsyncSerialQueue();
    const order = [];
    const mk = (n, delay) => () => new Promise((res) => setTimeout(() => { order.push(n); res(n); }, delay));
    const p1 = q.push(mk(1, 30));
    const p2 = q.push(mk(2, 5));
    const p3 = q.push(mk(3, 1));
    assert.deepEqual(await Promise.all([p1, p2, p3]), [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3], '严格按入队顺序串行执行');
});

test('serialQueue: 前一个失败不影响后续', async () => {
    const q = new AsyncSerialQueue();
    const p1 = q.push(async () => { throw new Error('first fails'); });
    const p2 = q.push(async () => 'ok2');
    await assert.rejects(p1, /first fails/);
    assert.equal(await p2, 'ok2');
});
