# -*- coding: utf-8 -*-
"""字节码级补丁：修补 TVBox jar 的两类问题。

1. 失效 CSS 选择器常量（Kwps 夸克盘社：'#J_topNavMb' → '#J_topNav'）。
   class 文件 constant_pool 中 CONSTANT_Utf8 条目自带 u2 长度前缀，
   原地替换内容并更新长度即可，其余索引/偏移不受影响。

2. dex2jar 转换 bug：super 调用被错误指向自身（ea3f 4K 网盘 jar 的
   Pan.init 递归 StackOverflow）。把 Methodref 的 class 重定向为父类
   Spider（runner 内置 stub），invokespecial/invokevirtual 均按
   JVM 虚方法语义正常解析。
"""
import zipfile

# 已知失效选择器补丁表：jar 内 class 路径 → [(旧选择器, 新选择器), ...]
# 注意：class 常量池里的字面量含前导空格（javap 显示 "String  #J_topNavMb  a"）。
# Kwps 网站导航 id 在 J_topNav / J_topNavMb 之间变动，而移动端导航的 class
# 稳定为 nav-m，改用类选择器（FongMi 自定义解析器不支持 [attr^=] 前缀语法）。
SELECTOR_PATCHES = {
    'com/github/catvod/spider/Kwps.class': [
        (' #J_topNavMb  a', ' .nav-m a'),
    ],
}

# dex2jar 递归修复：class 路径 → [(owner类, 方法名, 方法描述, 重定向到的类), ...]
# ea3f 4K 网盘 jar：Pan.init(Context,String) 的 invokespecial 指向自身 → 无限递归
# （Android ART 直接跑 DEX 无此问题；JVM 上必 StackOverflow）。
# 重定向到 com/github/catvod/crawler/Spider（runner stub 有同名方法）。
METHODREF_PATCHES = {
    'com/github/catvod/spider/Pan.class': [
        ('com/github/catvod/spider/Pan', 'init',
         '(Landroid/content/Context;Ljava/lang/String;)V',
         'com/github/catvod/crawler/Spider'),
    ],
}


def _parse_cp(data):
    """解析 constant_pool，返回 [(tag, start, info)], cp_count。

    info 为条目内有效载荷（不含 tag），便于读取字段。
    """
    out = []
    n = len(data)
    if n < 10:
        return out, 0
    pos = 8
    cp_count = int.from_bytes(data[pos:pos + 2], 'big')
    pos += 2
    i = 1
    while i < cp_count and pos + 1 < n:
        tag = data[pos]
        start = pos
        pos += 1
        if tag == 1:  # Utf8
            ln = int.from_bytes(data[pos:pos + 2], 'big')
            out.append((tag, start, pos + 2, ln))
            pos += 2 + ln
        elif tag == 7:      # Class
            out.append((tag, start, pos, 2))
            pos += 2
        elif tag in (8, 16, 19, 20):  # String/MethodType/Module/Package
            out.append((tag, start, pos, 2))
            pos += 2
        elif tag == 15:     # MethodHandle
            out.append((tag, start, pos, 3))
            pos += 3
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):  # int/float/refs/NAT/Dynamic
            out.append((tag, start, pos, 4))
            pos += 4
        elif tag in (5, 6):  # long/double（占 2 槽位）
            out.append((tag, start, pos, 8))
            pos += 8
            i += 1
        else:
            break
        i += 1
    return out, cp_count


def _cp_utf8(data, info):
    # info = (tag, start, payload_off, payload_len)
    off, ln = info[2], info[3]
    return data[off:off + ln].decode('utf-8', errors='replace')


def patch_methodref_class(data, owner, method, desc, new_owner):
    """把 Methodref(owner.method:desc) 的 class 重定向为 new_owner。

    返回 (new_bytes, count)。new_owner 须已存在于常量池（父类引用必有），
    复用其 Class 条目索引；否则不修改。
    """
    out = bytearray(data)
    entries, cp_count = _parse_cp(bytes(out))
    # 收集 Class 条目索引（tag 7）→ 类名
    class_idx = {}
    for idx, (tag, start, off, ln) in enumerate(entries):
        if tag != 7:
            continue
        name_idx = int.from_bytes(out[off:off + 2], 'big')
        if 1 <= name_idx <= len(entries) and entries[name_idx - 1][0] == 1:
            class_idx[idx + 1] = _cp_utf8(bytes(out), entries[name_idx - 1])
    target = None
    for idx, name in class_idx.items():
        if name == new_owner:
            target = idx
            break
    if target is None:
        return bytes(out), 0
    count = 0
    for idx, (tag, start, off, ln) in enumerate(entries):
        if tag != 10:  # Methodref
            continue
        cidx = int.from_bytes(out[off:off + 2], 'big')
        nt_idx = int.from_bytes(out[off + 2:off + 4], 'big')
        if class_idx.get(cidx) != owner:
            continue
        if not (1 <= nt_idx <= len(entries) and entries[nt_idx - 1][0] == 12):
            continue
        nt = entries[nt_idx - 1]
        # NameAndType: tag(1) + name_index(2) + descriptor_index(2)，payload 从 nt[2] 起
        name_idx = int.from_bytes(out[nt[2]:nt[2] + 2], 'big')
        dsc_idx = int.from_bytes(out[nt[2] + 2:nt[2] + 4], 'big')
        if not (1 <= name_idx <= len(entries) and entries[name_idx - 1][0] == 1):
            continue
        if not (1 <= dsc_idx <= len(entries) and entries[dsc_idx - 1][0] == 1):
            continue
        mname = _cp_utf8(bytes(out), entries[name_idx - 1])
        mdesc = _cp_utf8(bytes(out), entries[dsc_idx - 1])
        if mname == method and mdesc == desc:
            out[off:off + 2] = target.to_bytes(2, 'big')
            count += 1
    return bytes(out), count


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
    """把 src_jar 复制为 dst_jar，并应用补丁。

    patches 为 SELECTOR_PATCHES（utf8 替换）；METHODREF_PATCHES 始终应用。
    """
    changed = []
    with zipfile.ZipFile(src_jar, 'r') as zin:
        names = zin.namelist()
        with zipfile.ZipFile(dst_jar, 'w', zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                data = zin.read(name)
                for old, new in (patches or {}).get(name, []):
                    data, cnt = patch_utf8_constant(data, old, new)
                    if cnt:
                        changed.append((name, 'utf8', old, new, cnt))
                for owner, method, desc, new_owner in METHODREF_PATCHES.get(name, []):
                    data, cnt = patch_methodref_class(data, owner, method, desc, new_owner)
                    if cnt:
                        changed.append((name, 'methodref', owner + '.' + method, new_owner, cnt))
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
