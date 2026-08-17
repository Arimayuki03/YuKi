# -*- coding: utf-8 -*-
"""spawn Worker 入口；仅交换有大小上限的 JSON 帧。"""
from __future__ import annotations

import os

from .errors import RuntimeError, error_from_exception
from .process_transport import (
    apply_worker_limits,
    enter_worker_process_group,
    recv_json,
    send_json,
)


def worker_main(connection, spec, policy):
    enter_worker_process_group()
    apply_worker_limits(policy)
    os.environ['VPC_RUNTIME_WORKER'] = '1'
    handler = None
    try:
        # The spawned interpreter must not import or initialize any untrusted
        # runtime until the parent has attached it to the Windows Job Object.
        # Calling Process.start() and assigning the Job afterwards has a real
        # race: a JAR worker can otherwise create its JVM first.
        send_json(connection, {'op': 'booted', 'ok': True, 'pid': os.getpid()})
        start = recv_json(connection)
        if str((start or {}).get('op') or '') != 'start':
            raise RuntimeError(
                'L3_RUNTIME_PROTOCOL_ERROR',
                raw_error='worker start barrier was not released',
            )
        from .site_worker import SiteRuntimeWorker
        handler = SiteRuntimeWorker(spec)
        send_json(connection, {'op': 'ready', 'ok': True, 'pid': os.getpid()})
    except BaseException as exc:
        try:
            error = error_from_exception(
                exc if isinstance(exc, Exception) else Exception(str(exc)),
                stage='runtime', site_key=str((spec or {}).get('site_key') or ''),
                runtime=str((spec or {}).get('kind') or ''),
            )
            send_json(connection, {'op': 'ready', 'ok': False,
                                   'error': error.to_dict(include_raw=True)})
        except Exception:
            pass
        try:
            connection.close()
        except Exception:
            pass
        return

    try:
        while True:
            message = recv_json(connection)
            op = str((message or {}).get('op') or '')
            if op == 'shutdown':
                break
            if op == 'ping':
                send_json(connection, {'op': 'pong', 'id': message.get('id'), 'ok': True})
                continue
            if op != 'call':
                error = RuntimeError('L3_RUNTIME_PROTOCOL_ERROR', raw_error='unknown worker op')
                send_json(connection, {'id': message.get('id'), 'ok': False,
                                       'error': error.to_dict(include_raw=True)})
                continue
            request_id = str(message.get('id') or '')
            try:
                result = handler.call(
                    str(message.get('method') or ''),
                    list(message.get('args') or []),
                    dict(message.get('request') or {}),
                )
                send_json(connection, {
                    'id': request_id,
                    'ok': True,
                    'result': result,
                    'lastError': handler.last_error,
                })
            except BaseException as exc:
                if not isinstance(exc, Exception):
                    raise
                error = handler.map_error(exc, dict(message.get('request') or {}))
                send_json(connection, {
                    'id': request_id,
                    'ok': False,
                    'error': error.to_dict(include_raw=True),
                    'lastError': handler.last_error,
                })
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        if handler is not None:
            try:
                handler.destroy()
            except Exception:
                pass
        try:
            connection.close()
        except Exception:
            pass
