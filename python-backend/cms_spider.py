# -*- coding: utf-8 -*-
"""CMS 站源适配（type=0 XML / type=1 JSON，苹果 CMS 标准接口）。

无需任何爬虫运行时，纯 HTTP 直连，是 TVBox 多仓源中占比最大的站点类型：
- 分类：  {api}?ac=class
- 列表：  {api}?ac=videolist&t={tid}&pg={pg}
- 详情：  {api}?ac=videolist&ids={id}
- 搜索：  {api}?wd={key}&pg={pg}
- 播放：  vod_play_from / vod_play_url（直链直出 parse=0）

鸭子接口对齐 Runner 调用面（与 JsSpider 同一装配路径），方法返回 dict
（与 Spider 基类契约一致；app.py 包装层会统一 json.dumps，返回字符串会被二次序列化）。
"""
import json
import logging
import xml.etree.ElementTree as ET

import requests

logger = logging.getLogger('vpc.cms')

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

PLAYABLE = ('.m3u8', '.mp4', '.flv', '.mkv', '.avi', '.ts')


class CmsSpider:
    """单站点实例：每站独立（无基类单例问题）。"""

    def __init__(self, key, api, stype=1, name=''):
        self.key = key
        self.api = api
        self.stype = int(stype)     # 0=XML 1=JSON
        self.site_name = name or key
        self.filter = {}

    def getName(self):
        return self.site_name

    def init(self, extend=''):
        pass

    # ------------------------------------------------------------ 内容 API

    def homeContent(self, filter):
        data = self._fetch({'ac': 'class'})
        classes = [{'type_id': str(c.get('type_id', '')), 'type_name': c.get('type_name', '')}
                   for c in (data.get('class') or []) if c.get('type_id') not in ('', None)]
        result = {'class': classes, 'list': [], 'filters': {}}
        if filter and isinstance(data.get('filters'), dict):
            result['filters'] = data['filters']
            self.filter = data['filters']
        elif filter and isinstance(data.get('filter'), dict):
            result['filters'] = data['filter']
            self.filter = data['filter']
        # 首屏内容：取第一个分类的第一页
        if classes:
            try:
                lst = self._fetch({'ac': 'videolist', 't': classes[0]['type_id'], 'pg': '1'})
                result['list'] = [self._vod_short(v) for v in (lst.get('list') or [])]
            except Exception as e:
                logger.debug('cms %s home list failed: %s', self.key, e)
        return result

    def homeVideoContent(self):
        data = self._fetch({'ac': 'videolist', 'pg': '1'})
        return {'list': [self._vod_short(v) for v in (data.get('list') or [])]}

    def categoryContent(self, tid, pg, filter, extend):
        params = {'ac': 'videolist', 't': str(tid), 'pg': str(pg)}
        if extend:
            for k, v in (extend or {}).items():
                if v:
                    params[k] = str(v)
        data = self._fetch(params)
        result = {
            'page': int(data.get('page') or pg or 1),
            'pagecount': int(data.get('pagecount') or 0),
            'limit': int(data.get('limit') or 20),
            'total': int(data.get('total') or 0),
            'list': [self._vod_short(v) for v in (data.get('list') or [])],
        }
        return result

    def detailContent(self, ids):
        # JSON 源 vod_id 是整数，反序列化后为 int，统一转 str 再拼接
        ids = ','.join(str(i) for i in ids) if isinstance(ids, (list, tuple)) else str(ids)
        data = self._fetch({'ac': 'videolist', 'ids': ids})
        vods = data.get('list') or []
        return {'list': [self._vod_full(vods[0])] if vods else []}

    def searchContent(self, key, quick, pg='1'):
        data = self._fetch({'wd': str(key), 'pg': str(pg)})
        return {'list': [self._vod_short(v) for v in (data.get('list') or [])]}

    def playerContent(self, flag, id, vipFlags):
        # id 即播放地址（CMS 直链）；非媒体后缀交解析器兜底
        url = str(id)
        if url.lower().split('?')[0].endswith(PLAYABLE):
            return {'parse': 0, 'playUrl': '', 'url': url, 'header': json.dumps(UA)}
        return {'parse': 1, 'playUrl': '', 'url': url, 'header': json.dumps(UA)}

    def isVideoFormat(self, url):
        return str(url).lower().split('?')[0].endswith(PLAYABLE)

    def manualVideoCheck(self):
        return False

    def localProxy(self, param):
        return None

    def action(self, action):
        return {}

    def destroy(self):
        pass

    # ------------------------------------------------------------ 工具

    def _fetch(self, params):
        rsp = requests.get(self.api, params=params, headers=UA, timeout=15, verify=False)
        rsp.encoding = rsp.apparent_encoding or 'utf-8'
        text = rsp.text.strip()
        if text.startswith('{') or text.startswith('['):
            return json.loads(text)
        if text.startswith('<'):
            return self._parse_xml(text)
        raise ValueError('cms: unexpected response (%s...)' % text[:30])

    def _parse_xml(self, text):
        """type=0 苹果 CMS XML → 与 JSON 接口同构的 dict。"""
        root = ET.fromstring(text.encode('utf-8') if isinstance(text, str) else text)
        data = {}
        for tag in ('page', 'pagecount', 'limit', 'total'):
            node = root.find(tag)
            if node is not None and node.text:
                data[tag] = node.text
        classes = []
        cls_node = root.find('class')
        if cls_node is not None:
            for ty in cls_node.findall('ty'):
                classes.append({'type_id': ty.get('id', ''), 'type_name': (ty.text or '').strip()})
        data['class'] = classes
        vods = []
        list_node = root.find('list')
        if list_node is not None:
            for v in list_node.findall('video'):
                vods.append(self._xml_video(v))
        data['list'] = vods
        return data

    @staticmethod
    def _xml_video(node):
        """苹果 CMS XML <video> → 标准 vod_* 字段（XML 标签无 vod_ 前缀）。"""
        raw = {c.tag: (c.text or '').strip() for c in node}
        v = {
            'vod_id': raw.get('id', ''),
            'type_id': raw.get('tid', ''),
            'vod_name': raw.get('name', ''),
            'type_name': raw.get('type', ''),
            'vod_pic': raw.get('pic', ''),
            'vod_remarks': raw.get('note', '') or raw.get('state', ''),
            'vod_year': raw.get('year', ''),
            'vod_area': raw.get('area', ''),
            'vod_lang': raw.get('lang', ''),
            'vod_actor': raw.get('actor', ''),
            'vod_director': raw.get('director', ''),
            'vod_content': raw.get('des', ''),
        }
        # 播放源：<dl><dd flag="xxx">剧集$url#...</dd>...</dl>，多线路用 $$$ 拼接
        dl = node.find('dl')
        if dl is not None:
            flags, urls = [], []
            for dd in dl.findall('dd'):
                flags.append(dd.get('flag', ''))
                urls.append((dd.text or '').strip())
            if urls:
                v['vod_play_from'] = '$$$'.join(flags)
                v['vod_play_url'] = '$$$'.join(urls)
        return v

    @staticmethod
    def _vod_short(v):
        return {
            'vod_id': str(v.get('vod_id', '')),
            'vod_name': v.get('vod_name', ''),
            'vod_pic': v.get('vod_pic', ''),
            'vod_remarks': v.get('vod_remarks', '') or v.get('vod_note', ''),
        }

    @staticmethod
    def _vod_full(v):
        out = CmsSpider._vod_short(v)
        for k in ('type_id', 'type_name', 'vod_year', 'vod_area', 'vod_lang', 'vod_actor',
                  'vod_director', 'vod_content', 'vod_play_from', 'vod_play_url', 'vod_tag'):
            val = v.get(k)
            if val:
                out[k] = val
        # XML 侧字段命名差异（旧兼容）
        if 'vod_play_url' not in out and 'dl' in v:
            out['vod_play_url'] = v['dl']
        return out
