# -*- coding: utf-8 -*-
"""app.py / trigger.py 白盒单元测试（CatVod 契约恢复源码）。

app.py 与 trigger.py 是从 APK 高保真重建的"恢复源码"，契约必须原样保留
（PROGRESS.md 第 2 条）。本文件因此全部走白盒：直接钉住模块名推导、
str2json 参数解析、序列化口径（ensure_ascii=False）、以及 Trigger 与
app/Runner 之间**故意不同**的调用约定（pg 参数、extend 是否解析）。

与既有测试的互补关系：
- smoke.py / test_phase3.py：端到端 HTTP + 真实站点装载（黑盒）；
- 本文件：不启服务、不出网，只钉模块内部私有分支。

用法：<venv>/python python-backend/tests/test_app_trigger.py
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, BASE)

import app  # noqa: E402
import compat  # noqa: E402  # 补回 SourceFileLoader.load_module（3.12+）
import trigger  # noqa: E402

assert compat  # 显式声明依赖：app.spider 依赖 load_module 兼容层


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------
def _tmpdir():
    return tempfile.mkdtemp(prefix='yuki-apptrigger-')


class _Rec:
    """记录被调用的方法名与位置参数，所有方法都返回同一结果。

    有意不预置任何真实属性：这样 app.runner 层给 spider「打属性」之类的副作用
    在测试里会立刻显形，而不是被一个 __slots__ 恰好挡住。
    """

    def __init__(self, result=None, raises=None):
        self.calls = []
        self._result = result
        self._raises = raises

    def __getattr__(self, name):
        # 只拦截"未被调用过的方法名"；已调用过的名字由 __getattribute__ 记录到
        # calls 而不是落在实例字典里，因此这里不会漏。
        def _fn(*args):
            self.calls.append((name, args))
            if self._raises:
                raise self._raises
            return self._result
        return _fn


class _SpiderStub:
    """真实形状的最小 Spider：只有 getName / getDependence 两个取值方法。"""

    def __init__(self, name='stub'):
        self.name = name

    def getName(self):
        return self.name

    def getDependence(self):
        return None


def _inline_source(counter_path, tag='A'):
    """落盘即执行一次：往计数文件追加一字节，用于证明模块是否真的被 exec。"""
    return (
        "import io\n"
        "_p = %r\n"
        "with open(_p, 'a', encoding='utf-8') as _f:\n"
        "    _f.write('x')\n"
        "class Spider:\n"
        "    def getName(self):\n"
        "        return %r\n" % (counter_path, tag)
    )


# ---------------------------------------------------------------------------
# app.download / app.writeFile：落盘原子性与失败清理
# ---------------------------------------------------------------------------
def test_app_download_inline_writes_raw_bytes():
    """内联 api（非 http）走 str.encode：按 UTF-8 原样落盘。"""
    d = _tmpdir()
    try:
        path = os.path.join(d, 'inline.py')
        app.download(path, 'print("中文")')
        with open(path, 'rb') as f:
            assert f.read() == 'print("中文")'.encode('utf-8')
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_app_download_http_uses_redirect_content():
    """http api 走 redirect().content：只消费 content，不复用整个响应对象。"""
    d = _tmpdir()
    try:
        path = os.path.join(d, 'remote.py')

        class _Resp:
            content = b'# remote spider'

        with mock.patch.object(app, 'redirect', return_value=_Resp()) as rd:
            app.download(path, 'http://fixture.invalid/s.py')
        assert rd.call_args[0][0] == 'http://fixture.invalid/s.py'
        with open(path, 'rb') as f:
            assert f.read() == b'# remote spider'
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_app_writefile_is_atomic_replace():
    """原子写：先写同目录 .tmp 再 os.replace，tmp 名含 pid + 线程标识。"""
    d = _tmpdir()
    try:
        target = os.path.join(d, 'a.py')
        seen = {}
        real = os.replace

        def _spy(src, dst):
            seen['src'] = src
            seen['dst'] = dst
            return real(src, dst)

        with mock.patch.object(os, 'replace', _spy):
            app.writeFile(target, b'payload')
        assert seen['dst'] == target
        assert os.path.dirname(seen['src']) == os.path.dirname(target)
        assert seen['src'].startswith(target + '.')
        assert seen['src'].endswith('.tmp')
        # tmp 名 = <target>.<pid>.<thread_ident>.tmp
        tail = os.path.basename(seen['src'])[len(os.path.basename(target)):]
        assert re.fullmatch(r'\.\d+\.\d+\.tmp', tail), tail
        with open(target, 'rb') as f:
            assert f.read() == b'payload'
        assert not [n for n in os.listdir(d) if n.endswith('.tmp')]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_app_writefile_failure_raises_and_removes_tmp():
    """replace 失败：异常上抛 + 半成品 tmp 被清理 + 不留垃圾文件。"""
    d = _tmpdir()
    try:
        target = os.path.join(d, 'b.py')
        with mock.patch.object(os, 'replace', side_effect=OSError('disk full')):
            try:
                app.writeFile(target, b'x')
                assert False, 'replace 失败必须上抛'
            except OSError as e:
                assert 'disk full' in str(e)
        assert not os.path.exists(target)
        assert not [n for n in os.listdir(d) if n.endswith('.tmp')]
        # unlink 自身失败（OSError）也被吞掉，不掩盖原始异常
        with mock.patch.object(os, 'replace', side_effect=OSError('disk full')), \
                mock.patch.object(os, 'unlink', side_effect=OSError('busy')):
            try:
                app.writeFile(target, b'x')
                assert False
            except OSError as e:
                assert 'disk full' in str(e)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# app.spider：模块名推导（跨站串源防线）
# ---------------------------------------------------------------------------
def _write_download(path, api):
    """替代 app.download：不触网，把 api 按内联语义落盘。"""
    app.writeFile(path, str.encode(api))


def _cleanup_modules(directory):
    for name, mod in list(sys.modules.items()):
        if getattr(mod, '__file__', '') and os.path.dirname(mod.__file__) == directory:
            sys.modules.pop(name, None)


def test_app_spider_inline_names_by_digest():
    """内联源码：没有文件名 → stem 直接用 api 摘要，ext 固定 .py。"""
    d = _tmpdir()
    try:
        api = 'class Spider:\n    def getName(self):\n        return "inline"\n'
        digest = hashlib.sha1(api.encode('utf-8', 'replace')).hexdigest()[:12]
        with mock.patch.object(app, 'download', _write_download):
            assert app.spider(d, api).getName() == 'inline'
        assert os.path.isfile(os.path.join(d, 'inline_%s_%s.py' % (digest, digest)))
    finally:
        _cleanup_modules(d)
        shutil.rmtree(d, ignore_errors=True)


def test_app_spider_http_names_by_basename_and_digest():
    """http api：stem 取 path 的 basename（去扩展名）+ 摘要，ext 保留原始扩展名。"""
    d = _tmpdir()
    try:
        api = 'http://fixture.invalid/dir/plugin.py?ver=2'
        digest = hashlib.sha1(api.encode('utf-8', 'replace')).hexdigest()[:12]
        with mock.patch.object(app, 'download',
                               lambda p, a: app.writeFile(
                                   p, b'class Spider:\n    def getName(self):\n        return "http"\n')):
            assert app.spider(d, api).getName() == 'http'
        assert os.path.isfile(os.path.join(d, 'plugin_%s.py' % digest))
    finally:
        _cleanup_modules(d)
        shutil.rmtree(d, ignore_errors=True)


def test_app_spider_same_api_is_idempotent():
    """去重：同一 api 反复装载，落盘路径与模块名恒定，行为一致（不串到别的源）。"""
    d = _tmpdir()
    try:
        api = _inline_source(os.path.join(d, 'counter'), 'A')
        digest = hashlib.sha1(api.encode('utf-8', 'replace')).hexdigest()[:12]
        with mock.patch.object(app, 'download', _write_download):
            first = app.spider(d, api)
            assert first.getName() == 'A'
            second = app.spider(d, api)
            assert second.getName() == 'A'
            assert os.path.isfile(os.path.join(d, 'inline_%s_%s.py' % (digest, digest)))
        # 模块按「路径摘要」命名并登记进 sys.modules —— 这才是跨站串源的真防线：
        # 旧实现取 basename 作模块名，同名 spider.py 会在 sys.modules 互撞。
        stems = [n for n, m in sys.modules.items()
                 if getattr(m, '__file__', '') and os.path.dirname(m.__file__) == d]
        assert stems and all(s.startswith('inline_') for s in stems), stems
    finally:
        _cleanup_modules(d)
        shutil.rmtree(d, ignore_errors=True)


def _fake_download(path, api):
    """按 api 末位字符区分两个源，用于验证「不同址不同模块」。"""
    app.writeFile(path, _inline_source(os.path.join(os.path.dirname(path), 'counter'),
                                      api[-1]).encode('utf-8'))


def test_app_spider_distinct_api_distinct_module():
    """不串源：同一 basename、不同 query 的 api 必须落到不同模块，各执行一次。"""
    d = _tmpdir()
    counter = os.path.join(d, 'counter')
    try:
        api_a = 'http://fixture.invalid/plugin.py?site=A'
        api_b = 'http://fixture.invalid/plugin.py?site=B'
        digest_a = hashlib.sha1(api_a.encode('utf-8', 'replace')).hexdigest()[:12]
        digest_b = hashlib.sha1(api_b.encode('utf-8', 'replace')).hexdigest()[:12]
        assert digest_a != digest_b

        with mock.patch.object(app, 'download', _fake_download):
            a = app.spider(d, api_a)
            b = app.spider(d, api_b)
        # 若模块名只取 basename，第二次会命中第一次的模块，两个源串成一个。
        assert a.getName() == 'A' and b.getName() == 'B'
        assert os.path.isfile(os.path.join(d, 'plugin_%s.py' % digest_a))
        assert os.path.isfile(os.path.join(d, 'plugin_%s.py' % digest_b))
    finally:
        _cleanup_modules(d)
        shutil.rmtree(d, ignore_errors=True)


def test_app_spider_unsafe_chars_sanitized():
    """Windows 非法文件名字符（:*?"<>|#%）被替换为下划线，路径不转义。"""
    d = _tmpdir()
    try:
        api = 'http://fixture.invalid/a:b*c.py'
        digest = hashlib.sha1(api.encode('utf-8', 'replace')).hexdigest()[:12]
        with mock.patch.object(app, 'download', _fake_download):
            assert app.spider(d, api).getName() == 'y'      # api 末位字符
        base = 'a_b_c_%s.py' % digest
        assert os.path.isfile(os.path.join(d, base))
        assert not re.search(r'[\\/:*?"<>|#%]', base), base
    finally:
        _cleanup_modules(d)
        shutil.rmtree(d, ignore_errors=True)


