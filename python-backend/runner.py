import inspect


class Runner:
    def __init__(self, spider):
        self.spider = spider

    def getDependence(self):
        return self.spider.getDependence()

    def getName(self):
        return self.spider.getName()

    def init(self, extend=''):
        self.spider.init(extend)

    def homeContent(self, filter):
        return self.spider.homeContent(filter)

    def homeVideoContent(self, pg='1'):
        # T76：「全部」总览 feed 分页；旧爬虫不接受 pg 参数则回退无参调用。
        # L-20：签名预检代替 except TypeError——业务代码抛出的 TypeError
        # 不再被误判为"旧签名"而触发二次调用（副作用翻倍）
        try:
            n = len(inspect.signature(self.spider.homeVideoContent).parameters)
        except (TypeError, ValueError):
            n = 1
        return self.spider.homeVideoContent(pg) if n >= 1 else self.spider.homeVideoContent()

    def categoryContent(self, tid, pg, filter, extend):
        return self.spider.categoryContent(tid, pg, filter, extend)

    def detailContent(self, ids):
        return self.spider.detailContent(ids)

    def searchContent(self, key, quick, pg='1'):
        return self.spider.searchContent(key, quick, pg)

    def playerContent(self, flag, id, vipFlags):
        return self.spider.playerContent(flag, id, vipFlags)

    def liveContent(self, url):
        return self.spider.liveContent(url)

    def localProxy(self, param):
        return self.spider.localProxy(param)

    def proxy(self, param):
        """统一 FongMi proxy 入口：JAR 优先使用静态 Proxy.proxy(Map)。"""
        static = getattr(self.spider, 'proxy_static', None)
        if callable(static):
            return static(param)
        return self.spider.localProxy(param)

    def isVideoFormat(self, url):
        return self.spider.isVideoFormat(url)

    def manualVideoCheck(self):
        return self.spider.manualVideoCheck()

    def action(self, action):
        return self.spider.action(action)

    def destroy(self):
        self.spider.destroy()
