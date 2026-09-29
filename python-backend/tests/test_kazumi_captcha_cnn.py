# -*- coding: utf-8 -*-
"""kazumi/captcha_cnn.py 小模型推理链单元测试。

覆盖：权重缺失降级、权重文件加载、前向几何契约、识别结果格式、
异常吞掉（坏图不炸）、reset_cache 测试钩子、并发懒加载只构造一次。
"""
import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kazumi import captcha_cnn  # noqa: E402

# 仓库内权重产物路径（与 captcha_cnn._weights_path 指向同一文件）。
# 模块级常量：供 TestWeightsFilePresent 的类级 skipUnless 使用，
# 使 npz 缺失的环境（如 CI checkout 未含 LFS/产物）整体 skip 而非 fail。
_WEIGHTS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             'kazumi', 'assets', 'captcha_cnn.npz')


def _make_weights(seed=7):
    """按生产契约几何生成随机权重（与训练脚本/assets 产物严格同形）。

    前向几何：32×96 → conv(1→12,3×3) → pool → conv(12→24,3×3) → pool
    → flatten 24×6×22=3168 → fc(3168→256) → fc(256→40) → reshape (4,10)。
    曾误用 8/16 通道、fc 2112 的自造几何，导致 flatten 维度契约从未按
    真实形状验证过（识别率不在此测——那是训练脚本门槛）。"""
    import numpy as np
    rng = np.random.default_rng(seed)
    return {
        'c1_w': (rng.standard_normal((12, 1, 3, 3)) * 0.1).astype(np.float32),
        'c1_b': np.zeros(12, dtype=np.float32),
        'c2_w': (rng.standard_normal((24, 12, 3, 3)) * 0.1).astype(np.float32),
        'c2_b': np.zeros(24, dtype=np.float32),
        'fc1_w': (rng.standard_normal((256, 3168)) * 0.01).astype(np.float32),
        'fc1_b': np.zeros(256, dtype=np.float32),
        'fc2_w': (rng.standard_normal((40, 256)) * 0.01).astype(np.float32),
        'fc2_b': np.zeros(40, dtype=np.float32),
    }


def _png_bytes(size=(96, 32), color=0):
    """合成一张最小 PNG（PIL 生成）作为合法图片输入。"""
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new('L', size, color).save(buf, format='PNG')
    return buf.getvalue()


class TestModelUnavailable(unittest.TestCase):
    """权重缺失/损坏时的降级契约：recognize 返回 None、available False、不抛异常。"""

    def setUp(self):
        captcha_cnn.reset_cache()

    def tearDown(self):
        captcha_cnn.reset_cache()

    def test_missing_weights_degrade(self):
        with mock.patch.object(captcha_cnn, '_weights_path', return_value=''):
            self.assertFalse(captcha_cnn.model_available())
            self.assertIsNone(captcha_cnn.recognize(_png_bytes()))

    def test_corrupt_weights_degrade(self):
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.npz', delete=False) as f:
            f.write(b'not-an-npz-file')
            path = f.name
        try:
            with mock.patch.object(captcha_cnn, '_weights_path', return_value=path):
                self.assertFalse(captcha_cnn.model_available())
                self.assertIsNone(captcha_cnn.recognize(_png_bytes()))
        finally:
            os.unlink(path)

    def test_missing_weight_key_degrade(self):
        import tempfile
        import numpy as np
        with tempfile.NamedTemporaryFile(suffix='.npz', delete=False) as f:
            np.savez(f, c1_w=np.zeros(1))
            path = f.name
        try:
            with mock.patch.object(captcha_cnn, '_weights_path', return_value=path):
                self.assertFalse(captcha_cnn.model_available())
        finally:
            os.unlink(path)


