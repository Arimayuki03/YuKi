# -*- coding: utf-8 -*-
"""Reusable A4.1 Android Worker feasibility probe (not a Worker).

The probe verifies pinned Android artifacts, runs a supplied proof adapter in
an isolated child process, enforces init/home/player/proxy data-plane
contracts, and evaluates the A4.1 Go gates.  It intentionally contains no
Android execution implementation.
"""
from dataclasses import asdict, dataclass, field
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from typing import Any, Mapping
import zipfile

from .process_transport import WindowsJob

try:
    import psutil
except Exception:  # pragma: no cover - optional on minimal installations
    psutil = None


CONTRACT_METHODS = ('init', 'home', 'player', 'proxy')
ARTIFACT_KINDS = ('android_context', 'secondary_dex', 'arm_native_proxy')
MAX_ARCHIVE_ENTRY = 32 * 1024 * 1024
MAX_ARCHIVE_TOTAL = 128 * 1024 * 1024
MAX_CAPTURE_BYTES = 64 * 1024


@dataclass
class ProcessResult:
    status: str
    elapsed_ms: int
    exit_code: int | None = None
    peak_rss_bytes: int = 0
    stdout: str = ''
    stderr: str = ''
    payload: Any = None
    pid: int = 0

    def to_dict(self):
        return asdict(self)


@dataclass
class ContractResult:
    method: str
    state: str
    reason: str
    process: ProcessResult

    def to_dict(self):
        data = asdict(self)
        return data


@dataclass
class SampleResult:
    sample_id: str
    methods: dict[str, ContractResult] = field(default_factory=dict)

    @property
    def completed(self):
        return all(self.methods.get(name) is not None and
                   self.methods[name].state == 'passed'
                   for name in CONTRACT_METHODS)

    def to_dict(self):
        return {
            'sampleId': self.sample_id,
            'completed': self.completed,
            'methods': {name: result.to_dict()
                        for name, result in self.methods.items()},
        }


def _bounded_append(target, data):
    if not data or len(target) >= MAX_CAPTURE_BYTES:
        return
    target.extend(data[:MAX_CAPTURE_BYTES - len(target)])


def _drain(stream, target):
    try:
        while True:
            block = stream.read(4096)
            if not block:
                break
            _bounded_append(target, block)
    finally:
        stream.close()


def _kill_process_tree(proc, job=None):
    """Terminate only the exact probe process and descendants."""
    if proc.poll() is not None:
        if job is not None:
            job.close()
        return
    if job is not None:
        try:
            job.close()
            proc.wait(timeout=1)
            return
        except Exception:
            pass
    if psutil is not None:
        try:
            root = psutil.Process(proc.pid)
            children = root.children(recursive=True)
            for child in children:
                child.terminate()
            root.terminate()
            _, alive = psutil.wait_procs(children + [root], timeout=0.75)
            for item in alive:
                item.kill()
            psutil.wait_procs(alive, timeout=0.75)
            return
        except Exception:
            pass
    if os.name == 'nt':
        try:
            # ``taskkill /T`` is the dependency-free fallback for the exact
            # numeric root PID.  It avoids leaving the adapter's JVM/native
            # descendants alive after an outer timeout or cancellation.
            subprocess.run(
                ['taskkill', '/PID', str(int(proc.pid)), '/T', '/F'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=2, check=False)
            proc.wait(timeout=1)
            return
        except Exception:
            pass
    try:
        proc.terminate()
        proc.wait(timeout=0.75)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=0.75)
        except Exception:
            pass


