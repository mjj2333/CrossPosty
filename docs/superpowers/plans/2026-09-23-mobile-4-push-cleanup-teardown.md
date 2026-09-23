# CrossPosty Mobile — Plan 4: Failure Push, Storage Cleanup, Teardown

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone gets a push notification when a post fails; images are deleted a day after their post is done and orphans are swept daily; the old relay (table, bucket, cron, function) and the pairing-era leftovers are removed.

**Architecture:** Web Push (RFC 8291/8292) sent from the Edge Functions with `jsr:@negrel/webpush`, VAPID keys in function secrets, subscriptions in a `push_subscriptions` table. The PWA's service worker moves to vite-plugin-pwa's `injectManifest` strategy (`src/sw.ts`) so it can handle `push` and `notificationclick`. A `cleanup-media` Edge Function runs daily from `pg_cron` with the same `x-cron-secret` pattern; its selection logic is a pure, tested function. Teardown is a migration, so the repo records what was removed.

**Tech Stack:** `jsr:@negrel/webpush@^0.5.0` (`ApplicationServer.new({contactInformation, vapidKeys})`, `subscribe(sub).pushTextMessage(json, {ttl, urgency})`, `PushMessageError.isGone()`), workbox-precaching/core/routing in the SW, existing Supabase backend.

**Repo:** `C:\Users\drice\CrossPosty-mobile` (HEAD `f017ac9`). Plans 1–3 are live.

**Facts gathered for this plan:** hosted project has `relay_messages` (table), `relay-media` bucket (2 objects), function `delete_relay_media_objects`, cron job `relay-cleanup-daily`. iOS Web Push works only in a home-screen-installed PWA (16.4+), permission must be requested from a tap, and the project's OTP length is 8.

**Decisions:**
- Notify on failure only. Success is visible in the Queue; a notification per sent post would be noise.
- One subscription per device (`endpoint` is the key); a `410 Gone` from the push service deletes the row.
- Cleanup keeps `posts.media` metadata (alt text, paths) and records `media_purged_at`; only the bytes go.
- Teardown deletes the relay data outright (nothing in it is wanted); the extension repo stays archived on GitHub with its README pointer.

---

## File structure

```
supabase/migrations/20260923000005_push_and_purge.sql   # push_subscriptions, posts.media_purged_at
supabase/migrations/20260923000006_cleanup_cron.sql     # daily cleanup-media schedule
supabase/migrations/20260923000007_relay_teardown.sql   # drop relay table/bucket/function/cron
supabase/functions/_shared/push.ts (+ .test.ts)          # notifyFailure(deps)
supabase/functions/_shared/cleanup.ts (+ .test.ts)       # planCleanup(...) pure
supabase/functions/cleanup-media/index.ts
supabase/functions/run-due-posts/index.ts, post-now/index.ts   # call notifyFailure
supabase/functions/import_map.json                       # + @negrel/webpush
scripts/gen-vapid.ts
app/src/sw.ts                                            # injectManifest SW with push handlers
app/vite.config.ts, app/tsconfig.json, app/package.json  # injectManifest, WebWorker lib, workbox deps
app/src/lib/push.ts                                      # subscribe/unsubscribe/status
app/src/screens/Accounts.tsx                             # "Notify me when a post fails" toggle
app/src/App.tsx                                          # ?tab=queue deep link
docs/SETUP.md                                            # §11 push, §12 cleanup, §13 teardown
```

---

### Task 1: Schema — `push_subscriptions`, `media_purged_at`

**Files:** `supabase/migrations/20260923000005_push_and_purge.sql`

```sql
-- Web Push subscriptions, one row per device. The PWA writes these with
-- the user's session; Edge Functions read them with the service role.
create table push_subscriptions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text primary key,
  keys       jsonb not null,           -- { "p256dh": "...", "auth": "..." }
  created_at timestamptz not null default now(),
  constraint keys_is_object check (jsonb_typeof(keys) = 'object')
);
alter table push_subscriptions enable row level security;
create policy "own push subscriptions" on push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on push_subscriptions to service_role;

-- Set when cleanup-media has deleted the post's image bytes.
alter table posts add column media_purged_at timestamptz;
create index posts_purge_idx on posts (updated_at)
  where status = 'done' and media_purged_at is null;
```

- [ ] Write, re-read for `$$`/semicolons, `npx supabase db push --yes`, commit `feat(db): push_subscriptions and media_purged_at`.

---

### Task 2: `notifyFailure` + hook into both entrypoints

