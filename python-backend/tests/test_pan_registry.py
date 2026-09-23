# -*- coding: utf-8 -*-
"""pan 子包白盒单元测试：registry 注册表 / base 抽象基类 / models 数据模型。

覆盖注册与查找（大小写、未知名、重复注册）、遍历顺序稳定性、
字段校验与序列化往返、抽象方法的默认实现与必抛 NotImplementedError 的路径。

与既有用例互补：test_pan_provider.py 只验 QuarkProvider 的解析快路径，
test_pan_cache.py 只验缓存，本文件聚焦注册表/基类/模型三层的内部分支。
"""

from __future__ import annotations

import os
import sys
import traceback
from dataclasses import asdict, fields, is_dataclass
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from pan.base import PanProvider  # noqa: E402
from pan.models import PanFile, PlayUrl, PlayVariant, ShareInfo  # noqa: E402
from pan.registry import PanProviderRegistry, registry  # noqa: E402
from pan.quark import QuarkProvider  # noqa: E402


# --------------------------------------------------------------------------
# 测试用 provider
# --------------------------------------------------------------------------

def _make_provider(key='testpan', name='测试网盘', url=None, play=None, share=None,
                   list_files=None, validate=None):
    """按需构造一个 PanProvider 子类实例，便于逐分支打桩。

    resolve_play_url 必须在类体里定义：ABCMeta 在类创建时计算
    __abstractmethods__，事后赋值不会解除抽象标记。
    """
    shared = {'params': None, 'headers': None, 'refresh': None}

    class _P(PanProvider):
        def resolve_play_url(self, params: dict[str, Any], *, headers: dict[str, str],
                             refresh: bool = False):
            shared.update({'params': params, 'headers': headers, 'refresh': refresh})
            if play is not None:
                return play
            return PlayUrl(url or 'https://cdn.test/default.mp4',
                           file_id=str((params or {}).get('fileId') or ''),
                           provider=str(key))

    _P.key = key
    _P.name = name
    _P.shared = shared
    if share is not None:
        _P.resolve_share = lambda self, url_, *, headers: share
    if list_files is not None:
        _P.list_files = lambda self, request: list_files
    if validate is not None:
        _P.validate_cookie = lambda self, cookie: validate(cookie)
    return _P()


def _empty_registry():
    """构造一个真正空的注册表：构造函数的 ``providers or (QuarkProvider(),)``
    对空列表同样回落，只能显式清空 _providers 才能拿到空表（白盒现状）。"""
    reg = PanProviderRegistry()
    reg._providers.clear()
    assert reg.keys() == []
    return reg


# --------------------------------------------------------------------------
# 模型：字段与默认值
# --------------------------------------------------------------------------

def test_models_are_dataclasses_with_expected_fields():
    """四个模型都是 dataclass，且字段顺序/默认值符合契约。"""
    for cls in (PanFile, ShareInfo, PlayVariant, PlayUrl):
        assert is_dataclass(cls), cls
    assert [f.name for f in fields(PanFile)] == [
        'id', 'name', 'parent_id', 'is_dir', 'size', 'mime', 'updated_at',
        'playable', 'extra']
    assert [f.name for f in fields(ShareInfo)] == [
        'provider', 'share_id', 'title', 'files', 'extra']
    assert [f.name for f in fields(PlayVariant)] == [
        'url', 'quality', 'headers', 'original', 'transcoded', 'expire_at', 'extra']
    assert [f.name for f in fields(PlayUrl)] == [
        'url', 'headers', 'expire_at', 'file_id', 'provider', 'request',
        'quality', 'variants', 'original', 'transcoded', 'one_time']


def test_model_defaults_are_not_shared_mutable():
    """可变默认值走 default_factory：两个实例的 dict/list 互不相同。"""
    a, b = PlayUrl('u1'), PlayUrl('u2')
    a.headers['X'] = '1'
    a.variants.append(PlayVariant('v1'))
    a.request['k'] = 'v'
    assert b.headers == {} and b.variants == [] and b.request == {}
    f1, f2 = PanFile('1'), PanFile('2')
    f1.extra['k'] = 'v'
    assert f2.extra == {}
    s1, s2 = ShareInfo('quark', 'sid1'), ShareInfo('quark', 'sid2')
    s1.files.append(f1)
    s1.extra['k'] = 'v'
    assert s2.files == [] and s2.extra == {}


