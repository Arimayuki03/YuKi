# -*- coding: utf-8 -*-
"""N3.2 ~ N3.5 核心契约与统一数据面回归测试：
- QuickJS 宿主缺失全局诊断、安全守卫、单站点配额
- Python Spider 独立目录与依赖缺失诊断
- CMS 六方法契约、编码、HTML 假直链防误判、结构化错误
- 统一 /proxy 数据面调度、Range/206、流式转发与取消
"""
import io
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# 确保 python-backend 及 js-engine 目录在 sys.path 中
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
JS_ENGINE_DIR = os.path.join(BACKEND_DIR, 'js-engine')
if JS_ENGINE_DIR not in sys.path:
    sys.path.insert(0, JS_ENGINE_DIR)

from cms_spider import CmsSpider
from quickjs_host import JsEngine
import proxy_gateway
from proxy_contract import ProxyResult
from server import build_proxy_response


class TestN32QuickJSEnhancements(unittest.TestCase):
    def test_missing_global_diagnostic(self):
        engine = JsEngine(site_key='test_diag')
        with patch('quickjs_host.logger.warning') as mock_warn:
            engine._warn_missing_global('ReferenceError: rule is not defined', 'rule.js')
            mock_warn.assert_called()
            args, _ = mock_warn.call_args
            self.assertIn('drpy', args[3])  # 包含针对性的 drpy 建议

    def test_local_kv_site_quota(self):
        from quickjs_host import _native_local_set, _native_local_get
        set_fn = _native_local_set('quota_site')
        get_fn = _native_local_get('quota_site')
        
        # 写入正常大小
        set_fn('k1', 'hello')
        self.assertEqual(get_fn('k1'), 'hello')

    def test_security_guard_applied_to_http(self):
        from quickjs_host import _native_http
        # 严格 SSRF 模式（YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1）下私网地址仍被拒；
        # 桌面端默认已放开本机/内网引用（局域网 NAS / 本机服务是合理场景）。
        with patch.dict(os.environ, {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}):
            res_json = _native_http('http://192.168.1.1/admin', '{}')
        res = json.loads(res_json)
        self.assertEqual(res['status'], 403)
        self.assertIn('blocked', res['content'])


