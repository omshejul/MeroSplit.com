from django.shortcuts import render
from django.views.decorators.http import require_safe

from .mcp_oauth import issuer_url, resource_url


@require_safe
def setup(request):
    response = render(request, "ledger/mcp_setup.html", {"endpoint": resource_url(), "setup_url": f"{issuer_url()}/mcp/setup",
        "login_helper_url": f"{issuer_url()}/mcp/login.py", "device_url": f"{issuer_url()}/mcp/device"})
    response["Cache-Control"] = "public, max-age=300"
    response["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    response["Referrer-Policy"] = "no-referrer"
    return response
