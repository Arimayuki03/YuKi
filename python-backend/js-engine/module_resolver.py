# -*- coding: utf-8 -*-
"""ESM 多模块解析器：递归抓取远程 import 依赖并拓扑排序。

quickjs-ng 不支持跨模块 import，因此把入口模块及其依赖树抓取下来，
按依赖优先顺序展平为脚本序列，交给宿主逐模块以命名空间注入执行。

仅覆盖 CatVod/TVBox JS spider 实测形态：
- import {A, B as C} from './x.js'     命名导入
- import * as X from '../lib/y.js'     命名空间导入
- import D from './z.js'               默认导入（可与命名混写）
- import './side.js'                   副作用导入
动态 import() 与 http(s) 绝对依赖同样支持；循环依赖按先到者截断。
"""
import time
import logging
import re
import json
import threading
from urllib.parse import urljoin

logger = logging.getLogger('yuki.jsengine.resolver')

# 顶层 import 语句（整行，含多行命名列表不常见，按单行处理）
# high#8：命名列表可跨行书写（`import {\n A,\n B\n} from ...`），无 DOTALL 时
# 匹配不到该依赖，esm_transform 剥掉 import 后运行时 ReferenceError、站点静默
# 不可用。改为 [^;]*? 跨行匹配：遇到分号即停（import 子句内不会出现裸分号），
# 避免贪婪 `.+?` + DOTALL 在罕见形态下吞掉过多代码。
_RE_IMPORT_FROM = re.compile(
    r'^\s*import\s+([^;]*?)\s+from\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
_RE_IMPORT_SIDE = re.compile(r'^\s*import\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
# re-export 依赖抓取：export * from / export * as ns from / export {..} from。
# re-export 没有本地绑定（clause 记 None），但依赖模块必须被抓取并纳入拓扑序，
# 否则转发在运行时引用不到依赖命名空间。
_RE_EXPORT_FROM = re.compile(
    r'^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
# 导出子句内的 re-export 对（源名/导出名）：export 名为字符串字面量的怪异形态
# 由 esm_transform 处理，此处仅用于依赖抓取。
_RE_NAMESPACE = re.compile(r'^\*\s*as\s+([\w$]+)$')

MAX_MODULES = 40  # 单 spider 依赖模块数上限，防异常依赖树
MODULE_CACHE_TTL = 3600  # 模块二级缓存 TTL (1小时)

# 内存二级持久缓存：url -> (src, timestamp)
_GLOBAL_MODULE_CACHE = {}
# 条数上限：value 是整份模块源码（单条可达数 MB），且每个 SiteWorker 是独立进程、
# 各自持一份，8 Worker 并发时内存按 8 倍放大。原先完全无上限——配置多个 ESM 多模块
# 源就会单调增长到进程退出。触顶按「先清过期 → 再按写入序淘汰」收敛。
_GLOBAL_MODULE_CACHE_MAX = 128
# 读改写保护：build 名义上单线程，但 fetch_text 走网络 IO，字典裸奔不划算
_CACHE_LOCK = threading.Lock()


def fetch_module_cached(url, fetch_text, ttl=MODULE_CACHE_TTL):
    """带 TTL 的全局模块网络拉取与二级缓存，避免重复解析与跨站点拉取开销。"""
    now = time.time()
    with _CACHE_LOCK:
        cached = _GLOBAL_MODULE_CACHE.get(url)
        if cached and (now - cached[1]) < ttl:
            return cached[0]

    src = fetch_text(url)
    if src:
        with _CACHE_LOCK:
            _GLOBAL_MODULE_CACHE[url] = (src, now)
            if len(_GLOBAL_MODULE_CACHE) > _GLOBAL_MODULE_CACHE_MAX:
                # 过期条目先清（无损），仍超限才按写入时间从早到晚删
                for k in [k for k, (_s, ts) in _GLOBAL_MODULE_CACHE.items()
                          if (now - ts) >= ttl]:
                    _GLOBAL_MODULE_CACHE.pop(k, None)
                overflow = len(_GLOBAL_MODULE_CACHE) - _GLOBAL_MODULE_CACHE_MAX
                for k in list(_GLOBAL_MODULE_CACHE)[:max(0, overflow)]:
                    _GLOBAL_MODULE_CACHE.pop(k, None)
    return src


def parse_imports(src):
    """返回 [(clause_or_None, spec)]；副作用导入与 re-export clause 为 None。

    re-export（`export ... from 'spec'`）一并抓取依赖：无本地绑定，仅转发，
    clause 记 None（host 侧依据 ModuleBundle.imports 的 spec 第三元做转发）。
    """
    out = []
    seen = set()
    for m in _RE_IMPORT_FROM.finditer(src):
        if m.group(2) not in seen:
            seen.add(m.group(2))
            out.append((m.group(1).strip(), m.group(2)))
    for m in _RE_EXPORT_FROM.finditer(src):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append((None, m.group(1)))
    for m in _RE_IMPORT_SIDE.finditer(src):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append((None, m.group(1)))
    return out


# import 回边绑定语句签名：`var alias;`（函数提升，调用期经闭包读 var）+
# 延迟补赋闭包挂在模块命名空间的 __fixups__ 数组上，宿主在每轮模块 eval 后
# 统一回填（见 binding_statements 与 quickjs_host._drain_import_fixups）。
_FIXUP_NS_FMT = 'globalThis.__MOD{mod}__.__fixups__'


def _member_expr(obj_expr, prop_name):
    """生成对 obj_expr 的属性访问表达式（M2：非标识符名走括号访问）。

    字符串导入名（`import { "a-b" as x }` 等怪异形态经花括号正则漏进来）：
    点访问 `ns.a-b` 是非法 JS（整模块 SyntaxError），须生成 `ns["a-b"]`。
    属性名统一 JSON.stringify 转义。
    """
    if re.fullmatch(r'[A-Za-z_$][\w$]*', prop_name):
        return f'{obj_expr}.{prop_name}'
    return f'{obj_expr}[{json.dumps(prop_name, ensure_ascii=False)}]'


def binding_statements(clause, dep_ns, mod_idx=0, back_edge=True):
    """按导入子句生成 import 绑定语句（插入模块 IIFE 顶部、模块体之前）。

    取舍（H1/H2/H3 修复，绑定从 globalThis getter 收敛回 IIFE 作用域）：
    - 前向边（back_edge=False：依赖拓扑序在前，本模块 eval 时其命名空间已
      填充完毕）：`var alias = dep_ns.prop;` IIFE 内快照。绑定不触碰
      globalThis（H1：defineProperty 撞 non-configurable 属性如 http 抛
      TypeError 的场景不复存在），跨模块各自持有同名 var（H2：不再互相
      覆盖），IIFE var 遮蔽 cat.js 全局词法常量（H3：裸名优先解析到本
      模块导入）。
    - 回边（循环依赖中被 DFS 截断的边）：本模块 eval 时依赖命名空间必然
      尚未填充，快照取 undefined。「globalThis 唯一名 getter + IIFE 内不
      定义 var」在物理上不可行——模块体内裸标识符是 alias 本名，无法穿透
      解析到改名后的 __GETi_n__ getter（实测环依赖用例返回 undefined）。
      因此回边生成 `var alias;`（声明提升，函数体内引用经闭包在**调用期**
      读 var 当前值）+ 延迟补赋闭包：
      `(globalThis.__MODi__.__fixups__ = ...).push(function(){ alias = dep; })`。
      宿主在每轮模块 eval 后统一 drain（_drain_import_fixups，重复执行
      幂等）——依赖模块导出注册完成后回填 var，函数调用期与 ESM live
      binding 语义对齐。__fixups__ 挂在模块命名空间对象上，随 __MODn__
      一起被 _reset_spider_globals 清理（H4：不再有 globalThis getter 残留
      问题）。export * 合并须排除 __fixups__ 键（见 esm_transform）。
    - 回边模块**顶层立即**使用导入名仍为 undefined（真实 ESM 亦为 TDZ
      错误场景，属接受的取舍）。

    back_edge 缺省 True 保守走延迟回填（单模块兼容调用等无法判定拓扑的
    场景下，函数体内调用期解析仍然正确）。
    """
    lines = []
    if clause is None:
        return lines
    fixup_target = _FIXUP_NS_FMT.format(mod=mod_idx)

    def _emit(alias, dep_expr):
        """一条 import 绑定 → 前向边 IIFE var 快照；回边 var 声明 + 延迟回填。

        dep_expr 为完整的依赖取值表达式（属性访问已按 M2 处理为合法形态）。
        alias 必须是合法 JS 标识符——var 声明靠本名引用，非标识符形态跳过。
        """
        if not re.fullmatch(r'[A-Za-z_$][\w$]*', alias):
            logger.warning('import binding alias is not a JS identifier, skipped: %r', alias)
            return
        if back_edge:
            lines.append(f'var {alias};')
            lines.append(
                f'({fixup_target} = {fixup_target} || [])'
                f'.push(function() {{ {alias} = {dep_expr}; }});')
        else:
            lines.append(f'var {alias} = {dep_expr};')

    m_ns = _RE_NAMESPACE.match(clause)
    if m_ns:
        _emit(m_ns.group(1), dep_ns)
        return lines
    brace = re.search(r'\{([^}]*)\}', clause)
    head = (clause[:brace.start()] if brace else clause).strip().rstrip(',').strip()
    if head:
        # 默认导入：default 在依赖模块体求值时才赋到命名空间。前向边快照时
        # 依赖（拓扑序在前）已执行完毕；回边由延迟回填补齐
        _emit(head, f'{dep_ns}.default')
    if brace:
        for part in brace.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                src_name, alias = [x.strip() for x in part.split(' as ', 1)]
            else:
                src_name = alias = part
            src_name = _strip_string_quotes(src_name)
            _emit(alias, _member_expr(dep_ns, src_name))
    return lines


def _strip_string_quotes(name):
    """导入子句片段可能带引号（`import { "a-b" as x }`）：剥掉成对引号。"""
    if len(name) >= 2 and name[0] == name[-1] and name[0] in ('"', "'"):
        return name[1:-1]
    return name


class ModuleBundle:
    """抓取结果：modules 为 [(url, src)] 拓扑序（依赖在前）。

    imports：url -> [(clause_or_None, dep_url, spec)]；spec 为源码中的原始
    说明符字面量（如 './dep.js'），供 esm_transform 的 re-export 转发按
    dep_map 查找依赖命名空间。clause 为 None 表示副作用导入或 re-export。

    back_edges：{(url, dep_url), ...}——DFS 截断的真回边（依赖是当前 DFS
    栈上的祖先，其命名空间在当前模块 eval 时必然未填充）。import 绑定按此
    区分：回边走 globalThis 唯一名 getter 惰性解析，前向边走 IIFE 内 var
    快照（见 binding_statements）。不能按拓扑序号大小推断：a→b→a 环中
    b→a 的截断递归不产生新序号，dep_idx < mod_idx 但依赖尚未执行。
    """

    def __init__(self):
        self.modules = []
        self.index = {}        # url -> 序号
        self.imports = {}      # url -> [(clause, dep_url, spec)]（已解析为绝对地址）
        self.back_edges = set()
        self._visiting = set()

    def build(self, entry_url, fetch_text, limit=MAX_MODULES):
        self._visit(entry_url, fetch_text, limit)
        return self

    def _visit(self, url, fetch_text, limit):
        if url in self.index or url in self._visiting:
            return
        if len(self.modules) >= limit:
            raise ValueError(f'module count exceeds limit {limit}')
        # _visiting 必须覆盖整个子树（含依赖递归）：循环依赖 a→b→a 时，
        # b 对 a 的再次 _visit 靠此标记截断。旧实现在 fetch 后立即 discard，
        # 标记失效导致真环无限递归爆栈。
        self._visiting.add(url)
        try:
            src = fetch_module_cached(url, fetch_text)
            deps = []
            for clause, spec in parse_imports(src):
                dep = urljoin(url, spec)
                if not dep.startswith('http'):
                    continue
                deps.append((clause, dep, spec))
                if dep in self._visiting:
                    # dep 在当前 DFS 栈上（祖先）：真回边，本次递归被截断，
                    # dep 的命名空间要到祖先模块 eval 之后才填充
                    self.back_edges.add((url, dep))
                self._visit(dep, fetch_text, limit)
            self.imports[url] = deps
            self.index[url] = len(self.modules)
            self.modules.append((url, src))
        finally:
            self._visiting.discard(url)
