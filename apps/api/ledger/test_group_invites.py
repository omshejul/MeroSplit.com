import json
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import Client

from .models import Change, CommandReceipt, Expense, ExpenseNotice, Group, GroupInviteLink, Participant
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db

def account(name="New member"):
    email = f"{uuid4().hex}@example.invalid"
    return authenticated_client(get_user_model().objects.create_user(username=email, email=email, first_name=name))

def link(owner, gid):
    r = send(owner, "post", f"/groups/{gid}/invite-link", {"command_id": uid()})
    assert r.status_code == 200, r.content
    assert r["Cache-Control"] == "private, no-store"
    url = r.json()["url"]
    assert urlsplit(url).path.startswith("/j/") and not urlsplit(url).query and not urlsplit(url).fragment
    return urlsplit(url).path.removeprefix("/j/")

def join(actor, token, command=None):
    return send(actor, "post", "/group-invite-links/join", {"command_id": command or uid(), "token": token})

def test_reusable_new_members_no_guest_takeover(client, group):
    gid, ids, _ = group
    assert send(client, "post", f"/groups/{gid}/expenses", expense(ids)).status_code == 200
    before = list(Expense.objects.values()), ExpenseNotice.objects.count()
    token = link(client, gid)
    assert link(client, gid) == token and GroupInviteLink.objects.count() == 1
    for name in ["B", "New friend"]:
        person = account(name)
        preview = send(person, "post", "/group-invite-links/preview", {"token": token})
        assert preview.status_code == 200 and preview.json() == {"name": "Functional test", "already_member": False, "version": Group.objects.get(pk=gid).version, "people": [{"id": p, "name": n} for p, n in sorted(zip(ids[1:], ["B", "C"]))]}
        assert Participant.objects.filter(user=person.actor).count() == 0
        command = uid()
        r = join(person, token, command)
        assert r.status_code == 200 and r.json()["id"] == gid
        assert join(person, token, command).json() == r.json()
        assert join(person, token).status_code == 200
        p = Participant.objects.get(group_id=gid, user=person.actor)
        assert str(p.id) not in ids and Group.objects.get(pk=gid).owner_id == client.actor.pk
        state = send(person, "get", f"/groups/{gid}").json()
        assert state["balances"][str(p.id)] == "0"
        change = Change.objects.get(group_id=gid, kind="participant_added", actor=person.actor)
        assert change.data == {"id": str(p.id), "name": p.name, "linked_participant_ids": [str(p.id)]}
        activity = send(client, "get", "/activity").json()["items"]
        event = next(row for row in activity if row["id"] == str(change.id))
        assert event["kind"] == "member_added" and event["person"] == {"id": str(p.id), "name": p.name, "is_self": False}
        exported = send(client, "get", f"/groups/{gid}/export?format=json").json()["group"]
        exported_event = next(row for row in exported["activity"] if row["sequence"] == change.sequence)
        assert exported_event["kind"] == "participant_added" and exported_event["data"] == change.data

    assert Participant.objects.filter(id__in=ids[1:], user__isnull=True).count() == 2
    assert (list(Expense.objects.values()), ExpenseNotice.objects.count()) == before
    assert token not in json.dumps(list(Change.objects.values("data")))
    assert token not in json.dumps(list(CommandReceipt.objects.values("result")))

def test_unauthenticated_and_get_are_safe(client, group):
    gid, *_ = group
    token = link(client, gid)
    count = Participant.objects.count()
    guest = Client()
    assert send(guest, "post", "/group-invite-links/preview", {"token": token}).status_code == 401
    assert join(guest, token).status_code == 401
    for path in ["/group-invite-links/preview", "/group-invite-links/join"]:
        assert send(client, "get", path).status_code == 405
    assert Participant.objects.count() == count
    bad = send(account(), "post", "/group-invite-links/preview", {"token": token[:-1] + ("x" if token[-1] != "x" else "y")})
    assert bad.status_code == 404 and token not in bad.content.decode()

def test_inviter_and_closed_group_rules(client, group):
    gid, *_ = group
    token = link(client, gid)
    member = account()
    assert join(member, token).status_code == 200
    assert send(member, "post", f"/groups/{gid}/invite-link", {"command_id": uid()}).status_code == 403
    assert send(account(), "post", f"/groups/{gid}/invite-link", {"command_id": uid()}).status_code == 404
    for field in ["archived", "is_direct"]:
        Group.objects.filter(pk=gid).update(**{field: True})
        assert join(account(), token).status_code == 404
        assert send(client, "post", f"/groups/{gid}/invite-link", {"command_id": uid()}).status_code in [403, 409]
        Group.objects.filter(pk=gid).update(**{field: False})
    Group.objects.filter(pk=gid).update(owner=member.actor)
    assert join(account(), token).status_code == 404
    new = link(member, gid)
    assert new != token
    assert join(account(), new).status_code == 200
    Group.objects.filter(pk=gid).delete()
    assert join(account(), new).status_code == 404

