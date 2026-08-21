# -*- coding: utf-8 -*-
"""A4.1 normal/error/timeout/cancel and decision regression tests."""
import hashlib
import os
from pathlib import Path
import sys
import threading
import unittest
import zipfile

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from runtime.android_policy import (  # noqa: E402
    ANDROID_ONLY_MESSAGE, ANDROID_WORKER_DECISION, SUPPORT_CEILING,
    android_worker_available)
from runtime.android_worker_spike import (  # noqa: E402
    ContractProbe, ProbeProcessRunner, evaluate_go,
    inspect_android_artifact, load_manifest, validate_method_result)
from runtime.errors import RuntimeError as ContractError  # noqa: E402


HELPER = Path(__file__).with_name('fixtures') / 'android_worker_probe.py'
MANIFEST = BASE / 'spike' / 'android_worker_samples.json'
TEST_ROOT = Path(os.environ.get('VPC_TEST_ROOT') or (BASE / '.test-runtime'))


class AndroidWorkerSpikeTest(unittest.TestCase):
    def command(self, mode='normal'):
        return [sys.executable, str(HELPER), mode]

    def test_normal_contract_requires_real_data_plane_evidence(self):
        result = ContractProbe().run(
            self.command(), {'id': 'context-real-sample'}, timeout_ms=2000)
        self.assertTrue(result.completed)
        self.assertEqual(['init', 'home', 'player', 'proxy'],
                         list(result.methods))
        if os.name == 'nt':
            self.assertGreater(result.methods['init'].process.peak_rss_bytes, 0)
        ok, reason = validate_method_result('player', {'url': 'https://example/video'})
        self.assertFalse(ok)
        self.assertIn('media', reason)

    def test_adapter_error_is_not_silently_completed(self):
        result = ContractProbe().run(
            self.command('error'), {'id': 'bad'}, timeout_ms=2000)
        self.assertFalse(result.completed)
        self.assertEqual('error', result.methods['init'].state)
        self.assertEqual(7, result.methods['init'].process.exit_code)
        self.assertIn('synthetic adapter failure', result.methods['init'].reason)

    def test_timeout_terminates_probe(self):
        result = ProbeProcessRunner().run(
            self.command('hang'), {'method': 'init', 'sample': {'id': 'slow'}},
            timeout_ms=120)
        self.assertEqual('timeout', result.status)
        self.assertLess(result.elapsed_ms, 2500)
        self.assertIsNotNone(result.exit_code)

    def test_cancellation_terminates_probe(self):
        cancel = threading.Event()
        timer = threading.Timer(0.12, cancel.set)
        timer.start()
        try:
            result = ProbeProcessRunner().run(
                self.command('hang'), {'method': 'init', 'sample': {'id': 'cancel'}},
                timeout_ms=5000, cancel_event=cancel)
        finally:
            timer.cancel()
        self.assertEqual('cancelled', result.status)
        self.assertLess(result.elapsed_ms, 2500)
        self.assertIsNotNone(result.exit_code)

    def test_timeout_terminates_descendant_process_tree(self):
        folder = TEST_ROOT / 'android-worker-spike'
        folder.mkdir(parents=True, exist_ok=True)
        pid_file = folder / 'descendant.pid'
        if pid_file.exists():
            pid_file.unlink()
        result = ProbeProcessRunner().run(
            self.command('hang-child'),
            {'method': 'init', 'sample': {
                'id': 'tree', 'pidFile': str(pid_file)}}, timeout_ms=1200)
        self.assertEqual('timeout', result.status)
        self.assertTrue(pid_file.is_file(), result.stderr)
        child_pid = int(pid_file.read_text(encoding='ascii'))
        if os.name == 'nt':
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(
                0x1000, False, child_pid)
            active = False
            if handle:
                exit_code = ctypes.c_ulong()
                ctypes.windll.kernel32.GetExitCodeProcess(
                    handle, ctypes.byref(exit_code))
                active = exit_code.value == 259  # STILL_ACTIVE
                ctypes.windll.kernel32.CloseHandle(handle)
            self.assertFalse(active, 'probe descendant survived timeout')

    def test_manifest_is_pinned_and_covers_three_real_dex_kinds(self):
        data = load_manifest(MANIFEST)
        self.assertEqual(3, len(data['samples']))
        self.assertEqual(3, len({item['url'] for item in data['samples']}))
        self.assertTrue(all(item['url'].startswith('https://raw.githubusercontent.com/')
                            for item in data['samples']))

    def _artifact(self, folder, kind):
        tokens = {
            'android_context': b'dex\n035\x00Landroid/content/Context;',
            'secondary_dex': (b'dex\n035\x00Ldalvik/system/DexFile;'
                              b'loadDex classes2.dex secondary-dexes'),
            'arm_native_proxy': (b'dex\n035\x00mediaProxy-v7a mediaProxy-v8a '
                                 b'http://127.0.0.1:8944/?url= proxy'),
        }[kind]
        path = Path(folder) / ('%s.jar' % kind)
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('classes.dex', tokens)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        return path, {'id': kind, 'kind': kind, 'sha256': digest}

    def test_artifact_inspector_requires_observed_dex_evidence(self):
        folder = TEST_ROOT / 'android-worker-spike'
        folder.mkdir(parents=True, exist_ok=True)
        for kind in ('android_context', 'secondary_dex', 'arm_native_proxy'):
            path, sample = self._artifact(folder, kind)
            report = inspect_android_artifact(path, sample)
            self.assertTrue(report['validForKind'], report)
            self.assertFalse(report['nativeElfVerified'])

    def test_decision_engine_enforces_every_go_gate(self):
        complete = []
        for index in range(2):
            result = ContractProbe().run(
                self.command(), {'id': 'sample-%d' % index}, timeout_ms=2000)
            complete.append(result)
        metrics = {
            'coldStartMeasured': True, 'coldStartAcceptable': True,
            'memoryMeasured': True, 'memoryAcceptable': True,
            'installSizeMeasured': True, 'installSizeAcceptable': True,
        }
        lifecycle = {'start': True, 'stop': True, 'update': True}
        licenses = {'fongmi': True, 'androidImages': True,
                    'armTranslation': True, 'distribution': False}
        privacy = {'noUnknownThirdPartyCredentialUpload': True}
        no_go = evaluate_go(complete, metrics, lifecycle, licenses, privacy)
        self.assertEqual('NO_GO', no_go['decision'])
        self.assertIn('licensesApproved', no_go['failedGates'])
        licenses['distribution'] = True
        go = evaluate_go(complete, metrics, lifecycle, licenses, privacy)
        self.assertEqual('GO', go['decision'])

    def test_no_go_policy_cannot_be_overridden_by_environment_flags(self):
        self.assertEqual('C1', SUPPORT_CEILING)
        self.assertEqual('NO_GO', ANDROID_WORKER_DECISION)
        self.assertFalse(android_worker_available(enabled=True, ready=True))
        self.assertIn('Android/Dex/native', ANDROID_ONLY_MESSAGE)
        self.assertIn('dex2jar/JVM', ANDROID_ONLY_MESSAGE)
        payload = ContractError('L2_SITE_REQUIRES_ANDROID').to_dict()
        self.assertEqual(ANDROID_ONLY_MESSAGE, payload['message'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
