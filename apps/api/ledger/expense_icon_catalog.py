"""The shared vocabulary for automatic and explicitly selected bill icons."""
import json
from pathlib import Path
from typing import Literal

_catalog = json.loads((Path(__file__).parent / "assets" / "expense-icons.json").read_text())
OPTIONS = _catalog["options"]
LEGACY_ALIASES = _catalog["aliases"]
IconChoice = Literal["auto", *OPTIONS]


def canonical_icon(value):
    key = "".join(char for char in (value or "").casefold() if char.isalpha())
    return LEGACY_ALIASES.get(key, key if key in OPTIONS else "general")
