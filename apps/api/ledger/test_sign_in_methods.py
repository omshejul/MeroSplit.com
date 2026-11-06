import pytest
from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount, SocialToken
from django.contrib.auth import get_user_model
from django.test import Client

from .models import SignInPreference
from .test_api import authenticated_client, send

pytestmark = pytest.mark.django_db


@pytest.fixture
def actor():
    user = get_user_model().objects.create_user(username='signin-owner', email='owner@example.invalid')
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    return user


def test_methods_show_only_owned_identity_fields_and_auto_link_defaults_on(actor):
    account = SocialAccount.objects.create(user=actor, provider='google', uid='google-own', extra_data={
        'email': 'connected@example.invalid', 'nonce': 'must-not-leak', 'access_token': 'must-not-leak'})
    other = get_user_model().objects.create_user(username='other', email='other@example.invalid')
    SocialAccount.objects.create(user=other, provider='google', uid='google-other')
    data = send(authenticated_client(actor), 'get', '/me/sign-in-methods').json()
    assert data == {'auto_link': True, 'accounts': [{'id': str(account.pk), 'provider': 'google',
        'uid': 'google-own', 'email': 'connected@example.invalid', 'can_disconnect': True}]}
    assert not SignInPreference.objects.exists(), 'reading defaults must not create a settings row'


def test_auto_link_saves_per_account_and_rejects_coerced_booleans(actor):
    client = authenticated_client(actor)
    assert send(client, 'put', '/me/sign-in-methods/preferences', {'auto_link': False}).json()['auto_link'] is False
    assert send(client, 'get', '/me/sign-in-methods').json()['auto_link'] is False
    for bad in ['false', 0, None]:
        assert send(client, 'put', '/me/sign-in-methods/preferences', {'auto_link': bad}).status_code == 422
    assert send(client, 'put', '/me/sign-in-methods/preferences', {'auto_link': True, 'user_id': actor.pk}).status_code == 422
    other = get_user_model().objects.create_user(username='other')
    assert send(authenticated_client(other), 'get', '/me/sign-in-methods').json()['auto_link'] is True
    assert send(client, 'put', '/me/sign-in-methods/preferences', {'auto_link': True}).json()['auto_link'] is True


def test_disconnect_targets_exact_owned_record_and_keeps_verified_email_session(actor):
    account = SocialAccount.objects.create(user=actor, provider='google', uid='google-own')
    SocialToken.objects.create(account=account, token='synthetic-only')
    client = authenticated_client(actor)
    result = send(client, 'delete', f'/me/sign-in-methods/{account.pk}')
    assert result.status_code == 200 and result.json()['accounts'] == []
    assert not SocialAccount.objects.exists() and not SocialToken.objects.exists()
    assert send(client, 'get', '/me').json()['id'] == actor.pk
    assert result.json()['auto_link'] is True
    assert send(client, 'delete', f'/me/sign-in-methods/{account.pk}').status_code == 404


def test_foreign_or_unauthenticated_disconnect_does_not_change_any_links(actor):
    other = get_user_model().objects.create_user(username='other')
    account = SocialAccount.objects.create(user=other, provider='google', uid='other-identity')
    assert send(authenticated_client(actor), 'delete', f'/me/sign-in-methods/{account.pk}').status_code == 404
    for method, path, body in [('get', '/me/sign-in-methods', None),
                              ('put', '/me/sign-in-methods/preferences', {'auto_link': False}),
                              ('delete', f'/me/sign-in-methods/{account.pk}', None)]:
        assert send(Client(), method, path, body).status_code == 401
    assert SocialAccount.objects.filter(pk=account.pk).exists()


def test_last_provider_needs_a_verified_email_fallback(actor):
    EmailAddress.objects.filter(user=actor).update(verified=False)
    account = SocialAccount.objects.create(user=actor, provider='google', uid='only-identity')
    client = authenticated_client(actor)
    assert send(client, 'get', '/me/sign-in-methods').json()['accounts'][0]['can_disconnect'] is False
    assert send(client, 'delete', f'/me/sign-in-methods/{account.pk}').status_code == 409
    assert SocialAccount.objects.filter(pk=account.pk).exists()
    second = SocialAccount.objects.create(user=actor, provider='google', uid='another-identity')
    assert send(client, 'delete', f'/me/sign-in-methods/{second.pk}').status_code == 200
    assert send(client, 'delete', f'/me/sign-in-methods/{account.pk}').status_code == 409


def test_apple_disconnect_revokes_only_that_identity_after_commit(actor, monkeypatch, django_capture_on_commit_callbacks):
    account = SocialAccount.objects.create(user=actor, provider='apple', uid='apple-own', extra_data={'email': 'relay@privaterelay.appleid.com'})
    SocialToken.objects.create(account=account, token_secret='encrypted-synthetic')
    from . import apple_signin
    calls = []
    monkeypatch.setattr(apple_signin, 'configured', lambda: True)
    monkeypatch.setattr(apple_signin, 'token_cipher', lambda: type('Cipher', (), {'decrypt': lambda self, value: b'synthetic-refresh'})())
    monkeypatch.setattr(apple_signin, 'apple_request', lambda action, body: calls.append((action, body)))
    with django_capture_on_commit_callbacks(execute=True):
        response = send(authenticated_client(actor), 'delete', f'/me/sign-in-methods/{account.pk}')
        assert not calls, 'provider HTTP must run after the database transaction'
    assert response.status_code == 200
    assert calls == [('revoke', {'token': 'synthetic-refresh', 'token_type_hint': 'refresh_token'})]
    assert not SocialAccount.objects.filter(pk=account.pk).exists()
