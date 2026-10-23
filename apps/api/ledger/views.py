from django.http import HttpResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from ninja.errors import HttpError

from .collaboration import guest_view


def invite_review(data):
    names = {person["id"]: person["name"] for person in data["participants"]}

    def money(amount):
        amount = abs(int(amount))
        return f"₹{amount // 100:,}" + (f".{amount % 100:02}" if amount % 100 else "")

    def position(amount):
        if int(amount) > 0:
            return f"Owed {money(amount)}"
        if int(amount) < 0:
            return f"Owes {money(amount)}"
        return "Settled up"

    return {
        "balance": position(data["balance"]),
        "opening": None if not data["opening_balance"] else {
            **data["opening_balance"], "position": position(data["opening_balance"]["amount"]),
        },
        "expenses": [{
            **bill, "amount": money(bill["total"]),
            "payers": [{"name": names[person], "amount": money(amount)}
                       for person, amount in bill["paid"].items() if int(amount)],
            "shares": [{"name": names[person], "amount": money(amount)}
                       for person, amount in bill["shares"].items() if int(amount)],
        } for bill in data["expenses"]],
        "settlements": [{
            **payment, "amount": money(payment["amount"]),
            "sender_name": names[payment["sender"]], "recipient_name": names[payment["recipient"]],
        } for payment in data["settlements"]],
    }


@ensure_csrf_cookie
def invite_page(request, token):
    try:
        data = guest_view(token)
    except HttpError:
        return HttpResponse("Invitation expired or revoked.", status=404, content_type="text/plain")
    response = render(
        request,
        "ledger/invite.html",
        {"data": data, "review": invite_review(data), "token": token, "viewer_id": request.user.pk},
    )
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Frame-Options"] = "DENY"
    return response