def test_models_require_positional_fields():
    """必填字段缺失时 dataclass 抛 TypeError（缺字段校验）。"""
    for call in (lambda: PanFile(), lambda: ShareInfo(), lambda: ShareInfo('quark'),
                 lambda: PlayVariant(), lambda: PlayUrl()):
        try:
            call()
            assert False, '应当抛出 TypeError'
        except TypeError:
            pass


def test_models_reject_none_for_required_fields():
    """必填字段传 None 不报错（dataclass 无类型校验），但值原样保留。"""
    assert PanFile(None).id is None
    assert PlayUrl(None).url is None
    assert ShareInfo(None, None).provider is None


def test_models_accept_wrong_types_without_coercion():
    """dataclass 不做运行时类型强制：类型错误原样保留（不静默转换）。"""
    f = PanFile(123, name=456, is_dir='yes', size='big')
    assert f.id == 123 and f.name == 456
    assert f.is_dir == 'yes' and f.size == 'big'
    p = PlayUrl('u', expire_at='not-a-number', file_id=1)
    assert p.expire_at == 'not-a-number' and p.file_id == 1


def test_models_ignore_unknown_kwargs():
    """多余字段不被接受（显式 TypeError），调用方需自行裁剪入参。"""
    try:
        PlayUrl('u', unknown_field='x')
        assert False, '应当抛出 TypeError'
    except TypeError as e:
        assert 'unknown_field' in str(e)


def test_play_url_one_time_defaults_true():
    """播放 URL 默认是一次性凭据（one_time=True），与缓存隔离策略一致。"""
    assert PlayUrl('u').one_time is True
    assert PlayUrl('u', one_time=False).one_time is False


def test_model_equality_and_serialization_roundtrip():
    """asdict 序列化后再按同名 kwargs 还原，字段逐一相等。"""
    play = PlayUrl('https://cdn.test/a.mp4', headers={'Cookie': 'c'},
                   expire_at=1700000300.0, file_id='fid', provider='quark',
                   request={'fileId': 'fid'}, quality='original',
                   variants=[PlayVariant('https://cdn.test/a.mp4', quality='原画',
                                         original=True)],
                   original=True, transcoded=False, one_time=True)
    data = asdict(play)
    assert data['variants'][0]['quality'] == '原画'
    restored = PlayUrl(**{k: v for k, v in data.items() if k != 'variants'})
    restored.variants = [PlayVariant(**v) for v in data['variants']]
    assert restored == play
    assert asdict(restored) == data


def test_share_info_roundtrip_with_files():
    """ShareInfo 嵌套 PanFile 的序列化往返保持结构一致。"""
    share = ShareInfo('quark', 'sid', title='剧集',
                      files=[PanFile('f1', 'ep1.mp4', is_dir=False, size=10, playable=True),
                             PanFile('d1', 'dir', is_dir=True)],
                      extra={'pwd': 'abcd'})
    data = asdict(share)
    assert len(data['files']) == 2
    back = ShareInfo(provider=data['provider'], share_id=data['share_id'],
                     title=data['title'],
                     files=[PanFile(**f) for f in data['files']],
                     extra=data['extra'])
    assert back == share


def test_asdict_does_not_mutate_source():
    """asdict 是深拷贝语义：改动结果不影响原对象。"""
    play = PlayUrl('u', headers={'A': '1'}, variants=[PlayVariant('v')])
    data = asdict(play)
    data['headers']['A'] = '2'
    data['variants'].append(PlayVariant('v2'))
    assert play.headers == {'A': '1'}
    assert len(play.variants) == 1


# --------------------------------------------------------------------------
# base：抽象契约与默认实现
# --------------------------------------------------------------------------

def test_base_cannot_be_instantiated():
    """PanProvider 是 ABC：直接实例化抛 TypeError（抽象方法未实现）。"""
    try:
        PanProvider()
        assert False, '应当抛出 TypeError'
    except TypeError as e:
        assert 'abstract' in str(e)


def test_subclass_must_implement_resolve_play_url():
    """未实现 resolve_play_url 的子类同样无法实例化。"""
    class Incomplete(PanProvider):
        key = 'incomplete'

    try:
        Incomplete()
        assert False, '应当抛出 TypeError'
    except TypeError as e:
        assert 'resolve_play_url' in str(e)


def test_subclass_with_resolve_play_url_is_concrete():
    """只实现 resolve_play_url 即可实例化：其余方法都有默认实现。"""
    provider = _make_provider()
    assert isinstance(provider, PanProvider)
    assert provider.key == 'testpan'


