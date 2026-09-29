# -*- coding: utf-8 -*-
"""MacCMS 数字图片验证码 tiny-CNN 识别器（numpy 纯推理，无第三方深度学习依赖）。

参考 animeko（open-ani/ani）ImageCaptchaSolver 的「随应用交付小模型对验证码图
自动识别」思想（机制/模型契约可借鉴，其 AGPL-3.0 代码与 captcha-v1.0.onnx 模型
文件不可搬用——本模块为独立实现）：
  - 模型契约：灰度 32×96（H×W）→ 两层 stride-2 池化卷积（12/24 通道，3×3 核）→
    每列 4 个数字槽位 × 10 类（'0'-'9'）logits，对齐 MacCMS 4 位数字验证码；
  - 权重随应用打包（kazumi/assets/captcha_cnn.npz，约 2.9MB），无 onnxruntime
    / ddddocr 硬依赖，导入本模块即可用；
  - 训练脚本 tools/train_captcha_cnn.py（合成样本，源码树内，不随应用打包）。

推理链上层约定（captcha.py）：任何异常/权重缺失/输出不可信一律返回 None，
调用方降级 ddddocr 或人工窗口——本模块绝不让识别失败破坏搜索主链路。
"""
import logging
import os
import threading

import numpy as np

logger = logging.getLogger('yuki.kazumi.captcha_cnn')

# 模型输入几何（animeko captcha-v1.0.onnx 同款契约）：H=32, W=96
INPUT_H = 32
INPUT_W = 96
# 4 个数字槽位 × 10 类
SLOT_COUNT = 4
CLASS_COUNT = 10
DIGITS = '0123456789'

# 权重文件：随应用打包在 kazumi/assets；开发态与本模块同目录（kazumi/）相邻 assets/
_FILENAME = 'captcha_cnn.npz'

_holder = {'weights': None, 'tried': False}
_lock = threading.Lock()


def _weights_path():
    here = os.path.dirname(os.path.abspath(__file__))
    for base in (os.path.join(here, 'assets'), here):
        p = os.path.join(base, _FILENAME)
        if os.path.isfile(p):
            return p
    return ''


def _load_weights():
    """懒加载 npz 权重（双检锁；缺失/损坏永久标记不可用，行为同 ddddocr 降级口径）。

    holder 内以 False 作「不可用」哨兵（与 captcha.py _ocr_holder 同约定），
    对外返回一律归一为 None（`w if w else None`，同 captcha.py ddddocr 加载器
    口径）——曾因快速路径把 False 当成功泄漏，导致 model_available() 首次
    False 后永久 True、forward 在布尔值上取下标（'bool' object is not
    subscriptable）。"""
    w = _holder['weights']
    if w is not None or _holder['tried']:
        return w if w else None
    with _lock:
        w = _holder['weights']
        if w is not None or _holder['tried']:
            return w if w else None
        path = _weights_path()
        if not path:
            logger.info('[kazumi] 验证码小模型权重缺失，自动识别降级: %s', _FILENAME)
            _holder['weights'] = False
            _holder['tried'] = True
            return None
        try:
            with np.load(path) as data:
                w = {k: data[k] for k in data.files}
            for k in ('c1_w', 'c1_b', 'c2_w', 'c2_b', 'fc1_w', 'fc1_b', 'fc2_w', 'fc2_b'):
                if k not in w:
                    raise KeyError(f'missing weight key: {k}')
        except Exception as e:
            logger.warning('[kazumi] 验证码小模型加载失败（降级手动输入）: %s', e)
            _holder['weights'] = False
            _holder['tried'] = True
            return None
        _holder['weights'] = w
        _holder['tried'] = True
        return w


def reset_cache():
    """重置权重缓存（测试用）。"""
    with _lock:
        _holder['weights'] = None
        _holder['tried'] = False


def model_available():
    """当前进程是否具备小模型识别能力（只探测，不识别）。"""
    return _load_weights() is not None