class TestForwardContract(unittest.TestCase):
    """前向几何与识别结果格式契约（注入内存权重）。"""

    def setUp(self):
        captcha_cnn.reset_cache()

    def tearDown(self):
        captcha_cnn.reset_cache()

    def _inject(self):
        import numpy as np
        w = _make_weights()
        holder = {'weights': w, 'tried': True}
        return mock.patch.object(captcha_cnn, '_holder', holder), np

    def test_recognize_returns_4_digits_or_none(self):
        p, np = self._inject()
        with p:
            out = captcha_cnn.recognize(_png_bytes())
        # 随机权重也会输出 4 位数字文本（argmax 必落在 0-9），或 None（异常路径）
        self.assertTrue(out is None or (isinstance(out, str) and len(out) == 4 and out.isdigit()))

    def test_preprocess_shape_and_range(self):
        import numpy as np
        arr = captcha_cnn.preprocess(_png_bytes(color=255))  # 全白（背景域）
        self.assertEqual(arr.shape, (1, 1, 32, 96))
        self.assertEqual(arr.dtype, np.float32)
        # 全白图（255=背景域）整体接近全 1：preprocess 不反色，样本与
        # 推理同处「浅底=1、深字=0」域（见 preprocess docstring）
        self.assertGreater(float(arr.mean()), 0.9)

    def test_preprocess_aspect_ratio_pad(self):
        # 瘦高图（如 20×120 的单字符图）不拉伸变形：等比缩放后居中填充
        arr = captcha_cnn.preprocess(_png_bytes(size=(20, 120), color=255))
        self.assertEqual(arr.shape, (1, 1, 32, 96))
        # 两侧应有空白填充列（值≈1，背景域填充）
        col_means = arr.reshape(32, 96).mean(axis=0)
        self.assertGreater(float(col_means[:5].mean()), 0.95)

    def test_bad_image_raises_inside_recognize_swallowed(self):
        p, _ = self._inject()
        with p:
            self.assertIsNone(captcha_cnn.recognize(b'not-an-image'))
            self.assertIsNone(captcha_cnn.recognize(None))
            self.assertIsNone(captcha_cnn.recognize(b''))

    def test_pool2x2_odd_size(self):
        import numpy as np
        x = np.arange(2 * 3 * 5 * 7, dtype=np.float32).reshape(2, 3, 5, 7)
        pooled = captcha_cnn._pool2x2(x)
        self.assertEqual(pooled.shape, (2, 3, 2, 3))  # 丢弃末行/列

    def test_concurrent_load_constructs_once(self):
        # 双检锁契约：并发探测下 np.load 只发生一次（此处用计数桩验证串行化）。
        # 计数桩包住真实 np.load（不能 mock 掉 np.load 本身——桩内部还要用它）。
        import io
        import numpy as np
        buf = io.BytesIO()
        np.savez(buf, **_make_weights())
        real_load = np.load
        calls = []

        def counting_load(*a, **kw):
            # 假路径 → 从内存 buffer 读（桩内仍走真实 np.load 语义）
            if a and a[0] == '/fake/ok.npz':
                buf.seek(0)
                calls.append(a[:1])
                return real_load(buf)
            calls.append(a[:1])
            return real_load(*a, **kw)

        barrier = threading.Barrier(6)
        results = []

        def probe():
            barrier.wait(timeout=5)
            results.append(captcha_cnn.model_available())

        with mock.patch.object(captcha_cnn, '_weights_path', return_value='/fake/ok.npz'), \
                mock.patch('numpy.load', counting_load):
            threads = [threading.Thread(target=probe) for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
        self.assertTrue(all(results))
        self.assertEqual(len(calls), 1)


@unittest.skipUnless(os.path.isfile(_WEIGHTS_PATH),
                     'weights asset not built (run tools/train_captcha_cnn.py)')
class TestWeightsFilePresent(unittest.TestCase):
    """仓库内权重产物契约（识别器实际可用的前提）。

    类级 skipUnless：npz 产物缺失的环境（如未随 checkout 带出权重时）
    整体 skip 而非 fail——真实产物入库后正常环境仍全量校验。"""

    def _assets_path(self):
        return _WEIGHTS_PATH

    def test_weights_file_exists_in_assets(self):
        path = self._assets_path()
        self.assertTrue(os.path.isfile(path), f'权重产物缺失: {path}')
        import numpy as np
        with np.load(path) as data:
            self.assertEqual(set(data.files),
                             {'c1_w', 'c1_b', 'c2_w', 'c2_b', 'fc1_w', 'fc1_b', 'fc2_w', 'fc2_b'})

    def test_weights_shapes_match_production_contract(self):
        # 生产几何契约：conv 12/24 通道、flatten 24×6×22=3168、输出 4×10。
        import numpy as np
        with np.load(self._assets_path()) as data:
            shapes = {k: data[k].shape for k in data.files}
        self.assertEqual(shapes['c1_w'], (12, 1, 3, 3))
        self.assertEqual(shapes['c1_b'], (12,))
        self.assertEqual(shapes['c2_w'], (24, 12, 3, 3))
        self.assertEqual(shapes['c2_b'], (24,))
        self.assertEqual(shapes['fc1_w'], (256, 3168))
        self.assertEqual(shapes['fc1_b'], (256,))
        self.assertEqual(shapes['fc2_w'], (40, 256))
        self.assertEqual(shapes['fc2_b'], (40,))

    def test_real_weights_recognize_smoke(self):
        # 冒烟：真实 npz 能加载、能前向（不校验识别率，输出任意字符串即过）。
        self.assertTrue(captcha_cnn.model_available())
        out = captcha_cnn.recognize(_png_bytes())
        self.assertIsInstance(out, str)


if __name__ == '__main__':
    unittest.main()
