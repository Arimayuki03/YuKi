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
from urllib.parse import urljoin

logger = logging.getLogger('yuki.jsengine.resolver')

# 顶层 import 语句（整行，含多行命名列表不常见，按单行处理）
_RE_IMPORT_FROM = re.compile(r'^\s*import\s+(.+?)\s+from\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
_RE_IMPORT_SIDE = re.compile(r'^\s*import\s+[\'"]([^\'"]+)[\'"]\s*;?', re.M)
_RE_NAMESPACE = re.compile(r'^\*\s*as\s+([\w$]+)$')

MAX_MODULES = 40  # 单 spider 依赖模块数上限，防异常依赖树
MODULE_CACHE_TTL = 3600  # 模块二级缓存 TTL (1小时)

# 内存二级持久缓存：url -> (src, timestamp)
_GLOBAL_MODULE_CACHE = {}


def fetch_module_cached(url, fetch_text, ttl=MODULE_CACHE_TTL):
    """带 TTL 的全局模块网络拉取与二级缓存，避免重复解析与跨站点拉取开销。"""
    now = time.time()
    cached = _GLOBAL_MODULE_CACHE.get(url)
    if cached and (now - cached[1]) < ttl:
        return cached[0]
    
    src = fetch_text(url)
    if src:
        _GLOBAL_MODULE_CACHE[url] = (src, now)
    return src


def parse_imports(src):
    """返回 [(clause_or_None, spec)]；副作用导入 clause 为 None。"""
    out = []
    seen = set()
    for m in _RE_IMPORT_FROM.finditer(src):
        if m.group(2) not in seen:
            seen.add(m.group(2))
            out.append((m.group(1).strip(), m.group(2)))
    for m in _RE_IMPORT_SIDE.finditer(src):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append((None, m.group(1)))
    return out


def binding_statements(clause, dep_ns):
    """按导入子句生成 var 绑定语句列表（dep_ns 为依赖模块命名空间）。"""
    stmts = []
    if clause is None:
        return stmts
    m_ns = _RE_NAMESPACE.match(clause)
    if m_ns:
        stmts.append(f'var {m_ns.group(1)} = {dep_ns};')
        return stmts
    brace = re.search(r'\{([^}]*)\}', clause)
    head = (clause[:brace.start()] if brace else clause).strip().rstrip(',').strip()
    if head:
        stmts.append(f'var {head} = {dep_ns}.default;')
    if brace:
        for part in brace.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                src_name, alias = [x.strip() for x in part.split(' as ', 1)]
                stmts.append(f'var {alias} = {dep_ns}.{src_name};')
            else:
                stmts.append(f'var {part} = {dep_ns}.{part};')
    return stmts


class ModuleBundle:
    """抓取结果：modules 为 [(url, src)] 拓扑序（依赖在前）。"""

    def __init__(self):
        self.modules = []
        self.index = {}        # url -> 序号
        self.imports = {}      # url -> [(clause, dep_url)]（已解析为绝对地址）
        self._visiting = set()

    def build(self, entry_url, fetch_text, limit=MAX_MODULES):
        self._visit(entry_url, fetch_text, limit)
        return self

    def _visit(self, url, fetch_text, limit):
        if url in self.index or url in self._visiting:
            return
        if len(self.modules) >= limit:
            raise ValueError(f'module count exceeds limit {limit}')
        self._visiting.add(url)
        try:
            src = fetch_module_cached(url, fetch_text)
        finally:
            self._visiting.discard(url)
        deps = []
        for clause, spec in parse_imports(src):
            dep = urljoin(url, spec)
            if not dep.startswith('http'):
                continue
            deps.append((clause, dep))
            self._visit(dep, fetch_text, limit)
        self.imports[url] = deps
        self.index[url] = len(self.modules)
        self.modules.append((url, src))
