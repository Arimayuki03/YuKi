# -*- coding: utf-8 -*-
"""探测三：ctx.module 正确用法、exports 访问、Promise/await、原生回调。"""
import quickjs as qjs

print('Context attrs:', [x for x in dir(qjs.Context) if not x.startswith('_')])

ctx = qjs.Context()

# 1. module 定位传参
mods = {}
for attempt, call in enumerate([
    lambda: ctx.module("export const a = 1; export default 9;"),
    lambda: ctx.module("export const a = 1; export default 9;", 'm1'),
]):
    try:
        r = call()
        print(f'attempt{attempt} OK, ret type:', type(r))
        mods[attempt] = r
        break
    except Exception as e:
        print(f'attempt{attempt} failed:', type(e).__name__, str(e)[:100])

# 2. 跨模块静态 import
try:
    r = ctx.module("import * as t from 'm1'; globalThis.__T = t.a + (t.default||0);", 'm2')
    print('static import eval:', ctx.eval('__T'))
except Exception as e:
    print('static import failed:', type(e).__name__, str(e)[:150])

# 3. module 返回值是否是 namespace / 可否取属性
m = mods.get(0) or mods.get(1)
if m is not None:
    print('module obj dir:', [x for x in dir(m) if not x.startswith('_')])
    try:
        print('module json:', str(m.json())[:100])
    except Exception as e:
        print('module json failed:', str(e)[:80])

# 4. await / pending job
try:
    r = ctx.eval("(async () => 40 + await Promise.resolve(2))()")
    print('async eval ret:', r, type(r))
    for name in ('execute_pending_job', 'run_gc', 'loop'):
        if hasattr(ctx, name):
            print('has', name)
    if hasattr(ctx, 'execute_pending_job'):
        while ctx.execute_pending_job():
            pass
except Exception as e:
    print('async failed:', type(e).__name__, str(e)[:100])

# 5. 原生函数返回 dict → JS 对象？
def native_http(url, options):
    return {'code': 200, 'content': 'BODY:' + str(url), 'headers': {'k': 'v'}}

ctx.add_callable('_http', native_http)
r = ctx.eval("JSON.stringify(_http('http://x', {}))")
print('native dict return:', r)

# 6. JSException 信息
try:
    ctx.eval("nonexist_thing()")
except qjs.JSException as e:
    print('JSException:', str(e)[:120])