def preprocess(image_bytes):
    """验证码图片字节 → float32 灰度张量 (1, 1, 32, 96)，值域 [0,1]。

    归一口径（与训练脚本 gen_sample 严格一致，训练/推理不一致是识别率
    天坑——2026-09-28 两侧重复反色曾把识别率打回随机水平）：
      1. PIL 解码（L 模式灰度，任何格式失败抛异常由上层吞掉降级）；
      2. 保持纵横比缩放到 32×96 画布，浅色（255=背景域）空白填充
         （数字多为瘦高字形，直接拉伸会破坏宽度特征）；
      3. 归一化后「浅底=1、深字=0」，不在此处反色——训练样本同样保持
         「浅底深字」原域，域语义两侧统一由同一份注释约束。
    """
    from PIL import Image
    import io
    img = Image.open(io.BytesIO(image_bytes)).convert('L')
    w, h = img.size
    if w <= 0 or h <= 0:
        raise ValueError('empty image')
    scale = min(INPUT_W / w, INPUT_H / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    img = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new('L', (INPUT_W, INPUT_H), 255)
    canvas.paste(img, ((INPUT_W - nw) // 2, (INPUT_H - nh) // 2))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    return arr.reshape(1, 1, INPUT_H, INPUT_W)


def _conv2d(x, w, b, stride=1):
    """合法 2D 卷积（无 padding）。x: (N,C,H,W), w: (F,C,KH,KW)。"""
    n, c, h, wd = x.shape
    f, _, kh, kw = w.shape
    oh = (h - kh) // stride + 1
    ow = (wd - kw) // stride + 1
    s = x.strides
    windows = np.lib.stride_tricks.as_strided(
        x, (n, c, oh, ow, kh, kw),
        (s[0], s[1], s[2] * stride, s[3] * stride, s[2], s[3]))
    out = np.einsum('nchwkl,fckl->nfhw', windows, w, optimize=True)
    return out + b.reshape(1, f, 1, 1)


def _relu(x):
    return np.maximum(x, 0.0)


def _pool2x2(x):
    """2×2 max-pool（尺寸为奇数时丢弃末行/列，训练推理同口径）。"""
    n, c, h, w = x.shape
    h2, w2 = h // 2, w // 2
    x = x[:, :, :h2 * 2, :w2 * 2]
    return x.reshape(n, c, h2, 2, w2, 2).max(axis=(3, 5))


def forward(image_bytes):
    """前向推理：图片字节 → 4 个槽位各自的 10 类 logits (4, 10)。

    结构（与训练脚本严格一致，改动任何一侧都必须同步另一侧并重新训练）：
      conv(1→12, 3×3, s1) → relu → pool2 → conv(12→24, 3×3, s1) → relu → pool2
      → flatten (24×6×22) → fc(3168→256) → relu → fc(256→40) → reshape (4, 10)
    """
    w = _load_weights()
    if not w:  # None/False 哨兵均视为不可用（防御哨兵泄漏）
        return None
    x = preprocess(image_bytes)
    x = _pool2x2(_relu(_conv2d(x, w['c1_w'], w['c1_b'])))          # (1,12,15,47)
    x = _pool2x2(_relu(_conv2d(x, w['c2_w'], w['c2_b'])))          # (1,24,6,22)
    x = x.reshape(1, -1)
    if x.shape[1] != w['fc1_w'].shape[1]:
        raise ValueError(f'flatten dim mismatch: {x.shape[1]} != {w["fc1_w"].shape[1]}')
    x = _relu(x @ w['fc1_w'].T + w['fc1_b'])
    logits = x @ w['fc2_w'].T + w['fc2_b']                          # (1, 40)
    return logits.reshape(SLOT_COUNT, CLASS_COUNT)


def recognize(image_bytes):
    """验证码图片字节 → 4 位数字文本；无法识别返回 None。

    任何异常（权重缺失/图片非法/维度不符）都吞掉返回 None——本识别器是
    可选增强的第一优先级，失败自动落到 ddddocr/人工路径。"""
    try:
        logits = forward(image_bytes)
        if logits is None:
            return None
        preds = logits.argmax(axis=1)  # (4,)
        return ''.join(DIGITS[i] for i in preds)
    except Exception as e:
        logger.warning('[kazumi] 小模型验证码识别失败（降级）: %s', e)
        return None
