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
import os
import re
import threading
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
    """解析 constant_pool，返回 [entry], cp_count。

    entry = (tag, start, info, slot)；slot 是该条目的常量池索引（1 起，
    与字节码/其他条目里的 u2 引用同刻度）。long/double（tag 5/6）按 JVM
    规范占 2 个槽位：它们的 slot 加一即被跳过，其后条目的 slot 相应 +2。
    info 为条目内有效载荷（不含 tag），便于读取字段。

    审查 M-5：此前直接用「列表下标 + 1」当常量池索引，未补偿 long/double
    的双槽位——含 long/double 常量的 class 里，Methodref/Class/NameAndType
    的解析全部错位，补丁静默漏打。
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
        slot = i
        pos += 1
        if tag == 1:  # Utf8
            ln = int.from_bytes(data[pos:pos + 2], 'big')
            out.append((tag, start, pos + 2, ln, slot))
            pos += 2 + ln
        elif tag == 7:      # Class
            out.append((tag, start, pos, 2, slot))
            pos += 2
        elif tag in (8, 16, 19, 20):  # String/MethodType/Module/Package
            out.append((tag, start, pos, 2, slot))
            pos += 2
        elif tag == 15:     # MethodHandle
            out.append((tag, start, pos, 3, slot))
            pos += 3
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):  # int/float/refs/NAT/Dynamic
            out.append((tag, start, pos, 4, slot))
            pos += 4
        elif tag in (5, 6):  # long/double（占 2 槽位：本条 + 一个空槽）
            out.append((tag, start, pos, 8, slot))
            pos += 8
            i += 1
        else:
            break
        i += 1
    return out, cp_count


def _cp_by_slot(entries):
    """把 entries 按 slot 建索引：slot → entry。字节码里的 u2 引用按它解引用。"""
    return {entry[4]: entry for entry in entries}


def _cp_utf8(data, info):
    # info = (tag, start, payload_off, payload_len, slot)
    off, ln = info[2], info[3]
    return data[off:off + ln].decode('utf-8', errors='replace')


def patch_methodref_class(data, owner, method, desc, new_owner):
    """把 Methodref(owner.method:desc) 的 class 重定向为 new_owner。

    返回 (new_bytes, count)。new_owner 须已存在于常量池（父类引用必有），
    复用其 Class 条目索引；否则不修改。所有常量池引用一律按真实 slot 索引
    解析（long/double 双槽位已由 _parse_cp 补偿，见 _cp_by_slot）。
    """
    out = bytearray(data)
    entries, cp_count = _parse_cp(bytes(out))
    by_slot = _cp_by_slot(entries)

    def _entry_at(idx):
        """按常量池索引取条目；越界/空槽（long double 的第二槽）返回 None。"""
        return by_slot.get(idx)

    def _utf8_of(idx):
        entry = _entry_at(idx)
        if entry is None or entry[0] != 1:
            return None
        return _cp_utf8(bytes(out), entry)

    # 收集 Class 条目（tag 7）：slot → 类名
    class_idx = {}
    for entry in entries:
        tag, _start, off, _ln, slot = entry
        if tag != 7:
            continue
        name_idx = int.from_bytes(out[off:off + 2], 'big')
        name = _utf8_of(name_idx)
        if name is not None:
            class_idx[slot] = name
    target = None
    for slot, name in class_idx.items():
        if name == new_owner:
            target = slot
            break
    if target is None:
        return bytes(out), 0
    count = 0
    for entry in entries:
        tag, _start, off, _ln, _slot = entry
        if tag != 10:  # Methodref
            continue
        cidx = int.from_bytes(out[off:off + 2], 'big')
        nt_idx = int.from_bytes(out[off + 2:off + 4], 'big')
        if class_idx.get(cidx) != owner:
            continue
        nt = _entry_at(nt_idx)
        if nt is None or nt[0] != 12:
            continue
        # NameAndType: tag(1) + name_index(2) + descriptor_index(2)，payload 从 nt[2] 起
        name_idx = int.from_bytes(out[nt[2]:nt[2] + 2], 'big')
        dsc_idx = int.from_bytes(out[nt[2] + 2:nt[2] + 4], 'big')
        mname = _utf8_of(name_idx)
        mdesc = _utf8_of(dsc_idx)
        if mname is None or mdesc is None:
            continue
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
    if not old_b or not new_b or len(new_b) > 65535:
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


def _validate_zip_entry_name(name):
    """P3-4 防御校验：zip 条目名不得含 ``..`` 段、不以 ``/``/盘符开头。

    现实约束下补丁名硬编码、writestr 只写进 zip 包内不落盘，不构成实际
    目录穿越；但下游/第三方解包工具按条目名还原路径时，恶意条目名仍可能
    被写到目标目录外。非法即抛 ValueError，fail-closed。
    """
    text = str(name or '')
    if not text:
        raise ValueError('empty zip entry name')
    if text.startswith('/') or text.startswith('\\'):
        raise ValueError('zip entry name is absolute: %r' % text[:80])
    if len(text) >= 2 and text[1] == ':' and text[0].isalpha():
        raise ValueError('zip entry name carries a drive letter: %r' % text[:80])
    parts = re.split(r'[\\/]+', text)
    if any(seg == '..' for seg in parts):
        raise ValueError('zip entry name contains ".." segment: %r' % text[:80])


def patch_jar(src_jar, dst_jar, patches, dry_run=False):
    """把 src_jar 复制为 dst_jar，并应用补丁。

    patches 为 SELECTOR_PATCHES（utf8 替换）；METHODREF_PATCHES 始终应用。
    原子写（审查 M-4）：先写同目录临时文件，完成后 os.replace 到目标——
    直接 'w' 写目标时，进程崩溃会残留半截坏 jar；坏 jar 的 mtime 比源文件新，
    会被 apply_jar_patches 判「已是最新产物」永久复用，加载必败。失败时清理
    临时文件，目标只可能是完整产物或不存在。
    """
    changed = []
    tmp_dst = f'{dst_jar}.tmp{os.getpid()}-{threading.get_ident()}'
    try:
        with zipfile.ZipFile(src_jar, 'r') as zin:
            names = zin.namelist()
            with zipfile.ZipFile(tmp_dst, 'w', zipfile.ZIP_DEFLATED) as zout:
                for name in names:
                    # P3-4：防御性条目名校验（说明见 _validate_zip_entry_name）
                    _validate_zip_entry_name(name)
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
        os.replace(tmp_dst, dst_jar)
    finally:
        if os.path.isfile(tmp_dst):
            try:
                os.remove(tmp_dst)
            except OSError:
                pass
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
