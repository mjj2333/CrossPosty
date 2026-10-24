# Bluesky Auto-like Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically like qualifying direct replies to a user's Bluesky posts, 2–30 minutes after they arrive, with per-user filters and a visible ledger in the PWA.

**Architecture:** A new per-minute Edge Function `auto-like` polls each enabled user's Bluesky notifications, runs a pure decision function over new direct replies, queues the survivors in an `auto_like_events` table with a random due time, and likes whatever is due. Settings live as typed columns on the existing `settings` table; runtime state (watermark, last error) in `auto_like_state`. The PWA gets an `AutoLikeCard` on the Accounts tab.

**Tech Stack:** Deno Edge Functions (Supabase), PostgreSQL + pg_cron, plain XRPC fetch against the user's PDS, React 19 + Vite PWA, `deno test` / vitest.

**Spec:** `C:\Users\drice\CrossPosty\docs\superpowers\specs\2026-10-24-bluesky-auto-like-design.md`
**Repo:** `C:\Users\drice\CrossPosty-mobile` (all paths below are relative to it unless absolute). Plans and specs live in `C:\Users\drice\CrossPosty\docs\superpowers\`.

**Conventions you must follow**
- Run backend checks with `deno task check` (lint + fmt + typecheck + tests). Run `deno fmt supabase/functions scripts` before committing backend code.
- Run app checks from `app/` with `npm test`, `npm run lint`, `npm run build`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `fakeFetch` (in `_shared/test-utils.ts`) matches routes by URL substring and throws unless exactly one route matches. Pick substrings that cannot collide (`app.bsky.notification.listNotifications`, not `list`).
- Timestamps from Postgres arrive as `2026-10-24T18:06:03.123456+00:00`; from Bluesky as `2026-10-24T18:06:03.123Z`. **Never compare them as strings.** Use `Date.parse`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261024000010_auto_like.sql` | settings columns, `auto_like_state`, `auto_like_events`, RLS/grants, `auto_like_enable()` RPC |
| `supabase/migrations/20261024000011_auto_like_cron.sql` | pg_cron schedule (applied last, at deploy, so cron never calls an undeployed function) |
| `supabase/functions/_shared/tokens.ts` | `freshTokens()` — load/refresh/persist a user's platform tokens (extracted from `job.ts`, shared) |
| `supabase/functions/_shared/adapters/bluesky.ts` | `BlueskyAdapter` type + `listNotifications`, `getProfiles`, `like` |
| `supabase/functions/_shared/auto-like/decide.ts` | pure decision function, settings and reason types |
| `supabase/functions/_shared/auto-like/run.ts` | `runAutoLikeForUser()` — scan pass + like pass over an `AutoLikeDb` interface |
| `supabase/functions/_shared/auto-like/db.ts` | Supabase implementation of `AutoLikeDb` |
| `supabase/functions/auto-like/index.ts` | cron entrypoint; `?dry_run=1&lookback=<min>` |
| `supabase/functions/cleanup-media/index.ts` | + purge `auto_like_events` older than 30 days |
| `scripts/autolike-dry.ts` | calls the function in dry-run mode and prints decisions |
| `app/src/lib/autolike.ts` | PWA data helpers, reason text, number clamping |
| `app/src/components/AutoLikeCard.tsx` | the card |
| `app/src/screens/Accounts.tsx` | mounts the card under the Bluesky card |
| `docs/SETUP.md` | section 15 |

---

### Task 1: Schema migration (settings columns, state, ledger, enable RPC)

**Files:**
- Create: `supabase/migrations/20261024000010_auto_like.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Bluesky auto-like: per-user settings (columns on settings), runtime
-- state and a ledger of every reply considered. Bluesky only; X's
-- automation rules ban automated likes outright.

-- 1. Settings -----------------------------------------------------------
alter table settings
  add column auto_like_enabled boolean not null default false,
  add column auto_like_min_followers integer not null default 5
    constraint auto_like_min_followers_range check (auto_like_min_followers >= 0),
  add column auto_like_min_account_age_days integer not null default 7
    constraint auto_like_min_account_age_days_range check (auto_like_min_account_age_days >= 0),
  add column auto_like_skip_links boolean not null default true,
  add column auto_like_skip_no_avatar boolean not null default false,
  add column auto_like_skip_labeled boolean not null default true,
  add column auto_like_daily_cap integer not null default 100
    constraint auto_like_daily_cap_range check (auto_like_daily_cap between 1 and 1000);

-- 2. Runtime state, one row per user -----------------------------------
-- watermark: only notifications indexed after this instant are considered.
-- Set to now() whenever the feature is switched on (see auto_like_enable).
create table auto_like_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  watermark   timestamptz not null,
  last_run_at timestamptz,
  last_error  text,
  updated_at  timestamptz not null default now()
);
create trigger auto_like_state_set_updated_at before update on auto_like_state
  for each row execute function set_updated_at();

alter table auto_like_state enable row level security;
create policy "own auto_like_state" on auto_like_state
  for select to authenticated using (auth.uid() = user_id);
revoke all on auto_like_state from anon, authenticated;
grant select on auto_like_state to authenticated;
grant all on auto_like_state to service_role;

-- 3. Ledger, one row per reply considered ------------------------------
create table auto_like_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  reply_uri     text not null,
  reply_cid     text not null,
  author_did    text not null,
  author_handle text not null,
  decision      text not null
    constraint auto_like_events_decision check (decision in ('queued', 'liked', 'skipped', 'failed')),
  reason        text,
  due_at        timestamptz,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  liked_at      timestamptz,
  constraint auto_like_events_once unique (user_id, reply_uri)
);
create index auto_like_events_user_created on auto_like_events (user_id, created_at desc);
create index auto_like_events_due on auto_like_events (user_id, due_at) where decision = 'queued';
create index auto_like_events_liked on auto_like_events (user_id, liked_at) where decision = 'liked';

alter table auto_like_events enable row level security;
create policy "own auto_like_events" on auto_like_events
  for select to authenticated using (auth.uid() = user_id);
revoke all on auto_like_events from anon, authenticated;
grant select on auto_like_events to authenticated;
grant all on auto_like_events to service_role;

-- 4. Switch-on RPC -------------------------------------------------------
-- Sets the flag and resets the watermark in one transaction so a stale
-- watermark from an earlier enablement can never cause a backfill burst.
create or replace function auto_like_enable() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into settings (user_id, auto_like_enabled) values (auth.uid(), true)
    on conflict (user_id) do update set auto_like_enabled = true;
  insert into auto_like_state (user_id, watermark, last_error) values (auth.uid(), now(), null)
    on conflict (user_id) do update set watermark = now(), last_error = null;
end $$;
revoke execute on function auto_like_enable() from public, anon;
grant execute on function auto_like_enable() to authenticated;
```

- [ ] **Step 2: Push it to the linked project**

Run: `npx supabase db push --linked`
Expected: lists `20261024000010_auto_like.sql` and ends with `Finished supabase db push.` (Answer `Y` if prompted; the CLI is already linked.)

- [ ] **Step 3: Verify the objects exist**

