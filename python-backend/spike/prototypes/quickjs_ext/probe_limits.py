# -*- coding: utf-8 -*-
"""Probe quickjs-ng runtime constraints that drive the drpy engine design."""
import json
import time
import sys

import quickjs

ctx = quickjs.Context()


def callable_add(a, b):
    return a + b


ctx.add_callable('native_add', callable_add)

print('### 1. baseline eval + callable')
print('eval 1+2:', ctx.eval('1 + 2'))
print('callable:', ctx.eval('native_add(3, 4)'))

print('\n### 2. time_limit set -> can JS still call into Python?')
ctx.set_time_limit(1.0)
try:
    print('eval callable with limit:', ctx.eval('native_add(1, 2)'))
except Exception as e:
    print('FAILED:', type(e).__name__, e)
try:
    print('eval plain with limit:', ctx.eval('1 + 1'))
except Exception as e:
    print('plain FAILED:', type(e).__name__, e)

print('\n### 3. infinite loop interrupt under time limit')
t0 = time.time()
try:
    ctx.eval('while(true){}')
    print('NO INTERRUPT (bad)')
except Exception as e:
    print('interrupted ok:', type(e).__name__, str(e)[:120], 'elapsed=%.3fs' % (time.time() - t0))

print('\n### 4. clear time limit (0)')
try:
    ctx.set_time_limit(0)
    print('set_time_limit(0) ok')
except Exception as e:
    print('set_time_limit(0) FAILED:', type(e).__name__, e)
try:
    print('eval callable after clear:', ctx.eval('native_add(5, 6)'))
except Exception as e:
    print('callable after clear FAILED:', type(e).__name__, e)

print('\n### 5. negative time limit')
try:
    ctx.set_time_limit(-1)
    print('set_time_limit(-1) ok, callable:', ctx.eval('native_add(7, 8)'))
except Exception as e:
    print('set_time_limit(-1) FAILED:', type(e).__name__, e)

print('\n### 6. memory stats')
try:
    m = ctx.memory()
    print('memory():', type(m).__name__, m)
except Exception as e:
    print('memory() FAILED:', type(e).__name__, e)

print('\n### 7. pending jobs / microtasks')
print('execute_pending_job with nothing:', ctx.execute_pending_job())
r = ctx.eval('''
(function () {
    var done = false;
    globalThis.__RES__ = undefined;
    Promise.resolve('v').then(function (x) { globalThis.__RES__ = x; done = true; });
    return 'scheduled';
})()
''')
print('eval ret:', r)
print('before drain __RES__ =', ctx.eval('typeof globalThis.__RES__ === "undefined" ? "<undefined>" : globalThis.__RES__'))
n = 0
while ctx.execute_pending_job():
    n += 1
print('after drain, jobs executed:', n, '__RES__ =', ctx.eval('globalThis.__RES__'))

print('\n### 8. set_time_limit units (0.5s -> ~0.5s wall?)')
ctx.set_time_limit(0.5)
t0 = time.time()
try:
    ctx.eval('var t = 0; for (var i = 0; i < 1e9; i++) { t += i; }')
except Exception as e:
    print('interrupted in %.3fs (%s)' % (time.time() - t0, type(e).__name__, str(e)[:80]))
ctx.set_time_limit(0)

print('\n### 9. time limit is per-eval fresh budget or cumulative?')
ctx.set_time_limit(0.5)
t0 = time.time()
for i in range(5):
    try:
        ctx.eval('var t = 0; for (var j = 0; j < 5e7; j++) { t += j; }')
        print('eval %d ok' % i)
    except Exception as e:
        print('eval %d interrupted after %.3fs total' % (i, time.time() - t0))
        break
ctx.set_time_limit(0)

print('\n### 10. callable returning dict (instead of str)')
def callable_dict():
    return {'a': 1}
ctx.add_callable('native_dict', callable_dict)
try:
    print(ctx.eval('JSON.stringify(native_dict())'))
except Exception as e:
    print('dict FAILED:', type(e).__name__, e)

print('\n### 11. do timers exist?')
print('typeof setTimeout:', ctx.eval('typeof globalThis.setTimeout'))
print('typeof setInterval:', ctx.eval('typeof globalThis.setInterval'))
print('typeof queueMicrotask:', ctx.eval('typeof globalThis.queueMicrotask'))

print('\n### 12. time limit with setTimeout-ish microtask pump (async fn)')
ctx.set_time_limit(2.0)
code = '''
(async function () {
    var a = await Promise.resolve(1);
    var b = await Promise.resolve(2);
    return a + b;
})()
'''
try:
    ctx.set('__P__', ctx.eval(code))
    t0 = time.time()
    n = 0
    while ctx.execute_pending_job():
        n += 1
        if time.time() - t0 > 5:
            break
    print('pumped %d jobs, result:' % n, ctx.get('__P__'))
except Exception as e:
    print('async limit FAILED:', type(e).__name__, str(e)[:120])
ctx.set_time_limit(0)