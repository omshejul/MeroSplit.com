"""Public application associations for canonical sign-in and ledger routes."""

from django.http import JsonResponse
from django.views.decorators.http import require_safe

APPLE_ASSOCIATION = {
    "applinks": {
        "details": [
            {"appIDs": ["M4K84L4TKR.com.omshejul.splitdumb"], "components": [
                {"/": "/app/sign-in/*"}, {"/": "/app/groups/*"},
                {"/": "/app/invite/*"}, {"/": "/invite/*"},
            ]}
        ]
    }
}

ANDROID_ASSOCIATION = [
    {
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": "com.omshejul.splitdumb",
            "sha256_cert_fingerprints": [
                "56:1A:0D:8E:4F:76:48:85:1C:F4:E0:D9:59:3D:AA:8A:8C:66:84:3B:06:47:3D:74:62:0D:25:6A:8D:58:1F:54",
                "AC:28:B3:6D:8D:ED:87:F6:3F:E8:A8:92:87:95:C4:BB:86:1B:15:58:AB:9E:3F:60:51:B1:48:5E:4B:28:A5:A8",
                "00:B1:CB:8A:DB:28:E8:35:2B:35:72:56:42:77:04:8A:BE:B1:EC:1D:C5:FE:C4:F5:E1:17:3F:1B:DA:00:58:EC",
            ],
        },
    }
]


def _association(payload):
    response = JsonResponse(payload, safe=False)
    response["Cache-Control"] = "public, max-age=300, must-revalidate"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@require_safe
def apple_association(request):
    return _association(APPLE_ASSOCIATION)


@require_safe
def android_association(request):
    return _association(ANDROID_ASSOCIATION)
