"""Cosmetic expense icons. Financial category and ledger writes stay separate."""

import hashlib
import json
import math
import urllib.error
import urllib.request

from .expense_icon_catalog import OPTIONS

MODEL = "typesafe-ai/jev"
ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate"

CATEGORIES = {key: option[1] for key, option in OPTIONS.items()}
ICONS = {option[1]: f"{option[0]}: {option[2]}" for option in OPTIONS.values()}
ICON_CATEGORIES = {icon: category for category, icon in CATEGORIES.items()}

INSTRUCTIONS = "Pick the one broad bill icon that best represents the title. Use the supplied meanings rather than inventing a more specific icon."

def definition_revision():
    return hashlib.sha256(json.dumps({
        "model": MODEL,
        "criteria": ICONS,
        "categories": CATEGORIES,
        "instructions": INSTRUCTIONS,
    }, sort_keys=True).encode()).hexdigest()


DEFINITION_REVISION = definition_revision()


class CategoryUnavailable(Exception):
    """A safe code, never provider bodies, expense text or credentials."""


def decision_category(result):
    if not isinstance(result, dict) or result.get("model") != MODEL:
        return None
    answers = result.get("answers")
    if not isinstance(answers, dict):
        return None
    answer = answers.get("icon", {})
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return None
    probabilities = answer.get("probabilities")
    if not isinstance(probabilities, dict) or set(probabilities) != set(ICONS):
        return None
    if any(
        type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()
    ):
        return None
    if abs(sum(probabilities.values()) - 1) > 0.02:
        return None
    # The fixed icon order makes exact ties deterministic across responses.
    return ICON_CATEGORIES[max(ICONS, key=probabilities.get)]


def evaluate_title(title, key, *, send=urllib.request.urlopen):
    if not key:
        raise CategoryUnavailable("not_configured")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise CategoryUnavailable("invalid_title")
    payload = {
        "model": MODEL,
        "state": title,
        "questions": {
            "icon": {
                "type": "choice",
                "instructions": INSTRUCTIONS,
                "criteria": ICONS,
            }
        },
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with send(request, timeout=2.5) as response:
            raw = response.read(64_001)
        if len(raw) > 64_000:
            raise CategoryUnavailable("invalid_response")
        return decision_category(json.loads(raw))
    except urllib.error.HTTPError as error:
        raise CategoryUnavailable(f"gateway_http_{error.code}") from None
    except (OSError, ValueError, TypeError, AttributeError):
        raise CategoryUnavailable("gateway_unavailable") from None
