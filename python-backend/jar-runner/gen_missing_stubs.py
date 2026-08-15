# -*- coding: utf-8 -*-
"""为所有 -jvm.jar 缺失的 android.* / androidx.* / com.google.android.gms.* 类生成最小 stub。

- 缺失类清单来自常量池完整扫描（scan_missing.py 的逻辑）。
- 方法/字段按 jar 中的 methodref/fieldref 生成（签名一致），方法体抛 UnsupportedOperationException。
- 接口若被 jar 类 implements，按接口生成（空方法或 methodref 签名）。
- 嵌套类（名字含 $）生成顶层文件（JVM 按二进制名解析，等价可用）。
"""
import os, sys, glob, zipfile, re, struct
from collections import defaultdict

HOME = os.path.expanduser('~')
JAR_DIR = os.path.join(HOME, '.video-pc', 'cache', 'jar')
HERE = os.path.dirname(os.path.abspath(__file__))
STUBS_DIR = os.path.join(HERE, 'stubs')

PREFIXES = ('android/', 'com/github/catvod/crawler/', 'androidx/', 'com/google/android/gms/')

# 已知真实 Android 接口方法集（防止"接口声明了实现类没有的方法"导致加载失败）
KNOWN_INTERFACE_METHODS = {
    'android.app.Application$ActivityLifecycleCallbacks': [
        'void onActivityCreated(android.app.Activity activity, android.os.Bundle savedInstanceState)',
        'void onActivityStarted(android.app.Activity activity)',
        'void onActivityResumed(android.app.Activity activity)',
        'void onActivityPaused(android.app.Activity activity)',
        'void onActivityStopped(android.app.Activity activity)',
        'void onActivitySaveInstanceState(android.app.Activity activity, android.os.Bundle outState)',
        'void onActivityDestroyed(android.app.Activity activity)',
    ],
    'android.content.ComponentCallbacks2': [
        'void onTrimMemory(int level)',
        'void onConfigurationChanged(android.content.res.Configuration newConfig)',
        'void onLowMemory()',
    ],
    'android.content.DialogInterface$OnCancelListener': ['void onCancel(android.content.DialogInterface dialog)'],
    'android.content.DialogInterface$OnClickListener': ['void onClick(android.content.DialogInterface dialog, int which)'],
    'android.content.DialogInterface$OnDismissListener': ['void onDismiss(android.content.DialogInterface dialog)'],
    'android.content.DialogInterface$OnShowListener': ['void onShow(android.content.DialogInterface dialog)'],
    'android.os.Parcelable$Creator': [
        'java.lang.Object createFromParcel(android.os.Parcel source)',
        'java.lang.Object[] newArray(int size)',
    ],
    'android.animation.ValueAnimator$AnimatorUpdateListener': ['void onAnimationUpdate(android.animation.ValueAnimator animation)'],
    'android.view.View$OnUnhandledKeyEventListener': ['boolean onUnhandledKeyEvent(android.view.View v, android.view.KeyEvent event)'],
    'android.location.LocationListener': [
        'void onLocationChanged(android.location.Location location)',
        'void onStatusChanged(java.lang.String provider, int status, android.os.Bundle extras)',
        'void onProviderEnabled(java.lang.String provider)',
        'void onProviderDisabled(java.lang.String provider)',
    ],
    'android.view.WindowInsetsController$OnControllableInsetsChangedListener': [
        'void onControllableInsetsChanged(android.view.WindowInsetsController controller, int typeMask)',
    ],
    'androidx.core.util.Consumer': ['void accept(java.lang.Object t)'],
    'androidx.core.util.Predicate': ['boolean test(java.lang.Object t)'],
}

EXCEPTION_SUPER = {
    'android.content.ActivityNotFoundException': 'java.lang.RuntimeException',
    'android.os.BadParcelableException': 'java.lang.RuntimeException',
    'android.os.DeadObjectException': 'android.os.RemoteException',
}

