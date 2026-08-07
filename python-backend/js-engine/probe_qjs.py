# -*- coding: utf-8 -*-
"""探测 quickjs-ng 的 API：模块支持 / 函数注册 / Object 调用。"""
import quickjs as qjs

print('version:', getattr(qjs, '__version__', '?'))
print('exports:', [x for x in dir(qjs) if not x.startswith('_')])

ctx = qjs.Context()

# 1. 基础 eval
print('eval:', ctx.eval('1+2'))

# 2. Python 函数注册 + 同步回调
def native_add(a, b):
    return a + b

try:
    ctx.add_callable('pyAdd', native_add)
    print('add_callable ok')
except AttributeError:
    ctx.add_global_callable('pyAdd', native_add)
    print('add_global_callable ok')
print('callable:', ctx.eval('pyAdd(3,4)'))

# 3. ESM 模块支持？
for name in ('eval_module', 'module', 'add_module', 'import_module', 'compile_module'):
    print('has', name, '=', hasattr(ctx, name))

# 4. Object 获取与调用
ctx.eval('globalThis.__S = { f: (x) => JSON.stringify({got: x}) };')
obj = ctx.get('__S')
print('obj type:', type(obj))
f = ctx.get('__S.f')
print('call f:', f('hello'))

# 5. 异常
try:
    ctx.eval('throw new Error("boom")')
except Exception as e:
    print('exception type:', type(e).__name__, str(e)[:60])
