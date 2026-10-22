from django.http import HttpResponseBadRequest


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
