# Push notification worker

This release uses Expo Push only. Native tokens belong to EAS project `7b058184-31a7-41e9-96e1-5a752b7bf14f`; EAS holds the APNs/FCM configuration. The Django service does not accept raw APNs/FCM tokens or implement separate adapters.

## Deploy

1. Apply migrations through `0031_concise_notifications` with the API deployment.
2. Set `PUSH_PROVIDER=expo` on the API and supervised worker. Both use the same existing PostgreSQL `DATABASE_URL`, Django settings and release code.
3. Leave `EXPO_ACCESS_TOKEN` unset unless enhanced push security is enabled for the Expo project. If enabled, supply it privately to the worker (it is never public/mobile configuration).
4. Worker start command: `python manage.py send_bill_notifications --loop --interval 5`. No public domain, broker or Redis is needed. It can restart safely after an interrupted delivery.

One bounded run: `python manage.py send_bill_notifications --limit 100`. Limits are 1–1000, polling interval 1–3600 seconds. A run processes at most the limit of sends and the limit of receipts, sequentially, with a 10-second HTTP timeout each. Network calls target only `https://exp.host/--/api/v2/push/send` and `/getReceipts`.

Operator retry after fixing a permanent failure: add `--retry-failed`. Failed records without a known accepted ticket restart dispatch using their original event IDs. Records with an uncertain accepted ticket only retry receipt lookup; they are never blindly resent. Logs contain aggregate processed counts only; inspect sanitized `state`, `last_error`, attempts and timestamps in the database for diagnosis. Do not log/export device tokens or session keys.

## Registry and lifecycle

Authenticated PUT `/api/v1/me/push-devices/{installation_uuid}` accepts `{provider:"expo",platform:"ios"|"android",token:"ExpoPushToken[...]"}` (legacy `ExponentPushToken[...]` also supported), returning `{id,enabled:true}`. An installation or token rebinds atomically to the caller and their actual allauth/Django session. Identical registration is idempotent; changed ownership/session/token increments its binding revision. DELETE the same path is idempotent and owner-scoped, returning `{removed:true}`. Unknown fields/raw native tokens are rejected. No response or account export contains token/session secrets.

Logout deletes the Django Session and cascades its device registrations. Expired sessions and inactive accounts are rejected before dispatch. Account deletion explicitly revokes devices. Mobile must serialize register/revoke/account-switch actions so an old in-flight registration cannot win after a new account registers, and must handle permission revocation locally.

Bill creation locks the group then selected devices. Registration locks the user with `NO KEY UPDATE`, then session and devices; logout locks the session and devices before Django collects cascade children. These locks keep concurrent logout/token changes from rolling back a valid bill or leaving logout incomplete. Keep the configured DB session subclass named `SessionStore`: Django derives the signing salt from that class name, so renaming it would invalidate existing sessions.

## Delivery semantics

Only normal newly created bills enqueue rows in the same transaction as the ledger write. Edits, restores, CSV history import and repeated sync commands do not create events. Recipients are active linked group members other than the creator, with a current registered device; placeholders and unrelated accounts are excluded. Each bill/device/binding has a database uniqueness constraint.

The worker claims committed rows with a fenced lease, then rechecks account, session, device revision, membership, bill deletion and group archive before external sending. It sends a bounded actor/bill title and the recipient's current share, Android channel `shared-bills`, one-hour TTL and data `{type:"new_bill",event_id,recipient_user_id,group_id,expense_id}`. IDs are strings; event ID is stable across retries/devices. Routing data contains no names, amounts, descriptions, notes, photos or receipts. Display title/body include actor, bill, group and amount as appropriate, subject to OS preview settings. The client must validate recipient identity and fetch authorized content on tap.

- `pending` / `sending`: not yet accepted by Expo. Temporary network, HTTP429 and HTTP5xx errors back off; eight attempts maximum before `failed`.
- `queued` / `checking`: Expo accepted a ticket; this is not delivery. First receipt lookup is due after 15 minutes. Missing/transient receipt checks retry every 15 minutes for up to 24 hours without resending.
- `sent`: receipt confirms acceptance by APNs/FCM, not arrival/display on a device.
- `skipped`: membership/device/session or ledger state became ineligible.
- `failed`: permanent configuration/payload error, exhausted dispatch attempts or unavailable receipt. Error codes are allowlisted; upstream messages are discarded.

