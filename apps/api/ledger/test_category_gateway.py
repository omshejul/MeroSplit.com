import io
import json
from copy import deepcopy
from urllib.error import HTTPError

import pytest

from .category_gateway import (
    CATEGORIES,
    ENDPOINT,
    ICONS,
    INSTRUCTIONS,
    MODEL,
    CategoryUnavailable,
    decision_category,
    evaluate_title,
)


def decision(category="food", probability=0.95):
    weights = {key: (1 - probability) / (len(ICONS) - 1) for key in ICONS}
    weights[CATEGORIES[category]] = probability
    return {
        "model": MODEL,
        "answers": {"icon": {"type": "choice", "choice": CATEGORIES[category], "probabilities": weights}},
    }


@pytest.mark.parametrize("category", CATEGORIES)
def test_choice_uses_the_top_category_without_a_confidence_cutoff(category):
    assert decision_category(decision(category)) == category
    assert decision_category(decision(category, 0.06)) == category


@pytest.mark.parametrize("bad", [None, [], {}, {"model": "another/model"}, {"model": MODEL, "answers": None}])
def test_unknown_response_is_not_a_category(bad):
    assert decision_category(bad) is None


@pytest.mark.parametrize(
    "change", ["unknown", "missing", "nan", "boolean", "wrong_type", "invalid_sum"]
)
def test_malformed_probabilities_never_invent_an_icon(change):
    data = deepcopy(decision())
    answer = data["answers"]["icon"]
    if change == "unknown":
        answer["probabilities"]["invented"] = 0
    elif change == "missing":
        answer["probabilities"].pop("Invoice01Icon")
    elif change == "nan":
        answer["probabilities"]["Restaurant01Icon"] = float("nan")
    elif change == "boolean":
        answer["probabilities"]["Restaurant01Icon"] = True
    elif change == "wrong_type":
        answer["type"] = "score"
    else:
        answer["probabilities"]["Restaurant01Icon"] = 0.5
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
    assert payload["questions"] == {"icon": {
        "type": "choice", "instructions": INSTRUCTIONS, "criteria": ICONS,
    }}
    assert "broad bill icon" in INSTRUCTIONS
    assert len(ICONS) == len(CATEGORIES) == 20
    assert all(key.endswith("Icon") and value for key, value in ICONS.items())
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


def test_highest_probability_wins_even_if_the_reported_choice_disagrees():
    data = decision("transport", 0.3)
    data["answers"]["icon"]["choice"] = "Invoice01Icon"
    assert decision_category(data) == "transport"


def test_exact_ties_use_the_fixed_category_order():
    data = decision()
    answer = data["answers"]["icon"]
    answer["probabilities"] = {key: 0 for key in reversed(ICONS)}
    answer["probabilities"].update(Restaurant01Icon=0.5, Home01Icon=0.5)
    assert decision_category(data) == "food"


def test_old_category_response_cannot_populate_the_new_icon_cache():
    data = decision()
    data["answers"]["category"] = data["answers"].pop("icon")
    assert decision_category(data) is None