def test_app_spider_missing_class_propagates():
    """错误兜底：模块里没有 Spider 类 → AttributeError 上抛，不静默返回 None。"""
    d = _tmpdir()
    try:
        with mock.patch.object(app, 'download',
                               side_effect=lambda p, a: app.writeFile(p, b'VALUE = 1')):
            try:
                app.spider(d, 'http://fixture.invalid/nospider.py')
                assert False, '缺少 Spider 类必须抛异常'
            except AttributeError:
                pass
        for name, mod in list(sys.modules.items()):
            if getattr(mod, '__file__', '') and os.path.dirname(mod.__file__) == d:
                sys.modules.pop(name, None)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# app.str2json：参数解析（JSON body 非法 / 空 / 编码异常）
# ---------------------------------------------------------------------------
def test_app_str2json_valid():
    assert app.str2json('{"a": 1}') == {'a': 1}
    assert app.str2json('[]') == []


def test_app_str2json_invalid_raises():
    """非法 JSON body 必须上抛，由上层 _decorate_action_body 统一收口成结构化错误。"""
    for bad in ('', '{', 'not json', '{"a": }'):
        try:
            app.str2json(bad)
            assert False, '非法 JSON 未抛异常: %r' % bad
        except (ValueError, TypeError):
            pass
    # 编码异常：str2json 只收 str；bytes 交给 json.loads 处理（不吞异常）
    assert app.str2json(b'{"a":1}') == {'a': 1}


