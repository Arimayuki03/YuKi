# -*- coding: utf-8 -*-
"""RuleEngine.solve_captcha 自动解题流程测试（桩网络，不发真实请求）。

会话机制（2026-09-29 修复后）：独立 requests.Session 存验证会话 Cookie，
先访问搜索页建会话，取图/提交/复验共享。桩法：mock requests.Session.get
（engine 模块内引用的 requests）按步骤序号回放响应，断言同会话共享 +
守卫调用。覆盖：成功路径、识别失败换图重试、复验仍检出验证码回落、
取图非 PNG/失败、cancel_token 取消、无 base_url 拒绝、MacCMS 端点形态、
Cookie 落盘、主搜索路径零网络契约不被破坏。
"""
import os
import sys
import threading
import time
import unittest
from unittest import mock

import requests  # noqa: E402  ProxyError 回退测试用

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import kazumi.rule_engine as rule_engine_mod  # noqa: E402
from kazumi.rule_engine import RuleEngine, _looks_like_image  # noqa: E402
from kazumi.utils import CaptchaRequiredException, NoResultException  # noqa: E402


class _Cfg:
    """execution_config 桩（MacCMS 站点 + 无规则 captchaImage）。"""
    def __init__(self, base='https://example.com'):
        self.plugin_name = 'p'
        self.base_url = base
        self.search_url = base + '/search.php?wd=@keyword'
        self.anti_crawler_config = {}
        self.user_agent = ''


class _Rsp:
    """Session.get 返回值替身（status/content/text/headers/close）。"""
    def __init__(self, status=200, content=b'', text='', redirect=False,
                 location=''):
        self.status_code = status
        self.content = content
        self.text = text
        self.headers = {'Location': location} if redirect else {}
        self.closed = False

    def close(self):
        self.closed = True


def _png():
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new('L', (96, 32), 0).save(buf, format='PNG')
    return buf.getvalue()


class _Jar:
    def __init__(self):
        self.saved = []

    def set_domain_cookies(self, domain, cookies):
        self.saved.append((domain, cookies))


class _Cookie:
    def __init__(self, name, value, domain):
        self.name, self.value, self.domain = name, value, domain


class _PatchedSession:
    """上下文管理器形式的 Session.get/post 桩：按响应序列回放，记录请求 URL。

    序列口径：GET 与 POST 共用同一个回放队列（建会话 GET → 取图 GET →
    提交 POST → 复验 GET）；calls 记录 'GET <url>' / 'POST <url>' 供断言
    提交走 POST、同一会话贯穿全程。"""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __enter__(self):
        cm = mock.patch('kazumi.rule_engine.requests.Session')
        cls = cm.__enter__()
        self._cm = cm
        outer = self

        def _fake(method):
            def handler(url, **kw):
                outer.calls.append(f'{method} {url}')
                idx = min(len(outer.calls) - 1, len(outer.responses) - 1)
                return outer.responses[idx]
            return handler

        # solve_captcha 现统一走 sess.request(method, ...)（代理回退包装），
        # 直接桩 request 本体；calls 记录与 get/post 桩同口径（'GET <url>'）。
        # responses 序列里既可以是 _Rsp 也可以是 BaseException 实例——抛出即
        # 模拟网络层故障（ProxyError 等），不计入回放索引（异常步可重入）。
        def _request_dispatch(method, url, **kw):
            idx = min(len(outer.calls), len(outer.responses) - 1)
            step = outer.responses[idx]
            outer.calls.append(f'{method} {url}')
            if isinstance(step, BaseException):
                raise step
            return step

        cls.return_value.request = _request_dispatch
        cls.return_value.get = _fake('GET')
        cls.return_value.post = _fake('POST')
        return self

    def __exit__(self, *a):
        return self._cm.__exit__(*a)


