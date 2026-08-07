# -*- coding: utf-8 -*-
"""探测二：ctx.module / Function 调用 / cat.js 大文件兼容性。"""
import os
import quickjs as qjs

ctx = qjs.Context()

# 1. 命名模块 + import
try:
    ctx.module("export const a = 41; export function inc(x){ return x + 1; }", name='m1')
    r = ctx.eval("import('m1').then(m => m.a + 1)")
    print('dynamic import result:', r)
except Exception as e:
    print('module/import failed:', type(e).__name__, str(e)[:120])

# 2. 全局取函数并调用
ctx.eval("globalThis.f1 = (x) => 'got:' + x;")
f = ctx.get('f1')
print('get f1 type:', type(f))
try:
    print('call f1:', f('abc'))
except Exception as e:
    print('call f1 failed:', type(e).__name__, str(e)[:80])
    g = ctx.eval('f1')
    print('eval f1 type:', type(g))
    print('call via eval:', g('abc'))

# 3. Object 方法调用
ctx.eval("globalThis.o = { m(x){ return x * 2; } };")
obj = ctx.get('o')
print('Object methods:', [x for x in dir(obj) if not x.startswith('_')])
try:
    print('o.m(21) =', obj.m(21))
except Exception as e:
    print('o.m failed:', type(e).__name__, str(e)[:80])

# 4. cat.js（474KB 压缩库）可否直接 eval
cat = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                   'apk_analysis', 'extracted', 'assets', 'js', 'lib', 'cat.js')
cat = os.path.normpath(cat)
print('cat.js exists:', os.path.exists(cat))
if os.path.exists(cat):
    src = open(cat, encoding='utf-8').read()
    print('cat.js len:', len(src), 'first 120:', src[:120].replace('\n', ' '))
    try:
        ctx.eval(src)
        print('cat.js eval OK')
        for g in ('$', 'cheerio', 'CryptoJS', 'crypto', 'GBK', 'gbk', 'similarity', 'md5'):
            try:
                v = ctx.eval(f"typeof {g}")
                print(f'  typeof {g} =', v)
            except Exception as e:
                print(f'  typeof {g} err', str(e)[:60])
    except Exception as e:
        print('cat.js eval FAILED:', type(e).__name__, str(e)[:200])