Run:
```
npx supabase db query --linked "select column_name, column_default from information_schema.columns where table_name = 'settings' and column_name like 'auto_like%' order by column_name"
```
Expected: 7 rows (`auto_like_daily_cap` default `100`, `auto_like_enabled` default `false`, `auto_like_min_account_age_days` `7`, `auto_like_min_followers` `5`, `auto_like_skip_labeled` `true`, `auto_like_skip_links` `true`, `auto_like_skip_no_avatar` `false`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261024000010_auto_like.sql
git commit -m "feat(db): auto-like settings, state and ledger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Extract `freshTokens()` from the posting job

The posting job already loads, refreshes and persists tokens with concurrent-refresh recovery. Auto-like needs the exact same behaviour, so move it into a shared helper. The 23 existing job tests (`persists rotated tokens…`, `recovers from a concurrent token refresh…`, `a reauth error with no newer secret…`, `an account already needing reconnect…`) are the safety net.

**Files:**
- Create: `supabase/functions/_shared/tokens.ts`
- Modify: `supabase/functions/_shared/job.ts`

- [ ] **Step 1: Run the job tests to record the baseline**

Run: `deno test supabase/functions/_shared/job.test.ts`
Expected: `ok | 23 passed | 0 failed`

- [ ] **Step 2: Create the helper**

```ts
// supabase/functions/_shared/tokens.ts
// Loads a user's decrypted tokens for a platform, refreshing them through
// the adapter when needed and persisting rotated tokens. Shared by the
// posting job and auto-like so the concurrent-refresh recovery lives once.

import type { Adapter } from './adapters/types.ts';
import { PostError, toPostError } from './adapters/types.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import type { JobDb } from './job.ts';
import type { Platform } from './types.ts';

export type TokenDb = Pick<JobDb, 'getAccount' | 'saveAccountSecret'>;

// Throws PostError('permanent') when no usable account exists, and lets a
// 'reauth' PostError from the adapter bubble so the caller can mark the
// account for reconnection.
export async function freshTokens<T>(
  userId: string,
  platform: Platform,
  adapter: Pick<Adapter<T, unknown>, 'refreshIfNeeded'>,
  db: TokenDb,
  key: CryptoKey,
  nowMs: number,
): Promise<T> {
  const account = await db.getAccount(userId, platform);
  if (!account) throw new PostError(`No ${platform} account connected`, 'permanent');
  if (account.status === 'needs_reconnect') {
    throw new PostError(`${platform} account needs to be reconnected`, 'permanent');
  }

  let tokens = (await decryptJson(key, account.secret)) as T;
  let refreshed;
  try {
    refreshed = await adapter.refreshIfNeeded(tokens, nowMs);
  } catch (err) {
    const pe = toPostError(err);
    if (pe.kind !== 'reauth') throw err;
    // Another run may have rotated the tokens under us. Re-read; if the
    // stored secret changed, use it and try once more.
    const latest = await db.getAccount(userId, platform);
    if (!latest || latest.secret === account.secret) throw err;
    tokens = (await decryptJson(key, latest.secret)) as T;
    refreshed = await adapter.refreshIfNeeded(tokens, nowMs);
  }
  if (refreshed.changed) {
    await db.saveAccountSecret(
      userId,
      platform,
      await encryptJson(key, refreshed.tokens),
      refreshed.expiresAt?.toISOString() ?? null,
    );
  }
  return refreshed.tokens;
}
```

- [ ] **Step 3: Use it in `job.ts`**

In `supabase/functions/_shared/job.ts`, replace the imports

```ts
import { type AnyAdapter, type ImageInput, PostError, toPostError } from './adapters/types.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { postChain, type Sleep } from './post-chain.ts';
```

with

```ts
import { type AnyAdapter, type ImageInput, PostError, toPostError } from './adapters/types.ts';
import { postChain, type Sleep } from './post-chain.ts';
import { freshTokens } from './tokens.ts';
```

and inside `postToTarget`, replace everything from `const account = await deps.db.getAccount(post.user_id, platform);` through `tokens = refreshed.tokens;` (the block that ends just before `const formatted = formatForPlatform(`) with:

```ts
    const tokens = await freshTokens(
      post.user_id,
      platform,
      adapter,
      deps.db,
      deps.key,
      now.getTime(),
    );
```

- [ ] **Step 4: Run the full check**

Run: `deno task check`
Expected: lint and fmt clean, typecheck clean, `ok | 118 passed | 0 failed`. If lint reports an unused import in `job.ts`, remove it.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/tokens.ts supabase/functions/_shared/job.ts
git commit -m "refactor(job): extract freshTokens for reuse by auto-like

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Bluesky adapter — `listNotifications`, `getProfiles`, `like`

**Files:**
- Modify: `supabase/functions/_shared/adapters/bluesky.ts`
- Test: `supabase/functions/_shared/adapters/bluesky.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `bluesky.test.ts`)

```ts
Deno.test('listNotifications passes reasons, limit and cursor and returns the page', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(
    fakeFetch({
      'app.bsky.notification.listNotifications': () =>
        json({
          notifications: [{
            uri: 'at://did:plc:a/app.bsky.feed.post/1',
            cid: 'c1',
            reason: 'reply',
            indexedAt: '2026-10-24T00:00:00.000Z',
            author: { did: 'did:plc:a', handle: 'a.bsky.social' },
            record: { text: 'hi' },
          }],
          cursor: 'next',
        }),
    }, calls),
  );
  const out = await adapter.listNotifications(tokens(), {
    reasons: ['reply'],
    cursor: 'abc',
    limit: 50,
  });
  const u = new URL(calls[0].url);
  assertEquals(u.origin + u.pathname, 'https://pds.example/xrpc/app.bsky.notification.listNotifications');
  assertEquals(u.searchParams.getAll('reasons'), ['reply']);
  assertEquals(u.searchParams.get('cursor'), 'abc');
  assertEquals(u.searchParams.get('limit'), '50');
  assertEquals((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${inOneHour}`);
  assertEquals(out.cursor, 'next');
  assertEquals(out.notifications.length, 1);
  assertEquals(out.notifications[0].author.handle, 'a.bsky.social');
});

Deno.test('listNotifications tolerates a missing notifications array', async () => {
  const adapter = createBlueskyAdapter(
    fakeFetch({ 'app.bsky.notification.listNotifications': () => json({}) }),
  );
  const out = await adapter.listNotifications(tokens(), {});
  assertEquals(out, { notifications: [], cursor: undefined });
});

Deno.test('getProfiles encodes every DID and maps follower counts', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(
    fakeFetch({
      'app.bsky.actor.getProfiles': () =>
        json({
          profiles: [
            { did: 'did:plc:a', followersCount: 12 },
            { did: 'did:plc:b' }, // no count reported
          ],
        }),
    }, calls),
  );
  const out = await adapter.getProfiles(tokens(), ['did:plc:a', 'did:plc:b']);
  const u = new URL(calls[0].url);
  assertEquals(u.searchParams.getAll('actors'), ['did:plc:a', 'did:plc:b']);
  assertEquals(out.get('did:plc:a'), { followersCount: 12 });
  assertEquals(out.get('did:plc:b'), { followersCount: 0 });
});

Deno.test('getProfiles with no DIDs makes no network call', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(fakeFetch({}, calls));
  const out = await adapter.getProfiles(tokens(), []);
  assertEquals(out.size, 0);
  assertEquals(calls.length, 0);
});

Deno.test('getProfiles rejects more than 25 DIDs without a network call', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(fakeFetch({}, calls));
  const dids = Array.from({ length: 26 }, (_, i) => `did:plc:${i}`);
  const err = await assertRejects(() => adapter.getProfiles(tokens(), dids), PostError);
  assertEquals(err.kind, 'permanent');
  assertEquals(calls.length, 0);
});

Deno.test('like creates an app.bsky.feed.like record pointing at the subject', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(
    fakeFetch({
      'com.atproto.repo.createRecord': () =>
        json({ uri: 'at://did:plc:me/app.bsky.feed.like/xyz', cid: 'likecid' }),
    }, calls),
  );
  const out = await adapter.like(tokens(), { uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1' });
  assertEquals(out, { uri: 'at://did:plc:me/app.bsky.feed.like/xyz' });
  const body = bodyJson(calls[0].init) as {
    repo: string;
    collection: string;
    record: { $type: string; subject: { uri: string; cid: string }; createdAt: string };
  };
  assertEquals(body.repo, 'did:plc:me');
  assertEquals(body.collection, 'app.bsky.feed.like');
  assertEquals(body.record.$type, 'app.bsky.feed.like');
  assertEquals(body.record.subject, { uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1' });
  assertEquals(typeof body.record.createdAt, 'string');
});

Deno.test('like surfaces a 400 as a permanent error', async () => {
  const adapter = createBlueskyAdapter(
    fakeFetch({ 'com.atproto.repo.createRecord': () => json({ error: 'InvalidRequest' }, 400) }),
  );
  const err = await assertRejects(() => adapter.like(tokens(), { uri: 'at://x', cid: 'c' }), PostError);
  assertEquals(err.kind, 'permanent');
  assertEquals(err.info.status, 400);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno test supabase/functions/_shared/adapters/bluesky.test.ts`
Expected: type-check FAIL — `Property 'listNotifications' does not exist on type 'Adapter<BlueskyTokens, BskyImage>'`.

- [ ] **Step 3: Add the types and methods to `bluesky.ts`**

After the `BskyImage` type, add:

```ts
// Notification shapes, typed only as far as auto-like reads them.
export type BskyLabel = { src: string; val: string; neg?: boolean };

export type BskyProfileView = {
  did: string;
  handle: string;
  avatar?: string;
  createdAt?: string;
  labels?: BskyLabel[];
  viewer?: {
    muted?: boolean;
    mutedByList?: unknown;
    blockedBy?: boolean;
    blocking?: string;
    blockingByList?: unknown;
  };
};

export type BskyReplyRecord = {
  text?: string;
  reply?: { parent?: { uri?: string }; root?: { uri?: string } };
  facets?: Array<{ features?: Array<{ $type?: string }> }>;
  embed?: { $type?: string; media?: { $type?: string } };
};

export type BskyNotification = {
  uri: string;
  cid: string;
  author: BskyProfileView;
  reason: string;
  reasonSubject?: string;
  record: BskyReplyRecord;
  indexedAt: string;
};

// The generic Adapter interface stays platform-neutral; these calls exist
// only on Bluesky (X's automation rules ban automated likes outright).
export type BlueskyAdapter = Adapter<BlueskyTokens, BskyImage> & {
  listNotifications(
    tokens: BlueskyTokens,
    opts: { reasons?: string[]; cursor?: string; limit?: number },
  ): Promise<{ notifications: BskyNotification[]; cursor?: string }>;
  getProfiles(
    tokens: BlueskyTokens,
    dids: string[],
  ): Promise<Map<string, { followersCount: number }>>;
  like(tokens: BlueskyTokens, subject: { uri: string; cid: string }): Promise<{ uri: string }>;
};

const GET_PROFILES_MAX = 25; // app.bsky.actor.getProfiles lexicon maxLength for `actors`
```

Change the factory signature from

```ts
export function createBlueskyAdapter(
  fetchImpl: typeof fetch = fetch,
): Adapter<BlueskyTokens, BskyImage> {
```

to

```ts
export function createBlueskyAdapter(fetchImpl: typeof fetch = fetch): BlueskyAdapter {
```

and add the three methods to the returned object, after `post(...)`:

```ts
    async listNotifications(tokens, opts) {
      const params = new URLSearchParams();
      params.set('limit', String(opts.limit ?? 50));
      for (const r of opts.reasons ?? []) params.append('reasons', r);
      if (opts.cursor) params.set('cursor', opts.cursor);
      const res = await fetchImpl(
        `${tokens.pdsUrl}/xrpc/app.bsky.notification.listNotifications?${params}`,
        {
          method: 'GET',
          headers: authHeaders(tokens),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw await httpError(res, 'listNotifications');
      const json = (await res.json()) as { notifications?: BskyNotification[]; cursor?: string };
      return { notifications: json.notifications ?? [], cursor: json.cursor };
    },

    async getProfiles(tokens, dids) {
      const out = new Map<string, { followersCount: number }>();
      if (dids.length === 0) return out;
      if (dids.length > GET_PROFILES_MAX) {
        throw new PostError(
          `getProfiles takes at most ${GET_PROFILES_MAX} actors per call`,
          'permanent',
        );
      }
      const params = new URLSearchParams();
      for (const d of dids) params.append('actors', d);
      const res = await fetchImpl(`${tokens.pdsUrl}/xrpc/app.bsky.actor.getProfiles?${params}`, {
        method: 'GET',
        headers: authHeaders(tokens),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw await httpError(res, 'getProfiles');
      const json = (await res.json()) as {
        profiles?: Array<{ did: string; followersCount?: number }>;
      };
      for (const p of json.profiles ?? []) out.set(p.did, { followersCount: p.followersCount ?? 0 });
      return out;
    },

    async like(tokens, subject) {
      const record = {
        $type: 'app.bsky.feed.like',
        subject,
        createdAt: new Date().toISOString(),
      };
      const res = await fetchImpl(`${tokens.pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: { ...authHeaders(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({ repo: tokens.did, collection: 'app.bsky.feed.like', record }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw await httpError(res, 'like');
      const { uri } = (await res.json()) as { uri: string };
      return { uri };
    },
```

- [ ] **Step 4: Run the adapter tests**

Run: `deno test supabase/functions/_shared/adapters/bluesky.test.ts`
Expected: all pass, including the 7 new ones.

- [ ] **Step 5: Full check and commit**

Run: `deno fmt supabase/functions && deno task check`
Expected: clean, `ok | 125 passed | 0 failed`.

```bash
git add supabase/functions/_shared/adapters/bluesky.ts supabase/functions/_shared/adapters/bluesky.test.ts
git commit -m "feat(bluesky): listNotifications, getProfiles and like

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Pure decision function

**Files:**
- Create: `supabase/functions/_shared/auto-like/decide.ts`
- Test: `supabase/functions/_shared/auto-like/decide.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/auto-like/decide.test.ts
import { assertEquals } from '@std/assert';
import type { BskyNotification } from '../adapters/bluesky.ts';
import { type AutoLikeSettings, containsLink, decide, type DecideContext } from './decide.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const ME = 'did:plc:me';
const MY_POST = `at://${ME}/app.bsky.feed.post/abc`;

const defaults: AutoLikeSettings = {
  minFollowers: 5,
  minAccountAgeDays: 7,
  skipLinks: true,
  skipNoAvatar: false,
  skipLabeled: true,
  dailyCap: 100,
};

type Deep = {
  author?: Partial<BskyNotification['author']>;
  record?: BskyNotification['record'];
  reason?: string;
  reasonSubject?: string;
};

// A clean, qualifying direct reply from a 1-year-old account with an avatar.
function reply(o: Deep = {}): BskyNotification {
  return {
    uri: 'at://did:plc:them/app.bsky.feed.post/r1',
    cid: 'cid-r1',
    reason: o.reason ?? 'reply',
    reasonSubject: o.reasonSubject,
    indexedAt: '2026-10-24T11:59:00.000Z',
    author: {
      did: 'did:plc:them',
      handle: 'them.bsky.social',
      avatar: 'https://cdn/avatar.jpg',
      createdAt: '2025-10-24T00:00:00.000Z',
      labels: [],
      viewer: {},
      ...o.author,
    },
    record: o.record ?? { text: 'lovely!', reply: { parent: { uri: MY_POST } } },
  };
}

function ctx(over: Partial<DecideContext> = {}, s: Partial<AutoLikeSettings> = {}): DecideContext {
  return { selfDid: ME, settings: { ...defaults, ...s }, now: NOW, ...over };
}

Deno.test('a clean direct reply needs a follower count, then queues', () => {
  assertEquals(decide(reply(), ctx()), { kind: 'needs_followers' });
  assertEquals(decide(reply(), ctx({ followersCount: 5 })), { kind: 'queue' });
});

Deno.test('ignores anything that is not a direct reply to one of our posts', () => {
  assertEquals(decide(reply({ reason: 'mention' }), ctx()), { kind: 'ignore' });
  assertEquals(decide(reply({ reason: 'quote' }), ctx()), { kind: 'ignore' });
  // Reply to someone else's post, even under our thread.
  const nested = reply({
    record: {
      text: 'x',
      reply: { root: { uri: MY_POST }, parent: { uri: 'at://did:plc:other/app.bsky.feed.post/z' } },
    },
  });
  assertEquals(decide(nested, ctx()), { kind: 'ignore' });
});

Deno.test('falls back to reasonSubject when the record has no reply field', () => {
  const n = reply({ record: { text: 'x' }, reasonSubject: MY_POST });
  assertEquals(decide(n, ctx({ followersCount: 10 })), { kind: 'queue' });
});

Deno.test('ignores our own replies', () => {
  assertEquals(decide(reply({ author: { did: ME } }), ctx()), { kind: 'ignore' });
});

Deno.test('blocked and muted accounts are skipped regardless of settings', () => {
  const off = { skipLabeled: false, skipLinks: false, skipNoAvatar: false, minAccountAgeDays: 0, minFollowers: 0 };
  assertEquals(decide(reply({ author: { viewer: { blocking: 'at://me/block/1' } } }), ctx({}, off)), { kind: 'skip', reason: 'blocked' });
  assertEquals(decide(reply({ author: { viewer: { blockedBy: true } } }), ctx({}, off)), { kind: 'skip', reason: 'blocked' });
  assertEquals(decide(reply({ author: { viewer: { blockingByList: { uri: 'l' } } } }), ctx({}, off)), { kind: 'skip', reason: 'blocked' });
  assertEquals(decide(reply({ author: { viewer: { muted: true } } }), ctx({}, off)), { kind: 'skip', reason: 'muted' });
  assertEquals(decide(reply({ author: { viewer: { mutedByList: { uri: 'l' } } } }), ctx({}, off)), { kind: 'skip', reason: 'muted' });
});

Deno.test('labels from a moderation service skip; self-labels and negated labels do not', () => {
  const modLabel = reply({ author: { labels: [{ src: 'did:plc:moderation', val: 'spam' }] } });
  assertEquals(decide(modLabel, ctx()), { kind: 'skip', reason: 'labeled' });
  const selfLabel = reply({ author: { labels: [{ src: 'did:plc:them', val: 'porn' }] } });
  assertEquals(decide(selfLabel, ctx()), { kind: 'needs_followers' });
  const negated = reply({ author: { labels: [{ src: 'did:plc:moderation', val: 'spam', neg: true }] } });
  assertEquals(decide(negated, ctx()), { kind: 'needs_followers' });
  // Setting off → passes even with a moderation label.
  assertEquals(decide(modLabel, ctx({}, { skipLabeled: false })), { kind: 'needs_followers' });
});

Deno.test('young or undated accounts are skipped when a minimum age is set', () => {
  const young = reply({ author: { createdAt: '2026-10-20T00:00:00.000Z' } }); // 4 days old
  assertEquals(decide(young, ctx()), { kind: 'skip', reason: 'account_age' });
  const undated = reply({ author: { createdAt: undefined } });
  assertEquals(decide(undated, ctx()), { kind: 'skip', reason: 'account_age' });
  assertEquals(decide(young, ctx({}, { minAccountAgeDays: 0 })), { kind: 'needs_followers' });
  // Exactly 7 days old passes.
  const exact = reply({ author: { createdAt: '2026-10-17T12:00:00.000Z' } });
  assertEquals(decide(exact, ctx()), { kind: 'needs_followers' });
});

Deno.test('missing avatar is skipped only when that setting is on', () => {
  const bare = reply({ author: { avatar: undefined } });
  assertEquals(decide(bare, ctx()), { kind: 'needs_followers' });
  assertEquals(decide(bare, ctx({}, { skipNoAvatar: true })), { kind: 'skip', reason: 'no_avatar' });
});

Deno.test('containsLink sees facets, external embeds and bare URLs', () => {
  assertEquals(containsLink({ text: 'plain words only' }), false);
  assertEquals(containsLink({ text: 'see e.g. this, 3.5 stars' }), false);
  assertEquals(
    containsLink({
      text: 'look',
      facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link' }] }],
    }),
    true,
  );
  assertEquals(
    containsLink({ text: 'look', facets: [{ features: [{ $type: 'app.bsky.richtext.facet#mention' }] }] }),
    false,
  );
  assertEquals(containsLink({ text: 'x', embed: { $type: 'app.bsky.embed.external' } }), true);
  assertEquals(
    containsLink({
      text: 'x',
      embed: { $type: 'app.bsky.embed.recordWithMedia', media: { $type: 'app.bsky.embed.external' } },
    }),
    true,
  );
  assertEquals(containsLink({ text: 'x', embed: { $type: 'app.bsky.embed.images' } }), false);
  assertEquals(containsLink({ text: 'go to https://spam.example/now' }), true);
  assertEquals(containsLink({ text: 'go to spam.com/now' }), true);
  assertEquals(containsLink({ text: 'go to onlyfans.com' }), true);
});

Deno.test('links skip only when the setting is on', () => {
  const linked = reply({ record: { text: 'https://x.y/z', reply: { parent: { uri: MY_POST } } } });
  assertEquals(decide(linked, ctx()), { kind: 'skip', reason: 'links' });
  assertEquals(decide(linked, ctx({}, { skipLinks: false })), { kind: 'needs_followers' });
});

Deno.test('follower threshold', () => {
  assertEquals(decide(reply(), ctx({ followersCount: 4 })), { kind: 'skip', reason: 'followers' });
  assertEquals(decide(reply(), ctx({ followersCount: 5 })), { kind: 'queue' });
  // No minimum → no lookup needed at all.
  assertEquals(decide(reply(), ctx({}, { minFollowers: 0 })), { kind: 'queue' });
});

Deno.test('rules apply in order: the first failing rule is the reason', () => {
  const both = reply({
    author: { labels: [{ src: 'did:plc:moderation', val: 'spam' }], createdAt: '2026-10-23T00:00:00Z' },
    record: { text: 'https://x.y', reply: { parent: { uri: MY_POST } } },
  });
  assertEquals(decide(both, ctx()), { kind: 'skip', reason: 'labeled' });
  assertEquals(decide(both, ctx({}, { skipLabeled: false })), { kind: 'skip', reason: 'account_age' });
  assertEquals(decide(both, ctx({}, { skipLabeled: false, minAccountAgeDays: 0 })), { kind: 'skip', reason: 'links' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno test supabase/functions/_shared/auto-like/decide.test.ts`
Expected: FAIL — `Module not found "…/auto-like/decide.ts"`.

- [ ] **Step 3: Implement `decide.ts`**

```ts
// supabase/functions/_shared/auto-like/decide.ts
// Decides what auto-like should do with one reply notification. Pure: no
// clock reads (now is passed in), no network. The follower count is
// looked up by the caller, and only for replies that survive the cheaper
// rules, so `followersCount` may be undefined on the first call.

import type { BskyNotification, BskyProfileView, BskyReplyRecord } from '../adapters/bluesky.ts';

export type AutoLikeSettings = {
  minFollowers: number;
  minAccountAgeDays: number;
  skipLinks: boolean;
  skipNoAvatar: boolean;
  skipLabeled: boolean;
  dailyCap: number;
};

export type SkipReason =
  | 'blocked'
  | 'muted'
  | 'labeled'
  | 'account_age'
  | 'no_avatar'
  | 'links'
  | 'followers'
  | 'cap';

export type Decision =
  | { kind: 'ignore' } // not a direct reply to one of our posts, or our own reply
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'needs_followers' } // passed every lookup-free rule; caller must fetch the count
  | { kind: 'queue' };

export type DecideContext = {
  selfDid: string;
  settings: AutoLikeSettings;
  now: Date;
  followersCount?: number; // undefined = not looked up yet
};

const DAY_MS = 86_400_000;

// Conservative: an explicit scheme, or a bare host on a TLD people
// actually paste (example.com, example.com/x). "e.g." and "3.5" don't match.
const URL_RE =
  /https?:\/\/\S+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|app|me|ly|gg|xyz|info|biz|us|uk|ca|de|fr|es|it|nl|social|link|page|site|online|shop|club)(\/\S*)?\b/i;

export function isDirectReplyTo(n: BskyNotification, selfDid: string): boolean {
  if (n.reason !== 'reply') return false;
  const parent = n.record?.reply?.parent?.uri ?? n.reasonSubject;
  return typeof parent === 'string' && parent.startsWith(`at://${selfDid}/`);
}

// Only labels applied by someone other than the account itself count, so
// an adult-content self-label never trips this rule.
export function hasModerationLabel(author: BskyProfileView): boolean {
  return (author.labels ?? []).some((l) => l.src !== author.did && !l.neg);
}

export function containsLink(record: BskyReplyRecord | undefined): boolean {
  for (const f of record?.facets ?? []) {
    for (const feat of f.features ?? []) {
      if (feat.$type === 'app.bsky.richtext.facet#link') return true;
    }
  }
  const embedType = record?.embed?.$type ?? '';
  if (embedType.startsWith('app.bsky.embed.external')) return true;
  if (
    embedType.startsWith('app.bsky.embed.recordWithMedia') &&
    (record?.embed?.media?.$type ?? '').startsWith('app.bsky.embed.external')
  ) {
    return true;
  }
  return URL_RE.test(record?.text ?? '');
}

export function decide(n: BskyNotification, ctx: DecideContext): Decision {
  const a = n.author;
  if (!isDirectReplyTo(n, ctx.selfDid)) return { kind: 'ignore' };
  if (a.did === ctx.selfDid) return { kind: 'ignore' };

  // Fixed exclusions, never configurable.
  const v = a.viewer ?? {};
  if (v.blocking || v.blockedBy || v.blockingByList) return { kind: 'skip', reason: 'blocked' };
  if (v.muted || v.mutedByList) return { kind: 'skip', reason: 'muted' };

  // Adjustable rules, in order; the first failure is the recorded reason.
  const s = ctx.settings;
  if (s.skipLabeled && hasModerationLabel(a)) return { kind: 'skip', reason: 'labeled' };
  if (s.minAccountAgeDays > 0) {
    const created = a.createdAt ? Date.parse(a.createdAt) : NaN;
    if (Number.isNaN(created) || ctx.now.getTime() - created < s.minAccountAgeDays * DAY_MS) {
      return { kind: 'skip', reason: 'account_age' };
    }
  }
  if (s.skipNoAvatar && !a.avatar) return { kind: 'skip', reason: 'no_avatar' };
  if (s.skipLinks && containsLink(n.record)) return { kind: 'skip', reason: 'links' };
  if (s.minFollowers > 0) {
    if (ctx.followersCount === undefined) return { kind: 'needs_followers' };
    if (ctx.followersCount < s.minFollowers) return { kind: 'skip', reason: 'followers' };
  }
  return { kind: 'queue' };
}
```

- [ ] **Step 4: Run the tests**

Run: `deno test supabase/functions/_shared/auto-like/decide.test.ts`
Expected: `ok | 12 passed | 0 failed`.

- [ ] **Step 5: Full check and commit**

Run: `deno fmt supabase/functions && deno task check`
Expected: clean.

```bash
git add supabase/functions/_shared/auto-like/decide.ts supabase/functions/_shared/auto-like/decide.test.ts
git commit -m "feat(auto-like): pure decision rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Orchestration — scan pass and like pass

**Files:**
- Create: `supabase/functions/_shared/auto-like/run.ts`
- Test: `supabase/functions/_shared/auto-like/run.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/auto-like/run.test.ts
import { assertEquals } from '@std/assert';
import type { BlueskyAdapter, BskyNotification } from '../adapters/bluesky.ts';
import { PostError } from '../adapters/types.ts';
import { encryptJson, generateTokenKeyBase64, importTokenKey } from '../crypto.ts';
import type { AccountRow, BlueskyTokens, Platform } from '../types.ts';
import type { AutoLikeSettings, SkipReason } from './decide.ts';
import {
  type AutoLikeDb,
  type AutoLikeDeps,
  type AutoLikeUser,
  type EventInsert,
  MAX_DELAY_MS,
  MAX_LIKE_ATTEMPTS,
  MIN_DELAY_MS,
  type QueuedEvent,
  runAutoLikeForUser,
} from './run.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const ME = 'did:plc:me';
const MY_POST = `at://${ME}/app.bsky.feed.post/abc`;
const WATERMARK = '2026-10-24T11:00:00+00:00'; // Postgres-style, deliberately not ISO-Z

const settings: AutoLikeSettings = {
  minFollowers: 5,
  minAccountAgeDays: 7,
  skipLinks: true,
  skipNoAvatar: false,
  skipLabeled: true,
  dailyCap: 100,
};

type Row = EventInsert & { id: number; attempts: number; likedAt?: string; finalReason?: string };

class MemoryAutoLikeDb implements AutoLikeDb {
  rows: Row[] = [];
  watermarks: string[] = [];
  runs: Array<{ at: string; error: string | null }> = [];
  likedSince = 0;
  nextId = 1;

  listEnabledUsers() {
    return Promise.resolve([]);
  }
  insertEvents(events: EventInsert[]) {
    for (const e of events) {
      if (this.rows.some((r) => r.userId === e.userId && r.replyUri === e.replyUri)) continue;
      this.rows.push({ ...e, id: this.nextId++, attempts: 0 });
    }
    return Promise.resolve();
  }
  countLikedSince() {
    return Promise.resolve(this.likedSince);
  }
  countQueued(userId: string) {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId && r.decision === 'queued').length);
  }
  dueQueued(userId: string, nowIso: string, limit: number) {
    const due = this.rows
      .filter((r) => r.userId === userId && r.decision === 'queued' && r.dueAt !== null && r.dueAt <= nowIso)
      .slice(0, limit)
      .map((r): QueuedEvent => ({ id: r.id, replyUri: r.replyUri, replyCid: r.replyCid, attempts: r.attempts }));
    return Promise.resolve(due);
  }
  private row(id: number) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
  markLiked(id: number, likedAtIso: string) {
    const r = this.row(id);
    r.decision = 'liked' as Row['decision'];
    r.likedAt = likedAtIso;
    return Promise.resolve();
  }
  markSkipped(id: number, reason: SkipReason) {
    const r = this.row(id);
    r.decision = 'skipped';
    r.reason = reason;
    return Promise.resolve();
  }
  markFailed(id: number, reason: string) {
    const r = this.row(id);
    r.decision = 'failed' as Row['decision'];
    r.finalReason = reason;
    return Promise.resolve();
  }
  bumpAttempts(id: number) {
    this.row(id).attempts++;
    return Promise.resolve();
  }
  setWatermark(_u: string, iso: string) {
    this.watermarks.push(iso);
    return Promise.resolve();
  }
  setRunResult(_u: string, at: string, error: string | null) {
    this.runs.push({ at, error });
    return Promise.resolve();
  }
}

function notif(i: number, indexedAt: string, over: Partial<BskyNotification> = {}): BskyNotification {
  return {
    uri: `at://did:plc:them${i}/app.bsky.feed.post/r${i}`,
    cid: `cid${i}`,
    reason: 'reply',
    indexedAt,
    author: {
      did: `did:plc:them${i}`,
      handle: `them${i}.bsky.social`,
      avatar: 'https://cdn/a.jpg',
      createdAt: '2025-01-01T00:00:00.000Z',
      labels: [],
      viewer: {},
    },
    record: { text: 'nice', reply: { parent: { uri: MY_POST } } },
    ...over,
  };
}

type Page = { notifications: BskyNotification[]; cursor?: string };

function stubBluesky(opts: {
  pages?: Page[]; // served in order; the last page repeats
  followers?: Record<string, number>;
  like?: (uri: string) => Promise<unknown>;
  profilesError?: Error;
} = {}) {
  const log: string[] = [];
  const pages = opts.pages ?? [{ notifications: [] }];
  let pageIdx = 0;
  const adapter = {
    platform: 'bluesky' as Platform,
    characterLimit: 300,
    pacingMs: 1000,
    maxImages: 4,
    refreshIfNeeded: (tokens: BlueskyTokens) => Promise.resolve({ tokens, changed: false, expiresAt: null }),
    uploadImage: () => Promise.reject(new Error('not used')),
    post: () => Promise.reject(new Error('not used')),
    listNotifications: (_t: BlueskyTokens, o: { cursor?: string }) => {
      log.push(`list:${o.cursor ?? 'start'}`);
      const p = pages[Math.min(pageIdx, pages.length - 1)];
      pageIdx++;
      return Promise.resolve(p);
    },
    getProfiles: (_t: BlueskyTokens, dids: string[]) => {
      log.push(`profiles:${dids.length}`);
      if (opts.profilesError) return Promise.reject(opts.profilesError);
      const m = new Map<string, { followersCount: number }>();
      for (const d of dids) {
        const c = opts.followers?.[d];
        if (c !== undefined) m.set(d, { followersCount: c });
      }
      return Promise.resolve(m);
    },
    like: (_t: BlueskyTokens, s: { uri: string }) => {
      log.push(`like:${s.uri}`);
      return (opts.like ?? (() => Promise.resolve({ uri: 'at://like' })))(s.uri).then(() => ({ uri: 'at://like' }));
    },
  } as unknown as BlueskyAdapter;
  return { adapter, log };
}

async function setup(opts: Parameters<typeof stubBluesky>[0] & {
  dryRun?: boolean;
  random?: number;
  accountStatus?: 'ok' | 'needs_reconnect';
  settings?: Partial<AutoLikeSettings>;
} = {}) {
  const key = await importTokenKey(generateTokenKeyBase64());
  const tokens: BlueskyTokens = {
    identifier: 'me.bsky.social',
    appPassword: 'x',
    did: ME,
    handle: 'me.bsky.social',
    pdsUrl: 'https://pds.example',
    accessJwt: 'a',
    refreshJwt: 'r',
  };
  const account: AccountRow = {
    user_id: 'u1',
    platform: 'bluesky',
    handle: 'me.bsky.social',
    secret: await encryptJson(key, tokens),
    expires_at: null,
    status: opts.accountStatus ?? 'ok',
    updated_at: NOW.toISOString(),
  };
  const reconnects: string[] = [];
  const accounts = {
    getAccount: () => Promise.resolve(account),
    saveAccountSecret: () => Promise.resolve(),
    markAccountNeedsReconnect: (u: string) => {
      reconnects.push(u);
      return Promise.resolve();
    },
  };
  const db = new MemoryAutoLikeDb();
  const bluesky = stubBluesky(opts);
  const user: AutoLikeUser = { userId: 'u1', settings: { ...settings, ...opts.settings }, watermark: WATERMARK };
  const deps: AutoLikeDeps = {
    db,
    accounts,
    key,
    bluesky: bluesky.adapter,
    now: () => NOW,
    random: () => opts.random ?? 0.5,
    sleep: () => Promise.resolve(),
    dryRun: opts.dryRun ?? false,
  };
  return { db, deps, user, bluesky, reconnects };
}

Deno.test('queues a clean reply with a due time in the delay window and advances the watermark', async () => {
  const s = await setup({
    pages: [{ notifications: [notif(1, '2026-10-24T11:30:00.000Z')] }],
    followers: { 'did:plc:them1': 50 },
    random: 0,
  });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.scanned, 1);
  assertEquals(out.queued, 1);
  assertEquals(s.db.rows.length, 1);
  assertEquals(s.db.rows[0].decision, 'queued');
  assertEquals(s.db.rows[0].authorHandle, 'them1.bsky.social');
  assertEquals(s.db.rows[0].dueAt, new Date(NOW.getTime() + MIN_DELAY_MS).toISOString());
  assertEquals(s.db.watermarks, ['2026-10-24T11:30:00.000Z']);
  assertEquals(s.db.runs, [{ at: NOW.toISOString(), error: null }]);
});

Deno.test('random() = 1 lands at the top of the delay window', async () => {
  const s = await setup({
    pages: [{ notifications: [notif(1, '2026-10-24T11:30:00.000Z')] }],
    followers: { 'did:plc:them1': 50 },
    random: 0.999999,
  });
  await runAutoLikeForUser(s.user, s.deps);
  const due = Date.parse(s.db.rows[0].dueAt!);
  assertEquals(due > NOW.getTime() + MAX_DELAY_MS - 1000, true);
  assertEquals(due <= NOW.getTime() + MAX_DELAY_MS, true);
});

Deno.test('stops at the watermark: older notifications are neither considered nor paged past', async () => {
  const s = await setup({
    pages: [
      {
        notifications: [
          notif(1, '2026-10-24T11:30:00.000Z'),
          notif(2, '2026-10-24T11:00:00.000Z'), // equal to the watermark → old
          notif(3, '2026-10-24T10:00:00.000Z'),
        ],
        cursor: 'more',
      },
      { notifications: [notif(4, '2026-10-24T09:00:00.000Z')] },
    ],
    followers: { 'did:plc:them1': 50 },
  });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.scanned, 1);
  assertEquals(s.bluesky.log.filter((l) => l.startsWith('list:')), ['list:start']);
});

Deno.test('walks at most 5 pages when everything is new', async () => {
  const page = (i: number): Page => ({
    notifications: [notif(i, `2026-10-24T11:${String(59 - i).padStart(2, '0')}:00.000Z`)],
    cursor: `c${i}`,
  });
  const s = await setup({ pages: [page(1), page(2), page(3), page(4), page(5), page(6), page(7)], settings: { minFollowers: 0 } });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(s.bluesky.log.filter((l) => l.startsWith('list:')).length, 5);
  assertEquals(out.scanned, 5);
  // Watermark is the newest seen, not the last page's.
  assertEquals(s.db.watermarks, ['2026-10-24T11:58:00.000Z']);
});

Deno.test('follower lookup is batched and applied; a DID missing from the response counts as 0', async () => {
  const notifs = Array.from({ length: 30 }, (_, i) => notif(i + 1, '2026-10-24T11:30:00.000Z'));
  const followers: Record<string, number> = {};
  for (let i = 1; i <= 29; i++) followers[`did:plc:them${i}`] = i < 5 ? 1 : 10; // them30 missing
  const s = await setup({ pages: [{ notifications: notifs }], followers });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(s.bluesky.log.filter((l) => l.startsWith('profiles:')), ['profiles:25', 'profiles:5']);
  assertEquals(out.queued, 25); // them5..them29
  assertEquals(out.skipped, 5); // them1..4 (1 follower) + them30 (missing → 0)
  const skipped = s.db.rows.filter((r) => r.decision === 'skipped');
  assertEquals(skipped.every((r) => r.reason === 'followers'), true);
});

Deno.test('a failed follower lookup abandons the scan without advancing the watermark', async () => {
  const s = await setup({
    pages: [{ notifications: [notif(1, '2026-10-24T11:30:00.000Z')] }],
    profilesError: new PostError('getProfiles HTTP 502', 'transient'),
  });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.error, 'getProfiles HTTP 502');
  assertEquals(s.db.rows.length, 0);
  assertEquals(s.db.watermarks, []);
  assertEquals(s.db.runs, [{ at: NOW.toISOString(), error: 'getProfiles HTTP 502' }]);
});

Deno.test('skipped replies are recorded with their reason; non-candidates are not recorded', async () => {
  const s = await setup({
    pages: [{
      notifications: [
        notif(1, '2026-10-24T11:30:00.000Z', { reason: 'mention' }), // ignored
        notif(2, '2026-10-24T11:30:00.000Z', {
          author: { did: 'did:plc:them2', handle: 'them2', createdAt: '2026-10-23T00:00:00Z', viewer: {} },
        }), // too new
      ],
    }],
  });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.scanned, 2);
  assertEquals(out.skipped, 1);
  assertEquals(s.db.rows.map((r) => [r.authorHandle, r.decision, r.reason]), [['them2', 'skipped', 'account_age']]);
});

Deno.test('the daily cap counts recent likes plus queued, oldest replies win', async () => {
  const s = await setup({
    pages: [{
      notifications: [
        notif(1, '2026-10-24T11:40:00.000Z'),
        notif(2, '2026-10-24T11:20:00.000Z'), // older → queued first
      ],
    }],
    settings: { dailyCap: 10, minFollowers: 0 },
  });
  s.db.likedSince = 9; // 9 liked in the last 24 h → room for exactly one
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.queued, 1);
  assertEquals(out.skipped, 1);
  assertEquals(s.db.rows.find((r) => r.authorHandle === 'them2.bsky.social')?.decision, 'queued');
  assertEquals(s.db.rows.find((r) => r.authorHandle === 'them1.bsky.social')?.reason, 'cap');
});

Deno.test('like pass likes due events only, spaced by pacingMs', async () => {
  const s = await setup({ settings: { minFollowers: 0 } });
  await s.db.insertEvents([
    { userId: 'u1', replyUri: 'at://a', replyCid: 'ca', authorDid: 'd', authorHandle: 'a', decision: 'queued', reason: null, dueAt: '2026-10-24T11:59:00.000Z' },
    { userId: 'u1', replyUri: 'at://b', replyCid: 'cb', authorDid: 'd', authorHandle: 'b', decision: 'queued', reason: null, dueAt: '2026-10-24T12:01:00.000Z' },
  ]);
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.liked, 1);
  assertEquals(s.bluesky.log.filter((l) => l.startsWith('like:')), ['like:at://a']);
  assertEquals(s.db.rows[0].decision, 'liked');
  assertEquals(s.db.rows[0].likedAt, NOW.toISOString());
  assertEquals(s.db.rows[1].decision, 'queued');
});

Deno.test('like failures: permanent → failed http_NNN, transient → attempt bumped, fifth transient → gave_up', async () => {
  let mode: 'perm' | 'trans' = 'perm';
  const s = await setup({
    like: () =>
      Promise.reject(
        mode === 'perm'
          ? new PostError('like HTTP 400', 'permanent', { status: 400 })
          : new PostError('like HTTP 503', 'transient', { status: 503 }),
      ),
  });
  await s.db.insertEvents([
    { userId: 'u1', replyUri: 'at://a', replyCid: 'c', authorDid: 'd', authorHandle: 'a', decision: 'queued', reason: null, dueAt: '2026-10-24T11:00:00.000Z' },
    { userId: 'u1', replyUri: 'at://b', replyCid: 'c', authorDid: 'd', authorHandle: 'b', decision: 'queued', reason: null, dueAt: '2026-10-24T11:00:00.000Z' },
  ]);
  s.db.rows[1].attempts = MAX_LIKE_ATTEMPTS - 2; // b has two tries left
  let out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.failed, 2);
  assertEquals(s.db.rows[0].decision, 'failed');
  assertEquals(s.db.rows[0].finalReason, 'http_400');

  // Reset b to queued with 3 attempts, switch to transient: 4th attempt bumps, 5th gives up.
  s.db.rows[1].decision = 'queued';
  s.db.rows[1].attempts = MAX_LIKE_ATTEMPTS - 2;
  mode = 'trans';
  out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.failed, 0);
  assertEquals(s.db.rows[1].decision, 'queued');
  assertEquals(s.db.rows[1].attempts, MAX_LIKE_ATTEMPTS - 1);
  out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.failed, 1);
  assertEquals(s.db.rows[1].decision, 'failed');
  assertEquals(s.db.rows[1].finalReason, 'gave_up');
});