class TestSolveCaptcha(unittest.TestCase):
    def setUp(self):
        self.jar = _Jar()
        self.engine = RuleEngine(log_failures=False, cookie_jar=self.jar)
        self.engine._xpath_strategy = mock.MagicMock()
        self.engine._xpath_strategy._document_element.side_effect = \
            lambda html: mock.MagicMock()
        self.engine._xpath_strategy._detects_captcha.return_value = False

    def tearDown(self):
        mock.patch.stopall()

    def test_success_first_attempt(self):
        # 步骤：0 建会话(GET) → 1 取图(GET,PNG) → 2 提交(POST,code==1) → 3 复验
        rsp = [_Rsp(200, b'page'), _Rsp(200, _png()),
               _Rsp(200, b'{"code":1,"msg":"success"}',
                    text='{"code":1,"msg":"success"}'), _Rsp(200, b'normal page')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='1234'), \
                mock.patch.object(RuleEngine, '_persist_session_cookies') as m_persist:
            result = self.engine.solve_captcha(_Cfg())
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['code'], '1234')
        self.assertEqual(result['attempts'], 1)
        self.assertEqual(len(sess.calls), 4)
        m_persist.assert_called_once()
        self.assertIn('index.php/verify/index.html', sess.calls[1])
        # 提交必须走 POST（站点 JS 的 MAC.Ajax 'post' 口径；GET 不被接受）
        self.assertTrue(sess.calls[2].startswith('POST '), sess.calls)
        self.assertIn('verify_check', sess.calls[2])

    def test_wrong_answer_never_marks_success(self):
        # 提交响应 code:1002（验证码错误）→ 换图重试 → 3 轮后明确失败。
        # 回归锚点：不能因"复验页不再检出验证码"（频率提示页欺骗）而误报成功。
        png = _Rsp(200, _png())
        rejected = _Rsp(200, '{"code":1002,"msg":"验证码错误"}'.encode('utf-8'))
        rsp = [_Rsp(200, b'page'),
               png, rejected, _Rsp(200, b'freq-tip-page'),
               png, rejected, _Rsp(200, b'freq-tip-page'),
               png, rejected, _Rsp(200, b'freq-tip-page')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='9999'), \
                mock.patch.object(RuleEngine, '_persist_session_cookies') as m_persist:
            result = self.engine.solve_captcha(_Cfg())
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'max_attempts')
        self.assertEqual(result['attempts'], 3)
        m_persist.assert_not_called()  # 失败绝不落盘 Cookie

    def test_recognize_fail_retries_then_gives_up(self):
        # 建会话 + 3 轮取图(PNG)均识别失败 → max_attempts
        png = _Rsp(200, _png())
        rsp = [_Rsp(200, b'page')] + [png] * 3
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value=None):
            result = self.engine.solve_captcha(_Cfg())
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'max_attempts')
        self.assertEqual(result['attempts'], 3)
        self.assertEqual(len(sess.calls), 4)  # 建会话 + 3 次取图（无提交/复验）

    def test_recheck_still_captcha_falls_back_after_retry(self):
        # 第 1 轮提交成功但复验仍检出验证码 → 第 2 轮提交成功且复验通过
        png = _Rsp(200, _png())
        ok = _Rsp(200, b'{"code":1}', text='{"code":1}')
        rsp = [_Rsp(200, b'page'), png, ok, _Rsp(200, b'captcha page'),
               png, ok, _Rsp(200, b'normal page')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='5678') as m_rec, \
                mock.patch.object(self.engine._xpath_strategy, '_detects_captcha',
                                  side_effect=[True, False]), \
                mock.patch.object(RuleEngine, '_persist_session_cookies'):
            result = self.engine.solve_captcha(_Cfg())
        self.assertTrue(result['ok'])
        self.assertEqual(result['attempts'], 2)
        self.assertEqual(m_rec.call_count, 2)

    def test_non_png_image_retries_then_fails(self):
        # 取到 HTML（图端点不可用/拦截页）→ 换图重试后 image_fetch_failed
        html = _Rsp(200, b'<!DOCTYPE html>')
        rsp = [_Rsp(200, b'page')] + [html] * 3
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes') as m_rec:
            result = self.engine.solve_captcha(_Cfg())
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'image_fetch_failed')
        self.assertEqual(result['attempts'], 3)
        m_rec.assert_not_called()  # HTML 不进 OCR

    def test_gif_image_enters_ocr(self):
        # 魔数白名单回归（2026-09-29 修复）：GIF/JPEG/WebP 验证码（MacCMS
        # ThinkPHP verify 常见输出）此前被 PNG-only 门禁烧成 image_fetch_failed，
        # 永不进 OCR。修后 GIF 直接进 OCR，一轮成功。
        import io
        from PIL import Image
        buf = io.BytesIO()
        Image.new('L', (96, 32), 0).save(buf, format='GIF')
        gif = buf.getvalue()
        rsp = [_Rsp(200, b'page'), _Rsp(200, gif),
               _Rsp(200, b'{"code":1}', text='{"code":1}'), _Rsp(200, b'normal')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='4321') as m_rec, \
                mock.patch.object(RuleEngine, '_persist_session_cookies'):
            result = self.engine.solve_captcha(_Cfg())
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['code'], '4321')
        # prefer_llm=False 是未开开关时的显式透传值（2026-10-08 新增参数）
        m_rec.assert_called_once_with(gif, llm_cfg=None, prefer_llm=False)

    def test_looks_like_image_magic_whitelist(self):
        # _looks_like_image 单元口径：四格式白名单 + WebP RIFF 容器 +
        # HTML/空内容拒绝
        self.assertTrue(_looks_like_image(b'\x89PNG\r\n\x1a\n' + b'x' * 16))
        self.assertTrue(_looks_like_image(b'\xff\xd8\xff\xe0' + b'x' * 16))   # JPEG
        self.assertTrue(_looks_like_image(b'GIF87a' + b'x' * 16))             # GIF 87a
        self.assertTrue(_looks_like_image(b'GIF89a' + b'x' * 16))             # GIF 89a
        self.assertTrue(_looks_like_image(b'RIFF\x00\x00\x00\x00WEBPVP8 '))   # WebP
        self.assertFalse(_looks_like_image(b'RIFF\x00\x00\x00\x00WAVE '))     # RIFF 非 WebP
        self.assertFalse(_looks_like_image(b'<!DOCTYPE html>'))               # 拦截页
        self.assertFalse(_looks_like_image(b'<html>'))
        self.assertFalse(_looks_like_image(b''))
        self.assertFalse(_looks_like_image(b'{"code":1}'))                    # JSON 杂讯

    def test_image_fetch_failed_short_circuit_on_404(self):
        rsp = [_Rsp(200, b'page'), _Rsp(404, b'nope')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes') as m_rec:
            result = self.engine.solve_captcha(_Cfg())
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'image_fetch_failed')
        m_rec.assert_not_called()

    def test_cancelled_before_request(self):
        token = mock.MagicMock()
        token.is_set.return_value = True
        with _PatchedSession([]) as sess:
            result = self.engine.solve_captcha(_Cfg(), cancel_token=token)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'cancelled')
        self.assertEqual(sess.calls, [])

    def test_no_base_url_rejected(self):
        result = self.engine.solve_captcha(_Cfg(base=''))
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'no_base_url')

    def test_session_guarded_per_hop(self):
        # 每跳过 _guard_hop（SSRF 守卫口径与 _send_guarded 一致）
        rsp = [_Rsp(200, b'page'), _Rsp(200, _png()), _Rsp(200, b'ok'),
               _Rsp(200, b'normal')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('http_client._guard_hop', wraps=__import__(
                    'http_client')._guard_hop) as m_hop, \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='9090'), \
                mock.patch.object(RuleEngine, '_persist_session_cookies'):
            self.engine.solve_captcha(_Cfg())
        self.assertGreaterEqual(m_hop.call_count, 4)

    def test_proxy_error_falls_back_to_direct(self):
        # C2（2026-10-01）：代理软件退出但系统代理设置残留（127.0.0.1:7897
        # 拒连）时，主搜索链路靠「ProxyError→直连重试」兜底能成功，solve
        # 独立会话同样要回退直连——否则自动解题白丢给人工窗口。
        # 步骤：建会话(带代理→ProxyError→直连成功) → 取图 → 提交 → 复验。
        rsp = [requests.exceptions.ProxyError('refused 127.0.0.1:7897'),
               _Rsp(200, b'page'), _Rsp(200, _png()),
               _Rsp(200, b'{"code":1}', text='{"code":1}'), _Rsp(200, b'normal')]
        with _PatchedSession(rsp) as sess, \
                mock.patch('http_client.system_proxies',
                           return_value={'https': 'http://127.0.0.1:7897'}), \
                mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                           return_value='3456'), \
                mock.patch.object(RuleEngine, '_persist_session_cookies') as m_persist:
            result = self.engine.solve_captcha(_Cfg())
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['code'], '3456')
        m_persist.assert_called_once()

    def test_proxy_error_without_proxy_config_propagates(self):
        # 未配置代理时 ProxyError（非代理链路故障）原样上抛 → session_init_failed，
        # 不做无意义的直连重试（直连本来就是无代理，重试等于双倍烧超时）。
        with _PatchedSession([requests.exceptions.ProxyError('refused')]), \
                mock.patch('http_client.system_proxies', return_value={}):
            result = self.engine.solve_captcha(_Cfg())
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'session_init_failed')

    def test_maccms_endpoints_used(self):
        self.test_success_first_attempt()  # 端点断言已并入 success 用例


