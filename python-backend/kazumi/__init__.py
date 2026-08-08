# -*- coding: utf-8 -*-
"""Kazumi 规则引擎包。

与 CatVod Spider 引擎（app.py/runner.py/base/spider.py）完全隔离，
不继承 base.spider.Spider，不进入 SiteManager，避免单例污染。
"""
