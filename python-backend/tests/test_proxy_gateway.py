# -*- coding: utf-8 -*-
"""Pure dispatch tests for the shared proxy gateway."""

from __future__ import annotations

import os
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from proxy_gateway import dispatch  # noqa: E402


class Runner:
    def __init__(self, label):
        self.label = label
        self.local_calls = []
        self.proxy_calls = []

    def localProxy(self, params):
        self.local_calls.append(dict(params))
        return self.label + ':local'

    def proxy(self, params):
        self.proxy_calls.append(dict(params))
        return self.label + ':static'


class Site:
    def __init__(self, key, kind):
        self.key = key
        self.spider_type = kind
        self.runner = Runner(key)


class Sites:
    def __init__(self):
        self.items = {
            'js-site': Site('js-site', 'js'),
            'py-site': Site('py-site', 'py'),
            'jar-site': Site('jar-site', 'jar'),
        }
        self.current = None

    def get(self, key=None):
        return self.items.get(key) if key else next(iter(self.items.values()))

    def recent(self, kind=None):
        for site in self.items.values():
            if kind is None or site.spider_type == kind:
                return site
        return None

    def set_recent(self, key):
        self.current = key


class TestProxyGateway(unittest.TestCase):
    def test_explicit_site_uses_instance_proxy(self):
        sites = Sites()
        result = dispatch({'siteKey': 'py-site', 'do': 'py', 'range': 'bytes=0-1'}, sites)
        self.assertEqual(result, 'py-site:local')
        self.assertEqual(sites.items['py-site'].runner.local_calls[-1]['range'], 'bytes=0-1')

    def test_recent_jar_without_site_key_uses_static_proxy(self):
        sites = Sites()
        result = dispatch({'do': 'jar', 'x': '1'}, sites)
        self.assertEqual(result, 'jar-site:static')
        self.assertEqual(sites.current, 'jar-site')

    def test_pan_fallback_keeps_provider_name(self):
        sites = Sites()
        result = dispatch({'do': 'pan', 'site': 'quark', 'fileId': 'fid'}, sites)
        self.assertIn('do=pan', result)
        self.assertIn('site=quark', result)
        self.assertIn('fileId=fid', result)

    def test_health_check_does_not_require_site(self):
        self.assertEqual(dispatch({'do': 'ck'}, Sites()), 'ok')


if __name__ == '__main__':
    unittest.main()
