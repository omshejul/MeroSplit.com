from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace

import pytest
from django.db import close_old_connections, connections
from django.utils import timezone

from . import mcp_oauth as oauth

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def clock(monkeypatch):
    value = SimpleNamespace(now=timezone.now())
    monkeypatch.setattr(oauth.timezone, "now", lambda: value.now)
    return value


def tool(user=1, grant=1, network="synthetic-network"):
    oauth.rate_limit("tool", network, user_id=user, grant_id=grant)


def limited(action, seconds=1):
    with pytest.raises(oauth.OAuthError) as error:
        action()
    assert error.value.status == 429
    assert error.value.retry_after_seconds == seconds


def test_client_burst_refills_fractionally_without_a_minute_reset(clock):
    for _ in range(20):
        tool()
    limited(tool)
    clock.now += timedelta(microseconds=999_999)
    limited(tool)
    clock.now += timedelta(microseconds=1)
    tool()
    limited(tool)


def test_idle_time_never_accumulates_more_than_the_burst(clock):
    tool()
    clock.now += timedelta(hours=1)
    for _ in range(20):
        tool()
    limited(tool)


def test_account_budget_is_shared_across_clients_but_not_accounts(clock):
    for grant in (1, 2):
        for _ in range(20):
            tool(grant=grant)
    limited(lambda: tool(grant=3))
    tool(user=2, grant=4)
    clock.now += timedelta(milliseconds=500)
    tool(grant=3)
    limited(lambda: tool(grant=3))


def test_changing_network_does_not_reset_an_authorized_client(clock):
    for _ in range(20):
        tool(network="one")
    limited(lambda: tool(network="two"))


def test_connection_burst_has_its_own_ten_per_second_refill(clock):
    def connect():
        oauth.rate_limit("connection", "synthetic-network", user_id=1, grant_id=1)
    for _ in range(100):
        connect()
    limited(connect)
    clock.now += timedelta(milliseconds=100)
    connect()
    limited(connect)
    # Discovery and unsuccessful login attempts do not spend ledger tokens.
    for _ in range(60):
        oauth.rate_limit("invalid-auth", "synthetic-network")
    limited(lambda: oauth.rate_limit("invalid-auth", "synthetic-network"), seconds=60)
    for _ in range(20):
        tool()


def test_rejected_client_does_not_spend_other_budgets(clock):
    for _ in range(20):
        tool(grant=1)
    for _ in range(19):
        tool(grant=2)
    limited(lambda: tool(grant=1))
    tool(grant=2)
    limited(lambda: tool(grant=2))


def test_global_budget_is_shared_and_refills_ten_per_second(clock):
    for user in range(10):
        for _ in range(20):
            tool(user=user, grant=user)
    limited(lambda: tool(user=11, grant=11))
    clock.now += timedelta(milliseconds=100)
    tool(user=11, grant=11)
    limited(lambda: tool(user=11, grant=11))


def test_two_workers_cannot_spend_the_same_last_token(clock):
    for _ in range(19):
        tool()
    barrier = Barrier(2)

    def attempt():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            tool()
            return "allowed"
        except oauth.OAuthError:
            return "limited"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: attempt(), range(2))) == ["allowed", "limited"]
    limited(tool)


def test_backward_clock_never_refills_early_and_reports_the_real_wait(clock):
    for _ in range(20):
        tool()
    clock.now -= timedelta(seconds=10)
    limited(tool, seconds=11)
    clock.now += timedelta(seconds=11)
    tool()
