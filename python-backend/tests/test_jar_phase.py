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
        'spider': 'https://example.com/spider.jar;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

    # state 中 site 带 spiderType 字段
    st = server.config_mgr.state()
    if st['sites']:
        check('jar config: site has spiderType', all('spiderType' in s for s in st['sites']), str(st['sites']))


def main():
    try:
        test_java_probe()
        test_norm_jar_src()
        test_jar_spider_direct()
        test_config_load_jar_sites()
    finally:
        # 配置站点现在由 spawn Supervisor 持有，脚本结束必须走与应用退出
        # 相同的显式回收链，不能依赖 Future/解释器隐式退出。
        server.sites.destroy_all()

    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
