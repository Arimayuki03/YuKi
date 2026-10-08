# -*- coding: utf-8 -*-
"""Bangumi 评分/吐槽（rate/comment）与验证码自动识别测试。

评分/吐槽：POST /v0/users/-/collections/{subject_id} 的 body 扩展 rate（0-10，
0=清除评分）与 comment（吐槽文本），对齐官方 OpenAPI UserSubjectCollectionModifyPayload
（所有字段均可选）。YuKi 无独立评分端点（server.py 不新增 do），复用
kazumiBangumiSyncApply 的单条透传：apply_sync_plan 条目 {subjectId, type, rate, comment}。

验证码：utils 启发式分类（animeko WebCaptchaDetector 思路）+ captcha.py 可选 OCR
（ddddocr 缺席降级手动，animeko ImageCaptchaSolver→InteractiveSolveDialog 对应）。
验证码 payload 契约：只含纯计算字段（captcha_url / captcha_url_classified /
ocr_available），零额外网络请求；captcha_image_url 已移出 payload（规则派生页
抓取走 _send_guarded 守卫，消费方出现前不在主路径自动抓取）。

mock HTTP 写法对齐 test_kazumi.py TestBangumiSync（mock.patch requests.request /
_bangumi_username）。
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kazumi.plugin_manager import (  # noqa: E402
    PluginManager,
    normalize_bgm_rate,
    normalize_bgm_comment,
    normalize_bgm_tags,
    BGM_RATE_MAX,
    BGM_TAGS_MAX,
    BGM_TAG_MAX_LEN,
)
from kazumi.utils import (  # noqa: E402
    BgmFieldError,
    looks_like_image_captcha_url,
    detect_image_captcha_html,
)
from kazumi import captcha as captcha_mod  # noqa: E402
from kazumi import captcha_cnn as captcha_cnn_mod  # noqa: E402
from kazumi.rule_engine import RuleEngine  # noqa: E402
from kazumi.plugin import Plugin  # noqa: E402
from kazumi.utils import CaptchaRequiredException  # noqa: E402


class _Rsp:
    """requests 响应桩：status_code 可调，json/raise_for_status 按需。"""
    def __init__(self, code=200, payload=None):
        self.status_code = code
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _patched(mgr, rsp):
    """标准 mock 组合：username=alice + requests.request 返回 2xx。"""
    return (mock.patch.object(mgr, '_bangumi_username', return_value='alice'),
            mock.patch('requests.request', return_value=rsp))


class TestNormalizeRate(unittest.TestCase):
    """评分归一化：边界与非法值。"""

    def test_valid_scores(self):
        for v, want in ((1, 1), (5, 5), (10, 10), ('7', 7), (0, 0)):
            self.assertEqual(normalize_bgm_rate(v), want, v)

    def test_empty_means_no_change(self):
        self.assertIsNone(normalize_bgm_rate(None))
        self.assertIsNone(normalize_bgm_rate(''))

    def test_out_of_range_rejected(self):
        with self.assertRaises(BgmFieldError):
            normalize_bgm_rate(11)
        with self.assertRaises(BgmFieldError):
            normalize_bgm_rate(-1)
        self.assertEqual(BGM_RATE_MAX, 10)

    def test_non_numeric_rejected(self):
        with self.assertRaises(BgmFieldError):
            normalize_bgm_rate('abc')
        with self.assertRaises(BgmFieldError):
            normalize_bgm_rate([])


class TestNormalizeComment(unittest.TestCase):
    """吐槽归一化：空白/截断。"""

    def test_none_untouched(self):
        self.assertIsNone(normalize_bgm_comment(None))

    def test_strip_and_empty_to_none(self):
        self.assertEqual(normalize_bgm_comment('  神作  '), '神作')
        self.assertIsNone(normalize_bgm_comment('   '))

    def test_oversize_truncated(self):
        long = '好' * 20000
        self.assertEqual(len(normalize_bgm_comment(long)), 10000)


class TestNormalizeTags(unittest.TestCase):
    """个人标签归一化（对齐 Kazumi rating_review_dialog：≤10 个、单个 ≤10 字）。"""

    def test_none_and_empty_untouched(self):
        self.assertIsNone(normalize_bgm_tags(None))
        self.assertIsNone(normalize_bgm_tags(''))

    def test_strip_dedupe_keep_order(self):
        self.assertEqual(normalize_bgm_tags(['神作', ' 神作 ', '', 'TV', 'tv']), ['神作', 'TV', 'tv'])

    def test_string_becomes_single_item(self):
        # 整串标签（含逗号）不拆分：标签允许含逗号，拆分会改写用户语义
        self.assertEqual(normalize_bgm_tags('科幻,太空'), ['科幻,太空'])

    def test_empty_items_dropped(self):
        self.assertEqual(normalize_bgm_tags(['', '  ', None]), [])
        # 全空项 → 空列表（不是 None：调用方以 None 判「不修改」）
        self.assertEqual(normalize_bgm_tags(['', '  ']), [])

    def test_oversize_tag_rejected(self):
        with self.assertRaises(BgmFieldError) as cm:
            normalize_bgm_tags(['x' * (BGM_TAG_MAX_LEN + 1)])
        self.assertEqual(cm.exception.field, 'tags')
        self.assertEqual(BGM_TAG_MAX_LEN, 10)

    def test_too_many_rejected(self):
        with self.assertRaises(BgmFieldError) as cm:
            normalize_bgm_tags([f't{i}' for i in range(BGM_TAGS_MAX + 1)])
        self.assertEqual(cm.exception.field, 'tags')
        self.assertEqual(BGM_TAGS_MAX, 10)
        # 恰 10 个合法
        self.assertEqual(len(normalize_bgm_tags([f't{i}' for i in range(10)])), 10)

    def test_non_iterable_rejected(self):
        with self.assertRaises(BgmFieldError):
            normalize_bgm_tags(42)


class TestUpdateCollectionRateComment(unittest.TestCase):
    """bangumi_update_collection 的 rate/comment 扩展。"""

    def setUp(self):
        self.mgr = PluginManager()

    def test_body_with_type_rate_comment(self):
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', 2, rate=9, comment='神作')
        self.assertTrue(ok)
        # 首个尝试为 POST + `-` 通配用户；body 三字段齐备
        self.assertEqual(m.call_args[1]['json'], {'type': 2, 'rate': 9, 'comment': '神作'})

    def test_body_rate_only_no_type(self):
        # type<0 语义：不发 type，纯评分 PATCH（不动收藏状态）
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', -1, rate=7)
        self.assertTrue(ok)
        body = m.call_args[1]['json']
        self.assertEqual(body, {'rate': 7})

    def test_body_zero_type_omits_type(self):
        # type=0 不是合法收藏类型（官方 SubjectCollectionType 枚举仅 1-5，发 0 会被
        # Validation Error 拒收）：与 _bangumi_set_one 口径一致，body 省略 type 键
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', 0, rate=7)
        self.assertTrue(ok)
        body = m.call_args[1]['json']
        self.assertEqual(body, {'rate': 7})
        self.assertNotIn('type', body)

    def test_body_comment_only(self):
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', -1, comment='期待第二季')
        self.assertTrue(ok)
        self.assertEqual(m.call_args[1]['json'], {'comment': '期待第二季'})

    def test_no_extra_fields_backcompat(self):
        # 不传 rate/comment：body 与旧版完全一致（收藏同步路径不受影响）
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', 3)
        self.assertTrue(ok)
        self.assertEqual(m.call_args[1]['json'], {'type': 3})

    def test_invalid_rate_fails_fast_no_request(self):
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, msg = self.mgr.bangumi_update_collection('tok', '42', -1, rate=99)
        self.assertFalse(ok)
        self.assertIn('0-10', msg)
        m.assert_not_called()  # 非法入参不发任何网络请求

    def test_clear_rating_zero(self):
        # rate=0 = 清除评分（官方语义），必须能进 body
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', -1, rate=0)
        self.assertTrue(ok)
        self.assertEqual(m.call_args[1]['json'], {'rate': 0})

    def test_body_with_tags(self):
        # tags（T82 个人标签）随 body 提交；归一化后保序去重
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', -1,
                                                       tags=['神作', ' 神作 ', 'TV'])
        self.assertTrue(ok)
        self.assertEqual(m.call_args[1]['json'], {'tags': ['神作', 'TV']})

    def test_empty_tags_list_submitted(self):
        # 空标签数组 = 清除全部个人标签（语义区别于 None=不修改），必须能进 body
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', -1, tags=[])
        self.assertTrue(ok)
        self.assertEqual(m.call_args[1]['json'], {'tags': []})

    def test_invalid_tag_fails_fast_no_request(self):
        p1, p2 = _patched(self.mgr, _Rsp(200))
        with p1, p2 as m:
            ok, msg = self.mgr.bangumi_update_collection('tok', '42', -1, tags=['x' * 11])
        self.assertFalse(ok)
        self.assertIn('10 字', msg)
        m.assert_not_called()  # 非法入参不发任何网络请求


class TestApplySyncPlanRating(unittest.TestCase):
    """kazumiBangumiSyncApply 单条透传（评分/吐槽 UI 的后端通道）。"""

    def setUp(self):
        self.mgr = PluginManager()

    def _run(self, uploads, rsp=None):
        p1, p2 = _patched(self.mgr, rsp or _Rsp(200))
        with p1, p2 as m:
            result = self.mgr.bangumi_apply_sync_plan('tok', uploads, op_delay=0)
        return result, m

    def test_single_rating_entry(self):
        # 评分 UI 路径：type=-1（不动收藏类型）+ rate + comment 单条透传。
        # 官方 OpenAPI SubjectCollectionType 枚举仅 1-5：body 必须省略 type 键
        # （发 -1/0 会被 Validation Error 拒收，HTTP 400）
        result, m = self._run([{'subjectId': '42', 'type': -1, 'rate': 8, 'comment': '好看'}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(result['failed'], 0)
        body = m.call_args[1]['json']
        self.assertEqual(body, {'rate': 8, 'comment': '好看'})
        self.assertNotIn('type', body)

    def test_single_rating_zero_type_omits_type(self):
        # type=0 与 -1 同义（不修改收藏类型），同样不发 type
        result, m = self._run([{'subjectId': '42', 'type': 0, 'rate': 5}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'rate': 5})

    def test_single_type_valid_sends_type(self):
        # 对偶用例：合法收藏类型（1-5）正常透传 type
        result, m = self._run([{'subjectId': '42', 'type': 2, 'rate': 8}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'type': 2, 'rate': 8})

    def test_invalid_rate_counts_failed(self):
        result, m = self._run([{'subjectId': '42', 'type': -1, 'rate': 50}])
        self.assertEqual(result['failed'], 1)
        self.assertIn('0-10', result['results'][0]['msg'])
        m.assert_not_called()

    def test_invalid_comment_counts_failed(self):
        # comment 非 None 时恒转字符串（不会抛），非法 rate 才是 400 语义入口；
        # 此处验证 BgmFieldError 路径在并发 apply 中被归一为单条失败
        result, _ = self._run([{'subjectId': '42', 'type': -1, 'rate': 'x'}])
        self.assertEqual(result['failed'], 1)

    def test_plain_type_upload_backcompat(self):
        # 旧收藏同步条目（无 rate/comment）行为不变
        result, m = self._run([{'subjectId': '42', 'type': 2}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'type': 2})

    def test_single_tags_entry(self):
        # 标签 UI 路径：type=-1 + tags 单条透传（评分/吐槽 UI 走同一通道）
        result, m = self._run([{'subjectId': '42', 'type': -1, 'tags': ['神作', 'TV']}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'tags': ['神作', 'TV']})
        self.assertNotIn('type', m.call_args[1]['json'])

    def test_empty_tags_clears(self):
        # 空数组 = 清除全部标签：has_extra 判定必须把 tags=[] 视为有效改动
        result, m = self._run([{'subjectId': '42', 'type': -1, 'tags': []}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'tags': []})

    def test_invalid_tag_counts_failed(self):
        result, m = self._run([{'subjectId': '42', 'type': -1, 'tags': [f't{i}' for i in range(11)]}])
        self.assertEqual(result['failed'], 1)
        self.assertIn('最多 10 个', result['results'][0]['msg'])
        m.assert_not_called()

    def test_rate_comment_tags_combined(self):
        # 三字段合并：评分 + 吐槽 + 标签一次提交
        result, m = self._run([{'subjectId': '42', 'type': -1, 'rate': 9,
                                'comment': '神作', 'tags': ['神作']}])
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(m.call_args[1]['json'], {'rate': 9, 'comment': '神作', 'tags': ['神作']})

    def test_missing_token(self):
        # 缺 token：uploads 非空时带 error 说明且无成功上传（对齐既有契约）
        result = self.mgr.bangumi_apply_sync_plan('', [{'subjectId': '42', 'type': 1}])
        self.assertEqual(result.get('error'), '缺少 Bangumi token')
        self.assertFalse(result.get('uploaded'))


# ---------------------------------------------------------------- 验证码


class TestCaptchaHeuristics(unittest.TestCase):
    """utils 启发式分类器（animeko WebCaptchaDetector 思路：宁可漏报不误报）。"""

    def test_url_positive(self):
        for u in (
            'https://example.com/captcha.php',
            'https://example.com/include/imageVerify.php',
            'https://example.com/checkcode.aspx',
            'https://example.com/api/vcode?ts=1',
        ):
            self.assertTrue(looks_like_image_captcha_url(u), u)

    def test_url_negative(self):
        for u in (
            '', 'https://example.com/search?wd=关键词',
            'https://example.com/videocodec-info',
            'ftp://example.com/captcha.png',   # 非 http(s)
        ):
            self.assertFalse(looks_like_image_captcha_url(u), u)

    def test_html_positive(self):
        html = ('<form><img src="/captcha.php?ts=1" alt="验证码"/>'
                '<input name="code" maxlength="4"/></form>')
        self.assertTrue(detect_image_captcha_html(html))

    def test_html_negative_without_short_input(self):
        html = '<img src="/captcha.php"/><input name="code"/>'
        self.assertFalse(detect_image_captcha_html(html))

    def test_html_negative_without_captcha_url(self):
        html = '<input name="code" maxlength="4"/>'
        self.assertFalse(detect_image_captcha_html(html))


class TestCaptchaOcr(unittest.TestCase):
    """captcha.py 自动识别（可选依赖、失败降级、结果合法性门槛）。"""

    def setUp(self):
        captcha_mod.reset_ocr_cache()

    def tearDown(self):
        captcha_mod.reset_ocr_cache()

    def test_plausible_text(self):
        self.assertTrue(captcha_mod.is_plausible_captcha_text('a7X2'))
        self.assertTrue(captcha_mod.is_plausible_captcha_text(' 验证码 '))
        self.assertFalse(captcha_mod.is_plausible_captcha_text(''))
        self.assertFalse(captcha_mod.is_plausible_captcha_text('ab'))       # 过短
        self.assertFalse(captcha_mod.is_plausible_captcha_text('a' * 20))   # 过长

    def test_recognize_degrades_without_ocr(self):
        # ddddocr 不可用（默认 venv 未装）：识别返回 None，不抛异常
        if captcha_mod.ocr_available():
            self.skipTest('venv 已安装 ddddocr，跳过降级路径')
        self.assertIsNone(captcha_mod.recognize_captcha_bytes(b'fake-png-bytes'))
        self.assertIsNone(captcha_mod.recognize_captcha_bytes(None))

    def test_recognize_uses_cnn_when_available(self):
        # mock 识别器：验证「合法结果透传 / 噪声结果拒绝」两分支。
        # 现行一级是自研 tiny-CNN（ddddocr 已按体积决策移除）。
        class FakeCnn:
            def __init__(self, text):
                self.text = text

            def recognize(self, data):
                return self.text

        fake = FakeCnn('w2x9')
        captcha_mod._cnn_holder.update({'ok': True, 'tried': True})
        with mock.patch.object(captcha_mod, '_load_cnn', return_value=fake):
            self.assertEqual(captcha_mod.recognize_captcha_bytes(b'img'), 'w2x9')
        fake.text = 'x' * 30  # 过长噪声 → 拒绝 → 回落二级（未配置）→ None
        with mock.patch.object(captcha_mod, '_load_cnn', return_value=fake):
            self.assertIsNone(captcha_mod.recognize_captcha_bytes(b'img'))
        with mock.patch.object(captcha_mod, '_load_cnn', return_value=fake):
            # recognize 抛异常 → 吞掉并回落二级（也未配置）→ 最终 None
            def boom(_data):
                raise RuntimeError('model broken')
            fake.recognize = boom
            self.assertIsNone(captcha_mod.recognize_captcha_bytes(b'img'))

    def test_recognize_falls_back_to_llm(self):
        # 一级不可用 → 视觉 LLM 兜底链生效（需配置齐全，缺失时二级直接返回 None）
        captcha_mod._cnn_holder.update({'ok': False, 'tried': True})
        with mock.patch.object(captcha_mod, '_recognize_with_llm',
                               return_value='4486') as m_llm:
            self.assertEqual(
                captcha_mod.recognize_captcha_bytes(
                    b'img', llm_cfg={'base': 'https://x/v1', 'model': 'm'}), '4486')
        self.assertEqual(m_llm.call_count, 1)


class TestCaptchaLazyLoadRace(unittest.TestCase):
    """懒加载双检锁：并发探测下识别器构造函数只执行一次。

    无锁时多线并发会在「检查-构造-写回」窗口内重复构造（懒加载是 3MB 权重
    np.load，重复构造等于重复付成本）；先置 tried 后构造更糟——其他线程拿到
    假 None 静默降级。契约：构造串行化、tried 仅在构造结束后置位。
    现行一级是 tiny-CNN（captcha._load_cnn → captcha_cnn.model_available），
    ddddocr 已按体积决策移除，故直接桩 _load_cnn 即可锁定探测路径。"""

    def test_concurrent_ocr_available_constructs_once(self):
        import threading

        captcha_mod.reset_ocr_cache()
        construct_calls = []
        gate = threading.Event()

        def fake_load_cnn():
            # 构造慢速段：让所有线程都挤进检查窗口，放大竞态
            construct_calls.append(True)
            gate.wait(timeout=5)
            return mock.MagicMock(model_available=lambda: True)

        with mock.patch.object(captcha_mod, '_load_cnn', side_effect=fake_load_cnn):
            barrier = threading.Barrier(8)
            results = []

            def probe():
                barrier.wait(timeout=5)
                results.append(captcha_mod.ocr_available())

            threads = [threading.Thread(target=probe) for _ in range(8)]
            for t in threads:
                t.start()
            # 构造已被恰一个线程进入后放行 gate
            deadline = 50
            while len(construct_calls) < 1 and deadline > 0:  # 等首个构造进入
                threading.Event().wait(0.01)
                deadline -= 1
            gate.set()
            for t in threads:
                t.join(timeout=10)
        for t in threads:
            self.assertFalse(t.is_alive())
        self.assertEqual(len(construct_calls), 1, '识别器构造函数必须只被调用一次')
        self.assertEqual(results, [True] * 8)

    def tearDown(self):
        captcha_mod.reset_ocr_cache()


class _Cfg:
    """execution_config 桩（规则反爬配置 + searchURL 模板）。"""
    def __init__(self, search_url='https://example.com/search?wd=@keyword', anti=None):
        self.search_url = search_url
        self.base_url = 'https://example.com'
        self.anti_crawler_config = anti or {}


class TestCaptchaPayloadEnrich(unittest.TestCase):
    """search_with_captcha_retry 的 payload 契约。

    契约要点：payload 只含纯计算字段（零额外网络请求——结果经 SSE 逐源推送，
    验证码兜底不允许拖慢主链路）；captcha_image_url 不在其中（规则派生页抓取
    属 SSRF 守卫面，消费方出现前不做主路径自动抓取）。"""

    def setUp(self):
        self.engine = RuleEngine(log_failures=False)

    def _run(self, cfg):
        with mock.patch.object(self.engine, 'search', side_effect=CaptchaRequiredException('p')):
            return self.engine.search_with_captcha_retry(cfg, 'test')

    def test_payload_fields(self):
        payload = self._run(_Cfg(search_url='https://example.com/captcha.php?next=@keyword'))
        self.assertTrue(payload['captcha_required'])
        self.assertEqual(payload['plugin_name'], 'p')
        self.assertEqual(payload['captcha_url'], 'https://example.com/captcha.php?next=test')
        # URL 命中 captcha 特征 → 分类为图片验证码
        self.assertTrue(payload['captcha_url_classified'])
        # ocr_available 为布尔（ddddocr 装了是 True，没装是 False）
        self.assertIsInstance(payload['ocr_available'], bool)

    def test_payload_plain_url_not_classified(self):
        payload = self._run(_Cfg(search_url='https://example.com/search?wd=@keyword'))
        self.assertFalse(payload['captcha_url_classified'])

    def test_payload_contract_no_extra_fetch(self):
        # 主路径契约：payload 不含 captcha_image_url，且验证码分支零网络请求
        # （http_client.get / _send_guarded 均不得被调用）
        cfg = _Cfg(search_url='https://example.com/s?wd=@keyword',
                   anti={'enabled': 1, 'captchaImage': '//img'})
        with mock.patch.object(self.engine, 'search', side_effect=CaptchaRequiredException('p')), \
                mock.patch('http_client.get') as m_get, \
                mock.patch.object(RuleEngine, '_send_guarded') as m_guard:
            payload = self.engine.search_with_captcha_retry(cfg, 'k')
        self.assertNotIn('captcha_image_url', payload)
        self.assertEqual(sorted(payload.keys()),
                         sorted(['captcha_required', 'plugin_name', 'captcha_url',
                                 'captcha_url_classified', 'ocr_available']))
        m_get.assert_not_called()
        m_guard.assert_not_called()


class TestCaptchaImageUrlGuarded(unittest.TestCase):
    """_captcha_image_url 的守卫接入（按需调用路径，不在搜索主链路上）。

    captchaImage 抓的是规则派生页面，与搜索主链路同级不可信：必须走
    _send_guarded（逐跳 _guard_hop(kind='site') + 手动跟重定向），不得用裸
    http_client.get（自动跟重定向 + 无逐跳守卫，302 可进内网）。"""

    def setUp(self):
        self.engine = RuleEngine(log_failures=False)

    def test_uses_send_guarded_not_bare_get(self):
        # 抓取走 _send_guarded（守卫 + 禁自动跟重定向），不走裸 http_client.get
        cfg = _Cfg(search_url='https://example.com/s?wd=@keyword',
                   anti={'enabled': 1, 'captchaImage': '//img[@class="cap"]'})
        html = '<html><body><img class="cap" src="/gen/captcha.php?ts=1"></body></html>'

        class Rsp:
            status_code = 200
            text = html

        with mock.patch.object(RuleEngine, '_send_guarded', return_value=Rsp()) as m, \
                mock.patch('http_client.get') as m_bare:
            url = self.engine._captcha_image_url(cfg)
        self.assertEqual(url, 'https://example.com/gen/captcha.php?ts=1')
        m.assert_called_once()
        self.assertEqual(m.call_args[0][:3], ('GET', 'https://example.com/s?wd=', cfg))
        self.assertEqual(m.call_args[1].get('timeout'), (5, 8))
        m_bare.assert_not_called()

    def test_guarded_guard_blocks_private_redirect_target(self):
        # 功能性守卫断言：抓取被 _send_guarded 的逐跳守卫拦截（严格模式下
        # 内网地址拒绝），异常被吞、返回 ''（展示兜底可缺省）
        cfg = _Cfg(search_url='https://example.com/s?wd=@keyword',
                   anti={'enabled': 1, 'captchaImage': '//img'})
        with mock.patch.object(RuleEngine, '_send_guarded',
                               side_effect=ValueError('blocked by guard: 10.0.0.5')):
            url = self.engine._captcha_image_url(cfg)
        self.assertEqual(url, '')

    def test_non_200_returns_empty(self):
        cfg = _Cfg(search_url='https://example.com/s?wd=@keyword',
                   anti={'enabled': 1, 'captchaImage': '//img'})

        class Rsp:
            status_code = 500
            text = ''

        with mock.patch.object(RuleEngine, '_send_guarded', return_value=Rsp()):
            self.assertEqual(self.engine._captcha_image_url(cfg), '')

    def test_no_captcha_image_expr_no_request(self):
        # 规则未声明 captchaImage：不发起任何请求
        cfg = _Cfg(search_url='https://example.com/s?wd=@keyword', anti={})
        with mock.patch.object(RuleEngine, '_send_guarded') as m:
            self.assertEqual(self.engine._captcha_image_url(cfg), '')
        m.assert_not_called()


class TestBangumiEpisodeComments(unittest.TestCase):
    """分集评论（T82 选集讨论板块）：GET next.bgm /p1/episodes/{id}/comments。

    对齐 Kazumi getBangumiCommentsByEpisodeID：一次性返回全集主楼层数组，
    每项含 user/content/createdAt/replies（楼中楼）。next.bgm /p1 历史上出现过
    裸数组与 {list: []} 包装两种形态，统一兼容。
    """

    def setUp(self):
        self.mgr = PluginManager()

    def _rsp(self, payload, code=200):
        r = _Rsp(code, payload)
        return r

    def test_bare_array(self):
        payload = [{'user': {'nickname': '甲'}, 'content': '好活', 'createdAt': 1700000000, 'replies': []}]
        with mock.patch('http_client.get', return_value=self._rsp(payload)) as m:
            out = self.mgr.bangumi_episode_comments(102)
        self.assertEqual(out, payload)
        url = m.call_args[0][0]
        self.assertIn('/p1/episodes/102/comments', url)
        # UA 必须是 Bangumi 官方要求的应用标识（与 bangumi_comments 同口径）
        from kazumi.plugin_manager import BANGUMI_UA
        self.assertEqual(m.call_args[1]['headers']['User-Agent'], BANGUMI_UA)

    def test_list_wrapper_compat(self):
        # {list: [...]} 包装形态兼容（next.bgm 历史变体）
        payload = {'list': [{'user': {'nickname': '乙'}, 'content': 'x', 'replies': []}]}
        with mock.patch('http_client.get', return_value=self._rsp(payload)):
            out = self.mgr.bangumi_episode_comments(102)
        self.assertEqual(out, payload['list'])

    def test_data_wrapper_compat(self):
        payload = {'data': [{'content': 'y'}]}
        with mock.patch('http_client.get', return_value=self._rsp(payload)):
            out = self.mgr.bangumi_episode_comments(102)
        self.assertEqual(out, payload['data'])

    def test_non_list_payload_degrades_to_empty(self):
        # 奇异形态（字符串/对象且无 list/data 键）：空列表兜底，不抛异常
        with mock.patch('http_client.get', return_value=self._rsp('weird')):
            self.assertEqual(self.mgr.bangumi_episode_comments(102), [])
        with mock.patch('http_client.get', return_value=self._rsp({'foo': 1})):
            self.assertEqual(self.mgr.bangumi_episode_comments(102), [])

    def test_network_error_returns_empty(self):
        with mock.patch('http_client.get', side_effect=RuntimeError('boom')):
            self.assertEqual(self.mgr.bangumi_episode_comments(102), [])


class TestBangumiCommentsTotal(unittest.TestCase):
    """番剧吐槽（detail.js 吐槽页签）：GET next.bgm /p1/subjects/{id}/comments。

    正常响应为 {data: [...], total: N}（total 为该条目吐槽总数，与 limit/offset
    无关，UI 据此显示「共 N 条」真实总数而非「共 100 条+」）。统一返回
    {'list': [...], 'total': int}；裸数组/失败形态 total 回退已加载数/0。
    """

    def setUp(self):
        self.mgr = PluginManager()

    def test_dict_payload_with_total(self):
        payload = {'data': [{'user': {'nickname': '甲'}, 'comment': '好'}], 'total': 6984}
        with mock.patch('http_client.get', return_value=_Rsp(200, payload)) as m:
            out = self.mgr.bangumi_comments(876, 100, 0)
        self.assertEqual(out, {'list': payload['data'], 'total': 6984})
        url = m.call_args[0][0]
        self.assertIn('/p1/subjects/876/comments', url)
        self.assertEqual(m.call_args[1]['params'], {'limit': 100, 'offset': 0})

    def test_total_missing_falls_back_to_items_len(self):
        # 无 total 键（历史变体）：回退 items 长度（分页下仅已加载部分可知）
        payload = {'data': [{'comment': 'a'}, {'comment': 'b'}]}
        with mock.patch('http_client.get', return_value=_Rsp(200, payload)):
            out = self.mgr.bangumi_comments(876, 100, 0)
        self.assertEqual(out, {'list': payload['data'], 'total': 2})

    def test_bare_array_payload(self):
        payload = [{'comment': 'x'}, {'comment': 'y'}, {'comment': 'z'}]
        with mock.patch('http_client.get', return_value=_Rsp(200, payload)):
            out = self.mgr.bangumi_comments(876, 100, 0)
        self.assertEqual(out, {'list': payload, 'total': 3})

    def test_list_wrapper_compat(self):
        # {list: [...]} 包装形态兼容（next.bgm 历史变体）
        payload = {'list': [{'comment': 'w'}]}
        with mock.patch('http_client.get', return_value=_Rsp(200, payload)):
            out = self.mgr.bangumi_comments(876, 100, 0)
        self.assertEqual(out, {'list': payload['list'], 'total': 1})

    def test_non_list_payload_degrades_to_empty(self):
        with mock.patch('http_client.get', return_value=_Rsp(200, 'weird')):
            self.assertEqual(self.mgr.bangumi_comments(876, 100, 0), {'list': [], 'total': 0})
        with mock.patch('http_client.get', return_value=_Rsp(200, {'foo': 1})):
            self.assertEqual(self.mgr.bangumi_comments(876, 100, 0), {'list': [], 'total': 0})

    def test_network_error_returns_empty(self):
        with mock.patch('http_client.get', side_effect=RuntimeError('boom')):
            self.assertEqual(self.mgr.bangumi_comments(876, 100, 0), {'list': [], 'total': 0})

    def test_total_non_numeric_degrades(self):
        # total 为非数值（脏数据）：忽略并回退 items 长度
        payload = {'data': [{'comment': 'a'}], 'total': 'many'}
        with mock.patch('http_client.get', return_value=_Rsp(200, payload)):
            out = self.mgr.bangumi_comments(876, 100, 0)
        self.assertEqual(out, {'list': payload['data'], 'total': 1})


class TestPluginCaptchaImageField(unittest.TestCase):
    """Plugin.anti_crawler_config 承载 captchaImage（确保配置通路存在）。"""

    def test_from_json_captcha_image(self):
        p = Plugin.from_json({
            'api': '5', 'name': 'cap', 'baseURL': 'https://example.com',
            'searchURL': 'https://example.com/s?wd=@keyword',
            'searchList': '//div', 'searchName': '//a', 'searchResult': '//a',
            'chapterRoads': '//ul', 'chapterResult': '//li/a',
            'antiCrawlerConfig': {'enabled': 1, 'captchaDetectValue': '//div[@id="cap"]',
                                  'captchaImage': '//img[@id="capimg"]/@src'},
        })
        cfg = p.execution_config()
        self.assertEqual((cfg.anti_crawler_config or {}).get('captchaImage'),
                         '//img[@id="capimg"]/@src')


if __name__ == '__main__':
    unittest.main()
