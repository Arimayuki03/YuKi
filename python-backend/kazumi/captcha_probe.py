# -*- coding: utf-8 -*-
"""验证码识别链「设置页测试」服务（2026-10-02）。

与生产识别链（captcha.recognize_captcha_bytes）的区别：生产链只返回
「文本或 None」——够用来解题，却不足以回答用户在设置页点「测试」时真正
想问的两件事：
  1. 我配的视觉大模型**能用吗**（连通？Key 对？模型支持图片输入吗）；
  2. 内置小模型**在不在**（权重打进包了吗）。
所以本模块单独提供带诊断信息的探测，不改动生产链的返回契约（生产链多
返回一个字段就要同步改 rule_engine 与前端两处消费方，代价不划算）。

── 内置探测图：只用于视觉通道，不用于给小模型判分 ──────────────────
探测图由 PIL 现场合成（4 位数字 + 轻旋转/斜切/噪点，几何对齐真实站点
样本的 128×40），后端持有答案故可判定「视觉模型读得对不对」。

**关键实测约束（2026-10-02，改本文件前必读）**：内置图**绝不能**用来给
tiny-CNN 判对错——实测仓库内权重 kazumi/assets/captcha_cnn.npz：
    合成样本（tools/train_captcha_cnn.py 分布）  all4  9%  char 46%
    干净印刷体（Arial，无噪声）                  all4  2%  char 35%
    真实站点样本（.captcha-data，站点判题标注）  all4 41%  char 79%
    （2026-10-08 复测 val 集：all4 0.41、char 0.79，仍远低于训练脚本自称
      的 all4 ≥0.90 门槛）
即权重只在**真实站点分布**上可用，对合成图近乎随机（2026-10-08 实测内置
探测图 150 张 all4 仅 2.7%，低于 4 位随机基线 10%）。若拿内置图给小模型
判分，测试会稳定报「识别错误」——那是素材不在分布内，不是用户配置问题。

因此分级判定（每条结论都必须有实测支撑，不给出误导性红叉）：
  - tiny-CNN：只报「可用 / 不可用 + 耗时」，并如实告知本图不在其训练
    分布内、不可据此判分（见 cnn 段的 note 字段）；
  - 视觉 LLM：报「连通 + 是否支持图片输入 + 识别是否正确 + 耗时」——
    纯文本模型会在这一步以 400/bad_response 暴露，这正是验证码场景最
    常见的配置错误，也是本按钮的主要诊断价值。

合成素材的系统字体可用性：PIL 近代版本（含 Pillow>=12）的
ImageFont.load_default(size=…) 返回可缩放矢量字体；老版本返回位图字体
（固定 ~11px，探测图上字会小到读不出）。故 _render_probe_image 必须显式
校验渲染出的字形高度，过小则整体放弃合成（返回 None，前端提示改用真实
图）——宁可不给结论，也不给错结论。
"""
import io
import logging
import random
import time

logger = logging.getLogger('yuki.kazumi.captcha_probe')

# 探测图几何：对齐真实站点样本（.captcha-data 实测 128×40），不走
# captcha_cnn 的 32×96 模型输入尺寸——视觉模型不吃后者那种挤压比例。
PROBE_W = 128
PROBE_H = 40
PROBE_DIGITS = 4

# 字形高度下限（占画布高比例）：低于此值说明拿到的是位图默认字体，
# 渲染结果人类/模型都读不清，放弃合成而不是给出低质量探测图。
_MIN_GLYPH_HEIGHT_RATIO = 0.35

# 视觉探测超时：比生产链 _LLM_TIMEOUT(10,30) 收窄——设置页是交互手势，
# 用户盯着结果行，超过 20s 无反馈体验很差；且探测失败不损伤业务。
_PROBE_TIMEOUT = (8, 20)

_PROBE_PROMPT = (
    'This image is a CAPTCHA showing exactly 4 digits (0-9). '
    'Read them and output ONLY the 4 digits, nothing else.')