class TestSearchPathContractIntact(unittest.TestCase):
    """solve_captcha 是独立动作：搜索主路径的零网络请求契约必须原样保持。"""

    def test_search_with_captcha_retry_still_zero_fetch(self):
        engine = RuleEngine(log_failures=False)
        cfg = _Cfg()
        with mock.patch.object(engine, 'search', side_effect=CaptchaRequiredException('p')), \
                mock.patch('http_client.get'), \
                mock.patch.object(RuleEngine, '_send_guarded') as m_guard, \
                mock.patch('kazumi.rule_engine.requests.Session') as m_sess:
            payload = engine.search_with_captcha_retry(cfg, 'k')
        m_guard.assert_not_called()
        m_sess.assert_not_called()  # 主路径也不建独立会话
        self.assertTrue(payload['captcha_required'])
        self.assertIsInstance(payload['ocr_available'], bool)


class TestThrottleSite(unittest.TestCase):
    """_throttle_site 节流语义：min_gap 拉齐 + 并发原子性（2026-09-29 修复）。

    旧实现 get→sleep→set 非原子：并发搜索同域时双双通过间隔检查，共享节流
    形同虚设。修后「读 last / 算 wait / 预占名额」持 _THROTTLE_LOCK 原子完成，
    sleep 放锁外。"""

    def setUp(self):
        self._snapshot = dict(rule_engine_mod._SITE_LAST_REQUEST)
        rule_engine_mod._SITE_LAST_REQUEST.clear()

    def tearDown(self):
        rule_engine_mod._SITE_LAST_REQUEST.clear()
        rule_engine_mod._SITE_LAST_REQUEST.update(self._snapshot)

    def test_second_call_waits_until_min_gap(self):
        engine = RuleEngine(log_failures=False)
        url = 'https://throttle.example.com/search'
        t0 = time.monotonic()
        engine._throttle_site(url, min_gap=0.4)
        first_gap = time.monotonic() - t0
        self.assertLess(first_gap, 0.3, '首次调用不应等待')
        engine._throttle_site(url, min_gap=0.4)
        total = time.monotonic() - t0
        # 第二次调用被拉齐到 min_gap（±0.1s 容差口径）
        self.assertGreaterEqual(total, 0.35)
        self.assertLess(total, 1.0)

    def test_concurrent_calls_serialized_per_domain(self):
        # 并发同域：锁内原子预占名额，总耗时 ≥ 2×min_gap（两次调用被串行拉开）
        engine = RuleEngine(log_failures=False)
        url = 'https://concurrent.example.com/search'
        min_gap = 0.4
        barrier = threading.Barrier(2)
        results = {}

        def worker():
            barrier.wait()  # 同步起跑，最大化竞态窗口
            t = time.monotonic()
            engine._throttle_site(url, min_gap=min_gap)
            results[threading.get_ident()] = time.monotonic() - t

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(len(results), 2)
        # 正确口径：先到者立即通过，后到者被预占名额推到 min_gap 之外
        # （一个 ≈0、一个 ≈min_gap）。旧竞态代码下两者都 ≈0（双双通过间隔
        # 检查），故以 max 等待达到 min_gap 量级为串行化成立的判据。
        max_wait = max(results.values())
        self.assertGreaterEqual(max_wait, min_gap * 0.8,
                                f'并发调用未被节流串行化: {results}')

    def test_different_domains_do_not_block_each_other(self):
        engine = RuleEngine(log_failures=False)
        engine._throttle_site('https://a.example.com/s', min_gap=1.5)
        t = time.monotonic()
        engine._throttle_site('https://b.example.com/s', min_gap=1.5)
        self.assertLess(time.monotonic() - t, 0.3, '他域不应被本域节流拖慢')


