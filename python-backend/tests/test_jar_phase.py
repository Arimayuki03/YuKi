# -*- coding: utf-8 -*-
"""JAR spider 测试：java_probe 检测、config 加载 jar 站点、JarSpider 适配。

测试在无 JRE 环境不依赖 Java 运行时，通过 mock/probe cache 模拟各种场景。
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, 'js-engine'))

import hoststate  # noqa: E402

hoststate.configure(port=18333, token='jar-test')
hoststate.ensure_dirs()

import java_probe  # noqa: E402
import server  # noqa: E402

PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print(f'[PASS] {name}')
    else:
        FAILED.append(name)
        print(f'[FAIL] {name} {detail}')


def test_java_probe():
    """java_probe 探测可用（有 JDK 时）或返回 None（无 JDK 时）；不抛异常。"""
    java_probe.clear_cache()
    j = java_probe.find_java()
    if j is None:
        check('java_probe: no java found', True, 'no java on this machine')
        check('java_probe: version empty', java_probe.java_version() == '')
    else:
        check('java_probe: java found', isinstance(j, str) and j.endswith('java.exe'), f'bin={j}')
        check('java_probe: version present', len(java_probe.java_version()) > 0)


def test_norm_jar_src():
    """JarBridge.norm_jar_src 解析 jar url"""
    from jar_bridge import JarBridge
    url, md5, cls = JarBridge.norm_jar_src('https://x.com/spider/csp_MaoYan.jar')
    check('norm jar: url', url == 'https://x.com/spider/csp_MaoYan.jar', url)
    check('norm jar: class', cls == 'csp_MaoYan', cls)
    check('norm jar: no md5', md5 == '', md5)

    url2, md5_2, cls2 = JarBridge.norm_jar_src('https://x.com/spider/csp_Bili.jar;abc123def456abc123def456abc123d4')
    check('norm jar: md5 parsed', md5_2 == 'abc123def456abc123def456abc123d4', md5_2)
    check('norm jar: class with md5', cls2 == 'csp_Bili', cls2)

    url3, _, cls3 = JarBridge.norm_jar_src('csp_Test')
    check('norm jar: csp class only', url3 == '', url3)
    check('norm jar: csp class name', cls3 == '', cls3)  # 没有 url 时返回空


def test_jar_spider_direct():
    """JarSpider 在桥不可用（无 java）时降级返回空"""
    from jar_spider import make_jar_spider_class

    class FakeBridge:
        def call(self, method, *args, class_name='', pan_cookies=None):
            if method == 'init':
                return None
            if method == 'homeContent':
                return '{"class":[],"list":[]}'
            if method == 'searchContent':
                return '{"list":[{"vod_id":"j-1","vod_name":"test"}]}'
            if method == 'playerContent':
                return '{"url":"http://example.com/v.m3u8","parse":0,"header":{}}'
            if method == 'detailContent':
                return '{"list":[{"vod_id":"d-1","vod_name":"detail"}]}'
            if method == 'getName':
                return 'FakeJar'
            return None

    bridge = FakeBridge()
    spider = make_jar_spider_class('fjar', bridge, 'fake jar', 'csp_Fake')
    spider.init('extVal')
    home = spider.homeContent(True)
    check('jar spider homeContent', isinstance(home, dict) and home.get('class') == [], str(home))

    sr = spider.searchContent('keyword', True, '1')
    check('jar spider searchContent', sr['list'][0]['vod_name'] == 'test', str(sr))

    pc = spider.playerContent('f', 'http://example.com/v.m3u8', [])
    check('jar spider playerContent', pc['url'].endswith('.m3u8'), str(pc))

    dc = spider.detailContent(['d-1'])
    check('jar spider detailContent', dc['list'][0]['vod_id'] == 'd-1', str(dc))

    # 桥不可用（bridge=None）时降级
    dead = make_jar_spider_class('dead', None, 'dead', 'csp_Dead')
    dead.init('')
    check('jar spider no bridge home', dead.homeContent(False) == {}, str(dead.homeContent(False)))
    check('jar spider no bridge search', dead.searchContent('x', True) == {'list': []}, str(dead.searchContent('x', True)))


def test_config_load_jar_sites():
    """config 加载含 csp_ 站点的配置"""
    # 清空现有站点
    server.sites.destroy_all()
    server.config_mgr = server.ConfigManager(server.sites)
    java_probe.clear_cache()
    java_available = java_probe.find_java() is not None

    cfg = {
        # fixture.invalid 是 RFC 2606 保留的 .invalid TLD：永不解析、永不发包。
        # 此前用真实域名 example.com——有 JDK 的机器上 csp_ 站点构建会真的发起
        # 公网请求（审查 T-8）。仍带 md5 且为 https：jar 下载完整性严格模式
        # （YUKI_JAR_INSECURE_SOURCES）要求的是校验值存在，本用例预期失败路径
        # 是「域名不可达」，不触网即可成立。
        'spider': 'https://fixture.invalid/spider.jar;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'sites': [
            {'key': 'py-site', 'name': 'Py源', 'type': 3, 'api': '''from base.spider import Spider
class Spider(Spider):
    def init(self,extend=''):pass
    def getName(self):return 'py'
    def homeContent(self,filter):return {'class':[{'type_id':'1','type_name':'电影'}],'list':[]}
    def searchContent(self,key,quick,pg='1'):return {'list':[]}
    def detailContent(self,ids):return {'list':[{'vod_id':'1','vod_name':'t'}]}
    def playerContent(self,flag,id,vipFlags):return {'url':id,'parse':0}
'''},
            {'key': 'jar-site', 'name': 'JAR源', 'type': 3, 'api': 'csp_Test', 'ext': 'ext'},
            {'key': 'skip-me', 'name': '跳过类型', 'type': 2, 'api': 'http://x'},
        ],
        'parses': [],
        'flags': [],
        'lives': [],
    }

    summary = server.config_mgr.load(json.dumps(cfg, ensure_ascii=False))
    check('jar config: python site loaded', summary['sites'] >= 1, str(summary))
    if java_available:
        # Java 可用时 csp_ 站点需 jar 下载 → 连不上 jar URL → 失败进入 skipped
        check('jar config: jar site skipped (no jar url or unreachable)',
              'jar-site' in str(summary.get('skipped', [])), str(summary))
    else:
        check('jar config: jar site skipped (no java)',
              'jar-site' in str(summary.get('skipped', [])), str(summary))

    # state 中 site 带 spiderType 字段（无条件断言，审查 T-8：此前
    # `if st['sites']` 在站点列表为空时整条断言静默蒸发，假绿）
    st = server.config_mgr.state()
    check('jar config: state non-empty', bool(st['sites']), str(st))
    check('jar config: site has spiderType', all('spiderType' in s for s in st['sites']),
          str(st['sites']))


def test_methodref_patch_slot_alignment():
    """jar_patch 常量池索引必须按真实槽位解析（审查 M-5）。

    long/double（tag 5/6）在 JVM 常量池占 2 个槽位：其后条目的索引整体 +1。
    此前实现用「列表下标 + 1」当槽位索引，含 long/double 常量的 class 里
    Methodref/Class/NameAndType 全部错位，补丁静默漏打。这里手工构造
    「Methodref 之前有 Long」的最小 class 验证补丁仍正确定位与重定向。
    """
    from jar_patch import patch_methodref_class

    def u2(v):
        return int(v).to_bytes(2, 'big')

    def build(entries):
        """构造最小 class 文件。entries: (tag, payload)；long/double 双槽位。"""
        body = b''
        slot = 1
        for tag, payload in entries:
            if tag == 1:
                body += b'\x01' + u2(len(payload)) + payload
            else:
                body += bytes([tag]) + payload
            slot += 2 if tag in (5, 6) else 1
        # cp_count 落在最后一个槽位之后（long/double 额外吃一个槽位号）
        count = slot + (1 if entries and entries[-1][0] in (5, 6) else 0)
        return b'\xca\xfe\xba\xbe' + b'\x00\x00' + b'\x00\x00' + u2(count) + body

    desc = b'(Landroid/content/Context;Ljava/lang/String;)V'
    common = [
        (1, b'java/lang/Object'),                       # slot 1
        (7, u2(1)),                                     # slot 2: Class(Object)
    ]

    # ── 用例 1：Methodref 前有 Long（占 2 槽位）────────────────────────────
    # 槽位：1 Utf8(Object) 2 Class(Object) 3-4 Long
    # 5 Utf8(Pan) 6 Class(Pan) 7 Utf8(init) 8 Utf8(desc) 9 NAT 10 Methodref
    # 11 Utf8(Spider) 12 Class(Spider)
    with_long = [
        *common,
        (5, (1 << 62).to_bytes(8, 'big')),              # slots 3-4
        (1, b'com/github/catvod/spider/Pan'),           # slot 5
        (7, u2(5)),                                     # slot 6: Class(Pan)
        (1, b'init'),                                   # slot 7
        (1, desc),                                      # slot 8
        (12, u2(7) + u2(8)),                            # slot 9: NAT
        (10, u2(6) + u2(9)),                            # slot 10: Methodref(Pan, NAT)
        (1, b'com/github/catvod/crawler/Spider'),       # slot 11
        (7, u2(11)),                                    # slot 12: Class(Spider)
    ]
    data = build(with_long)
    patched, count = patch_methodref_class(
        data, 'com/github/catvod/spider/Pan', 'init', desc.decode(),
        'com/github/catvod/crawler/Spider')
    check('methodref patch: long/double class patched', count == 1, f'count={count}')
    # Methodref 的 class_index 被改写为 12（Spider 的 Class 槽位）
    from jar_patch import _parse_cp
    es, _ = _parse_cp(patched)
    by_slot = {e[4]: e for e in es}
    mref = by_slot[10]
    cidx = int.from_bytes(patched[mref[2]:mref[2] + 2], 'big')
    check('methodref patch: redirected to Spider class slot', cidx == 12, f'cidx={cidx}')

    # ── 用例 2：无 long/double 的普通 class（回归）─────────────────────────
    plain = [
        *common,                                        # 1, 2
        (1, b'com/github/catvod/spider/Pan'),           # slot 3
        (7, u2(3)),                                     # slot 4: Class(Pan)
        (1, b'init'),                                   # slot 5
        (1, desc),                                      # slot 6
        (12, u2(5) + u2(6)),                            # slot 7: NAT
        (10, u2(4) + u2(7)),                            # slot 8: Methodref(Pan, NAT)
        (1, b'com/github/catvod/crawler/Spider'),       # slot 9
        (7, u2(9)),                                     # slot 10: Class(Spider)
    ]
    data2 = build(plain)
    patched2, count2 = patch_methodref_class(
        data2, 'com/github/catvod/spider/Pan', 'init', desc.decode(),
        'com/github/catvod/crawler/Spider')
    check('methodref patch: plain class patched', count2 == 1, f'count={count2}')
    es2, _ = _parse_cp(patched2)
    by2 = {e[4]: e for e in es2}
    mref2 = by2[8]
    cidx2 = int.from_bytes(patched2[mref2[2]:mref2[2] + 2], 'big')
    check('methodref patch: plain redirected to Spider', cidx2 == 10, f'cidx={cidx2}')

    # ── 用例 3：new_owner 不在常量池时不修改 ───────────────────────────────
    data3 = build(plain)
    patched3, count3 = patch_methodref_class(
        data3, 'com/github/catvod/spider/Pan', 'init', desc.decode(),
        'com/example/NotThere')
    check('methodref patch: missing target is no-op',
          count3 == 0 and patched3 == data3, f'count={count3}')


def main():
    try:
        test_java_probe()
        test_norm_jar_src()
        test_jar_spider_direct()
        test_config_load_jar_sites()
        test_methodref_patch_slot_alignment()
    finally:
        # 配置站点现在由 spawn Supervisor 持有，脚本结束必须走与应用退出
        # 相同的显式回收链，不能依赖 Future/解释器隐式退出。
        server.sites.destroy_all()

    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
