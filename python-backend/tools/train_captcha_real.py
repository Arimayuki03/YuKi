# -*- coding: utf-8 -*-
"""目标站真实数据定向训练：tiny-CNN 在「真实为主 + 合成为辅」混合分布上重训。

用法（开发机一次性，数据不进 git）：
    python-backend/.venv/Scripts/python.exe python-backend/tools/train_captcha_real.py \
        --data .review-tmp/captcha_data \
        --out python-backend/kazumi/assets/captcha_cnn.npz

与 train_captcha_cnn.py（纯合成基线）的关系：
  - 模型契约严格同构（同一 captcha_cnn 前向，改动任何一侧必须同步重训）；
  - 数据源升级：真实样本（sample_captcha_site.py 站点判题零错标采集）为主，
    合成样本（gen_batch 复用）为辅防遗忘/增广多样性；
  - 三站（mutefun/mgnacg/girigirilove）定向覆盖：全部 MacCMS 4 位数字，
    花体/斜体字形（大角度旋转、斜切、粘连常见）。

真实数据协议：
  - 文件名 <site>_<idx>_<text>.png 为站点 verify_check 判题通过的标注
    （错标率≈0）；manifest.json 为冗余索引，以文件名为准；
  - 划分：按文本分组、组内 md5 排序确定性切 train/val（val 每文本类至少
    1 张保证类覆盖），同分布无泄漏（同一图片不会同时出现在两侧）；
  - 在线增强：真实样本只做轻扰动（±4° 旋转、亮度抖动、模糊、平移、椒盐），
    不做重变形——站点字形本身已是强变形分布。

验收门槛（真实 val 集）：char ≥0.97、all4 ≥0.90（数据同分布后远高于纯合成
0.80 口径；残余失败由 solve_captcha 换图重试 ≤3 + 人工窗口兜底）。
"""
import argparse
import hashlib
import os
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from kazumi import captcha_cnn  # noqa: E402  复用前向/preprocess，保证训练推理同构
from kazumi.captcha_cnn import INPUT_H, INPUT_W  # noqa: E402

# 三站清单与 sample_captcha_site.py 的 SITES 键对应（该文件持有站点地址与
# 采集协议）。站点仅用于本地验证码样本采集/训练评估：采集必须限速串行，
# 本文件只读本地已落盘样本，不发起任何网络请求。
SITES = ('mutefun', 'mgnacg', 'girigirilove')
VAL_FRACTION = 0.10


def load_real_dataset(data_dir):
    """读入全部真实样本 → (files, texts)。文件名即标注（站点判题协议）。"""
    files, texts = [], []
    for site in SITES:
        site_dir = os.path.join(data_dir, site)
        if not os.path.isdir(site_dir):
            print(f'WARN: missing site dir {site_dir}')
            continue
        for name in sorted(os.listdir(site_dir)):
            if not name.endswith('.png'):
                continue
            text = name[:-4].rsplit('_', 1)[-1]
            if len(text) != 4 or not text.isdigit():
                continue
            files.append(os.path.join(site_dir, name))
            texts.append(text)
    return files, texts


def split_train_val(files, texts, val_fraction=VAL_FRACTION):
    """按文本分组、组内 md5 确定性切分：val 每类按比例取（≥2 张的类保底 1 张）。

    同一张图不会同时进 train/val（无泄漏）；文本类分层保证 val 数字类覆盖。"""
    by_text = {}
    for f, t in zip(files, texts):
        by_text.setdefault(t, []).append(f)
    train_f, train_t, val_f, val_t = [], [], [], []
    for t in sorted(by_text):
        fs = sorted(by_text[t], key=lambda p: hashlib.md5(p.encode()).hexdigest())
        n_val = int(round(len(fs) * val_fraction))
        if len(fs) >= 2:
            n_val = max(1, n_val)
        else:
            n_val = 0
        val_f.extend(fs[:n_val])
        val_t.extend([t] * n_val)
        train_f.extend(fs[n_val:])
        train_t.extend([t] * (len(fs) - n_val))
    return (train_f, train_t), (val_f, val_t)