# ---------------------------------------------------------------------------
# app 的 handler 包装层：序列化口径与参数解析
# ---------------------------------------------------------------------------
def test_app_home_content_serializes_unicode():
    """homeContent 统一 json.dumps 且 ensure_ascii=False：中文不被转义。"""
    rec = _Rec({'class': [{'type_name': '电影'}]})
    out = app.homeContent(rec, False)
    assert isinstance(out, str)
    assert '电影' in out and '\\u' not in out
    assert rec.calls == [('homeContent', (False,))]
    assert json.loads(out)['class'][0]['type_name'] == '电影'


def test_app_home_video_content_pg_default():
    """homeVideoContent 的 pg 默认 '1'；显式 pg 原样透传（不转 int）。"""
    rec = _Rec({'list': []})
    app.homeVideoContent(rec)
    assert rec.calls[-1] == ('homeVideoContent', ('1',))
    app.homeVideoContent(rec, '7')
    assert rec.calls[-1] == ('homeVideoContent', ('7',))


def test_app_category_content_parses_extend():
    """categoryContent 的 extend 是 JSON 字符串 → 解析成 dict 再下发。"""
    rec = _Rec({'list': []})
    app.categoryContent(rec, 'tid1', '2', True, '{"area":"日韩"}')
    name, args = rec.calls[-1]
    assert name == 'categoryContent'
    assert args == ('tid1', '2', True, {'area': '日韩'})


