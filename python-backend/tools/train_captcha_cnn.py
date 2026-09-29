# -*- coding: utf-8 -*-
"""训练 MacCMS 数字验证码 tiny-CNN 并导出 npz 权重（numpy 手写训练，无 torch）。

用法（开发机一次性，产物随应用打包）：
    python-backend/.venv/Scripts/python.exe python-backend/tools/train_captcha_cnn.py
        [--epochs 12] [--samples 24000] [--out python-backend/kazumi/assets/captcha_cnn.npz]

模型契约与 kazumi/captcha_cnn.py 严格一致（改动任何一侧必须同步另一侧并重训）：
  输入 (N,1,32,96) 浅底深字（样本与站点原始图同构，反色在 preprocess 统一做）；
  conv(1→12,3×3,s1)+relu+pool2 → conv(12→24,3×3,s1)+relu+pool2
  → flatten(24×6×22=3168) → fc(3168→256)+relu → fc(256→40) → reshape(4,10)。

训练数据完全合成：PIL 七段风格/多字体数字 + 随机平移旋转缩放 + 干扰线 +
椒盐噪声 + 亮度抖动；胜在分布可控、零人工标注。验收门槛：合成验证集上
单字符准确率 ≥94%、整图 4 位全对 ≥80%（solve_captcha 换图重试 ≤3 次，端到端成功率 ≈99%，残余失败回落人工窗口）。
"""
import argparse
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from kazumi import captcha_cnn  # noqa: E402  复用前向/卷积实现，保证训练推理同构

DIGITS = '0123456789'
INPUT_H, INPUT_W = captcha_cnn.INPUT_H, captcha_cnn.INPUT_W

# 背景色（浅色系，模拟站点浅底）与前景深色系；训练合成多样性即推理鲁棒性
_BG = [(255, 255, 255), (245, 245, 245), (240, 244, 248), (250, 240, 235), (235, 245, 235)]
# 前景深色系（真实站点笔画的深色分布：黑/深灰/棕/藏蓝/紫/墨绿），
# 贴布前按 Rec.601 转 L 灰度（0.299R+0.587G+0.114B）——画布是 L 模式
_FG = [(20, 20, 20), (40, 40, 45), (60, 30, 20), (20, 50, 80), (50, 20, 70), (10, 80, 40)]

_FONT_DIRS = [
    r'C:\Windows\Fonts',
    '/usr/share/fonts/truetype/dejavu',
    '/System/Library/Fonts',
]
_FONT_CANDIDATES = [
    'arial.ttf', 'arialbd.ttf', 'calibri.ttf', 'candara.ttf', 'comic.ttf',
    'consola.ttf', 'cour.ttf', 'georgia.ttf', 'impact.ttf', 'segoeui.ttf',
    'segoeuib.ttf', 'tahoma.ttf', 'times.ttf', 'timesbd.ttf', 'verdana.ttf',
    'verdanab.ttf', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf',
]


def _load_fonts():
    fonts = []
    for d in _FONT_DIRS:
        if not os.path.isdir(d):
            continue
        for name in _FONT_CANDIDATES:
            p = os.path.join(d, name)
            if os.path.isfile(p):
                fonts.append(p)
    return fonts or [None]


