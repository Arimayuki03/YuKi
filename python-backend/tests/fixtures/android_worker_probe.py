# -*- coding: utf-8 -*-
"""Deterministic subprocess adapter for A4.1 process-boundary tests."""
import json
from pathlib import Path
import subprocess
import sys
import time


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'normal'
    request = json.loads(sys.stdin.readline())
    method = request.get('method')
    sample = request.get('sample') or {}
    if mode == 'error':
        print('synthetic adapter failure', file=sys.stderr)
        return 7
    if mode == 'hang':
        time.sleep(30)
        return 0
    if mode == 'hang-child':
        child = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(30)'])
        pid_file = str(sample.get('pidFile') or '')
        if pid_file:
            Path(pid_file).write_text(str(child.pid), encoding='ascii')
        print('childPid=%d' % child.pid, file=sys.stderr, flush=True)
        time.sleep(30)
        return 0
    responses = {
        'init': {'initialized': True, 'loadedSample': sample.get('id')},
        'home': {'class': [{'type_id': 'movie', 'type_name': 'Movie'}]},
        'player': {
            'url': 'http://127.0.0.1/media.m3u8',
            'mediaProbe': {'status': 206, 'firstByteBytes': 188,
                           'firstFrameMs': 42},
        },
        'proxy': {'status': 206, 'bodyBytes': 188,
                  'contentType': 'video/mp2t', 'rangeSupported': True},
    }
    print(json.dumps(responses.get(method, {})))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