def test_app_detail_content_bad_json_raises():
    """detailContent 的 ids 非法 JSON → ValueError 上抛（不吞、不返回空串）。"""
    rec = _Rec({'list': []})
    try:
        app.detailContent(rec, 'not-json')
        assert False
    except ValueError:
        pass
    assert rec.calls == []          # 解析失败不得先调用 spider


def test_app_live_and_localproxy_no_serialization():
    """liveContent / localProxy 是原始通道：返回值不做 json.dumps。"""
    live = _Rec({'url': 'rtmp://x'})
    assert app.liveContent(live, 'rtmp://x') == {'url': 'rtmp://x'}
    assert live.calls == [('liveContent', ('rtmp://x',))]
    lp = _Rec(b'raw-bytes')
    assert app.localProxy(lp, '{"a":1}') == b'raw-bytes'
    assert lp.calls == [('localProxy', ({'a': 1},))]


def test_app_action_and_init_destroy_delegate():
    """action 走 JSON 序列化；init/destroy/getName/getDependence 是纯转发。"""
    act = _Rec({'ok': True})
    out = app.action(act, '{"do":"click"}')
    assert json.loads(out) == {'ok': True}
    assert act.calls == [('action', ('{"do":"click"}',))], act.calls   # 原串下发

    rec = _Rec('ignored')
    app.init(rec, 'ext=1')
    app.destroy(rec)
    assert rec.calls == [('init', ('ext=1',)), ('destroy', ())]
    assert app.getName(_SpiderStub('n1')) == 'n1'
    assert app.getDependence(_SpiderStub()) is None


def test_app_player_search_argument_order():
    """playerContent / searchContent 的位置参数顺序是 CatVod 契约，不可调换。"""
    p = _Rec({'url': 'u'})
    app.playerContent(p, 'flag', 'id-1', '[]')
    assert p.calls == [('playerContent', ('flag', 'id-1', []))]
    s = _Rec({'list': []})
    app.searchContent(s, '关', '0')
    assert s.calls == [('searchContent', ('关', '0', '1'))]
    app.searchContent(s, '关', '0', '3')
    assert s.calls[-1] == ('searchContent', ('关', '0', '3'))


# ---------------------------------------------------------------------------
# app.redirect / app._fetch：收编到 http_client 的语义
# ---------------------------------------------------------------------------
def test_app_fetch_delegates_to_http_client():
    """_fetch 不自动跟重定向 + verify=True（UA/代理语义已收编到 http_client）。"""
    with mock.patch.object(app.http_client, 'get', return_value='RESP') as g:
        assert app._fetch('http://fixture.invalid/x') == 'RESP'
    assert g.call_args[0][0] == 'http://fixture.invalid/x'
    assert g.call_args[1]['allow_redirects'] is False
    assert g.call_args[1]['verify'] is True
    assert g.call_args[1]['timeout'] == 15


def test_app_redirect_trust_root_and_max_bytes():
    """redirect 是插件兜底下载路径：trust_root=url 且体积上限放宽到 32MB。"""
    url = 'http://fixture.invalid/plugin.py'
    with mock.patch.object(app.http_client, 'fetch_follow_redirects', return_value='R') as fr:
        assert app.redirect(url) == 'R'
    kwargs = fr.call_args[1]
    assert kwargs['trust_root'] == url
    assert kwargs['max_bytes'] == 32 * 1024 * 1024
    assert kwargs['max_bytes'] == app.http_client.MAX_REDIRECT_BODY_BYTES


# ---------------------------------------------------------------------------
# trigger.Trigger：纯转发层的调用约定（与 app/Runner 的差异）
# ---------------------------------------------------------------------------
def test_trigger_delegates_every_method():
    """Trigger 的每个静态方法都只做一次转发，不做序列化、不补参数。"""
    methods = [
        ('init', ('ext',), ('init', ('ext',))),
        ('homeContent', (True,), ('homeContent', (True,))),
        ('homeVideoContent', (), ('homeVideoContent', ())),
        ('categoryContent', ('t', '1', False, '{}'), ('categoryContent', ('t', '1', False, '{}'))),
        ('detailContent', (['i'],), ('detailContent', (['i'],))),
        ('searchContent', ('k', '0'), ('searchContent', ('k', '0', '1'))),
        ('playerContent', ('f', 'i', []), ('playerContent', ('f', 'i', []))),
        ('liveContent', ('u',), ('liveContent', ('u',))),
        ('isVideoFormat', ('u.m3u8',), ('isVideoFormat', ('u.m3u8',))),
        ('manualVideoCheck', (), ('manualVideoCheck', ())),
        ('action', ('{}',), ('action', ('{}',))),
        ('destroy', (), ('destroy', ())),
    ]
    for name, args, expected in methods:
        rec = _Rec('R')
        getattr(trigger.Trigger, name)(rec, *args)
        assert rec.calls == [expected], '%s → %r' % (name, rec.calls)


