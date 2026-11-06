import json

import pytest
import sentry_sdk
from config.sentry import scrub_breadcrumb, scrub_event
from django.contrib.auth import get_user_model
from django.test import Client
from sentry_sdk.integrations.django import DjangoIntegration
from sentry_sdk.transport import Transport


@pytest.mark.django_db
def test_real_native_and_browser_authentication_attach_only_authenticated_account_ids():
    native_user = get_user_model().objects.create_user(username='private-native', email='private-native@example.test')
    browser_user = get_user_model().objects.create_user(username='private-browser', email='private-browser@example.test')
    native = Client()
    native.force_login(native_user, backend='allauth.account.auth_backends.AuthenticationBackend')
    native.defaults['HTTP_X_SESSION_TOKEN'] = native.session.session_key
    native.cookies.clear()
    browser = Client()
    browser.force_login(browser_user, backend='allauth.account.auth_backends.AuthenticationBackend')
    anonymous = Client(HTTP_X_MEROSPLIT_ACCOUNT=str(native_user.pk))
    captured = []

    class Capture(Transport):
        def capture_envelope(self, envelope):
            for item in envelope.items:
                if item.headers.get('type') in {'event', 'transaction'}:
                    captured.append(json.loads(item.get_bytes()))

    sentry_sdk.init(dsn='http://public@localhost/1', transport=Capture, default_integrations=False,
                    integrations=[DjangoIntegration()], traces_sample_rate=1.0,
                    before_breadcrumb=scrub_breadcrumb, before_send=scrub_event,
                    before_send_transaction=scrub_event)
    try:
        identities = []
        for client, expected_status in [(native, 200), (browser, 200), (anonymous, 401)]:
            before = len(captured)
            with sentry_sdk.isolation_scope():
                with sentry_sdk.start_transaction(name='GET /api/v1/me', op='http.server'):
                    response = client.get('/api/v1/me')
                    assert response.status_code == expected_status
                    sentry_sdk.capture_exception(ValueError('private bill content'))
            events = captured[before:]
            assert events
            identities.append({event.get('user', {}).get('id') for event in events})
        assert identities == [{str(native_user.pk)}, {str(browser_user.pk)}, {None}]
        assert 'private' not in str(captured)
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.get_global_scope().set_client(None)
