# CrossPosty Mobile — design

**Date:** 2026-09-21
**Status:** approved in conversation, awaiting written review
**Replaces:** the CrossPosty Chrome extension (`C:\Users\drice\CrossPosty`) and the phone pairing PWA (`C:\Users\drice\CrossPosty-phone`)

## Goal

A single-user app that lives entirely on a phone: compose a post with images, schedule it, and have it go out to Bluesky and X at the chosen time with no desktop, no browser extension and no app store.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| X posting method | Official X API v2, pay-per-use | Only route that works from a phone or server without cookie replay. At ~10 posts/week, a third with links, cost is about $3.25/month ($0.015 per post, $0.20 per post containing a link). Cheaper than the $99/yr Apple developer account any non-API iPhone route needs, and carries no ban risk. |
| Backend | Supabase (existing project) | Free tier covers it; project, bucket and auth already exist. |
| Users | One (the owner) | No multi-tenant auth, no per-user billing. |
| Bluesky auth | App password | Simpler than OAuth on a server; revocable from Bluesky settings. |
| Distribution | PWA on Netlify, installed to the home screen | No Apple involvement. |
| Platforms | Bluesky and X only | Threads, Substack, LinkedIn and Mastodon are dropped. |

## Architecture

```
┌── Phone PWA (Netlify, React + Vite + Tailwind) ─────────────┐
│  Sign in · Compose · Queue · Accounts                        │
│  Talks to Supabase with the user's session JWT only.         │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌── Supabase ──────────────────────────────────────────────────┐
│  Auth (magic link, one allowed email)                        │
│  Postgres: accounts · posts · settings   (RLS on all)        │
│  Storage: post-media (private)                               │
│  pg_cron (every minute) ──▶ Edge Function run-due-posts      │
│  Edge Functions: run-due-posts · post-now · connect-bluesky  │
│                  · x-oauth-callback                          │
│  Secrets: TOKEN_KEY · X_CLIENT_ID · X_CLIENT_SECRET          │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
              Bluesky PDS (atproto)      X API v2
```

The PWA never holds a platform token. Only Edge Functions can decrypt them.

## Data model

All tables carry `user_id` and row-level security restricting rows to `auth.uid()`.

### `accounts`

| Column | Type | Notes |
|---|---|---|
| `platform` | `'bluesky' \| 'x'` | Primary key with `user_id`. |
| `handle` | text | Display only. |
| `secret` | bytea | AES-GCM ciphertext of the token blob (below). |
| `expires_at` | timestamptz | Access-token expiry; null for Bluesky app password. |
| `status` | `'ok' \| 'needs_reconnect'` | Set by the job when a refresh fails. |
| `updated_at` | timestamptz | |

Token blob, before encryption:

- Bluesky: `{ identifier, appPassword, accessJwt, refreshJwt, did, pdsUrl }`
- X: `{ accessToken, refreshToken, userId }`

### `posts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `status` | `'draft' \| 'scheduled' \| 'posting' \| 'done' \| 'failed'` | |
| `scheduled_at` | timestamptz | UTC. |
| `text` | text | Master copy. |
| `variants` | jsonb | `{ bluesky?: string, x?: string }` overrides; absent means follow `text`. |
| `media` | jsonb | `[{ storagePath, mimeType, alt }]`, max 4. |
| `targets` | text[] | Subset of `['bluesky','x']`, non-empty when scheduled. |
| `results` | jsonb | Per target: `{ state: 'pending' \| 'sent' \| 'failed', url?, remoteId?, error?, attempts, nextAttemptAt? }`. |
| `posting_started_at` | timestamptz | Set when claimed; used to detect a crashed run. |
| `created_at`, `updated_at` | timestamptz | |

`done` means every target is `sent`. `failed` means at least one target is `failed` and none is `pending`.

### `settings`