**Files:** `supabase/functions/_shared/push.ts`, `push.test.ts`, `import_map.json` (+ `"@negrel/webpush": "jsr:@negrel/webpush@^0.5.0"`), `run-due-posts/index.ts`, `post-now/index.ts`, `scripts/gen-vapid.ts`, `deno.json` (task `gen-vapid`).

- [ ] **Tests first** (`push.test.ts`) — `notifyFailure` takes an injectable `send` so tests never touch the library:

```ts
import { assertEquals } from '@std/assert';
import { buildFailureMessage, notifyFailure, type PushDeps } from './push.ts';
import type { PostRow } from './types.ts';

const post = {
  id: 'p1', user_id: 'u1', status: 'failed', text: 'Hello world this is a long post', targets: ['bluesky', 'x'],
  results: { bluesky: { state: 'sent', attempts: 1 }, x: { state: 'failed', attempts: 3, error: 'X create post HTTP 403: duplicate content' } },
} as unknown as PostRow;

Deno.test('buildFailureMessage names the failed platforms and the first error', () => {
  const m = buildFailureMessage(post);
  assertEquals(m.title, 'Post failed on X');
  assertEquals(m.body.startsWith('"Hello world'), true);
  assertEquals(m.body.includes('duplicate content'), true);
  assertEquals(m.url, '/?tab=queue');
});

function deps(overrides: Partial<PushDeps> = {}): PushDeps & { sent: string[]; deleted: string[] } {
  const sent: string[] = [];
  const deleted: string[] = [];
  return {
    listSubscriptions: () => Promise.resolve([{ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } }, { endpoint: 'https://push/b', keys: { p256dh: 'p', auth: 'a' } }]),
    send: (sub) => { sent.push(sub.endpoint); return Promise.resolve('ok'); },
    deleteSubscription: (endpoint) => { deleted.push(endpoint); return Promise.resolve(); },
    sent, deleted, ...overrides,
  };
}

Deno.test('sends to every subscription', async () => {
  const d = deps();
  const out = await notifyFailure('u1', post, d);
  assertEquals(d.sent, ['https://push/a', 'https://push/b']);
  assertEquals(out, { sent: 2, gone: 0, failed: 0 });
});

Deno.test('a gone subscription is deleted and does not stop the others', async () => {
  const d = deps({ send: (sub) => Promise.resolve(sub.endpoint.endsWith('/a') ? 'gone' : 'ok') });
  const out = await notifyFailure('u1', post, d);
  assertEquals(d.deleted, ['https://push/a']);
  assertEquals(out, { sent: 1, gone: 1, failed: 0 });
});

Deno.test('a send error is counted, not thrown', async () => {
  const d = deps({ send: () => Promise.reject(new Error('boom')) });
  const out = await notifyFailure('u1', post, d);
  assertEquals(out.failed, 2);
});

Deno.test('no subscriptions is a no-op', async () => {
  const d = deps({ listSubscriptions: () => Promise.resolve([]) });
  assertEquals(await notifyFailure('u1', post, d), { sent: 0, gone: 0, failed: 0 });
});
```

- [ ] **Implement `push.ts`**

```ts
// Failure notifications over Web Push. The library call is behind
// `send` so the logic is testable and a broken push service never
// affects posting.
import * as webpush from '@negrel/webpush';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Platform, PostRow } from './types.ts';

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type SendOutcome = 'ok' | 'gone';
export type PushDeps = {
  listSubscriptions: (userId: string) => Promise<Subscription[]>;
  send: (sub: Subscription, payload: string) => Promise<SendOutcome>;
  deleteSubscription: (endpoint: string) => Promise<void>;
};
export type FailureMessage = { title: string; body: string; url: string };

const LABEL: Record<Platform, string> = { bluesky: 'Bluesky', x: 'X' };

export function buildFailureMessage(post: PostRow): FailureMessage {
  const failed = post.targets.filter((p) => post.results[p]?.state === 'failed');
  const names = failed.map((p) => LABEL[p]).join(' and ') || 'a platform';
  const firstError = failed.map((p) => post.results[p]?.error).find(Boolean) ?? 'unknown error';
  const snippet = post.text.trim().slice(0, 60) + (post.text.trim().length > 60 ? '…' : '');
  return {
    title: `Post failed on ${names}`,
    body: `"${snippet}" — ${firstError.slice(0, 120)}`,
    url: '/?tab=queue',
  };
}

export async function notifyFailure(
  userId: string,
  post: PostRow,
  deps: PushDeps,
): Promise<{ sent: number; gone: number; failed: number }> {
  const subs = await deps.listSubscriptions(userId);
  const payload = JSON.stringify(buildFailureMessage(post));
  const out = { sent: 0, gone: 0, failed: 0 };
  for (const sub of subs) {
    try {
      const r = await deps.send(sub, payload);
      if (r === 'gone') {
        out.gone++;
        await deps.deleteSubscription(sub.endpoint);
      } else out.sent++;
    } catch (err) {
      out.failed++;
      console.warn('[push] send failed', sub.endpoint.slice(0, 40), String(err));
    }
  }
  return out;
}

// Production deps: Supabase for subscriptions, @negrel/webpush for sending.
// VAPID_KEYS_JSON is the exportVapidKeys() output; PUSH_CONTACT a mailto:.
export async function makePushDeps(supabase: SupabaseClient): Promise<PushDeps | null> {
  const raw = Deno.env.get('VAPID_KEYS_JSON');
  const contact = Deno.env.get('PUSH_CONTACT');
  if (!raw || !contact) return null; // push not configured; posting must still work
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(raw), { extractable: false });
  const appServer = await webpush.ApplicationServer.new({ contactInformation: contact, vapidKeys });
  return {
    async listSubscriptions(userId) {
      const { data, error } = await supabase.from('push_subscriptions').select('endpoint, keys').eq('user_id', userId);
      if (error) throw error;
      return (data ?? []) as Subscription[];
    },
    async send(sub, payload) {
      try {
        await appServer.subscribe(sub).pushTextMessage(payload, { ttl: 60 * 60 * 24, urgency: webpush.Urgency.High });
        return 'ok';
      } catch (err) {
        if (err instanceof webpush.PushMessageError && err.isGone()) return 'gone';
        throw err;
      }
    },
    async deleteSubscription(endpoint) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    },
  };
}
```