def _digit_image(ch, font_path, fg, pad=6):
    """单个数字渲染成紧凑灰度图（L 模式，白底黑字），后续统一缩放贴布。"""
    size = 28
    if font_path:
        font = ImageFont.truetype(font_path, size)
    else:
        try:
            from PIL import ImageFont as IF
            font = IF.load_default(size=size)
        except Exception:
            font = ImageFont.load_default()
    img = Image.new('L', (size * 2, size * 2), 255)
    d = ImageDraw.Draw(img)
    d.text((size // 2, size // 2), ch, fill=0, font=font)
    bbox = img.point(lambda v: 255 - v).getbbox()  # 非空白区域
    if bbox:
        img = img.crop(bbox)
    # 注：原此处有一行 `img.point(lambda v: v if v < 255 else 255)`，
    # 恒等映射（no-op，任何 <255 保持原值、255 保持 255），已删除。
    return img, fg


def _place_digit(canvas, digit_img, fg, cx, cy, angle, scale, shear=0.0, stretch_x=1.0):
    """旋转/斜切/水平拉伸后以 (cx,cy) 为中心贴到画布上（乘前景色，保背景）。

    shear 斜切 + stretch_x 水平拉伸对齐真实站点的花体/斜体艺术字
    （如 2kdm 系的 ∞ 形 0、斜体 2——2026-09-29 实测真实分布在此）。
    变换顺序：resize → shear → rotate，expand 防裁切。"""
    w, h = digit_img.size
    nw, nh = max(1, int(w * scale * stretch_x)), max(1, int(h * scale))
    img = digit_img.resize((nw, nh), Image.BILINEAR)
    if abs(shear) > 1e-3:
        # AFFINE (a,b,c,d,e,f): x' = a*x + b*y + c；斜切沿 y 方向平移 x
        img = img.transform(
            (nw + int(abs(shear) * nh) + 1, nh), Image.AFFINE,
            (1.0, shear, -shear * nh if shear > 0 else 0.0, 0.0, 1.0, 0.0),
            resample=Image.BILINEAR, fillcolor=255)
    img = img.rotate(angle, expand=True, resample=Image.BILINEAR, fillcolor=255)
    w, h = img.size
    mask = img.point(lambda v: max(0, 255 - v))  # 笔画为白
    # 先算好落点再取回退内容：crop 必须与 paste 同一块区域，否则相邻数字
    # 重叠时后贴数字会用画布左上角 (0,0) 的背景覆盖先前数字的笔画。
    # PIL crop 越界坐标合法（超出部分补黑），paste 负坐标自动裁剪，尺寸不受影响。
    x = int(cx - w / 2)
    y = int(cy - h / 2)
    color = Image.new('L', (w, h), int(fg))
    layer = Image.composite(color, canvas.crop((x, y, x + w, y + h)), mask)
    canvas.paste(layer, (x, y))
    return canvas


def _noise_lines(draw, w, h, rng):
    # 干扰线是弱增强：1-2 条浅色细线（重干扰线会把 8/3、1/7 的判别笔画淹没）
    for _ in range(int(rng.integers(1, 3))):
        x1, y1 = float(rng.uniform(0, w)), float(rng.uniform(0, h))
        x2, y2 = float(rng.uniform(0, w)), float(rng.uniform(0, h))
        gray = int(rng.integers(170, 230))
        draw.line((x1, y1, x2, y2), fill=gray, width=1)


def _salt_pepper(arr, rng, amount=0.02):
    n = max(1, int(arr.size * amount))
    idx = rng.integers(0, arr.size, size=n)
    flat = arr.reshape(-1)
    flat[idx] = rng.random(n)
    return arr


def gen_sample(text, fonts, rng):
    """合成一张 32×96 的 4 位数字验证码 → float32 反色张量 (1,32,96)。"""
    w, h = INPUT_W, INPUT_H
    bg = _BG[int(rng.integers(0, len(_BG)))]
    canvas = Image.new('L', (w, h), int(sum(bg) / 3))
    d = ImageDraw.Draw(canvas)
    # 背景纹理：随机浅色小方格
    for _ in range(int(rng.integers(0, 30))):
        x, y = float(rng.uniform(0, w)), float(rng.uniform(0, h))
        s = float(rng.uniform(1, 4))
        d.rectangle((x, y, x + s, y + s), fill=int(rng.integers(150, 230)))
    _noise_lines(d, w, h, rng)
    # 4 位数字：中心间隔均匀，带随机抖动/旋转/缩放/斜切/水平拉伸。
    # 花体/斜体是真实站点（2kdm 系）的常态分布：±22° 大角度 + ±0.45 斜切
    # + 0.8~1.35 水平拉伸，覆盖 ∞ 形 0、斜体 2/3 等艺术字形。
    step = w / 5.0
    for i, ch in enumerate(text):
        font_path = fonts[int(rng.integers(0, len(fonts)))] if fonts else None
        # 前景从深色调色板取色再转 L 灰度（原来只用 0~199 灰度随机，
        # _FG 定义了却从未参与合成）
        fg_rgb = _FG[int(rng.integers(0, len(_FG)))]
        fg = int(0.299 * fg_rgb[0] + 0.587 * fg_rgb[1] + 0.114 * fg_rgb[2])
        digit_img, fg = _digit_image(ch, font_path, fg)
        angle = float(rng.uniform(-22, 22))
        scale = float(rng.uniform(0.72, 1.0))
        shear = float(rng.uniform(-0.45, 0.45))
        stretch_x = float(rng.uniform(0.8, 1.35))
        cx = step * (i + 1) + float(rng.uniform(-4, 4))
        cy = h / 2.0 + float(rng.uniform(-3, 3))
        _place_digit(canvas, digit_img, fg, cx, cy, angle, scale,
                     shear=shear, stretch_x=stretch_x)
    if rng.random() < 0.5:
        canvas = canvas.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.3, 0.8))))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    # 样本保持「浅底深字」（与站点原始图同构），反色统一由推理侧 preprocess
    # 完成（1=笔画、0=背景）——两侧重复反色是识别率天坑（2026-09-28 实证）。
    arr = _salt_pepper(arr, rng, float(rng.uniform(0.003, 0.012)))
    return arr.reshape(1, INPUT_H, INPUT_W)