class TestNoResultRetry(unittest.TestCase):
    """search_with_captcha_retry 的 NoResult 短重试契约（2026-09-29 修复锁定）。

    背景：solve 成功后前端立即重搜会撞「搜索间隔 3 秒」提示页（无结果节点
    → NoResultException），对 TTL 内刚解题的域做一次隔 4s 的重试。修复点：
    重试若再抛 CaptchaRequiredException，必须返回结构化 payload 而非让异常
    逃逸（server.py 只消费 dict）。"""

    def setUp(self):
        rule_engine_mod._RECENT_SOLVED.clear()

    def tearDown(self):
        mock.patch.stopall()
        rule_engine_mod._RECENT_SOLVED.clear()

    def _make_engine(self):
        # 同既有桩风格：cookie_jar 桩 has_cookies()=True，_recently_solved
        # 命中走 _RECENT_SOLVED 直写（TTL 语义由 solve 成功路径负责）
        class _HasCookiesJar:
            def has_cookies(self):
                return True

        engine = RuleEngine(log_failures=False, cookie_jar=_HasCookiesJar())
        return engine

    def _mark_recently_solved(self, cfg):
        import time as time_mod
        from urllib.parse import urlparse
        key = (urlparse(cfg.base_url).hostname or '').lower()
        rule_engine_mod._RECENT_SOLVED[key] = time_mod.monotonic()

    def test_retry_succeeds_once_within_ttl(self):
        # TTL 内（_recently_solved 命中 + cookie_jar 有 cookie）→ 重试一次成功
        engine = self._make_engine()
        cfg = _Cfg(base='https://retry-ok.example.com')
        self._mark_recently_solved(cfg)
        search = mock.Mock(side_effect=[NoResultException('p'), 'TRACE'])
        with mock.patch.object(engine, 'search', search), \
                mock.patch.object(RuleEngine, '_throttle_site') as m_throttle:
            result = engine.search_with_captcha_retry(cfg, 'kw')
        self.assertEqual(result, 'TRACE')
        self.assertEqual(search.call_count, 2)  # 首发 + 重试
        m_throttle.assert_called_once()         # 重试前过节流（min_gap=4.0）
        self.assertEqual(m_throttle.call_args.kwargs.get('min_gap'), 4.0)

    def test_retry_captcha_returns_payload_not_exception(self):
        # 重试再撞验证码 → 结构化 payload（锁定问题 3：异常不得逃逸）
        engine = self._make_engine()
        cfg = _Cfg(base='https://retry-captcha.example.com')
        self._mark_recently_solved(cfg)
        search = mock.Mock(side_effect=[NoResultException('p'),
                                        CaptchaRequiredException('p')])
        with mock.patch.object(engine, 'search', search):
            result = engine.search_with_captcha_retry(cfg, 'kw')
        self.assertIsInstance(result, dict, '重试再撞验证码必须返回 dict')
        self.assertTrue(result['captcha_required'])
        self.assertEqual(result['plugin_name'], 'p')
        self.assertIn('captcha_url', result)
        self.assertIsInstance(result['ocr_available'], bool)

    def test_no_jar_or_not_recent_raises(self):
        # 未验证过的源不重试（真无结果不被拖慢）：NoResultException 原样上抛
        engine = RuleEngine(log_failures=False, cookie_jar=None)
        cfg = _Cfg()
        search = mock.Mock(side_effect=NoResultException('p'))
        with mock.patch.object(engine, 'search', search):
            with self.assertRaises(NoResultException):
                engine.search_with_captcha_retry(cfg, 'kw')
        self.assertEqual(search.call_count, 1)  # 无重试