def test_base_validate_cookie_rejects_blank_only():
    """默认 validate_cookie 只判空：非空一律通过（不做内容校验）。"""
    provider = _make_provider()
    assert provider.validate_cookie('') == ['cookie missing']
    assert provider.validate_cookie('   ') == ['cookie missing']
    assert provider.validate_cookie(None) == ['cookie missing']
    assert provider.validate_cookie('a=b') == []
    assert provider.validate_cookie('garbage-without-equals') == []


def test_base_resolve_share_returns_none():
    """默认 resolve_share 返回 None：未实现分享解析的 provider 不伪装可用。"""
    provider = _make_provider()
    assert provider.resolve_share('https://pan.quark.cn/s/abc', headers={}) is None


def test_base_list_files_raises_not_implemented():
    """默认 list_files 抛 NotImplementedError，并带上 provider key 便于定位。"""
    provider = _make_provider(key='nobrowse')
    try:
        provider.list_files({'parent': 'root'})
        assert False, '应当抛出 NotImplementedError'
    except NotImplementedError as e:
        assert 'nobrowse' in str(e)
        assert 'browsing' in str(e)


def test_base_list_files_message_uses_empty_key():
    """未设置 key 时错误信息前缀为空字符串（不崩溃，只是可读性差）。"""
    provider = _make_provider(key='')
    try:
        provider.list_files(None)
        assert False, '应当抛出 NotImplementedError'
    except NotImplementedError as e:
        assert str(e).startswith(' provider')


def test_base_refresh_play_url_carries_file_id():
    """refresh_play_url 默认实现：把 file_id 补进 request 并以 refresh=True 重解析。"""
    provider = _make_provider(key='refreshpan')
    play = PlayUrl('https://cdn.test/old.mp4', file_id='fid-9',
                   request={'shareId': 's'})
    result = provider.refresh_play_url(play, headers={'Cookie': 'c'})
    assert result is not None
    assert provider.shared['refresh'] is True
    assert provider.shared['params'] == {'shareId': 's', 'fileId': 'fid-9'}
    assert provider.shared['headers'] == {'Cookie': 'c'}


def test_base_refresh_play_url_keeps_existing_file_id():
    """request 里已有 fileId 时不被 play.file_id 覆盖（保留原始入参语义）。"""
    provider = _make_provider(key='refreshpan2')
    play = PlayUrl('u', file_id='new-fid', request={'fileId': 'old-fid'})
    provider.refresh_play_url(play, headers={})
    assert provider.shared['params'] == {'fileId': 'old-fid'}


def test_base_refresh_play_url_without_file_id():
    """没有 file_id 时 request 原样传入（不塞空字符串）。"""
    provider = _make_provider(key='refreshpan3')
    provider.refresh_play_url(PlayUrl('u', request={'shareId': 's'}), headers={})
    assert provider.shared['params'] == {'shareId': 's'}


def test_base_refresh_play_url_empty_request():
    """request 为 None：dict(None or {}) 兜底为空 dict，不抛错。"""
    provider = _make_provider(key='refreshpan4')
    provider.refresh_play_url(PlayUrl('u', request=None), headers={})
    assert provider.shared['params'] == {}


def test_base_refresh_returns_subclass_result_as_is():
    """子类 resolve_play_url 返回 None（解析失败）时 refresh 也返回 None。"""
    provider = _make_provider(key='refreshpan5', play=None)
    provider.resolve_play_url = lambda params, *, headers, refresh=False: None
    assert provider.refresh_play_url(PlayUrl('u', file_id='f'), headers={}) is None


def test_base_class_attributes_default_to_empty():
    """基类 key/name 默认为空串；子类覆写后不污染基类。"""
    assert PanProvider.key == ''
    assert PanProvider.name == ''
    assert QuarkProvider.key == 'quark'
    assert PanProvider.key == ''


# --------------------------------------------------------------------------
# registry：注册与查找
# --------------------------------------------------------------------------

def test_registry_default_contains_quark():
    """默认构造只注册夸克一个 provider，不伪装其他网盘可用。"""
    reg = PanProviderRegistry()
    assert reg.keys() == ['quark']
    assert isinstance(reg.get('quark'), QuarkProvider)


def test_registry_accepts_explicit_provider_list():
    """显式传入 providers 时不再自动塞 quark（避免隐式默认）。"""
    reg = PanProviderRegistry([_make_provider('a'), _make_provider('b')])
    assert reg.keys() == ['a', 'b']
    assert reg.get('quark') is None