def gen_batch(n, rng, fonts):
    xs = np.zeros((n, 1, INPUT_H, INPUT_W), dtype=np.float32)
    ys = np.zeros((n, captcha_cnn.SLOT_COUNT), dtype=np.int64)
    for i in range(n):
        text = ''.join(DIGITS[j] for j in rng.integers(0, 10, size=4))
        xs[i] = gen_sample(text, fonts, rng)
        ys[i] = [int(c) for c in text]
    return xs, ys


# ---------------------------------------------------------------- numpy 训练

def _softmax_ce(logits, labels):
    """softmax 交叉熵 + 梯度（logits: (N,4,10), labels: (N,4)）。"""
    n = logits.shape[0]
    m = logits.max(axis=2, keepdims=True)
    e = np.exp(logits - m)
    p = e / e.sum(axis=2, keepdims=True)
    truth = np.take_along_axis(p, labels[:, :, None], axis=2)  # (N,4,1)
    loss = -np.log(truth + 1e-9).mean()
    d = p.copy()
    np.put_along_axis(d, labels[:, :, None], np.take_along_axis(d, labels[:, :, None], axis=2) - 1.0, axis=2)
    # loss 对 N*SLOT 个元素求均值，梯度必须除同一个数（不是 N——那会大 SLOT 倍）
    return loss, d / labels.size


def _conv_backward(dout, x, w, stride=1):
    n, c, h, wd = x.shape
    f, _, kh, kw = w.shape
    _, _, oh, ow = dout.shape
    dx = np.zeros_like(x)
    dw = np.zeros_like(w)
    s = x.strides
    windows = np.lib.stride_tricks.as_strided(
        x, (n, c, oh, ow, kh, kw),
        (s[0], s[1], s[2] * stride, s[3] * stride, s[2], s[3]))
    dw += np.einsum('nchwkl,nfhw->fckl', windows, dout, optimize=True)
    # 每个输出位置对应输入窗口：(C*KL, F) @ (F, N*OH*OW) → 逐位置窗口梯度
    w_flat = w.reshape(f, -1)                      # (F, C*KL)
    dflat = dout.transpose(0, 2, 3, 1).reshape(-1, f)  # (N*OH*OW, F)
    win_grad = (dflat @ w_flat).reshape(n, oh, ow, c, kh, kw)
    win_grad = win_grad.transpose(0, 3, 1, 2, 4, 5)    # (N,C,OH,OW,KH,KW)
    for i in range(kh):
        for j in range(kw):
            dx[:, :, i:i + oh * stride:stride, j:j + ow * stride:stride] += win_grad[:, :, :, :, i, j]
    return dx, dw


