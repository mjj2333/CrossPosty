# CrossPosty Mobile — Bluesky auto-like replies (design)

**Date:** 2026-10-24
**Scope:** automatically like qualifying direct replies to the user's Bluesky posts, with per-user filters and a visible ledger. Bluesky only. X is explicitly out: X's automation rules ban automated likes with no exceptions, and the owner's X accounts have already been burned once on a sibling platform.
**Repo:** `C:\Users\drice\CrossPosty-mobile` (Edge Functions + PWA). Plan to follow as `docs/superpowers/plans/2026-10-24-mobile-7-auto-like.md`.

## 1. Decisions

- **Which posts:** every post on the user's Bluesky account, whether published through CrossPosty or manually. Discovery is through the account's notifications, so one code path covers both.
- **Which responses:** direct replies only. A reply whose parent is not a post authored by the user is ignored, as are quote posts and mentions.
- **Timing:** each qualifying reply is liked after a random delay of 2–30 minutes.
- **Backfill:** none. Switching the feature on records the moment; only notifications indexed after that are considered.
- **Daily cap:** default 100 likes per rolling 24 hours, adjustable.
- **Visibility:** likes today, likes in the last 7 days, and the last 50 decisions with handle, outcome and reason.
- **Approach:** poll `app.bsky.notification.listNotifications` from a per-minute pg_cron job (chosen over per-post thread walking and over a firehose subscriber, which would need a long-running process the Edge Function model cannot host).

## 2. Architecture

A new Edge Function **`auto-like`** at `supabase/functions/auto-like/index.ts`, scheduled by a new migration (`cron.schedule('auto-like', '* * * * *', …)`) with the same `x-cron-secret` header and Vault lookups as `run-due-posts`. Pure logic lives in `supabase/functions/_shared/auto-like.ts` with injected dependencies, mirroring `job.ts` / `processPost`, so it is unit-testable with stub adapters and a stub database.

Each tick:

1. Load every user where `settings.auto_like_enabled` is true **and** their `accounts` row for `bluesky` has `status = 'ok'`.
2. For each user, independently (one user's failure never blocks another's run):
   - **Refresh** the session through the existing adapter's `refreshIfNeeded`, persisting rotated tokens exactly as the posting job does.
   - **Scan pass** (§4).
   - **Like pass** (§5).
   - Write `auto_like_state.last_run_at`, and `last_error` (null on success, message on failure).
3. Respect the function wall clock the same way `run-due-posts` does: stop starting new users once ~45 s have elapsed and report them as skipped in the response summary. Remaining users are picked up next minute; nothing is lost because the watermark only advances for users that completed their scan.

Response body: `{ users: n, summary: [{ user_id, scanned, queued, skipped, liked, failed, error? }] }`. A `?dry_run=1` query parameter (still cron-secret-authenticated) runs the scan pass and returns each decision in the response (`dry: [{ handle, uri, outcome, reason }]`) instead of writing events; it performs no likes, writes nothing to the ledger or state, and does not advance the watermark. An optional `&lookback=<minutes>` moves the watermark back for that dry scan only, so the rules can be checked against replies that already exist on the test account.

## 3. Data model

### 3.1 Settings (columns added to the existing `settings` table)

| Column | Type | Default | UI label |
|---|---|---|---|
| `auto_like_enabled` | boolean | `false` | Auto-like replies |
| `auto_like_min_followers` | integer, ≥ 0 | `5` | Minimum followers |
| `auto_like_min_account_age_days` | integer, ≥ 0 | `7` | Minimum account age (days) |
| `auto_like_skip_links` | boolean | `true` | Skip replies containing links |
| `auto_like_skip_no_avatar` | boolean | `false` | Skip accounts with no profile photo |
| `auto_like_skip_labeled` | boolean | `true` | Skip accounts with moderation labels |
| `auto_like_daily_cap` | integer, 1–1000 | `100` | Daily limit |

Check constraints enforce the ranges. Existing `settings` grants and the "own settings" RLS policy already cover read and write for the owner; the PWA keeps using `saveSettings` upserts.