def _font(size):
    """取一个可用字体；不可缩放（位图）字体返回 None（调用方放弃合成）。"""
    from PIL import Image, ImageDraw, ImageFont
    try:
        f = ImageFont.load_default(size=size)
    except TypeError:
        return None      # 极老 PIL：load_default 不接受 size
    except Exception:
        return None
    probe = Image.new('L', (PROBE_W, PROBE_H), 255)
    ImageDraw.Draw(probe).text((2, 2), '1234', fill=0, font=f)
    bbox = probe.point(lambda v: 255 - v).getbbox()
    if not bbox:
        return None
    if (bbox[3] - bbox[1]) < PROBE_H * _MIN_GLYPH_HEIGHT_RATIO:
        # 位图字体（渲染高度远小于请求 size）：探测图不可读，放弃
        return None
    return f


def render_probe_image(seed=None):
    """合成一张 4 位数字验证码探测图 → (png_bytes, answer_text)，不可用返回 None。

    形变分布（旋转/斜切/噪点）刻意贴近真实站点而非训练脚本的合成分布：
    视觉模型要判的是「能不能读懂验证码」，不是「能不能读懂印刷体」。
    每次调用随机取新答案（seed 仅用于测试复现）。"""
    from PIL import Image, ImageDraw, ImageFilter
    rng = random.Random(seed)
    answer = ''.join(str(rng.randrange(10)) for _ in range(PROBE_DIGITS))
    size = int(PROBE_H * 0.72)
    font = _font(size)
    if font is None:
        logger.info('[kazumi] 探测图合成不可用（PIL 无可用可缩放字体）')
        return None
    canvas = Image.new('L', (PROBE_W, PROBE_H), 245)
    draw = ImageDraw.Draw(canvas)
    step = PROBE_W / (PROBE_DIGITS + 1.0)
    for i, ch in enumerate(answer):
        # 逐字渲染后单独形变（整串一起旋转会粘连到无法辨认）
        cell = Image.new('L', (int(step * 1.6), PROBE_H), 245)
        ImageDraw.Draw(cell).text((4, int(PROBE_H * 0.12)), ch, fill=15, font=font)
        angle = rng.uniform(-12, 12)
        cell = cell.rotate(angle, expand=True, resample=Image.BILINEAR, fillcolor=245)
        cell = cell.transform(
            (cell.width, cell.height), Image.AFFINE,
            (1.0, rng.uniform(-0.25, 0.25), -3.0, 0.0, 1.0, 0.0),
            resample=Image.BILINEAR, fillcolor=245)
        canvas.paste(cell, (int(step * (i + 1) - cell.width / 2),
                            int((PROBE_H - cell.height) / 2)))
    # 轻噪点 + 一条干扰线（真实验证码的常态干扰，但不淹没笔画）
    pixels = canvas.load()
    for _ in range(int(PROBE_W * PROBE_H * 0.02)):
        pixels[rng.randrange(PROBE_W), rng.randrange(PROBE_H)] = rng.randrange(120, 240)
    draw.line((rng.uniform(0, PROBE_W), rng.uniform(0, PROBE_H),
               rng.uniform(0, PROBE_W), rng.uniform(0, PROBE_H)),
              fill=200, width=1)
    canvas = canvas.filter(ImageFilter.GaussianBlur(0.4))
    buf = io.BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue(), answer