def _windows_process_tree_rss(root_pid):
    """Return current working set for one Windows process tree without psutil."""
    if os.name != 'nt':
        return 0
    try:
        import ctypes
        from ctypes import wintypes

        class ProcessEntry(ctypes.Structure):
            _fields_ = [
                ('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', wintypes.LONG), ('dwFlags', wintypes.DWORD),
                ('szExeFile', wintypes.WCHAR * 260),
            ]

        class MemoryCounters(ctypes.Structure):
            _fields_ = [
                ('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t),
                ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t),
                ('PeakPagefileUsage', ctypes.c_size_t),
            ]

        kernel = ctypes.windll.kernel32
        snapshot = kernel.CreateToolhelp32Snapshot(0x00000002, 0)
        if snapshot in (0, ctypes.c_void_p(-1).value):
            return 0
        parents = {}
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        try:
            ok = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
                ok = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        pids = {int(root_pid)}
        changed = True
        while changed:
            changed = False
            for pid, parent in parents.items():
                if parent in pids and pid not in pids:
                    pids.add(pid)
                    changed = True
        total = 0
        for pid in pids:
            handle = kernel.OpenProcess(0x0410, False, pid)
            if not handle:
                continue
            counters = MemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            try:
                if ctypes.windll.psapi.GetProcessMemoryInfo(
                        handle, ctypes.byref(counters), counters.cb):
                    total += int(counters.WorkingSetSize)
            finally:
                kernel.CloseHandle(handle)
        return total
    except Exception:
        return 0


def _process_tree_rss(pid):
    if psutil is not None:
        try:
            root = psutil.Process(pid)
            return (root.memory_info().rss +
                    sum(child.memory_info().rss
                        for child in root.children(recursive=True)))
        except Exception:
            return 0
    return _windows_process_tree_rss(pid)


