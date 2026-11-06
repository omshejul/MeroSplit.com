import unittest

from config.sentry import scrub_event


class SentryPrivacyTests(unittest.TestCase):
    def test_scrubs_credentials_and_content_preserving_stack_location(self):
        event = {
            "request": {"url": "/j/private-token", "data": "private bill"},
            "user": {"email": "private@example.test"},
            "extra": {"token": "private-token"},
            "breadcrumbs": [{"message": "private note"}],
            "logentry": {"message": "private log"},
            "transaction": "/j/private-token",
            "exception": {"values": [{"type": "ValueError", "value": "private bill",
                "stacktrace": {"frames": [{"filename": "ledger/api.py", "lineno": 42,
                    "vars": {"token": "private-token"}, "context_line": "private"}]}}]},
        }
        result = scrub_event(event, {})
        self.assertNotIn("private", str(result))
        exception = result["exception"]["values"][0]
        self.assertEqual(exception["type"], "ValueError")
        self.assertEqual(exception["stacktrace"]["frames"][0]["lineno"], 42)


class SentryObservabilityTests(unittest.TestCase):
    def test_account_id_breadcrumbs_and_trace_timings_survive_without_private_data(self):
        event = {
            'user': {'id': '80', 'email': 'private@example.test', 'ip_address': '192.0.2.1'},
            'transaction': 'POST /api/v1/groups/private/expenses?token=secret',
            'breadcrumbs': {'values': [{'category': 'query', 'message': 'SELECT private'},
                {'type': 'http', 'data': {'url': 'https://merosplit.com/api/v1/groups/private/expenses?token=secret', 'method': 'POST', 'status_code': 409, 'body': 'private'}}]},
            'spans': [{'op': 'db.query', 'description': 'SELECT private', 'start_timestamp': 1, 'timestamp': 2, 'data': {'db.params': ['secret']}}],
            'contexts': {'trace': {'trace_id': 'a' * 32, 'data': {'password': 'secret'}}, 'custom': {'note': 'private'}},
        }
        result = scrub_event(event, {})
        self.assertEqual(result['user'], {'id': '80'})
        self.assertEqual(result['transaction'], '/api/v1/groups/:id/expenses')
        self.assertEqual(len(result['breadcrumbs']['values']), 1)
        self.assertEqual(result['spans'][0]['timestamp'], 2)
        self.assertEqual(result['spans'][0]['description'], 'db.query')
        for value in ['private', 'secret', '192.0.2.1', 'SELECT']:
            self.assertNotIn(value, str(result))

    def test_breadcrumbs_are_limited_and_console_sql_are_discarded(self):
        from config.sentry import scrub_breadcrumb
        for category in ['console', 'query', 'navigation', 'ui.click']:
            self.assertIsNone(scrub_breadcrumb({'category': category, 'message': 'private'}))
        event = {'breadcrumbs': {'values': [{'type': 'http', 'data': {'url': '/api/v1/me'}}] * 60}}
        self.assertEqual(len(scrub_event(event, {})['breadcrumbs']['values']), 50)

    def test_sentry_enabled_with_full_tracing_and_scrubbing_for_errors_and_transactions(self):
        from unittest.mock import patch

        from config.sentry import init_sentry, scrub_breadcrumb
        with patch.dict('os.environ', {'SENTRY_DSN': 'http://public@localhost/1'}), patch('config.sentry.sentry_sdk.init') as init:
            init_sentry()
        options = init.call_args.kwargs
        self.assertEqual(options['traces_sample_rate'], 1.0)
        self.assertEqual(options['max_breadcrumbs'], 50)
        self.assertIs(options['before_send'], scrub_event)
        self.assertIs(options['before_send_transaction'], scrub_event)
        self.assertIs(options['before_breadcrumb'], scrub_breadcrumb)
        self.assertFalse(options['send_default_pii'])

    def test_actual_sdk_isolates_authenticated_native_browser_and_anonymous_request_events(self):
        import json
        from types import SimpleNamespace

        import sentry_sdk
        from sentry_sdk.transport import Transport

        from config.sentry import scrub_breadcrumb, sentry_request_context
        captured = []

        class Capture(Transport):
            def capture_envelope(self, envelope):
                for item in envelope.items:
                    if item.headers.get('type') in {'event', 'transaction'}:
                        captured.append(json.loads(item.get_bytes()))

        with sentry_sdk.init(dsn='http://public@localhost/1', transport=Capture, default_integrations=False,
                             traces_sample_rate=1.0, before_send=scrub_event,
                             before_send_transaction=scrub_event, before_breadcrumb=scrub_breadcrumb):
            for identifier, source in [(80, 'native'), (59, 'browser'), (None, 'anonymous')]:
                user = SimpleNamespace(pk=identifier, is_authenticated=identifier is not None)
                request = SimpleNamespace(path='/api/v1/groups/private/expenses', method='POST', user=user if source == 'browser' else None, auth=None)

                def response(current):
                    # Native Ninja authentication happens inside get_response.
                    if source == 'native':
                        current.auth = user
                    sentry_sdk.capture_exception(ValueError('private bill contents'))
                    return 'ok'

                with sentry_sdk.isolation_scope():
                    middleware = sentry_request_context(response)
                    middleware(request)
                    with sentry_sdk.start_transaction(name='GET /api/v1/groups/private/summary', op='http.server'):
                        pass
        self.assertEqual(len(captured), 6)
        self.assertEqual([event.get('user', {}).get('id') for event in captured], ['80', '80', '59', '59', None, None])
        self.assertNotIn('private', str(captured))
