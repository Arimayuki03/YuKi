import time
import quickjs

ctx = quickjs.Context()
ctx.add_callable('native_add', lambda a, b: a + b)

ctx.set_time_limit(1.0)
print('1. calling JS fn through Object (eval-created) with limit armed:')
f = ctx.eval('(function(){ return native_add(1, 2); })')
print('   f() =', f())

print('2. infinite loop inside a JS fn called through Object:')
g = ctx.eval('(function(){ var t = 0; while (true) { t++; } })')
t0 = time.time()
try:
    g()
    print('   NO INTERRUPT (bad)')
except Exception as e:
    print('   interrupted: %s in %.3f' % (type(e).__name__, time.time() - t0))
ctx.set_time_limit(-1)

print('3. direct callable reference (ctx.get) — same as ctx.eval creation?')
ctx.set_time_limit(1.0)
h = ctx.eval('(function(){ return native_add(10, 32); })')
print('   h() =', h())
ctx.set_time_limit(-1)

print('4. does eval-created ASYNC fn with native call in continuation work under armed limit?')
ctx.set_time_limit(2.0)
p = ctx.eval('(async function(){ var a = await Promise.resolve(3); return native_add(a, 4); })')
ctx.set('__R__', None)
p().then(lambda v: ctx.set('__R__', v) if False else None)  # python-lambda callables can't be .then callbacks
print('   (skip python callback in .then; use JS capture)')
ctx.set_time_limit(-1)

print('5. JS-side capture wrapper around native call, under armed limit:')
ctx.set_time_limit(2.0)
ctx.eval('globalThis.__CAP__ = {};')
q = ctx.eval('(function(){ var pm = (async function(){ var a = await Promise.resolve(3); return native_add(a, 4); })(); pm.then(function(v){ __CAP__.v = v; }, function(e){ __CAP__.e = String(e && e.message || e); }); return pm; })')
pm = q()
n = 0
t0 = time.time()
while ctx.execute_pending_job():
    n += 1
    if time.time() - t0 > 6:
        break
print('   pumped %d jobs, CAP =' % n, ctx.eval('JSON.stringify(__CAP__)'))
ctx.set_time_limit(-1)

print('6. get() instead of eval for function creation:')
ctx.set_time_limit(1.0)
ctx.eval('globalThis.__FN__ = function(){ return native_add(5, 6); };')
fn = ctx.get('__FN__')
print('   fn() =', fn())
ctx.set_time_limit(-1)

print('7. __VPC_CALL__-style: arg passing + string return under armed limit')
ctx.set_time_limit(1.0)
ctx.eval('globalThis.__CALL__ = function(method, argsJson){ return JSON.stringify({m: method, len: (argsJson||"").length}); };')
c = ctx.get('__CALL__')
print('   call =', c('home', '["a","b"]'))
ctx.set_time_limit(-1)
