# -*- coding: utf-8 -*-
"""G0.1 正常/异常/超时/无限循环兼容夹具与退出语义。"""
import json
import os
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
CORPUS = os.path.join(HERE, 'compat_repos.json')
REPORT = os.path.join(HERE, 'compat_report.json')
SUITE = os.path.join(HERE, 'test_config_compat.py')


class OfflineCompatibilityTest(unittest.TestCase):
    def test_offline_matrix_exits_and_matches_expected_stages(self):
        with open(CORPUS, encoding='utf-8') as source:
            corpus = json.load(source)
        self.assertEqual(len(corpus.get('repos') or []), 21)
        self.assertEqual(len(corpus.get('offline') or []), 4)
        baseline_mtime = os.path.getmtime(os.path.join(HERE, 'compat_baseline.json')) \
            if os.path.exists(os.path.join(HERE, 'compat_baseline.json')) else None
        env = {
            **os.environ,
            'PYTHONIOENCODING': 'utf-8',
            'VPC_COMPAT_HOME_TIMEOUT': '0.5',
            'VPC_COMPAT_HOME_BUDGET': '1.0',
            # Timeout/infinite fixtures intentionally leave a non-daemon
            # probe worker alive after writing their report.  This forces the
            # parent process-tree termination path instead of an in-child
            # forced-exit shortcut.
            'VPC_COMPAT_REPO_TIMEOUT': '6',
        }
        started = time.monotonic()
        result = subprocess.run(
            [sys.executable, SUITE, '--offline'], cwd=BASE, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', timeout=30)
        elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 0, result.stdout[-4000:])
        self.assertLess(elapsed, 30)
        with open(REPORT, encoding='utf-8') as source:
            report = json.load(source)
        records = {item['name']: item for item in report['repos']}
        self.assertEqual(records['offline-normal']['stages']['S5']['state'], 'passed')
        self.assertEqual(records['offline-error']['stages']['S3']['state'], 'failed')
        self.assertEqual(records['offline-timeout']['stages']['S3']['state'], 'timeout')
        self.assertEqual(records['offline-infinite']['stages']['S3']['state'], 'timeout')
        self.assertTrue(records['offline-timeout']['termination']['forced'])
        self.assertTrue(records['offline-infinite']['termination']['forced'])
        self.assertFalse(records['offline-timeout']['termination'].get('descendantsAlive', True))
        self.assertFalse(records['offline-infinite']['termination'].get('descendantsAlive', True))
        self.assertTrue(records['offline-timeout']['termination'].get('descendantPids'))
        self.assertTrue(records['offline-infinite']['termination'].get('descendantPids'))
        self.assertEqual(report['aggregate']['forced_terminations'], 2)
        self.assertFalse(records['offline-error']['sites_detail'][0]['healthy'])
        self.assertFalse(records['offline-timeout']['sites_detail'][0]['healthy'])
        self.assertFalse(records['offline-infinite']['sites_detail'][0]['healthy'])
        self.assertLess(records['offline-infinite']['elapsed'], 30)
        if baseline_mtime is not None:
            self.assertEqual(os.path.getmtime(os.path.join(HERE, 'compat_baseline.json')),
                             baseline_mtime, '未传 --update-baseline 不得修改基线')


if __name__ == '__main__':
    unittest.main(verbosity=2)
