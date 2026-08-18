import time
import quickjs

ctx = quickjs.Context()

# 8. time limit units 0.5
ctx.set_time_limit(0.5)
t0 = time.time()
try:
    ctx.eval('var t = 0; for (var i = 0; i < 1e9; i++) { t += i; }')
    print('8. NO INTERRUPT')
except Exception as e:
    print('8. interrupted: ' + type(e).__name__ + ' elapsed=%.3f' % (time.time() - t0))
ctx.set_time_limit(-1)

# 9. per-eval fresh budget or cumulative?
ctx.set_time_limit(0.5)
t0 = time.time()
for i in range(3):
    try:
        ctx.eval('var t = 0; for (var j = 0; j < 5e7; j++) { t += j; }')
        print('9. eval %d ok' % i)
    except Exception as e:
        print('9. eval %d interrupted after %.3f total: %s' % (i, time.time() - t0, e))
        break
ctx.set_time_limit(-1)

# 10. callable returning dict
def callable_dict():
    return {'a': 1}
ctx.add_callable('native_dict', callable_dict)
try:
    print('10. dict callable:', ctx.eval('JSON.stringify(native_dict())'))
except Exception as e:
    print('10. dict FAILED:', type(e).__name__, e)

# 11. timers / microtasks globals
print('11. setTimeout:', ctx.eval('typeof globalThis.setTimeout'), '| setInterval:', ctx.eval('typeof globalThis.setInterval'), '| queueMicrotask:', ctx.eval('typeof globalThis.queueMicrotask'), '| Promise:', ctx.eval('typeof globalThis.Promise'), '| fetch:', ctx.eval('typeof globalThis.fetch'))

# 12. async fn + pending job pump with time limit armed? (callable inside async under limit)
ctx.set_time_limit(2.0)
code = '(async function () { var a = await Promise.resolve(1); var b = await Promise.resolve(2); return a + b; })()'
try:
    ctx.set('__P__', ctx.eval(code))
    t0 = time.time()
    n = 0
    while ctx.execute_pending_job():
        n += 1
        if time.time() - t0 > 5:
            break
    print('12. pumped %d jobs, result:' % n, ctx.get('__P__'))
except Exception as e:
    print('12. async limit FAILED:', type(e).__name__, str(e)[:120])
ctx.set_time_limit(-1)

# 12b. async fn that calls native while limit armed
ctx.set_time_limit(2.0)
code2 = '(async function () { var a = await Promise.resolve(1); var x = native_add(a, 40); return x; })()'
try:
    ctx.set('__P__', ctx.eval(code2))
    n = 0
    while ctx.execute_pending_job():
        n += 1
    print('12b. result:', ctx.get('__P__'))
except Exception as e:
    print('12b. async native under limit FAILED:', type(e).__name__, str(e)[:140])
ctx.set_time_limit(-1)

# 13. memory limit behavior (small limit)
try:
    ctx.set_memory_limit(1 * 1024 * 1024)
    try:
        ctx.eval('var a = []; for (var i = 0; i < 1000000; i++) a.push(i);')
        print('13. alloc ok (no limit hit)')
    except Exception as e:
        print('13. alloc limited:', type(e).__name__, str(e)[:120])
except Exception as e:
    print('13. set_memory_limit FAILED:', type(e).__name__, e)