class TestN33PythonSpiderIsolation(unittest.TestCase):
    def test_materialize_isolated_subdirectories(self):
        from config import ConfigManager
        from site_manager import SiteManager
        sm = SiteManager()
        mgr = ConfigManager(sm)
        site_key = 'py_iso_test'
        content = b"class Spider: pass"
        
        with patch('http_client.fetch_follow_redirects') as mock_fetch:
            mock_resp = MagicMock()
            mock_resp.content = content
            mock_fetch.return_value = mock_resp
            
            path = mgr._materialize_python_spider(site_key, 'http://test.com/spider.py')
            self.assertTrue(os.path.isabs(path))
            self.assertIn(site_key, path)
            self.assertTrue(os.path.exists(path))


    def _mgr(self):
        from config import ConfigManager
        from site_manager import SiteManager
        return ConfigManager(SiteManager())

    def test_materialize_content_addressed_no_overwrite(self):
        """同 key 同 URL 的两份不同内容落在两个 sha256 子目录并存（按 key 落盘会互相覆盖）。"""
        mgr = self._mgr()
        api = 'https://test.com/spider.py'
        bodies = (b'class Spider: v1', b'class Spider: v2  # different')
        paths = []
        for body in bodies:
            with patch('http_client.fetch_follow_redirects') as mock_fetch:
                mock_fetch.return_value = MagicMock(content=body)
                paths.append(mgr._materialize_python_spider('py_iso_addr', api))
        self.assertNotEqual(os.path.dirname(paths[0]), os.path.dirname(paths[1]))
        # 两个内容哈希目录同属该站点目录
        self.assertEqual(os.path.dirname(os.path.dirname(paths[0])),
                         os.path.dirname(os.path.dirname(paths[1])))
        for path, body in zip(paths, bodies):
            with io.open(path, 'rb') as handle:
                self.assertEqual(handle.read(), body)

    def test_materialize_atomic_write_leaves_no_tmp(self):
        """原子写（写 .tmp 后 os.replace）不得留下临时文件——子进程 import 会读到半成品。"""
        mgr = self._mgr()
        with patch('http_client.fetch_follow_redirects') as mock_fetch:
            mock_fetch.return_value = MagicMock(content=b'class Spider: tmp')
            path = mgr._materialize_python_spider('py_iso_tmp', 'https://test.com/spider.py')
        leftovers = [n for n in os.listdir(os.path.dirname(path)) if n.endswith('.tmp')]
        self.assertEqual(leftovers, [], f'原子写不应留下临时文件: {leftovers}')

    def test_materialize_plain_http_warns(self):
        """明文 http 源（无完整性校验、可被 MITM 换成任意代码）必须醒目告警；https/内联不告警。"""
        mgr = self._mgr()

        def mitm_warns(mock):
            return [c for c in mock.call_args_list if 'MITM' in str(c)]

        with (patch('http_client.fetch_follow_redirects') as mock_fetch,
              patch('config.logger.warning') as mock_warn):
            mock_fetch.return_value = MagicMock(content=b'class Spider: plain')
            mgr._materialize_python_spider('py_iso_http', 'http://test.com/spider.py')
            self.assertTrue(mitm_warns(mock_warn), '明文 http 源应告警完整性/MITM 风险')

        with (patch('http_client.fetch_follow_redirects') as mock_fetch,
              patch('config.logger.warning') as mock_warn):
            mock_fetch.return_value = MagicMock(content=b'class Spider: tls')
            mgr._materialize_python_spider('py_iso_https', 'https://test.com/spider.py')
            self.assertEqual(mitm_warns(mock_warn), [], 'https 源不应告警')

        with patch('config.logger.warning') as mock_warn:
            mgr._materialize_python_spider('py_iso_inline', 'class Spider:\n    pass\n')
            self.assertEqual(mitm_warns(mock_warn), [], '内联源码不走网络，不应告警')

class TestN34CmsContract(unittest.TestCase):
    def setUp(self):
        self.spider = CmsSpider('cms_test', 'http://example.com/api', stype=1, name='测试CMS')

    def test_fake_html_direct_link_detected(self):
        # 网页地址必须标记为 parse=1 (交由解析器)，绝不能直接 parse=0 误标为直链
        res = self.spider.playerContent('line1', 'https://example.com/play/123.html', [])
        self.assertEqual(res['parse'], 1)

        res_php = self.spider.playerContent('line1', 'https://example.com/play.php?id=1', [])
        self.assertEqual(res_php['parse'], 1)

        # 真实直链媒体必须标记为 parse=0
        res_m3u8 = self.spider.playerContent('line1', 'https://example.com/live.m3u8', [])
        self.assertEqual(res_m3u8['parse'], 0)
        self.assertEqual(res_m3u8['url'], 'https://example.com/live.m3u8')

    def test_video_format_check(self):
        self.assertTrue(self.spider.isVideoFormat('https://example.com/test.mp4'))
        self.assertFalse(self.spider.isVideoFormat('https://example.com/test.html'))
        self.assertFalse(self.spider.isVideoFormat('https://example.com/play.jsp?v=1'))

    def test_xml_and_json_parsing(self):
        xml_data = """<?xml version="1.0" encoding="utf-8"?>
        <rss version="5.1">
            <class>
                <ty id="1">电影</ty>
            </class>
            <list page="1" pagecount="1" pagesize="20" recordcount="1">
                <video>
                    <id>100</id>
                    <tid>1</tid>
                    <name>测试影片</name>
                    <type>电影</type>
                    <dl>
                        <dd flag="http">第1集$https://example.com/1.m3u8</dd>
                    </dl>
                </video>
            </list>
        </rss>
        """
        parsed = self.spider._parse_xml(xml_data)
        self.assertEqual(len(parsed['class']), 1)
        self.assertEqual(parsed['class'][0]['type_name'], '电影')
        self.assertEqual(len(parsed['list']), 1)
        self.assertEqual(parsed['list'][0]['vod_name'], '测试影片')
        self.assertEqual(parsed['list'][0]['vod_play_url'], '第1集$https://example.com/1.m3u8')


