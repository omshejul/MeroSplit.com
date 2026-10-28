import io
import json
from copy import deepcopy
from urllib.error import HTTPError

import pytest

from .category_gateway import (
    CATEGORIES,
    ENDPOINT,
    MODEL,
    CategoryUnavailable,
    decision_category,
    evaluate_title,
)


def decision(category="food", probability=0.95):
    weights = {key: (1 - probability) / (len(CATEGORIES) - 1) for key in CATEGORIES}
    weights[category] = probability
    return {
        "model": MODEL,
        "answers": {"category": {"type": "choice", "choice": category, "probabilities": weights}},
    }


@pytest.mark.parametrize("category", CATEGORIES)
def test_choice_uses_fixed_categories_and_fifty_percent_confidence(category):
    assert decision_category(decision(category)) == (None if category == "general" else category)
    assert decision_category(decision(category, 0.49)) is None
    assert decision_category(decision(category, 0.5)) == (None if category == "general" else category)


@pytest.mark.parametrize("bad", [None, [], {}, {"model": "another/model"}, {"model": MODEL, "answers": None}])
def test_unknown_response_is_not_a_category(bad):
    assert decision_category(bad) is None


@pytest.mark.parametrize(
    "change", ["unknown", "missing", "nan", "boolean", "wrong_choice", "wrong_type", "invalid_sum"]
)
def test_malformed_probabilities_never_invent_an_icon(change):
    data = deepcopy(decision())
    answer = data["answers"]["category"]
    if change == "unknown":
        answer["probabilities"]["invented"] = 0
    elif change == "missing":
        answer["probabilities"].pop("general")
    elif change == "nan":
        answer["probabilities"]["food"] = float("nan")
    elif change == "boolean":
        answer["probabilities"]["food"] = True
    elif change == "wrong_choice":
        answer["choice"] = "rent"
    elif change == "wrong_type":
        answer["type"] = "score"
    else:
        answer["probabilities"]["food"] = 0.5
    assert decision_category(data) is None


def test_outbound_request_contains_only_title_and_fixed_definitions_without_fallbacks():
    calls = []

    def send(request, timeout):
        calls.append((request, timeout))
        return io.BytesIO(json.dumps(decision()).encode())

    assert evaluate_title("Synthetic dinner", "synthetic-key", send=send) == "food"
    request, timeout = calls[0]
    assert timeout == 2.5 and request.full_url == ENDPOINT and request.method == "POST"
    payload = json.loads(request.data)
    assert set(payload) == {"model", "state", "questions"}
    assert payload["model"] == MODEL and payload["state"] == "Synthetic dinner"
    assert payload["questions"]["category"]["criteria"] == CATEGORIES
    assert request.headers["Authorization"] == "Bearer synthetic-key"


def test_missing_key_and_invalid_title_do_not_make_a_provider_request():
    def unexpected(*args, **kwargs):
        raise AssertionError("No provider call expected")

    with pytest.raises(CategoryUnavailable, match="not_configured"):
        evaluate_title("Synthetic title", "", send=unexpected)
    for title in ["", " ", "x" * 201, None]:
        with pytest.raises(CategoryUnavailable, match="invalid_title"):
            evaluate_title(title, "synthetic-key", send=unexpected)


def test_provider_failure_does_not_echo_a_title_key_or_provider_error_body():
    def failed(request, timeout):
        raise HTTPError(ENDPOINT, 503, "secret provider message", {}, io.BytesIO(b"secret body"))

    with pytest.raises(CategoryUnavailable) as error:
        evaluate_title("Private synthetic title", "synthetic-key", send=failed)
    assert str(error.value) == "gateway_http_503"


@pytest.mark.parametrize("chosen", ["food", "rent"])
def test_fifty_percent_tie_needs_no_lead(chosen):
    data = decision(chosen, 0.5)
    answer = data["answers"]["category"]
    answer["probabilities"] = {key: 0 for key in CATEGORIES}
    answer["probabilities"].update(food=0.5, rent=0.5)
    assert decision_category(data) == chosen