### 3.2 `auto_like_state` (runtime state, one row per user)

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid pk → `auth.users` cascade | |
| `watermark` | timestamptz not null | Only notifications with `indexedAt > watermark` are considered. Set to `now()` when the feature is switched on. |
| `last_run_at` | timestamptz | |
| `last_error` | text | Shown on the card; null when the last run succeeded. |
| `updated_at` | timestamptz | `set_updated_at` trigger like the other tables. |

Written only by the service role. Authenticated users may `select` their own row (RLS), so the card can show the last error.

Switching on is done by a security-definer RPC `auto_like_enable()` that upserts the state row with `watermark = now()`, clears `last_error`, and sets `settings.auto_like_enabled = true` in one transaction, so a stale watermark from a previous enablement can never cause a backfill. Switching off is a plain settings update; the state row is kept.

### 3.3 `auto_like_events` (ledger, one row per reply considered)

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity pk | |
| `user_id` | uuid not null → `auth.users` cascade | |
| `reply_uri` | text not null | `at://` URI of the reply |
| `reply_cid` | text not null | needed for the like record's `subject` |
| `author_did` | text not null | |
| `author_handle` | text not null | snapshot at decision time, for display |
| `decision` | text not null, check in (`queued`,`liked`,`skipped`,`failed`) | |
| `reason` | text | skip/failure reason code (§4.3); null for `queued`/`liked` |
| `due_at` | timestamptz | set for `queued`; the random delay |
| `attempts` | integer not null default 0 | like attempts |
| `created_at` | timestamptz not null default now() | |
| `liked_at` | timestamptz | |

Indexes: unique `(user_id, reply_uri)` (idempotent rescans, never a double like); `(user_id, created_at desc)` for the card; `(decision, due_at)` for the like pass; partial `(user_id, liked_at)` where `decision = 'liked'` for the cap and the counts.

Grants: `select` to `authenticated` with an "own events" RLS policy; everything else service role only.

