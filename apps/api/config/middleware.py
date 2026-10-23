from django.http import HttpResponseBadRequest, JsonResponse


def health_probe_only(get_response):
    def respond(request):
        if request.META.get("HTTP_HOST", "").split(":")[0] == "healthcheck.railway.app":
            if request.method not in ["GET", "HEAD"] or request.path not in [
                "/api/v1/health",
                "/api/v1/ready",
            ]:
                return HttpResponseBadRequest("Invalid health probe")
        return get_response(request)

    return respond


def email_code_only(get_response):
    def respond(request):
        path = request.path.rstrip("/")
        if path.startswith(("/_allauth/app/v1/", "/_allauth/browser/v1/")) and request.method not in {"GET", "HEAD", "OPTIONS"}:
            suffix = path.split("/v1/", 1)[1]
            allowed = (request.method == "POST" and suffix in {"auth/code/request", "auth/code/confirm"}) or (
                request.method == "DELETE" and suffix == "auth/session"
            )
            if not allowed:
                return JsonResponse({"status": 403, "errors": [{"message": "Use an email code to sign in."}]}, status=403)
        return get_response(request)

    return respond


def browser_account_scope(get_response):
    def respond(request):
        expected = request.headers.get("X-MeroSplit-Account")
        if expected and request.user.is_authenticated and str(request.user.pk) != expected:
            return JsonResponse({
                "error": "unauthorized",
                "detail": "This browser is signed in to another account. Sign in again. Your saved changes are safe.",
            }, status=401)
        return get_response(request)

    return respond