class TestN35ProxyGateway(unittest.TestCase):
    def test_param_semantic_retention(self):
        params = {'siteKey': 'demo_site', 'url': 'http://cdn.com/1.m3u8', 'header': '{"User-Agent":"test"}'}
        sites_mock = MagicMock()
        site_mock = MagicMock()
        site_mock.key = 'demo_site'
        site_mock.runner.localProxy.return_value = 'http://proxy-out'
        sites_mock.get.return_value = site_mock

        res = proxy_gateway.dispatch(params, sites_mock)
        self.assertEqual(res, 'http://proxy-out')
        # 原始 siteKey 语义不应被强制 pop 抹杀
        site_mock.runner.localProxy.assert_called_once()
        called_args = site_mock.runner.localProxy.call_args[0][0]
        self.assertIn('siteKey', called_args)

    def test_proxy_result_range_206(self):
        # 测试 206 Partial Content 流式响应
        stream = io.BytesIO(b"0123456789ABCDEF")
        pr = ProxyResult(
            status=206,
            mime='video/mp4',
            body=stream,
            headers={'Content-Range': 'bytes 0-7/16', 'Content-Length': '8'}
        )
        response = build_proxy_response(pr)
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.headers.get('content-range'), 'bytes 0-7/16')


    def test_esm_module_caching(self):
        from module_resolver import ModuleBundle
        fetch_count = 0
        def mock_fetch(url):
            nonlocal fetch_count
            fetch_count += 1
            if url == 'http://example.com/entry.js':
                return "import './dep.js'; export default {};"
            return "export const x = 1;"

        bundle1 = ModuleBundle().build('http://example.com/entry.js', mock_fetch)
        self.assertEqual(fetch_count, 2)

        # 第二次构建相同模块树，应命中全局模块二级缓存
        bundle2 = ModuleBundle().build('http://example.com/entry.js', mock_fetch)
        self.assertEqual(fetch_count, 2)  # 未触发额外网络请求
        self.assertEqual(len(bundle2.modules), 2)


