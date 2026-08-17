from base.spider import Spider as BaseSpider


class Spider(BaseSpider):
    _instance = None

    def init(self, extend=''):
        self.extend = extend

    def getName(self):
        return 'Offline Error'

    def homeContent(self, filter):
        raise ValueError('fixture error token=secret Cookie: session=private')

    def destroy(self):
        return None
