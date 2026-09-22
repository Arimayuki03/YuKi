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
  - 本文件只做「识别一件事」：验证码图片字节 → 文本（recognize_captcha_bytes，
    预留接口，尚未挂载生产调用方）。
    优先用 ddddocr（专为中文站点滑块/字符验证码训练的轻量 OCR，含自带 onnx
    模型，无需额外模型文件），import 失败或调用异常一律返回 None——未来接入
    方把 None 视为「未识别」，渲染层沿既有交互兜底：展示验证码图给用户手动
    输入（animeko InteractiveSolveDialog 对应位）。不阻塞登录/搜索主链路。

依赖策略：ddddocr **不进 requirements.txt 锁文件**（本轮决策）：
  - ddddocr 依赖 onnxruntime，Python 3.14（本项目 venv 版本）无预编译轮子，
    pip 安装大概率失败，进锁文件会让 CI/全新构建直接红；
  - onnxruntime 体积 ~200MB，随应用 PyInstaller 打包会显著增大产物；
  - 因此定位为「开发者本机可选增强」：装得上就自动识别，装不上静默降级，
    用户仍走原有的验证窗口手动输入路径（该路径始终可用）。
"""
import logging
import threading

logger = logging.getLogger('yuki.kazumi.captcha')

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


def ocr_available():
    """当前进程是否具备自动识别能力（只探测，不识别）。"""
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

    预留接口，尚未挂载：当前无生产调用方（验证码主路径只做分类与手动输入
    兜底）。未来接入自动识别时按「识别失败降级手动」的约定调用。

    任何异常（缺库/模型损坏/图片非法/结果不可信）都吞掉并返回 None：
    本模块是可选增强，绝不让识别失败破坏搜索/登录主链路。"""
    if not image_bytes:
        return None
    ocr = _load_ocr()
    if ocr is None:
        return None
    try:
        text = ocr.classification(bytes(image_bytes))
    except Exception as e:
        logger.warning('[kazumi] 验证码识别失败（降级手动输入）: %s', e)
        return None
    text = str(text or '').strip()
    if not is_plausible_captcha_text(text):
        logger.info('[kazumi] 验证码识别结果不可信，降级手动输入: %r', text[:16])
        return None
    return text
