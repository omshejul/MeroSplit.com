# Incoming mail

Cloudflare Email Routing sends only `mail@merosplit.com` to the `merosplit-mail` Worker. The Worker forwards to the existing verified destination `mail@merosplit.com`. Catch-all remains disabled. No HTTP handler, auto-reply, message storage or content logging.

Run `node --test infra/cloudflare-email/worker.test.mjs` from the repository root. Deploy this directory only from a freshly fetched, clean checkout whose HEAD exactly matches GitHub `origin/main`. The existing authenticated Cloudflare API can upload `worker.mjs` as an ES module with observability disabled; no Worker bindings or secrets are needed. `wrangler.jsonc` also records the deployment configuration.

The zone needs Cloudflare-managed routing MX, SPF and DKIM records, an exact literal `to` rule for `mail@merosplit.com` with Worker action `merosplit-mail`, and the verified destination address. Provider configuration readback verifies setup; completed inbox delivery is a separate claim.

This incoming Worker does not replace the application's transactional email provider.
