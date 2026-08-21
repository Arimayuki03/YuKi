# -*- coding: utf-8 -*-
"""端到端 JAR 桥测试：java 可用时真实加载本地测试 jar 跑完整五方法。

依赖 JDK（JAVA_HOME 或 PATH）；无 JDK 时跳过（不视为失败）。
用法：<venv>/python tests/test_jar_e2e.py
"""
import os
import glob
import shutil
import subprocess
import sys
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import hoststate  # noqa: E402

hoststate.configure(port=18555, token='e2e')
hoststate.ensure_dirs()

import java_probe  # noqa: E402
from jar_bridge import JarBridge  # noqa: E402
from jar_spider import make_jar_spider_class  # noqa: E402

RUNNER = os.path.join(BASE, '..', 'vendor', 'spider-runner.jar')
TEST_JAR = os.path.join(BASE, 'jar-runner', 'test-spider.jar')
TEST_BUILD = os.path.join(BASE, 'jar-runner', 'test-build')
TEST_SOURCES = [os.path.join(BASE, 'jar-runner', 'TestSpider.java')]
TEST_SOURCES.extend(glob.glob(os.path.join(
    BASE, 'jar-runner', 'test-parser', '**', '*.java'), recursive=True))

PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print(f'[PASS] {name}')
    else:
        FAILED.append(name)
        print(f'[FAIL] {name} {detail}')


def ensure_test_jar():
    """Build the source fixture when a JDK is available.

    The generated jar stays ignored, but the type-2 parser source and the
    recipe are versioned so a clean checkout cannot accidentally exercise an
    old local binary or silently omit the Json extension contract.
    """
    latest_source = max((os.path.getmtime(path) for path in TEST_SOURCES), default=0)
    if os.path.isfile(TEST_JAR) and os.path.getmtime(TEST_JAR) >= latest_source:
        return True
    javac = shutil.which('javac')
    if not javac:
        return os.path.isfile(TEST_JAR)
    shutil.rmtree(TEST_BUILD, ignore_errors=True)
    os.makedirs(TEST_BUILD, exist_ok=True)
    try:
        proc = subprocess.run(
            [javac, '-encoding', 'UTF-8', '-d', TEST_BUILD, *TEST_SOURCES],
            capture_output=True, text=True, timeout=30, check=False)
        if proc.returncode != 0:
            print('FAIL: test-spider.jar compile failed')
            print((proc.stderr or proc.stdout or '')[:2000])
            return False
        with zipfile.ZipFile(TEST_JAR, 'w', zipfile.ZIP_DEFLATED) as archive:
            for root, _dirs, files in os.walk(TEST_BUILD):
                for name in files:
                    if name.endswith('.class'):
                        path = os.path.join(root, name)
                        archive.write(path, os.path.relpath(path, TEST_BUILD))
        return True
    finally:
        shutil.rmtree(TEST_BUILD, ignore_errors=True)


def main():
    java_probe.clear_cache()
    if not java_probe.find_java():
        print('SKIP: no java runtime, e2e test skipped')
        sys.exit(0)
    if not os.path.isfile(RUNNER):
        print(f'SKIP: spider-runner.jar missing ({RUNNER})')
        sys.exit(0)
    if not ensure_test_jar():
        print(f'FAIL: test-spider.jar missing or could not be built ({TEST_JAR})')
        sys.exit(1)

    bridge = JarBridge.get_or_create(TEST_JAR, runner_jar=RUNNER)
    spider = make_jar_spider_class('e2e', bridge, 'E2E', 'TestSpider')
    spider.init('e2e-ext')

    home = spider.homeContent(True)
    check('e2e homeContent', home.get('class', [{}])[0].get('type_name') == '测试分类', str(home)[:120])

    sr = spider.searchContent('海贼王', True, '1')
    check('e2e searchContent', sr['list'][0]['vod_name'] == '海贼王测试结果', str(sr)[:120])

    dc = spider.detailContent(['e2e-9'])
    check('e2e detailContent', dc['list'][0]['vod_id'] == 'e2e-9'
          and 'ep1$http://test/v.mp4' in dc['list'][0]['vod_play_url'], str(dc)[:150])

    pc = spider.playerContent('test', 'http://x/v.mp4', [])
    check('e2e playerContent', pc['url'] == 'http://x/v.mp4' and pc['parse'] == 0, str(pc)[:120])

    ext = spider.jsonExt('Demo', {'json': 'https://jx.test/?url='}, 'episode-id')
    check('e2e parse type2 Json extension', 'type2.mp4?source=episode-id' in ext
          and '"jxCount":1' in ext, str(ext)[:160])

    # destroy 是终态：runner 应答后自行退出，进程退出属于正常语义（不视为失败）
    spider.destroy()
    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
