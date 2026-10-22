# Functional contract

Base `/api/v1`. JSON uses decimal strings for all paise and UUID strings for entity IDs. Currency INR only. Positive balance means owed to participant. Actor identity is Django/allauth session ownership. Native auth uses allauth app session tokens in `X-Session-Token`; no custom JWT/user store.

All mutating ledger requests contain `command_id` UUID. Updates also contain `version` integer. Replaying identical actor/command/payload returns the original result; changed payload returns409. Error JSON has `error` and `detail`.

- GET `/health`, `/ready` are unauthenticated liveness/database readiness.
- POST `/groups` body `{command_id, id, name, participants:[{id,name}]}`. Creator is participant with their user ID linked explicitly by server. Client supplies their participant `id` as `self_participant_id`. Returns `{id:group_id,version}`; fetch snapshot separately.
- Optional `is_direct:true` creates a friend ledger with exactly two participants; adding a third is rejected. The default is false. Group lists, snapshots and JSON exports preserve the flag. Omitted and explicit false retain legacy command-replay compatibility.
- GET `/groups` returns `{groups:[{id,name,version}]}`.
- GET `/groups/{id}` returns `{id,name,version,participants:[{id,name,user_id}],expenses:[...],settlements:[...],balances:{participant_id:paise},transfers:[{sender,recipient,amount}],activity:[...]}`. Sync currently fetches full snapshots carrying the accepted group version. Maximum-size snapshot performance has not been established; no incremental cursor endpoint exists yet.
- POST `/groups/{id}/expenses` body `{command_id,id,description,total,paid:{id:paise},split:{mode:'equal'|'exact'|'percent'|'shares',values:{id:decimal_string}},date:'YYYY-MM-DD',category,notes}`. Equal values are selected participant IDs with value'1'. Percent values total100.00; shares max4decimal places. Returns `{id:group_id,version}`; fetch snapshot separately.
- PUT `/groups/{id}/expenses/{id}` same body plus `version` of expense. DELETE body `{command_id,version}`; POST `/restore` body `{command_id,version}`. Expense output includes `id,version,description,total,paid,shares,split,date,category,notes,deleted`.
- POST `/groups/{id}/settlements` body `{command_id,id,sender,recipient,amount,attempt_id?}` creates explicit manual bookkeeping. POST `/settlements/{id}/reverse` body `{command_id}`.
- POST `/groups/{id}/opening-balances` body `{command_id,id,balances:{id:paise},source,cutoff}` creates a pending balanced opening proposal. It posts only after every nonzero linked participant acknowledges.
- GET `/groups/{id}/export?format=json|csv` returns accepted records with allocations and provenance.

Payment attempts, invites/claiming, account export/deletion and group archive have the explicit endpoints below. The mobile client uses plain fetch and persists queued commands; no generated SDK or generic command bus. The Python API is authoritative; TypeScript previews and Python allocations run the same fixtures.

Per-bill/payment amount bound: 1_000_000_000paise. Aggregate balances may exceed a single bill. Auth user IDs are Django integers serialized to string for client ownership keys. Allauth native routes `/_allauth/app/v1/auth/login`, `/signup`, `/session` return `meta.session_token` and `data.user.id`; use stringified user ID.

## Phase4 operations

- GET `/me` gives current Django user plus their payment profile; PUT `/me/payment-profile` body `{vpa}` changes only the caller's own VPA/version.
- POST `/groups/{id}/invites` body `{command_id,participant_id}` returns write ack plus `token` and `url`; only organizer; share is manual. Token scopes a read view to that participant.
- GET `/invites/{token}` requires no login and returns that participant's balance, involved records and counterparties only. POST `/invites/{token}/claim` body `{command_id}` needs authenticated native session-token or same-origin browser-session access; browser mutation requires CSRF. Owner must explicitly approve. The generated `/invite/{token}` URL serves the small Django participant page.
- POST `/groups/{id}/invites/{invite_id}/approve` or `/revoke` body `{command_id}`. Approval links exact pending claimant and participant; never matches name/email. Owner sees claimant account identity before approving.
- POST `/groups/{id}/opening-balances` creates a pending vector. POST `/groups/{id}/opening-balances/{opening_id}/acknowledge` body `{command_id}` acknowledges caller's claimed participant. It affects balances only after every nonzero participant acknowledges. Snapshot includes `opening_balance` with `accepted` and `acknowledgments`.
- POST `/groups/{id}/payment-attempts` body `{command_id,id,sender,recipient,amount,group_version,payee_version}`. Only signed-in sender; recipient must be linked with a current payment profile. Amount limited to the current simplified transfer. An existing active same-pair attempt is reused rather than duplicated. Write response remains `{id:group_id,version}`; fetch the accepted snapshot to select the actual active attempt ID. Snapshot `payment_attempts` preserves quoted amount and exposes linked `settlement_id`/`recorded_amount` when present.
- POST `/groups/{id}/payment-attempts/{attempt_id}/report`, `/confirm`, `/cancel` body `{command_id}`. Report is payer assertion only. Confirm is receiver-only and posts exactly one settlement; later acknowledgment of a manual record changes provenance only. Cancel permitted only before a payer report and never erases a report. No callback endpoint marks bank payment successful.
- GET `/groups/{id}/payment-attempts/{attempt_id}/launch` checks sender, group/profile revisions and quote expiry; returns copyable VPA/amount/details with `bank_verified:false` and `direct_launch_supported:false`. Direct UPI launch is disabled pending supported-device evidence. An expired quote never discards a reported payment.
- POST `/groups/{id}/archive` body `{command_id,archived}` owner-only.
- GET `/account/export` includes caller's accepted groups; DELETE `/account` deactivates login, removes credentials/contact/payment profile, anonymizes retained shared ledger attribution and preserves other members' financial history.

