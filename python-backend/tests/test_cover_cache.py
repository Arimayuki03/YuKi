# -*- coding: utf-8 -*-
"""封面磁盘缓存（B-08）单测：cover_cache 模块 + /kazumi/cover 端点接线。

覆盖（仿 test_aggsearch_cache.py 风格：纯函数层自写断言 + unittest 端点级，
不用 pytest）：
① 命中零网络回字节（端点二次请求不打 http_client）；
② 未命中拉取写盘回字节（put 落盘，三次重复请求单次回源）；
③ 拉取失败不留脏文件（404/超时/非图片：目录无新增 .bin）；
④ LRU/配额淘汰（超配额先淘过期、再按 mtime 淘最旧；命中触摸 mtime）；
⑤ TTL 过期重拉（头部 exp 拨回过去 → miss → 重新回源）；
- 键派生：键=URL sha1 与端口/token 无关（r 段归一化前后同键）；
- 中毒面：空体/超 8MB/畸形 ctype 不落盘（put 护栏）；
- cacheSize/clearCache 挂接（cacheSize bytes 含 covers 分项、clearCache 清空）。

端点驱动方式（test_aggsearch_cache.py 手法）：从 create_app() 路由表取
/kazumi/cover 的 endpoint，直接 await 调用（无需起 uvicorn）；
http_client.get 打桩，hoststate 目录指到测试根。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)
# import server 会构造 SiteManager/ConfigManager，但不触网不建目录（惰性）；
# 仍按既有测试惯例把目录指到测试根，保证环境变量先于 hoststate 初始化就绪。
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(TEST_ROOT, 'cache'))

import cover_cache  # noqa: E402
import http_client  # noqa: E402
import server  # noqa: E402

COVERS_DIR = os.path.join(TEST_ROOT, 'cache', 'covers')


class _FakeRsp:
    def __init__(self, status=200, content=b'', ctype='image/jpeg'):
        self.status_code = status
        self.content = content
        self.headers = {'content-type': ctype}


def _reset_store():
    """每个用例独立目录：丢弃单例 + 清目录（避免记账串台）。

    COVERS_DIR 落在本仓库 .test-runtime 下（非系统 Temp），进程退出后由
    仓库清理；不再使用 tempfile.mkdtemp 直建目录（L14 残留根源）。"""
    cover_cache.set_dir_for_tests(COVERS_DIR)
    cover_cache._store_instance = None
    shutil.rmtree(COVERS_DIR, ignore_errors=True)


def _bin_count():
    return len([f for f in os.listdir(COVERS_DIR) if f.endswith('.bin')]) \
        if os.path.isdir(COVERS_DIR) else 0


# ---------------------------------------------------------------------------
# cover_cache 纯模块层
# ---------------------------------------------------------------------------

def test_key_derivation():
    """键=URL sha1：与端口/token 无关；同一 URL 恒同键。"""
    u1 = 'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg'
    u2 = 'https://lain.bangumi.vip/pic/cover/l/a/b/1.jpg'
    assert cover_cache.key_for(u1) == cover_cache.key_for(u1)
    assert cover_cache.key_for(u1) != cover_cache.key_for(u2)
    assert len(cover_cache.key_for(u1)) == 40  # sha1 hex


def test_put_get_roundtrip():
    _reset_store()
    k = cover_cache.key_for('https://lain.bgm.tv/pic/cover/l/a.jpg')
    assert cover_cache.get(k) is None  # 未命中
    assert cover_cache.put(k, b'\xff\xd8jpg', 'image/jpeg') is True
    hit = cover_cache.get(k)
    assert hit is not None and hit[0] == b'\xff\xd8jpg' and hit[1] == 'image/jpeg'
    # 毒面：空体 / 超 8MB / 非 image ctype（put 侧消毒改写而非拒绝）
    assert cover_cache.put(k, b'') is False
    assert cover_cache.put(k, b'x' * (cover_cache.MAX_ENTRY_BYTES + 1)) is False
    assert cover_cache.put(k, b'ok', 'text/html; charset=utf-8\r\nEVIL|') is True
    assert cover_cache.get(k)[1] == 'image/jpeg'  # 畸形 ctype 被消毒为默认值


def test_corrupt_and_empty_files_self_heal():
    """半截/空/坏头文件：get 惰性删除并返回 None（不留脏条目）。"""
    _reset_store()
    k = cover_cache.key_for('https://lain.bgm.tv/pic/cover/l/b.jpg')
    path = os.path.join(COVERS_DIR, k + '.bin')
    os.makedirs(COVERS_DIR, exist_ok=True)  # 直写文件需先建目录
    for garbage in (b'', b'no-newline', b'notafloat|x\nbody', b'123|image/jpeg\n'):
        with open(path, 'wb') as f:
            f.write(garbage)
        assert cover_cache.get(k) is None, garbage
    assert _bin_count() == 0  # 全部被惰性删除


def test_lru_and_quota_eviction():
    """配额淘汰：先淘已过期条目，仍超按 mtime 淘最旧；命中触摸 mtime。"""
    _reset_store()
    # L14：TemporaryDirectory 退出即自动清理，不再往系统 Temp 留 cover-quota-* 残留
    with tempfile.TemporaryDirectory(prefix='cover-quota-') as tdir:
        tmpdir = os.path.join(tdir, 'covers')
        store = cover_cache.CoverStore(tmpdir, max_bytes=1000, ttl=100000)
        _run_quota_eviction_steps(store, tmpdir)
    assert not os.path.isdir(tmpdir)  # 退出 with 块即已清理
    assert not os.path.isdir(tdir)


def _run_quota_eviction_steps(store, tmpdir):
    """配额淘汰断言主体（从 test_lru_and_quota_eviction 拆出复用）。"""
    ka = cover_cache.key_for('a')  # 最旧：put 后不再摸
    kb = cover_cache.key_for('b')  # 中间：get 触摸变新
    kc = cover_cache.key_for('c')  # 最新
    store.put(ka, b'a' * 400)
    store.put(kb, b'b' * 400)
    store.put(kc, b'c' * 400)
    assert store.get(kb) is not None  # 触摸 b → a 成为最旧
    # 超配额（1200+头部 > 1000）：按 mtime 淘 a
    store._evict_if_needed()
    assert store.get(ka) is None
    assert store.get(kb) is not None and store.get(kc) is not None
    # 已过期条目优先于更旧的未过期条目被淘
    kd = cover_cache.key_for('d')
    store.put(kd, b'd' * 400)
    assert store.get(ka) is None and store.get(kd) is not None
    # 把 d 的头部 exp 拨到过去（直接改文件首行）
    with open(os.path.join(tmpdir, kd + '.bin'), 'rb') as f:
        data = f.read()
    with open(os.path.join(tmpdir, kd + '.bin'), 'wb') as f:
        f.write(data.replace(b'%f|' % store._files[kd + '.bin'][1], b'1.0|', 1))
    store.put(cover_cache.key_for('e'), b'e' * 400)
    store._evict_if_needed()  # d 过期 → 先淘 d 而非 mtime 更旧的 b
    assert store.get(kd) is None


def test_ttl_expiry_repull():
    """TTL 过期：头部 exp 过去时刻 → get 返回 None（惰性删除）→ 重拉。"""
    _reset_store()
    k = cover_cache.key_for('https://lain.bgm.tv/pic/cover/l/t.jpg')
    assert cover_cache.put(k, b'old', 'image/jpeg')
    assert cover_cache.get(k)[0] == b'old'
    # 直接拨头部 exp 到过去（模拟 7 天流逝；不做主动重验，TTL 兜底）
    path = os.path.join(COVERS_DIR, k + '.bin')
    with open(path, 'rb') as f:
        data = f.read()
    with open(path, 'wb') as f:
        f.write(b'1.0|image/jpeg\nold')
    assert cover_cache.get(k) is None
    assert _bin_count() == 0
    assert cover_cache.put(k, b'new', 'image/jpeg')
    assert cover_cache.get(k)[0] == b'new'


def test_stats_and_clear():
    _reset_store()
    assert cover_cache.stats() == (0, 0, 0)
    k = cover_cache.key_for('s')
    cover_cache.put(k, b'x' * 100, 'image/jpeg')
    total, entries, expired = cover_cache.stats()
    assert entries == 1 and total > 100 and expired == 0
    assert cover_cache.clear_all() == 1
    assert cover_cache.stats() == (0, 0, 0)
    assert cover_cache.get(k) is None


def test_key_path_whitelist():
    """L2 路径白名单双保险：第一道字符集校验拒绝分隔符/空白/超长；第二道
    realpath 前缀复核兜底拦下字符集合法但会逃出缓存根的键（如 Windows
    盘符相对路径 ``C:xxx``，os.path.join 会被它整个替换掉）；正常 sha1 键
    全兼容，恶意键零落盘。"""
    _reset_store()
    os.makedirs(COVERS_DIR, exist_ok=True)
    # 正常键不受影响（sha1 hex 是白名单子集）
    good = cover_cache.key_for('https://lain.bgm.tv/pic/cover/l/w.jpg')
    assert cover_cache.put(good, b'ok') is True
    assert cover_cache.get(good) == (b'ok', 'image/jpeg')
    # 第一道：字符集/长度直接拒绝
    charset_rejected = [
        good[:-1] + '/',            # 尾部分隔符
        good[:-1] + '\\',           # Windows 分隔符
        good[:-2] + '/../x',        # 路径穿越（含 /）
        good + 'x' * 200,           # 超长（>128）
        '',                         # 空
        'sha1_with space',          # 空白字符
    ]
    for bad in charset_rejected:
        assert cover_cache.key_allowed(bad) is False, bad
        assert cover_cache.put(bad, b'evil') is False, bad
        assert cover_cache.get(bad) is None, bad
    assert _bin_count() == 1  # 恶意键零落盘
    # 第二道：字符集合法（:、. 均在白名单内）但 realpath 逃出缓存根的键
    drive_key = 'C:' + good[:-2]          # 盘符相对路径：join 会丢弃前缀目录
    assert cover_cache.key_allowed(drive_key) is True
    assert cover_cache.put(drive_key, b'evil') is False
    assert cover_cache.get(drive_key) is None
    # 第一道+第二道合验：落盘目录只有正常键那一个文件
    assert sorted(os.listdir(os.path.realpath(COVERS_DIR))) == [good + '.bin']
    # 直调第二道复核：逃逸路径抛 ValueError、合法键返回原路径
    store = cover_cache._store()
    assert store._checked_path(good) == os.path.join(COVERS_DIR, good + '.bin')
    try:
        store._check_path_in_root('..' + os.sep + 'escape')
        raise AssertionError('expected ValueError')
    except ValueError:
        pass


def test_get_put_accounting_no_drift():
    """L3 记账竞态：并发 get/put 混跑后 stats 与目录实况一致（无计数漂移）。"""
    _reset_store()
    import threading
    store = cover_cache._store()
    keys = [cover_cache.key_for('conc-%d' % i) for i in range(8)]
    for k in keys:
        store.put(k, b'z' * 500)
    barrier = threading.Barrier(8)

    def worker(i):
        barrier.wait()
        for _ in range(50):
            store.get(keys[i % len(keys)])       # 触摸/过期清理路径
            store.put(keys[(i + 1) % len(keys)], b'z' * 500)
            store.stats()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    total, entries, expired = store.stats()
    real = 0
    real_bytes = 0
    for fn in os.listdir(COVERS_DIR):
        if fn.endswith('.bin'):
            real += 1
            real_bytes += os.path.getsize(os.path.join(COVERS_DIR, fn))
    assert entries == real, (entries, real)
    assert total == real_bytes, (total, real_bytes)
    assert expired == 0


# ---------------------------------------------------------------------------
# 端点级：/kazumi/cover（create_app 路由驱动，http_client.get 打桩）
# ---------------------------------------------------------------------------

URL_OK = 'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg'


def _cover_endpoint():
    app = server.create_app()
    return next(route.endpoint for route in app.routes
                if getattr(route, 'path', '') == '/kazumi/cover')


class CoverEndpointCacheTest(unittest.TestCase):
    def setUp(self):
        _reset_store()
        self.endpoint = _cover_endpoint()
        self.calls = []

        def fake_get(url, **kw):
            self.calls.append(url)
            return _FakeRsp(status=200, content=b'\xff\xd8fresh', ctype='image/jpeg')

        self._old_get = http_client.get
        http_client.get = fake_get

    def tearDown(self):
        http_client.get = self._old_get

    def _call(self, url=URL_OK, if_none_match=None):
        req = type('R', (), {'headers': {'if-none-match': if_none_match or ''}})()
        return asyncio.run(self.endpoint(request=req, url=url))

    def test_miss_fetches_writes_and_hits_zero_network(self):
        """② 未命中拉取写盘回字节 → ① 二次命中零网络回同字节。"""
        r1 = self._call()
        assert r1.status_code == 200 and r1.body == b'\xff\xd8fresh'
        # 官方+镜像两路并行竞速（被墙不再串行干等）：两个候选各发一次，
        # 先成功者胜出（fake 全部 200，两 URL 都会出现在 calls 里）
        assert sorted(self.calls) == sorted([
            'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg',
            'https://lain.bangumi.vip/pic/cover/l/a/b/1.jpg',
        ])
        assert _bin_count() == 1
        r2 = self._call()
        assert r2.status_code == 200 and r2.body == b'\xff\xd8fresh'
        assert len(self.calls) == 2  # 零网络：缓存命中不再回源（仍是首拉的两路）
        assert r2.media_type.startswith('image/')
        assert 'max-age=604800' in r2.headers['Cache-Control']
        assert r2.headers['ETag'].startswith('W/"')

    def test_fetch_failure_leaves_no_file(self):
        """③ 拉取失败（404/超时/非图片）不留脏文件：目录无 .bin。"""
        def fake_get(url, **kw):
            self.calls.append(url)
            return _FakeRsp(status=404, content=b'not found', ctype='image/jpeg')

        http_client.get = fake_get
        r = self._call()
        assert r.status_code == 502 and _bin_count() == 0
        # 超时形态（异常）与非图片 ctype 同样不落盘
        def fake_timeout(url, **kw):
            self.calls.append(url)
            raise RuntimeError('timed out')

        http_client.get = fake_timeout
        assert self._call().status_code == 502 and _bin_count() == 0

        def fake_html(url, **kw):
            self.calls.append(url)
            return _FakeRsp(status=200, content=b'<html>err</html>', ctype='text/html')

        http_client.get = fake_html
        assert self._call().status_code == 502 and _bin_count() == 0
        # 失败后恢复：正常回源并落盘（失败请求未被错误缓存）
        http_client.get = lambda url, **kw: _FakeRsp(200, b'\xff\xd8ok', 'image/jpeg')
        assert self._call().body == b'\xff\xd8ok'
        assert _bin_count() == 1

    def test_etag_304_roundtrip(self):
        """命中时 If-None-Match 匹配 ETag → 304 空体；不匹配回 200 字节。"""
        r1 = self._call()
        etag = r1.headers['ETag']
        r2 = self._call(if_none_match=etag)
        assert r2.status_code == 304 and not r2.body
        assert len(self.calls) == 2  # 304 判定在磁盘缓存命中后，零网络（首拉竞速两路）
        r3 = self._call(if_none_match='W/"other"')
        assert r3.status_code == 200 and r3.body == b'\xff\xd8fresh'

    def test_ttl_expiry_repulls_via_endpoint(self):
        """⑤ TTL 过期重拉：头部拨回过去 → 端点 miss → 重新回源写新值。"""
        assert self._call().status_code == 200
        k = cover_cache.key_for(URL_OK)
        with open(os.path.join(COVERS_DIR, k + '.bin'), 'rb') as f:
            data = f.read()
        with open(os.path.join(COVERS_DIR, k + '.bin'), 'wb') as f:
            f.write(b'1.0|image/jpeg\n' + data.partition(b'\n')[2])
        http_client.get = lambda url, **kw: _FakeRsp(200, b'\xff\xd8v2', 'image/jpeg')
        r = self._call()
        assert r.body == b'\xff\xd8v2' and _bin_count() == 1

    def test_whitelist_still_first_and_cache_key_normalized(self):
        """白名单 403 先于缓存查询；r 段归一化（/r/400/...c/ → 同路径 ...l/）
        后作为缓存键——同图不同形态共用一条缓存。"""
        bad = 'https://evil.example.com/a.jpg'
        assert self._call(url=bad).status_code == 403
        assert self.calls == [] and _bin_count() == 0
        # 带病 r 段 URL：端点归一化（仅 c 段→l，r/400 宽度前缀保留）后落缓存，
        # 键=归一化 URL 的 sha1
        poisoned = 'https://lain.bgm.tv/r/400/pic/cover/c/a/b/1.jpg'
        assert self._call(url=poisoned).body == b'\xff\xd8fresh'
        normalized = 'https://lain.bgm.tv/r/400/pic/cover/l/a/b/1.jpg'
        assert cover_cache.get(cover_cache.key_for(normalized)) is not None

    def test_cache_size_and_clear_cache_wiring(self):
        """cacheSize 统计含 covers 分项；clearCache 清空封面缓存。

        两者都在 dispatch_action 的 do 分支（同步可直调，无需起服务）。"""
        assert self._call().status_code == 200
        status, body = server.dispatch_action({'do': 'cacheSize'})
        d = __import__('json').loads(body)
        assert status == 200 and d['breakdown']['covers'] > 0
        assert d['items'] >= 1
        status2, body2 = server.dispatch_action({'do': 'clearCache'})
        d2 = __import__('json').loads(body2)
        assert status2 == 200 and d2['detail']['covers'] == 1
        assert _bin_count() == 0


if __name__ == '__main__':
    # 既有惯例（test_aggsearch_cache.py）：纯函数层自跑 + unittest 驱动端点级；
    # 两者都绿才打印 ALL PASS。
    # 注意：exit=False 会让 unittest 失败时**不**结束本进程，脚本继续往下跑、
    # 照样打印 ALL PASS 并以 0 退出——run_all 只按 returncode 判成败，于是端点级
    # 用例全红也判 PASS，门禁形同虚设。必须显式把 wasSuccessful 转成退出码。
    res = unittest.main(argv=[sys.argv[0], 'CoverEndpointCacheTest'],
                        exit=False, verbosity=1)
    if not res.result.wasSuccessful():
        sys.exit(1)
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