If `webpush.Urgency.High` is not the exported name (the JSR docs list the enum without values), use the string `'high'` cast, and report it.

- [ ] **Hook in**: in `run-due-posts/index.ts` and `post-now/index.ts`, after `processPost` returns with `out.status === 'failed'`: `const push = await makePushDeps(supabase); if (push) await notifyFailure(post.user_id, { ...post, results: out.results, status: 'failed' }, push);` wrapped in try/catch that only logs. Build `makePushDeps` once per invocation, before the loop.

- [ ] **`scripts/gen-vapid.ts`**

```ts
// Prints the two values to put in secrets; run once.
import * as webpush from '@negrel/webpush';
const keys = await webpush.generateVapidKeys({ extractable: true });
const exported = await webpush.exportVapidKeys(keys);
console.log('VAPID_KEYS_JSON=' + JSON.stringify(exported));
console.log('VITE_VAPID_PUBLIC_KEY=' + (await webpush.exportApplicationServerKey(keys)));
```
`deno.json` task: `"gen-vapid": "deno run scripts/gen-vapid.ts"`.

- [ ] `deno task check` green (95 + 5), commit `feat(push): failure notifications via Web Push`.

---

### Task 3: `cleanup-media` — pure planner, function, daily cron

**Files:** `_shared/cleanup.ts`, `cleanup.test.ts`, `cleanup-media/index.ts`, `config.toml` (`[functions.cleanup-media]`), `migrations/20260923000006_cleanup_cron.sql`.

- [ ] **Tests first**

```ts
import { assertEquals } from '@std/assert';
import { planCleanup } from './cleanup.ts';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const old = new Date(NOW - 2 * 86_400_000).toISOString();
const fresh = new Date(NOW - 3_600_000).toISOString();

Deno.test('purges media of posts done for over a day and marks them', () => {
  const plan = planCleanup({
    now: NOW,
    posts: [
      { id: 'a', status: 'done', updated_at: old, media_purged_at: null, media: [{ storagePath: 'u/a/1' }] },
      { id: 'b', status: 'done', updated_at: fresh, media_purged_at: null, media: [{ storagePath: 'u/b/1' }] },
      { id: 'c', status: 'scheduled', updated_at: old, media_purged_at: null, media: [{ storagePath: 'u/c/1' }] },
    ],
    objects: [{ name: 'u/a/1', created_at: old }, { name: 'u/b/1', created_at: fresh }, { name: 'u/c/1', created_at: old }],
  });
  assertEquals(plan.remove.sort(), ['u/a/1']);
  assertEquals(plan.markPurged, ['a']);
});

Deno.test('removes orphans older than a day: no post, or path not in the post media', () => {
  const plan = planCleanup({
    now: NOW,
    posts: [{ id: 'a', status: 'scheduled', updated_at: old, media_purged_at: null, media: [{ storagePath: 'u/a/keep' }] }],
    objects: [
      { name: 'u/a/keep', created_at: old },
      { name: 'u/a/dropped', created_at: old },
      { name: 'u/zzz/1', created_at: old },
      { name: 'u/zzz/2', created_at: fresh },
    ],
  });
  assertEquals(plan.remove.sort(), ['u/a/dropped', 'u/zzz/1']);
  assertEquals(plan.markPurged, []);
});

Deno.test('a done post already marked purged has leftovers removed but is not re-marked', () => {
  const plan = planCleanup({
    now: NOW,
    posts: [{ id: 'a', status: 'done', updated_at: old, media_purged_at: old, media: [{ storagePath: 'u/a/1' }] }],
    objects: [{ name: 'u/a/1', created_at: old }],
  });
  assertEquals(plan.remove, ['u/a/1']);
  assertEquals(plan.markPurged, []);
});
```

