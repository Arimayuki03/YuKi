# -*- coding: utf-8 -*-
"""保持旧 Runner API 的进程外代理。"""
from __future__ import annotations

import base64

from proxy_contract import ProxyResult

from .contracts import current_runtime_request
from .supervisor import RuntimeSupervisor


class _SpiderState:
    def __init__(self, owner, site_key=''):
        self._owner = owner
        self.site_key = site_key
        self.last_error = ''
        self.request_id = ''
        self.play_session_id = ''

    def setCache(self, key, value):
        return self._owner._invoke('setCache', key, value)

    def getCache(self, key):
        return self._owner._invoke('getCache', key)

    def delCache(self, key):
        return self._owner._invoke('delCache', key)

    def getProxyUrl(self, local=True):
        return self._owner._invoke('getProxyUrl', local)


class SupervisedRunner:
    def __init__(self, spec, policy=None):
        self.supervisor = RuntimeSupervisor(spec, policy=policy)
        self.spider = _SpiderState(self, str((spec or {}).get('site_key') or ''))
        self.bridge = None
        self.last_request_id = ''
        self.last_play_session_id = ''

    def _invoke(self, method, *args):
        request = current_runtime_request()
        if request is not None:
            self.last_request_id = request.request_id
            self.last_play_session_id = request.play_session_id
            self.spider.request_id = request.request_id
            self.spider.play_session_id = request.play_session_id
        result, last_error = self.supervisor.call(method, args, request=request)
        self.spider.last_error = last_error
        return result

    def getDependence(self):
        return self._invoke('getDependence')

    def getName(self):
        return self._invoke('getName')

    def init(self, extend=''):
        return self._invoke('init', extend)

    def homeContent(self, filter):
        return self._invoke('homeContent', filter)

    def homeVideoContent(self, pg='1'):
        return self._invoke('homeVideoContent', pg)

    def categoryContent(self, tid, pg, filter, extend):
        return self._invoke('categoryContent', tid, pg, filter, extend)

    def detailContent(self, ids):
        return self._invoke('detailContent', ids)

    def searchContent(self, key, quick, pg='1'):
        return self._invoke('searchContent', key, quick, pg)

    def playerContent(self, flag, id, vipFlags):
        return self._invoke('playerContent', flag, id, vipFlags)

    def liveContent(self, url):
        return self._invoke('liveContent', url)

    def localProxy(self, param):
        return self._decode_proxy(self._invoke('localProxy', param))

    def proxy(self, param):
        return self._decode_proxy(self._invoke('proxy', param))

    @staticmethod
    def _decode_proxy(result):
        if not isinstance(result, dict) or not result.get('__vpc_proxy__'):
            return result
        headers = {str(key): str(value) for key, value in (result.get('headers') or {}).items()}
        stream = result.get('stream')
        close = None
        if isinstance(stream, dict) and stream.get('port') and stream.get('token'):
            from jar_bridge import JarProxyBody
            body = JarProxyBody(
                stream.get('host') or '127.0.0.1',
                int(stream['port']),
                str(stream['token']),
            )
            close = body.close
        else:
            body = base64.b64decode(str(result.get('body') or ''), validate=False)
        return ProxyResult(
            status=int(result.get('status') or 200),
            mime=str(result.get('mime') or 'application/octet-stream'),
            body=body,
            headers=headers,
            close=close,
        )

    def isVideoFormat(self, url):
        return self._invoke('isVideoFormat', url)

    def manualVideoCheck(self):
        return self._invoke('manualVideoCheck')

    def action(self, action):
        return self._invoke('action', action)

    def cancel_active(self, reason='cancelled'):
        return self.supervisor.cancel_active(reason)

    def cancel_request(self, request_id, reason='cancelled'):
        return self.supervisor.cancel_request(request_id, reason)

    def force_half_open(self):
        self.supervisor.force_half_open()

    def runtime_state(self):
        return self.supervisor.snapshot()

    def destroy(self):
        self.supervisor.destroy()