class TestDispatchCaptchaSolveEnvelope(unittest.TestCase):
    """dispatcher 端点响应结构锁（2026-09-29 修复）。

    solve_captcha 成功结果 {'ok': True, 'code': '1234', 'attempts': 1} 里的
    code 是 OCR 识别出的验证码答案（字符串）。旧实现 {'code': 200, **result}
    平铺展开会让验证码答案覆盖信封的 code==200 成功标记，违反本 dispatcher
    「code==200 表示成功」契约。修后 result 整体嵌套在 'result' 键下，
    渲染端（kazumi.js / search.js）读 rsp.result.ok / rsp.result.reason。"""

    def _dispatch(self, solve_result):
        import json as json_mod
        import server as server_mod

        class _Plugin:
            def execution_config(self):
                return _Cfg()

        mgr = mock.MagicMock()
        mgr.get.return_value = _Plugin()
        engine = mock.MagicMock()
        engine.solve_captcha.return_value = solve_result
        with mock.patch.object(server_mod, 'kazumi_mgr', mgr), \
                mock.patch.object(server_mod, 'kazumi_engine', engine):
            status, body = server_mod.dispatch_kazumi_action(
                {'do': 'kazumiCaptchaSolve', 'plugin': 'p'})
        self.assertEqual(status, 200)
        data = json_mod.loads(body)
        return data

    def test_success_code_not_shadowed_by_answer(self):
        data = self._dispatch({'ok': True, 'code': '1234', 'attempts': 1})
        self.assertEqual(data['code'], 200, '信封 code==200 不得被验证码答案覆盖')
        self.assertEqual(data['result'], {'ok': True, 'code': '1234', 'attempts': 1})
        self.assertEqual(data['result']['code'], '1234')
        self.assertTrue(data['result']['ok'])

    def test_failure_nested_result_passthrough(self):
        data = self._dispatch({'ok': False, 'reason': 'max_attempts', 'attempts': 3})
        self.assertEqual(data['code'], 200)
        self.assertFalse(data['result']['ok'])
        self.assertEqual(data['result']['reason'], 'max_attempts')


