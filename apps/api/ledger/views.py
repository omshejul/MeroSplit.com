from django.http import HttpResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from ninja.errors import HttpError

from .collaboration import guest_view


@ensure_csrf_cookie
def invite_page(request, token):
    try:
        data = guest_view(token)
    except HttpError:
        return HttpResponse("Invitation expired or revoked.", status=404, content_type="text/plain")
    response = render(
        request,
        "ledger/invite.html",
        {"data": data, "token": token, "viewer_id": request.user.pk},
    )
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Frame-Options"] = "DENY"
    return response
