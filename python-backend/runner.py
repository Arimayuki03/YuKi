import inspect

from runtime.contracts import current_runtime_request


class Runner:
    def __init__(self, spider):
        self.spider = spider
        self.last_request_id = ''
        self.last_play_session_id = ''

    def _invoke(self, method, *args):
        """在不改变 Spider 方法签名的前提下贯穿运行时请求上下文。"""
        request = current_runtime_request()
        if request is not None:
            request.raise_if_cancelled()
            self.last_request_id = request.request_id
            self.last_play_session_id = request.play_session_id
            try:
                self.spider.request_id = request.request_id
                self.spider.play_session_id = request.play_session_id
            except Exception:
                pass
        return getattr(self.spider, method)(*args)

    def getDependence(self):
        return self._invoke('getDependence')

    def getName(self):
        return self._invoke('getName')

    def init(self, extend=''):
        return self._invoke('init', extend)

    def homeContent(self, filter):
        return self._invoke('homeContent', filter)

    def homeVideoContent(self, pg='1'):
        # T76：「全部」总览 feed 分页；旧爬虫不接受 pg 参数则回退无参调用。
        # L-20：签名预检代替 except TypeError——业务代码抛出的 TypeError
        # 不再被误判为"旧签名"而触发二次调用（副作用翻倍）
        try:
            n = len(inspect.signature(self.spider.homeVideoContent).parameters)
        except (TypeError, ValueError):
            n = 1
        return self._invoke('homeVideoContent', pg) if n >= 1 else self._invoke('homeVideoContent')

    def categoryContent(self, tid, pg, filter, extend):
        return self._invoke('categoryContent', tid, pg, filter, extend)

    def detailContent(self, ids):
        return self._invoke('detailContent', ids)

    def searchContent(self, key, quick, pg='1'):
        return self._invoke('searchContent', key, quick, pg)

    def playerContent(self, flag, id, vipFlags):
        return self._invoke('playerContent', flag, id, vipFlags)

    def jsonExt(self, key, jxs, url):
        return self._invoke('jsonExt', key, jxs, url)

    def liveContent(self, url):
        return self._invoke('liveContent', url)

    def localProxy(self, param):
        return self._invoke('localProxy', param)

    def proxy(self, param):
        """统一 FongMi proxy 入口：JAR 优先使用静态 Proxy.proxy(Map)。"""
        static = getattr(self.spider, 'proxy_static', None)
        if callable(static):
            request = current_runtime_request()
            if request is not None:
                self.last_request_id = request.request_id
                self.last_play_session_id = request.play_session_id
            return static(param)
        return self._invoke('localProxy', param)

    def isVideoFormat(self, url):
        return self._invoke('isVideoFormat', url)

    def manualVideoCheck(self):
        return self._invoke('manualVideoCheck')

    def action(self, action):
        return self._invoke('action', action)

    def destroy(self):
        return self._invoke('destroy')
