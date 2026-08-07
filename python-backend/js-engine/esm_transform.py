# -*- coding: utf-8 -*-
"""ESM → 脚本转换器。

quickjs-ng 的 ctx.module() 不支持命名模块/跨模块 import，且原生回调无法
返回对象，因此统一把 ESM 源码转换为普通脚本：exports 收集到
globalThis.<ns>，import 语句注释掉（宿主库已注入为全局）。

支持的语法（覆盖 CatVod JS spider 与 cat.js 实测形态）：
- export {a as b, c}                     → globalThis.ns.b = a; ...
- export default function/class/表达式    → globalThis.ns.default = ...
- export (async )?function name          → 保留声明 + 注册
- export class name                      → 保留声明 + 注册
- export const/let/var name = ...        → 保留声明 + 注册
- import ... from '...'                  → 注释掉
"""
import re

_RE_EXPORT_LIST = re.compile(r'export\s*\{([^}]*)\}')
_RE_EXPORT_DEFAULT = re.compile(r'export\s+default\s+')
_RE_EXPORT_FUNC = re.compile(r'export\s+(async\s+function|function)\s+([A-Za-z_$][\w$]*)')
_RE_EXPORT_CLASS = re.compile(r'export\s+(class)\s+([A-Za-z_$][\w$]*)')
_RE_EXPORT_VAR = re.compile(r'export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)')
_RE_IMPORT = re.compile(r'^\s*import\s+(?:[^;\'"]+from\s+)?[\'\"][^\'\"]+[\'\"]\s*;?', re.M)
_RE_EXPORT_RESIDUAL = re.compile(r'^\s*export\s+(?![\w$])', re.M)  # 兜底：未覆盖形态的残留 export


def esm_to_script(src, ns='__MODULE_EXPORTS__'):
    assignments = []

    def repl_export_list(m):
        for part in m.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                local, exported = [x.strip() for x in part.split(' as ', 1)]
            else:
                local = exported = part
            assignments.append(f'globalThis.{ns}.{exported} = {local};')
        return ''

    out = _RE_EXPORT_LIST.sub(repl_export_list, src)

    def repl_export_func(m):
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_FUNC.sub(repl_export_func, out)

    def repl_export_class(m):
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_CLASS.sub(repl_export_class, out)

    def repl_export_var(m):
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_VAR.sub(repl_export_var, out)
    out = _RE_EXPORT_DEFAULT.sub(f'globalThis.{ns}.default = ', out)
    out = _RE_IMPORT.sub('/* import stripped by host */', out)
    out = _RE_EXPORT_RESIDUAL.sub('', out)  # 兜底清除未覆盖形态的 export 前缀

    return (f'globalThis.{ns} = globalThis.{ns} || {{}};\n'
            + out + '\n' + '\n'.join(assignments) + '\n')
