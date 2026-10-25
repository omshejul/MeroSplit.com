import pytest

from .test_api import client as client
from .test_api import expense, send
from .test_api import group as group

pytestmark = pytest.mark.django_db


def test_october_bill_is_first_in_unfiltered_summary_even_when_old_bills_exclude_current_person(client, group):
    group_id, people, _ = group
    for title, day in [("Electricity april", "2026-05-15"), ("Cleaning liquid", "2026-05-12"), ("Garbage", "2026-05-11")]:
        old = expense(people, total="30000") | {
            "description": title, "date": day, "paid": {people[1]: "30000"},
            "split": {"mode": "equal", "values": {people[1]: "1", people[2]: "1"}},
        }
        assert send(client, "post", f"/groups/{group_id}/expenses", old).status_code == 200
    current = expense(people, total="30000") | {"description": "Garbage man", "date": "2026-10-19"}
    assert send(client, "post", f"/groups/{group_id}/expenses", current).status_code == 200
    full = send(client, "get", f"/groups/{group_id}").json()
    summary = send(client, "get", f"/groups/{group_id}/summary?limit=2").json()
    assert summary["balances"] == full["balances"]
    assert summary["balances"][people[0]] == "20000"
    assert summary["expenses"][0]["id"] == current["id"]
    assert summary["transactions"][0]["bill"]["id"] == current["id"]
    assert summary["transactions"][1]["bill"]["shares"].get(people[0], "0") == "0"
    assert summary["history"]["transactions"]["next_cursor"]
