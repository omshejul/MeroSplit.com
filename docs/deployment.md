# Deployment

Deploy only reviewed source already on GitHub main. Fetch origin and require a clean release checkout matching origin/main before deployment. A successful build or upload is not proof of runtime behavior or installation.

## Backend

The API and notification worker share PostgreSQL. Configure your own private environment from `apps/api/.env.example`, run migrations and verify readiness. Keep database, storage, OAuth and mail credentials on the backend. Native clients receive only public identifiers and their own session credentials.

## Google and Apple sign-in

Use your own provider registrations and match bundle/package identifiers, signing certificates, URL schemes, authorized origins and callbacks to the client and backend configuration. Preserve allauth session ownership. Verified authoritative provider emails automatically link to one active account with a matching verified email. Other identities require explicit account linking. Web client secrets and Apple signing keys belong only on the server.

## Email delivery

Select a supported provider through server configuration. Preserve frozen delivery identifiers and uncertain outcomes across deployments; do not resend solely because an acknowledgement was lost. The incoming mail Worker uses a private `FORWARD_TO` secret. See [incoming mail setup](../infra/cloudflare-email/README.md) and [push configuration](../apps/api/PUSH.md).

## Native builds and OTA updates

Use your own EAS project, channel and signing credentials when building an independent app. The configured fingerprint runtime must match the installed native binary. Native dependency or capability changes need a new binary. Automatic checks must retain cached or embedded startup when offline.

Review `apps/mobile/app.json` and `apps/mobile/eas.json` before building or publishing an update. Verify the actual running version/update after delivery; an upload receipt alone does not prove an OTA was installed. Keep signing keys and store submission credentials outside source control.

Native startup checks are reused. Foregrounding, reconnecting and app interaction can check again after a five-minute cooldown; the Me button bypasses it. Downloads run without confirmation. A completed download offers Restart now or Later on a safe main screen, once per update per running session. Later leaves Restart to update in Me. Restart flushes draft/chat writes and rechecks account, navigation, foreground, sync and modal guards.
