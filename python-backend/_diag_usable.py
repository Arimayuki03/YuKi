# -*- coding: utf-8 -*-
"""全量可用源统计：对每个仓构建所有站点并实测 homeContent，统计可用源数量。

可用 = homeContent 返回 list 非空 或 class 非空（有分类可浏览）。
输出 JSON 到 _usable_report.json，控制台打印按可用数降序的摘要。
"""
import sys
import os
import json
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.disable(logging.CRITICAL)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import app as app_mod
_orig_redirect = app_mod.redirect

def short_redirect(url, timeout=15):
    """子蜘蛛下载短超时（真实网络，但限制单站耗时）。"""
    return _orig_redirect(url, timeout=min(timeout, 5))

app_mod.redirect = short_redirect

import jar_bridge as jb
jb.CALL_TIMEOUT = 12  # JVM 桥单次调用上限（防挂死）

import server
from config import ConfigManager, parse_config_json
cm = ConfigManager(server.sites)

REPOS = [
    ("王小二新", "https://9280.kstore.vip/newwex.json", 'single'),
    ("哈基米", "https://17264.kstore.space/哈基米.png", 'single'),
    ("王二小", "http://tvbox.王二小放牛娃.top", 'single'),
    ("菜妮丝", "https://tv.菜妮丝.top", 'single'),
    ("HG", "https://api.hgyx.vip/hgyx.json", 'single'),
    ("香雅情", "https://raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json", 'single'),
    ("小苹果", "https://bitbucket.org/xduo/duoapi/raw/master/xpg.json", 'single'),
    ("驸马", "http://fmys.top/fmys.json", 'single'),
    ("分享", "https://raw.githubusercontent.com/maoystv/6/main/000.json", 'single'),
    ("L佬", "https://android.lushunming.qzz.io/json/index.json", 'single'),
    ("苹果CMS", "https://pastebin.com/raw/gtbKvnE1", 'single'),
    ("老刘备", "https://raw.liucn.cc/box/m.json", 'single'),
    ("欧歌", "https://xn--anna-wn6lw489o.v.nxog.top/m/", 'single'),
    ("饭太硬", "http://www.饭太硬.net/tv", 'single'),
    ("游魂多仓", "https://www.iyouhun.com/tv/dc", 'multi'),
    ("小盒子多仓", "http://xhztv.top/DC.txt", 'multi'),
    ("高天多仓", "https://cdn.jsdelivr.net/gh/gaotianliuyun/gao@master/0707.json", 'multi'),
]

def probe_site(site):
    """单站点可用性探测：homeContent 有内容即可用。返回 (key, name, usable, cls, lst, err)。"""
    try:
        hc = site.runner.homeContent(False)
        if not isinstance(hc, dict):
            hc = {}
        cls = len(hc.get('class') or [])
        lst = len(hc.get('list') or [])
        usable = lst > 0 or cls > 0
        return (site.key, (site.name or ''), usable, cls, lst, '')
    except Exception as e:
        return (site.key, (site.name or ''), False, 0, 0, str(e)[:60])

def build_and_probe(name, url, kind):
    t0 = time.time()
    try:
        if kind == 'multi':
            summ = cm.load(url)
            sites = list(cm.sites.sites)
            built = summ.get('sites', 0)
        else:
            text = cm._fetch_config(url)
            cfg = parse_config_json(text)
            prep = cm._prepare(cfg, url)
            sites = prep['sites']
            built = prep['summary']['sites']
        total = len(sites)
        usable = 0
        per_site = []
        # 站点探测：同仓内串行（jar 桥共享），多仓由外层并行
        for s in sites:
            r = probe_site(s)
            per_site.append(r)
            if r[2]:
                usable += 1
        dt = time.time() - t0
        return {
            'repo': name, 'url': url, 'built': built, 'total': total,
            'usable': usable, 'seconds': round(dt, 1), 'sites': per_site,
        }
    except Exception as e:
        return {'repo': name, 'url': url, 'built': 0, 'total': 0, 'usable': 0,
                'seconds': round(time.time() - t0, 1), 'error': str(e)[:120], 'sites': []}

results = []
with ThreadPoolExecutor(max_workers=4) as pool:
    futs = {pool.submit(build_and_probe, n, u, k): n for n, u, k in REPOS}
    for fut in as_completed(futs):
        r = fut.result()
        results.append(r)
        print('[%s] built=%d usable=%d total=%d %.0fs%s' % (
            r['repo'], r['built'], r['usable'], r['total'], r['seconds'],
            (' ERR:' + r['error']) if r.get('error') else ''))

results.sort(key=lambda r: r['usable'], reverse=True)
with open('_usable_report.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print('\n==== 排序摘要（按可用源数降序）====')
for r in results:
    print('%-10s 可用 %4d / 构建 %4d' % (r['repo'], r['usable'], r['built']))
