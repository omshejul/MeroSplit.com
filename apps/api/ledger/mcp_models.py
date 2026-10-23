"""Durable, account-owned MCP OAuth credentials; only token digests are stored."""

import uuid

from django.conf import settings
from django.db import models


class McpOAuthClient(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    redirect_uris = models.JSONField()
    application_type = models.CharField(max_length=6, default="native")
    created_at = models.DateTimeField(auto_now_add=True)


class McpOAuthPendingAuthorization(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client = models.ForeignKey(McpOAuthClient, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.CASCADE)
    redirect_uri = models.TextField()
    state = models.TextField(blank=True)
    code_challenge = models.CharField(max_length=43)
    resource = models.URLField(max_length=2048)
    scope = models.CharField(max_length=40)
    expires_at = models.DateTimeField(db_index=True)
    code_digest = models.CharField(max_length=64, unique=True, null=True)
    code_expires_at = models.DateTimeField(null=True)
    approved_at = models.DateTimeField(null=True)
    consumed_at = models.DateTimeField(null=True)
    denied_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class McpOAuthGrant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client = models.ForeignKey(McpOAuthClient, on_delete=models.CASCADE)
    scope = models.CharField(max_length=40)
    resource = models.URLField(max_length=2048)
    access_token_digest = models.CharField(max_length=64, unique=True)
    access_expires_at = models.DateTimeField()
    refresh_token_digest = models.CharField(max_length=64, unique=True)
    refresh_expires_at = models.DateTimeField(db_index=True)
    revoked_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True)

    class Meta:
        indexes = [models.Index(fields=["user", "-created_at", "-id"], name="mcp_grant_account")]


class McpOAuthRefreshDigest(models.Model):
    digest = models.CharField(primary_key=True, max_length=64)
    grant = models.ForeignKey(McpOAuthGrant, on_delete=models.CASCADE)
    expires_at = models.DateTimeField(db_index=True)