def train(epochs, samples_per_epoch, batch_size, lr, out_path, seed):
    rng = np.random.default_rng(seed)
    fonts = _load_fonts()
    print(f'fonts: {len(fonts)}')
    # 验证集固定（8k 样本），训练集每 epoch 重采样
    vx, vy = gen_batch(4000, rng, fonts)

    # He 初始化
    params = {
        'c1_w': (rng.standard_normal((12, 1, 3, 3)) * np.sqrt(2 / 9)).astype(np.float32),
        'c1_b': np.zeros(12, dtype=np.float32),
        'c2_w': (rng.standard_normal((24, 12, 3, 3)) * np.sqrt(2 / 108)).astype(np.float32),
        'c2_b': np.zeros(24, dtype=np.float32),
        'fc1_w': (rng.standard_normal((256, 3168)) * np.sqrt(2 / 3168)).astype(np.float32),
        'fc1_b': np.zeros(256, dtype=np.float32),
        'fc2_w': (rng.standard_normal((40, 256)) * np.sqrt(2 / 256)).astype(np.float32),
        'fc2_b': np.zeros(40, dtype=np.float32),
    }

    def forward_all(x):
        z1 = captcha_cnn._conv2d(x, params['c1_w'], params['c1_b'])
        a1 = captcha_cnn._relu(z1)
        p1 = captcha_cnn._pool2x2(a1)
        z2 = captcha_cnn._conv2d(p1, params['c2_w'], params['c2_b'])
        a2 = captcha_cnn._relu(z2)
        p2 = captcha_cnn._pool2x2(a2)
        flat = p2.reshape(x.shape[0], -1)
        z3 = flat @ params['fc1_w'].T + params['fc1_b']
        a3 = captcha_cnn._relu(z3)
        logits = (a3 @ params['fc2_w'].T + params['fc2_b']).reshape(x.shape[0], 4, 10)
        cache = (x, z1, a1, p1, z2, a2, p2, flat, z3, a3)
        return logits, cache

    def evaluate(n=4000):
        correct_char, correct_all = 0, 0
        for s in range(0, n, 500):
            xb, yb = vx[s:s + 500], vy[s:s + 500]
            logits, _ = forward_all(xb)
            pred = logits.argmax(axis=2)
            correct_char += int((pred == yb).sum())
            correct_all += int((pred == yb).all(axis=1).sum())
        total = n * 4
        return correct_char / total, correct_all / n

    best_all = 0.0
    for epoch in range(1, epochs + 1):
        t0 = time.time()
        # 余弦退火（合成任务在线采样，前期大 lr 快收敛、后期细调）
        ep_lr = lr * (0.5 * (1 + np.cos(np.pi * (epoch - 1) / max(1, epochs)))) + lr * 0.02
        loss_sum, steps = 0.0, 0
        order = rng.permutation(samples_per_epoch)
        for s in range(0, samples_per_epoch, batch_size):
            n = min(batch_size, samples_per_epoch - s)
            idx = order[s:s + n]
            # 每批独立采样（在线合成：见过的图永不重复，天然无限数据集）
            xb, yb = gen_batch(n, rng, fonts)
            logits, cache = forward_all(xb)
            loss, dlogits = _softmax_ce(logits, yb)
            loss_sum += loss * n
            steps += n
            x, z1, a1, p1, z2, a2, p2, flat, z3, a3 = cache

            # fc2
            d_fc2w = dlogits.reshape(n, -1).T @ a3
            d_fc2b = dlogits.reshape(n, -1).sum(axis=0)
            da3 = dlogits.reshape(n, -1) @ params['fc2_w']
            dz3 = da3 * (z3 > 0)
            # fc1
            d_fc1w = dz3.T @ flat
            d_fc1b = dz3.sum(axis=0)
            dflat = dz3 @ params['fc1_w']
            dp2 = dflat.reshape(p2.shape)
            # pool2 反传：max 位置回传
            n_, c_, h_, w_ = p2.shape
            a2_ = a2[:, :, :h_ * 2, :w_ * 2].reshape(n_, c_, h_, 2, w_, 2)
            mask2 = (a2_ == a2_.max(axis=(3, 5), keepdims=True))
            da2 = np.zeros_like(a2[:, :, :h_ * 2, :w_ * 2])
            da2 += (dp2[:, :, :, None, :, None] * mask2).reshape(da2.shape)
            da2_full = np.zeros_like(a2)
            da2_full[:, :, :h_ * 2, :w_ * 2] = da2
            dz2 = da2_full * (z2 > 0)
            # conv2（_conv_backward 返回 (d输入, d权重)，一次调用双取）
            dp1, d_c2w = _conv_backward(dz2, p1, params['c2_w'])
            d_c2b = dz2.sum(axis=(0, 2, 3))
            # pool1 反传
            n_, c_, h_, w_ = p1.shape
            a1_ = a1[:, :, :h_ * 2, :w_ * 2].reshape(n_, c_, h_, 2, w_, 2)
            mask1 = (a1_ == a1_.max(axis=(3, 5), keepdims=True))
            da1 = np.zeros_like(a1[:, :, :h_ * 2, :w_ * 2])
            da1 += (dp1[:, :, :, None, :, None] * mask1).reshape(da1.shape)
            da1_full = np.zeros_like(a1)
            da1_full[:, :, :h_ * 2, :w_ * 2] = da1
            dz1 = da1_full * (z1 > 0)
            # conv1（同上：返回 (d输入, d权重)，已是单次调用；d输入无消费方故弃）
            _, d_c1w = _conv_backward(dz1, x, params['c1_w'])
            d_c1b = dz1.sum(axis=(0, 2, 3))

            grads = {'c1_w': d_c1w, 'c1_b': d_c1b, 'c2_w': d_c2w, 'c2_b': d_c2b,
                     'fc1_w': d_fc1w, 'fc1_b': d_fc1b, 'fc2_w': d_fc2w, 'fc2_b': d_fc2b}
            for k in params:
                params[k] = (params[k] - ep_lr * grads[k]).astype(np.float32)

        char_acc, all_acc = evaluate()
        print(f'epoch {epoch:2d}/{epochs}  loss {loss_sum / max(steps, 1):.4f}  '
              f'char {char_acc:.4f}  all4 {all_acc:.4f}  lr {ep_lr:.5f}  {time.time() - t0:.0f}s')
        if all_acc > best_all:
            best_all = all_acc
            np.savez_compressed(out_path, **params)
            print(f'  saved -> {out_path}')
    char_acc, all_acc = evaluate()
    print(f'FINAL char {char_acc:.4f}  all4 {all_acc:.4f}  (best all4 {best_all:.4f})')
    return char_acc, all_acc


