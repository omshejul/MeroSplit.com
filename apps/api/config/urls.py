from allauth.headless.constants import Client
from django.urls import include, path, re_path
from django.views.generic import TemplateView
from ledger import mcp_oauth_views
from ledger.api import api
from ledger.auth_views import (
    ConfirmEmailCodeView,
    ExchangeEmailLinkView,
    RenewEmailLinkView,
    RequestEmailCodeView,
    RequestEmailLinkView,
    ResumeEmailLinkView,
)
from ledger.bill_email_views import stop_bill_emails
from ledger.mcp_setup import setup as mcp_setup

from config.associations import android_association, apple_association
from config.web import invite_app, public_asset, web_app, web_media

urlpatterns = [
    path("assets/typography.css", public_asset, {"asset": "typography.css"}),
    path("assets/fonts/StackSansText.ttf", public_asset, {"asset": "StackSansText.ttf"}),
    path("assets/home.css", public_asset, {"asset": "home.css"}),
    path("assets/merosplit-icon.png", public_asset, {"asset": "merosplit-icon.png"}),
    path("mcp/setup", mcp_setup),
    path("bill-email/opt-out/<uuid:notice_id>", stop_bill_emails),
    path(".well-known/oauth-authorization-server", mcp_oauth_views.metadata),
    path(".well-known/oauth-protected-resource", mcp_oauth_views.resource_metadata),
    path(".well-known/oauth-protected-resource/mcp", mcp_oauth_views.resource_metadata),
    path("oauth/register", mcp_oauth_views.register),
    path("oauth/authorize", mcp_oauth_views.authorize),
    path("oauth/token", mcp_oauth_views.token),
    path("oauth/revoke", mcp_oauth_views.revoke),
    path("", TemplateView.as_view(template_name="ledger/home.html")),
    path("robots.txt", TemplateView.as_view(template_name="ledger/robots.txt", content_type="text/plain; charset=utf-8")),
    path("sitemap.xml", TemplateView.as_view(template_name="ledger/sitemap.xml", content_type="application/xml; charset=utf-8")),
    path(".well-known/apple-app-site-association", apple_association),
    path(".well-known/assetlinks.json", android_association),
    path("app/media/<uuid:file_id>", web_media),
    re_path(r"^app(?:/(?P<path>.*))?$", web_app),
    path("_allauth/app/v1/auth/code/request", RequestEmailCodeView.as_api_view(client=Client.APP)),
    path("_allauth/app/v1/auth/code/confirm", ConfirmEmailCodeView.as_api_view(client=Client.APP)),
    path("_allauth/browser/v1/auth/code/request", RequestEmailCodeView.as_api_view(client=Client.BROWSER)),
    path("_allauth/browser/v1/auth/code/confirm", ConfirmEmailCodeView.as_api_view(client=Client.BROWSER)),
    *[path(f"_allauth/{client}/v1/auth/link/{action}", view.as_api_view(client=kind))
      for client, kind in [("browser", Client.BROWSER), ("app", Client.APP)]
      for action, view in [("request", RequestEmailLinkView), ("exchange", ExchangeEmailLinkView),
                           ("resume", ResumeEmailLinkView), ("renew", RenewEmailLinkView)]],
    path("privacy", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "privacy"})),
    path("chat-policy", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "chat"})),
    path("support", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "support"})),
    path("delete-account", TemplateView.as_view(template_name="ledger/public.html", extra_context={"page": "delete"})),
    path("invite/<str:token>", invite_app),
    path("api/v1/", api.urls),
    path("_allauth/", include("allauth.headless.urls")),
]