One row per user: `mention_map` (jsonb, same shape as today's `MentionMap`), `default_targets` (text[]).

### Storage

Bucket `post-media`, private, path `<user_id>/<post_id>/<index>`. RLS lets the user read and write their own prefix. Objects are deleted by the job one day after the post reaches `done`; a daily cron also removes objects for posts that no longer exist.

## Token encryption

`TOKEN_KEY` is a 256-bit AES-GCM key held only in Edge Function secrets. Encrypt with a random 12-byte IV per write; store `iv || ciphertext` in `accounts.secret`. A database dump alone cannot yield a token.

## The posting job (`run-due-posts`)

Invoked every minute by `pg_cron` via `pg_net` with the service-role key, and directly by the `post-now` function.

1. **Claim.** In one transaction: `SELECT ... FROM posts WHERE status = 'scheduled' AND scheduled_at <= now() FOR UPDATE SKIP LOCKED`, then set `status = 'posting'`, `posting_started_at = now()`. Also re-queue any post with `status = 'posting'` and `posting_started_at < now() - interval '10 minutes'` (a crashed run); its per-target results prevent re-sending.
2. **Per target** (in the order given by `targets`), skipping any already `sent` and any whose `nextAttemptAt` is in the future:
   1. Load and decrypt the account. If `status = 'needs_reconnect'`, mark the target failed with that error.
   2. `refreshIfNeeded`: refresh when `expires_at` is within 5 minutes. On refresh failure, set `accounts.status = 'needs_reconnect'` and fail the target.
   3. Resolve the text: `variants[target] ?? text`, then `formatForPlatform` (mention map, platform limit; chain-capable platforms skip truncation).
   4. Split into chunks with `splitIntoChain`. Upload images once, attach to the head chunk only. Post each chunk as a reply to the previous, with the platform's pacing delay.
   5. Write the target result immediately (`sent` with the head URL, or `failed`).
3. **Classify failures.** Network errors, HTTP 5xx and 429 are transient: increment `attempts`, and if under 3 set `nextAttemptAt = now() + 5 min` and leave the target `pending`. Anything else (4xx other than 429, revoked token, media rejected) is permanent: `failed`.
4. **Finish.** If any target is still `pending`, set the post back to `scheduled` so the next tick retries it. Otherwise set `done` or `failed`. On `failed`, send a push notification.

A partial chain (head posted, later chunk failed) counts as `sent` with the head URL, and the error is kept in `results[target].error` for display, matching today's behaviour.

## Platform adapters (Edge Function, Deno)

Common interface:

```ts
interface Adapter {
  refreshIfNeeded(account: DecryptedAccount): Promise<DecryptedAccount>;
  uploadMedia(account, image: { bytes: Uint8Array; mimeType: string; alt: string }): Promise<string>;
  post(account, text: string, mediaIds: string[], replyTo?: PostRef): Promise<PostRef & { url: string }>;
  characterLimit: number;
  pacingMs: number;
}
```

### Bluesky

Port of `src/platforms/bluesky.ts`, app-password path only, using `@atproto/api` via `npm:` specifier.

- Session: `com.atproto.server.createSession` on connect; `refreshSession` when the access JWT is within 5 minutes of expiry; persist rotated tokens after every use. If refresh fails, fall back to `createSession` with the stored app password before giving up.
- Images: resize to under 1 MB (port of the existing canvas/`OffscreenCanvas` logic, or `imagescript` if `OffscreenCanvas` is unavailable in Deno), `uploadBlob`, `app.bsky.embed.images` with alt text.
- Facets: port `bluesky-facets.ts` unchanged (links, mentions resolved to DIDs, hashtags).
- Chaining: `reply: { root, parent }`, 1 s pacing. Limit 300.

### X

New, on the v2 API.

- **OAuth 2.0 with PKCE**, confidential client. Scopes: `tweet.read tweet.write users.read media.write offline.access`. The PWA generates the verifier and opens `https://x.com/i/oauth2/authorize`; X redirects to the PWA, which posts the code and verifier to `x-oauth-callback`, which exchanges them using `X_CLIENT_SECRET`, fetches `/2/users/me`, encrypts and stores the tokens.
- **Refresh**: access tokens last 2 hours; refresh tokens are single-use. Refresh when within 5 minutes of expiry and store the new pair immediately.
- **Media**: `POST /2/media/upload` chunked (INIT, APPEND, FINALIZE, STATUS poll if `processing_info` is returned), `media_category = tweet_image`. Up to 4 images.
- **Post**: `POST /2/tweets` with `{ text, media: { media_ids }, reply: { in_reply_to_tweet_id } }`. Chaining with 2 s pacing, images on the head only. Limit 280. URL: `https://x.com/<handle>/status/<id>`.
- **Errors**: 429 and 5xx transient; 401 after a refresh attempt means `needs_reconnect`; 403 and 400 permanent with the API's message surfaced.

### Not carried over

Cookie reading, `CreateTweet` template capture, `declarativeNetRequest` header rewrites, the hourly rate-limit guard and the 24-hour auto-pause. The API has documented limits and no anti-automation flagging for its own clients.

## Shared code (`shared/`)

Ported unchanged from the extension, with tests: `thread-split.ts`, `format.ts` (mention swap, hashtag handling, per-platform truncation, `CHAIN_CAPABLE = {x, bluesky}`), `bluesky-facets.ts`, and the `Post`, `MentionMap` and result types. Imported by both the PWA and the Edge Functions so the character counts and chain hints shown on the phone match what the server does.

## The phone app

Stack: Vite, React, Tailwind, `vite-plugin-pwa`, Supabase JS client. Installed to the iOS home screen.

### Sign in

Email magic link. A `before insert` trigger on `auth.users` raises unless the email equals the configured owner address, so the public URL can't be used by anyone else.

### Compose

- Text area; image picker (max 4) with a thumbnail and an alt-text field per image; images upload to Storage on save.
- Target toggles for Bluesky and X. Next to X: estimated cost, `$0.015` or `$0.20` if the text contains a URL, multiplied by the number of chunks.
- Per-platform character counts. Over the limit shows "Will chain into N posts" rather than an error.
- "Edit for Bluesky" / "Edit for X" disclosures that create a variant override; a "reset to master" link removes it.
- Time picker in the phone's local zone (stored UTC), default now. Buttons: **Schedule** (status `scheduled`) and **Post now** (`scheduled_at = now()`, then calls `post-now` and shows per-platform results with links).
- Composing works offline; Schedule and Post now require a connection and say so.

### Queue

Groups: **Scheduled** (edit, reschedule, cancel back to draft or delete), **Sent** (per-platform links), **Failed** (per-platform error, Retry button which resets that target to `pending`, `attempts = 0`, and the post to `scheduled`). Drafts appear at the top.

### Accounts

- Bluesky: handle and app password fields; Connect calls an Edge Function `connect-bluesky` that creates the session and stores the encrypted blob.
- X: Connect X button starting the OAuth flow; shows handle and status; Reconnect when `needs_reconnect`.
- Mention map editor (same UI as today's `Mentions.tsx`).

### Notifications

Web push (VAPID) for failed posts only. Permission is requested the first time a post is scheduled. Subscription stored in a `push_subscriptions` table; `run-due-posts` sends through `web-push` when a post reaches `failed`.

## Repo layout

New repo `CrossPosty-mobile`:

```
app/          PWA
shared/       thread-split, format, facets, types (+ tests)
supabase/
  migrations/ tables, RLS, cron, trigger
  functions/  run-due-posts · post-now · connect-bluesky · x-oauth-callback
  tests/      adapter + job tests (Deno test, mocked fetch)
scripts/      live-smoke.ts
docs/         SETUP.md (one-time setup checklist), MANUAL.md
```

## Testing

- **Unit** (Vitest): shared text code, ported from `tests/platforms/*.test.ts` and the thread-split tests.
- **Adapter and job** (Deno test, mocked `fetch`): token refresh and rotation, chunked upload, chaining, transient vs permanent classification, per-target result writing, and that re-running the job on a half-finished post sends only the remaining target.
- **Live smoke** (`scripts/live-smoke.ts`, run by hand): one text post, one four-image post with alt text, one thread, to each platform. Proves the X developer app, scopes and billing, and the Bluesky app password.
- **Manual checklist** (`docs/MANUAL.md`): install to home screen, schedule and background off the phone until it fires, failure notification, reconnect flow.

## One-time setup (owner)

1. Create an X developer app in the Developer Console: OAuth 2.0, confidential client, callback URL = the PWA's URL, scopes as above. Add a payment method and a small credit balance. Note the media-upload rate shown in the console.
2. Generate a Bluesky app password.
3. Set Edge Function secrets: `TOKEN_KEY` (32 random bytes, base64), `X_CLIENT_ID`, `X_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `OWNER_EMAIL`.
4. Apply migrations; enable `pg_cron` and `pg_net`.
5. Deploy the PWA to Netlify (repoint the existing site).

## Migration from the current apps

- Archive the extension repo with a final commit pointing at `CrossPosty-mobile`. Do not delete: the history keeps the Threads and Substack adapters.
- Drop the relay table, `relay-media` bucket and pairing from the Supabase project after the new schema is live.
- Retire the pairing PWA by repointing its Netlify site.

## Out of scope

Multiple users, multiple accounts per platform, video, drafts synced across devices, analytics, any platform other than Bluesky and X, an App Store listing.
