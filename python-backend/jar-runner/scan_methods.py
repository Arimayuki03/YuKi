# -*- coding: utf-8 -*-
"""分析 jar 中对 android.* 类的 methodref/fieldref 调用，
对比 stub 源码中已声明的方法/字段，输出缺失方法清单。"""
import os, sys, glob, zipfile, re, struct
from collections import defaultdict

HOME = os.path.expanduser('~')
JAR_DIR = os.path.join(HOME, '.video-pc', 'cache', 'jar')
HERE = os.path.dirname(os.path.abspath(__file__))
STUBS_DIR = os.path.join(HERE, 'stubs')
PREFIXES = ('android/', 'com/github/catvod/crawler/')


def parse_cp(data):
    """返回 (cp_list, methodrefs, fieldrefs, classrefs)。"""
    if len(data) < 10 or data[:4] != b'\xca\xfe\xba\xbe':
        return None
    pos = 8
    cp_count = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
    cp = [None] * cp_count
    i = 1
    while i < cp_count:
        tag = data[pos]; pos += 1
        if tag == 1:
            ln = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2
            cp[i] = data[pos:pos+ln].decode('latin1'); pos += ln
        elif tag in (3, 4): pos += 4
        elif tag in (5, 6): pos += 8; i += 1
        elif tag == 7: cp[i] = ('cls', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag == 8: cp[i] = ('str', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag == 16: cp[i] = ('itype', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag == 15: cp[i] = ('mh', data[pos:pos+3]); pos += 3
        elif tag == 19: cp[i] = ('md', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag == 20: cp[i] = ('pkg', struct.unpack('>H', data[pos:pos+2])[0]); pos += 2
        elif tag in (9, 10, 11, 12):  # fieldref/methodref/interface-methodref/nameandtype
            cp[i] = (tag, struct.unpack('>H', data[pos:pos+2])[0], struct.unpack('>H', data[pos:pos+2])[0]); pos += 4
        elif tag in (17, 18):
            cp[i] = ('dyn', data[pos:pos+4]); pos += 4
        else:
            return None
        i += 1

    def utf(idx):
        return cp[idx] if 0 < idx < cp_count and isinstance(cp[idx], str) else None

    def cls_name(idx):
        e = cp[idx] if 0 < idx < cp_count else None
        if e and e[0] == 'cls':
            return utf(e[1])
        return None

    methodrefs = defaultdict(set)  # target -> {(name, desc)}
    fieldrefs = defaultdict(set)
    classrefs = set()
    for e in cp:
        if not e:
            continue
        if e[0] == 'cls':
            nm = utf(e[1])
            if nm:
                classrefs.add(nm)
        elif e[0] in (9, 10, 11):
            target = cls_name(e[1])
            nat = cp[e[2]] if e[2] < cp_count else None
            if target and nat and nat[0] in (9, 10, 11, 12) and isinstance(nat[1], int):
                name = utf(nat[1])
                desc = utf(nat[2])
                if name and desc:
                    (fieldrefs if e[0] == 9 else methodrefs)[target].add((name, desc))
    return cp, methodrefs, fieldrefs, classrefs


def collect_existing():
    names = {}
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
            names[pkg + '.' + outer_file] = src
            continue
        outer = pkg + '.' + outer_file
        names[outer] = src
        for m2 in re.finditer(r'\b(?:public\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:interface|class|enum|@interface)\s+([A-Za-z_$][\w$]*)', src):
            inner = m2.group(1)
            if inner != outer_file:
                names[outer + '$' + inner] = src
    return names


def desc_to_java(desc):
    """描述符 -> (返回类型, [参数类型])，全限定名。"""
    ret, rest = desc.split(')', 1)
    params = []
    i = 1
    while i < len(ret):
        c = ret[i]
        if c == 'L':
            j = ret.index(';', i)
            params.append(ret[i+1:j].replace('/', '.'))
            i = j + 1
        elif c == '[':
            j = i
            while ret[j] == '[':
                j += 1
            if ret[j] == 'L':
                k = ret.index(';', j)
                params.append(ret[i:k+1].replace('/', '.'))
                i = k + 1
            else:
                prim = ret[j]
                params.append(ret[i:j+1].replace('I', 'int').replace('Z', 'boolean').replace('J', 'long')
                              .replace('F', 'float').replace('D', 'double').replace('B', 'byte')
                              .replace('C', 'char').replace('S', 'short'))
                i = j + 1
        else:
            params.append({'I': 'int', 'Z': 'boolean', 'J': 'long', 'F': 'float', 'D': 'double',
                           'B': 'byte', 'C': 'char', 'S': 'short', 'V': 'void'}[c])
            i += 1
    r = rest[1:]
    if r.startswith('L') and r.endswith(';'):
        r = r[1:-1].replace('/', '.')
    elif r.startswith('['):
        j = 0
        while r[j] == '[':
            j += 1
        if r[j] == 'L':
            r = r[1:j+1].replace('/', '.') + '[]' * j
            r = r.replace(';', '')
        else:
            r = {'I': 'int', 'Z': 'boolean', 'J': 'long', 'F': 'float', 'D': 'double',
                 'B': 'byte', 'C': 'char', 'S': 'short'}[r[j]] + '[]' * j
    return r, params


def main():
    existing = collect_existing()
    jars = sorted(glob.glob(os.path.join(JAR_DIR, '*-jvm.jar')))
    methodrefs = defaultdict(set)
    fieldrefs = defaultdict(set)
    for j in jars:
        z = zipfile.ZipFile(j)
        for n in z.namelist():
            if not n.endswith('.class'):
                continue
            r = parse_cp(z.read(n))
            if not r:
                continue
            _, mr, fr, _ = r
            for tgt, items in mr.items():
                if tgt.startswith(PREFIXES):
                    methodrefs[tgt.replace('/', '.')] |= items
            for tgt, items in fr.items():
                if tgt.startswith(PREFIXES):
                    fieldrefs[tgt.replace('/', '.')] |= items
        z.close()

    # 对现有 stub 类统计缺失方法
    print('=== 现有 stub 上被调用但可能未声明的方法 ===')
    total_missing = 0
    for cls in sorted(existing):
        src = existing[cls]
        if '$' in cls:
            continue
        simple = cls.split('.')[-1]
        mrs = methodrefs.get(cls, set())
        frs = fieldrefs.get(cls, set())
        missing_m = []
        for name, desc in sorted(mrs):
            if name == '<init>':
                continue
            # 粗略检查：方法名是否出现在源码中
            if re.search(r'\b' + re.escape(name) + r'\s*\(', src):
                continue
            missing_m.append((name, desc))
        missing_f = []
        for name, desc in sorted(frs):
            if re.search(r'\b' + re.escape(name) + r'\b', src):
                continue
            missing_f.append((name, desc))
        if missing_m or missing_f:
            total_missing += len(missing_m) + len(missing_f)
            print(f'\n{cls}:')
            for name, desc in missing_m[:12]:
                print(f'  M {name}{desc}')
                if len(missing_m) > 12:
                    print(f'  ... +{len(missing_m)-12} more')
                    break
            for name, desc in missing_f[:8]:
                print(f'  F {name} {desc}')
    print(f'\ntotal missing members: {total_missing}')


if __name__ == '__main__':
    main()