Snapshot `invites` is visible to organizer only and includes claimant ID/email for intentional approval. Authentication emails are not verified in this controlled functional build. Do not present a user as email verified. A forwarded token alone cannot post receipts or claim a participant without organizer approval. No automatic invitations/messages are sent.

POST `/groups/{id}/participants` body `{command_id,id,name}` adds an unclaimed participant, organizer-only, cap100. Existing expense allocations remain unchanged and new participant starts withzero historical share. Snapshot `totals` provides accepted gross purchase spending plus each participant paid/share totals, allpaise strings. Repayments and opening balances do not count as purchase spending.

## Splitwise CSV import

- POST `/imports/splitwise/preview` with `{csv}` returns `{source_hash,currency,members,expense_count,payment_count,balances,unresolved,warnings,duplicate_group}`. Balances and unresolved `amount` use string paise. Unresolved rows include their physical CSV start-line number; member indexes follow the CSV header. Preview writes nothing.
- POST `/imports/splitwise` with `{command_id,id,csv,name,self_index,payers}` creates one new shared group atomically. `payers` maps unresolved row-number strings to zero-based member indexes. Only `self_index` is linked to the caller. Result `{id,version,already_imported}` identifies either the new group or the caller's existing import. Same-command retries preserve payload identity; semantic source duplicates cannot post twice.
- INR exports are supported up to 1 MiB, 10,000 transactions and 100 members. Historical Payment rows become settlement records. The Total balance footer is verified and excluded. CSV nets are reconstructed into one payer and exact shares; original contribution details, comments and receipts are unavailable. Balance-neutral bills require a payer choice; ambiguous multiple-positive-net bills and unsupported currencies are rejected.

## Private photos and bill attachments

All file routes require normal account authentication. File metadata is `{id,name,content_type,size}`, where size is the optimized artifact's byte count. No R2 credentials, object keys or signed URLs appear in snapshots or persisted client metadata.

- GET `/me` includes `avatar:metadata|null`. POST `/me/avatar` accepts multipart `id` (client UUID) and `file`, returning `{avatar,cleanup_pending}`. DELETE `/me/avatar` returns `{removed:true,cleanup_pending}`. Photo access is limited to its owner.
- GET `/groups/{group_id}/expenses/{expense_id}/attachments` returns `{attachments,can_modify}`. POST the same path accepts multipart `id` and `file`, returning `{attachment,version}`. DELETE `.../attachments/{file_id}` returns `{removed:true,cleanup_pending,version}`. Current linked members may read. Archived groups are read-only; deleted bills cannot be read or changed. Media changes increment Group.version, preserving Expense.version and all financial amounts.
- GET `/media/{file_id}/url` rechecks ownership/group access and returns `{url,expires_at}` for a private signed GET valid for five minutes. Removal denies new URLs immediately; an already issued URL may work until expiry. URLs are transient and must not be saved in SQLite or exports.
- Uploads use a client UUID and original-byte fingerprint. Retrying the same file returns its accepted metadata without duplicate history; a changed file with that ID returns 409. Removed IDs cannot resurrect. Removal hides metadata before deleting the object; `cleanup_pending:true` means logical removal succeeded and repeated DELETE can retry cleanup. A concurrent file change returns a retryable 409.

Only processed artifacts reach R2 under `avatars/` or `bills/`; raw inputs are temporary and closed on every outcome. JPEG, PNG and WebP inputs are oriented, stripped of metadata and converted to full-color JPEG at quality 82. Avatars accept up to 5 MiB and become at most 512 pixels on their long edge; bill images accept up to 20 MiB and become at most 2400 pixels. Convert iPhone HEIC to JPEG through the native picker. Bills support at most 10 attachments.

Bill PDFs accept up to 20 MiB and 100 pages. pypdf rewrites structure, compresses content streams and deduplicates objects while preserving searchable text. Encrypted, signed, active/interactive, embedded-file, malformed and excessive-resource PDFs are rejected explicitly. Already compressed PDFs may not shrink. JSON group/account exports include attachment metadata and the account's photo metadata; CSV exports retain financial rows only.

Configure backend-only `R2_BUCKET`, `R2_ENDPOINT_URL`, `R2_REGION`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Run migrations 0004 and 0005 before serving this release. `python manage.py purge_media` manually retries up to 100 retired object deletions and abandons interrupted pending uploads older than one day. It skips active/in-progress files; run it again when its summary reports pending cleanup. There is no scheduler or worker.
