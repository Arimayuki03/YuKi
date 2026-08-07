# -*- coding: utf-8 -*-
"""Phase 3 测试：CatVod config 加载（Py 内联源 + JS 双协议源）+ 全链路 + SSE。

用法：<venv>/python tests/test_phase3.py
"""
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.parse

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, 'js-engine'))

PORT = 8322
TOKEN = 'p3-token'
os.environ['VPC_PORT'] = str(PORT)
os.environ['VPC_TOKEN'] = TOKEN

import hoststate  # noqa: E402

hoststate.configure(port=PORT, token=TOKEN)
hoststate.ensure_dirs()

import server  # noqa: E402
import uvicorn  # noqa: E402

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print(f'[PASS] {name}')
    else:
        FAILED.append(name)
        print(f'[FAIL] {name} {detail}')


def req(method, path, data=None, with_token=True):
    url = f'http://127.0.0.1:{PORT}{path}'
    if with_token:
        url += ('&' if '?' in url else '?') + 'token=' + TOKEN
    body = None
    headers = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as rsp:
            return rsp.status, rsp.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')


PY_SRC = '''
from base.spider import Spider

class Spider(Spider):
    def init(self, extend=''):
        self.extend = extend
    def getName(self):
        return '内联Py源'
    def homeContent(self, filter):
        return {'class': [{'type_id': 'py', 'type_name': 'Py分类'}], 'list': []}
    def searchContent(self, key, quick, pg='1'):
        return {'list': [{'vod_id': 'py-1', 'vod_name': key + '(Py结果)'}]}
    def detailContent(self, ids):
        return {'list': [{'vod_id': ids[0], 'vod_name': 'Py详情'}]}
    def playerContent(self, flag, id, vipFlags):
        return {'url': id, 'parse': 0}
'''

JS_DEFAULT_SRC = ('export default { init: function(){}, '
                  'home: function(){ return JSON.stringify({list: []}); }, '
                  'search: function(wd){ return JSON.stringify('
                  '{list: [{vod_id: "jsd-1", vod_name: wd + "(默认导出)"}]}); } };')

JS_EVAL_SRC = open(os.path.join(FIX, 'demo_js.js'), encoding='utf-8').read()

CONFIG = {
    'spider': 'http://example.com/tv.jar;md5',
    'sites': [
        {'key': 'ipy', 'name': '内联Py源', 'type': 3, 'api': PY_SRC, 'ext': 'ext-py'},
        {'key': 'ijs', 'name': 'JS示例', 'type': 4, 'api': JS_EVAL_SRC, 'ext': 'ext-js'},
        {'key': 'ijsd', 'name': 'JS默认导出', 'type': 4, 'api': JS_DEFAULT_SRC},
        {'key': 'skip1', 'name': '不支持类型', 'type': 2, 'api': 'http://x'},
    ],
    'parses': [{'name': 'p1', 'type': 0, 'url': 'http://parse'}],
    'flags': ['demo'],
    'lives': [],
}