def test_trigger_surface_is_pinned():
    """接口面钉死：Trigger 只暴露这 12 个转发方法，且不含 getName/getDependence。

    getName / getDependence / jsonExt / localProxy 都不在 Trigger 上——缺哪个都
    是 AttributeError 而不是 NotImplementedError，所以调用前必须确认表面。
    容器层取名的两条路径是 app.getName / runner.getName。
    """
    expected_surface = {'init', 'homeContent', 'homeVideoContent', 'categoryContent',
                        'detailContent', 'searchContent', 'playerContent', 'liveContent',
                        'isVideoFormat', 'manualVideoCheck', 'action', 'destroy'}
    surface = {n for n in dir(trigger.Trigger) if not n.startswith('_')}
    assert surface == expected_surface
    for missing in ('getName', 'getDependence', 'jsonExt', 'localProxy', 'proxy'):
        assert not hasattr(trigger.Trigger, missing), missing
    # staticmethod 描述符经类属性访问会被解包成普通函数，必须看 __dict__ 原值
    assert all(isinstance(v, staticmethod) for k, v in trigger.Trigger.__dict__.items()
               if not k.startswith('__')), 'Trigger 的方法必须全是 staticmethod'


def test_trigger_init_default_extend_empty():
    """init 的 extend 缺省为 ''（而非 None），保证旧 spider 的 extend 解析不炸。"""
    rec = _Rec()
    trigger.Trigger.init(rec)
    assert rec.calls == [('init', ('',))]


def test_trigger_home_video_content_omits_pg():
    """关键差异：Trigger.homeVideoContent 不带 pg，而 app/Runner 默认传 '1'。"""
    rec = _Rec()
    trigger.Trigger.homeVideoContent(rec)
    assert rec.calls == [('homeVideoContent', ())]
    # 对照：app 层默认补 '1'
    rec2 = _Rec()
    app.homeVideoContent(rec2)
    assert rec2.calls == [('homeVideoContent', ('1',))]


def test_trigger_forwards_raw_extend_unparsed():
    """关键差异：Trigger 的 extend 原样下发，不像 app.categoryContent 那样先 str2json。"""
    rec = _Rec()
    trigger.Trigger.categoryContent(rec, 'tid', '1', None, '{"area":"日韩"}')
    assert rec.calls[-1][1][3] == '{"area":"日韩"}'       # 仍是字符串
    rec2 = _Rec({'list': []})
    app.categoryContent(rec2, 'tid', '1', None, '{"area":"日韩"}')
    assert rec2.calls[-1][1][3] == {'area': '日韩'}       # 已解析


def test_trigger_returns_spider_value_verbatim():
    """返回值由 spider 决定且原样透传：不做 json.dumps，不补默认值。"""
    assert trigger.Trigger.homeContent(_Rec('站点A'), True) == '站点A'
    assert trigger.Trigger.manualVideoCheck(_Rec(False)) is False
    assert trigger.Trigger.isVideoFormat(_Rec(0), 'u.m3u8') == 0
    assert trigger.Trigger.destroy(_Rec(None)) is None
    # 对照：Trigger 不补 pg，返回的仍旧是 spider 的值
    assert trigger.Trigger.homeVideoContent(_Rec({'list': []})) == {'list': []}


def test_trigger_exception_propagates_uncaught():
    """Trigger 不含 try/except：spider 异常原样上抛，由上层错误映射收口。"""
    boom = _Rec(raises=RuntimeError('spider down'))
    for call in (lambda: trigger.Trigger.homeContent(boom, True),
                 lambda: trigger.Trigger.detailContent(boom, ['1']),
                 lambda: trigger.Trigger.destroy(boom)):
        try:
            call()
            assert False, 'spider 异常必须上抛'
        except RuntimeError as e:
            assert 'spider down' in str(e)
    assert len(boom.calls) == 3        # 每次都真的转发了


if __name__ == '__main__':
    failed = []
    for name in sorted(list(globals())):
        fn = globals()[name]
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print('PASS %s' % name)
            except Exception as exc:              # noqa: BLE001 - 汇总 runner
                failed.append(name)
                print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
    print('RESULT: %d passed, %d failed' % (
        len([n for n in globals() if n.startswith('test_')]) - len(failed), len(failed)))
    sys.exit(1 if failed else 0)