- [ ] **`cleanup.ts`**

```ts
// Decides which storage objects to delete. Pure: takes what the DB and
// the bucket listing say, returns paths to remove and posts to mark.
export type CleanupPost = {
  id: string;
  status: string;
  updated_at: string;
  media_purged_at: string | null;
  media: Array<{ storagePath: string }>;
};
export type CleanupObject = { name: string; created_at: string };
export const GRACE_MS = 24 * 60 * 60 * 1000;

export function planCleanup(input: { now: number; posts: CleanupPost[]; objects: CleanupObject[] }) {
  const byId = new Map(input.posts.map((p) => [p.id, p]));
  const remove = new Set<string>();
  const markPurged: string[] = [];
  const isOld = (iso: string) => input.now - Date.parse(iso) > GRACE_MS;

  for (const p of input.posts) {
    if (p.status === 'done' && !p.media_purged_at && isOld(p.updated_at)) {
      for (const m of p.media) remove.add(m.storagePath);
      markPurged.push(p.id);
    }
  }
  for (const o of input.objects) {
    if (!isOld(o.created_at)) continue;
    const postId = o.name.split('/')[1];
    const post = postId ? byId.get(postId) : undefined;
    if (!post) remove.add(o.name);
    else if (post.media_purged_at) remove.add(o.name);
    else if (!post.media.some((m) => m.storagePath === o.name)) remove.add(o.name);
  }
  return { remove: [...remove], markPurged };
}
```

- [ ] **`cleanup-media/index.ts`**: `x-cron-secret` check like `run-due-posts`; service client; for each user in `select distinct user_id from posts` (one today): load posts (`id, status, updated_at, media_purged_at, media`), list objects two levels deep (`storage.from('post-media').list(uid)` → folders → `list(`${uid}/${folder}`)` → files with `created_at`, name prefixed back to full path), `planCleanup`, `storage.remove(paths)` in batches of 100, `update posts set media_purged_at = now() where id in (...)`. Return `{ users, removed, marked }`. Add `[functions.cleanup-media]` to `config.toml`.

- [ ] **Cron migration** — same shape as `20260921000003_cron.sql` but `cron.schedule('cleanup-media', '17 3 * * *', ...)` hitting `/functions/v1/cleanup-media`.

- [ ] `deno task check` green (+3), `db push`, `functions deploy cleanup-media`, commit `feat(cleanup): daily media purge and orphan sweep`.

---

### Task 4: App — service worker with push, subscribe toggle, deep link

**Files:** `app/package.json` (+ `workbox-precaching workbox-core workbox-routing` dev deps), `app/vite.config.ts`, `app/tsconfig.json`, `app/src/sw.ts`, `app/src/lib/push.ts`, `app/src/screens/Accounts.tsx`, `app/src/App.tsx`, `app/.env.example` (+ `VITE_VAPID_PUBLIC_KEY`).

- [ ] **`vite.config.ts`**: `VitePWA({ strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts', registerType: 'autoUpdate', includeAssets: [...], manifest: {...same...}, injectManifest: { globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'] } })`. `tsconfig.json` lib adds `"WebWorker"`.

- [ ] **`src/sw.ts`**

```ts
/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
self.skipWaiting();
clientsClaim();
// SPA: any navigation serves the precached index.html.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

type Payload = { title: string; body: string; url: string };

self.addEventListener('push', (event) => {
  let p: Payload = { title: 'CrossPosty', body: 'A post needs attention.', url: '/?tab=queue' };
  try {
    if (event.data) p = { ...p, ...(event.data.json() as Partial<Payload>) };
  } catch { /* keep defaults */ }
  event.waitUntil(self.registration.showNotification(p.title, { body: p.body, data: { url: p.url }, icon: '/icon-192.png', badge: '/icon-192.png' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => 'focus' in c);
    if (existing) { await (existing as WindowClient).navigate(url); await (existing as WindowClient).focus(); }
    else await self.clients.openWindow(url);
  })());
});
```

