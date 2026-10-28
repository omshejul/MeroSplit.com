"""Cosmetic expense icons. Financial category and ledger writes stay separate."""

import hashlib
import json
import math
import urllib.error
import urllib.request

MODEL = "typesafe-ai/jev"
ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate"
CATEGORIES = {
    "food": "Restaurant01Icon",
    "groceries": "ShoppingBasket01Icon",
    "water": "WaterEnergyIcon",
    "utilities": "FlashIcon",
    "transport": "Car01Icon",
    "travel": "Airplane01Icon",
    "rent": "Home01Icon",
    "shopping": "ShoppingBag01Icon",
    "entertainment": "Ticket01Icon",
    "health": "HealthIcon",
    "education": "Book01Icon",
    "coffee": "Coffee01Icon",
    "tea": "TeaIcon",
    "bakery": "Bread01Icon",
    "dessert": "CakeSliceIcon",
    "fastfood": "Pizza01Icon",
    "alcohol": "BeerIcon",
    "produce": "CarrotIcon",
    "meat": "SteakIcon",
    "seafood": "FishIcon",
    "dairy": "MilkCartonIcon",
    "snacks": "PopcornIcon",
    "electricity": "ElectricPlugsIcon",
    "gas": "GasStoveIcon",
    "internet": "Wifi01Icon",
    "mobile": "SmartPhone02Icon",
    "household": "KitchenUtensilsIcon",
    "cleaning": "CleaningBucketIcon",
    "laundry": "WashingMachineIcon",
    "repairs": "RepairIcon",
    "furniture": "Sofa01Icon",
    "appliances": "FridgeIcon",
    "electronics": "ComputerIcon",
    "clothing": "TShirtIcon",
    "footwear": "ShoesIcon",
    "beauty": "PerfumeIcon",
    "haircut": "Scissor01Icon",
    "taxi": "TaxiIcon",
    "bus": "Bus01Icon",
    "train": "Train01Icon",
    "metro": "MetroIcon",
    "fuel": "FuelStationIcon",
    "parking": "CircleParkingIcon",
    "tolls": "Road01Icon",
    "cycling": "BicycleIcon",
    "carmaintenance": "Car02Icon",
    "flights": "Airplane02Icon",
    "hotel": "Hotel01Icon",
    "movies": "Film01Icon",
    "music": "Music01Icon",
    "gaming": "GameController01Icon",
    "sports": "FootballIcon",
    "fitness": "Dumbbell01Icon",
    "books": "Book02Icon",
    "stationery": "PencilIcon",
    "tuition": "School01Icon",
    "childcare": "BabyBottleIcon",
    "pets": "PawPrintIcon",
    "gifts": "GiftIcon",
    "charity": "CharityIcon",
    "insurance": "Shield02Icon",
    "taxes": "TaxesIcon",
    "bankfees": "CreditCardIcon",
    "shipping": "DeliveryBox01Icon",
    "office": "OfficeIcon",
    "medicine": "Medicine01Icon",
    "dental": "DentalToothIcon",
    "flowers": "Flower01Icon",
    "photography": "Camera01Icon",
    "subscriptions": "RepeatIcon",
    "software": "SoftwareIcon",
    "garbage": "TrashIcon",
    "wastecollection": "GarbageTruckIcon",
    "recycling": "Recycle02Icon",
    "general": "Invoice01Icon"
}
ICONS = {icon: icon for icon in CATEGORIES.values()}
ICON_CATEGORIES = {icon: category for category, icon in CATEGORIES.items()}

INSTRUCTIONS = 'Pick the icon from Hugeicons Core Free (@hugeicons/core-free-icons) that best represents this title.'

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
