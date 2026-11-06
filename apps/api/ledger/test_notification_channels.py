from uuid import uuid4
import pytest
from allauth.account.models import EmailAddress
from .models import NotificationPreference, PushDevice
from .test_api import client as client, send
from .test_push import configured as configured, register

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def verified(client):
    client.actor.email = 'channels@example.com'
    client.actor.save(update_fields=['email'])
    EmailAddress.objects.create(user=client.actor, email=client.actor.email, verified=True, primary=True)


def write(client, client_id, revision, **patch):
    response = send(client, 'put', '/me/notifications/channels', {'client_id': str(client_id), 'revision': revision, **patch})
    assert response.status_code == 200, response.content
    return response.json()


def test_read_preserves_legacy_mute_and_explicit_email_on_never_enables_legacy_push(client):
    device = register(client)
    send(client, 'put', '/me/notifications/preferences', {'expense_updates': False, 'email_reminders': True})
    state = send(client, 'get', '/me/notifications/channels').json()
    assert state['email_notifications'] is False and state['legacy_muted'] is True
    assert PushDevice.objects.filter(pk=device.pk).exists()
    state = write(client, uuid4(), 1, email_notifications=True)
    assert state['email_notifications'] is True and state['statement_enabled'] is True
    assert state['legacy_muted'] is False
    assert not PushDevice.objects.filter(pk=device.pk).exists()
    assert {'id': str(device.pk), 'revision': 0} in state['muted_push_devices']
    assert send(client, 'put', f'/me/push-devices/{device.pk}', {'provider':'expo','platform':'ios','token':device.token}).json()['enabled'] is False
    assert NotificationPreference.objects.get(user=client.actor).expense_updates is True


def test_push_activation_never_restores_email_hidden_by_legacy_master(client):
    send(client, 'put', '/me/notifications/preferences', {'expense_updates': False, 'email_reminders': True})
    state = write(client, uuid4(), 1, activate_push=True)
    assert state['email_notifications'] is False and state['legacy_muted'] is False


def test_email_and_statements_do_not_change_push_and_frequency_is_explicit(client):
    device = register(client)
    identity = uuid4()
    write(client, identity, 1, email_notifications=True)
    state = write(client, identity, 2, statement_frequency='weekly')
    assert state['statement_frequency'] == 'weekly' and state['statement_enabled'] is True
    state = write(client, identity, 3, email_notifications=False)
    assert state['email_notifications'] is False and state['statement_enabled'] is False
    assert PushDevice.objects.filter(pk=device.pk).exists()
    assert NotificationPreference.objects.get(user=client.actor).expense_updates is True


def test_stale_or_duplicate_request_cannot_overwrite_a_later_choice(client):
    identity = uuid4()
    write(client, identity, 3, email_notifications=True)
    write(client, identity, 4, email_notifications=False)
    assert write(client, identity, 3, email_notifications=True)['email_notifications'] is False
    write(client, identity, 5, email_notifications=True)
    write(client, uuid4(), 1, email_notifications=False)
    assert write(client, identity, 5, email_notifications=True)['email_notifications'] is False
    assert write(client, identity, 2, email_notifications=True)['revision'] == 5


def test_push_tombstone_rejects_late_registration_and_old_delete_cannot_remove_new_on(client):
    installation = uuid4()
    body = {'provider': 'expo', 'platform': 'ios', 'token': f'ExpoPushToken[test-{installation}]'}
    assert send(client, 'put', f'/me/push-devices/{installation}', {**body, 'preference_revision': 1}).json()['enabled']
    assert send(client, 'delete', f'/me/push-devices/{installation}?preference_revision=2').json()['removed']
    assert not send(client, 'put', f'/me/push-devices/{installation}', {**body, 'preference_revision': 1}).json()['enabled']
    assert not PushDevice.objects.filter(pk=installation).exists()
    assert send(client, 'put', f'/me/push-devices/{installation}', {**body, 'preference_revision': 3}).json()['enabled']
    send(client, 'delete', f'/me/push-devices/{installation}?preference_revision=2')
    assert PushDevice.objects.filter(pk=installation).exists()
    send(client, 'delete', f'/me/push-devices/{installation}')
    assert not PushDevice.objects.filter(pk=installation).exists()
    assert not send(client, 'put', f'/me/push-devices/{installation}', body).json()['enabled']
    assert send(client, 'put', f'/me/push-devices/{installation}', {**body, 'token': 'ExpoPushToken[rotated]', 'preference_revision': 4}).json()['enabled']


def test_channel_inputs_require_a_valid_intent_and_verified_email(client):
    base = {'client_id': str(uuid4()), 'revision': 1}
    for patch in [{}, {'email_notifications': 'yes'}, {'statement_frequency': 'daily'}, {'revision': 0, 'email_notifications': True}]:
        assert send(client, 'put', '/me/notifications/channels', {**base, **patch}).status_code == 422
    EmailAddress.objects.filter(user=client.actor).delete()
    assert send(client, 'put', '/me/notifications/channels', {**base, 'email_notifications': True}).status_code == 422
    assert not NotificationPreference.objects.filter(user=client.actor, email_reminders=True).exists()


def test_retiring_legacy_mute_also_blocks_same_revision_v2_refresh_until_a_new_explicit_on(client):
    installation = uuid4()
    body = {'provider':'expo','platform':'ios','token':f'ExpoPushToken[test-{installation}]','preference_revision':7}
    assert send(client,'put',f'/me/push-devices/{installation}',body).json()['enabled']
    send(client,'put','/me/notifications/preferences',{'expense_updates':False,'email_reminders':True})
    state = write(client,uuid4(),1,email_notifications=True)
    assert {'id':str(installation),'revision':7} in state['muted_push_devices']
    assert send(client,'put',f'/me/push-devices/{installation}',body).json()['enabled'] is False
    assert send(client,'put',f'/me/push-devices/{installation}',{**body,'preference_revision':8}).json()['enabled'] is True
    assert not send(client,'get','/me/notifications/channels').json()['muted_push_devices']