- [ ] **`src/lib/push.ts`**

```ts
import { supabase } from './supabase';

const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export function pushSupported(): boolean {
  return Boolean(publicKey) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Must be called from a tap (iOS requires a user gesture for the permission prompt).
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Notifications need the app installed to the home screen (iOS 16.4+).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey!) }));
  const json = sub.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('not signed in');
  const { error } = await supabase.from('push_subscriptions').upsert({ user_id: user.id, endpoint: sub.endpoint, keys: json.keys });
  if (error) throw error;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}
```

- [ ] **Accounts.tsx**: a "Notifications" section with a toggle "Notify me when a post fails" reflecting `currentSubscription()`; enabling calls `enablePush()` (errors shown), disabling `disablePush()`. When `!pushSupported()` show the install hint instead of the toggle.

- [ ] **App.tsx**: read `new URLSearchParams(location.search).get('tab')` on mount; if `queue`/`accounts`, start on that tab and `history.replaceState(null, '', '/')`.

- [ ] `npm run build` green (SW now built from `src/sw.ts`), `npm test`, oxlint clean. Commit `feat(app): push notifications for failed posts`.

---

### Task 5: Deploy and live test

- [ ] `deno task gen-vapid` → put `VAPID_KEYS_JSON` and `VITE_VAPID_PUBLIC_KEY` lines into `.env.smoke` (never print the private key). `npx supabase secrets set VAPID_KEYS_JSON="$VAPID_KEYS_JSON" PUSH_CONTACT="mailto:drice233@gmail.com"`. Deploy `run-due-posts post-now cleanup-media`.
- [ ] Add `VITE_VAPID_PUBLIC_KEY` to the `app/.env.production` writer in the deploy step; build; `netlify deploy --prod`.
- [ ] **Phone**: reopen the installed app (it updates), Accounts → enable notifications → allow. Force a failure: Accounts → disconnect Bluesky → Compose a Bluesky-only post → Post now → expect a "Post failed on Bluesky" notification within seconds; tap it → Queue opens on the failed post. Reconnect Bluesky, Retry → sent.
- [ ] **Cleanup**: `POST /functions/v1/cleanup-media` with the cron secret once by hand (via `curl` from `.env.smoke`), expect `{ users: 1, removed: N, marked: M }` matching the day-old smoke posts; confirm in the dashboard that the bucket shrank and `media_purged_at` is set.
- [ ] Commit docs (`SETUP.md` §11–12), push.

---

### Task 6: Teardown

**Files:** `supabase/migrations/20260923000007_relay_teardown.sql`, `docs/SETUP.md` §13, extension repo README (already points at the successor).

```sql
-- Remove the phone-to-extension relay from the pairing-era design.
-- Nothing in it is needed: the PWA talks to Supabase directly.
select cron.unschedule('relay-cleanup-daily');
drop function if exists delete_relay_media_objects();
delete from storage.objects where bucket_id = 'relay-media';
delete from storage.buckets where id = 'relay-media';
drop table if exists relay_messages;
```

- [ ] Before writing it, `db query` the exact signature of `delete_relay_media_objects` (`select pg_get_function_identity_arguments(oid) ...`) and any policies on `relay_messages`/`relay-media` so the `drop` statements match; `cron.unschedule` errors if the job name is wrong, so confirm it from `cron.job` first.
- [ ] `db push`; verify: `relay_messages` gone, bucket gone, `cron.job` has only `run-due-posts` and `cleanup-media`.
- [ ] Old repos: the extension repo (`C:\Users\drice\CrossPosty`) keeps its history; ask the owner to click **Archive** on GitHub (gh CLI isn't logged in). `C:\Users\drice\CrossPosty-phone` is not a git repo and its Netlify site is now the new app; the folder can be deleted — leave that to the owner.
- [ ] Update the extension repo's README pointer to say the successor is live, and the memory file. Commit `chore(db): tear down the relay`.

---

## Self-review

**Spec coverage:** failure push with VAPID and permission on a tap ✔ T2/T4/T5; storage cleanup a day after `done` plus orphan sweep ✔ T3; relay teardown and old-repo disposition ✔ T6. Success notifications deliberately excluded.

**Placeholders:** none; the two library-name uncertainties (`Urgency.High`, `createHandlerBoundToURL`) are called out with fallbacks.

**Type consistency:** `Subscription` (`push.ts`) matches the `push_subscriptions` row and the browser's `PushSubscriptionJSON.keys`; `planCleanup` input types match the columns selected in `cleanup-media`; `PostRow.results[p].error` is what `buildFailureMessage` reads.
