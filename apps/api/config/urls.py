from django.urls import include, path
from django.views.generic import TemplateView
from ledger.api import api
from ledger.views import invite_page

urlpatterns = [
    path("privacy", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "privacy"})),
    path("support", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "support"})),
    path("delete-account", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "delete"})),
    path("invite/<str:token>", invite_page),
    path("api/v1/", api.urls),
    path("_allauth/", include("allauth.headless.urls")),
]
