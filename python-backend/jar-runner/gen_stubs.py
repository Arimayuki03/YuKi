#!/usr/bin/env python3
"""从转换后的 jar 中提取缺失的 Android 类引用，自动生成 minimal stub .java 文件。

读取每个 spider .class 的常量池，对每个引用的 android.* 类：
1. 确定它的父类（从该类在 jar 中的常量池或上下文推断）
2. 如果是接口，生成 interface stub
3. 否则生成 class stub（extends 推断的父类，空方法体）
4. 排除已有 stubs 的类
"""
import os, re, glob, json
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
STUBS_DIR = os.path.join(HERE, 'stubs')
JAR = os.path.expanduser('~/.video-pc/cache/jar/fm-jvm.jar')

# 已存在的 stubs（包名.类名）
existing = set()
for f in glob.iglob(os.path.join(STUBS_DIR, '**', '*.java'), recursive=True):
    pkg = 'android'
    with open(f, encoding='latin1') as fh:
        for line in fh:
            if line.startswith('package '):
                pkg = line.strip().rstrip(';').split()[1]
                break
    name = os.path.splitext(os.path.basename(f))[0]
    existing.add(pkg + '.' + name)

# 从 jar 中解析所有对 android.* 的引用
refs = {}
z = zipfile.ZipFile(JAR)
for n in z.namelist():
    if not n.endswith('.class'):
        continue
    data = z.read(n)
    # 从常量池提取 superclass
    txt = data.decode('latin1')
    # 找出所有 android.* 引用
    for m in re.finditer(rb'L(android/[A-Za-z_\$][A-Za-z0-9_\$/\-]*);', data):
        cls = m.group(1).decode('latin1').replace('/', '.')
        if cls not in existing:
            refs[cls] = refs.get(cls, 0) + 1

# 父类未知的——全部设为 Object
# 对于 android.view.View 等已在 jar 中使用的超类，从字节码中提取
superclass_map = {}

# 对于每个 android.* 类，尝试从使用它的类的字节码中推断父类
# 简单策略：从 spider 类的常量池属性中找 superclass 引用
for n in z.namelist():
    if not n.endswith('.class'):
        continue
    data = z.read(n)
    txt = data.decode('latin1')
    # 超类引用在常量池中表现为 "classname" 后跟 super: 标志
    # 更简单的方法：看该类是否 extends 另一个 android 类
    # 从类的名称看它的包——如果类名以 android/ 开头，读取它的常量池找 super
    if n.startswith('android/'):
        cls_name = n.replace('/', '.').replace('.class', '')
        # 尝试从字节码查找 super_class_index
        # 在 .class 文件中，偏移 4+2 字节是常量池计数，解析太复杂
        # 使用简单启发式：在文本中找父类名
        for m in re.finditer(rb'L(android/[A-Za-z_\$][A-Za-z0-9_\$/\-]*);', data):
            candidate = m.group(1).decode('latin1').replace('/', '.')
            if candidate != cls_name:
                superclass_map[cls_name] = candidate
                break

z.close()
# 只保留 missing 的
missing = [cls for cls in refs if cls not in existing]
print(f'Missing top-level: {len(missing)}')

# 按包分组
from collections import defaultdict
by_pkg = defaultdict(list)
for cls in missing:
    *pkg_parts, name = cls.split('.')
    pkg = '.'.join(pkg_parts)
    by_pkg[pkg].append(name)

# 生成 stub
generated = 0
for pkg, names in sorted(by_pkg.items()):
    pkg_dir = os.path.join(STUBS_DIR, *pkg.split('.'))
    os.makedirs(pkg_dir, exist_ok=True)
    for name in sorted(names):
        full_cls = pkg + '.' + name
        super_cls = superclass_map.get(full_cls, '')
        # 避免循环继承
        if super_cls and super_cls.startswith('android.'):
            super_short = super_cls[len(pkg)+1:] if super_cls.startswith(pkg) else super_cls
        else:
            super_short = ''
        fp = os.path.join(pkg_dir, name + '.java')
        if os.path.isfile(fp):
            continue
        lines = [f'package {pkg};', '']
        lines.append(f'/** Auto-generated stub for {full_cls}. */')
        if super_short:
            lines.append(f'public class {name} extends {super_short} {{')
        else:
            lines.append(f'public class {name} {{')
        lines.append('}')
        with open(fp, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
        generated += 1
        if generated <= 10:
            print(f'  generated: {full_cls} extends {super_short or "Object"}')

print(f'\nGenerated {generated} stubs')