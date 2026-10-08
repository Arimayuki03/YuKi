# -*- coding: utf-8 -*-
"""Kazumi 图片验证码自动识别（借鉴 animeko 项目思路的可选增强）。

animeko（open-ani/ani）的做法（app/shared/app-data/.../web/captcha/）：
  1. WebCaptchaDetector —— 纯分类器：启发式识别页面/URL 的验证码类型，只负责
     决定 UI 文案与 auto-solve 策略，判错代价低，宁可漏报不误报；
  2. ImageCaptchaSolver —— 随应用交付的 ONNX 模型对验证码图自动识别，
     失败/不支持时回退 InteractiveSolveDialog（把图展示给用户手动输入）。

本模块按同一分层移植到 YuKi 的 python 后端：
  - URL/HTML 启发式分类器在 kazumi/utils.py（looks_like_image_captcha_url /
    detect_image_captcha_html，animeko WebCaptchaDetector 对应位）；
  - 本文件只做「识别一件事」：验证码图片字节 → 文本（recognize_captcha_bytes）。

识别链（2026-10-01 重排，ddddocr 移除）：
  1. 自研 tiny-CNN（captcha_cnn.py，numpy 纯推理，权重随应用打包 ~3MB）：
     毫秒级、零外部依赖，扛住大部分标准形变样本；
  2. 视觉 LLM（translate.llm_vision_recognize_captcha，OpenAI 兼容多模态）：
     用户在划词翻译设置里配了 LLM（baseURL/model）时启用，扛花体/粘连等
     tiny-CNN 的分布外样本。凭据按次传入不落盘；未配置/失败/超时一律静默
     降级。决策记录：ddddocr（+200MB onnxruntime/opencv）按体积决策移除，
     识别率缺口由 LLM 兜底 + 3 轮换图重试 + 人工窗口补偿（用户 2026-10-01
     拍板，替代 2026-09-30 的「识别率优先」口径）。

任何一级 import 失败或调用异常一律返回 None——渲染层把 None 视为「未识别」，
沿既有交互兜底：人工验证窗口（animeko InteractiveSolveDialog 对应位）。
不阻塞登录/搜索主链路。
"""
import base64
import logging
import threading

logger = logging.getLogger('yuki.kazumi.captcha')

# 注意：captcha_cnn（连带 numpy）必须**懒加载**——numpy import ~120ms，
# 顶部 import 会拖慢 kazumi 包的加载链，spider worker 子进程的冷启动超时
# （test_config_content_blackbox 并发用例）会因此大面积 502。
# 仅在验证码识别路径真正触达时才付出这笔成本。

# 识别结果边界：Bangumi/常见番剧站验证码为 4-6 位字符（字母数字）。
# 超出视为识别失败（避免把噪声当结果提交，对齐 animeko 识别后仍要过
# PageEvaluator 判定成功的「识别 ≠ 解决」思想）。
_CAPTCHA_LEN_MIN = 3
_CAPTCHA_LEN_MAX = 8

# 模块级懒加载缓存：None=尚未尝试，False=不可用，否则为 tiny-CNN 可用。
_cnn_holder = {'ok': None, 'tried': False}
_cnn_lock = threading.Lock()


def _cnn_available():
    """tiny-CNN 权重探测（双检锁；失败永久标记不可用，不重复尝试）。"""
    ok = _cnn_holder['ok']
    if ok is not None:
        return ok
    with _cnn_lock:
        ok = _cnn_holder['ok']
        if ok is not None:
            return ok
        try:
            ok = bool(_load_cnn().model_available())
        except Exception as e:
            logger.info('[kazumi] tiny-CNN 探测不可用（降级 LLM 链）: %s', e)
            ok = False
        _cnn_holder['ok'] = ok
        _cnn_holder['tried'] = True
        return ok


def reset_ocr_cache():
    """重置识别器缓存（测试用：mock 注入后强制重新加载）。"""
    with _cnn_lock:
        _cnn_holder['ok'] = None
        _cnn_holder['tried'] = False


def _load_cnn():
    """懒加载小模型模块（首次调用付 numpy import ~120ms，之后走模块缓存）。"""
    from . import captcha_cnn
    return captcha_cnn


def ocr_available(llm_cfg=None):
    """当前进程是否具备自动识别能力（只探测，不识别）。

    两级识别链任一可用即为 True：tiny-CNN（权重随应用打包）或视觉 LLM
    （用户已配置 baseURL/model）。llm_cfg 缺省时只探测 tiny-CNN——调用方
    （solve_captcha）在真正识别时才拿得到按次传入的凭据，这里多探一步
    LLM 只为前端「⚡可自动」提示更准确。

    _load_cnn() 会触发 import captcha_cnn → 顶部 import numpy：numpy 缺失
    时 ImportError 必须在本模块边界吞掉降级，不能从「只探测」的探测口溢出
    （本模块契约：任何一级 import 失败一律降级）。"""
    try:
        if _cnn_available():
            return True
    except Exception as e:
        logger.info('[kazumi] tiny-CNN 探测异常（降级 LLM 探测）: %s', e)
    return bool(llm_cfg and str((llm_cfg or {}).get('model') or '').strip()
                and str((llm_cfg or {}).get('base') or '').strip())


