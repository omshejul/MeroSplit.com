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

Manual update checks read `/api/v1/app-releases` before checking OTA. When the installed native build is older, they open the platform store listing. Update `apps/api/ledger/app_releases.py` only after verifying the exact release is available in the store, including the intended Play testing audience. An uploaded or pending-review build is not available. The store controls account, territory, device and staged-rollout eligibility. Release checks use installed binary metadata, never the OTA manifest version. Store lookup failures can still download a compatible OTA, but cannot report No new updates when both checks are needed.

## Sentry

The `om-shejul` organization has `merosplit-api` for Django and the notification worker, and `merosplit-app` for Expo native and web. Set `SENTRY_DSN`, `SENTRY_ENVIRONMENT=production` and `SENTRY_RELEASE` to the source revision on both backend services. Without a DSN, reporting is disabled.

Set `EXPO_PUBLIC_SENTRY_DSN` for production client exports. EAS profiles contain the public client DSN. Local development reporting is disabled. The native SDK and Expo plugin require new binaries; this integration changes the fingerprint and must not be sent to older store builds by OTA. Native integration was explicitly approved on 6 November 2026. Store privacy declarations must reflect crash diagnostics before submitting those binaries.

Metro adds debug IDs. `export:web` emits source maps, uploads them with the authenticated `sentry` CLI when a client DSN is set, then deletes the maps before deploying public assets. A failed upload fails the export. Native release builds upload maps/symbols through the Expo plugin using a private `SENTRY_AUTH_TOKEN` in the build environment. After future compatible OTA publication, run `pnpm exec sentry-expo-upload-sourcemaps dist` with that token. Never place the token in `EXPO_PUBLIC_*`.

Trace sampling is 100% on the app and backend. Up to 50 sanitized HTTP/sync breadcrumbs and the authenticated account ID help diagnose failures. App identity is cleared when signing out, switching accounts or holding authentication; backend identity comes from the authenticated Django/Ninja request scope. HTTP span names use route templates, SQL text/parameters and arbitrary span attributes are removed, and both error and transaction payloads pass privacy hooks. Handled outbox failures report through Sentry without replaying a failed financial request. Emails, names, request bodies, tokens, bill content, free-text breadcrumbs, error messages and frame locals remain excluded. Session replay remains disabled. Native crash reports also contain SDK-provided device/runtime diagnostics. Source maps remain private.
