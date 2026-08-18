import time
import threading
import quickjs

# GIL during eval: does a busy-loop eval block the main thread?
ctx = quickjs.Context()
flag = {'done': False}
def worker():
    try:
        ctx.eval('while(true){}')
    except Exception as e:
        flag['err'] = str(e)
    flag['done'] = True

t = threading.Thread(target=worker, daemon=True)
t.start()
time.sleep(0.2)
t0 = time.time()
# can the main thread run Python while the eval spins?
time.sleep(0.5)
main_ok = time.time() - t0 < 0.9
print('main thread responsive while eval busy-loop: ', main_ok)
# try to interrupt from another thread via set_time_limit (not thread-safe, just observe)
try:
    ctx.set_time_limit(1.0)
    print('set_time_limit from other thread: ok (returned)')
except Exception as e:
    print('set_time_limit from other thread failed:', type(e).__name__, str(e)[:80])
time.sleep(1.5)
print('worker done:', flag)

# memory limit vs callable interplay
ctx2 = quickjs.Context()
ctx2.add_callable('n', lambda x: x + 1)
ctx2.set_memory_limit(8 * 1024 * 1024)
print('callable under memory limit:', ctx2.eval('n(41)'))
try:
    ctx2.eval('var a = []; for (var i = 0; i < 2000000; i++) a.push(i);')
    print('big alloc ok')
except Exception as e:
    print('big alloc limited:', type(e).__name__, str(e)[:60])
print('callable still ok after OOM:', ctx2.eval('n(1)'))