def test_registry_empty_list_falls_back_to_quark():
    """构造参数 ``providers or (QuarkProvider(),)`` 对空列表同样回落。

    白盒现状：空 list 是 falsy，无法表达「显式空注册表」；只有显式传入
    非空 providers 才能屏蔽默认的 quark。
    """
    assert PanProviderRegistry([]).keys() == ['quark']
    assert PanProviderRegistry(()).keys() == ['quark']
    assert PanProviderRegistry(None).keys() == ['quark']


def test_registry_register_and_lookup():
    """注册后按 key 查找返回同一实例（引用相等）。"""
    reg = _empty_registry()
    provider = _make_provider('mypan')
    reg.register(provider)
    assert reg.get('mypan') is provider


def test_registry_lookup_is_case_insensitive():
    """查找统一 lower+strip：大小写与前后空白都能命中。"""
    provider = _make_provider('CasePan')
    reg = PanProviderRegistry([provider])
    for key in ('casepan', 'CASEPAN', ' CasePan ', 'CaSePaN'):
        assert reg.get(key) is provider, key
    assert reg.keys() == ['casepan']


def test_registry_key_is_normalized_on_register():
    """注册时 key 被 strip+lower，且 name 不参与查找。"""
    reg = _empty_registry()
    reg.register(_make_provider('  UC  ', name='UC网盘'))
    assert reg.keys() == ['uc']
    assert reg.get('UC') is not None
    assert reg.get('UC网盘') is None


def test_registry_unknown_key_returns_none():
    """未注册的网盘返回 None（不返回空适配器伪装成可用）。"""
    reg = _empty_registry()
    assert reg.get('baidu') is None
    assert reg.get('') is None
    assert reg.get(None) is None
    assert reg.get('   ') is None


def test_registry_duplicate_register_overwrites():
    """重复注册同一 key：后者覆盖前者（注册表是 dict，不拒绝）。"""
    reg = _empty_registry()
    first, second = _make_provider('dup'), _make_provider('dup')
    reg.register(first)
    reg.register(second)
    assert reg.get('dup') is second
    assert reg.keys() == ['dup']


def test_registry_duplicate_key_different_case_collapses():
    """大小写不同的同一 key 视为同一个，后注册覆盖先注册。"""
    reg = _empty_registry()
    first, second = _make_provider('Dup'), _make_provider('dup')
    reg.register(first)
    assert reg.get('dup') is first
    reg.register(second)
    assert reg.get('DUP') is second
    assert len(reg.keys()) == 1


def test_registry_rejects_blank_key():
    """key 为空/纯空白/None 时注册抛 ValueError。"""
    reg = _empty_registry()
    for key in ('', '   ', None):
        try:
            reg.register(_make_provider(key))
            assert False, '应当抛出 ValueError: %r' % (key,)
        except ValueError as e:
            assert 'key is required' in str(e)
    assert reg.keys() == []


def test_registry_rejects_blank_key_even_with_name():
    """即使 name 有值，key 缺失仍拒绝（key 是唯一标识）。"""
    reg = _empty_registry()
    try:
        reg.register(_make_provider('', name='无名网盘'))
        assert False, '应当抛出 ValueError'
    except ValueError:
        pass


def test_registry_rejects_non_string_key_usage():
    """key 为数字时 str() 转换后可用（register 走 str(provider.key or '')）。"""
    reg = _empty_registry()
    provider = _make_provider(123)
    reg.register(provider)
    assert reg.get('123') is provider
    assert reg.keys() == ['123']


def test_registry_keys_are_sorted_stably():
    """遍历顺序 = key 字典序，与注册顺序无关（顺序稳定性）。"""
    reg = _empty_registry()
    for key in ('zpan', 'apan', 'mpan', 'bpan'):
        reg.register(_make_provider(key))
    assert reg.keys() == ['apan', 'bpan', 'mpan', 'zpan']
    assert _empty_registry().register(_make_provider('apan')) is None
    assert reg.keys() == ['apan', 'bpan', 'mpan', 'zpan']  # 重复注册不改顺序


def test_registry_keys_returns_fresh_list():
    """keys() 返回新 list：改动返回值不污染注册表。"""
    reg = _empty_registry()
    reg.register(_make_provider('a'))
    snapshot = reg.keys()
    snapshot.append('mutated')
    assert reg.keys() == ['a']


