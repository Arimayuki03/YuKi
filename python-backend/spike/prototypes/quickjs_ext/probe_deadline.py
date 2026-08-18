import time
import quickjs

ctx = quickjs.Context()
ctx.add_callable('native_ping', lambda: 'pong')

# Deadline semantics: set a short limit, wait past it, then eval again
ctx.set_time_limit(0.3)
time.sleep(0.5)
print('after deadline elapsed, plain eval:', end=' ')
try:
    print(ctx.eval('1+1'))
except Exception as e:
    print('FAILED:', type(e).__name__, str(e)[:80])
print('after deadline elapsed, native eval:', end=' ')
try:
    print(ctx.eval('native_ping()'))
except Exception as e:
    print('FAILED:', type(e).__name__, str(e)[:80])
# re-arm and eval a busy loop: does a fresh eval refresh the deadline?
ctx.set_time_limit(2.0)
t0 = time.time()
try:
    ctx.eval('var t=0; for(var i=0;i<1e9;i++){t+=i;}')
    print('long loop ok')
except Exception as e:
    print('long loop interrupted at %.2f (fresh deadline?): %s' % (time.time() - t0, str(e)[:60]))
ctx.set_time_limit(-1)
print('cleared, native ok:', ctx.eval('native_ping()'))