Retention: the existing daily `cleanup-media` run deletes `auto_like_events` older than 30 days (one extra statement; the function's response gains an `events_purged` count).

## 4. Scan pass

### 4.1 Fetch

`GET /xrpc/app.bsky.notification.listNotifications?reasons=reply&limit=50` on the user's PDS with the session token. Notifications arrive newest first. Walk pages (cursor) until a notification with `indexedAt <= watermark` is reached or 5 pages have been read; take everything newer. After a successful scan, set `watermark` to the newest `indexedAt` seen (unchanged if nothing new). The 5-page ceiling bounds a single tick at 250 notifications; anything older than that after a viral spike is deliberately dropped, which is acceptable for a courtesy feature and keeps the tick inside the wall clock.

### 4.2 Candidate test (fixed, not settings)

A notification becomes a candidate only if all hold:

- `reason === 'reply'`.
- `record.reply.parent.uri` starts with `at://<user DID>/` — a **direct** reply to a post she authored. Replies deeper in the thread (parent is someone else's post, even under her root) are ignored. No fallback to `reasonSubject`, which may name the root rather than the parent.
- `author.did !== <user DID>` (her own replies are ignored).
- Not blocked or muted in either direction: `author.viewer.blocking`, `author.viewer.blockedBy`, `author.viewer.blockingByList` and `author.viewer.muted` (which is true for list mutes as well; `mutedByList` is also checked defensively) must all be absent or falsy.

Non-candidates are not recorded in the ledger except the block/mute case, which is recorded as `skipped` with reason `blocked` or `muted` so the user can see the exclusion working.

### 4.3 Adjustable rules, applied in this order

The ledger reason is the first rule that fails. Reason codes are stable strings the UI maps to text.

| Order | Setting | Rule | Reason code |
|---|---|---|---|
| 1 | skip labeled | any label on `author.labels` whose `src` is **not** `author.did` (self-labels are ignored), which is not negated (`neg` falsy), and whose value is not an adult-content classification (`porn`, `sexual`, `nudity`, `sexual-figurative`, `graphic-media`). Bluesky's own moderation applies those to accounts that never self-labelled; they describe content, not conduct, and must never skip this user's audience | `labeled` |
| 2 | min account age | `author.createdAt` missing, or newer than N days before now | `account_age` |
| 3 | skip no avatar | `author.avatar` missing or empty | `no_avatar` |
| 4 | skip links | reply `record.facets` contains any `app.bsky.richtext.facet#link` feature, **or** `record.embed` is `app.bsky.embed.external` (or a `recordWithMedia` wrapping one), **or** the text, after stripping `@handle` mentions, matches a conservative URL pattern: `https?://` (any case), a lowercase bare host on an unambiguous TLD (`.com`, `.net`, `.org`, `.io`, `.app`, …) with or without a path, or a lowercase bare host on a TLD that is also a common word (`.it`, `.me`, `.us`, `.de`, `.es`, `.co`, …) only when followed by `/`. Mentions, sentence-case words after a missing space ("love it.It is") and handles are deliberately not links | `links` |
| 5 | min followers | `followersCount < N`, from a batched `app.bsky.actor.getProfiles` call (≤ 25 DIDs per call) made only for candidates that survived rules 1–4. A DID missing from the response (deactivated account) counts as 0 followers. If the lookup call itself fails, the whole scan is abandoned without advancing the watermark and retried next tick (§7) | `followers` |
| 6 | daily cap | likes with `liked_at` in the last 24 h plus currently `queued` events ≥ cap | `cap` |

A setting that is off makes its rule pass. Rules 1–4 use fields already present on the notification's `author` (`ProfileView` carries `viewer`, `labels`, `avatar`, `createdAt`), so they cost no extra calls.

### 4.4 Outcome

- Pass → insert `queued` with `due_at = now() + random(2 min … 30 min)`.
- Fail → insert `skipped` with the reason.
- Inserts use `on conflict (user_id, reply_uri) do nothing` so a watermark overlap or a re-run is harmless.
- Dry run → nothing is inserted; the decision (`queue`, or `skip` plus reason) is returned in the response.

## 5. Like pass

Select up to 20 `queued` events for the user with `due_at <= now()`, oldest first. For each:

1. Re-check the cap (likes in the last 24 h ≥ cap → mark `skipped`/`cap`; the queued reservation from §4.3 rule 6 makes this rare).
2. `POST /xrpc/com.atproto.repo.createRecord` with collection `app.bsky.feed.like`, record `{ $type, subject: { uri: reply_uri, cid: reply_cid }, createdAt }`.
3. On 2xx → `decision = 'liked'`, `liked_at = now()`.
4. On a permanent error (4xx other than 401/429, including a deleted reply) → `decision = 'failed'`, `reason = 'http_<status>'`.
5. On 429 or 5xx or a network error → `attempts += 1`, leave `queued`; after 5 attempts → `failed`/`gave_up`.
6. On 401 → the session is dead: `refreshIfNeeded` already ran, so treat as `reauth` (§7) and stop this user's pass.

Likes are spaced by the adapter's existing 1 s `pacingMs`. Bluesky's PDS write budget (5,000 points/hour, 3 per create) is three orders of magnitude above the daily cap.

## 6. Adapter additions (`adapters/bluesky.ts`)

Three methods on the Bluesky adapter, all using the existing `authHeaders`, `FETCH_TIMEOUT_MS` and `httpError` classification:

- `listNotifications(tokens, { reasons, cursor, limit })` → `{ notifications, cursor }` typed to the fields §4 reads.
- `getProfiles(tokens, dids)` → map DID → `{ followersCount }` (chunking to 25 is the caller's job, tested).
- `like(tokens, { uri, cid })` → `{ uri }` of the like record.

The `Adapter` interface is **not** widened (X has no equivalent and must never grow one); these are Bluesky-specific exports on the object returned by `createBlueskyAdapter`, typed as `BlueskyAdapter extends Adapter<…>`.

## 7. Errors

- **Needs reconnect:** a refresh that falls back to `createSession` and fails, or a 401 during the pass, calls `markAccountNeedsReconnect(user, 'bluesky')` (existing), which stops both posting and auto-like for that user until she re-enters her app password. `last_error = 'Bluesky session expired; reconnect in Accounts'`.
- **Transient (429, 5xx, timeout) during scan:** abandon this user's tick without advancing the watermark; `last_error` set; retried next minute.
- **Transient during like:** per-event retry as in §5.
- **Unexpected exception:** caught per user, logged, `last_error` set, next user proceeds; the function still returns 200 with the summary (cron must not see a flapping endpoint).
- The card shows `last_error` as a warn notice; it clears on the next successful run.

## 8. UI (Accounts tab)

A new `Card title="Auto-like replies"` placed directly under the Bluesky card. When no Bluesky account is connected the card body is a single muted line: "Connect Bluesky to use this."

Contents, top to bottom:

1. **Switch** "Auto-like replies" — on calls `auto_like_enable()`; off calls `saveSettings({ auto_like_enabled: false })`.
2. **Numbers** (three `Input type="number" inputMode="numeric"`, saved on blur/change with the existing `run()` helper): Minimum followers, Minimum account age (days), Daily limit.
3. **Checkboxes** (saved on change): Skip replies containing links; Skip accounts with no profile photo; Skip accounts with moderation labels.
4. **Fixed note** (muted): "Blocked and muted accounts, and your own replies, are always skipped. Replies are liked 2–30 minutes after they arrive."
5. **Stats line**: "Liked today N · last 7 days M" from two cheap counts over `auto_like_events`.
6. **Recent activity**: last 50 events, newest first, each one row: `@handle · liked` / `· skipped — reason text` / `· queued` / `· failed — reason` with a relative time. Reason text map: labeled → "moderation label", account_age → "account too new", no_avatar → "no profile photo", links → "contains a link", followers → "too few followers", cap → "daily limit reached", blocked → "blocked", muted → "muted", gave_up → "Bluesky kept erroring", http_4xx → "rejected by Bluesky".
7. **Error notice** when `auto_like_state.last_error` is set.

Data access from the PWA: `settings` (existing), `auto_like_state` (own row select), `auto_like_events` (own rows select, limit 50 plus two counts), and the `auto_like_enable` RPC. New helpers go in `app/src/lib/autolike.ts`; `Accounts.tsx` is already ~450 lines, so the card is its own component `app/src/components/AutoLikeCard.tsx`.

## 9. Testing

- **Decision rules** (`_shared/auto-like.test.ts`): `decide(notification, settings, followers)` is a pure function. Fixtures: a clean reply (queued); each fixed exclusion (not-direct-reply, self, blocked, blockedBy, muted, mutedByList); each adjustable rule on and off; a self-label that must be ignored vs a labeler label that must not; links via facet, via external embed, via bare text; ordering (a reply failing both labeled and links reports `labeled`).
- **Scan/like orchestration** (same file, stub adapter + stub db as in `job.test.ts`): watermark advances only after a successful scan; nothing older than the watermark is considered; page walking stops at the watermark and at 5 pages; the delay lands in 2–30 min; cap counts liked + queued; like pass retries then gives up at 5; 401 marks reconnect and stops; one user's throw does not stop the next; dry run writes nothing, likes nothing and leaves the watermark alone.
- **Adapter** (`bluesky.test.ts`): fake-fetch tests for `listNotifications` (query string, cursor passthrough), `getProfiles` (DID list encoding), `like` (record shape and `subject`).
- **Migration/RPC**: `auto_like_enable` sets the watermark and the flag atomically (checked in the live smoke below, not unit-tested).
- **Live check**: `deno task autolike-dry` calls the function with `?dry_run=1` against the linked project and prints the summary; run against the owner's test account with a few deliberate replies before enabling for anyone else.
- **PWA**: the helpers in `app/src/lib/autolike.ts` get a vitest for the reason-text mapping and the number-field clamping, in the same style as `PostResultCard.test.ts`. The test runner has no DOM, so the card itself is checked by hand at phone width.

## 10. Out of scope

- X (policy), Threads, any other platform.
- Liking quote posts, mentions, or nested replies.
- Auto-replying, auto-following, or any other automated action.
- Per-post opt-out, allow-lists, keyword filters, per-user time windows. All are easy to add later as further rules in §4.3 if the ledger shows a need.
- Notifying the user about likes made (push is reserved for posting failures).