PRIM = {'I': 'int', 'Z': 'boolean', 'J': 'long', 'F': 'float', 'D': 'double',
        'B': 'byte', 'C': 'char', 'S': 'short', 'V': 'void'}


def parse_cp(data):
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
        elif tag in (9, 10, 11, 12):
            a = struct.unpack('>H', data[pos:pos+2])[0]
            b = struct.unpack('>H', data[pos+2:pos+4])[0]
            cp[i] = (tag, a, b); pos += 4
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

    methodrefs = defaultdict(set)
    fieldrefs = defaultdict(set)
    classrefs = set()
    static_methods = set()  # (target_dot, name, desc) 被 invokestatic 调用
    static_fields = set()   # (target_dot, name, desc) 被 getstatic/putstatic 访问

    def ref_info(idx):
        e = cp[idx] if 0 < idx < cp_count else None
        if e and e[0] in (9, 10, 11):
            target = cls_name(e[1])
            nat = cp[e[2]] if e[2] < cp_count else None
            if target and nat and nat[0] == 12:
                name = utf(nat[1])
                desc = utf(nat[2])
                if name and desc:
                    return target, name, desc
        return None

    for idx, e in enumerate(cp):
        if not e:
            continue
        if e[0] == 'cls':
            nm = utf(e[1])
            if nm:
                classrefs.add(nm)
        elif e[0] in (9, 10, 11):
            info = ref_info(idx)
            if info:
                tgt, name, desc = info
                (fieldrefs if e[0] == 9 else methodrefs)[tgt].add((name, desc))

    # ---- 遍历 Code 属性字节码，找出 invokestatic/getstatic/putstatic ----
    # 操作码操作数长度分类
    OP0 = (set(range(0x00, 0x10)) | set(range(0x1A, 0x36)) | set(range(0x3B, 0x84)) |
           set(range(0x85, 0x99)) | {0xA9} | set(range(0xAC, 0xB2)) | {0xBE, 0xBF} |
           set(range(0xC2, 0xC5)) | {0xCA} | set(range(0xCB, 0xFE)))
    OP1 = {0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3A, 0xBC}
    OP2 = ({0x11, 0x13, 0x14, 0x84} | set(range(0x99, 0xA9)) | set(range(0xB2, 0xB9)) |
           {0xBB, 0xBD, 0xC0, 0xC1, 0xC6, 0xC7, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
            0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF, 0xE0, 0xE1, 0xE2, 0xE3,
            0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF,
            0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFB,
            0xFC, 0xFD, 0xFE, 0xFF})
    OP3 = {0xC5}
    OP4 = {0xB9, 0xBA}
    OP5 = {0xC8, 0xC9}

    def walk_code(code):
        j = 0
        n = len(code)
        while j < n:
            op = code[j]
            if op == 0xB8:  # invokestatic
                idx = struct.unpack('>H', code[j+1:j+3])[0]
                info = ref_info(idx)
                if info:
                    static_methods.add((info[0].replace('/', '.'), info[1], info[2]))
                j += 3
            elif op in (0xB2, 0xB3):  # getstatic/putstatic
                idx = struct.unpack('>H', code[j+1:j+3])[0]
                info = ref_info(idx)
                if info:
                    static_fields.add((info[0].replace('/', '.'), info[1], info[2]))
                j += 3
            elif op == 0xAA:  # tableswitch
                pad = (4 - ((j + 1) % 4)) % 4
                p = j + 1 + pad
                if p + 12 > n:
                    break
                low = struct.unpack('>i', code[p+4:p+8])[0]
                high = struct.unpack('>i', code[p+8:p+12])[0]
                j = p + 12 + max(0, high - low + 1) * 4
            elif op == 0xAB:  # lookupswitch
                pad = (4 - ((j + 1) % 4)) % 4
                p = j + 1 + pad
                if p + 8 > n:
                    break
                npairs = struct.unpack('>i', code[p+4:p+8])[0]
                j = p + 8 + max(0, npairs) * 8
            elif op in OP0:
                j += 1
            elif op in OP1:
                j += 2
            elif op in OP2:
                j += 3
            elif op in OP3:
                j += 4
            elif op in OP4:
                j += 5
            elif op in OP5:
                j += 6
            else:
                j += 1

    def skip_attrs(p):
        cnt = struct.unpack('>H', data[p:p+2])[0]; p += 2
        for _ in range(cnt):
            alen = struct.unpack('>I', data[p+2:p+6])[0]
            p += 6 + alen
        return p

    try:
        p = pos  # 常量池结束 = access/this/super/interfaces 起点
        p += 2 + 2 + 2
        icnt = struct.unpack('>H', data[p:p+2])[0]; p += 2 + 2 * icnt
        fcnt = struct.unpack('>H', data[p:p+2])[0]; p += 2
        for _ in range(fcnt):
            p += 6
            p = skip_attrs(p)
        mcnt = struct.unpack('>H', data[p:p+2])[0]; p += 2
        for _ in range(mcnt):
            p += 6
            acnt = struct.unpack('>H', data[p:p+2])[0]; p += 2
            for _ in range(acnt):
                aname = utf(struct.unpack('>H', data[p:p+2])[0])
                alen = struct.unpack('>I', data[p+2:p+6])[0]
                ap = p + 6
                if aname == 'Code' and alen >= 8:
                    clen = struct.unpack('>I', data[ap+4:ap+8])[0]
                    walk_code(data[ap+8:ap+8+clen])
                p = ap + alen
    except Exception:
        pass
    return methodrefs, fieldrefs, classrefs, static_methods, static_fields


