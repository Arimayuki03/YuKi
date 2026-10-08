# -*- coding: utf-8 -*-
"""真实集评估：tiny-CNN（指定 npz）vs ddddocr 在三站真实样本上的对比报告。

用法：
    python-backend/.venv/Scripts/python.exe python-backend/tools/eval_captcha_real.py \
        [--npz python-backend/kazumi/assets/captcha_cnn.npz] [--data .captcha-data]

输出：
  - 总体与分站的 char / all4 准确率（train 切分与 val 切分分开报告——val 才是
    泛化口径，train 数字仅参考拟合程度）；
  - ddddocr 同集对照（all4 即「站点判题会通过」的口径）；
  - 识别延迟（tiny-CNN 单图毫秒级 vs ddddocr），供识别链排序决策参考。
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)
sys.path.insert(0, HERE)

from kazumi import captcha_cnn  # noqa: E402
from train_captcha_real import SITES, load_real_dataset, real_batch, split_train_val  # noqa: E402

# 本文件为纯离线评估：只读本地已落盘的真实样本与 npz 权重，不发起任何网络
# 请求。SITES 站点仅用于本地验证码样本采集/训练，采集侧限速约束见
# sample_captcha_site.py。


def cnn_accuracy(params, files, texts, rng):
    """tiny-CNN 批量准确率（无增强，直接复用训练侧 real_batch 保证同构）。"""
    trainer_mod = sys.modules['train_captcha_real']
    xs = np.zeros((len(files), 1, captcha_cnn.INPUT_H, captcha_cnn.INPUT_W), dtype=np.float32)
    ys = np.zeros((len(files), 4), dtype=np.int64)
    # 分批编码（复用 real_batch，但不做增强）
    for s in range(0, len(files), 500):
        xb, yb = real_batch(files[s:s + 500], texts[s:s + 500], rng, augment=False)
        xs[s:s + 500] = xb
        ys[s:s + 500] = yb
    trainer = trainer_mod.Trainer(np.random.default_rng(0), params)
    logits, _ = trainer.forward_all(xs)
    pred = logits.argmax(axis=2)
    char_acc = float((pred == ys).sum()) / (len(files) * 4)
    all4_acc = float((pred == ys).all(axis=1).sum()) / max(len(files), 1)
    return char_acc, all4_acc, pred


def dddd_accuracy(files, texts):
    """ddddocr 对照：all4 准确率 + char 准确率 + 单图延迟。"""
    import ddddocr
    ocr = ddddocr.DdddOcr(show_ad=False)
    n_char = n_all = 0
    t0 = time.perf_counter()
    preds = []
    for p in files:
        with open(p, 'rb') as f:
            content = f.read()
        out = str(ocr.classification(content) or '').strip()
        preds.append(out)
    dt = time.perf_counter() - t0
    for out, t in zip(preds, texts):
        n_all += int(out == t)
        n_char += sum(1 for a, b in zip(out, t) if a == b)
    return n_char / (len(files) * 4), n_all / max(len(files), 1), dt / len(files) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--npz', default=os.path.join(BACKEND, 'kazumi', 'assets', 'captcha_cnn.npz'))
    ap.add_argument('--data', default='.captcha-data')
    args = ap.parse_args()

    with np.load(args.npz) as data:
        params = {k: data[k] for k in data.files}
    rng = np.random.default_rng(0)

    files, texts = load_real_dataset(args.data)
    if not files:
        # 空数据集早退（L2，对齐 train_captcha_real.py）：否则 va_f[0] 抛
        # IndexError、准确率除零，堆栈对使用毫无诊断价值。
        print('ERROR: no real samples found', file=sys.stderr)
        sys.exit(2)
    (tr_f, tr_t), (va_f, va_t) = split_train_val(files, texts)
    print(f'dataset: total={len(files)} train={len(tr_f)} val={len(va_f)}')

    print('\n== tiny-CNN (retrained) ==')
    for name, fs, ts in (('train', tr_f, tr_t), ('val  ', va_f, va_t)):
        char_acc, all4_acc, _ = cnn_accuracy(params, fs, ts, rng)
        print(f'  {name} char={char_acc:.4f}  all4={all4_acc:.4f}  (n={len(fs)})')

    # 分站（val 口径为准）
    for site in SITES:
        sf = [p for p in va_f if os.path.basename(p).startswith(site)]
        st = [t for p, t in zip(va_f, va_t) if os.path.basename(p).startswith(site)]
        if not sf:
            continue
        char_acc, all4_acc, _ = cnn_accuracy(params, sf, st, rng)
        print(f'  {site:13s} val char={char_acc:.4f}  all4={all4_acc:.4f}  (n={len(sf)})')

    print('\n== ddddocr (baseline) ==')
    d_char, d_all4, d_ms = dddd_accuracy(va_f, va_t)
    print(f'  val   char={d_char:.4f}  all4={d_all4:.4f}  (n={len(va_f)})  {d_ms:.0f} ms/img')

    t0 = time.perf_counter()
    with open(va_f[0], 'rb') as f:
        captcha_cnn.recognize(f.read())
    print(f'\ntiny-CNN latency: {(time.perf_counter() - t0) * 1000:.1f} ms/img (首次含加载)')


if __name__ == '__main__':
    main()