def main():
    # ---- 1. config 加载（含热替换、类型过滤） ----
    summary = server.config_mgr.load(json.dumps(CONFIG, ensure_ascii=False))
    check('config sites loaded == 3', summary['sites'] == 3, str(summary))
    check('unsupported type skipped', any('skip1' in str(s) for s in summary['skipped']), str(summary))

    def runner_of(key):
        return server.sites.get(key).runner

    # ---- 2. Python 源全链路（经恢复版 app.py 入口） ----
    import app as spider_app
    r = runner_of('ipy')
    home = json.loads(spider_app.homeContent(r, False))
    check('py homeContent', home['class'][0]['type_id'] == 'py', str(home)[:80])
    sr = json.loads(spider_app.searchContent(r, '甲', '0'))
    check('py searchContent', sr['list'][0]['vod_name'] == '甲(Py结果)', str(sr)[:80])
    de = json.loads(spider_app.detailContent(r, '["pid-9"]'))
    check('py detailContent', de['list'][0]['vod_id'] == 'pid-9', str(de)[:80])

    # ---- 3. JS 源（__jsEvalReturn 协议 + 异步 home + 宿主注入面） ----
    rj = runner_of('ijs')
    hj = json.loads(spider_app.homeContent(rj, True))
    meta = hj.get('meta', {})
    check('js homeContent(async Promise)', hj['class'][0]['type_id'] == 'js', str(hj)[:100])
    check('js req() injected', meta.get('hasReq') is True, str(meta))
    check('js cheerio injected', meta.get('hasCheerio') is True, str(meta))
    check('js CryptoJS injected', meta.get('hasCrypto') is True, str(meta))
    check('js init(ext) received', meta.get('extSeen') == 'ext-js', str(meta))
    sj = json.loads(spider_app.searchContent(rj, '乙', '0'))
    check('js searchContent', sj['list'][0]['vod_name'] == '乙(JS结果)', str(sj)[:80])
    pj = json.loads(spider_app.playerContent(rj, 'jsdemo', 'js://ep1', '[]'))
    check('js playerContent', pj['url'] == 'js://ep1', str(pj)[:80])

    # ---- 4. JS 源（default 导出协议） ----
    rd = runner_of('ijsd')
    sd = json.loads(spider_app.searchContent(rd, '丙', '0'))
    check('js default-export search', sd['list'][0]['vod_name'] == '丙(默认导出)', str(sd)[:80])

    # ---- 5. HTTP 端点：/sites、SSE、热更新 ----
    app = server.create_app()
    cfg = uvicorn.Config(app, host='127.0.0.1', port=PORT, log_level='error')
    srv = uvicorn.Server(cfg)
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)

    code, body = req('GET', '/sites')
    st = json.loads(body)
    check('/sites state', code == 200 and len(st['sites']) == 3 and len(st['parses']) == 1, body[:120])

    # ---- CMS 适配（type=0/1 纯 HTTP 站源）：无网络构造与播放判定 ----
    from cms_spider import CmsSpider
    cms = CmsSpider('c1', 'http://cms.example/api.php', 1, 'CMS站')
    play = cms.playerContent('f', 'http://a/b.m3u8', [])
    check('cms player direct link', play['parse'] == 0 and play['url'] == 'http://a/b.m3u8', str(play))
    play2 = cms.playerContent('f', 'http://a/page.html', [])
    check('cms player needs parse', play2['parse'] == 1, str(play2))
    xml_sample = ('<?xml version="1.0"?><rss><page>1</page><pagecount>2</pagecount>'
                  '<class><ty id="1">电影</ty></class>'
                  '<list><video><id>9</id><name>X</name></video></list></rss>')
    parsed = cms._parse_xml(xml_sample)
    check('cms xml parse', parsed['class'][0]['type_name'] == '电影' and parsed.get('total') is None
          and parsed['pagecount'] == '2', str(parsed)[:120])

    code, body = req('GET', '/search/stream?word=' + urllib.parse.quote('测试'))
    data_events = [l[6:] for l in body.split('\n') if l.startswith('data: ')]
    check('SSE event count (3 sources + done)', len(data_events) == 4, body[:200])
    sources = {json.loads(e)['source'] for e in data_events if e.strip() != '{}'}
    check('SSE all sources streamed', sources == {'ipy', 'ijs', 'ijsd'}, str(sources))
    check('SSE done event', 'event: done' in body, body[-100:])

    # ---- 6. 热更新：do=setting name=config 替换为单源配置（异步任务，轮询结果）----
    new_cfg = json.dumps({'sites': [{'key': 'ipy', 'name': '内联Py源', 'type': 3, 'api': PY_SRC}]},
                         ensure_ascii=False)
    code, body = req('POST', '/action', data={'do': 'setting', 'name': 'config', 'text': new_cfg})
    resp = json.loads(body)
    check('hot reload accepted', code == 200 and resp.get('code') == 202, body[:150])
    summary = None
    for _ in range(30):
        c2, b2 = req('POST', '/action', data={'do': 'configTask'})
        task = json.loads(b2)
        if task.get('status') in ('done', 'error'):
            summary = task.get('summary')
            break
        time.sleep(1)
    check('hot reload via setting', c2 == 200 and summary and summary['sites'] == 1, str(summary)[:150])
    check('sites replaced', [s.key for s in server.sites.sites] == ['ipy'],
          str([s.key for s in server.sites.sites]))

    # ---- 缓存清理 / 外部文本拉取（直播源） ----
    server.cache_store.set('t_ck', 'v1')
    c3, b3 = req('POST', '/action', data={'do': 'clearCache'})
    r3 = json.loads(b3)
    check('clearCache', c3 == 200 and r3.get('code') == 200 and server.cache_store.get('t_ck') == '', b3[:80])
    c4, b4 = req('POST', '/action', data={'do': 'fetchText', 'url': f'http://127.0.0.1:{PORT}/health'})
    r4 = json.loads(b4)
    check('fetchText', c4 == 200 and 'status' in r4.get('text', ''), b4[:80])

    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    srv.should_exit = True
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
