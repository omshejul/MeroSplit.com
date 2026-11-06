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