DeviceNotRegistered retires the matching device binding. An old receipt cannot retire a device rebound to another account. Known MessageRateExceeded receipts requeue dispatch with backoff and a new eligibility check. Expo accepted sends cannot be revoked later; generic content plus client authorization prevents opening another account's data.

The database prevents duplicate event creation, but a lost HTTP response/crash can cause another provider attempt. Stable event IDs, Expo collapseId and Android tag coalesce retries; exactly-once remote delivery is not promised.

Protocol reference: https://docs.expo.dev/push-notifications/sending-notifications/ (checked during implementation).


## Bill-chat previews

Chat-enabled devices receive `Sender · Bill` with a single-line message preview. Multiple currently unread, eligible messages in one bill use `Bill · N new messages` and the latest two sender-prefixed previews. Hidden, cancelled, seen and blocked messages are excluded; enabling updates again does not include messages from before the new preference boundary. Names use the same participant display rules as chat, with `Someone` and `Bill conversation` as empty-name fallbacks. Preview text strips control/bidi formatting and has bounded length. No preview is stored in routing data or worker logs.

The conversation identifier includes recipient and bill, so different accounts and bills cannot replace one another. Expo `collapseId` coalesces pending updates and replaces the iOS notification; Android `tag` replaces the displayed conversation summary, and iOS `threadId` identifies its group. Existing event/message IDs and authorized tap routing remain intact. This is a native text notification, without a custom notification extension, avatar or inline reply. New-bill and membership notifications use concise contextual copy.

Chat previews include user content in the push sent through Expo/APNs/FCM and may appear on the lock screen according to the user's OS preview settings. Dispatch still checks active session/device binding, notification preference, current financial membership, blocking and hidden/deleted/archived state. Once accepted by a provider, content cannot be remotely retracted and a later removal/read/opt-out may race an already submitted request. Receipts still mean provider acceptance, never read state or proven device delivery.


## Concise financial notifications

Apply migration 0031 on the API and worker before publishing the mobile update. Device registration accepts optional `ledger_updates` and a supported `currency` code, defaulting to false and INR. Currency/capability refresh does not rotate device ownership or its revision. New mobile clients register the current saved display preference on startup, foreground and preference change. Symbols change without converting amounts. Older clients still receive creation/membership pushes; only financial-capable devices receive the four new types.

- New bill: `Om added Dinner` / `Your share is ₹400.` Payer-only recipients instead see `You're included as a payer.` Current unread, session and 30-second grace checks remain.
- Added to group: `Om added you to Goa trip` / `Tap to view the group.` Direct ledgers say `Om added you` without exposing their internal ledger name.
- Bill updated: `Om updated Dinner` / `Your share changed from ₹400 to ₹500.` Only changed paid/share recipients are notified, after 30 seconds. Metadata-only edits are silent.
- Bill deleted: `Om deleted Dinner` / `₹400 removed from your share.` Financial reversal retains the ledger record; it removes the bill from balances.
- Payment recorded: `Om recorded a ₹500 payment` / `Marked as paid to you.` Only the other payment participants are notified. A separate recorder names the actual counterparty; neither wording nor delivery claims bank verification. Reversed payments and duplicate confirmations do not send another recorded alert.
- Payment reminder: `A reminder from Om` / `You owe Om ₹500.` The Remind action appears beside incoming repayments for linked members while online. The authenticated creditor must supply a matching current version and exact proposed repayment. At most one reminder per sender/recipient per 24 hours, and ten per sender per 24 hours, across groups. No automatic reminders. No push-enabled compatible route returns an actionable error.

Non-direct notifications append the group name. Display fields strip controls/bidi formatting and are bounded. Activity pushes are committed with their source ledger change or reminder command, uniquely keyed per source/device/binding. Reminder commands do not change the ledger version or invalidate prepared payments. The existing worker claims fenced leases, rechecks current membership, actor, preferences, session, revision and financial state, and drops superseded bill versions, reversed payments, settled reminders and events older than one hour. Uncertain sends are held without another POST; explicit rate rejections retry with bounded backoff. Accepted tickets only check receipts, with a bounded retry window. Old-client routing is capability-gated; taps authorize a fresh bill/group fetch, with deletion/payment/reminder falling back to the group. These events do not enable email, create bank transfers, or acknowledge a bill as read.

Provider acceptance is not proof of device delivery. Submitted previews cannot be retracted after an OS/privacy or membership change. Existing creation-push retry semantics above are unchanged.