class TestPersistSessionCookies(unittest.TestCase):
    def test_persists_matching_domain(self):
        jar = _Jar()
        engine = RuleEngine(log_failures=False, cookie_jar=jar)

        class _Sess:
            cookies = [_Cookie('PHPSESSID', 'abc', '.example.com')]

        engine._persist_session_cookies('https://example.com/x', _Sess())
        self.assertEqual(len(jar.saved), 1)
        domain, cookies = jar.saved[0]
        self.assertEqual(domain, 'example.com')
        self.assertEqual(cookies[0]['name'], 'PHPSESSID')

    def test_no_jar_is_noop(self):
        engine = RuleEngine(log_failures=False)
        engine._persist_session_cookies('https://example.com')  # 不抛异常即可


class TestPreferLlmOrdering(unittest.TestCase):
    """「优先使用 LLM」开关：识别链两级次序（2026-10-08）。

    背景（实测）：tiny-CNN 在真实站点样本上永远返回 4 位数字（500 张实测
    返回 None 0 次），而 4 位数字恒能通过 is_plausible_captcha_text 的格式
    闸门，故默认次序下 LLM 这一级几乎永不上场——同批样本 all4 仅 0.37，即
    多数错读被直接提交。开关把次序倒过来，让要识别率的用户绕开小模型。

    契约：prefer_llm=True 时先 LLM；LLM 不可用/结果不可信时仍回落小模型
    （不是「跳过小模型」），最后才 None（人工窗口）。
    """

    def setUp(self):
        from kazumi import captcha as captcha_mod
        self.mod = captcha_mod
        # 本类整体替换 _load_cnn / _recognize_with_llm / _cnn_holder，必须整体
        # 还原：这些是模块级缓存与函数引用，泄漏会污染后续用例（实测曾把
        # TestSolveCaptcha 的识别桩换成假 CNN，致 HTML 解析路径报错）。
        self._saved = (captcha_mod._load_cnn, captcha_mod._recognize_with_llm,
                       dict(captcha_mod._cnn_holder))

    def tearDown(self):
        load_cnn, rec_llm, holder = self._saved
        self.mod._load_cnn = load_cnn
        self.mod._recognize_with_llm = rec_llm
        self.mod._cnn_holder.update(holder)
        self.mod.reset_ocr_cache()

    def _run(self, prefer, llm_result, cnn_result='1111'):
        """按给定两级返回值跑一次识别，返回 (结果, 调用次序)。"""
        order = []
        self.mod._recognize_with_llm = lambda b, c: (order.append('llm'), llm_result)[1]
        cnn = mock.MagicMock()
        cnn.recognize.side_effect = lambda b: (order.append('cnn'), cnn_result)[1]
        self.mod._load_cnn = lambda: cnn
        self.mod._cnn_holder['ok'] = True
        self.mod._cnn_holder['tried'] = True
        out = self.mod.recognize_captcha_bytes(b'\x89PNG-fake', llm_cfg={'base': 'x', 'model': 'm'},
                                               prefer_llm=prefer)
        return out, order

    def test_default_order_is_cnn_first(self):
        out, order = self._run(False, '2222')
        self.assertEqual(out, '1111')
        self.assertEqual(order, ['cnn'], '默认只调小模型即返回，不碰 LLM')

    def test_prefer_llm_calls_llm_first(self):
        out, order = self._run(True, '2222')
        self.assertEqual(out, '2222')
        self.assertEqual(order, ['llm'], '开关开启时 LLM 先跑且直接采用其结果')

    def test_prefer_llm_falls_back_to_cnn(self):
        """LLM 返回 None（未配置/失败/不可信）→ 回落小模型，不是直接失败。"""
        out, order = self._run(True, None)
        self.assertEqual(out, '1111')
        self.assertEqual(order, ['llm', 'cnn'])

    def test_prefer_llm_without_config_still_uses_cnn(self):
        """开关开了但没配 LLM：识别链该级跳过，回到小模型——不能变成无解。"""
        order = []
        self.mod._recognize_with_llm = lambda b, c: (order.append('llm'), None)[1]
        cnn = mock.MagicMock()
        cnn.recognize.side_effect = lambda b: (order.append('cnn'), '4321')[1]
        self.mod._load_cnn = lambda: cnn
        self.mod._cnn_holder['ok'] = True
        self.mod._cnn_holder['tried'] = True
        out = self.mod.recognize_captcha_bytes(b'\x89PNG-fake', llm_cfg=None, prefer_llm=True)
        self.assertEqual(out, '4321')
        self.assertEqual(order, ['llm', 'cnn'])

    def test_both_unavailable_returns_none(self):
        """两级都不可用 → None（调用方回落人工窗口）。"""
        out, order = self._run(True, None, cnn_result=None)
        self.assertIsNone(out)
        self.assertEqual(order, ['llm', 'cnn'])

    def test_solve_passes_prefer_llm_through(self):
        """solve_captcha 必须把开关透传到识别调用（否则前端开关形同虚设）。"""
        engine = RuleEngine(log_failures=False)
        # 复验步要走 xpath 检测：与 TestSolveCaptcha.setUp 同口径桩掉，
        # 否则 'normal' 这种非 HTML 正文会让 _document_element 抛解析异常。
        engine._xpath_strategy = mock.MagicMock()
        engine._xpath_strategy._document_element.side_effect = lambda html: mock.MagicMock()
        engine._xpath_strategy._detects_captcha.return_value = False
        rec = mock.patch('kazumi.rule_engine._captcha_mod.recognize_captcha_bytes',
                         return_value='1234')
        png = _Rsp(200, _png())
        rsp = [_Rsp(200, b'page'), png,
               _Rsp(200, b'{"code":1}', text='{"code":1}'), _Rsp(200, b'normal')]
        with _PatchedSession(rsp), rec as m_rec, \
                mock.patch.object(RuleEngine, '_persist_session_cookies'):
            engine.solve_captcha(_Cfg(), prefer_llm=True)
        self.assertEqual(m_rec.call_args.kwargs.get('prefer_llm'), True)

    def test_server_flag_parsed_from_form(self):
        """端点解析：只有显式真值才算开，缺键/0/false 一律关（默认关闭）。"""
        import server as server_mod
        for val, expected in (('1', True), ('true', True), ('yes', True), ('on', True),
                              ('0', False), ('false', False), ('', False), (None, False)):
            form = {} if val is None else {'captchaLLMPrefer': val}
            self.assertEqual(server_mod._captcha_prefer_llm(form), expected, f'val={val!r}')

    def test_solve_endpoint_forwards_prefer_flag(self):
        """kazumiCaptchaSolve 端点把开关传给 engine.solve_captcha。"""
        import json as json_mod
        import server as server_mod

        class _Plugin:
            def execution_config(self):
                return _Cfg()

        mgr = mock.MagicMock()
        mgr.get.return_value = _Plugin()
        engine = mock.MagicMock()
        engine.solve_captcha.return_value = {'ok': True, 'code': '1234', 'attempts': 1}
        with mock.patch.object(server_mod, 'kazumi_mgr', mgr), \
                mock.patch.object(server_mod, 'kazumi_engine', engine):
            status, body = server_mod.dispatch_kazumi_action(
                {'do': 'kazumiCaptchaSolve', 'plugin': 'p', 'captchaLLMPrefer': '1'})
        self.assertEqual(status, 200)
        self.assertEqual(engine.solve_captcha.call_args.kwargs.get('prefer_llm'), True)
        json_mod.loads(body)


if __name__ == '__main__':
    unittest.main()
