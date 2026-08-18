# -*- coding: utf-8 -*-
"""A4.1 proof adapter for measuring the existing JVM Android-shim option.

It runs one method in a fresh process so the outer spike harness can enforce a
deadline, cancellation and process-tree cleanup.  The adapter does not claim
Android compatibility and does not synthesize media/proxy success evidence.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

os.environ.setdefault('VPC_WORKER_CONTROL_ONLY', '1')

import hoststate  # noqa: E402
from jar_bridge import JarBridge  # noqa: E402


def _json_value(value):
    if isinstance(value, (dict, list)):
        return value


def _call_json(bridge, class_name, method, *args):
    value = _json_value(bridge.call(method, *args, class_name=class_name))
    if not isinstance(value, dict):
        raise ValueError('%s returned no object' % method)
    return value


def _derive_player_request(bridge, class_name):
    """Walk home -> category -> detail to obtain a real episode identifier."""
    home = _call_json(bridge, class_name, 'homeContent', True)
    videos = home.get('list') if isinstance(home.get('list'), list) else []
    if not videos:
        classes = home.get('class') if isinstance(home.get('class'), list) else []
        if not classes:
            raise ValueError('home returned no category for player derivation')
        tid = str(classes[0].get('type_id') or '')
        category = _call_json(
            bridge, class_name, 'categoryContent', tid, '1', False, {})
        videos = category.get('list') if isinstance(category.get('list'), list) else []
    if not videos:
        raise ValueError('category returned no video for player derivation')
    vod_id = str(videos[0].get('vod_id') or '')
    if not vod_id:
        raise ValueError('video has no vod_id')
    detail = _call_json(bridge, class_name, 'detailContent', [vod_id])
    rows = detail.get('list') if isinstance(detail.get('list'), list) else []
    if not rows:
        raise ValueError('detail returned no video')
    row = rows[0]
    sources = str(row.get('vod_play_from') or '').split('$$$')
    playlists = str(row.get('vod_play_url') or '').split('$$$')
    for index, playlist in enumerate(playlists):
        for episode in playlist.split('#'):
            if '$' not in episode:
                continue
            _, episode_id = episode.split('$', 1)
            if episode_id.strip():
                flag = sources[index] if index < len(sources) else ''
                return flag, episode_id.strip()
    raise ValueError('detail returned no playable episode id')


def _probe_media(value):
    """Require bytes and an actual mpv first frame; a URL alone never passes."""
    if not isinstance(value, dict) or not value.get('url'):
        return value
    url = str(value['url'])
    if not url.lower().startswith(('http://', 'https://')):
        return value
    headers = value.get('header') if isinstance(value.get('header'), dict) else {}
    request = Request(url, headers={**{str(k): str(v) for k, v in headers.items()},
                                    'Range': 'bytes=0-65535'})
    with urlopen(request, timeout=4) as response:
        data = response.read(64 * 1024)
        status = int(getattr(response, 'status', 0) or response.getcode() or 0)
    media = {'status': status, 'firstByteBytes': len(data), 'firstFrameMs': -1}
    mpv = BASE.parent / 'vendor' / 'mpv' / 'mpv.exe'
    if data and mpv.is_file():
        command = [str(mpv), '--no-config', '--no-terminal', '--vo=null', '--ao=null',
                   '--frames=1', '--cache=no', '--demuxer-max-bytes=1048576']
        if headers:
            command.append('--http-header-fields=' + ','.join(
                '%s: %s' % (key, value) for key, value in headers.items()))
        command.append(url)
        started = time.monotonic()
        played = subprocess.run(command, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=6)
        if played.returncode == 0:
            media['firstFrameMs'] = int((time.monotonic() - started) * 1000)
    value = dict(value)
    value['mediaProbe'] = media
    return value


def _real_player(bridge, class_name):
    flag, episode_id = _derive_player_request(bridge, class_name)
    value = _call_json(
        bridge, class_name, 'playerContent', flag, episode_id, [])
    return _probe_media(value)
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def main():
    request = json.loads(sys.stdin.readline())
    method = str(request.get('method') or '')
    sample = dict(request.get('sample') or {})
    probe = dict(sample.get('jvmProbe') or {})
    raw_artifact = Path(str(sample.get('artifactPath') or ''))
    artifact = str(raw_artifact.parent / str(probe.get('file') or ''))
    class_name = str(probe.get('className') or '')
    if not artifact or not class_name:
        raise ValueError('artifactPath and className are required')
    test_root = Path(os.environ.get('VPC_TEST_ROOT') or (BASE / '.test-runtime'))
    hoststate.configure(port=18557, token='a4-1-spike',
                        data_dir=str(test_root / 'data'),
                        cache_dir=str(test_root / 'cache'),
                        plugins_dir=str(test_root / 'cache' / 'py'),
                        log_dir=str(test_root / 'data' / 'logs'))
    hoststate.ensure_dirs()
    bridge = JarBridge(artifact)
    try:
        ext = str(probe.get('ext') or '')
        if method == 'init':
            bridge.call('init', ext, class_name=class_name)
            value = {'initialized': True, 'loadedSample': sample.get('id')}
        elif method == 'home':
            bridge.call('init', ext, class_name=class_name)
            value = _json_value(bridge.call(
                'homeContent', True, class_name=class_name))
        elif method == 'player':
            bridge.call('init', ext, class_name=class_name)
            value = _real_player(bridge, class_name)
        elif method == 'proxy':
            bridge.call('init', ext, class_name=class_name)
            player = _real_player(bridge, class_name)
            player_url = str(player.get('url') or '')
            parts = urlsplit(player_url)
            query = {key: values[-1] for key, values in
                     parse_qs(parts.query, keep_blank_values=True).items()}
            proxy = bridge.call_proxy(
                query or {'url': player_url},
                class_name=class_name)
            body = proxy.body
            data = body.read(4096) if hasattr(body, 'read') else bytes(body or b'')[:4096]
            value = {
                'status': int(proxy.status), 'bodyBytes': len(data),
                'contentType': str((proxy.headers or {}).get('Content-Type') or ''),
            }
            if hasattr(body, 'close'):
                body.close()
        else:
            raise ValueError('unknown method: %s' % method)
        print(json.dumps(value, ensure_ascii=False, default=str))
        return 0
    except Exception as exc:
        print('%s: %s' % (type(exc).__name__, exc), file=sys.stderr)
        return 2
    finally:
        bridge.destroy()


if __name__ == '__main__':
    raise SystemExit(main())