def collect_existing():
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
                params.append(ret[j+1:k].replace('/', '.') + '[]' * (j - i + 1))
                i = k + 1
            else:
                params.append(PRIM[ret[j]] + '[]' * (j - i + 1))
                i = j + 1
        else:
            params.append(PRIM[c])
            i += 1
    r = rest
    if r.startswith('L') and r.endswith(';'):
        r = r[1:-1].replace('/', '.')
    elif r.startswith('['):
        j = 0
        while r[j] == '[':
            j += 1
        if r[j] == 'L':
            k = r.index(';')
            r = r[j+1:k].replace('/', '.') + '[]' * j
        else:
            r = PRIM[r[j]] + '[]' * j
    elif r in PRIM:
        r = PRIM[r]
    return r, params


def desc_to_type(desc):
    """字段描述符 -> Java 类型（全限定名）。"""
    d = desc
    arr = 0
    while d.startswith('['):
        arr += 1
        d = d[1:]
    if d.startswith('L') and d.endswith(';'):
        t = d[1:-1].replace('/', '.')
    else:
        t = PRIM[d]
    return t + '[]' * arr


def gen_class_file(full_cls, kind, methodrefs, fieldrefs, static_methods=None, static_fields=None):
    """生成一个顶层 stub 源文件内容。"""
    static_methods = static_methods or set()
    static_fields = static_fields or set()
    # androidx/gms 类只用于类加载（几乎不会被调用），且其方法签名含 jar 内部混淆类型，
    # 无法在 runner 侧编译 → 生成空类型。
    if full_cls.startswith(('androidx.', 'com.google.android.gms.')):
        pkg, _, simple = full_cls.rpartition('.')
        return (f'package {pkg};\n\n/** Auto-generated stub for {full_cls}. */\n'
                f'public {"interface " if kind == "interface" else "class "}{simple} '
                f'{{ }}\n')
    pkg, _, simple = full_cls.rpartition('.')
    lines = [f'package {pkg};', '']
    lines.append(f'/** Auto-generated stub for {full_cls}. */')
    if kind == 'interface':
        lines.append(f'public interface {simple} {{')
        body = []
        for name, desc in sorted(methodrefs):
            if name == '<init>' or name == '<clinit>':
                continue
            ret, params = desc_to_java(desc)
            ps = ', '.join(f'{t} p{i}' for i, t in enumerate(params))
            body.append(f'    {ret} {name}({ps});')
        for sig in KNOWN_INTERFACE_METHODS.get(full_cls, []):
            if not any(sig.split('(')[0].endswith(' ' + m.split('(')[0].split(' ')[-1]) for m in body):
                body.append('    ' + sig + ';')
        if not body:
            body.append('    // marker interface')
        lines.extend(body)
        lines.append('}')
    else:
        sup = EXCEPTION_SUPER.get(full_cls, 'java.lang.Object')
        if full_cls == 'android.os.Binder':
            sup = 'java.lang.Object'
        if full_cls == 'android.app.DialogFragment':
            sup = 'android.app.Fragment'
        if full_cls == 'android.app.Fragment':
            sup = 'java.lang.Object'
        if full_cls == 'android.content.BroadcastReceiver':
            sup = 'java.lang.Object'
        if full_cls == 'android.content.ContentProvider':
            sup = 'java.lang.Object'
        abstract = 'abstract ' if full_cls == 'android.os.Binder' else ''
        lines.append(f'public {abstract}class {simple} extends {sup} {{')
        # 字段（被 getstatic/putstatic 访问的生成 static；其余按实例字段）
        for name, desc in sorted(fieldrefs):
            if name in ('<init>', '<clinit>'):
                continue
            t = desc_to_type(desc)
            mod = 'static ' if (name, desc) in static_fields else ''
            lines.append(f'    public {mod}{t} {name};')
        # 方法（被 invokestatic 调用的生成 static）
        for name, desc in sorted(methodrefs):
            if name == '<clinit>':
                continue
            if name == '<init>':
                ret, params = desc_to_java(desc)
                ps = ', '.join(f'{t} p{i}' for i, t in enumerate(params))
                lines.append(f'    public {simple}({ps}) {{ }}')
                continue
            ret, params = desc_to_java(desc)
            ps = ', '.join(f'{t} p{i}' for i, t in enumerate(params))
            mod = 'static ' if (name, desc) in static_methods else ''
            if full_cls == 'android.os.Binder' and name in ('queryLocalInterface', 'transact', 'isBinderAlive',
                                                             'linkToDeath', 'unlinkToDeath', 'dump', 'getInterfaceDescriptor',
                                                             'pingBinder'):
                default = 'null'
                if ret == 'boolean':
                    default = 'false'
                elif ret == 'int':
                    default = '0'
                lines.append(f'    public {mod}{ret} {name}({ps}) {{ return {default}; }}')
                continue
            # 生成的方法体默认"良性降级"（不抛异常）：避免真实执行路径被 UnsupportedOperationException 打断
            if ret == 'void':
                body = '{ }'
            elif ret in ('boolean', 'int', 'long', 'float', 'double', 'short', 'byte', 'char'):
                body = f'{{ return 0; }}'
                if ret == 'boolean':
                    body = '{ return false; }'
                elif ret == 'char':
                    body = '{ return \'\\0\'; }'
            else:
                body = '{ return null; }'
            lines.append(f'    public {mod}{ret} {name}({ps}) {body}')
        lines.append('}')
    return '\n'.join(lines) + '\n'


