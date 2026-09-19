# -*- coding: utf-8 -*-
"""保持旧 Runner API 的进程外代理。"""
from __future__ import annotations

import base64
import threading

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
        spec = dict(spec or {})
        # P1-5：Worker 是 spawn 的全新解释器，hoststate._state 里 port/token
        # 全空（data_dir 仅 env 兜底）——KV 请求打到 :0、getProxyUrl() 产出
        # 坏地址、JVM 地址 token 为空。宿主侧在 server.main 已经 configure，
        # 在统一的 runner 构造点把三元组补进 spec（缺省注入：config.py 各
        # runtime 分支与 site_manager 本地插件分支自动覆盖，无需逐处改）；
        # token 只经 Pipe 在本机父子进程间传递，可以放 spec。
        try:
            import hoststate
            spec.setdefault('proxy_port', int(hoststate.get_port() or 0))
            spec.setdefault('proxy_token', str(hoststate.get_token() or ''))
            spec.setdefault('data_dir', str(hoststate.get_data_dir() or ''))
        except Exception:
            pass
        self.supervisor = RuntimeSupervisor(spec, policy=policy)
        self.spider = _SpiderState(self, str((spec or {}).get('site_key') or ''))
        self.bridge = None
        # 与 runner.py 的 Runner 同一修法：每站点一个 SupervisedRunner，同一站点会并发
        # 处理多个请求，把 request_id 存成普通实例属性等于存「最后一个碰巧跑完的请求」，
        # 排障时会指到别的请求上。改为线程本地记录本线程最近一次处理的请求。
        self._ctx_tls = threading.local()

    @property
    def last_request_id(self):
        return getattr(self._ctx_tls, 'request_id', '')

    @property
    def last_play_session_id(self):
        return getattr(self._ctx_tls, 'play_session_id', '')

    def _invoke(self, method, *args):
        request = current_runtime_request()
        if request is not None:
            self._ctx_tls.request_id = request.request_id
            self._ctx_tls.play_session_id = request.play_session_id
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

    def jsonExt(self, key, jxs, url):
        return self._invoke('jsonExt', key, jxs, url)

    def liveContent(self, url):
        return self._invoke('liveContent', url)

    def localProxy(self, param):
        return self._decode_proxy(self._invoke('localProxy', param))

    def proxy(self, param):
        return self._decode_proxy(self._invoke('proxy', param))

    @staticmethod
    def _decode_proxy(result):
        if not isinstance(result, dict) or not result.get('__yuki_proxy__'):
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
