"""Mailbox opt-out is an explicit CSRF-protected action, never a link preview."""
from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters
from ninja.errors import HttpError

from .bill_email import opt_out
from .otp import EmailCodeLimited, client_network, consume_limits


@csrf_protect
@sensitive_post_parameters()
def stop_bill_emails(request, notice_id):
    if request.method in {'GET', 'HEAD'}:
        response = render(request, 'ledger/bill_email_stop.html', {'notice_id': notice_id})
    elif request.method == 'POST':
        try:
            with transaction.atomic():
                consume_limits([('bill-email-optout-network', client_network(request), 60, 30), ('bill-email-optout-global', 'all', 60, 300)])
            if int(request.META.get('CONTENT_LENGTH') or 0) > 4096:
                return HttpResponse(status=400)
            if set(request.POST) - {'proof', 'csrfmiddlewaretoken'} or len(request.POST.getlist('proof')) != 1:
                return HttpResponse(status=400)
            opt_out(notice_id, request.POST.get('proof'))
            response = render(request, 'ledger/bill_email_stop.html', {'stopped': True})
        except (HttpError, EmailCodeLimited):
            return JsonResponse({'detail': 'This email preference link is unavailable. Sign in to change email preferences.'}, status=400)
    else:
        return HttpResponse(status=405)
    response['Cache-Control'] = 'no-store'
    response['Referrer-Policy'] = 'no-referrer'
    response['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    return response
