import time
import json
import quickjs

ctx = quickjs.Context()
def native_echo(v):
    return 'PY:' + str(v)
ctx.add_callable('native_echo', native_echo)

def pump(max_rounds=2000, cap=10):
    t0 = time.time()
    n = 0
    while ctx.execute_pending_job():
        n += 1
        if n > max_rounds or time.time() - t0 > cap:
            break
    return n, time.time() - t0

W = 'globalThis.__W__ = {value: undefined, error: undefined, pending: 0};'

def run_async(desc, code, arm_limit):
    if arm_limit:
        ctx.set_time_limit(2.0)
    else:
        ctx.set_time_limit(-1)
    ctx.eval(W)
    prom = ctx.eval(code)
    ctx.set('__P__', prom)
    ctx.eval('__W__.pending = 1; Promise.resolve(__P__).then(function(v){ __W__.value = v; __W__.pending = 0; }, function(e){ __W__.error = String(e && e.message || e); __W__.pending = 0; });')
    n, dt = pump()
    state = ctx.eval('JSON.stringify({value: __W__.value, error: __W__.error, pending: __W__.pending})')
    print(f'{desc}: jobs={n} dt={dt:.3f}s state={state}')
    ctx.set_time_limit(-1)

run_async('A. async native echo, limit ARMED', '(async function(){ return await Promise.resolve("x").then(native_echo); })()', True)
run_async('B. async native echo, limit clear', '(async function(){ return await Promise.resolve("x").then(native_echo); })()', False)

print('C. busy loop inside pending job, limit armed:')
ctx.set_time_limit(1.0)
ctx.eval(W)
ctx.set('__P__', ctx.eval('(async function(){ await Promise.resolve(1); var t = 0; while (true) { t++; } })()'))
ctx.eval('__W__.pending = 1; Promise.resolve(__P__).then(function(v){ __W__.value = v; __W__.pending = 0; }, function(e){ __W__.error = String(e && e.message || e); __W__.pending = 0; });')
t0 = time.time()
n = 0
interrupted = False
while ctx.execute_pending_job():
    n += 1
    if time.time() - t0 > 5:
        interrupted = True
        break
print('   jobs=%d dt=%.3f interrupted=%s %s' % (n, time.time() - t0, interrupted, ctx.eval('JSON.stringify(__W__)')))
ctx.set_time_limit(-1)

print('D. sync native under limit:', end=' ')
ctx.set_time_limit(1.0)
try:
    ctx.eval('native_echo("direct")')
    print('OK (unexpected)')
except Exception as e:
    print('FAILED:', type(e).__name__, str(e)[:80])
ctx.set_time_limit(-1)

print('E. promise-wrapped sync method w/ native, limit armed:')
ctx.set_time_limit(2.0)
ctx.eval(W)
ctx.eval('globalThis.__M__ = function(){ return native_echo("wrapped"); };')
ctx.eval('__W__.pending = 1; Promise.resolve().then(function(){ try { __W__.value = __M__(); } catch(e){ __W__.error = String(e && e.message || e); } __W__.pending = 0; });')
n, dt = pump()
print('   jobs=%d dt=%.3f' % (n, dt), ctx.eval('JSON.stringify(__W__)'))
ctx.set_time_limit(-1)

print('F. per-eval time budget:')
ctx.set_time_limit(0.4)
t0 = time.time()
try:
    ctx.eval('var t=0; for (var i=0;i<1e8;i++){t+=i;}')
    print('  F1. eval ok')
except Exception as e:
    print('  F1. interrupted at %.3f: %s' % (time.time() - t0, e))
try:
    ctx.eval('var t=0; for (var i=0;i<1e8;i++){t+=i;}')
    print('  F2. eval ok (fresh budget?)')
except Exception as e:
    print('  F2. interrupted at %.3f (cumulative?): %s' % (time.time() - t0, type(e).__name__, str(e)[:60]))
ctx.set_time_limit(-1)
