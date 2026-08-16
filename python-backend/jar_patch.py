# -*- coding: utf-8 -*-
"""字节码级补丁：修补 TVBox jar 中失效的 CSS 选择器常量。

Kwps（夸克盘社）homeContent 用 '#J_topNavMb' 解析首页移动端导航作为分类，
网站改版后该 id 已不存在（桌面/移动版均为 '#J_topNav'），导致分类恒为空。

原理：class 文件 constant_pool 中 CONSTANT_Utf8 条目自带 u2 长度前缀，
原地替换内容并更新长度即可，其余索引/偏移不受影响（解析器按长度顺序跳转）。
"""
import os
import re
import shutil
import zipfile

# 已知失效选择器补丁表：jar 内 class 路径 → [(旧选择器, 新选择器), ...]
# 注意：class 常量池里的字面量含前导空格（javap 显示 "String  #J_topNavMb  a"）
SELECTOR_PATCHES = {
    'com/github/catvod/spider/Kwps.class': [
        (' #J_topNavMb  a', ' #J_topNav a'),
    ],
}


def _patch_class_bytes(data):
    """在 class 字节流中修补 CONSTANT_Utf8 常量；返回 (新字节, 命中数)。"""
    patched = bytearray(data)
    hits = 0
    for old, new in SELECTOR_PATCHES.get('', []):
        raise AssertionError('unreachable')
    return bytes(patched), hits


def patch_utf8_constant(data, old, new):
    """把 class 字节流中所有内容 == old 的 CONSTANT_Utf8 常量替换为 new。

    返回 (new_bytes, count)。CONSTANT_Utf8 条目：u1 tag=1; u2 length; u1 bytes[length]。
    直接二进制定位（带 tag/length 校验）后原地改写长度与内容；constant_pool 按
    自描述长度顺序解析，后续条目偏移不受影响。
    """
    out = bytearray(data)
    count = 0
    old_b = old.encode('utf-8')
    new_b = new.encode('utf-8')
    if len(old_b) != len(old_b) or len(new_b) > 65535:
        raise ValueError('bad patch length')
    # 定位 "tag=1 length=len(old_b) old_b" 模式
    pattern = b'\x01' + len(old_b).to_bytes(2, 'big') + old_b
    start = 0
    while True:
        idx = out.find(pattern, start)
        if idx < 0:
            break
        # 长度字段 = idx+1..idx+3；内容区 idx+3 .. idx+3+len(old_b)
        out[idx + 1:idx + 3] = len(new_b).to_bytes(2, 'big')
        seg_start = idx + 3
        seg_end = seg_start + len(old_b)
        # 新内容写入，并把后续字节整体前移（class 文件无绝对文件偏移引用，
        # 常量池索引不受影响，字节码内偏移均为方法体相对偏移，安全）
        tail = bytes(out[seg_end:])
        out[seg_start:seg_end] = new_b
        out[seg_start + len(new_b):] = tail
        count += 1
        start = idx + len(new_b) + 3
    return bytes(out), count


def patch_jar(src_jar, dst_jar, patches, dry_run=False):
    """把 src_jar 复制为 dst_jar，并应用 patches（class 路径 → [(old, new)]）。"""
    changed = []
    with zipfile.ZipFile(src_jar, 'r') as zin:
        names = zin.namelist()
        with zipfile.ZipFile(dst_jar, 'w', zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                data = zin.read(name)
                if name in patches:
                    for old, new in patches[name]:
                        data, cnt = patch_utf8_constant(data, old, new)
                        if cnt:
                            changed.append((name, old, new, cnt))
                zout.writestr(name, data)
    return changed


if __name__ == '__main__':
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else ''
    dst = sys.argv[2] if len(sys.argv) > 2 else ''
    if not src or not dst:
        print('usage: jar_patch.py <src.jar> <dst.jar>')
        sys.exit(1)
    changed = patch_jar(src, dst, SELECTOR_PATCHES)
    for c in changed:
        print('patched:', c)
    if not changed:
        print('no patches applied')
