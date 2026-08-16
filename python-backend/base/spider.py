import re
import os
import json
import time
import urllib.parse
import hoststate
import http_client
from lxml import etree
from abc import abstractmethod, ABCMeta
from importlib.machinery import SourceFileLoader


class Spider(metaclass=ABCMeta):
    _instance = None

    def __init__(self):
        self.extend = ''

    def __new__(cls, *args, **kwargs):
        if cls._instance:
            return cls._instance
        cls._instance = super().__new__(cls)
        return cls._instance

    @abstractmethod
    def init(self, extend=''):
        pass

    def homeContent(self, filter):
        pass

    def homeVideoContent(self):
        pass

    def categoryContent(self, tid, pg, filter, extend):
        pass

    def detailContent(self, ids):
        pass

    def searchContent(self, key, quick, pg='1'):
        pass

    def playerContent(self, flag, id, vipFlags):
        pass

    def liveContent(self, url):
        pass

    def localProxy(self, param):
        pass

    def isVideoFormat(self, url):
        pass

    def manualVideoCheck(self):
        pass

    def action(self, action):
        pass

    def destroy(self):
        pass

    def getName(self):
        pass

    def getDependence(self):
        return []

    def loadSpider(self, name):
        return self.loadModule(name).Spider()

    def loadModule(self, name):
        cache_dir = hoststate.get_cache_dir()
        path = os.path.join(os.path.join(cache_dir, 'py'), f'{name}.py')
        return SourceFileLoader(name, path).load_module()

    def regStr(self, reg, src, group=1):
        m = re.search(reg, src)
        src = ''
        if m:
            src = m.group(group)
        return src

    def removeHtmlTags(self, src):
        clean = re.compile('<.*?>')
        return re.sub(clean, '', src)

    def cleanText(self, src):
        clean = re.sub('[😀-🙏🌀-🗿🚀-\U0001f6ff\U0001f1e0-🇿]', '', src)
        return clean

    def fetch(self, url, params=None, cookies=None, headers=None, timeout=5, verify=True, stream=False, allow_redirects=True):
        rsp = http_client.get(url, params=params, cookies=cookies, headers=headers, timeout=timeout, verify=verify, stream=stream, allow_redirects=allow_redirects)
        rsp.encoding = 'utf-8'
        return rsp

    def post(self, url, params=None, data=None, json=None, cookies=None, headers=None, timeout=5, verify=True, stream=False, allow_redirects=True):
        rsp = http_client.post(url, params=params, data=data, json=json, cookies=cookies, headers=headers, timeout=timeout, verify=verify, stream=stream, allow_redirects=allow_redirects)
        rsp.encoding = 'utf-8'
        return rsp

    def html(self, content):
        return etree.HTML(content)

    @staticmethod
    def str2json(text):
        return json.loads(text)

    @staticmethod
    def json2str(obj):
        return json.dumps(obj, ensure_ascii=False)

    def getProxyUrl(self, local=True):
        return f"{hoststate.get_proxy_url(local)}?do=py"

    def log(self, msg):
        if isinstance(msg, dict) or isinstance(msg, list):
            print(json.dumps(msg, ensure_ascii=False))
        else:
            print(f'{msg}')

    def getCache(self, key):
        # key 需 URL 编码（M-22）：含 &/=/#/中文等字符的 key 不编码会被
        # 拆成多个查询参数或截断
        k = urllib.parse.quote(str(key), safe='')
        value = self.fetch(f'http://127.0.0.1:{hoststate.get_port()}/cache?do=get&key={k}', timeout=5).text
        if len(value) > 0:
            if value.startswith('{') and value.endswith('}') or value.startswith('[') and value.endswith(']'):
                value = json.loads(value)
                if type(value) == dict:
                    if 'expiresAt' not in value or value['expiresAt'] >= int(time.time()):
                        return value
                    else:
                        self.delCache(key)
                        return None
            return value
        else:
            return None

    def setCache(self, key, value):
        if type(value) in (int, float):
            value = str(value)
        if len(value) > 0:
            if type(value) == dict or type(value) == list:
                value = json.dumps(value, ensure_ascii=False)
        k = urllib.parse.quote(str(key), safe='')
        r = self.post(f'http://127.0.0.1:{hoststate.get_port()}/cache?do=set&key={k}', data={'value': value}, timeout=5)
        return 'succeed' if r.status_code == 200 else 'failed'

    def delCache(self, key):
        k = urllib.parse.quote(str(key), safe='')
        r = self.fetch(f'http://127.0.0.1:{hoststate.get_port()}/cache?do=del&key={k}', timeout=5)
        return 'succeed' if r.status_code == 200 else 'failed'