class TestN36EsmModuleParity(unittest.TestCase):
    """ESM 多模块运行时对齐回归：循环依赖 live binding / re-export 转发 /
    多声明符与解构导出 / spider 重复加载重置 / local KV 原子写。"""

    def _engine(self):
        return JsEngine(site_key='n36_parity')

    @staticmethod
    def _fetch(files):
        def fetch(url):
            for prefix, src in files.items():
                if url.startswith(prefix):
                    return src
            raise AssertionError('unexpected module url: ' + url)
        return fetch

    def test_circular_dependency_live_bindings(self):
        """循环依赖 a↔b：调用期经 getter 读到对方导出（旧 var 快照实现取到 undefined/TypeError）。

        注：导入别名避开 cat.js 顶层词法常量名（cat.js 转换后常驻全局词法环境，
        单字母/常见短名会被其 let/const 遮蔽，任何实现都取不到 globalThis 值）。
        """
        engine = self._engine()
        fetch = self._fetch({
            'http://t-cycle/a.js': (
                'import { hiFn } from "./b.js";\n'
                'export function greet() { return "a:" + hiFn(); }\n'
                'export const SITE_NAME = "A";\n'
                'export default { greet: greet, hiFn: hiFn };'
            ),
            'http://t-cycle/b.js': (
                'import { SITE_NAME } from "./a.js";\n'
                'export function hiFn() { return "hi-" + SITE_NAME; }'
            ),
        })
        self.assertTrue(engine.load_spider_url('http://t-cycle/a.js', fetch))
        self.assertEqual(engine.call('greet'), 'a:hi-A')
        self.assertEqual(engine.call('hiFn'), 'hi-A')

    def test_multiline_import_and_reexport_forwarding(self):
        """多行命名 import + export * from 转发：转发函数可调、本模块用导入值正常。"""
        engine = self._engine()
        fetch = self._fetch({
            'http://t-reexport/entry.js': (
                'import {\n'
                '  helperFn,\n'
                '  tagLabel as tagAlias\n'
                '} from "./extra.js";\n'
                'export * from "./extra.js";\n'
                'export default {\n'
                '  helperFn: helperFn,\n'
                '  useAlias: function() { return helperFn() + ":" + tagAlias; }\n'
                '};'
            ),
            'http://t-reexport/extra.js': (
                'export function helperFn() { return "H"; }\n'
                'export const tagLabel = "T";'
            ),
        })
        self.assertTrue(engine.load_spider_url('http://t-reexport/entry.js', fetch))
        # 转发进来的函数（经 globalThis getter 取依赖命名空间）可调用
        self.assertEqual(engine.call('helperFn'), 'H')
        # 本模块使用导入值的函数
        self.assertEqual(engine.call('useAlias'), 'H:T')
        # export * 已把 extra.js 的命名导出合并进入口命名空间（不含 default）
        self.assertEqual(engine.ctx.eval('globalThis.__MODULE_EXPORTS__.tagLabel'), 'T')

    def test_multi_declarator_and_destructuring_exports(self):
        """export const a=1, b=2 多声明符与对象/数组解构导出：命名空间拿到全部绑定。

        绑定名避开 cat.js 顶层词法常量（单字母/短名被遮蔽会导致 eval redeclaration）。
        """
        engine = self._engine()
        src = (
            'const srcObj = {dv: 10, k: 20};\n'
            'const srcArr = [1, 2, 3];\n'
            'export const mv1 = 1, mv2 = srcObj.dv;\n'
            'export const { dv, k: dvAlias, extra = 99, ...resto } = srcObj;\n'
            'export const [arrFirst, , arrThird] = srcArr;\n'
            'export default {};'
        )
        self.assertTrue(engine.load_spider(src))
        exports = json.loads(engine.ctx.eval(
            'JSON.stringify(globalThis.__MODULE_EXPORTS__)'))
        self.assertEqual(exports['mv1'], 1)
        self.assertEqual(exports['mv2'], 10)
        self.assertEqual(exports['dv'], 10)
        self.assertEqual(exports['dvAlias'], 20)   # k: dvAlias 重命名
        self.assertEqual(exports['extra'], 99)     # 默认值穿透
        self.assertEqual(exports['resto'], {})     # ...rest
        self.assertEqual(exports['arrFirst'], 1)
        self.assertEqual(exports['arrThird'], 3)   # 数组洞跳过
        self.assertIn('default', exports)

    def test_reload_spider_replaces_previous(self):
        """重复 load_spider / load_spider_url（站点重载/换源）：新 spider 方法生效（旧实现返回旧值）。"""
        engine = self._engine()
        self.assertTrue(engine.load_spider(
            'export default { info: function() { return "v1"; } };'))
        self.assertEqual(engine.call('info'), 'v1')
        # 第二次加载：旧实现 __JS_SPIDER__ 已存在被 loader 守卫跳过，仍返回 v1
        self.assertTrue(engine.load_spider(
            'export default { info: function() { return "v2"; } };'))
        self.assertEqual(engine.call('info'), 'v2')

    def test_reload_spider_url_replaces_previous(self):
        """load_spider_url 换源重载：旧 __JS_SPIDER__/__MODn__ 命名空间被清空重建。"""
        engine = self._engine()
        fetch = self._fetch({
            'http://t-reload/one.js': 'export default { info: function() { return "u1"; } };',
            'http://t-reload/two.js': 'export default { info: function() { return "u2"; } };',
        })
        self.assertTrue(engine.load_spider_url('http://t-reload/one.js', fetch))
        self.assertEqual(engine.call('info'), 'u1')
        self.assertTrue(engine.load_spider_url('http://t-reload/two.js', fetch))
        self.assertEqual(engine.call('info'), 'u2')
        # 旧命名空间已清理，无 __MODn__ 残留（one.js 仅 1 个模块，第二个源同名 MOD0 已重建）
        self.assertEqual(engine.ctx.eval(
            'Object.getOwnPropertyNames(globalThis).filter('
            'function(k){return /^__MOD\\d+__$/.test(k);}).length'), 1)
        # H4 负向：残留绑定机制（__fixups__）不残留在 globalThis（无 __GET 等
        # getter 名），宿主 API（http）在重载后仍可调用
        self.assertEqual(engine.ctx.eval(
            'Object.getOwnPropertyNames(globalThis).filter('
            'function(k){return /^__GET\\d+_\\d+__$/.test(k);}).length'), 0)
        self.assertEqual(engine.ctx.eval(
            'typeof globalThis.http'), 'function')

    def test_import_alias_conflicts_with_host_global(self):
        """H1 负向：import 别名占用宿主全局名（http）时整站仍可加载。

        绑定收敛进 IIFE 作用域（var 快照/回填），不再对 globalThis 做裸名
        defineProperty——撞 non-configurable 宿主属性（http）抛 TypeError
        导致整站加载失败的场景不再存在。
        """
        engine = self._engine()
        fetch = self._fetch({
            'http://t-alias/lib.js': (
                'export function http(u) { return "wrapped:" + u; }\n'
                'export default {};'
            ),
            'http://t-alias/main.js': (
                'import { http } from "./lib.js";\n'
                'export default { fetchName: function() { return http("x"); } };'
            ),
        })
        self.assertTrue(engine.load_spider_url('http://t-alias/main.js', fetch))
        # IIFE 内 var 遮蔽宿主 globalThis.http：模块内读到的是导入值
        self.assertEqual(engine.call('fetchName'), 'wrapped:x')
        # 宿主全局 http 未被破坏
        self.assertEqual(engine.ctx.eval('typeof globalThis.http'), 'function')

    def test_sibling_modules_same_alias_from_different_deps(self):
        """H2 负向：两个兄弟模块从不同依赖导入同名导出，各自取对值。

        绑定为各模块 IIFE 内独立 var：不再生成 globalThis 同名 getter 被
        后定义者覆盖（旧实现 m1:A/m2:B 静默变成 m1:B/m2:B）。
        """
        engine = self._engine()
        fetch = self._fetch({
            'http://t-sib/depA.js': 'export const who = "A";',
            'http://t-sib/depB.js': 'export const who = "B";',
            'http://t-sib/m1.js': (
                'import { who } from "./depA.js";\n'
                'export function m1Who() { return who; }\n'
                'export default {};'
            ),
            'http://t-sib/m2.js': (
                'import { who } from "./depB.js";\n'
                'export function m2Who() { return who; }\n'
                'export default {};'
            ),
            'http://t-sib/main.js': (
                'import { m1Who } from "./m1.js";\n'
                'import { m2Who } from "./m2.js";\n'
                'export default {\n'
                '  p1: function() { return m1Who(); },\n'
                '  p2: function() { return m2Who(); }\n'
                '};'
            ),
        })
        self.assertTrue(engine.load_spider_url('http://t-sib/main.js', fetch))
        self.assertEqual(engine.call('p1'), 'A')
        self.assertEqual(engine.call('p2'), 'B')

    def test_regex_literal_comma_in_multi_declarator_export(self):
        """M1/M3 负向：多声明符导出中初始化值含正则字面量（逗号/转义/字符类）
        与跨行续写（无尾逗号）时全部声明符正确注册，且正则可执行。"""
        engine = self._engine()
        src = (
            'const testStr = "1a,b2x,y3a/b";\n'
            'export const rx = /a,b/.test(testStr), split = /x[1,3]y/.test(testStr),\n'
            '  esc = /a\\/b/.test(testStr), num = 7,\n'
            '  cont = "a" +\n'
            '    "-b", second = 2;\n'
            'export default { test: function() { return rx && split && esc; } };'
        )
        self.assertTrue(engine.load_spider(src))
        exports = json.loads(engine.ctx.eval(
            'JSON.stringify(globalThis.__MODULE_EXPORTS__)'))
        self.assertIs(exports['rx'], True)
        self.assertIs(exports['split'], True)     # 字符类内逗号未误切
        self.assertIs(exports['esc'], True)       # 转义斜杠未终止正则
        self.assertEqual(exports['num'], 7)
        self.assertEqual(exports['cont'], 'a-b')  # M3 续行收集
        self.assertEqual(exports['second'], 2)

    def test_string_export_name_reexport(self):
        """M2 负向：字符串导出名 re-export（`export {v as "a-b"} from`）生成
        合法括号访问而非非法 `ns."a-b"`；转发值与再导入均正确。"""
        engine = self._engine()
        fetch = self._fetch({
            'http://t-strex/dep.js': (
                'export function v() { return "V"; }\n'
                'export const tag = "T";'
            ),
            'http://t-strex/mid.js': (
                'export { v as "a-b", tag } from "./dep.js";\n'
                'export default {};'
            ),
            'http://t-strex/main.js': (
                'import { "a-b" as fn, tag } from "./mid.js";\n'
                'export default {\n'
                '  call: function() { return fn() + ":" + tag; }\n'
                '};'
            ),
        })
        self.assertTrue(engine.load_spider_url('http://t-strex/main.js', fetch))
        self.assertEqual(engine.call('call'), 'V:T')
        # 字符串导出名已注册到中转模块命名空间（括号访问，非非法 ns."a-b"）
        self.assertEqual(engine.ctx.eval(
            'globalThis.__MOD1__["a-b"]()'), 'V')

    def test_local_kv_atomic_write_leaves_no_tmp(self):
        """_local_kv_save 原子写：落盘后无临时文件残留、JSON 可解析（崩溃不再静默清空）。"""
        import tempfile
        import quickjs_host
        tmpdir = tempfile.mkdtemp(prefix='yuki_kv_test_')
        old_dir, old_file = quickjs_host.LOCAL_KV_DIR, quickjs_host.LOCAL_KV_FILE
        try:
            quickjs_host.LOCAL_KV_DIR = tmpdir
            quickjs_host.LOCAL_KV_FILE = os.path.join(tmpdir, 'js_local-test.json')
            set_fn = quickjs_host._native_local_set('atom_site')
            set_fn('key1', 'val1')
            names = os.listdir(tmpdir)
            self.assertEqual(names, ['js_local-test.json'],
                             f'原子写不应留下临时文件: {names}')
            with open(quickjs_host.LOCAL_KV_FILE, encoding='utf-8') as f:
                data = json.load(f)
            self.assertEqual(data.get('atom_site' + quickjs_host.KV_SCOPE_SEP + 'key1'), 'val1')
        finally:
            quickjs_host.LOCAL_KV_DIR, quickjs_host.LOCAL_KV_FILE = old_dir, old_file
            for n in os.listdir(tmpdir):
                try:
                    os.remove(os.path.join(tmpdir, n))
                except OSError:
                    pass
            os.rmdir(tmpdir)


if __name__ == '__main__':
    unittest.main()