def _probe_llm(image_bytes, llm_cfg):
    """视觉 LLM 单级探测 → {ok, ms, err, text}。

    与生产链 llm_vision_recognize_captcha 同源（同一 OpenAI 兼容多模态协议），
    但超时收窄且不吞异常分类——探测的目的就是把失败原因说清楚。"""
    from .translate import (TranslateError, _CAPTCHA_MAX_TOKENS,
                            extract_captcha_digits, extract_vision_text)
    cfg = dict(llm_cfg or {})
    if not (str(cfg.get('model') or '').strip() and str(cfg.get('base') or '').strip()):
        return {'ok': False, 'err': 'bad_request', 'text': ''}
    import base64
    import http_client
    import json
    import re
    base = str(cfg.get('base') or '').strip().rstrip('/')
    key = str(cfg.get('key') or '').strip()
    model = str(cfg.get('model') or '').strip()
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': _PROBE_PROMPT},
            {'type': 'image_url', 'image_url': {
                'url': 'data:image/png;base64,' + base64.b64encode(image_bytes).decode('ascii')}},
        ]}],
        'temperature': 0.0,
        # 输出预算与生产链同源（translate._CAPTCHA_MAX_TOKENS，2026-10-08
        # 由 16 提升）：推理型模型先输出前言、答案落在末尾，预算不足就是截断。
        # 两侧必须同一常量，否则探测通过而线上失败。
        'max_tokens': _CAPTCHA_MAX_TOKENS,
        'stream': False,
    }
    started = time.monotonic()
    ms = 0
    try:
        rsp = http_client.post(base + '/chat/completions', json=body,
                               timeout=_PROBE_TIMEOUT, headers=headers)
        # 分类口径与 translate.llm_vision_recognize_captcha 一致（复用其错误码，
        # 前端错误文案表可共用一套键）。抽成局部函数：截断重发分支（L4）复用
        # 同一套判定，避免两处漂移。
        def _raise_for_status(r):
            if r.status_code in (401, 403):
                raise TranslateError('auth', 'LLM 鉴权失败（{}）'.format(r.status_code))
            if r.status_code == 429:
                raise TranslateError('rate_limit', 'LLM 频率受限（429）')
            if r.status_code >= 500:
                raise TranslateError('server', 'LLM 服务暂不可用（{}）'.format(r.status_code))
            if r.status_code != 200:
                # 4xx 里最高频的一类：模型不支持图片输入（纯文本模型收到
                # image_url 直接 400）——探测的核心诊断目标
                raise TranslateError('bad_request', 'LLM 请求失败（{}）'.format(r.status_code))
        _raise_for_status(rsp)
        ms = round((time.monotonic() - started) * 1000)
        # 正文提取与生产链同源（translate.extract_vision_text，M4）：content
        # 分段数组 / reasoning_content 兜底在此集中维护，两侧必须同一口径。
        data = json.loads(rsp.text)
        content = extract_vision_text(data)
        # 截断保护：finish_reason=length 且 4 位数字未出现时放宽预算重发一次。
        # 基线预算已从 16 提到 320（见 body 注释），此处的升级比例也相应放大
        # ——少数推理型模型的前言远超预期，二次给足预算而不是让探测失败。
        # 「验证码是1797」按 token 切分后末尾数字可能被截掉、思考型模型可能
        # 把预算全烧在 reasoning 上，两者都表现为「识别为空」。
        if not re.search(r'\d{4}', content.translate(
                str.maketrans('０１２３４５６７８９', '0123456789'))) \
                and str(data['choices'][0].get('finish_reason') or '') == 'length':
            body['max_tokens'] = _CAPTCHA_MAX_TOKENS * 4
            rsp = http_client.post(base + '/chat/completions', json=body,
                                   timeout=_PROBE_TIMEOUT, headers=headers)
            # 重发响应复用同一套状态码分类（L4）：首次 200 不代表重发也 200
            _raise_for_status(rsp)
            data = json.loads(rsp.text)
            content = extract_vision_text(data)
            # 耗时合并两次请求（L4）：重发也是探测成本的一部分
            ms = round((time.monotonic() - started) * 1000)
    except TranslateError as e:
        return {'ok': False, 'err': e.code, 'ms': round((time.monotonic() - started) * 1000), 'text': ''}
    except (ValueError, TypeError, KeyError, IndexError) as e:
        # 响应体结构不符（缺 choices/message/content）：与生产链同判 bad_response。
        # 必须单独分类——模型返回了 200 但内容不是预期结构，说明端点/协议不对，
        # 若笼统归到 network 会误导用户去查网络。
        logger.info('[kazumi] 验证码探测：视觉模型响应格式异常: %s', e)
        return {'ok': False, 'err': 'bad_response',
                'ms': round((time.monotonic() - started) * 1000), 'text': ''}
    except Exception as e:
        logger.info('[kazumi] 验证码探测：视觉模型请求异常: %s', e)
        return {'ok': False, 'err': 'network',
                'ms': round((time.monotonic() - started) * 1000), 'text': ''}
    # 与生产链共享同一提取口径（translate.extract_captcha_digits）：中文模型
    # 回复「验证码是1797」时 \b 在汉字与数字间不成立会整体漏提取（2026-10-03
    # 用户实测「识别为空」的根因）——两侧必须同源，否则测试通过线上失败。
    # 推理型模型前言里可能先出现别的数字串，故提取口径按「答案在末尾」取
    # 最后一个候选（详见 translate.extract_captcha_digits）。
    # raw 供 UI 展示模型回复原文（截 64 字符防刷屏）。
    return {'ok': True, 'ms': ms, 'text': extract_captcha_digits(content),
            'raw': content[:64]}