def is_plausible_captcha_text(text):
    """识别结果合法性检查：3-8 位且以可见 ASCII 为主（验证码字符域）。

    空白/空串/超长噪声一律拒绝——自动识别的结果宁缺毋滥，错了要让用户
    多等一轮「提交失败→重输」，比直接降级手动输入更费时。"""
    t = str(text or '').strip()
    if not (_CAPTCHA_LEN_MIN <= len(t) <= _CAPTCHA_LEN_MAX):
        return False
    # 允许字母数字与常见符号；出现控制字符/大段空白视为噪声
    return all(32 < ord(ch) < 127 or ch.isalnum() for ch in t)


def _recognize_with_llm(image_bytes, llm_cfg):
    """视觉 LLM 二级识别。配置缺失/异常/结果不可信一律返回 None。"""
    if not (llm_cfg and str((llm_cfg or {}).get('model') or '').strip()
            and str((llm_cfg or {}).get('base') or '').strip()):
        return None
    try:
        from . import translate
        img_b64 = base64.b64encode(bytes(image_bytes)).decode('ascii')
        text = translate.llm_vision_recognize_captcha(img_b64, llm_cfg)
    except Exception as e:
        logger.info('[kazumi] LLM 验证码识别失败（降级人工窗口）: %s', e)
        return None
    text = str(text or '').strip()
    if is_plausible_captcha_text(text):
        return text
    if text:
        logger.info('[kazumi] LLM 验证码结果不可信: %r', text[:16])
    return None


def recognize_captcha_bytes(image_bytes, llm_cfg=None, prefer_llm=False):
    """验证码图片字节 → 文本；无法识别返回 None（调用方降级手动输入）。

    两级识别链（2026-10-01 重排：ddddocr +200MB 依赖按体积决策移除）：
      1. tiny-CNN（captcha_cnn，权重随应用打包）：毫秒级零依赖，4 位数字域；
      2. 视觉 LLM（llm_cfg 按次传入，用户在划词翻译设置配置）：多模态
         /chat/completions 识别，扛 tiny-CNN 分布外的花体/粘连字形。

    prefer_llm（2026-10-08 新增开关，默认 False）：为 True 时把两级次序
    倒过来（先 LLM 后 CNN）。背景是「默认次序下 LLM 几乎永不上场」——
    tiny-CNN 在真实站点样本上永远返回 4 位数字（500 张实测返回 None 0 次），
    而 4 位数字恒能通过 is_plausible_captcha_text 的格式闸门，故一级总是
    「成功」返回、二级无机会。实测同一批样本 all4 仅 0.37，即 63% 的错读
    被直接提交给了站点。想要识别率而非延迟的用户需要一条绕开 CNN 的路，
    这就是本开关；默认关闭以保住零依赖毫秒级的默认体验。

    次序倒转而非「跳过 CNN」：LLM 失败/不可信仍回落 CNN，最后才是 None
    （人工窗口）——偏好识别率的用户也不该因为 LLM 临时不可用而失去本地能力。

    任何异常（缺库/模型损坏/图片非法/结果不可信）都吞掉并返回 None：
    本模块是可选增强，绝不让识别失败破坏搜索/登录主链路。"""
    if not image_bytes:
        return None
    levels = (_LEVEL_LLM, _LEVEL_CNN) if prefer_llm else (_LEVEL_CNN, _LEVEL_LLM)
    for level in levels:
        text = _LEVELS[level](image_bytes, llm_cfg)
        if text:
            return text
    return None


def _recognize_level_cnn(image_bytes, llm_cfg):
    """第一级 tiny-CNN 识别（llm_cfg 本层不用，签名对齐便于统一调度）。"""
    try:
        if _cnn_available():
            raw = _load_cnn().recognize(image_bytes)
            # 必须 strip：合法性校验按 strip 后的长度判定，但提交给站点的是
            # 返回值本身——不 strip 就会把带空白的原值发过去，站点判题必失败
            # （与二级 LLM 路径的 str(...).strip() 同口径）。
            text = str(raw or '').strip()
            if text and is_plausible_captcha_text(text):
                return text
            if raw:
                logger.info('[kazumi] tiny-CNN 验证码结果不可信: %r', str(raw)[:16])
    except Exception as e:
        logger.warning('[kazumi] tiny-CNN 验证码识别异常: %s', e)
    return None


def _recognize_level_llm(image_bytes, llm_cfg):
    """第二级视觉 LLM 识别（配置门禁 + 合法性校验已在 _recognize_with_llm 内）。"""
    return _recognize_with_llm(image_bytes, llm_cfg)


_LEVEL_CNN = 'cnn'
_LEVEL_LLM = 'llm'
_LEVELS = {_LEVEL_CNN: _recognize_level_cnn, _LEVEL_LLM: _recognize_level_llm}
