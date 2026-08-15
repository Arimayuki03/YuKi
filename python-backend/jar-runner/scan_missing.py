# -*- coding: utf-8 -*-
"""扫描所有 -jvm.jar 中引用的 android.* / com.github.catvod.crawler.* 类，
与 runner 现有 stubs 对比，输出缺失清单（含引用方、用法: interface/superclass/type）。
基于常量池完整解析（覆盖 getstatic/invokestatic 等指令引用的类）。"""
import os, sys, glob, zipfile, re, struct
from collections import defaultdict

HOME = os.path.expanduser('~')
JAR_DIR = os.path.join(HOME, '.video-pc', 'cache', 'jar')
HERE = os.path.dirname(os.path.abspath(__file__))
STUBS_DIR = os.path.join(HERE, 'stubs')

PREFIXES = ('android/', 'com/github/catvod/crawler/')


def parse_class(data):
    """返回 (this_name, super_name, interfaces, class_refs) 或 None。"""
    if len(data) < 10 or data[:4] != b'\xca\xfe\xba\xbe':
        return None
    pos = 8
    cp_count = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    cp = [None] * cp_count
    i = 1
    while i < cp_count:
        tag = data[pos]; pos += 1
        if tag == 1:  # Utf8
            ln = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
            cp[i] = data[pos:pos+ln].decode('latin1'); pos += ln
        elif tag in (3, 4): pos += 4
        elif tag in (5, 6): pos += 8; i += 1
        elif tag == 7:  # Class -> name index
            cp[i] = ('cls', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag in (8, 16, 19, 20): pos += 2
        elif tag == 15: pos += 3
        elif tag in (9, 10, 11, 12, 17, 18): pos += 4
        i += 1
    if pos + 6 > len(data):
        return None
    access = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    this_idx = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    super_idx = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    iface_count = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    ifaces = []
    for _ in range(iface_count):
        ifaces.append(struct.unpack('>H', data[pos:pos+2])[0]); pos += 2

    def name_of(idx):
        if idx <= 0 or idx >= cp_count:
            return None
        e = cp[idx]
        if not e or e[0] != 'cls':
            return None
        uidx = e[1]
        if uidx <= 0 or uidx >= cp_count:
            return None
        return cp[uidx] if isinstance(cp[uidx], str) else None

    refs = set()
    for e in cp:
        if e and e[0] == 'cls':
            nm = name_of(cp.index(e)) if False else None  # placeholder, resolved below
    # 直接遍历：cls 条目指向 utf8 索引
    for idx, e in enumerate(cp):
        if e and e[0] == 'cls':
            uidx = e[1]
            if 0 < uidx < cp_count and isinstance(cp[uidx], str):
                refs.add(cp[uidx])
    this = name_of(this_idx)
    sup = name_of(super_idx)
    ifs = [name_of(x) for x in ifaces]
    ifs = [x for x in ifs if x]
    return this, sup, ifs, refs, bool(access & 0x0200)


def collect_existing():
    """扫描 stubs 目录，返回 set(全限定名)。"""
    names = set()
    for f in glob.iglob(os.path.join(STUBS_DIR, '**', '*.java'), recursive=True):
        with open(f, encoding='utf-8', errors='replace') as fh:
            src = fh.read()
        pkg = 'android'
        m = re.search(r'package\s+([\w.]+)\s*;', src)
        if m:
            pkg = m.group(1)
        rel = os.path.relpath(f, STUBS_DIR)
        outer_file = os.path.splitext(os.path.basename(rel))[0]
        if '$' in outer_file:
            names.add(pkg + '.' + outer_file)
            continue
        outer = pkg + '.' + outer_file
        names.add(outer)
        for m2 in re.finditer(r'\b(?:public\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:interface|class|enum|@interface)\s+([A-Za-z_$][\w$]*)', src):
            inner = m2.group(1)
            if inner != outer_file:
                names.add(outer + '$' + inner)
    return names


def main():
    existing = collect_existing()
    jars = sorted(glob.glob(os.path.join(JAR_DIR, '*-jvm.jar')))
    print('jars:', [os.path.basename(j) for j in jars])
    refs = defaultdict(list)
    used_as_interface = set()
    used_as_super = set()
    for j in jars:
        z = zipfile.ZipFile(j)
        for n in z.namelist():
            if not n.endswith('.class'):
                continue
            info = parse_class(z.read(n))
            if not info:
                continue
            this, sup, ifs, class_refs, is_iface = info
            for ref in class_refs:
                if ref.startswith(PREFIXES):
                    refs[ref.replace('/', '.')].append(n)
            if sup and sup.startswith(PREFIXES):
                used_as_super.add(sup.replace('/', '.'))
            for f in ifs:
                if f.startswith(PREFIXES):
                    used_as_interface.add(f.replace('/', '.'))
        z.close()
    missing = sorted(k for k in refs if k not in existing)
    print(f'\nmissing count: {len(missing)}\n')
    for ref in missing:
        if ref in used_as_interface:
            kind = 'interface'
        elif ref in used_as_super:
            kind = 'class'
        else:
            kind = '?'
        srcs = sorted(set(refs[ref]))[:3]
        print(f'{ref}  [{kind}]  <- {[s.split("/")[-1] for s in srcs]}')


if __name__ == '__main__':
    main()