def probe(llm_cfg=None, image=None):
    """跑一次识别链探测 → 结构化诊断 dict（不抛异常，失败也返回结论）。

    返回体（供 server 端点直接 JSON 化，渲染层按字段渲染）：
      {
        'image': True,                 # 内置探测图是否可用（False 时其余无意义）
        'answer': '1234',              # 探测图答案（调试/展示用）
        'cnn': {'available': bool, 'ms': int, 'text': str, 'note': str},
        'llm': {'enabled': bool, 'ok': bool, 'ms': int, 'err': str,
                'text': str, 'correct': bool, 'raw': str},
      }
    cnn 段恒定返回（无论是否启用 LLM）：用户需要知道内置能力在不在。
    note 如实说明「内置图不在小模型训练分布内」——见本模块顶部实测数据，
    这条警示比一个错误的「识别失败」结论有用得多。
    llm.raw 是模型回复原文（截 64 字符）：「识别为空」时用户能直接看到模型
    到底回了什么（空内容/思考型模型正文在别处/前缀形态），不再两眼一抹黑。
    """
    out = {'image': False, 'answer': '', 'cnn': {'available': False, 'ms': 0, 'text': ''},
           'llm': {'enabled': False, 'ok': False, 'ms': 0, 'err': '', 'text': '',
                   'correct': False, 'raw': ''}}
    built = image if image is not None else render_probe_image()
    if not built:
        return out
    png, answer = built
    out['image'] = True
    out['answer'] = answer

    # 第一级：tiny-CNN（只报可用性，不判对错，理由见模块顶部实测）
    try:
        from . import captcha as captcha_mod
        started = time.monotonic()
        if captcha_mod._cnn_available():
            text = captcha_mod._load_cnn().recognize(png)
            out['cnn'] = {'available': True, 'ms': round((time.monotonic() - started) * 1000),
                          'text': str(text or '')}
        else:
            out['cnn'] = {'available': False, 'ms': 0, 'text': ''}
    except Exception as e:
        logger.info('[kazumi] 验证码探测：小模型探测异常: %s', e)
        out['cnn'] = {'available': False, 'ms': 0, 'text': ''}
    out['cnn']['note'] = (
        '内置小模型的训练分布是真实站点验证码，本探测图为合成图、不在其分布内，'
        '故此处的识别结果不代表线上识别率')

    # 第二级：视觉 LLM（配置齐全才跑——未启用兜底时不该悄悄消耗用户额度）
    cfg = llm_cfg or {}
    if str(cfg.get('model') or '').strip() and str(cfg.get('base') or '').strip():
        out['llm']['enabled'] = True
        r = _probe_llm(png, cfg)
        out['llm'].update(r)
        if r.get('ok'):
            out['llm']['correct'] = (r.get('text') or '') == answer
    return out
