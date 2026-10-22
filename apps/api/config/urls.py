from django.urls import include, path
from ledger.api import api
from ledger.views import invite_page

urlpatterns = [
    path("invite/<str:token>", invite_page),
    path("api/v1/", api.urls),
    path("_allauth/", include("allauth.headless.urls")),
]
