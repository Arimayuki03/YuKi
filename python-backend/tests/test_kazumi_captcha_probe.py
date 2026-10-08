# -*- coding: utf-8 -*-
"""设置页「验证码识别测试」服务测试（kazumi/captcha_probe.py，桩网络）。

覆盖三条契约：
  1. 内置探测图：几何/可辨性（4 个分离字形团 + 字高占比下限）——老 PIL 的
     位图默认字体渲染出的图人类都读不出，必须整体放弃合成而不是给低质图；
  2. 分级判定：小模型只报可用性不判对错（合成图不在其训练分布内，实测权重
     在合成图上整图仅 ~9%，近随机基线 10%——拿它判分必然误报「识别失败」）；
     视觉 LLM 判连通 + 图片可读性，并按错误码分类；
  3. 端点信封：dispatch_kazumi_action('kazumiCaptchaProbe') 恒 200 且 result
     嵌套（成败由 result 表达，与 kazumiCaptchaSolve 同信封口径）。

不发真实网络请求；LLM 侧桩在 captcha_probe._probe_llm / http_client.post。
"""
import io
import os
import sys
import unittest
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
for _p in (BASE, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)
_TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(_TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(_TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(_TEST_ROOT, 'cache'))

import http_client  # noqa: E402
from kazumi import captcha as captcha_mod  # noqa: E402  小模型探测桩目标（probe 内部按名引用）
from kazumi import captcha_probe  # noqa: E402


class _Rsp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        import json as _json
        self.text = _json.dumps(self._payload)


def _llm_payload(text):
    return {'choices': [{'message': {'content': text}}]}


class TestProbeImage(unittest.TestCase):
    """内置探测图：合成成功 / 几何 / 可辨性 / 字体退化时放弃合成。"""

    def test_render_returns_png_and_answer(self):
        built = captcha_probe.render_probe_image(seed=1)
        self.assertIsNotNone(built)
        png, answer = built
        self.assertEqual(len(answer), 4)
        self.assertTrue(answer.isdigit())
        self.assertTrue(png.startswith(b'\x89PNG'))
        from PIL import Image
        im = Image.open(io.BytesIO(png))
        self.assertEqual(im.size, (captcha_probe.PROBE_W, captcha_probe.PROBE_H))

    def test_render_is_seed_reproducible_and_varies(self):
        a = captcha_probe.render_probe_image(seed=7)
        b = captcha_probe.render_probe_image(seed=7)
        c = captcha_probe.render_probe_image(seed=8)
        self.assertEqual(a[1], b[1])
        self.assertNotEqual(a[1], c[1])

    def test_digits_are_separated_and_readable(self):
        """可辨性护栏：4 个分离字形团 + 字高占画布 ≥ 下限。

        位图默认字体（老 PIL）渲染高度远小于请求 size，探测图会小到读不出
        ——合成侧已按 _MIN_GLYPH_HEIGHT_RATIO 放弃，这里守住该契约不被改坏。"""
        from PIL import Image
        for seed in (1, 42, 777):
            png, _ = captcha_probe.render_probe_image(seed=seed)
            arr = np.asarray(Image.open(io.BytesIO(png)).convert('L'), dtype=np.float32)
            ink = arr < 128
            col = ink.sum(axis=0)
            thresh = max(1.0, col.max() * 0.15)
            blobs, start = [], None
            for i, v in enumerate(col):
                if v >= thresh and start is None:
                    start = i
                elif v < thresh and start is not None:
                    if i - start >= 3:
                        blobs.append((start, i))
                    start = None
            if start is not None and len(col) - start >= 3:
                blobs.append((start, len(col)))
            self.assertEqual(len(blobs), 4, f'seed={seed} 字形团数应为 4，实得 {len(blobs)}')
            rows = np.nonzero(ink.sum(axis=1))[0]
            height = (rows.max() - rows.min() + 1) if len(rows) else 0
            self.assertGreaterEqual(height / arr.shape[0],
                                    captcha_probe._MIN_GLYPH_HEIGHT_RATIO)

    def test_unusable_font_abandons_rendering(self):
        """字体不可缩放（位图）→ render 返回 None，绝不产出低质探测图。"""
        with mock.patch.object(captcha_probe, '_font', return_value=None):
            self.assertIsNone(captcha_probe.render_probe_image(seed=1))

    def test_probe_degrades_when_image_unavailable(self):
        with mock.patch.object(captcha_probe, 'render_probe_image', return_value=None):
            out = captcha_probe.probe()
        self.assertFalse(out['image'])
        self.assertFalse(out['cnn']['available'])
        self.assertFalse(out['llm']['enabled'])


class TestProbeGrading(unittest.TestCase):
    """分级判定：小模型不判对错；LLM 判连通/图片可读性 + 错误分类。"""

    def test_cnn_section_reports_availability_not_correctness(self):
        """契约核心：cnn 段报 available，且**不带** correct 字段。

        合成图不在小模型训练分布内（实测权重合成图整图 ~9%，近随机），
        若在此判对错会让测试稳定误报「识别失败」。断言 correct 不存在，
        使「给小模型判分」这种改动无法悄悄溜进主干。"""
        with mock.patch.object(captcha_mod, '_cnn_available', return_value=True), \
                mock.patch.object(captcha_mod, '_load_cnn') as load:
            load.return_value.recognize.return_value = '0000'   # 明显≠答案
            out = captcha_probe.probe()
        self.assertTrue(out['cnn']['available'])
        self.assertNotIn('correct', out['cnn'], '小模型段不得判对错')
        self.assertTrue(out['cnn']['note'], 'note 必须如实说明分布外')

    def test_cnn_unavailable_reported(self):
        with mock.patch.object(captcha_mod, '_cnn_available', return_value=False):
            out = captcha_probe.probe()
        self.assertFalse(out['cnn']['available'])

    def test_cnn_exception_degrades_to_unavailable(self):
        with mock.patch.object(captcha_mod, '_cnn_available', side_effect=RuntimeError('boom')):
            out = captcha_probe.probe()
        self.assertFalse(out['cnn']['available'])

    def test_llm_skipped_when_not_configured(self):
        out = captcha_probe.probe(llm_cfg=None)
        self.assertFalse(out['llm']['enabled'])
        self.assertFalse(out['llm']['ok'])
        # 未启用兜底时不该悄悄消耗用户额度：不得发起任何请求
        with mock.patch.object(http_client, 'post') as post:
            captcha_probe.probe(llm_cfg={'base': '', 'model': '', 'key': ''})
        post.assert_not_called()

    def test_llm_success_and_correctness(self):
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(f'答案是 {answer}'))):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertTrue(out['llm']['enabled'])
        self.assertTrue(out['llm']['ok'])
        self.assertTrue(out['llm']['correct'])
        self.assertEqual(out['llm']['text'], answer)

    def test_llm_wrong_read_is_not_ok_correct(self):
        built = captcha_probe.render_probe_image(seed=5)
        wrong = '0000' if built[1] != '0000' else '1111'
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(wrong))):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertTrue(out['llm']['ok'])          # 连通
        self.assertFalse(out['llm']['correct'])    # 但读错了

    def test_llm_error_classification(self):
        """错误码分类：auth/rate_limit/server/bad_request(含不支持图片)/network。"""
        built = captcha_probe.render_probe_image(seed=5)
        cases = [(401, 'auth'), (429, 'rate_limit'), (500, 'server'), (400, 'bad_request')]
        for status, expected in cases:
            with mock.patch.object(http_client, 'post', return_value=_Rsp(status, {})):
                out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                          image=built)
            self.assertFalse(out['llm']['ok'])
            self.assertEqual(out['llm']['err'], expected, f'status={status}')

    def test_llm_network_error_classified(self):
        built = captcha_probe.render_probe_image(seed=5)
        with mock.patch.object(http_client, 'post', side_effect=OSError('unreachable')):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertFalse(out['llm']['ok'])
        self.assertEqual(out['llm']['err'], 'network')

    def test_llm_malformed_body_is_bad_response(self):
        built = captcha_probe.render_probe_image(seed=5)
        with mock.patch.object(http_client, 'post', return_value=_Rsp(200, {'nope': 1})):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertFalse(out['llm']['ok'])
        self.assertEqual(out['llm']['err'], 'bad_response')

    def test_llm_chinese_wrapped_reply_extracted(self):
        """中文模型回复「验证码是XXXX。」必须提取成功（2026-10-03 用户实测回归）。

        实测模型读对了图、但回复带中文前缀——旧口径 \\b 在汉字与数字间不成立
        （Python \\w 匹配汉字），整体漏提取显示「识别为空」。探测与生产链必须
        同一提取口径。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        for reply in (f'验证码是{answer}。', f'图片中的数字是{answer}',
                      f' 识别结果：{answer} '):
            with mock.patch.object(http_client, 'post',
                                   return_value=_Rsp(200, _llm_payload(reply))):
                out = captcha_probe.probe(
                    llm_cfg={'base': 'https://x/v1', 'model': 'm'}, image=built)
            self.assertTrue(out['llm']['ok'], reply)
            self.assertEqual(out['llm']['text'], answer, reply)
            self.assertTrue(out['llm']['correct'], reply)

    def test_llm_fullwidth_and_spaced_digits_extracted(self):
        """全角（１７９７）与空格分位（1 7 9 7）形态同样必须提取成功。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        fw = answer.translate(str.maketrans('0123456789', '０１２３４５６７８９'))
        spaced = ' '.join(answer)
        for reply in (fw, spaced, f'验证码{fw}'):
            with mock.patch.object(http_client, 'post',
                                   return_value=_Rsp(200, _llm_payload(reply))):
                out = captcha_probe.probe(
                    llm_cfg={'base': 'https://x/v1', 'model': 'm'}, image=built)
            self.assertEqual(out['llm']['text'], answer, reply)
            self.assertTrue(out['llm']['correct'], reply)

    def test_reasoning_prefixed_reply_takes_trailing_answer(self):
        """推理型模型先吐前言、答案落在末尾：必须取末尾候选（2026-10-08 实测）。

        用户实测形态：模型回复以 "The user wants me to read a CAPTCHA with
        exactly 4 digits. Looki…" 开头，因截断表现为「识别为空」。即便不截断，
        旧「取首个匹配」的口径也可能把前言里偶现的数字串当答案。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        reply = ('The user wants me to read a CAPTCHA with exactly 4 digits. '
                 f'Looking closely, the digits are {answer}.')
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(reply))):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertEqual(out['llm']['text'], answer)
        self.assertTrue(out['llm']['correct'])

    def test_prefixed_reply_with_decoy_number_takes_trailing_answer(self):
        """前言里含另一个 4 位数字串时，仍必须取末尾的（2026-10-08）。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        decoy = '4321' if answer != '4321' else '5678'
        reply = f'In 2024 the pattern {decoy} appears, but the code is {answer}'
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(reply))):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertEqual(out['llm']['text'], answer)
        self.assertTrue(out['llm']['correct'])

    def test_truncated_reply_retries_with_larger_budget(self):
        """finish_reason=length 且无 4 位数字 → max_tokens 放宽重发一次。

        用户实测形态（2026-10-08）：推理型模型先吐一段前言，预算不足时答案
        被截在窗口外，表现为「识别为空」。首请求用基线预算，二次放宽。
        断言引用 translate._CAPTCHA_MAX_TOKENS 而非写死数值——预算常量调整
        时本用例不该失败（它锁的是「重发放宽」这个契约，不是某个具体数字）。"""
        from kazumi.translate import _CAPTCHA_MAX_TOKENS
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        truncated = {'choices': [{'message': {'content': '验证码是'},
                                  'finish_reason': 'length'}]}
        complete = {'choices': [{'message': {'content': f'验证码是{answer}'},
                                 'finish_reason': 'stop'}]}
        # kwargs['json'] 是同一 dict 的引用：重试会原地改 max_tokens，回看
        # 第一次调用也会读到放宽后的值。必须在 side_effect 当场快照各次预算。
        budgets = []

        def seq(url, **kw):
            budgets.append(kw['json']['max_tokens'])
            return _Rsp(200, truncated if len(budgets) == 1 else complete)

        with mock.patch.object(http_client, 'post', side_effect=seq):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertEqual(len(budgets), 2)
        self.assertEqual(budgets[0], _CAPTCHA_MAX_TOKENS)
        self.assertGreater(budgets[1], budgets[0], '重发必须放宽预算')
        self.assertEqual(out['llm']['text'], answer)
        self.assertTrue(out['llm']['correct'])

    def test_baseline_budget_fits_reasoning_preamble(self):
        """基线预算必须装得下推理前言：16 token 正是截断 bug 的根因。

        实测截断样本仅前言就超过 16 token。这里守住「预算显著大于纯答案
        （4 字符）所需」的契约，防止有人把预算改回 16 而让 bug 复活。"""
        from kazumi.translate import _CAPTCHA_MAX_TOKENS
        self.assertGreater(_CAPTCHA_MAX_TOKENS, 64,
                           '预算必须容纳推理型模型的前言，16 token 会截断')

    def test_extraction_matches_production_chain(self):
        """同源契约：探测与生产链（llm_vision_recognize_captcha）对同一回复
        必须给出同一答案——否则「测试通过、线上失败」。"""
        from kazumi import translate as translate_mod
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        reply = f'验证码是{answer}。'
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(reply))):
            probe_out = captcha_probe.probe(
                llm_cfg={'base': 'https://x/v1', 'model': 'm'}, image=built)
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload(reply))):
            prod_out = translate_mod.llm_vision_recognize_captcha(
                'aW1n', {'base': 'https://x/v1', 'model': 'm'})
        self.assertEqual(probe_out['llm']['text'], answer)
        self.assertEqual(prod_out, answer)

    def test_content_array_form_extracted(self):
        """部分网关把多模态 content 回成分段数组——取各段 text 拼接后提取。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        payload = {'choices': [{'message': {'content': [
            {'type': 'text', 'text': '验证码是'},
            {'type': 'text', 'text': answer},
        ]}}]}
        with mock.patch.object(http_client, 'post', return_value=_Rsp(200, payload)):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertEqual(out['llm']['text'], answer)
        self.assertTrue(out['llm']['correct'])

    def test_reasoning_content_fallback(self):
        """思考型模型 content 空、正文在 reasoning_content——一并兜住。"""
        built = captcha_probe.render_probe_image(seed=5)
        answer = built[1]
        payload = {'choices': [{'message': {'content': '',
                                            'reasoning_content': f'图里是{answer}'}}]}
        with mock.patch.object(http_client, 'post', return_value=_Rsp(200, payload)):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertEqual(out['llm']['text'], answer)

    def test_raw_reply_exposed_for_diagnosis(self):
        """「识别为空」时 UI 要能显示模型原文——result.llm.raw 必须带回。"""
        built = captcha_probe.render_probe_image(seed=5)
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload('我看不到图片'))):
            out = captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm'},
                                      image=built)
        self.assertTrue(out['llm']['ok'])
        self.assertFalse(out['llm']['correct'])
        self.assertEqual(out['llm']['text'], '')
        self.assertEqual(out['llm']['raw'], '我看不到图片')

    def test_llm_sends_image_as_multimodal_content(self):
        """探测必须真的带图：纯文本模型会在站点侧 400，这是核心诊断点。"""
        built = captcha_probe.render_probe_image(seed=5)
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload('1234'))) as post:
            captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'vlm'},
                                image=built)
        body = post.call_args.kwargs['json']
        self.assertEqual(post.call_args.args[0], 'https://x/v1/chat/completions')
        content = body['messages'][0]['content']
        self.assertTrue(any(p.get('type') == 'image_url' for p in content))
        self.assertIn('data:image/png;base64,', content[1]['image_url']['url'])
        self.assertEqual(body['model'], 'vlm')

    def test_key_forwarded_as_bearer(self):
        built = captcha_probe.render_probe_image(seed=5)
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, _llm_payload('1234'))) as post:
            captcha_probe.probe(llm_cfg={'base': 'https://x/v1', 'model': 'm', 'key': 'sk-t'},
                                image=built)
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer sk-t')

    def test_probe_never_raises(self):
        """设置页按钮：任何异常都必须变成结论，绝不让点击抛出。"""
        with mock.patch.object(captcha_probe, 'render_probe_image',
                               side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                captcha_probe.probe()


class TestCaptchaProbeEndpoint(unittest.TestCase):
    """端点信封：恒 200 + result 嵌套（与 kazumiCaptchaSolve 同口径）。"""

    def _dispatch(self, form):
        import json as json_mod
        import server as server_mod
        with mock.patch.object(server_mod, 'kazumi_mgr', mock.MagicMock()):
            status, body = server_mod.dispatch_kazumi_action(form)
        self.assertEqual(status, 200, '探测失败是结论不是传输错误，信封恒 200')
        return json_mod.loads(body)

    def test_probe_envelope(self):
        data = self._dispatch({'do': 'kazumiCaptchaProbe'})
        self.assertEqual(data['code'], 200)
        self.assertIn('result', data)
        self.assertIn('cnn', data['result'])
        self.assertIn('llm', data['result'])

    def test_llm_cfg_parsed_from_form(self):
        """端点按次收凭据（captchaLLM* 键），与 solve 同一套解析。"""
        with mock.patch.object(captcha_probe, 'probe',
                               return_value={'image': True}) as probe:
            with mock.patch.dict('sys.modules', {'kazumi.captcha_probe': probe}):
                self._dispatch({'do': 'kazumiCaptchaProbe',
                                'captchaLLMBase': 'https://x/v1',
                                'captchaLLMModel': 'vlm',
                                'captchaLLMKey': 'sk-t'})
        cfg = probe.call_args.kwargs['llm_cfg']
        self.assertEqual(cfg['base'], 'https://x/v1')
        self.assertEqual(cfg['model'], 'vlm')
        self.assertEqual(cfg['key'], 'sk-t')


if __name__ == '__main__':
    unittest.main()
