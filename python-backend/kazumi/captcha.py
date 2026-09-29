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
    识别链两级（2026-09-29 重排，ddddocr 为主识别器）：① ddddocr（专为中文
    站点滑块/字符验证码训练，含自带 onnx 模型）；② 自研 tiny-CNN 兜底
    （captcha_cnn.py，numpy 纯推理，权重随应用打包，参考 animeko 小模型
    契约——机制可借鉴、其 AGPL 代码/模型不可搬），4 位数字 MacCMS 验证码。
    任何一级 import 失败或调用异常一律返回
    None——渲染层把 None 视为「未识别」，沿既有交互兜底：人工验证窗口
    （animeko InteractiveSolveDialog 对应位）。不阻塞登录/搜索主链路。

依赖策略：numpy / ddddocr（连带 onnxruntime、opencv-python）均进
requirements.txt 锁文件——2026-09-29 起真实站验证码为花体艺术字，自研合成
模型分布外全错、ddddocr 大部分直接命中，已升级为主识别器随 PyInstaller 打包
（增重约 200MB 换真实站可用性）。
"""
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

# 模块级懒加载缓存：None=尚未尝试，False=不可用，否则为识别器实例。
# 构造必须持锁串行（双检）：DdddOcr 构造装载 ~几十 MB 的 onnx 模型，重且慢，
# 并发调用若不加锁会同时构造多份；tried 只能在构造结束后置位，先置位会让
# 并发窗口内的其他线程拿到假 None 静默降级。
_ocr_holder = {'ocr': None, 'tried': False}
_ocr_lock = threading.Lock()


def _load_ocr():
    """懒加载 ddddocr 识别器（双检锁：构造在锁内完成，失败永久标记不可用）。

    GIL 只保证 dict 赋值原子，不保证「检查-构造-写回」复合操作的互斥，
    重依赖的懒加载必须显式加锁。"""
    ocr = _ocr_holder['ocr']
    if ocr is not None or _ocr_holder['tried']:
        return ocr if ocr else None
    with _ocr_lock:
        ocr = _ocr_holder['ocr']
        if ocr is not None or _ocr_holder['tried']:
            return ocr if ocr else None
        try:
            import ddddocr  # 可选依赖：未安装/无 onnxruntime 轮子时走降级路径
            ocr = ddddocr.DdddOcr(show_ad=False)
        except Exception as e:
            logger.info('[kazumi] ddddocr 不可用（验证码自动识别降级为手动输入）: %s', e)
            _ocr_holder['ocr'] = False
            _ocr_holder['tried'] = True
            return None
        _ocr_holder['ocr'] = ocr
        _ocr_holder['tried'] = True
        return ocr


def reset_ocr_cache():
    """重置识别器缓存（测试用：mock 注入后强制重新加载）。"""
    with _ocr_lock:
        _ocr_holder['ocr'] = None
        _ocr_holder['tried'] = False


def _load_cnn():
    """懒加载小模型模块（首次调用付 numpy import ~120ms，之后走模块缓存）。"""
    from . import captcha_cnn
    return captcha_cnn


def ocr_available():
    """当前进程是否具备自动识别能力（只探测，不识别）。

    两级识别链任一可用即为 True：ddddocr（主识别器）或自研小模型
    （权重随应用打包）。"""
    # _load_cnn() 会触发 import captcha_cnn → 顶部 import numpy：numpy 缺失
    # 时 ImportError 必须在本模块边界吞掉降级，不能从「只探测」的探测口溢出
    # （本模块契约：任何一级 import 失败一律降级）。
    try:
        if _load_cnn().model_available():
            return True
    except Exception as e:
        # 只吞加载类异常（ImportError 等）；探测路径正常情况不抛业务异常
        logger.info('[kazumi] 小模型探测不可用（降级 ddddocr 探测）: %s', e)
    return _load_ocr() is not None


def is_plausible_captcha_text(text):
    """识别结果合法性检查：3-8 位且以可见 ASCII 为主（验证码字符域）。

    空白/空串/超长噪声一律拒绝——自动识别的结果宁缺毋滥，错了要让用户
    多等一轮「提交失败→重输」，比直接降级手动输入更费时。"""
    t = str(text or '').strip()
    if not (_CAPTCHA_LEN_MIN <= len(t) <= _CAPTCHA_LEN_MAX):
        return False
    # 允许字母数字与常见符号；出现控制字符/大段空白视为噪声
    return all(32 < ord(ch) < 127 or ch.isalnum() for ch in t)


def recognize_captcha_bytes(image_bytes):
    """验证码图片字节 → 文本；无法识别返回 None（调用方降级手动输入）。

    两级识别链（2026-09-29 重排：真实站验证码是花体/斜体艺术字，自研
    合成模型分布外全错、ddddocr 大部分直接命中，见 roadmap B 节复盘）：
      1. ddddocr（优先）：专为中文站点字符验证码训练，模型内置在 pip 包，
         MIT 许可；PyInstaller 打包增重约 200MB（onnxruntime + opencv），
         换取真实站可用性。
      2. 自研 tiny-CNN（captcha_cnn，权重随应用打包）：数字域兜底，在
         ddddocr 结果不可信（3-8 位门槛拒绝）时尝试。

    任何异常（缺库/模型损坏/图片非法/结果不可信）都吞掉并返回 None：
    本模块是可选增强，绝不让识别失败破坏搜索/登录主链路。"""
    if not image_bytes:
        return None
    # 第一级：ddddocr
    ocr = _load_ocr()
    if ocr is not None:
        try:
            text = ocr.classification(bytes(image_bytes))
        except Exception as e:
            logger.warning('[kazumi] ddddocr 识别异常（继续小模型链）: %s', e)
            text = None
        text = str(text or '').strip()
        if is_plausible_captcha_text(text):
            return text
        if text:
            logger.info('[kazumi] ddddocr 结果不可信: %r', text[:16])
    # 第二级：自研小模型（4 位数字域兜底）
    try:
        text = _load_cnn().recognize(image_bytes)
        if text and is_plausible_captcha_text(text):
            return text
        if text:
            logger.info('[kazumi] 小模型验证码结果不可信: %r', str(text)[:16])
    except Exception as e:
        logger.warning('[kazumi] 小模型验证码识别异常: %s', e)
    return None