def test_hidden_and_removed_replay(client, group):
    gid, *_ = group
    token = link(client, gid)
    member = account()
    command = uid()
    assert join(member, token, command).status_code == 200
    p = Participant.objects.get(group_id=gid, user=member.actor)
    Participant.objects.filter(pk=p.pk).update(hidden=True)
    assert join(member, token).status_code == 200
    p.refresh_from_db()
    assert p.hidden
    Participant.objects.filter(pk=p.pk).update(removed=True)
    assert join(member, token, command).status_code == 403
    assert send(member, "post", "/group-invite-links/preview", {"token": token}).status_code == 403
    p.refresh_from_db()
    assert p.removed and p.hidden

@pytest.mark.django_db(transaction=True)
def test_concurrent_join_once(client, group):
    gid, *_ = group
    token = link(client, gid)
    member = account()
    user_id = member.actor.pk
    def attempt(_):
        close_old_connections()
        try:
            return join(authenticated_client(get_user_model().objects.get(pk=user_id)), token).status_code
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(attempt, range(2))) == [200, 200]
    assert Participant.objects.filter(group_id=gid, user_id=user_id).count() == 1
    assert Change.objects.filter(group_id=gid, kind="participant_added", actor_id=user_id).count() == 1


def test_solo_group_records_bill_then_first_friend_joins_without_rewriting_history(client):
    gid, own = uid(), uid()
    payload = {"command_id": uid(), "id": gid, "name": "Solo trip", "self_participant_id": own, "participants": [{"id": own, "name": "You"}]}
    assert send(client, "post", "/groups", payload).status_code == 200
    assert send(client, "post", f"/groups/{gid}/expenses", expense([own], beneficiaries=[0])).status_code == 200
    original = list(Expense.objects.values())
    token = link(client, gid)
    friend = account()
    assert join(friend, token).status_code == 200
    state = send(client, "get", f"/groups/{gid}").json()
    assert len(state["participants"]) == 2 and set(state["balances"].values()) == {"0"} and not state["transfers"]
    assert list(Expense.objects.values()) == original


def test_creation_saves_guest_emails_without_sending_invitations(client):
    from .models import Invite, MembershipDelivery
    known = account("Known")
    from allauth.account.models import EmailAddress
    EmailAddress.objects.create(user=known.actor, email=known.actor.email, verified=True, primary=True)
    own, guest, joined = uid(), uid(), uid()
    gid = uid()
    payload = {"command_id": uid(), "id": gid, "name": "Optional people", "self_participant_id": own,
               "participants": [{"id": own, "name": "You"}, {"id": guest, "name": "Guest", "email": "friend@example.invalid"}, {"id": joined, "name": "Known", "email": known.actor.email}]}
    assert send(client, "post", "/groups", payload).status_code == 200
    assert Participant.objects.get(pk=guest).contact_email == "friend@example.invalid"
    assert Participant.objects.get(pk=guest).user_id is None
    assert Participant.objects.get(pk=joined).user_id == known.actor.pk
    assert Invite.objects.count() == 0
    # Existing known-account notification behavior is preserved, no invite emails are sent here.
    assert not MembershipDelivery.objects.filter(recipient_email="friend@example.invalid").exists()


@pytest.mark.parametrize("accepted", [False, True])
def test_join_preserves_pending_and_accepted_opening_balances(client, group, accepted):
    from .models import OpeningBalance
    from .test_collaboration import link as link_person
    gid, ids, _ = group
    borrower, creditor = account("Borrower"), account("Creditor")
    link_person(client, borrower, gid, ids[1])
    link_person(client, creditor, gid, ids[2])
    body = {"command_id": uid(), "id": uid(), "balances": {ids[0]: "0", ids[1]: "-500", ids[2]: "500"}, "source": "Agreed previous balances", "cutoff": "2026-10-16"}
    assert send(client, "post", f"/groups/{gid}/opening-balances", body).status_code == 200
    endpoint = f"/groups/{gid}/opening-balances/{body['id']}/acknowledge"
    if accepted:
        for member in [borrower, creditor]:
            assert send(member, "post", endpoint, {"command_id": uid()}).status_code == 200
    before = OpeningBalance.objects.values().get(group_id=gid)
    balances = send(client, "get", f"/groups/{gid}").json()["balances"]
    friend = account("First link member")
    assert join(friend, link(client, gid)).status_code == 200
    person = Participant.objects.get(group_id=gid, user=friend.actor)
    state = send(friend, "get", f"/groups/{gid}").json()
    assert OpeningBalance.objects.values().get(group_id=gid) == before
    assert state["balances"] == {**balances, str(person.id): "0"}
    assert state["opening_balance"]["accepted"] is accepted
    if not accepted:
        for member in [borrower, creditor]:
            assert send(member, "post", endpoint, {"command_id": uid()}).status_code == 200
        final = send(friend, "get", f"/groups/{gid}").json()
        assert final["opening_balance"]["accepted"] is True
        assert final["balances"] == {**body["balances"], str(person.id): "0"}
