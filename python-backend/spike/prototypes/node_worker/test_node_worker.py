# -*- coding: utf-8 -*-
"""
node_worker 综合验证套件：
1. MockHttpServer 启动与 4 套 fixture 规则全流程验证 (home, category, search, detail, play)
2. 安全沙箱验证：阻止 child_process 执行，阻止任意文件系统越界访问
3. 超时强杀机制验证 (timeout kill)
4. 内存超限检测机制验证 (memory limit check)
"""

import os
import sys
import time

# 路径定位
CURR_DIR = os.path.dirname(os.path.abspath(__file__))
SPIKE_DIR = os.path.abspath(os.path.join(CURR_DIR, '..', '..'))
BACKEND_DIR = os.path.abspath(os.path.join(SPIKE_DIR, '..'))

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
if SPIKE_DIR not in sys.path:
    sys.path.insert(0, SPIKE_DIR)

from fixtures.mock_server import MockHttpServer, patch_host
from spike.prototypes.node_worker import (
    NodeSupervisor,
    NodeWorkerSpider,
    NodeWorkerTimeoutError,
    NodeWorkerMemoryLimitError,
    make_node_worker_spider,
)

FIXTURES_DIR = os.path.join(SPIKE_DIR, 'fixtures')


def test_fixture_rules():
    print("\n[TEST 1] Testing 4 drpy fixture rules with NodeWorkerSpider...")
    results = {}
    with MockHttpServer() as srv:
        base_url = srv.get_url()
        rules = [
            'rule1_simple_cms.js',
            'rule2_crypto_auth.js',
            'rule3_template_eval.js',
            'rule4_stateful_local.js'
        ]

        for rule_name in rules:
            path = os.path.join(FIXTURES_DIR, rule_name)
            with open(path, 'r', encoding='utf-8') as f:
                src = f.read()
            src = patch_host(src, base_url)

            spider = make_node_worker_spider(
                key=rule_name.replace('.js', ''),
                rule_source=src,
                name=rule_name
            )

            try:
                spider.init()
                # 1. home
                home_res = spider.homeContent(False)
                assert isinstance(home_res, dict), f"homeContent not dict: {type(home_res)}"
                assert 'class' in home_res and 'list' in home_res, "homeContent missing class/list"

                # 2. category
                tid = home_res['class'][0]['type_id'] if home_res['class'] else '1'
                cate_res = spider.categoryContent(tid, '1', False, {})
                assert isinstance(cate_res, dict), f"categoryContent not dict: {type(cate_res)}"
                assert 'list' in cate_res, "categoryContent missing list"

                # 3. detail
                vod_id = cate_res['list'][0]['vod_id'] if cate_res['list'] else '1001'
                detail_res = spider.detailContent(vod_id)
                assert isinstance(detail_res, dict), f"detailContent not dict: {type(detail_res)}"
                assert 'list' in detail_res and len(detail_res['list']) > 0, "detailContent list empty"

                # 4. search
                search_res = spider.searchContent("测试", False, '1')
                assert isinstance(search_res, dict), f"searchContent not dict: {type(search_res)}"
                assert 'list' in search_res, "searchContent missing list"

                # 5. play
                play_res = spider.playerContent('f1', '/cms/play/x.m3u8')
                assert isinstance(play_res, dict), f"playerContent not dict: {type(play_res)}"
                assert 'url' in play_res, "playerContent missing url"

                results[rule_name] = {'status': 'PASS', 'detail': f"class_count={len(home_res.get('class', []))}, items={len(cate_res.get('list', []))}"}
            except Exception as e:
                results[rule_name] = {'status': 'FAIL', 'error': str(e)}
            finally:
                spider.destroy()

        hits = srv.hits()
        print(f"Mock server hits summary: {hits}")

    all_passed = True
    for rname, res in results.items():
        print(f"  [{res['status']}] {rname}: {res.get('detail') or res.get('error')}")
        if res['status'] != 'PASS':
            all_passed = False
    return all_passed


def test_security_sandbox():
    print("\n[TEST 2] Testing security sandbox isolation (child_process and arbitrary fs)...")
    
    # 1. 尝试执行外部命令 (child_process)
    malicious_cmd_rule = """
    var rule = {
        home: function() {
            var cp = require('child_process');
            return cp.execSync('whoami').toString();
        }
    };
    """
    sup = NodeSupervisor()
    try:
        sup.start()
        blocked_cp = False
        try:
            sup.load_rule(malicious_cmd_rule)
            sup.call_rpc('home')
        except Exception as e:
            blocked_cp = True
            print(f"  [PASS] Blocked child_process: {e}")
        assert blocked_cp, "child_process was not blocked!"
    finally:
        sup.destroy()

    # 2. 尝试越界访问敏感文件
    malicious_fs_rule = """
    var rule = {
        home: function() {
            var fs = require('fs');
            return fs.readFileSync('C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts', 'utf8');
        }
    };
    """
    sup = NodeSupervisor()
    try:
        sup.start()
        blocked_fs = False
        try:
            sup.load_rule(malicious_fs_rule)
            sup.call_rpc('home')
        except Exception as e:
            blocked_fs = True
            print(f"  [PASS] Blocked arbitrary file access: {e}")
        assert blocked_fs, "Arbitrary fs access was not blocked!"
    finally:
        sup.destroy()

    return True


def test_timeout_kill():
    print("\n[TEST 3] Testing worker timeout enforcement and SIGKILL...")
    infinite_loop_rule = """
    var rule = {
        home: function() {
            var start = Date.now();
            while (Date.now() - start < 10000) {} // 死循环 10s
            return "ok";
        }
    };
    """
    sup = NodeSupervisor(timeout=1.5)
    killed = False
    try:
        sup.start()
        sup.load_rule(infinite_loop_rule)
        try:
            sup.call_rpc('home')
        except NodeWorkerTimeoutError as e:
            killed = True
            print(f"  [PASS] Successfully killed worker on timeout: {e}")
        assert killed, "Timeout was not triggered!"
        assert not sup.is_alive(), "Worker process should be terminated after timeout!"
    finally:
        sup.destroy()
    return True


def test_memory_limit():
    print("\n[TEST 4] Testing worker memory limit detection...")
    mem_leak_rule = """
    var leak = [];
    var rule = {
        home: function() {
            for (var i = 0; i < 200000; i++) {
                leak.push(new Array(1000).fill('memory_leak_string_payload_data'));
            }
            return JSON.stringify({ count: leak.length });
        }
    };
    """
    # 限制 50MB 内存
    sup = NodeSupervisor(max_memory_mb=50.0, timeout=10.0)
    mem_killed = False
    try:
        sup.start()
        sup.load_rule(mem_leak_rule)
        try:
            sup.call_rpc('home')
        except NodeWorkerMemoryLimitError as e:
            mem_killed = True
            print(f"  [PASS] Successfully caught memory limit exceeded: {e}")
        assert mem_killed, "Memory limit was not triggered!"
        assert not sup.is_alive(), "Worker process should be terminated after exceeding memory limit!"
    finally:
        sup.destroy()
    return True


def main():
    print("==================================================")
    print(" Starting Node Worker Prototype Verification Suite ")
    print("==================================================")
    
    t1 = test_fixture_rules()
    t2 = test_security_sandbox()
    t3 = test_timeout_kill()
    t4 = test_memory_limit()

    all_passed = t1 and t2 and t3 and t4
    print("\n==================================================")
    if all_passed:
        print(" ALL VERIFICATION TESTS PASSED SUCCESSFULLY! ")
    else:
        print(" SOME TESTS FAILED! ")
    print("==================================================")
    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())
