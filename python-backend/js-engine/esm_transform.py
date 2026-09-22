# -*- coding: utf-8 -*-
"""ESM → 脚本转换器。

quickjs-ng 的 ctx.module() 不支持命名模块/跨模块 import，且原生回调无法
返回对象，因此统一把 ESM 源码转换为普通脚本：exports 收集到
globalThis.<ns>，import 语句注释掉（宿主库已注入为全局）。

支持的语法（覆盖 CatVod JS spider 与 cat.js 实测形态）：
- export {a as b, c}                     → globalThis.ns.b = a; ...
  （导出名为字符串字面量等非标识符形态时生成 `ns["a-b"] = ...` 括号访问）
- export default function/class/表达式    → globalThis.ns.default = ...
- export (async )?function name          → 保留声明 + 注册
- export class name                      → 保留声明 + 注册
- export const/let/var name = ...        → 保留声明 + 注册（含多声明符
  `export const a = 1, b = 2` 与解构 `export const {a, k: b} = obj` /
  `export const [x, y] = arr`）
- export * from '...' / export * as ns from '...' / export {a as b} from '...'
  （re-export 转发）：仅在多模块模式（dep_map 非空）下支持，转为对依赖
  命名空间的运行时合并/赋值；单文件模式丢弃（本地绑定不存在，若按本地
  导出注册会 ReferenceError）
- import ... from '...'                  → 注释掉

替换顺序约束：re-export 两个分支必须先于本地 export {} 列表执行——
列表分支的正则同样会匹配 re-export 语句的子串，先跑列表分支会吞掉子句
并留下悬空的 from 从句（SyntaxError）。
"""
import json
import logging
import re

logger = logging.getLogger('yuki.jsengine.esm')

