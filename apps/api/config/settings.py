import json
import os
from pathlib import Path
from urllib.parse import urlsplit as _urlsplit

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "")
R2_REGION = os.environ.get("R2_REGION", "auto")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_SECRET_KEY is required")
    SECRET_KEY = "local-development-only-do-not-deploy"
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",")
if os.environ.get("RAILWAY_PUBLIC_DOMAIN"):
    ALLOWED_HOSTS.append(os.environ["RAILWAY_PUBLIC_DOMAIN"])
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.sites",
    "allauth",
    "allauth.account",
    "allauth.headless",
    "ledger",
]
MIDDLEWARE = [
    "config.middleware.health_probe_only",
    "django.middleware.security.SecurityMiddleware",
    "config.middleware.email_code_only",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "config.middleware.browser_account_scope",
    "allauth.account.middleware.AccountMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {"default": dj_database_url.config(conn_max_age=0, conn_health_checks=True)}
if DATABASES["default"].get("ENGINE") != "django.db.backends.postgresql":
    raise RuntimeError("A PostgreSQL DATABASE_URL is required")
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
SITE_ID = 1
ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_ADAPTER = "ledger.auth_adapter.EmailCodeAccountAdapter"
ACCOUNT_SIGNUP_FIELDS = ["email*"]
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_LOGIN_BY_CODE_ENABLED = True
ACCOUNT_LOGIN_BY_CODE_REQUIRED = False
ACCOUNT_LOGIN_BY_CODE_FORMAT = {"length": 4, "numeric": True, "dashed": False}
ACCOUNT_UNIQUE_EMAIL = True
HEADLESS_ONLY = True
HEADLESS_CLIENTS = ("app", "browser")
EMAIL_BACKEND = "django.core.mail.backends.dummy.EmailBackend"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "MeroSplit <mail@merosplit.com>")
EMAIL_REPLY_TO = os.environ.get("EMAIL_REPLY_TO", "mail@merosplit.com")
PUBLIC_WEB_URL = os.environ.get("PUBLIC_WEB_URL", "https://merosplit.com")
EMAIL_CLIENT_IP_SOURCE = os.environ.get("EMAIL_CLIENT_IP_SOURCE", "remote_addr")
EMAIL_RAILWAY_PUBLIC_HOSTS = {
    host.strip().lower().rstrip(".") for host in os.environ.get("EMAIL_RAILWAY_PUBLIC_HOSTS", "").split(",") if host.strip()
}
if EMAIL_CLIENT_IP_SOURCE not in {"remote_addr", "railway_public"}:
    raise RuntimeError("EMAIL_CLIENT_IP_SOURCE must be remote_addr or railway_public")
if EMAIL_CLIENT_IP_SOURCE == "railway_public" and not EMAIL_RAILWAY_PUBLIC_HOSTS:
    raise RuntimeError("Railway email rate limits require explicit EMAIL_RAILWAY_PUBLIC_HOSTS")
try:
    STORE_REVIEW_AUTH = json.loads(os.environ.get("STORE_REVIEW_AUTH_JSON", "[]"))
    if not isinstance(STORE_REVIEW_AUTH, list) or len(STORE_REVIEW_AUTH) > 2:
        raise ValueError()
    for entry in STORE_REVIEW_AUTH:
        if (
            not isinstance(entry, dict) or set(entry) != {"store", "user_id", "email", "pin_hash"}
            or entry["store"] not in {"apple", "google"} or type(entry["user_id"]) is not int or entry["user_id"] <= 0
            or not isinstance(entry["email"], str) or "@" not in entry["email"]
            or entry["email"] != entry["email"].strip().lower() or len(entry["email"]) > 254
            or not isinstance(entry["pin_hash"], str)
        ):
            raise ValueError()
        if entry["pin_hash"]:
            algorithm, iterations, salt, digest = entry["pin_hash"].split("$")
            if algorithm != "pbkdf2_sha256" or not 1_000_000 <= int(iterations) <= 4_000_000 or len(salt) < 12 or len(digest) != 44:
                raise ValueError()
    if any(len({entry[key] for entry in STORE_REVIEW_AUTH}) != len(STORE_REVIEW_AUTH) for key in ("store", "user_id", "email")):
        raise ValueError()
except (TypeError, ValueError, KeyError):
    raise RuntimeError("STORE_REVIEW_AUTH_JSON must contain unique exact synthetic identities and encoded credential hashes") from None
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_ENGINE = "config.sessions"
SESSION_COOKIE_AGE = 60 * 60 * 24 * 14
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
USE_TZ = True
TIME_ZONE = "Asia/Kolkata"
LANGUAGE_CODE = "en-in"
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False}},
}
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
            ]
        },
    }
]
if os.environ.get("TEST_DATABASE_NAME"):
    DATABASES["default"]["TEST"] = {"NAME": os.environ["TEST_DATABASE_NAME"]}

ALLOWED_HOSTS.append("healthcheck.railway.app")
if DEBUG:
    ALLOWED_HOSTS.append("10.0.2.2")
SECURE_SSL_REDIRECT = not DEBUG
SECURE_REDIRECT_EXEMPT = [r"^api/v1/(health|ready)$"]

PUSH_PROVIDER = os.environ.get("PUSH_PROVIDER", "")
EXPO_ACCESS_TOKEN = os.environ.get("EXPO_ACCESS_TOKEN", "")

# One canonical OAuth issuer/resource, independent of request Host headers.
MCP_SERVER_URL = os.environ.get("MCP_SERVER_URL", "https://merosplit.com/mcp")
MCP_ALLOWED_HOSTS = list(dict.fromkeys([_urlsplit(MCP_SERVER_URL).netloc, *ALLOWED_HOSTS]))
MCP_ALLOWED_ORIGINS = list(dict.fromkeys([f"https://{_urlsplit(MCP_SERVER_URL).netloc}", PUBLIC_WEB_URL.rstrip("/")]))
