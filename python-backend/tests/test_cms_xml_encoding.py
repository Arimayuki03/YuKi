# -*- coding: utf-8 -*-
"""苹果 CMS（type=0）XML 响应解析的编码与安全检查。

回归背景（2026-09 全项目审查）：_parse_xml 曾对 str 输入做 text.encode('utf-8') 再喂
ElementTree。_fetch 已按 apparent_encoding 把响应解成 str，而国内苹果 CMS 大量声明
<?xml version="1.0" encoding="GBK"?>；ElementTree 读到 GBK 声明就用 GBK 去解 UTF-8
字节，实测抛 ValueError: multi-byte encodings are not supported —— 这类站点全部失效。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cms_spider import CmsSpider    # noqa: E402

_GBK_DOC = ('<?xml version="1.0" encoding="GBK"?><rss><list>'
            '<video><name>凡人修仙传</name><id>12</id></video></list></rss>')
_UTF8_DOC = ('<?xml version="1.0" encoding="UTF-8"?><rss><page>2</page><list>'
             '<video><name>测试影片</name></video></list></rss>')


def _spider():
    # _parse_xml 不触网、不用实例状态，绕过需要 api 的 __init__
    return CmsSpider.__new__(CmsSpider)


class XmlEncodingTests(unittest.TestCase):

    def test_gbk_declared_str_parses(self):
        data = _spider()._parse_xml(_GBK_DOC)
        self.assertEqual(data['list'][0]['vod_name'], '凡人修仙传')
        self.assertEqual(data['list'][0]['vod_id'], '12')

    def test_utf8_declared_str_parses(self):
        data = _spider()._parse_xml(_UTF8_DOC)
        self.assertEqual(data['list'][0]['vod_name'], '测试影片')
        self.assertEqual(data['page'], '2')

    def test_gb2312_declared_str_parses(self):
        doc = _GBK_DOC.replace('encoding="GBK"', 'encoding="gb2312"')
        self.assertEqual(_spider()._parse_xml(doc)['list'][0]['vod_name'], '凡人修仙传')

    def test_no_declaration_means_no_reencoding(self):
        """无编码声明的 str 文档同样要能解析（防止退回到「按声明重编码」的实现）。"""
        doc = '<?xml version="1.0"?><rss><list><video><name>无声明</name></video></list></rss>'
        self.assertEqual(_spider()._parse_xml(doc)['list'][0]['vod_name'], '无声明')


class XmlBytesFallbackTests(unittest.TestCase):
    """调用方给原始字节时（生产 _fetch 只给 str，此为兜底路径），按声明编码解码。"""

    def test_gbk_bytes_use_declared_codec(self):
        data = _spider()._parse_xml(_GBK_DOC.encode('gbk'))
        self.assertEqual(data['list'][0]['vod_name'], '凡人修仙传')

    def test_undecleared_bytes_default_to_utf8(self):
        doc = '<?xml version="1.0"?><rss><list><video><name>纯UTF8</name></video></list></rss>'
        self.assertEqual(_spider()._parse_xml(doc.encode('utf-8'))['list'][0]['vod_name'], '纯UTF8')

    def test_unknown_declared_codec_falls_back(self):
        """声明了不存在的编码名时不得抛 LookupError，应回退 utf-8 继续解析。"""
        doc = _GBK_DOC.replace('encoding="GBK"', 'encoding="NOT-A-CODEC"')
        data = _spider()._parse_xml(doc.encode('utf-8'))
        self.assertEqual(data['list'][0]['vod_name'], '凡人修仙传')


class XmlClassMappingTests(unittest.TestCase):

    def test_class_ty_nodes_map_to_type_id_name(self):
        doc = ('<?xml version="1.0" encoding="GBK"?><rss><class>'
               '<ty id="1">国产剧</ty><ty id="2">港台剧</ty></class><list/></rss>')
        classes = _spider()._parse_xml(doc)['class']
        self.assertEqual([c['type_id'] for c in classes], ['1', '2'])
        self.assertEqual([c['type_name'] for c in classes], ['国产剧', '港台剧'])


class XmlSecurityTests(unittest.TestCase):
    """L-24 billion-laughs / XXE 防护不得因编码修复而退化。"""

    def test_doctype_rejected(self):
        doc = ('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY e "x">]>'
               '<rss><list><video><name>&e;</name></video></list></rss>')
        with self.assertRaises(ValueError):
            _spider()._parse_xml(doc)

    def test_entity_rejected_without_doctype_keyword(self):
        doc = ('<?xml version="1.0" encoding="GBK"?><!ENTITY x "y">'
               '<rss><list/></rss>')
        with self.assertRaises(ValueError):
            _spider()._parse_xml(doc)


if __name__ == '__main__':
    unittest.main(verbosity=2)
