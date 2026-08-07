# -*- coding: utf-8 -*-
"""示例源（Demo Spider）：用于 Phase 1 链路自测与 UI 联调。

返回固定 mock 数据，不访问外网；Phase 3 起由真实源替换。
插件约定：顶层类名 Spider，继承 base.spider.Spider，必须实现 init。
"""
from base.spider import Spider


class Spider(Spider):
    def init(self, extend=''):
        self.extend = extend

    def getName(self):
        return '示例源'

    def getDependence(self):
        return []

    def homeContent(self, filter):
        return {
            'class': [
                {'type_id': 'movie', 'type_name': '电影'},
                {'type_id': 'serie', 'type_name': '剧集'},
            ],
            'list': [
                {'vod_id': 'demo-1', 'vod_name': '示例影片 A', 'vod_pic': '', 'vod_remarks': 'HD'},
                {'vod_id': 'demo-2', 'vod_name': '示例影片 B', 'vod_pic': '', 'vod_remarks': '4K'},
            ],
            'filters': {},
        }

    def homeVideoContent(self):
        return {'list': self.homeContent(False)['list']}

    def categoryContent(self, tid, pg, filter, extend):
        return {'list': [], 'page': int(pg or 1), 'pagecount': 1, 'limit': 0, 'total': 0}

    def detailContent(self, ids):
        vod_id = ids[0] if ids else 'demo-1'
        return {'list': [{
            'vod_id': vod_id,
            'vod_name': '示例影片',
            'type_name': '电影',
            'vod_play_from': 'demo',
            'vod_play_url': '第1集$demo://ep1#第2集$demo://ep2',
        }]}

    def searchContent(self, key, quick, pg='1'):
        return {'list': [{
            'vod_id': 'demo-search-1',
            'vod_name': f'{key} (示例结果)',
            'vod_pic': '',
            'vod_remarks': 'Demo',
        }]}

    def playerContent(self, flag, id, vipFlags):
        # Phase 4 起返回公开样片直链，供 mpv 端到端起播验证
        samples = {
            'demo://ep1': 'https://media.w3.org/2010/05/sintel/trailer.mp4',
            'demo://ep2': 'https://vjs.zencdn.net/v/oceans.mp4',
        }
        return {'url': samples.get(id, id), 'parse': 0, 'header': {}}

    def localProxy(self, param):
        return [200, 'text/plain; charset=utf-8', 'demo-proxy-ok'.encode('utf-8')]

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False
