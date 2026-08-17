from base.spider import Spider as BaseSpider


class Spider(BaseSpider):
    _instance = None

    def init(self, extend=''):
        self.extend = str(extend or '')

    def getName(self):
        return 'Offline Normal'

    def homeContent(self, filter):
        return {
            'class': [{'type_id': 'fixture', 'type_name': 'Fixture'}],
            'list': [{'vod_id': 'episode-1', 'vod_name': 'Offline Video'}],
        }

    def detailContent(self, ids):
        return {'list': [{
            'vod_id': 'episode-1', 'vod_name': 'Offline Video',
            'vod_play_from': 'fixture',
            'vod_play_url': 'Episode 1$episode-1',
        }]}

    def playerContent(self, flag, id, vipFlags):
        return {'parse': 0, 'url': self.extend + 'media.mp4', 'header': {}}

    def searchContent(self, key, quick, pg='1'):
        return {'list': []}

    def destroy(self):
        return None