class ProbeProcessRunner:
    """Run one JSON probe request with timeout, cancellation and RSS capture."""

    def run(self, command, payload, *, timeout_ms=5000, cancel_event=None):
        if not command or not isinstance(command, (list, tuple)):
            raise ValueError('probe command must be a non-empty list')
        timeout_ms = max(1, int(timeout_ms))
        creationflags = 0
        if os.name == 'nt':
            creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        started = time.monotonic()
        proc = subprocess.Popen(
            [str(value) for value in command], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=creationflags)
        job = None
        if os.name == 'nt':
            try:
                # The adapter waits for stdin, so it cannot spawn a JVM/native
                # descendant before the kill-on-close boundary is attached.
                job = WindowsJob(proc.pid)
            except Exception:
                _kill_process_tree(proc)
                raise
        stdout_buf = bytearray()
        stderr_buf = bytearray()
        stdout_thread = threading.Thread(
            target=_drain, args=(proc.stdout, stdout_buf), daemon=True)
        stderr_thread = threading.Thread(
            target=_drain, args=(proc.stderr, stderr_buf), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        proc.stdin.write((json.dumps(payload, ensure_ascii=False) + '\n').encode('utf-8'))
        proc.stdin.close()
        status = 'error'
        peak_rss = 0
        while proc.poll() is None:
            peak_rss = max(peak_rss, _process_tree_rss(proc.pid))
            if cancel_event is not None and cancel_event.is_set():
                status = 'cancelled'
                _kill_process_tree(proc, job)
                break
            if (time.monotonic() - started) * 1000 >= timeout_ms:
                status = 'timeout'
                _kill_process_tree(proc, job)
                break
            time.sleep(0.01)
        else:
            status = 'ok' if proc.returncode == 0 else 'error'
        if proc.poll() is None:
            _kill_process_tree(proc, job)
        try:
            proc.wait(timeout=1)
        except Exception:
            _kill_process_tree(proc, job)
        if job is not None:
            job.close()
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        stdout_text = bytes(stdout_buf).decode('utf-8', 'replace').strip()
        stderr_text = bytes(stderr_buf).decode('utf-8', 'replace').strip()
        decoded = None
        if status == 'ok':
            try:
                decoded = json.loads(stdout_text)
            except (TypeError, ValueError):
                status = 'error'
                stderr_text = (stderr_text + ' invalid JSON response').strip()
        return ProcessResult(
            status=status,
            elapsed_ms=max(0, int((time.monotonic() - started) * 1000)),
            exit_code=proc.returncode,
            peak_rss_bytes=peak_rss,
            stdout=stdout_text,
            stderr=stderr_text,
            payload=decoded,
            pid=proc.pid)


def validate_method_result(method, value):
    """Validate user-visible contract completion, not object/URL creation."""
    if not isinstance(value, Mapping):
        return False, 'response is not an object'
    if method == 'init':
        good = value.get('initialized') is True and bool(value.get('loadedSample'))
        return good, '' if good else 'init did not initialize the requested sample'
    if method == 'home':
        classes = value.get('class')
        good = isinstance(classes, list) and len(classes) > 0
        return good, '' if good else 'home returned no categories'
    if method == 'player':
        media = value.get('mediaProbe')
        good = (bool(value.get('url')) and isinstance(media, Mapping) and
                int(media.get('status') or 0) in (200, 206) and
                int(media.get('firstByteBytes') or 0) > 0 and
                int(media.get('firstFrameMs') if media.get('firstFrameMs') is not None else -1) >= 0)
        return good, '' if good else 'player URL lacks successful media/first-frame evidence'
    if method == 'proxy':
        good = (int(value.get('status') or 0) in (200, 206) and
                int(value.get('bodyBytes') or value.get('firstByteBytes') or 0) > 0 and
                bool(value.get('contentType')))
        return good, '' if good else 'proxy returned no verified response body'
    return False, 'unknown contract method'


class ContractProbe:
    def __init__(self, runner=None):
        self.runner = runner or ProbeProcessRunner()

    def run(self, command, sample, *, timeout_ms=5000, cancel_event=None):
        sample_id = str(sample.get('id') or '')
        if not sample_id:
            raise ValueError('sample id is required')
        result = SampleResult(sample_id)
        for method in CONTRACT_METHODS:
            process = self.runner.run(
                command, {'method': method, 'sample': dict(sample)},
                timeout_ms=timeout_ms, cancel_event=cancel_event)
            if process.status == 'ok':
                passed, reason = validate_method_result(method, process.payload)
                state = 'passed' if passed else 'failed'
            else:
                state = process.status
                reason = process.stderr or process.status
            result.methods[method] = ContractResult(method, state, reason, process)
            if state in ('timeout', 'cancelled'):
                break
        return result


def _read_archive_bytes(path):
    chunks = []
    entries = []
    total = 0
    with zipfile.ZipFile(path, 'r') as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if info.file_size > MAX_ARCHIVE_ENTRY:
                raise ValueError('archive entry exceeds safety limit: %s' % info.filename)
            total += info.file_size
            if total > MAX_ARCHIVE_TOTAL:
                raise ValueError('archive exceeds safety limit')
            data = archive.read(info)
            entries.append(info.filename.replace('\\', '/'))
            chunks.append(data)
    return entries, b'\n'.join(chunks)


def _elf_machine(data):
    if len(data) < 20 or data[:4] != b'\x7fELF':
        return ''
    endian = 'little' if data[5:6] == b'\x01' else 'big'
    machine = int.from_bytes(data[18:20], endian)
    return {40: 'armeabi-v7a', 183: 'arm64-v8a'}.get(machine, 'other-%d' % machine)


def inspect_android_artifact(path, sample):
    """Verify a pinned real DEX JAR and classify only observed evidence."""
    artifact = Path(path)
    if not artifact.is_file():
        raise FileNotFoundError(str(artifact))
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    expected = str(sample.get('sha256') or '').lower()
    if expected and digest != expected:
        raise ValueError('sha256 mismatch for %s' % sample.get('id'))
    entries, blob = _read_archive_bytes(artifact)
    dex_entries = [name for name in entries if name.lower().endswith('.dex')]
    if not dex_entries or b'dex\n' not in blob:
        raise ValueError('artifact contains no DEX bytecode')
    lower = blob.lower()
    has_context = b'android/content/context' in lower
    has_secondary_loader = (
        (b'dalvik/system/dexfile' in lower or b'dalvik/system/dexclassloader' in lower) and
        (b'loaddex' in lower or b'classes2.dex' in lower or b'secondary-dexes' in lower))
    has_local_proxy = (b'127.0.0.1' in lower or b'localhost' in lower) and b'proxy' in lower
    arm_markers = [marker.decode('ascii') for marker in
                   (b'armeabi-v7a', b'arm64-v8a', b'-v7a', b'-v8a') if marker in lower]
    so_entries = [name for name in entries if name.lower().endswith('.so')]
    abi = []
    with zipfile.ZipFile(artifact, 'r') as archive:
        for name in so_entries:
            machine = _elf_machine(archive.read(name))
            if machine and machine not in abi:
                abi.append(machine)
    has_arm_reference = bool(abi or arm_markers)
    kind = str(sample.get('kind') or '')
    valid = {
        'android_context': has_context,
        'secondary_dex': has_secondary_loader,
        'arm_native_proxy': has_arm_reference and has_local_proxy,
    }.get(kind, False)
    return {
        'sampleId': str(sample.get('id') or ''),
        'kind': kind,
        'path': str(artifact),
        'sha256': digest,
        'sizeBytes': artifact.stat().st_size,
        'dexEntries': dex_entries,
        'hasAndroidContext': has_context,
        'hasSecondaryDexLoader': has_secondary_loader,
        'hasLocalProxy': has_local_proxy,
        'armMarkers': arm_markers,
        'nativeEntries': so_entries,
        'nativeElfVerified': bool(abi),
        'verifiedAbi': abi,
        'validForKind': bool(valid),
    }


def inventory_execution_options(env=None):
    env = dict(os.environ if env is None else env)
    adb = shutil.which('adb')
    emulator = shutil.which('emulator')
    java = shutil.which('java')
    remote = str(env.get('YUKI_ANDROID_WORKER_URL') or '')
    return {
        'packagedGuestOrEmulator': {
            'available': bool(adb and emulator), 'adb': adb or '',
            'emulator': emulator or '', 'networkNamespace': 'guest NAT/bridge'},
        'pairedAndroidDeviceWorker': {
            'available': bool(adb), 'adb': adb or '',
            'networkNamespace': 'physical device (localhost is device)'},
        'selfHostedRemoteWorker': {
            'available': bool(remote), 'endpointConfigured': bool(remote),
            'networkNamespace': 'remote host',
            'credentialBoundary': 'operator-controlled endpoint only'},
        'jvmAndroidShim': {
            'available': bool(java), 'java': java or '',
            'supportsArmNative': False, 'networkNamespace': 'desktop host'},
    }


def evaluate_go(sample_results, metrics, lifecycle, license_review, privacy):
    """Evaluate every A4.1 Go gate and return a reproducible decision."""
    completed = sum(1 for item in sample_results if item.completed)
    gates = {
        'twoOfThreeContracts': completed >= 2,
        'coldStartMeasuredAndAcceptable': bool(metrics.get('coldStartMeasured') and
                                               metrics.get('coldStartAcceptable')),
        'memoryMeasuredAndAcceptable': bool(metrics.get('memoryMeasured') and
                                            metrics.get('memoryAcceptable')),
        'installSizeMeasuredAndAcceptable': bool(metrics.get('installSizeMeasured') and
                                                 metrics.get('installSizeAcceptable')),
        'lifecycleReliable': all(bool(lifecycle.get(name))
                                 for name in ('start', 'stop', 'update')),
        'licensesApproved': all(bool(license_review.get(name)) for name in
                                ('fongmi', 'androidImages', 'armTranslation', 'distribution')),
        'noUnknownThirdPartyCredentialUpload': bool(
            privacy.get('noUnknownThirdPartyCredentialUpload')),
    }
    failed = [name for name, value in gates.items() if not value]
    return {
        'decision': 'GO' if not failed else 'NO_GO',
        'completedSamples': completed,
        'requiredCompletedSamples': 2,
        'gates': gates,
        'failedGates': failed,
    }


def load_manifest(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    samples = data.get('samples') if isinstance(data, Mapping) else None
    if not isinstance(samples, list) or len(samples) != 3:
        raise ValueError('manifest must contain exactly three samples')
    kinds = {str(item.get('kind') or '') for item in samples}
    if kinds != set(ARTIFACT_KINDS):
        raise ValueError('manifest must cover all three required sample kinds')
    for item in samples:
        if not item.get('id') or not item.get('url') or len(str(item.get('sha256') or '')) != 64:
            raise ValueError('sample id, url and pinned sha256 are required')
    return data