def desc_types(desc):
    """从描述符中提取所有引用类型（L...;）。"""
    out = set()
    for m in re.finditer(r'L([A-Za-z0-9_$/\-]+);', desc):
        out.add(m.group(1))
    return out


def main():
    force = '--force' in sys.argv
    existing = collect_existing()
    if force:
        # --force：把已自动生成的 stub 视为缺失（重新生成，吸收方法/字段引用）
        for f in glob.iglob(os.path.join(STUBS_DIR, '**', '*.java'), recursive=True):
            with open(f, encoding='utf-8', errors='replace') as fh:
                src = fh.read()
            if 'Auto-generated stub for' in src:
                pkg = 'android'
                m = re.search(r'package\s+([\w.]+)\s*;', src)
                if m:
                    pkg = m.group(1)
                outer_file = os.path.splitext(os.path.basename(f))[0]
                existing.discard(pkg + '.' + outer_file)
    jars = sorted(glob.glob(os.path.join(JAR_DIR, '*-jvm.jar')))
    methodrefs = defaultdict(set)
    fieldrefs = defaultdict(set)
    classrefs = defaultdict(set)
    static_methods = defaultdict(set)  # target_dot -> {(name, desc)}
    static_fields = defaultdict(set)
    used_as_interface = set()
    used_as_super = set()
    for j in jars:
        z = zipfile.ZipFile(j)
        for n in z.namelist():
            if not n.endswith('.class'):
                continue
            r = parse_cp(z.read(n))
            if not r:
                continue
            mr, fr, cr, smr, sfr = r
            for tgt, items in mr.items():
                if tgt.startswith(PREFIXES):
                    methodrefs[tgt.replace('/', '.')] |= items
                    for name, desc in items:
                        for t in desc_types(desc):
                            if t.startswith(PREFIXES):
                                classrefs[t.replace('/', '.')].add(n)
            for tgt, items in fr.items():
                if tgt.startswith(PREFIXES):
                    fieldrefs[tgt.replace('/', '.')] |= items
                    for name, desc in items:
                        for t in desc_types(desc):
                            if t.startswith(PREFIXES):
                                classrefs[t.replace('/', '.')].add(n)
            for ref in cr:
                if ref.startswith(PREFIXES):
                    classrefs[ref.replace('/', '.')].add(n)
            for tgt, name, desc in smr:
                if tgt.startswith(('android.', 'com.github.catvod.crawler.', 'androidx.', 'com.google.android.gms.')):
                    static_methods[tgt].add((name, desc))
            for tgt, name, desc in sfr:
                if tgt.startswith(('android.', 'com.github.catvod.crawler.', 'androidx.', 'com.google.android.gms.')):
                    static_fields[tgt].add((name, desc))
        z.close()
    # 二次扫描确定 interface/super 用法
    for j in jars:
        z = zipfile.ZipFile(j)
        for n in z.namelist():
            if not n.endswith('.class'):
                continue
            data = z.read(n)
            # 粗解析 super/ifaces（复用 scan_missing 的解析）
            try:
                import scan_missing as sm
                info = sm.parse_class(data)
                if info:
                    if info[1] and info[1].startswith(PREFIXES):
                        used_as_super.add(info[1].replace('/', '.'))
                    for f in info[2]:
                        if f.startswith(PREFIXES):
                            used_as_interface.add(f.replace('/', '.'))
            except Exception:
                pass
        z.close()

    missing = sorted(k for k in classrefs if k not in existing)
    print(f'missing: {len(missing)}')
    written = 0
    for cls in missing:
        kind = 'interface' if cls in used_as_interface else 'class'
        # 异常类默认 class；被 extends 的默认 class
        pkg, _, simple = cls.rpartition('.')
        pkg_dir = os.path.join(STUBS_DIR, *pkg.split('.'))
        os.makedirs(pkg_dir, exist_ok=True)
        fp = os.path.join(pkg_dir, simple + '.java')
        if os.path.isfile(fp):
            with open(fp, encoding='utf-8', errors='replace') as fh:
                existing_src = fh.read()
            if 'Auto-generated stub for' not in existing_src:
                print(f'skip existing file (not auto-generated): {fp}')
                continue
        src = gen_class_file(cls, kind, methodrefs.get(cls, set()), fieldrefs.get(cls, set()),
                             static_methods.get(cls, set()), static_fields.get(cls, set()))
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(src)
        written += 1
        print(f'  + {cls} [{kind}]')
    print(f'written: {written}')


if __name__ == '__main__':
    main()
