#!/usr/bin/env python3
"""Build spider-runner.jar from SpiderRunner.java + stubs.

Requires JDK 8+ (javac + jar) on PATH or JAVA_HOME.
Output: python-backend/jar-runner/runner.jar (copied to vendor/spider-runner.jar)
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, '..', '..')
VENDOR_DIR = os.path.join(BASE, 'vendor')
OUTPUT_JAR = os.path.join(HERE, 'runner.jar')
# Windows 桌面沙箱/企业策略有时会把 %TEMP% 新建目录标成不可写，导致
# ``tempfile.TemporaryDirectory`` 在 javac 前就失败。构建目录只存放 class
# 中间产物，位于源码目录且已在 .gitignore 中排除，构建完成后清理。
BUILD_ROOT = os.path.join(HERE, 'build-tmp')

# 查找 javac
def find_javac():
    jh = os.environ.get('JAVA_HOME', '')
    if jh:
        jc = os.path.join(jh, 'bin', 'javac.exe' if os.name == 'nt' else 'javac')
        if os.path.isfile(jc):
            return jc
    w = shutil.which('javac')
    if w:
        return w
    return None


def find_jar():
    jh = os.environ.get('JAVA_HOME', '')
    if jh:
        jr = os.path.join(jh, 'bin', 'jar.exe' if os.name == 'nt' else 'jar')
        if os.path.isfile(jr):
            return jr
    w = shutil.which('jar')
    if w:
        return w
    return None


def main():
    javac = find_javac()
    if not javac:
        print('ERROR: javac not found. Install JDK 8+ or set JAVA_HOME.')
        sys.exit(1)

    # 收集所有 .java 源文件
    sources = [os.path.join(HERE, 'SpiderRunner.java')]
    stubs = glob.glob(os.path.join(HERE, 'stubs', '**', '*.java'), recursive=True)
    sources.extend(stubs)
    source_list = [s for s in sources if os.path.isfile(s)]
    if not source_list:
        print('ERROR: no source files found')
        sys.exit(1)

    build_dir = BUILD_ROOT
    shutil.rmtree(build_dir, ignore_errors=True)
    os.makedirs(build_dir, exist_ok=True)
    try:
        # 编译：stub 源码可引用 dexdeps（okhttp3/org.json 等），
        # 使 Spider.safeDns()/client() 等方法的签名与 jar 期望完全一致
        deps_dir = os.path.join(VENDOR_DIR, 'dexdeps')
        deps = [os.path.join(deps_dir, f) for f in os.listdir(deps_dir) if f.endswith('.jar')] \
            if os.path.isdir(deps_dir) else []
        classpath = os.pathsep.join([os.path.join(HERE, 'stubs'), build_dir] + deps)
        cmd = [javac, '-encoding', 'UTF-8', '-d', build_dir, '-cp', classpath]
        cmd.extend(source_list)
        print('Compiling...')
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print('COMPILE ERROR:')
            print(r.stderr or r.stdout)
            sys.exit(1)
        print('Compile OK')

        # 打包 jar
        jar_bin = find_jar()
        if jar_bin:
            cmd = [jar_bin, 'cfe', OUTPUT_JAR, 'SpiderRunner', '-C', build_dir, '.']
            subprocess.run(cmd, check=True, capture_output=True)
        else:
            # 用 zipfile 创建 jar（jar 本质是 zip + MANIFEST.MF）
            print('jar tool not found, creating via zipfile...')
            manifest = 'Manifest-Version: 1.0\nMain-Class: SpiderRunner\n\n'
            with zipfile.ZipFile(OUTPUT_JAR, 'w', zipfile.ZIP_DEFLATED) as zf:
                zf.writestr('META-INF/MANIFEST.MF', manifest)
                for root, dirs, files in os.walk(build_dir):
                    for fn in files:
                        if not fn.endswith('.class'):
                            continue
                        full = os.path.join(root, fn)
                        arcname = os.path.relpath(full, build_dir)
                        zf.write(full, arcname)

        print(f'runner.jar built: {OUTPUT_JAR}')

        # 复制到 vendor/
        os.makedirs(VENDOR_DIR, exist_ok=True)
        vendor_dest = os.path.join(VENDOR_DIR, 'spider-runner.jar')
        shutil.copy2(OUTPUT_JAR, vendor_dest)
        print(f'copied to: {vendor_dest}')
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