Deno.test('a 401 while liking marks the account for reconnect and records the error', async () => {
  const s = await setup({ like: () => Promise.reject(new PostError('like HTTP 401', 'reauth', { status: 401 })) });
  await s.db.insertEvents([
    { userId: 'u1', replyUri: 'at://a', replyCid: 'c', authorDid: 'd', authorHandle: 'a', decision: 'queued', reason: null, dueAt: '2026-10-24T11:00:00.000Z' },
  ]);
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(s.reconnects, ['u1']);
  assertEquals(out.error, 'Bluesky session expired; reconnect in Accounts');
  assertEquals(s.db.rows[0].decision, 'queued'); // left for after reconnect
  assertEquals(s.db.runs[0].error, 'Bluesky session expired; reconnect in Accounts');
});

Deno.test('an account needing reconnect is reported, nothing scanned', async () => {
  const s = await setup({ accountStatus: 'needs_reconnect', pages: [{ notifications: [notif(1, '2026-10-24T11:30:00.000Z')] }] });
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.error, 'bluesky account needs to be reconnected');
  assertEquals(s.bluesky.log, []);
});

Deno.test('dry run writes nothing, likes nothing, and returns the decisions', async () => {
  const s = await setup({
    dryRun: true,
    pages: [{
      notifications: [
        notif(1, '2026-10-24T11:30:00.000Z'),
        notif(2, '2026-10-24T11:30:00.000Z', { record: { text: 'https://spam.example', reply: { parent: { uri: MY_POST } } } }),
      ],
    }],
    followers: { 'did:plc:them1': 50 },
  });
  await s.db.insertEvents([
    { userId: 'u1', replyUri: 'at://due', replyCid: 'c', authorDid: 'd', authorHandle: 'due', decision: 'queued', reason: null, dueAt: '2026-10-24T11:00:00.000Z' },
  ]);
  const out = await runAutoLikeForUser(s.user, s.deps);
  assertEquals(out.dry, [
    { handle: 'them1.bsky.social', uri: 'at://did:plc:them1/app.bsky.feed.post/r1', outcome: 'queue', reason: null },
    { handle: 'them2.bsky.social', uri: 'at://did:plc:them2/app.bsky.feed.post/r2', outcome: 'skip', reason: 'links' },
  ]);
  assertEquals(s.db.rows.length, 1); // only the pre-existing row
  assertEquals(s.db.rows[0].decision, 'queued'); // not liked
  assertEquals(s.db.watermarks, []);
  assertEquals(s.db.runs, []);
  assertEquals(s.bluesky.log.some((l) => l.startsWith('like:')), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno test supabase/functions/_shared/auto-like/run.test.ts`
Expected: FAIL — `Module not found "…/auto-like/run.ts"`.

- [ ] **Step 3: Implement `run.ts`**

```ts
// supabase/functions/_shared/auto-like/run.ts
// One user's auto-like tick: a scan pass that turns new reply
// notifications into queued/skipped ledger rows, then a like pass over
// rows whose random delay has elapsed. Pure of Supabase: everything comes
// through AutoLikeDeps, mirroring job.ts.

import type { BlueskyAdapter, BskyNotification } from '../adapters/bluesky.ts';
import { toPostError } from '../adapters/types.ts';
import type { JobDb } from '../job.ts';
import type { Sleep } from '../post-chain.ts';
import { freshTokens } from '../tokens.ts';
import type { BlueskyTokens } from '../types.ts';
import { type AutoLikeSettings, decide, type SkipReason } from './decide.ts';

export const MAX_PAGES = 5; // × PAGE_SIZE bounds one tick; older replies after a spike are dropped
export const PAGE_SIZE = 50;
export const LIKE_BATCH = 20;
export const MAX_LIKE_ATTEMPTS = 5;
export const MIN_DELAY_MS = 2 * 60_000;
export const MAX_DELAY_MS = 30 * 60_000;
const PROFILES_PER_CALL = 25;
const DAY_MS = 86_400_000;
export const REAUTH_MESSAGE = 'Bluesky session expired; reconnect in Accounts';

export type AutoLikeUser = { userId: string; settings: AutoLikeSettings; watermark: string };

export type EventInsert = {
  userId: string;
  replyUri: string;
  replyCid: string;
  authorDid: string;
  authorHandle: string;
  decision: 'queued' | 'skipped';
  reason: SkipReason | null;
  dueAt: string | null;
};

export type QueuedEvent = { id: number; replyUri: string; replyCid: string; attempts: number };

export interface AutoLikeDb {
  listEnabledUsers(): Promise<AutoLikeUser[]>;
  insertEvents(events: EventInsert[]): Promise<void>; // on conflict (user_id, reply_uri) do nothing
  countLikedSince(userId: string, sinceIso: string): Promise<number>;
  countQueued(userId: string): Promise<number>;
  dueQueued(userId: string, nowIso: string, limit: number): Promise<QueuedEvent[]>;
  markLiked(id: number, likedAtIso: string): Promise<void>;
  markSkipped(id: number, reason: SkipReason): Promise<void>;
  markFailed(id: number, reason: string): Promise<void>;
  bumpAttempts(id: number): Promise<void>;
  setWatermark(userId: string, iso: string): Promise<void>;
  setRunResult(userId: string, lastRunAtIso: string, lastError: string | null): Promise<void>;
}

export type AutoLikeDeps = {
  db: AutoLikeDb;
  accounts: Pick<JobDb, 'getAccount' | 'saveAccountSecret' | 'markAccountNeedsReconnect'>;
  key: CryptoKey;
  bluesky: BlueskyAdapter;
  now: () => Date;
  random: () => number; // [0, 1)
  sleep: Sleep;
  dryRun: boolean;
};

export type DryDecision = {
  handle: string;
  uri: string;
  outcome: 'queue' | 'skip';
  reason: SkipReason | null;
};

export type UserSummary = {
  user_id: string;
  scanned: number;
  queued: number;
  skipped: number;
  liked: number;
  failed: number;
  error?: string;
  dry?: DryDecision[];
};

export async function runAutoLikeForUser(
  user: AutoLikeUser,
  deps: AutoLikeDeps,
): Promise<UserSummary> {
  const summary: UserSummary = {
    user_id: user.userId,
    scanned: 0,
    queued: 0,
    skipped: 0,
    liked: 0,
    failed: 0,
  };
  const now = deps.now();
  try {
    const tokens = await freshTokens<BlueskyTokens>(
      user.userId,
      'bluesky',
      deps.bluesky,
      deps.accounts,
      deps.key,
      now.getTime(),
    );
    await scan(user, tokens, deps, summary);
    if (!deps.dryRun) {
      await likeDue(user, tokens, deps, summary);
      await deps.db.setRunResult(user.userId, now.toISOString(), null);
    }
  } catch (err) {
    const pe = toPostError(err);
    if (pe.kind === 'reauth') {
      await deps.accounts.markAccountNeedsReconnect(user.userId, 'bluesky');
      summary.error = REAUTH_MESSAGE;
    } else {
      summary.error = pe.message.slice(0, 200);
    }
    if (!deps.dryRun) await deps.db.setRunResult(user.userId, now.toISOString(), summary.error);
  }
  return summary;
}

// Newest-first pages; stop at the first notification at or before the
// watermark, at the end, or after MAX_PAGES.
async function fetchNew(
  user: AutoLikeUser,
  tokens: BlueskyTokens,
  deps: AutoLikeDeps,
): Promise<{ fresh: BskyNotification[]; newest: string | null }> {
  const watermarkMs = Date.parse(user.watermark);
  const fresh: BskyNotification[] = [];
  let newest: string | null = null;
  let newestMs = -Infinity;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = await deps.bluesky.listNotifications(tokens, {
      reasons: ['reply'],
      cursor,
      limit: PAGE_SIZE,
    });
    let reachedOld = false;
    for (const n of out.notifications) {
      const t = Date.parse(n.indexedAt);
      if (!(t > watermarkMs)) {
        reachedOld = true;
        break;
      }
      if (t > newestMs) {
        newestMs = t;
        newest = n.indexedAt;
      }
      fresh.push(n);
    }
    if (reachedOld || !out.cursor || out.notifications.length === 0) break;
    cursor = out.cursor;
  }
  return { fresh, newest };
}

type Decided = { n: BskyNotification; outcome: 'queue' | 'skip'; reason: SkipReason | null };

async function scan(
  user: AutoLikeUser,
  tokens: BlueskyTokens,
  deps: AutoLikeDeps,
  summary: UserSummary,
): Promise<void> {
  const { fresh, newest } = await fetchNew(user, tokens, deps);
  summary.scanned = fresh.length;
  const now = deps.now();
  const ctx = { selfDid: tokens.did, settings: user.settings, now };

  // First pass: every rule that needs no lookup.
  const needFollowers: BskyNotification[] = [];
  const decided: Decided[] = [];
  for (const n of fresh) {
    const d = decide(n, ctx);
    if (d.kind === 'ignore') continue;
    if (d.kind === 'needs_followers') needFollowers.push(n);
    else if (d.kind === 'skip') decided.push({ n, outcome: 'skip', reason: d.reason });
    else decided.push({ n, outcome: 'queue', reason: null });
  }

  // Second pass: one batched profile lookup for the survivors. A DID the
  // AppView does not return (deactivated account) counts as 0 followers.
  if (needFollowers.length > 0) {
    const dids = [...new Set(needFollowers.map((n) => n.author.did))];
    const counts = new Map<string, { followersCount: number }>();
    for (let i = 0; i < dids.length; i += PROFILES_PER_CALL) {
      const chunk = await deps.bluesky.getProfiles(tokens, dids.slice(i, i + PROFILES_PER_CALL));
      for (const [did, c] of chunk) counts.set(did, c);
    }
    for (const n of needFollowers) {
      const followersCount = counts.get(n.author.did)?.followersCount ?? 0;
      const d = decide(n, { ...ctx, followersCount });
      if (d.kind === 'skip') decided.push({ n, outcome: 'skip', reason: d.reason });
      else if (d.kind === 'queue') decided.push({ n, outcome: 'queue', reason: null });
    }
  }

  // Daily cap: likes in the last 24 h plus what is already waiting.
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const used = (await deps.db.countLikedSince(user.userId, since)) +
    (await deps.db.countQueued(user.userId));
  let remaining = Math.max(0, user.settings.dailyCap - used);

  // Oldest first so the cap favours earlier replies.
  decided.sort((a, b) => Date.parse(a.n.indexedAt) - Date.parse(b.n.indexedAt));

  const inserts: EventInsert[] = [];
  const dry: DryDecision[] = [];
  for (const d of decided) {
    let outcome = d.outcome;
    let reason = d.reason;
    if (outcome === 'queue') {
      if (remaining <= 0) {
        outcome = 'skip';
        reason = 'cap';
      } else {
        remaining--;
      }
    }
    if (deps.dryRun) {
      dry.push({ handle: d.n.author.handle, uri: d.n.uri, outcome, reason });
      continue;
    }
    const dueAt = outcome === 'queue'
      ? new Date(now.getTime() + MIN_DELAY_MS + deps.random() * (MAX_DELAY_MS - MIN_DELAY_MS))
        .toISOString()
      : null;
    inserts.push({
      userId: user.userId,
      replyUri: d.n.uri,
      replyCid: d.n.cid,
      authorDid: d.n.author.did,
      authorHandle: d.n.author.handle,
      decision: outcome === 'queue' ? 'queued' : 'skipped',
      reason,
      dueAt,
    });
    if (outcome === 'queue') summary.queued++;
    else summary.skipped++;
  }

  if (deps.dryRun) {
    summary.dry = dry;
    return;
  }
  if (inserts.length > 0) await deps.db.insertEvents(inserts);
  if (newest) await deps.db.setWatermark(user.userId, newest);
}

async function likeDue(
  user: AutoLikeUser,
  tokens: BlueskyTokens,
  deps: AutoLikeDeps,
  summary: UserSummary,
): Promise<void> {
  const now = deps.now();
  const due = await deps.db.dueQueued(user.userId, now.toISOString(), LIKE_BATCH);
  if (due.length === 0) return;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  let likedRecently = await deps.db.countLikedSince(user.userId, since);

  for (const [i, ev] of due.entries()) {
    if (likedRecently >= user.settings.dailyCap) {
      await deps.db.markSkipped(ev.id, 'cap');
      summary.skipped++;
      continue;
    }
    if (i > 0) await deps.sleep(deps.bluesky.pacingMs);
    try {
      await deps.bluesky.like(tokens, { uri: ev.replyUri, cid: ev.replyCid });
      await deps.db.markLiked(ev.id, deps.now().toISOString());
      likedRecently++;
      summary.liked++;
    } catch (err) {
      const pe = toPostError(err);
      if (pe.kind === 'reauth') throw pe;
      if (pe.kind === 'permanent') {
        await deps.db.markFailed(ev.id, pe.info.status ? `http_${pe.info.status}` : 'rejected');
        summary.failed++;
        continue;
      }
      if (ev.attempts + 1 >= MAX_LIKE_ATTEMPTS) {
        await deps.db.markFailed(ev.id, 'gave_up');
        summary.failed++;
      } else {
        await deps.db.bumpAttempts(ev.id);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `deno test supabase/functions/_shared/auto-like/run.test.ts`
Expected: `ok | 13 passed | 0 failed`. If the `an account needing reconnect` test fails on message casing, match the message `freshTokens` throws (`bluesky account needs to be reconnected`) exactly.

- [ ] **Step 5: Full check and commit**

Run: `deno fmt supabase/functions && deno task check`
Expected: clean, `ok | 150 passed | 0 failed`.

```bash
git add supabase/functions/_shared/auto-like/run.ts supabase/functions/_shared/auto-like/run.test.ts
git commit -m "feat(auto-like): scan and like passes over an injected db

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Supabase `AutoLikeDb` and the `auto-like` Edge Function

No unit tests here (thin glue over supabase-js); `deno task check` type-checks it and Task 12 runs it live.

**Files:**
- Create: `supabase/functions/_shared/auto-like/db.ts`
- Create: `supabase/functions/auto-like/index.ts`

- [ ] **Step 1: Write `db.ts`**

```ts
// supabase/functions/_shared/auto-like/db.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SkipReason } from './decide.ts';
import type { AutoLikeDb, AutoLikeUser, EventInsert, QueuedEvent } from './run.ts';

type SettingsRow = {
  user_id: string;
  auto_like_min_followers: number;
  auto_like_min_account_age_days: number;
  auto_like_skip_links: boolean;
  auto_like_skip_no_avatar: boolean;
  auto_like_skip_labeled: boolean;
  auto_like_daily_cap: number;
};

export function makeAutoLikeDb(supabase: SupabaseClient): AutoLikeDb {
  return {
    // Three queries rather than a join: settings, auto_like_state and
    // accounts all key on auth.users, not on each other, so PostgREST
    // cannot embed them.
    async listEnabledUsers() {
      const { data: settings, error } = await supabase
        .from('settings')
        .select(
          'user_id, auto_like_min_followers, auto_like_min_account_age_days, auto_like_skip_links, auto_like_skip_no_avatar, auto_like_skip_labeled, auto_like_daily_cap',
        )
        .eq('auto_like_enabled', true);
      if (error) throw error;
      const rows = (settings ?? []) as SettingsRow[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.user_id);

      const [{ data: states, error: e1 }, { data: accounts, error: e2 }] = await Promise.all([
        supabase.from('auto_like_state').select('user_id, watermark').in('user_id', ids),
        supabase.from('accounts').select('user_id').eq('platform', 'bluesky').eq('status', 'ok').in(
          'user_id',
          ids,
        ),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const watermark = new Map(
        ((states ?? []) as Array<{ user_id: string; watermark: string }>).map((
          s,
        ) => [s.user_id, s.watermark]),
      );
      const healthy = new Set(((accounts ?? []) as Array<{ user_id: string }>).map((a) => a.user_id));

      const users: AutoLikeUser[] = [];
      for (const r of rows) {
        const wm = watermark.get(r.user_id);
        if (!wm || !healthy.has(r.user_id)) continue; // never enabled properly, or needs reconnect
        users.push({
          userId: r.user_id,
          watermark: wm,
          settings: {
            minFollowers: r.auto_like_min_followers,
            minAccountAgeDays: r.auto_like_min_account_age_days,
            skipLinks: r.auto_like_skip_links,
            skipNoAvatar: r.auto_like_skip_no_avatar,
            skipLabeled: r.auto_like_skip_labeled,
            dailyCap: r.auto_like_daily_cap,
          },
        });
      }
      return users;
    },

    async insertEvents(events: EventInsert[]) {
      const { error } = await supabase.from('auto_like_events').upsert(
        events.map((e) => ({
          user_id: e.userId,
          reply_uri: e.replyUri,
          reply_cid: e.replyCid,
          author_did: e.authorDid,
          author_handle: e.authorHandle,
          decision: e.decision,
          reason: e.reason,
          due_at: e.dueAt,
        })),
        { onConflict: 'user_id,reply_uri', ignoreDuplicates: true },
      );
      if (error) throw error;
    },

    async countLikedSince(userId, sinceIso) {
      const { count, error } = await supabase
        .from('auto_like_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('decision', 'liked')
        .gte('liked_at', sinceIso);
      if (error) throw error;
      return count ?? 0;
    },

    async countQueued(userId) {
      const { count, error } = await supabase
        .from('auto_like_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('decision', 'queued');
      if (error) throw error;
      return count ?? 0;
    },

    async dueQueued(userId, nowIso, limit) {
      const { data, error } = await supabase
        .from('auto_like_events')
        .select('id, reply_uri, reply_cid, attempts')
        .eq('user_id', userId)
        .eq('decision', 'queued')
        .lte('due_at', nowIso)
        .order('due_at', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as Array<
        { id: number; reply_uri: string; reply_cid: string; attempts: number }
      >).map((r): QueuedEvent => ({
        id: r.id,
        replyUri: r.reply_uri,
        replyCid: r.reply_cid,
        attempts: r.attempts,
      }));
    },

    async markLiked(id, likedAtIso) {
      const { error } = await supabase
        .from('auto_like_events')
        .update({ decision: 'liked', liked_at: likedAtIso })
        .eq('id', id);
      if (error) throw error;
    },

    async markSkipped(id, reason: SkipReason) {
      const { error } = await supabase
        .from('auto_like_events')
        .update({ decision: 'skipped', reason })
        .eq('id', id);
      if (error) throw error;
    },

    async markFailed(id, reason) {
      const { error } = await supabase
        .from('auto_like_events')
        .update({ decision: 'failed', reason })
        .eq('id', id);
      if (error) throw error;
    },

    async bumpAttempts(id) {
      // Read-modify-write is fine: one function instance per minute owns a user's rows.
      const { data, error } = await supabase
        .from('auto_like_events')
        .select('attempts')
        .eq('id', id)
        .single();
      if (error) throw error;
      const { error: e2 } = await supabase
        .from('auto_like_events')
        .update({ attempts: ((data as { attempts: number }).attempts ?? 0) + 1 })
        .eq('id', id);
      if (e2) throw e2;
    },

    async setWatermark(userId, iso) {
      const { error } = await supabase
        .from('auto_like_state')
        .update({ watermark: iso })
        .eq('user_id', userId);
      if (error) throw error;
    },

    async setRunResult(userId, lastRunAtIso, lastError) {
      const { error } = await supabase
        .from('auto_like_state')
        .update({ last_run_at: lastRunAtIso, last_error: lastError })
        .eq('user_id', userId);
      if (error) throw error;
    },
  };
}
```

- [ ] **Step 2: Write the entrypoint**

```ts
// supabase/functions/auto-like/index.ts
// Called every minute by pg_cron (see migrations/..._auto_like_cron.sql).
// For each user with auto-like on and a healthy Bluesky account: scan new
// reply notifications, queue the ones that pass the rules, like the ones
// whose delay has elapsed. Authenticated by the shared CRON_SECRET header.
//
// ?dry_run=1            scan only; return decisions, write nothing, like nothing
// ?dry_run=1&lookback=N also look back N minutes before the watermark (dry only)

import { createClient } from '@supabase/supabase-js';
import { createBlueskyAdapter } from '../_shared/adapters/bluesky.ts';
import { makeAutoLikeDb } from '../_shared/auto-like/db.ts';
import { type AutoLikeDeps, runAutoLikeForUser, type UserSummary } from '../_shared/auto-like/run.ts';
import { importTokenKey } from '../_shared/crypto.ts';
import { makeJobDb } from '../_shared/db.ts';
import { env, jsonResponse, serviceKey } from '../_shared/http.ts';
import { realSleep } from '../_shared/post-chain.ts';

const DEADLINE_MS = 45_000; // headroom under the 55 s pg_net timeout

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (req.headers.get('x-cron-secret') !== env('CRON_SECRET')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const lookbackMin = dryRun ? Number(url.searchParams.get('lookback') ?? '0') : 0;

  const supabase = createClient(env('SUPABASE_URL'), serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const deps: AutoLikeDeps = {
    db: makeAutoLikeDb(supabase),
    accounts: makeJobDb(supabase),
    key: await importTokenKey(env('TOKEN_KEY')),
    bluesky: createBlueskyAdapter(fetch),
    now: () => new Date(),
    random: Math.random,
    sleep: realSleep,
    dryRun,
  };

  let users;
  try {
    users = await deps.db.listEnabledUsers();
  } catch (err) {
    return jsonResponse({ error: String(err).slice(0, 200) }, 500);
  }

  const summary: UserSummary[] = [];
  const started = Date.now();
  for (const [i, user] of users.entries()) {
    if (Date.now() - started > DEADLINE_MS) {
      // Watermarks only move for users that finished, so the rest simply
      // run next minute.
      for (const u of users.slice(i)) {
        summary.push({ user_id: u.userId, scanned: 0, queued: 0, skipped: 0, liked: 0, failed: 0, error: 'skipped: out of time' });
      }
      break;
    }
    if (lookbackMin > 0 && Number.isFinite(lookbackMin)) {
      user.watermark = new Date(Date.parse(user.watermark) - lookbackMin * 60_000).toISOString();
    }
    try {
      summary.push(await runAutoLikeForUser(user, deps));
    } catch (err) {
      // runAutoLikeForUser catches adapter errors itself; this is a DB
      // failure. Report it and carry on with the next user.
      console.error('auto-like crashed', user.userId, err);
      summary.push({
        user_id: user.userId,
        scanned: 0,
        queued: 0,
        skipped: 0,
        liked: 0,
        failed: 0,
        error: `crashed: ${String(err).slice(0, 200)}`,
      });
    }
  }
  return jsonResponse({ users: users.length, dry_run: dryRun, summary });
});
```

- [ ] **Step 3: Type-check and lint**

Run: `deno fmt supabase/functions && deno task check`
Expected: clean (`Check supabase/functions/auto-like/index.ts` appears in the output), `ok | 150 passed | 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/auto-like/db.ts supabase/functions/auto-like/index.ts
git commit -m "feat(auto-like): Supabase db and cron entrypoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Purge old ledger rows from the nightly cleanup

**Files:**
- Modify: `supabase/functions/cleanup-media/index.ts`

- [ ] **Step 1: Add the purge before the final response**

Replace the last two lines of the handler

```ts
  const status = errors.length > 0 ? 500 : 200;
  return jsonResponse({ users: userIds.length, removed, marked, errors }, status);
```

with

```ts
  // Auto-like ledger: keep 30 days of decisions for the Accounts card.
  // Queued rows are never purged (they are liked or failed long before).
  let eventsPurged = 0;
  {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('auto_like_events')
      .delete()
      .lt('created_at', cutoff)
      .neq('decision', 'queued')
      .select('id');
    if (error) errors.push(`auto_like_events purge failed: ${error.message}`);
    else eventsPurged = data?.length ?? 0;
  }

  const status = errors.length > 0 ? 500 : 200;
  return jsonResponse(
    { users: userIds.length, removed, marked, events_purged: eventsPurged, errors },
    status,
  );
```

- [ ] **Step 2: Check and commit**

Run: `deno fmt supabase/functions && deno task check`
Expected: clean.

```bash
git add supabase/functions/cleanup-media/index.ts
git commit -m "feat(cleanup): purge auto-like events older than 30 days

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Dry-run script

**Files:**
- Create: `scripts/autolike-dry.ts`
- Modify: `deno.json` (tasks)

- [ ] **Step 1: Write the script**

```ts
// scripts/autolike-dry.ts
// Calls the deployed auto-like function in dry-run mode and prints what it
// would do for every enabled user. Nothing is liked or recorded.
// Run: deno task autolike-dry [-- --lookback 60]
import { parseArgs } from '@std/cli';

function need(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing ${k} in .env.smoke`);
  return v;
}

const argv = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
const args = parseArgs(argv, { string: ['lookback'] });
const lookback = args.lookback ? `&lookback=${encodeURIComponent(args.lookback)}` : '';

const res = await fetch(`${need('SUPABASE_URL')}/functions/v1/auto-like?dry_run=1${lookback}`, {
  method: 'POST',
  headers: { 'x-cron-secret': need('CRON_SECRET'), 'content-type': 'application/json' },
  body: '{}',
});
const body = await res.json();
console.log('auto-like dry run', res.status);
for (const u of body.summary ?? []) {
  console.log(`user ${u.user_id}: scanned ${u.scanned}${u.error ? ` error: ${u.error}` : ''}`);
  for (const d of u.dry ?? []) {
    console.log(`  ${d.outcome === 'queue' ? 'LIKE ' : 'skip '} @${d.handle}${d.reason ? ` (${d.reason})` : ''}  ${d.uri}`);
  }
}
if (!res.ok) Deno.exit(1);
```

- [ ] **Step 2: Add the task** — in `deno.json` `tasks`, after `"gen-vapid"`:

```json
    "autolike-dry": "deno run --allow-net --allow-env --env-file=.env.smoke scripts/autolike-dry.ts"
```

(Add the comma after the `gen-vapid` line.)

- [ ] **Step 3: Type-check and commit**

Run: `deno fmt scripts && deno check scripts/autolike-dry.ts`
Expected: `Check scripts/autolike-dry.ts` with no errors. (The live run happens in Task 12, after deploy.)

```bash
git add scripts/autolike-dry.ts deno.json
git commit -m "chore(scripts): auto-like dry-run task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: PWA data helpers

**Files:**
- Create: `app/src/lib/autolike.ts`
- Test: `app/src/lib/autolike.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/lib/autolike.test.ts
import { describe, expect, it } from 'vitest';
import { clampSetting, describeEvent } from './autolike';

describe('describeEvent', () => {
  it('maps decisions and reason codes to the card text', () => {
    expect(describeEvent({ decision: 'liked', reason: null })).toBe('liked');
    expect(describeEvent({ decision: 'queued', reason: null })).toBe('queued');
    expect(describeEvent({ decision: 'skipped', reason: 'links' })).toBe('skipped — contains a link');
    expect(describeEvent({ decision: 'skipped', reason: 'followers' })).toBe('skipped — too few followers');
    expect(describeEvent({ decision: 'skipped', reason: 'account_age' })).toBe('skipped — account too new');
    expect(describeEvent({ decision: 'skipped', reason: 'no_avatar' })).toBe('skipped — no profile photo');
    expect(describeEvent({ decision: 'skipped', reason: 'labeled' })).toBe('skipped — moderation label');
    expect(describeEvent({ decision: 'skipped', reason: 'cap' })).toBe('skipped — daily limit reached');
    expect(describeEvent({ decision: 'skipped', reason: 'blocked' })).toBe('skipped — blocked');
    expect(describeEvent({ decision: 'skipped', reason: 'muted' })).toBe('skipped — muted');
    expect(describeEvent({ decision: 'skipped', reason: 'something_new' })).toBe('skipped — something_new');
    expect(describeEvent({ decision: 'failed', reason: 'http_400' })).toBe('failed — rejected by Bluesky');
    expect(describeEvent({ decision: 'failed', reason: 'gave_up' })).toBe('failed — Bluesky kept erroring');
    expect(describeEvent({ decision: 'failed', reason: null })).toBe('failed — error');
  });
});

describe('clampSetting', () => {
  it('parses, floors and clamps to the database ranges', () => {
    expect(clampSetting('auto_like_min_followers', '12.7', 5)).toBe(12);
    expect(clampSetting('auto_like_min_followers', '-3', 5)).toBe(0);
    expect(clampSetting('auto_like_min_followers', 'abc', 5)).toBe(5);
    expect(clampSetting('auto_like_min_followers', '', 5)).toBe(5);
    expect(clampSetting('auto_like_daily_cap', '0', 100)).toBe(1);
    expect(clampSetting('auto_like_daily_cap', '5000', 100)).toBe(1000);
    expect(clampSetting('auto_like_min_account_age_days', '99999', 7)).toBe(3650);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from `app/`): `npm test`
Expected: FAIL — cannot resolve `./autolike`.

- [ ] **Step 3: Implement `autolike.ts`**

```ts
// app/src/lib/autolike.ts
import { supabase } from './supabase';

export type AutoLikeSettings = {
  auto_like_enabled: boolean;
  auto_like_min_followers: number;
  auto_like_min_account_age_days: number;
  auto_like_skip_links: boolean;
  auto_like_skip_no_avatar: boolean;
  auto_like_skip_labeled: boolean;
  auto_like_daily_cap: number;
};

// Mirrors the column defaults in 20261024000010_auto_like.sql.
export const AUTO_LIKE_DEFAULTS: AutoLikeSettings = {
  auto_like_enabled: false,
  auto_like_min_followers: 5,
  auto_like_min_account_age_days: 7,
  auto_like_skip_links: true,
  auto_like_skip_no_avatar: false,
  auto_like_skip_labeled: true,
  auto_like_daily_cap: 100,
};

export type AutoLikeEvent = {
  id: number;
  author_handle: string;
  decision: 'queued' | 'liked' | 'skipped' | 'failed';
  reason: string | null;
  created_at: string;
  liked_at: string | null;
};

export type AutoLikeState = { last_run_at: string | null; last_error: string | null };

export type AutoLikeView = {
  settings: AutoLikeSettings;
  state: AutoLikeState | null;
  events: AutoLikeEvent[];
  likedToday: number;
  likedWeek: number;
};

const SETTINGS_COLS =
  'auto_like_enabled, auto_like_min_followers, auto_like_min_account_age_days, auto_like_skip_links, auto_like_skip_no_avatar, auto_like_skip_labeled, auto_like_daily_cap';

export async function loadAutoLike(): Promise<AutoLikeView> {
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const [s, st, ev, day, week] = await Promise.all([
    supabase.from('settings').select(SETTINGS_COLS).maybeSingle(),
    supabase.from('auto_like_state').select('last_run_at, last_error').maybeSingle(),
    supabase
      .from('auto_like_events')
      .select('id, author_handle, decision, reason, created_at, liked_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('auto_like_events').select('id', { count: 'exact', head: true }).eq('decision', 'liked').gte('liked_at', dayAgo),
    supabase.from('auto_like_events').select('id', { count: 'exact', head: true }).eq('decision', 'liked').gte('liked_at', weekAgo),
  ]);
  for (const r of [s, st, ev, day, week]) if (r.error) throw r.error;
  return {
    settings: (s.data as AutoLikeSettings | null) ?? AUTO_LIKE_DEFAULTS,
    state: (st.data as AutoLikeState | null) ?? null,
    events: (ev.data ?? []) as AutoLikeEvent[],
    likedToday: day.count ?? 0,
    likedWeek: week.count ?? 0,
  };
}

// Switch-on goes through the RPC so the watermark resets atomically with the flag.
export async function enableAutoLike(): Promise<void> {
  const { error } = await supabase.rpc('auto_like_enable');
  if (error) throw error;
}

export async function saveAutoLike(patch: Partial<AutoLikeSettings>): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('not signed in');
  const { error } = await supabase.from('settings').upsert({ user_id: user.id, ...patch });
  if (error) throw error;
}

export const REASON_TEXT: Record<string, string> = {
  labeled: 'moderation label',
  account_age: 'account too new',
  no_avatar: 'no profile photo',
  links: 'contains a link',
  followers: 'too few followers',
  cap: 'daily limit reached',
  blocked: 'blocked',
  muted: 'muted',
  gave_up: 'Bluesky kept erroring',
};

export function describeEvent(e: Pick<AutoLikeEvent, 'decision' | 'reason'>): string {
  switch (e.decision) {
    case 'liked':
      return 'liked';
    case 'queued':
      return 'queued';
    case 'skipped':
      return `skipped — ${REASON_TEXT[e.reason ?? ''] ?? e.reason ?? 'filtered'}`;
    case 'failed': {
      const text = e.reason?.startsWith('http_') ? 'rejected by Bluesky' : REASON_TEXT[e.reason ?? ''];
      return `failed — ${text ?? 'error'}`;
    }
  }
}

// Number fields are clamped to the DB check constraints so a typo never
// produces a 400 from PostgREST.
export const LIMITS = {
  auto_like_min_followers: [0, 1_000_000],
  auto_like_min_account_age_days: [0, 3650],
  auto_like_daily_cap: [1, 1000],
} as const;
export type NumberKey = keyof typeof LIMITS;
export type BoolKey = 'auto_like_skip_links' | 'auto_like_skip_no_avatar' | 'auto_like_skip_labeled';

export function clampSetting(key: NumberKey, raw: string, fallback: number): number {
  if (raw.trim() === '') return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  const [lo, hi] = LIMITS[key];
  return Math.min(hi, Math.max(lo, n));
}
```

- [ ] **Step 4: Run the tests**

Run (from `app/`): `npm test`
Expected: `Test Files 6 passed`, `Tests 9 passed`.

- [ ] **Step 5: Lint and commit**

Run (from `app/`): `npm run lint`
Expected: no warnings.

```bash
git add app/src/lib/autolike.ts app/src/lib/autolike.test.ts
git commit -m "feat(app): auto-like data helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `AutoLikeCard` and mounting it on the Accounts tab

**Files:**
- Create: `app/src/components/AutoLikeCard.tsx`
- Modify: `app/src/screens/Accounts.tsx`

- [ ] **Step 1: Write the card**

```tsx
// app/src/components/AutoLikeCard.tsx
import { useEffect, useState } from 'react';
import {
  type AutoLikeView,
  type BoolKey,
  clampSetting,
  describeEvent,
  enableAutoLike,
  loadAutoLike,
  type NumberKey,
  saveAutoLike,
} from '../lib/autolike';
import { relative } from '../lib/time';
import { Card, Input, Notice } from '../ui';

const TITLE = 'Auto-like replies';

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`relative w-11 h-[26px] rounded-full shrink-0 ${on ? 'bg-select' : 'bg-surface-2'}`}
      >
        <span
          className="absolute top-[3px] left-[3px] w-5 h-5 bg-white rounded-full transition-transform"
          style={{ transform: on ? 'translateX(18px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}

export function AutoLikeCard({ hasBluesky }: { hasBluesky: boolean }) {
  const [view, setView] = useState<AutoLikeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Number fields while being edited; committed (clamped) on blur.
  const [drafts, setDrafts] = useState<Partial<Record<NumberKey, string>>>({});

  async function refresh() {
    try {
      setView(await loadAutoLike());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- load-on-mount; setState happens after await
    if (hasBluesky) void refresh();
  }, [hasBluesky]);

  async function apply(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!hasBluesky) {
    return (
      <Card title={TITLE}>
        <p className="text-sm text-ink-muted">Connect Bluesky to use this.</p>
      </Card>
    );
  }
  if (!view) {
    return (
      <Card title={TITLE}>
        {error ? <Notice kind="danger">{error}</Notice> : <p className="text-sm text-ink-muted">Loading…</p>}
      </Card>
    );
  }
  const s = view.settings;

  const number = (key: NumberKey, label: string) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        aria-label={label}
        className="w-24 text-right py-2"
        value={drafts[key] ?? String(s[key])}
        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => {
          const v = clampSetting(key, drafts[key] ?? String(s[key]), s[key]);
          setDrafts((d) => {
            const next = { ...d };
            delete next[key];
            return next;
          });
          if (v !== s[key]) void apply(() => saveAutoLike({ [key]: v }));
        }}
      />
    </label>
  );

  const check = (key: BoolKey, label: string) => (
    <label className="flex items-center justify-between gap-3 text-sm min-h-[44px]">
      <span>{label}</span>
      <input
        type="checkbox"
        className="w-5 h-5 accent-select"
        checked={s[key]}
        onChange={(e) => void apply(() => saveAutoLike({ [key]: e.target.checked }))}
      />
    </label>
  );

  return (
    <Card title={TITLE}>
      <div className="space-y-3">
        <Switch
          label="Auto-like replies"
          on={s.auto_like_enabled}
          onChange={(next) => void apply(() => (next ? enableAutoLike() : saveAutoLike({ auto_like_enabled: false })))}
        />
        {number('auto_like_min_followers', 'Minimum followers')}
        {number('auto_like_min_account_age_days', 'Minimum account age (days)')}
        {number('auto_like_daily_cap', 'Daily limit')}
        {check('auto_like_skip_links', 'Skip replies containing links')}
        {check('auto_like_skip_no_avatar', 'Skip accounts with no profile photo')}
        {check('auto_like_skip_labeled', 'Skip accounts with moderation labels')}
        <p className="text-xs text-ink-muted">
          Blocked and muted accounts, and your own replies, are always skipped. Replies are liked 2–30 minutes after they arrive.
        </p>
        <p className="text-sm">
          Liked today {view.likedToday} · last 7 days {view.likedWeek}
        </p>
        {view.state?.last_error && <Notice kind="warn">{view.state.last_error}</Notice>}
        {error && <Notice kind="danger">{error}</Notice>}
        {view.events.length > 0 && (
          <ul className="space-y-1 text-sm">
            {view.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-2">
                <span className="truncate">
                  @{e.author_handle} · {describeEvent(e)}
                </span>
                <span className="text-xs text-ink-muted shrink-0">{relative(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Mount it in `Accounts.tsx`**

Add the import after the `ConnectedRow`-related imports at the top:

```tsx
import { AutoLikeCard } from '../components/AutoLikeCard';
```

Then, directly after the closing `</Card>` of `<Card title={LABEL.bluesky}>` (and before `<Card title={LABEL.x}>`), insert:

```tsx
      <AutoLikeCard hasBluesky={Boolean(bluesky && bluesky.status === 'ok')} />
```

- [ ] **Step 3: Build, lint, test**

Run (from `app/`): `npm run lint && npm test && npm run build`
Expected: lint clean, `Tests 9 passed`, build ends with `files generated` and `dist/sw.js`. If `tsc` complains that `saveAutoLike({ [key]: v })` is not assignable to `Partial<AutoLikeSettings>`, change those two calls to `saveAutoLike({ [key]: v } as Partial<AutoLikeSettings>)` and import the type.

- [ ] **Step 4: Look at it**

Run (from `app/`): `npm run dev` and open the Accounts tab in a browser at phone width (or use the Playwright MCP tools to screenshot `http://localhost:5173`). Check: the card sits under Bluesky; with no Bluesky account it shows the one-line message; with one, the switch, three numbers, three checkboxes, note, stats line. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/AutoLikeCard.tsx app/src/screens/Accounts.tsx
git commit -m "feat(app): auto-like card on the Accounts tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Setup docs

**Files:**
- Modify: `docs/SETUP.md` (append section 15)
- Modify: `README.md` (one line in the commands list)

- [ ] **Step 1: Append to `docs/SETUP.md`**

```markdown
## 15. Auto-like replies (Bluesky only)

Likes qualifying direct replies to the user's Bluesky posts 2–30 minutes after they arrive. Bluesky only: X's automation rules ban automated likes with no exceptions, so there is deliberately no X equivalent.

- **Deploy:** `npx supabase db push --linked` (migrations `…000010_auto_like.sql` and `…000011_auto_like_cron.sql`), then `npx supabase functions deploy auto-like cleanup-media`. The cron entry `auto-like` runs every minute with the same Vault-backed URL/secret as `run-due-posts`.
- **Switch on:** each user does it themselves on **Accounts → Auto-like replies**. Switching on resets the watermark to that moment, so nothing older is ever liked. Settings (saved on change): minimum followers (default 5), minimum account age in days (7), daily limit (100), skip replies containing links (on), skip accounts with no profile photo (off), skip accounts with moderation labels (on; self-applied labels such as adult-content tags do not count). Blocked and muted accounts and the user's own replies are always skipped.
- **Ledger:** `auto_like_events` holds one row per reply considered (queued / liked / skipped + reason / failed + reason). The card shows the last 50 and likes today / last 7 days. Rows older than 30 days are purged by the nightly `cleanup-media` run (`events_purged` in its response).
- **Dry run:** `deno task autolike-dry [-- --lookback 60]` calls the function with `?dry_run=1` and prints, per enabled user, what it would like or skip and why. Nothing is written or liked. `--lookback N` scans N minutes before the watermark so replies that already exist can be checked. Run this against the owner's test account before enabling it for anyone else.
- **Errors:** a dead session marks the Bluesky account `needs_reconnect` (which also stops posting) and shows "Bluesky session expired; reconnect in Accounts" on the card. Anything else lands in `auto_like_state.last_error`, shown on the card until the next clean run.
- **Inspect:** `npx supabase db query --linked "select author_handle, decision, reason, created_at from auto_like_events order by created_at desc limit 20"`.
```

- [ ] **Step 2: README** — in the commands list, after the `npx supabase db push` line, add:

```markdown
- `deno task autolike-dry` — show what auto-like would do, without liking anything
```

- [ ] **Step 3: Commit**

```bash
git add docs/SETUP.md README.md
git commit -m "docs(setup): auto-like replies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Deploy and live dry run

The posting job's shared code changed in Task 2, so `run-due-posts` and `post-now` are redeployed too.

**Files:**
- Create: `supabase/migrations/20261024000011_auto_like_cron.sql`

- [ ] **Step 1: Write the cron migration**

```sql
-- Every minute, call the auto-like Edge Function. Same Vault-backed
-- URL/secret lookups as run-due-posts (see 20260921000003_cron.sql).
-- Kept separate from the schema migration so it is applied only once the
-- function is deployed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'auto-like',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/auto-like',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
```

- [ ] **Step 2: Deploy the functions first, then the cron**

Run: `npx supabase functions deploy auto-like cleanup-media run-due-posts post-now`
Expected: JSON ending `"message":"Deployed Functions."` listing all four.

Run: `npx supabase db push --linked`
Expected: applies `20261024000011_auto_like_cron.sql`.

- [ ] **Step 3: Confirm the cron is calling it**

Wait one minute, then run:
```
npx supabase db query --linked "select status_code, content::text from net._http_response order by created desc limit 3"
```
Expected: a `200` row whose content starts `{"users":0,"dry_run":false,"summary":[]}` (nobody enabled yet).

- [ ] **Step 4: Deploy the app**

Run (from `app/`): `npm run build`
Run (from repo root): `netlify deploy --prod --dir=app/dist --site 4c30f4a2-de96-4ff0-8b51-7d8235a7f7a5`
Expected: `Deploy is live!` with the production URL `https://crossposty-phone.netlify.app`.

- [ ] **Step 5: Live dry run on the owner's test account**

1. On the phone or in a browser, sign in as the owner, open **Accounts**, switch **Auto-like replies** on.
2. From a *different* Bluesky account, post a direct reply to any recent post on the test account (mjj2323.bsky.social). Wait ~30 s for the AppView to index it.
3. Run: `deno task autolike-dry`
   Expected: `user <uuid>: scanned 1` followed by either `LIKE  @<handle>` or `skip  @<handle> (<reason>)` with a reason that matches the replier's account (e.g. `followers` if the replying account has fewer than 5 followers).
4. Run it again with `deno task autolike-dry -- --lookback 1440` and confirm older replies appear too, all as decisions only.
5. Confirm nothing was written: `npx supabase db query --linked "select count(*) from auto_like_events"` → `0`.
6. Leave the switch on if you want the real run to like the test reply; the next cron tick queues it, and 2–30 minutes later the card shows `liked`. Or switch it off.

- [ ] **Step 6: Commit and push**

```bash
git add supabase/migrations/20261024000011_auto_like_cron.sql
git commit -m "feat(db): schedule auto-like every minute

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

- [ ] **Step 7: Record the state**

In `C:\Users\drice\CrossPosty` (the docs repo) nothing further is needed; the spec and this plan are already committed. Update the working-state memory note (`project_working_state.md`) with one line: auto-like shipped on 2026-10-24, Bluesky only, dry-run via `deno task autolike-dry`.

---

## Self-review

**Spec coverage**
- §1 decisions → Tasks 4 (direct replies, fixed exclusions, rule order), 5 (delay window, no backfill via watermark, cap), 10 (visibility). ✔
- §2 architecture → Task 6 (entrypoint, per-user isolation, deadline, dry run + lookback), Task 12 (cron). ✔
- §3 data model → Task 1 (settings columns with defaults and checks, state, ledger with the four indexes, RLS/grants, enable RPC), Task 7 (30-day purge). ✔
- §4 scan pass → Tasks 3 (`listNotifications` with `reasons`), 4 (candidate test, rules, self-label exclusion, link detection via facets/embed/text), 5 (5-page ceiling, watermark advance, batched profiles with missing-DID-as-zero, cap counting liked+queued, oldest-first, conflict-ignoring inserts). ✔
- §5 like pass → Task 5 (batch of 20, cap re-check, permanent/transient/reauth handling, 5 attempts, pacing). ✔
- §6 adapter additions without widening `Adapter` → Task 3 (`BlueskyAdapter` intersection type). ✔
- §7 errors → Task 5 (`REAUTH_MESSAGE`, `last_error` via `setRunResult`, transient scan abandons without watermark move), Task 6 (per-user crash isolation, always 200). ✔
- §8 UI → Task 10 (card under Bluesky, disabled line, switch via RPC, three numbers saved on blur, three checkboxes, fixed note, stats, ledger of 50 with reason text, error notice), Task 9 (helpers, reason map). ✔
- §9 testing → Tasks 3, 4, 5, 9 (unit), Task 12 (live dry run). The card itself is checked by hand in Task 10 step 4. ✔
- §10 out of scope → nothing added. ✔

**Placeholder scan** — no TBD/TODO; every code step shows the code; commands have expected output.

**Type consistency** — `AutoLikeSettings` (camelCase, backend) vs `AutoLikeSettings` (snake_case column names, PWA) are intentionally different types in different packages; `db.ts` maps between them in `listEnabledUsers`. `SkipReason` strings match `REASON_TEXT` keys. `EventInsert.decision` is `'queued' | 'skipped'`; `MemoryAutoLikeDb` widens it via a cast only inside the test. `freshTokens` throws `bluesky account needs to be reconnected` (lowercase platform name) and the Task 5 test asserts exactly that. `UserSummary` shape is identical in `run.ts` and the entrypoint's out-of-time/crash rows.
