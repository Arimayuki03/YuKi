# -*- coding: utf-8 -*-
"""G0.2 RuntimeRequest/Response/Error 的离线契约测试。"""
import json
import os
import sys
import asyncio
import threading
import time
import unittest
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from runner import Runner  # noqa: E402
from runtime.contracts import (RuntimeRequest, RuntimeResponse, bind_runtime_request,
                               current_runtime_request)  # noqa: E402
from runtime.errors import ERROR_SPECS, RuntimeError, error_from_exception, redact_sensitive  # noqa: E402


class _Spider:
    def homeContent(self, _filter):
        return {'list': []}


class RuntimeContractTest(unittest.TestCase):
    @staticmethod
    def _action_endpoint():
        import server
        app = server.create_app()
        return next(route.endpoint for route in app.routes
                    if getattr(route, 'path', '') == '/action')

    class _Request:
        def __init__(self, form, request_id='', disconnect_after=None):
            self._form = dict(form)
            self.headers = {'x-request-id': request_id} if request_id else {}
            self._disconnect_after = disconnect_after
            self._checks = 0

        async def form(self):
            return dict(self._form)

        async def is_disconnected(self):
            self._checks += 1
            return bool(self._disconnect_after is not None
                        and self._checks >= self._disconnect_after)

    def test_normal_request_response_and_runner_trace(self):
        request = RuntimeRequest.create(
            request_id='req-normal-0001', play_session_id='session-normal-0001',
            site_key='demo', method='homeContent', args={'filter': False})
        runner = Runner(_Spider())
        with bind_runtime_request(request):
            result = runner.homeContent(False)
        response = RuntimeResponse.success(request, result, runtime='python').to_dict()
        self.assertTrue(response['ok'])
        self.assertEqual(response['requestId'], 'req-normal-0001')
        self.assertEqual(response['playSessionId'], 'session-normal-0001')
        self.assertEqual(runner.last_request_id, response['requestId'])

    def test_exception_is_structured_and_never_http_200(self):
        request = RuntimeRequest.create(
            request_id='req-error-0001', site_key='demo', method='playerContent')
        error = error_from_exception(ValueError('token=secret'), request=request)
        response = RuntimeResponse.failure(request, error).to_dict()
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], 'L3_RUNTIME_CALL_FAILED')
        self.assertGreaterEqual(error.http_status, 400)
        self.assertNotIn('secret', json.dumps(response, ensure_ascii=False))

        import server
        status, body = server.dispatch_action(
            {'do': 'homeContent', 'site': 'missing', 'requestId': 'req-http-error-0001'})
        payload = json.loads(body)
        self.assertGreaterEqual(status, 400)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'L2_SITE_NOT_FOUND')

    def test_timeout_maps_to_retryable_runtime_timeout(self):
        request = RuntimeRequest.create(request_id='req-timeout-0001', method='homeContent')
        error = error_from_exception(TimeoutError('slow Cookie: abc'), request=request)
        self.assertEqual(error.code, 'L3_RUNTIME_TIMEOUT')
        self.assertTrue(error.retryable)
        self.assertEqual(error.http_status, 504)

    def test_deadline_and_requests_timeout_are_structured(self):
        request = RuntimeRequest.create(request_id='req-deadline-0001', method='homeContent',
                                        deadline_ms=1)
        time.sleep(0.01)
        with self.assertRaises(RuntimeError) as caught:
            request.raise_if_cancelled()
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        import requests
        mapped = error_from_exception(requests.Timeout('upstream timeout'), request=request)
        self.assertEqual(mapped.code, 'L3_RUNTIME_TIMEOUT')

    def test_active_runner_observes_cancellation_and_exits(self):
        class CooperativeSpider:
            def homeContent(self, _filter):
                while True:
                    current_runtime_request().raise_if_cancelled()
                    time.sleep(0.001)

        request = RuntimeRequest.create(request_id='req-active-cancel-0001', method='homeContent')
        result = {}

        def run():
            try:
                with bind_runtime_request(request):
                    Runner(CooperativeSpider()).homeContent(False)
            except RuntimeError as error:
                result['error'] = error

        thread = threading.Thread(target=run)
        thread.start()
        time.sleep(0.02)
        request.cancel()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive(), 'cooperative runtime must release its thread after cancel')
        self.assertEqual(result['error'].code, 'L3_RUNTIME_CANCELLED')

    def test_cancelled_request_raises_structured_error(self):
        request = RuntimeRequest.create(request_id='req-cancel-0001', method='playerContent')
        request.cancel()
        with self.assertRaises(RuntimeError) as caught:
            request.raise_if_cancelled()
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_CANCELLED')
        self.assertEqual(caught.exception.request_id, request.request_id)

    def test_async_and_future_cancellation_map_to_structured_cancel(self):
        request = RuntimeRequest.create(request_id='req-cancel-map-0001', method='homeContent')
        self.assertEqual(error_from_exception(asyncio.CancelledError(), request=request).code,
                         'L3_RUNTIME_CANCELLED')
        import concurrent.futures
        self.assertEqual(error_from_exception(concurrent.futures.CancelledError(), request=request).code,
                         'L3_RUNTIME_CANCELLED')

    def test_l1_l6_catalog_and_sensitive_redaction(self):
        self.assertEqual({code[:2] for code in ERROR_SPECS}, {'L1', 'L2', 'L3', 'L4', 'L5', 'L6'})
        text = redact_sensitive(
            'Authorization: Bearer abc Cookie: sid=private token=secret BDUSS=credential')
        for secret in ('abc', 'private', 'secret', 'credential'):
            self.assertNotIn(secret, text)
        self.assertIn('[REDACTED]', text)

    def test_action_upstream_failures_never_return_http_200(self):
        import server
        with mock.patch('config.fetch_text_diagnostics', return_value={
                'text': '', 'status': 0, 'finalUrl': '',
                'failureDomain': 'fixture.invalid', 'error': 'connection timeout'}):
            status, body = server.dispatch_action({
                'do': 'fetchText', 'url': 'http://fixture.invalid',
                'requestId': 'req-fetch-failed-0001'})
        payload = json.loads(body)
        self.assertEqual(status, 504)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'L1_CONFIG_TIMEOUT')

        with mock.patch('pan_login.quark_qr_create', side_effect=OSError('fixture network down')):
            status, body = server.dispatch_action({
                'do': 'panCookie', 'act': 'qrCreate',
                'requestId': 'req-qr-failed-0001'})
        payload = json.loads(body)
        self.assertEqual(status, 502)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'L3_RUNTIME_CALL_FAILED')

        # A legacy Spider result may carry an embedded error while returning a
        # CatVod-shaped object.  The action decorator must promote it to a
        # non-2xx RuntimeResponse instead of treating the 200 as success.
        request = RuntimeRequest.create(
            request_id='req-embedded-error-0001', method='playerContent')
        status, body = server._decorate_action_body(
            200,
            json.dumps({'url': '', 'parse': 1, 'error': {
                'code': 'L4_PARSE_UNAVAILABLE', 'stage': 'parse',
                'retryable': False, 'message': 'no parser',
            }}), request)
        payload = json.loads(body)
        self.assertEqual(status, 424)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'L4_PARSE_UNAVAILABLE')

    def test_action_endpoint_normal_timeout_cancel_and_cleanup(self):
        import server

        endpoint = self._action_endpoint()

        def normal_dispatch(_form, request):
            self.assertEqual(request.request_id, 'req-endpoint-normal-0001')
            return 200, json.dumps({'list': []})

        with mock.patch.object(server, 'dispatch_action', side_effect=normal_dispatch):
            response = asyncio.run(endpoint(self._Request(
                {'do': 'homeContent', 'requestId': 'req-endpoint-normal-0001',
                 'playSessionId': 'session-endpoint-normal-0001'},
                request_id='req-endpoint-normal-0001')))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get('x-request-id'), 'req-endpoint-normal-0001')
        self.assertEqual(response.headers.get('x-play-session-id'),
                         'session-endpoint-normal-0001')
        body = json.loads(response.body)
        self.assertTrue(body['ok'])
        self.assertEqual(body['requestId'], 'req-endpoint-normal-0001')

        def cooperative_dispatch(_form, request):
            server._register_runtime_request(request)
            try:
                while True:
                    request.raise_if_cancelled()
                    time.sleep(0.001)
            finally:
                server._unregister_runtime_request(request)

        with mock.patch.object(server, 'dispatch_action', side_effect=cooperative_dispatch):
            response = asyncio.run(endpoint(self._Request(
                {'do': 'homeContent', 'requestId': 'req-endpoint-timeout-0001',
                 'deadlineMs': '20'}, request_id='req-endpoint-timeout-0001')))
        self.assertEqual(response.status_code, 504)
        body = json.loads(response.body)
        self.assertFalse(body['ok'])
        self.assertEqual(body['error']['code'], 'L3_RUNTIME_TIMEOUT')
        time.sleep(0.05)
        self.assertNotIn('req-endpoint-timeout-0001', server._active_runtime_requests)

        with mock.patch.object(server, 'dispatch_action', side_effect=cooperative_dispatch):
            response = asyncio.run(endpoint(self._Request(
                {'do': 'homeContent', 'requestId': 'req-endpoint-cancel-0001',
                 'deadlineMs': '1000'}, request_id='req-endpoint-cancel-0001',
                disconnect_after=2)))
        self.assertEqual(response.status_code, 499)
        body = json.loads(response.body)
        self.assertFalse(body['ok'])
        self.assertEqual(body['error']['code'], 'L3_RUNTIME_CANCELLED')
        time.sleep(0.05)
        self.assertNotIn('req-endpoint-cancel-0001', server._active_runtime_requests)


if __name__ == '__main__':
    unittest.main(verbosity=2)
