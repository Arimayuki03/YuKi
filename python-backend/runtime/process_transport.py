# -*- coding: utf-8 -*-
"""Supervisor 与 spawn Worker 之间的 JSON 帧和进程树回收。"""
from __future__ import annotations

import base64
import json
import os
import signal
import subprocess


MAX_FRAME_BYTES = 16 * 1024 * 1024
_BYTES_MARKER = '__vpc_bytes__'


class WindowsJob:
    """Kill-on-close Job Object；保证 Worker 与其后代形成一个回收单元。"""

    def __init__(self, pid, memory_limit_mb=0):
        self.handle = None
        if os.name != 'nt':
            return
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ('ReadOperationCount', ctypes.c_ulonglong),
                ('WriteOperationCount', ctypes.c_ulonglong),
                ('OtherOperationCount', ctypes.c_ulonglong),
                ('ReadTransferCount', ctypes.c_ulonglong),
                ('WriteTransferCount', ctypes.c_ulonglong),
                ('OtherTransferCount', ctypes.c_ulonglong),
            ]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ('PerProcessUserTimeLimit', ctypes.c_longlong),
                ('PerJobUserTimeLimit', ctypes.c_longlong),
                ('LimitFlags', wintypes.DWORD),
                ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t),
                ('ActiveProcessLimit', wintypes.DWORD),
                ('Affinity', ctypes.c_size_t),
                ('PriorityClass', wintypes.DWORD),
                ('SchedulingClass', wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ('BasicLimitInformation', BASIC_LIMITS),
                ('IoInfo', IO_COUNTERS),
                ('ProcessMemoryLimit', ctypes.c_size_t),
                ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t),
                ('PeakJobMemoryUsed', ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.OpenProcess.restype = wintypes.HANDLE
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), 'CreateJobObjectW failed')
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
        memory_limit_mb = max(0, int(memory_limit_mb or 0))
        if memory_limit_mb:
            limits.BasicLimitInformation.LimitFlags |= 0x00000100  # PROCESS_MEMORY
            limits.ProcessMemoryLimit = memory_limit_mb * 1024 * 1024
        if not kernel32.SetInformationJobObject(
                job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.get_last_error()
            kernel32.CloseHandle(job)
            raise OSError(error, 'SetInformationJobObject failed')
        process_handle = kernel32.OpenProcess(0x0001 | 0x0100, False, int(pid))
        if not process_handle:
            error = ctypes.get_last_error()
            kernel32.CloseHandle(job)
            raise OSError(error, 'OpenProcess failed')
        try:
            if not kernel32.AssignProcessToJobObject(job, process_handle):
                error = ctypes.get_last_error()
                kernel32.CloseHandle(job)
                raise OSError(error, 'AssignProcessToJobObject failed')
        finally:
            kernel32.CloseHandle(process_handle)
        self.handle = job

    def close(self):
        handle, self.handle = self.handle, None
        if handle and os.name == 'nt':
            import ctypes
            ctypes.WinDLL('kernel32', use_last_error=True).CloseHandle(handle)


def encode_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {_BYTES_MARKER: base64.b64encode(value).decode('ascii')}
    if isinstance(value, (list, tuple)):
        return [encode_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): encode_value(item) for key, item in value.items()}
    raise TypeError('runtime result is not JSON serializable: %s' % type(value).__name__)


def decode_value(value):
    if isinstance(value, list):
        return [decode_value(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {_BYTES_MARKER}:
            return base64.b64decode(str(value[_BYTES_MARKER] or ''), validate=False)
        return {str(key): decode_value(item) for key, item in value.items()}
    return value


def send_json(connection, payload):
    raw = json.dumps(encode_value(payload), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError('runtime frame exceeds %d bytes' % MAX_FRAME_BYTES)
    connection.send_bytes(raw)


def recv_json(connection):
    raw = connection.recv_bytes(MAX_FRAME_BYTES)
    return decode_value(json.loads(raw.decode('utf-8')))


def apply_worker_limits(policy):
    """在支持 RLIMIT 的系统施加内存上限；Windows 仍由进程树边界兜底。"""
    memory_mb = max(0, int((policy or {}).get('memory_limit_mb') or 0))
    if not memory_mb or os.name == 'nt':
        return
    try:
        import resource
        limit = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception:
        pass


def enter_worker_process_group():
    if os.name != 'nt':
        try:
            os.setsid()
        except OSError:
            pass


def terminate_process_tree(process, timeout=3.0, job=None):
    """终止 Worker 及其 Java/Node/Python 后代，不把 terminate 当作完成证据。"""
    if process is None:
        return True
    if job is not None:
        try:
            job.close()
            process.join(timeout=max(0.1, min(float(timeout), 1.0)))
            if not process.is_alive():
                return True
        except Exception:
            pass
    pid = getattr(process, 'pid', None)
    if pid and os.name == 'nt':
        try:
            subprocess.run(
                ['taskkill', '/PID', str(pid), '/T', '/F'],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=max(1.0, float(timeout)),
                check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
    elif pid:
        try:
            os.killpg(pid, signal.SIGKILL)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
    try:
        process.join(timeout=max(0.1, float(timeout)))
    except Exception:
        pass
    if getattr(process, 'is_alive', lambda: False)():
        try:
            process.kill()
            process.join(timeout=1.0)
        except Exception:
            pass
    return not getattr(process, 'is_alive', lambda: False)()