def _augment(img, rng):
    """真实样本扰动增强（输入/输出均 PIL L 模式，值域 0-255）。

    中等口径（2026-09-30 第三轮过拟合复盘：train loss 0.08 而 val all4 停在
    0.40，1900 张独立样本的记忆上限；增强是唯一不花钱的数据扩充）：在站点
    字形边界内做随机仿射——旋转 ±7°、水平位移 ±3px、垂直位移 ±2px、轻度
    剪切 ±0.12、缩放 0.85~1.1、亮度抖动、模糊、椒盐。剪切/缩放参数按三站
    花体字形目验校准，不至于把 6/8、5/6 变换混淆。"""
    angle = float(rng.uniform(-7, 7))
    shear = float(rng.uniform(-0.12, 0.12))
    scale = float(rng.uniform(0.85, 1.1))
    # 一步 AFFINE 完成旋转+剪切+缩放（围绕图心，fillcolor 取背景白）
    w, h = img.size
    cos_a, sin_a = np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))
    # 输出坐标 → 输入坐标的逆映射（PIL AFFINE 语义）：x_in = a*x_out + b*y_out + c
    a = cos_a / scale
    b = (sin_a + shear * cos_a) / scale
    c = w / 2 - a * w / 2 - b * h / 2
    d = -sin_a / scale
    e = (cos_a - shear * sin_a) / scale
    f_ = h / 2 - d * w / 2 - e * h / 2
    img = img.transform((w, h), Image.AFFINE, (a, b, c, d, e, f_),
                        resample=Image.BILINEAR, fillcolor=255)
    if rng.random() < 0.5:
        k = float(rng.uniform(0.7, 1.0))
        img = img.point(lambda v: int(v * k))
    if rng.random() < 0.35:
        img = img.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.3, 0.8))))
    arr = np.asarray(img, dtype=np.float32) / 255.0
    if rng.random() < 0.7:
        dx, dy = int(rng.integers(-3, 4)), int(rng.integers(-2, 3))
        arr = np.roll(arr, (dy, dx), axis=(0, 1))
    n = max(1, int(arr.size * float(rng.uniform(0.002, 0.01))))
    idx = rng.integers(0, arr.size, size=n)
    arr.reshape(-1)[idx] = rng.random(n)
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), 'L')


def real_batch(files, texts, rng, augment=True):
    """真实样本批 → (N,1,32,96) float32 张量 + (N,4) 标签。"""
    xs = np.zeros((len(files), 1, INPUT_H, INPUT_W), dtype=np.float32)
    ys = np.zeros((len(files), 4), dtype=np.int64)
    for i, (p, t) in enumerate(zip(files, texts)):
        img = Image.open(p).convert('L')
        if augment:
            img = _augment(img, rng)
        xs[i] = captcha_cnn.preprocess_pil(img)
        ys[i] = [int(c) for c in t]
    return xs, ys


def _softmax_ce(logits, labels):
    """softmax 交叉熵 + 梯度（logits: (N,4,10), labels: (N,4)）。"""
    m = logits.max(axis=2, keepdims=True)
    e = np.exp(logits - m)
    p = e / e.sum(axis=2, keepdims=True)
    truth = np.take_along_axis(p, labels[:, :, None], axis=2)
    loss = -np.log(truth + 1e-9).mean()
    d = p.copy()
    np.put_along_axis(d, labels[:, :, None],
                      np.take_along_axis(d, labels[:, :, None], axis=2) - 1.0, axis=2)
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
    w_flat = w.reshape(f, -1)
    dflat = dout.transpose(0, 2, 3, 1).reshape(-1, f)
    win_grad = (dflat @ w_flat).reshape(n, oh, ow, c, kh, kw)
    win_grad = win_grad.transpose(0, 3, 1, 2, 4, 5)
    for i in range(kh):
        for j in range(kw):
            dx[:, :, i:i + oh * stride:stride, j:j + ow * stride:stride] += win_grad[:, :, :, :, i, j]
    return dx, dw