# import 剥离正则：与 module_resolver.parse_imports 同款（[^;]*? 跨行子句，
# 遇分号即停）。esm_transform 不 import module_resolver（保持单向依赖：
# module_resolver 只被 quickjs_host 引用），此处复制同款模式。
_RE_IMPORT_FROM = re.compile(
    r'^\s*import\s+([^;]*?)\s+from\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
_RE_IMPORT_SIDE = re.compile(r'^\s*import\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)

_RE_EXPORT_LIST = re.compile(r'export\s*\{([^}]*)\}')
_RE_EXPORT_DEFAULT = re.compile(r'export\s+default\s+')
_RE_EXPORT_FUNC = re.compile(r'export\s+(async\s+function|function)\s+([A-Za-z_$][\w$]*)')
_RE_EXPORT_CLASS = re.compile(r'export\s+(class)\s+([A-Za-z_$][\w$]*)')
_RE_EXPORT_VAR = re.compile(r'export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)')
# 解构声明导出：export const {..} = / export const [..] =（标识符分支接不住的
# 形态）。注意 group(2)（{/[）在 match 内，repl 需把开括号回填到输出。
_RE_EXPORT_DESTRUCT = re.compile(r'export\s+(const|let|var)\s*([{\[])')
# re-export 两形态：export * [as ns] from / export {..} from
_RE_EXPORT_STAR_FROM = re.compile(
    r'export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*[\'"]([^\'"]+)[\'"]\s*;?')
_RE_EXPORT_LIST_FROM = re.compile(
    r'export\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?')
_RE_IDENT = re.compile(r'[A-Za-z_$][\w$]*')
# import 剥离复用解析侧两条正则（_RE_IMPORT_FROM/_RE_IMPORT_SIDE，见下）：
# 旧专用正则的子句段 [^;'"]+ 遇字符串导入名（import { "a-b" as x }）提前
# 截断，残留 `as fn, tag } from ...` 造成 SyntaxError（M2 同源）。
_RE_EXPORT_RESIDUAL = re.compile(r'^\s*export\s+(?![\w$])', re.M)  # 兜底：未覆盖形态的残留 export

# M3：多声明符扫描的「显式续行标记」——顶层换行前末字符为这些时继续跨行
# 收集（`"a" +\n "-b"` / `(x,\n y)` 等）。仅放宽，不收紧：逗号由原逻辑处理，
# 此处把二目运算符/开括号/三元/箭头等也视为续行。
_ASI_CONT = set('+-*/%,&|^!<>=?:~([{')


def _member_expr(obj_expr, prop_name):
    """生成对 obj_expr 的属性访问表达式（M2：非标识符名走括号访问）。

    `export {x as "a-b"} from './d'` / 字符串导入名等怪异形态：点访问
    `ns.a-b` 是非法 JS（语法错误→整模块 eval 失败），须生成
    `ns["a-b"]`。属性名统一 JSON.stringify 转义。
    """
    if re.fullmatch(r'[A-Za-z_$][\w$]*', prop_name):
        return f'{obj_expr}.{prop_name}'
    return f'{obj_expr}[{json.dumps(prop_name, ensure_ascii=False)}]'


def _strip_quotes(name):
    """导出/导入子句片段可能带引号（`export {x as "a-b"}`）：剥掉成对引号。"""
    if len(name) >= 2 and name[0] == name[-1] and name[0] in ('"', "'"):
        return name[1:-1]
    return name


def _skip_string(text, i):
    """text[i] 为引号/反引号，返回跳过整个字面量后的下标（含转义处理）。"""
    quote = text[i]
    i += 1
    n = len(text)
    while i < n and text[i] != quote:
        i += 2 if text[i] == '\\' else 1
    return i + 1


def _is_regex_start(text, i):
    """text[i] == '/' 时判定是否正则字面量起点（而非除法运算符）。

    JS 无法从词法层面绝对区分（`a / b` vs `/re/`），按惯用启发式：前一
    有效字符为 `)`/`]`/`}`、标识符字符或数字时是除法，否则视为正则起点
    （语句起始/`(`、`[`、`{`、`,`、`=`、`:`、运算符、关键字之后）。关键字
    归入"前一字符非标识符尾"靠其尾字符必然是标识符字符的近似——`return`
    后跟 `/` 实为正则但被判为除法属罕见误判，方向安全（少认正则 ≤ 生成
    错误代码）。
    """
    j = i - 1
    while j >= 0 and text[j] in ' \t\r\n':
        j -= 1
    if j < 0:
        return True
    c = text[j]
    return not (c in ')]}' or c.isalnum() or c in '_$')


def _skip_regex(text, i):
    r"""text[i] 为 '/'（已判定为正则起点），返回跳过整个字面量后的下标。

    处理反斜杠转义与字符类 `[...]`（类内 `/` 不终止正则），行终止符视为
    残缺（JS 正则字面量不得跨行），返回 n 让上层自然收尾。
    """
    i += 1
    n = len(text)
    in_class = False
    while i < n:
        c = text[i]
        if c == '\\':
            i += 2
            continue
        if c == '\n' or c == '\r':
            return i     # 残缺：正则不跨行
        if in_class:
            if c == ']':
                in_class = False
        elif c == '[':
            in_class = True
        elif c == '/':
            return i + 1
        i += 1
    return n


def _top_level_comma_split(text):
    """按顶层逗号切分；跳过字符串/模板/注释/正则/括号嵌套。

    用于 `export const a = 1, b = 2` 的声明符列表与解构模式元素切分：
    字面量（含正则，如 `/a,b/.test(s)`）与嵌套结构内的逗号不是顶层逗号，
    不切分。
    """
    parts, buf = [], []
    depth = 0
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        # 注释整体跳过（换行保留，便于调用方做 ASI 判断）
        if c == '/' and nxt == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in ('"', "'", '`'):
            j = _skip_string(text, i)
            buf.append(text[i:j])
            i = j
            continue
        if c == '/' and nxt != '/' and nxt != '*' and _is_regex_start(text, i):
            j = _skip_regex(text, i)
            buf.append(text[i:j])
            i = j
            continue
        # 括号嵌套：() [] {} 同计——解构模式/默认值内的逗号不是顶层
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth = max(0, depth - 1)
        if c == ',' and depth == 0:
            parts.append(''.join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    if buf:
        parts.append(''.join(buf))
    return parts


def _matched_bracket_span(text, i):
    """text[i] 为 {/[/(，返回与之配对的闭括号下标（字符串/注释/正则/嵌套感知）。

    找不到配对（残缺源码）返回 -1。
    """
    open_ch = text[i]
    close_ch = {'{': '}', '[': ']', '(': ')'}[open_ch]
    depth = 0
    in_str = None
    n = len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ('"', "'", '`'):
            in_str = c
        elif c == '/' and nxt == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        elif c == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        elif c == '/' and nxt != '*' and _is_regex_start(text, i):
            i = _skip_regex(text, i)
            continue
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0 and c == close_ch:
                return i
        i += 1
    return -1


def _binding_names_from_destruct(pattern):
    """从解构模式（`{a, k: b, d = 1, ...rest}` / `[x, , y]`）提取绑定名列表。

    - 对象模式：简写名取自身；`k: target` 取 target；默认值穿透；...rest 取
      rest 名；字符串键/计算键 `'k': v` / `[expr]: v` 的 target 是标识符时
      同样可提取（绑定本来就是 v）。
    - 数组模式：逐元素取首个标识符，洞（`,`）跳过，默认值穿透。
    - 无法静态可靠提取的形态（嵌套解构目标 `k: {x}`、`k: [x]`、计算键简写
      `[expr]`）跳过——少注册导出优于生成错误代码。
    """
    names = []
    stripped = pattern.strip()
    is_object = stripped.startswith('{')
    inner = (stripped[1:-1]
             if (stripped.endswith('}') or stripped.endswith(']')) and len(stripped) >= 2
             else stripped)
    for elem in _top_level_comma_split(inner):
        elem = elem.strip()
        if not elem:
            continue   # 数组模式的洞
        if elem.startswith('...'):
            rest = elem[3:].strip()
            if _RE_IDENT.fullmatch(rest):
                names.append(rest)
            continue
        if is_object:
            # 先切顶层冒号（`k: target`），冒号在嵌套内的不算（字符串/注释/
            # 正则内的冒号同理——M1 同源问题）
            depth, colon = 0, -1
            i2, n2 = 0, len(elem)
            in_str = None
            while i2 < n2:
                c2 = elem[i2]
                if in_str:
                    if c2 == '\\':
                        i2 += 2
                        continue
                    if c2 == in_str:
                        in_str = None
                elif c2 in ('"', "'", '`'):
                    in_str = c2
                elif c2 == '/' and i2 + 1 < n2 and elem[i2 + 1] not in '/*' \
                        and _is_regex_start(elem, i2):
                    i2 = _skip_regex(elem, i2)
                    continue
                elif c2 in '([{':
                    depth += 1
                elif c2 in ')]}':
                    depth -= 1
                elif c2 == ':' and depth == 0:
                    colon = i2
                    break
                i2 += 1
            target = elem[colon + 1:] if colon >= 0 else elem
            if target.lstrip().startswith(('[', '{')):
                continue   # 嵌套解构目标/计算键简写：跳过（见上）
        else:
            target = elem
        m = _RE_IDENT.match(target.lstrip())
        if m:
            names.append(m.group(0))
    return names


def _extra_declarator_names(text):
    """`export const a = 1, b = 2;` 首个声明符之后的余文中提取后续绑定名。

    扫描边界：顶层 `;` 结束；顶层换行且前一有效字符不是「显式续行标记」
    （逗号或二目运算符/开括号，M3：`"a" +\n "-b"` 无尾逗号的跨行续写旧
    实现会静默漏注册后续声明符）结束；字符串/模板/注释/正则/括号嵌套整体
    跳过。顶层逗号结尾可跨行续收（逗号后换行继续收集下一声明符）。
    返回绑定名列表（可能是解构名）。
    """
    depth = 0
    i, n = 0, len(text)
    in_str = None
    last_top = ''     # 深度 0 处最近一个非空白字符（ASI 判断用）
    comma_seen = False
    seg_start = 0
    segments = []
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'", '`'):
            j = _skip_string(text, i)
            if depth == 0:
                last_top = c
            i = j
            continue
        if c == '/' and nxt == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        # M1：正则字面量整体跳过（`/a,b/` 内的逗号不是声明符分隔）
        if c == '/' and nxt not in ('/', '*') and _is_regex_start(text, i):
            j = _skip_regex(text, i)
            if depth == 0:
                last_top = text[j - 1] if j > i else c
            i = j
            continue
        if depth == 0:
            if c == ';':
                break
            if c == '\n' and not (last_top == ',' or last_top in _ASI_CONT):
                break   # ASI：声明符列表已结束（末尾无逗号/续行运算符）
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        if c == ',' and depth == 0:
            segments.append(text[seg_start:i])
            seg_start = i + 1
            comma_seen = True
            last_top = ','
            i += 1
            continue
        if depth == 0 and not c.isspace():
            last_top = c
        i += 1
    if not comma_seen:
        return []
    segments.append(text[seg_start:i])
    names = []
    for seg in segments[1:]:   # segments[0] 是已注册首绑定的初始化余文
        seg = seg.strip()
        if not seg:
            continue
        if seg[0] in '([{':
            # 逗号后跟解构声明：`const a = 1, {b, c} = obj;`
            end = _matched_bracket_span(seg, 0)
            if end > 0:
                names.extend(_binding_names_from_destruct(seg[:end + 1]))
            continue
        m = _RE_IDENT.match(seg)
        if m:
            names.append(m.group(0))
    return names


def esm_to_script(src, ns='__MODULE_EXPORTS__', dep_map=None):
    """把 ESM 源码转换为普通脚本。

    dep_map：说明符字面量 → 依赖命名空间全局名（如 {'./dep.js': '__MOD0__'}），
    仅多模块模式传入；re-export 转发据此对依赖命名空间做运行时合并/赋值。
    None 时 re-export 语句被丢弃（单文件模式无依赖命名空间可转发，且绝不
    能按本地导出注册——本地名不存在会 ReferenceError）。
    """
    assignments = []

    def repl_export_star_from(m):
        """export * from 'spec' / export * as ns from 'spec' → 运行时合并。

        export * 语义：转发依赖的全部命名导出，不含 default，且不覆盖本模块
        同名导出（本模块导出优先）。依赖已按拓扑序先执行，命名空间已填充；
        转发合并语句由模块体末尾的 assignments 统一执行，时序同样在依赖
        命名空间填充之后。合并排除 `__fixups__`（回边补赋闭包数组是宿主
        机制，不是导出，见 module_resolver.binding_statements）与
        `default`；own-key 判定不沿原型链（L1：`k in ns` 会误合并继承键）。
        """
        ns_alias, spec = m.group(1), m.group(2)
        dep = (dep_map or {}).get(spec)
        if dep is None:
            return ''   # 单文件模式/未知说明符：丢弃（调用方已知取舍）
        if ns_alias:
            assignments.append(f'globalThis.{ns}.{ns_alias} = {dep};')
            return ''
        assignments.append(
            'Object.keys(%s).forEach(function(k){'
            'if (k !== "default" && k !== "__fixups__" && '
            '!Object.prototype.hasOwnProperty.call(globalThis.%s, k)) '
            'globalThis.%s[k] = %s[k];});' % (dep, ns, ns, dep))
        return ''

    def repl_export_list_from(m):
        """export {a as b, c} from 'spec' → 定向转发指定导出。

        赋值语句在模块体执行后统一注册，此时依赖命名空间已填充；若依赖
        缺失该导出，取到 undefined（对齐 ESM 链接失败场景的宽松化处理）。
        导出名为字符串字面量等非标识符形态时走括号访问（M2）。
        """
        clause, spec = m.group(1), m.group(2)
        dep = (dep_map or {}).get(spec)
        if dep is None:
            return ''
        for part in clause.split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                src_name, exported = [x.strip() for x in part.split(' as ', 1)]
            else:
                src_name = exported = part
            src_name = _strip_quotes(src_name)
            exported = _strip_quotes(exported)
            assignments.append(
                f'{_member_expr(f"globalThis.{ns}", exported)} = '
                f'{_member_expr(dep, src_name)};')
        return ''

    def repl_export_list(m):
        """本地 export {a as b, c}：导出名非标识符时走括号访问（M2）。"""
        for part in m.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                local, exported = [x.strip() for x in part.split(' as ', 1)]
            else:
                local = exported = part
            exported = _strip_quotes(exported)
            assignments.append(
                f'{_member_expr(f"globalThis.{ns}", exported)} = {local};')
        return ''

    # 顺序敏感：re-export 两分支必须先于本地 export {} 列表（见模块 docstring）
    out = _RE_EXPORT_STAR_FROM.sub(repl_export_star_from, src)
    out = _RE_EXPORT_LIST_FROM.sub(repl_export_list_from, out)
    out = _RE_EXPORT_LIST.sub(repl_export_list, out)

    def repl_export_func(m):
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_FUNC.sub(repl_export_func, out)

    def repl_export_class(m):
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_CLASS.sub(repl_export_class, out)

    def repl_export_var(m):
        # 多声明符：`export const a = 1, b = 2, c = 3`——首绑定由 match 注册，
        # 余文（match 之后到声明列表结束）里的每个顶层逗号段再各注册一个绑定
        for name in _extra_declarator_names(out[m.end():]):
            assignments.append(f'globalThis.{ns}.{name} = {name};')
        assignments.append(f'globalThis.{ns}.{m.group(2)} = {m.group(2)};')
        return f'{m.group(1)} {m.group(2)}'

    out = _RE_EXPORT_VAR.sub(repl_export_var, out)

    def repl_export_destruct(m):
        """解构声明导出：export const {a, k: b} = obj; / export const [x, y] = arr;

        只剥掉 export 前缀、保留完整解构语句（JS 自己完成解构赋值），另从
        模式静态提取绑定名逐一注册到命名空间。group(2)（开括号）在 match
        内，替换文本必须原样回填，否则解构模式残缺成 SyntaxError。
        """
        open_ch = m.group(2)
        rest = out[m.end():]
        end = _matched_bracket_span(open_ch + rest, 0)
        if end > 0:
            # end 是「open_ch + rest」整体串中闭括号下标，换算回 rest 内的偏移
            pattern = (open_ch + rest)[:end + 1]
            for name in _binding_names_from_destruct(pattern):
                assignments.append(f'globalThis.{ns}.{name} = {name};')
        return f'{m.group(1)} {open_ch}'

    out = _RE_EXPORT_DESTRUCT.sub(repl_export_destruct, out)
    out = _RE_EXPORT_DEFAULT.sub(f'globalThis.{ns}.default = ', out)
    # import 剥离（正则与 parse_imports 同款，见文件头说明）：
    # 子句内字符串导入名（import { "a-b" as x }）由 [^;]*? 段覆盖
    out = _RE_IMPORT_FROM.sub('/* import stripped by host */', out)
    out = _RE_IMPORT_SIDE.sub('/* import stripped by host */', out)
    out = _RE_EXPORT_RESIDUAL.sub('', out)  # 兜底清除未覆盖形态的 export 前缀

    return (f'globalThis.{ns} = globalThis.{ns} || {{}};\n'
            + out + '\n' + '\n'.join(assignments) + '\n')