def _selfcheck():
    """不落盘快速自检（不训练）：小画布两数字重叠，断言先前笔画不被后贴
    数字的回退背景覆盖（2026-09-29 crop 错位回归锁）；负坐标落点不抛异常；
    gen_sample 输出形状/值域正确。"""
    canvas = Image.new('L', (40, 20), 255)
    # 数字 A：整块笔画（全黑 10×10），中心 (18,10) → 覆盖 x13..22
    a = Image.new('L', (10, 10), 0)
    _place_digit(canvas, a, 0, 18, 10, angle=0, scale=1.0)
    # 数字 B：左半透明（mask=0 走回退路径）、右半笔画，中心 (21,10) → 覆盖
    # x16..25，其中 x16..20 的回退区压在 A 的笔画上
    b = Image.new('L', (10, 10), 255)
    for px in range(5, 10):
        for py in range(10):
            b.putpixel((px, py), 0)
    _place_digit(canvas, b, 0, 21, 10, angle=0, scale=1.0)
    # 修复前：B 的回退内容取画布左上角 (0,0) 背景，A 的笔画被擦成 255；
    # 修复后：回退内容取 B 落点处画布，A 笔画保持 0
    assert all(canvas.getpixel((x, 10)) == 0 for x in range(16, 21)), \
        'overlap regression: previous digit strokes erased by later paste'
    assert all(canvas.getpixel((x, 10)) == 0 for x in range(21, 26)), \
        'later digit stroke missing'
    # 负坐标落点：crop 越界补黑 / paste 自动裁剪，不得抛异常
    c = Image.new('L', (30, 30), 255)
    _place_digit(c, a, 0, 2, 3, angle=0, scale=1.0)
    assert c.getpixel((2, 3)) == 0, 'negative-coordinate paste failed'
    # gen_sample 基本形状与值域
    arr = gen_sample('0123', [None], np.random.default_rng(0))
    assert arr.shape == (1, INPUT_H, INPUT_W) and arr.dtype == np.float32
    assert float(arr.min()) >= 0.0 and float(arr.max()) <= 1.0
    print('selfcheck OK: overlap preserved / negative paste ok / gen_sample shape ok')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--epochs', type=int, default=25)
    ap.add_argument('--samples', type=int, default=20000, help='训练样本/epoch（验证集固定 4k）')
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--lr', type=float, default=0.02)
    ap.add_argument('--seed', type=int, default=20260928)
    ap.add_argument('--out', default=os.path.join(BACKEND, 'kazumi', 'assets', 'captcha_cnn.npz'))
    ap.add_argument('--selfcheck', action='store_true',
                    help='运行不落盘快速自检（重叠回归 + gen_sample 形状），不训练')
    args = ap.parse_args()
    if args.selfcheck:
        _selfcheck()
        return
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    char_acc, all_acc = train(args.epochs, args.samples, args.batch, args.lr, args.out, args.seed)
    # 门槛校准（2026-09-28 实训）：单图 4 位全对 ≥0.80 即可用——solve_captcha 对
    # 同一源换图重试 ≤3 次，端到端成功率 ≈ 1-(1-0.81)^3 ≈ 99.3%，残余失败自动
    # 回落人工验证窗口（设计内降级，见 docs/ANTIVIRUS_AND_ROADMAP.md B 节）。
    if char_acc < 0.94 or all_acc < 0.80:
        print('BELOW THRESHOLD (char>=0.94 all4>=0.80)', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