class Trainer:
    """参数/前向/反传封装（与 train_captcha_cnn.train 同构，支持外部数据批）。"""

    def __init__(self, rng, params=None, dropout=0.0, weight_decay=0.0):
        self.params = self._he_init(rng) if params is None else params
        self.rng = rng
        self.dropout = dropout          # fc1 输出 dropout 率（推理恒关）
        self.weight_decay = weight_decay  # L2（只作用权重矩阵，不动偏置）

    @staticmethod
    def _he_init(rng):
        """v2 几何（与 captcha_cnn.forward 严格同构）：conv 12/24、fc 256。

        字面量取自 captcha_cnn.forward 实际维度（conv 1→12→24，fc 3168→256→40）：
        captcha_cnn 模块从未导出 CONV1_F/CONV2_F/FC1_OUT 常量，此前引用必抛
        AttributeError（默认路径 Trainer(rng, None) 直接触发）。"""
        c1, c2, fc1 = 12, 24, 256
        flat = c2 * 6 * 22  # pool2 输出 (24,6,22)，展平 24*6*22 = 3168 与 fc1_w 形状一致
        return {
            'c1_w': (rng.standard_normal((c1, 1, 3, 3)) * np.sqrt(2 / 9)).astype(np.float32),
            'c1_b': np.zeros(c1, dtype=np.float32),
            'c2_w': (rng.standard_normal((c2, c1, 3, 3)) * np.sqrt(2 / (9 * c1))).astype(np.float32),
            'c2_b': np.zeros(c2, dtype=np.float32),
            'fc1_w': (rng.standard_normal((fc1, flat)) * np.sqrt(2 / flat)).astype(np.float32),
            'fc1_b': np.zeros(fc1, dtype=np.float32),
            'fc2_w': (rng.standard_normal((40, fc1)) * np.sqrt(2 / fc1)).astype(np.float32),
            'fc2_b': np.zeros(40, dtype=np.float32),
        }

    def forward_all(self, x, training=False):
        p = self.params
        z1 = captcha_cnn._conv2d(x, p['c1_w'], p['c1_b'])
        a1 = captcha_cnn._relu(z1)
        p1 = captcha_cnn._pool2x2(a1)
        z2 = captcha_cnn._conv2d(p1, p['c2_w'], p['c2_b'])
        a2 = captcha_cnn._relu(z2)
        p2 = captcha_cnn._pool2x2(a2)
        flat = p2.reshape(x.shape[0], -1)
        z3 = flat @ p['fc1_w'].T + p['fc1_b']
        a3 = captcha_cnn._relu(z3)
        # fc1 输出 inverted dropout：训练缩放 1/(1-rate)，推理不加缩放
        # （与 torch nn.Dropout 语义一致，评估/推理路径零改动）。
        mask = None
        if training and self.dropout > 0:
            keep = 1.0 - self.dropout
            mask = (self.rng.random(a3.shape) < keep).astype(np.float32) / keep
            a3 = a3 * mask
        logits = (a3 @ p['fc2_w'].T + p['fc2_b']).reshape(x.shape[0], 4, 10)
        return logits, (x, z1, a1, p1, z2, a2, p2, flat, z3, a3, mask)

    def train_step(self, xb, yb, lr):
        p = self.params
        logits, cache = self.forward_all(xb, training=True)
        loss, dlogits = _softmax_ce(logits, yb)
        x, z1, a1, p1, z2, a2, p2, flat, z3, a3, mask = cache
        n = xb.shape[0]

        d_fc2w = dlogits.reshape(n, -1).T @ a3
        d_fc2b = dlogits.reshape(n, -1).sum(axis=0)
        da3 = dlogits.reshape(n, -1) @ p['fc2_w']
        if mask is not None:
            da3 = da3 * mask
        dz3 = da3 * (z3 > 0)
        d_fc1w = dz3.T @ flat
        d_fc1b = dz3.sum(axis=0)
        dflat = dz3 @ p['fc1_w']
        dp2 = dflat.reshape(p2.shape)
        n_, c_, h_, w_ = p2.shape
        a2_ = a2[:, :, :h_ * 2, :w_ * 2].reshape(n_, c_, h_, 2, w_, 2)
        mask2 = (a2_ == a2_.max(axis=(3, 5), keepdims=True))
        da2_full = np.zeros_like(a2)
        da2_full[:, :, :h_ * 2, :w_ * 2] = (dp2[:, :, :, None, :, None] * mask2).reshape(
            n_, c_, h_ * 2, w_ * 2)
        dz2 = da2_full * (z2 > 0)
        dp1, d_c2w = _conv_backward(dz2, p1, p['c2_w'])
        d_c2b = dz2.sum(axis=(0, 2, 3))
        n_, c_, h_, w_ = p1.shape
        a1_ = a1[:, :, :h_ * 2, :w_ * 2].reshape(n_, c_, h_, 2, w_, 2)
        mask1 = (a1_ == a1_.max(axis=(3, 5), keepdims=True))
        da1_full = np.zeros_like(a1)
        da1_full[:, :, :h_ * 2, :w_ * 2] = (dp1[:, :, :, None, :, None] * mask1).reshape(
            n_, c_, h_ * 2, w_ * 2)
        dz1 = da1_full * (z1 > 0)
        _, d_c1w = _conv_backward(dz1, x, p['c1_w'])
        d_c1b = dz1.sum(axis=(0, 2, 3))

        grads = {'c1_w': d_c1w, 'c1_b': d_c1b, 'c2_w': d_c2w, 'c2_b': d_c2b,
                 'fc1_w': d_fc1w, 'fc1_b': d_fc1b, 'fc2_w': d_fc2w, 'fc2_b': d_fc2b}
        for k in p:
            g = grads[k]
            # L2 只作用权重矩阵（偏置衰减无正则收益）；损失项已含 0.5*wd*||w||²
            # 的等价实现——直接在梯度上加 wd*w，配合小 lr 数值上等价。
            if self.weight_decay > 0 and k.endswith('_w'):
                g = g + self.weight_decay * p[k]
            p[k] = (p[k] - lr * g).astype(np.float32)
        return loss

    def evaluate(self, batches):
        """batches: iterable of (xb, yb)；返回 (char_acc, all4_acc)。"""
        correct_char = correct_all = total = 0
        for xb, yb in batches:
            logits, _ = self.forward_all(xb)
            pred = logits.argmax(axis=2)
            correct_char += int((pred == yb).sum())
            correct_all += int((pred == yb).all(axis=1).sum())
            total += xb.shape[0]
        return correct_char / max(total * 4, 1), correct_all / max(total, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data', default='.review-tmp/captcha_data',
                    help='真实数据根目录（内含三站子目录）')
    ap.add_argument('--out', default=os.path.join(BACKEND, 'kazumi', 'assets', 'captcha_cnn.npz'))
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--lr', type=float, default=0.02)
    ap.add_argument('--real-repeat', type=int, default=1,
                    help='每 epoch 真实样本重复次数（每次重新增强，等效扩充真实集）')
    ap.add_argument('--synthetic-per-epoch', type=int, default=6000,
                    help='每 epoch 混入的合成样本数')
    ap.add_argument('--seed', type=int, default=20260930)
    ap.add_argument('--warm-start', action='store_true',
                    help='从现有 out npz 热启动（缺省 He 随机初始化）')
    ap.add_argument('--dropout', type=float, default=0.0, help='fc1 输出 dropout 率（仅训练期）')
    ap.add_argument('--weight-decay', type=float, default=0.0, help='L2 正则系数（仅权重矩阵）')
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    sys.path.insert(0, HERE)
    from train_captcha_cnn import _load_fonts, gen_batch  # 复用纯合成采样器

    files, texts = load_real_dataset(args.data)
    if not files:
        print('ERROR: no real samples found', file=sys.stderr)
        sys.exit(2)
    (tr_f, tr_t), (va_f, va_t) = split_train_val(files, texts)
    print(f'real samples: total={len(files)} train={len(tr_f)} val={len(va_f)}')

    fonts = _load_fonts()
    print(f'fonts: {len(fonts)}')

    params = None
    if args.warm_start and os.path.isfile(args.out):
        with np.load(args.out) as data:
            params = {k: data[k] for k in data.files}
        print('warm start from existing npz')
    trainer = Trainer(rng, params, dropout=args.dropout, weight_decay=args.weight_decay)

    val_batches = []
    for s in range(0, len(va_f), 500):
        val_batches.append(real_batch(va_f[s:s + 500], va_t[s:s + 500], rng, augment=False))

    best_all = 0.0
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        t0 = time.time()
        ep_lr = args.lr * (0.5 * (1 + np.cos(np.pi * (epoch - 1) / max(1, args.epochs)))) + args.lr * 0.02
        loss_sum, steps = 0.0, 0
        # 真实样本每 epoch 重复 real_repeat 次（每次重新洗牌+重新增强，等效
        # 扩充真实集暴露量）；合成样本固定补足多样性份额。第一轮欠拟合复盘：
        # 真实:合成 = 1900:6000，76% 梯度信号来自分布不匹配的合成域，且真实
        # 样本每轮仅曝光 1 次——真实为主、合成为辅的反转是收敛关键。
        batches = []
        for _rep in range(max(1, args.real_repeat)):
            order = rng.permutation(len(tr_f))
            for s in range(0, len(tr_f), args.batch):
                idx = order[s:s + args.batch]
                batches.append(('real', [tr_f[i] for i in idx], [tr_t[i] for i in idx]))
        s = 0
        while s < args.synthetic_per_epoch:
            n = min(args.batch, args.synthetic_per_epoch - s)
            batches.append(('syn', n, None))
            s += n
        rng.shuffle(batches)

        for b in batches:
            if b[0] == 'real':
                xb, yb = real_batch(b[1], b[2], rng, augment=True)
            else:
                xb, yb = gen_batch(b[1], rng, fonts)
            loss_sum += trainer.train_step(xb, yb, ep_lr) * xb.shape[0]
            steps += xb.shape[0]

        char_acc, all_acc = trainer.evaluate(val_batches)
        print(f'epoch {epoch:2d}/{args.epochs}  loss {loss_sum / max(steps, 1):.4f}  '
              f'char {char_acc:.4f}  all4 {all_acc:.4f}  lr {ep_lr:.5f}  {time.time() - t0:.0f}s')
        if all_acc > best_all or epoch == 1:
            best_all = all_acc
            np.savez_compressed(args.out, **trainer.params)
            print(f'  saved -> {args.out}')

    char_acc, all_acc = trainer.evaluate(val_batches)
    print(f'FINAL val char {char_acc:.4f}  all4 {all_acc:.4f}  (best all4 {best_all:.4f})')
    if char_acc < 0.97 or all_acc < 0.90:
        print('BELOW THRESHOLD (char>=0.97 all4>=0.90)', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