def test_registry_iteration_order_after_many_inserts():
    """连续插入后顺序仍为字典序（dict 插入序 + sorted 双重保证）。"""
    reg = _empty_registry()
    for key in ('q', 'a', 'z', 'b', 'y', 'c'):
        reg.register(_make_provider(key))
    assert reg.keys() == sorted(['q', 'a', 'z', 'b', 'y', 'c'])


# --------------------------------------------------------------------------
# registry.resolve：委托与兜底
# --------------------------------------------------------------------------

def test_registry_resolve_delegates_to_provider():
    """resolve 把 params/headers/refresh 原样转发给对应 provider。"""
    provider = _make_provider('deleg')
    reg = PanProviderRegistry([provider])
    play = reg.resolve('deleg', {'fileId': 'fid'}, headers={'Cookie': 'c'}, refresh=True)
    assert play is not None
    assert provider.shared['params'] == {'fileId': 'fid'}
    assert provider.shared['headers'] == {'Cookie': 'c'}
    assert provider.shared['refresh'] is True


def test_registry_resolve_unknown_key_returns_none():
    """未知 provider：resolve 返回 None（不抛错、不回落默认 provider）。"""
    reg = _empty_registry()
    assert reg.resolve('ghost', {'fileId': 'f'}, headers={}) is None


def test_registry_resolve_is_case_insensitive():
    """resolve 与 get 同口径：大小写不敏感。"""
    provider = _make_provider('UpperPan')
    reg = PanProviderRegistry([provider])
    assert reg.resolve('upperpan', {}, headers={}) is not None
    assert reg.resolve('UPPERPAN', {}, headers={}) is not None


def test_registry_resolve_propagates_provider_none():
    """provider 解析失败返回 None 时，registry 原样返回 None。"""
    provider = _make_provider('failpan')
    provider.resolve_play_url = lambda params, *, headers, refresh=False: None
    reg = PanProviderRegistry([provider])
    assert reg.resolve('failpan', {}, headers={}) is None


def test_registry_resolve_propagates_provider_exception():
    """provider 抛异常时 registry 不吞（异常语义交给上层处理）。"""
    provider = _make_provider('boompan')

    def boom(params, *, headers, refresh=False):
        raise RuntimeError('resolve boom')

    provider.resolve_play_url = boom
    reg = PanProviderRegistry([provider])
    try:
        reg.resolve('boompan', {}, headers={})
        assert False, '应当抛出 RuntimeError'
    except RuntimeError as e:
        assert 'resolve boom' in str(e)


def test_registry_resolve_defaults_refresh_false():
    """不传 refresh 时默认 False（与 provider 签名一致）。"""
    provider = _make_provider('norefresh')
    reg = PanProviderRegistry([provider])
    reg.resolve('norefresh', {}, headers={})
    assert provider.shared['refresh'] is False


def test_registry_resolve_empty_and_none_key():
    """空/None key 走 get 的兜底，返回 None 而非 KeyError。"""
    reg = _empty_registry()
    assert reg.resolve('', {}, headers={}) is None
    assert reg.resolve(None, {}, headers={}) is None


def test_module_level_registry_is_quark_only():
    """模块级单例 registry 只含 quark，且与新建实例互不影响。"""
    assert registry.keys() == ['quark']
    other = _empty_registry()
    other.register(_make_provider('temp'))
    assert 'temp' not in registry.keys()
    assert registry.keys() == ['quark']


def test_registry_accepts_arbitrary_object_with_key():
    """register 不做 isinstance 校验：duck typing，只要有 key 就能注册。

    这是白盒现状（可被利用注入假 provider），此处固化行为。
    """
    reg = _empty_registry()

    class Duck:
        key = 'duck'
        name = '鸭子网盘'

    duck = Duck()
    reg.register(duck)  # type: ignore[arg-type]
    assert reg.get('duck') is duck


def test_registry_rejects_object_without_key_attribute():
    """没有 key 属性的对象：getattr 缺失触发 AttributeError（未做保护）。"""
    reg = _empty_registry()

    class NoKey:
        pass

    try:
        reg.register(NoKey())  # type: ignore[arg-type]
        assert False, '应当抛出 AttributeError'
    except AttributeError:
        pass


if __name__ == '__main__':
    passed = 0
    failed = []
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                passed += 1
                print('PASS %s' % name)
            except Exception as exc:  # noqa: BLE001
                failed.append(name)
                print('FAIL %s: %r' % (name, exc))
                traceback.print_exc()
    print('---- %d passed, %d failed ----' % (passed, len(failed)))
    if failed:
        sys.exit(1)
    print('ALL PASS')
