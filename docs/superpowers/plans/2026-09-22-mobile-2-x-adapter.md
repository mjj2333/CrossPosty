# CrossPosty Mobile — Plan 2: X Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The scheduler posts to X through the official v2 API (text, up to 4 images, threads with X's 23-character URL weighting), using OAuth 2.0 tokens issued by the X developer console and rotated automatically.

**Architecture:** An `x.ts` adapter beside `bluesky.ts`, behind the same `Adapter<T, M>` interface, which gains `maxImages` and `measure` so the chain runner and splitter stop hard-coding platform facts. `PostError` gains optional metadata (`status`, `code`, `retryAfterMs`) so X's 429 `Retry-After` and 403 detail messages drive the job's retry decisions. Tokens are seeded once from the console via a script (no PWA sign-in flow needed for a single owner); the adapter refreshes them with the client ID/secret held in Edge Function secrets.

**Tech Stack:** X API v2 (`POST /2/tweets`, chunked `/2/media/upload/*`, `POST /2/oauth2/token`, `GET /2/users/me`), Deno, existing Supabase backend from Plan 1.

**Repo:** `C:\Users\drice\CrossPosty-mobile` (HEAD `d3b000a` at the time of writing). Plan 1: `2026-09-21-mobile-1-backend-bluesky.md`; its "Carry-forwards for Plan 2" section is resolved by Tasks 1 and 2 here except the atproto-specific items, which stay deferred.

**Decisions made while planning:**
- The console issued OAuth 2.0 access + refresh tokens for the owner's account, so there is no authorization-code flow and no `x-oauth-callback` function in this plan. Reconnecting (if the refresh chain ever breaks) means generating a new pair in the console and re-running the seed script.
- The seed script performs one refresh immediately, so a bad client secret or a spent refresh token is caught at seed time, and the stored pair has a known expiry.
- Image cap for X is 5,000,000 bytes (X's image limit); one APPEND segment is enough at that size.
- Cost: `POST /2/tweets` is $0.015 per call ($0.20 with a link); each chunk of a thread is one call. The smoke test posts ~6 tweets, one with a link, ≈ $0.30. Media upload pricing is confirmed in Task 4 from the console.

---

## File structure

```
supabase/functions/_shared/
  adapters/types.ts          # + maxImages, measure on Adapter; PostError.info; retry-after parsing
  adapters/x.ts              # NEW: refresh, chunked upload, create post, error mapping
  adapters/x.test.ts         # NEW
  text/thread-split.ts       # splitIntoChain(text, limit, measure?) — binary-search prefix under a measure
  text/thread-split.test.ts  # + X-weighted case
  post-chain.ts              # uses adapter.maxImages / adapter.measure
  post-chain.test.ts         # fake adapter gains maxImages
  job.ts                     # honours PostError.info.retryAfterMs
  job.test.ts                # + retry-after case
  types.ts                   # XTokens gains expiresAt
  adapters/bluesky.ts        # + maxImages: 4 (interface change)
supabase/functions/run-due-posts/index.ts   # registers the X adapter when X_CLIENT_ID/SECRET are set
scripts/seed-x-account.ts    # NEW: console tokens -> one refresh -> encrypted accounts row
scripts/live-smoke.ts        # + --targets, X verification read
deno.json                    # + seed-x task
docs/SETUP.md                # + X section
```

---

### Task 1: Interface changes — `maxImages`, `measure`, `PostError.info`, measured splitting

**Files:**
- Modify: `supabase/functions/_shared/adapters/types.ts`
- Modify: `supabase/functions/_shared/text/thread-split.ts`, `thread-split.test.ts`
- Modify: `supabase/functions/_shared/post-chain.ts`, `post-chain.test.ts`
- Modify: `supabase/functions/_shared/job.ts`, `job.test.ts`
- Modify: `supabase/functions/_shared/adapters/bluesky.ts` (add `maxImages: 4`)
- Modify: `supabase/functions/_shared/types.ts` (`XTokens.expiresAt`)

- [ ] **Step 1: Write the failing tests**

Append to `thread-split.test.ts`:

```ts
import { effectiveLength, X_URL_WEIGHT } from './format.ts';

Deno.test('a measure function decides what fits (X counts every URL as 23)', () => {
  // 12 short URLs: 155 raw chars (fits 280 raw) but 12*23 + 11 = 287 weighted.
  const text = Array(12).fill('https://a.co').join(' ');
  const xMeasure = (t: string) => effectiveLength(t, X_URL_WEIGHT);
  assertEquals(splitIntoChain(text, 280), [text]);
  const chunks = splitIntoChain(text, 280, xMeasure);
  assertEquals(chunks.length, 2);
  for (const c of chunks) assertEquals(xMeasure(c) <= 280, true);
  assertEquals(chunks.map((c) => c.replace(/ \d+\/\d+$/, '')).join(' '), text);
});
```

Append to `post-chain.test.ts` (the fake adapter must also gain `maxImages` and optional `measure`; see step 3):

```ts
Deno.test('uploads at most adapter.maxImages images', async () => {
  const f = fakeAdapter({ maxImages: 2 });
  await postChain(f.adapter, { t: '' }, 'x', ['a', 'b', 'c'].map(img), f.sleep);
  assertEquals(f.uploads, ['a', 'b']);
});

Deno.test('splits with the adapter measure when present', async () => {
  const text = Array(12).fill('https://a.co').join(' ');
  const f = fakeAdapter({ measure: (t) => effectiveLength(t, X_URL_WEIGHT) });
  const out = await postChain(f.adapter, { t: '' }, text, [], f.sleep);
  assertEquals(out.total, 2);
});
```

Append to `job.test.ts`:

```ts
Deno.test('a transient failure with Retry-After longer than 5 min waits that long', async () => {
  const x = stubAdapter('x', {
    fail: new PostError('HTTP 429', 'transient', { status: 429, retryAfterMs: 15 * 60_000 }),
  });
  const s = await setup({ x, targets: ['x'] });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.results.x?.nextAttemptAt, new Date(NOW.getTime() + 15 * 60_000).toISOString());
});
```

Add to `adapters/types.test.ts`:

```ts
import { httpError } from './types.ts';

Deno.test('httpError records status and parses Retry-After seconds', async () => {
  const res = new Response('slow down', { status: 429, headers: { 'retry-after': '90' } });
  const err = await httpError(res, 'x');
  assertEquals(err.kind, 'transient');
  assertEquals(err.info, { status: 429, retryAfterMs: 90_000 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test`
Expected: type errors on `maxImages`/`measure`/`info` and the new assertions failing.

- [ ] **Step 3: Implement**

`adapters/types.ts` — replace `PostError`, `httpError`, and the `Adapter` interface:

```ts
export type PostErrorInfo = {
  status?: number; // HTTP status when the failure came from a response
  code?: string; // provider-specific code or title, e.g. X "duplicate-content"
  retryAfterMs?: number; // from a Retry-After header, when present
};

export class PostError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly info: PostErrorInfo = {},
  ) {
    super(message);
    this.name = 'PostError';
  }
}

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export async function httpError(res: Response, what: string): Promise<PostError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    body = '(unreadable body)';
  }
  const info: PostErrorInfo = { status: res.status };
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
  return new PostError(`${what} HTTP ${res.status}: ${body}`, classifyHttp(res.status), info);
}
```

and in `Adapter<T, M>` add after `pacingMs`:

```ts
  maxImages: number;
  // How many characters `text` costs on this platform. Defaults to
  // `text.length`; X counts every URL as 23 regardless of length.
  measure?: (text: string) => number;
```

`text/thread-split.ts` — full replacement of the function bodies (comments at the top stay):

```ts
export type Measure = (text: string) => number;
const charLength: Measure = (t) => t.length;

export function splitIntoChain(text: string, limit: number, measure: Measure = charLength): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Single-post case — no suffix, no chain.
  if (measure(trimmed) <= limit) return [trimmed];

  let chunks = greedySplit(trimmed, limit - MAX_SUFFIX_WIDTH, measure);
  let suffix = suffixWidth(chunks.length);
  if (suffix !== MAX_SUFFIX_WIDTH) {
    chunks = greedySplit(trimmed, limit - suffix, measure);
  }
  if (suffixWidth(chunks.length) !== suffix) {
    suffix = suffixWidth(chunks.length);
    chunks = greedySplit(trimmed, limit - suffix, measure);
  }
  const total = chunks.length;
  return chunks.map((c, i) => `${c} ${i + 1}/${total}`);
}

function suffixWidth(total: number): number {
  // " N/M" — both numerals are `total`, separated by `/`, preceded by a space.
  return 1 + String(total).length + 1 + String(total).length;
}

// Largest n such that measure(text.slice(0, n)) <= budget. Adding
// characters never lowers a measure, so binary search is safe.
function longestPrefix(text: string, budget: number, measure: Measure): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function greedySplit(text: string, budget: number, measure: Measure): string[] {
  // A budget under 1 can never advance the loop below. Real limits are
  // 280/300; this guards tiny limits and the refinement passes above,
  // where a large chunk count widens the suffix and shrinks the budget.
  if (budget < 1) {
    throw new Error(`splitIntoChain: limit too small to chain (budget ${budget})`);
  }
  const result: string[] = [];
  let remaining = text;
  while (measure(remaining) > budget) {
    const headLen = longestPrefix(remaining, budget, measure);
    if (headLen < 1) {
      throw new Error(`splitIntoChain: budget ${budget} cannot fit the next token`);
    }
    const head = remaining.slice(0, headLen);
    let cut = -1;
    const sentenceRe = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceRe.exec(head)) !== null) cut = m.index + 1;
    // If the only sentence boundary is in the first half, prefer a
    // later word boundary so we don't lose too much content per chunk.
    if (cut < headLen * 0.5) {
      const wordCut = head.lastIndexOf(' ');
      if (wordCut > cut) cut = wordCut;
    }
    if (cut <= 0) cut = headLen;
    const piece = remaining.slice(0, cut).trim();
    if (piece) result.push(piece);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) result.push(remaining);
  return result;
}
```

`post-chain.ts` — delete `const MAX_IMAGES = 4;`, then:

```ts
  const chunks = splitIntoChain(text, adapter.characterLimit, adapter.measure);
  ...
  for (const image of images.slice(0, adapter.maxImages)) {
```

`post-chain.test.ts` — `fakeAdapter(opts: { limit?: number; failAt?: number; maxImages?: number; measure?: (t: string) => number } = {})`, with `maxImages: opts.maxImages ?? 4` and `measure: opts.measure` on the adapter object; add `import { effectiveLength, X_URL_WEIGHT } from './text/format.ts';`. The existing "only the first four images are uploaded" test still passes via the default.

`job.ts` — in the transient branch:

```ts
    if (pe.kind === 'transient' && attempts < MAX_ATTEMPTS) {
      // Honour a provider's Retry-After when it is longer than our floor.
      const delayMs = Math.max(RETRY_DELAY_MS, pe.info.retryAfterMs ?? 0);
      return {
        state: 'pending',
        attempts,
        error: pe.message,
        nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      };
    }
```

`job.test.ts` — `stubAdapter`'s adapter object gains `maxImages: 4`.

`adapters/bluesky.ts` — add `maxImages: 4,` after `pacingMs: 1000,`.

`types.ts` — `XTokens`:

```ts
export type XTokens = {
  accessToken: string;
  refreshToken: string; // single-use: replaced on every refresh
  userId: string;
  handle: string; // username without @
  expiresAt: number; // epoch ms of accessToken expiry
};
```

- [ ] **Step 4: Run the suite**

Run: `deno task check`
Expected: lint/fmt/check clean; `76 passed` (70 + 1 splitter + 2 chain + 1 job + 1 types + the existing count adjusts if a test was split — report the real number).

- [ ] **Step 5: Commit**

```
git commit -am "feat(shared): adapter maxImages/measure, PostError metadata, measured chain splitting"
```

---

### Task 2: X adapter

**Files:**
- Create: `supabase/functions/_shared/adapters/x.ts`
- Test: `supabase/functions/_shared/adapters/x.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals, assertRejects } from '@std/assert';
import type { XTokens } from '../types.ts';
import { bodyJson, fakeFetch, json, type FetchCall } from '../test-utils.ts';
import { createXAdapter, fetchMe } from './x.ts';
import { PostError } from './types.ts';

const NOW = 1_700_000_000_000;
const cfg = { clientId: 'cid', clientSecret: 'csecret' };

function tokens(expiresAt = NOW + 3600_000): XTokens {
  return { accessToken: 'at-1', refreshToken: 'rt-1', userId: '42', handle: 'me', expiresAt };
}

Deno.test('fetchMe returns id and username', async () => {
  const fetch = fakeFetch({
    'users/me': (_u, init) => {
      assertEquals((init.headers as Record<string, string>).authorization, 'Bearer at-1');
      return json({ data: { id: '42', name: 'Me', username: 'me' } });
    },
  });
  assertEquals(await fetchMe('at-1', fetch), { id: '42', username: 'me' });
});

Deno.test('refreshIfNeeded is a no-op while the access token is fresh', async () => {
  const calls: FetchCall[] = [];
  const out = await createXAdapter(cfg, fakeFetch({}, calls)).refreshIfNeeded(tokens(), NOW);
  assertEquals(out.changed, false);
  assertEquals(calls.length, 0);
});

Deno.test('refreshIfNeeded posts the refresh grant with Basic auth and stores the new pair', async () => {
  const fetch = fakeFetch({
    'oauth2/token': (_u, init) => {
      const h = init.headers as Record<string, string>;
      assertEquals(h.authorization, `Basic ${btoa('cid:csecret')}`);
      assertEquals(h['content-type'], 'application/x-www-form-urlencoded');
      const body = String(init.body);
      assertEquals(body.includes('grant_type=refresh_token'), true);
      assertEquals(body.includes('refresh_token=rt-1'), true);
      assertEquals(body.includes('client_id=cid'), true);
      return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200, token_type: 'bearer' });
    },
  });
  const out = await createXAdapter(cfg, fetch).refreshIfNeeded(tokens(NOW + 60_000), NOW);
  assertEquals(out.changed, true);
  assertEquals(out.tokens.accessToken, 'at-2');
  assertEquals(out.tokens.refreshToken, 'rt-2');
  assertEquals(out.tokens.expiresAt, NOW + 7200_000);
  assertEquals(out.tokens.handle, 'me');
});

Deno.test('a rejected refresh (400 invalid_grant) is a reauth error', async () => {
  const fetch = fakeFetch({ 'oauth2/token': () => json({ error: 'invalid_grant' }, 400) });
  const err = await assertRejects(
    () => createXAdapter(cfg, fetch).refreshIfNeeded(tokens(NOW), NOW),
    PostError,
  );
  assertEquals(err.kind, 'reauth');
});

Deno.test('uploadImage runs initialize -> append -> finalize and returns the media id', async () => {
  const calls: FetchCall[] = [];
  const fetch = fakeFetch({
    'media/upload/initialize': (_u, init) => {
      assertEquals(bodyJson(init), { media_type: 'image/png', total_bytes: 3, media_category: 'tweet_image' });
      return json({ data: { id: '777', media_key: '3_777', expires_after_secs: 86400 } });
    },
    '777/append': (_u, init) => {
      assertEquals(init.body instanceof FormData, true);
      const form = init.body as FormData;
      assertEquals(form.get('segment_index'), '0');
      assertEquals(form.get('media') instanceof Blob, true);
      return new Response(null, { status: 204 });
    },
    '777/finalize': () => json({ data: { id: '777', media_key: '3_777' } }),
  }, calls);
  const id = await createXAdapter(cfg, fetch).uploadImage(tokens(), {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    alt: 'three',
  });
  assertEquals(id, '777');
  assertEquals(calls.map((c) => c.url.split('/2/')[1]), [
    'media/upload/initialize',
    'media/upload/777/append',
    'media/upload/777/finalize',
  ]);
});

Deno.test('uploadImage polls STATUS while processing', async () => {
  let polls = 0;
  const fetch = fakeFetch({
    'media/upload/initialize': () => json({ data: { id: '1' } }),
    '1/append': () => new Response(null, { status: 204 }),
    '1/finalize': () =>
      json({ data: { id: '1', processing_info: { state: 'pending', check_after_secs: 0 } } }),
    'command=STATUS': () => {
      polls++;
      return json({
        data: { id: '1', processing_info: { state: polls < 2 ? 'in_progress' : 'succeeded', check_after_secs: 0 } },
      });
    },
  });
  const adapter = createXAdapter(cfg, fetch, () => Promise.resolve());
  assertEquals(await adapter.uploadImage(tokens(), { bytes: new Uint8Array(1), mimeType: 'image/gif', alt: '' }), '1');
  assertEquals(polls, 2);
});

Deno.test('uploadImage rejects images over 5,000,000 bytes without a network call', async () => {
  const calls: FetchCall[] = [];
  const err = await assertRejects(
    () => createXAdapter(cfg, fakeFetch({}, calls)).uploadImage(tokens(), { bytes: new Uint8Array(5_000_001), mimeType: 'image/jpeg', alt: '' }),
    PostError,
  );
  assertEquals(err.kind, 'permanent');
  assertEquals(calls.length, 0);
});

Deno.test('post sends text, media ids and reply pointer, returns the status URL', async () => {
  const fetch = fakeFetch({
    '2/tweets': (_u, init) => {
      assertEquals(bodyJson(init), {
        text: 'hello',
        media: { media_ids: ['777'] },
        reply: { in_reply_to_tweet_id: '100' },
      });
      return json({ data: { id: '101', text: 'hello' } });
    },
  });
  const ref = await createXAdapter(cfg, fetch).post(tokens(), 'hello', ['777'], {
    root: { id: '99', url: '' },
    parent: { id: '100', url: '' },
  });
  assertEquals(ref, { id: '101', url: 'https://x.com/me/status/101' });
});

Deno.test('post omits media and reply keys when absent', async () => {
  const fetch = fakeFetch({
    '2/tweets': (_u, init) => {
      assertEquals(Object.keys(bodyJson(init)), ['text']);
      return json({ data: { id: '1', text: 'x' } });
    },
  });
  await createXAdapter(cfg, fetch).post(tokens(), 'x', []);
});

Deno.test('X error mapping: 429 transient with Retry-After, 403 duplicate permanent, 401 reauth', async () => {
  const adapter = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    createXAdapter(cfg, fakeFetch({ '2/tweets': () => new Response(JSON.stringify(body), { status, headers }) }));

  const rate = await assertRejects(() => adapter(429, { title: 'Too Many Requests' }, { 'retry-after': '120' }).post(tokens(), 'x', []), PostError);
  assertEquals(rate.kind, 'transient');
  assertEquals(rate.info.retryAfterMs, 120_000);

  const dup = await assertRejects(() => adapter(403, { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' }).post(tokens(), 'x', []), PostError);
  assertEquals(dup.kind, 'permanent');
  assertEquals(dup.message.includes('duplicate content'), true);

  const auth = await assertRejects(() => adapter(401, { title: 'Unauthorized' }).post(tokens(), 'x', []), PostError);
  assertEquals(auth.kind, 'reauth');
});

Deno.test('adapter metadata', () => {
  const a = createXAdapter(cfg, fakeFetch({}));
  assertEquals(a.characterLimit, 280);
  assertEquals(a.maxImages, 4);
  assertEquals(a.measure?.('go https://a.co now'), 'go '.length + 23 + ' now'.length);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `Module not found ... x.ts`.

- [ ] **Step 3: Write the adapter**

```ts
// X adapter over the official v2 API with OAuth 2.0 user tokens. The
// token pair is seeded from the developer console (scripts/seed-x-account.ts)
// and rotated here; the caller persists it when `changed` is true.

import type { XTokens } from '../types.ts';
import { effectiveLength, X_URL_WEIGHT } from '../text/format.ts';
import {
  type Adapter,
  httpError,
  type ImageInput,
  parseRetryAfterMs,
  PostError,
  type PostErrorInfo,
  type PostRef,
  type RefreshOutcome,
} from './types.ts';

export const X_API = 'https://api.x.com';
const X_CHAR_LIMIT = 280;
const IMAGE_CAP = 5_000_000; // X image limit
const REFRESH_WINDOW_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const PROCESSING_MAX_MS = 60_000;

export type XClientConfig = { clientId: string; clientSecret: string };
export type XMediaId = string;
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

type ProcessingInfo = { state?: string; check_after_secs?: number; error?: { message?: string } };

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '(unreadable body)';
  }
}

// X's v2 error bodies are {title, detail, status, type} or {errors:[{message,code}]}.
async function xError(res: Response, what: string): Promise<PostError> {
  const raw = await safeText(res);
  let detail = raw;
  let code: string | undefined;
  try {
    const j = JSON.parse(raw) as { title?: string; detail?: string; errors?: Array<{ message?: string; code?: number }> };
    detail = j.detail ?? j.errors?.[0]?.message ?? j.title ?? raw;
    code = j.title ?? (j.errors?.[0]?.code !== undefined ? String(j.errors[0].code) : undefined);
  } catch {
    // not JSON; keep raw
  }
  const info: PostErrorInfo = { status: res.status };
  if (code) info.code = code;
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
  const kind = res.status === 401 ? 'reauth' : res.status === 429 || res.status >= 500 ? 'transient' : 'permanent';
  return new PostError(`${what} HTTP ${res.status}: ${detail}`, kind, info);
}

export async function fetchMe(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; username: string }> {
  const res = await fetchImpl(`${X_API}/2/users/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await xError(res, 'X users/me');
  const j = (await res.json()) as { data: { id: string; username: string } };
  return { id: j.data.id, username: j.data.username };
}

export function createXAdapter(
  config: XClientConfig,
  fetchImpl: typeof fetch = fetch,
  sleep: Sleep = realSleep,
): Adapter<XTokens, XMediaId> {
  const auth = (t: XTokens): Record<string, string> => ({ authorization: `Bearer ${t.accessToken}` });
  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

  async function waitForProcessing(tokens: XTokens, id: string, initial: ProcessingInfo): Promise<void> {
    let current = initial;
    const started = Date.now();
    while (current.state && current.state !== 'succeeded') {
      if (current.state === 'failed') {
        throw new PostError(`X media processing failed: ${current.error?.message ?? 'unknown'}`, 'permanent');
      }
      if (Date.now() - started > PROCESSING_MAX_MS) {
        throw new PostError('X media processing timed out', 'transient');
      }
      await sleep(Math.max(0, current.check_after_secs ?? 1) * 1000);
      const res = await fetchImpl(`${X_API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`, {
        headers: auth(tokens),
        signal: signal(),
      });
      if (!res.ok) throw await xError(res, 'X media status');
      const j = (await res.json()) as { data?: { processing_info?: ProcessingInfo } };
      current = j.data?.processing_info ?? { state: 'succeeded' };
    }
  }

  return {
    platform: 'x',
    characterLimit: X_CHAR_LIMIT,
    pacingMs: 2000,
    maxImages: 4,
    measure: (text) => effectiveLength(text, X_URL_WEIGHT),

    async refreshIfNeeded(tokens, nowMs): Promise<RefreshOutcome<XTokens>> {
      if (tokens.expiresAt - nowMs > REFRESH_WINDOW_MS) {
        return { tokens, changed: false, expiresAt: new Date(tokens.expiresAt) };
      }
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: config.clientId,
      });
      const res = await fetchImpl(`${X_API}/2/oauth2/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: signal(),
      });
      if (!res.ok) {
        // 400 invalid_grant / 401: the refresh token is spent or revoked.
        // Only a new pair from the developer console fixes this.
        if (res.status === 400 || res.status === 401) {
          throw new PostError(
            `X token refresh rejected (HTTP ${res.status}): ${await safeText(res)}. Generate a new token pair in the developer console and run the seed script again.`,
            'reauth',
            { status: res.status },
          );
        }
        throw await httpError(res, 'X token refresh');
      }
      const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
      const next: XTokens = {
        ...tokens,
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? tokens.refreshToken,
        expiresAt: nowMs + j.expires_in * 1000,
      };
      return { tokens: next, changed: true, expiresAt: new Date(next.expiresAt) };
    },

    async uploadImage(tokens, image: ImageInput): Promise<XMediaId> {
      if (image.bytes.byteLength > IMAGE_CAP) {
        throw new PostError(`Image is ${image.bytes.byteLength} bytes; X allows at most ${IMAGE_CAP}`, 'permanent');
      }
      const init = await fetchImpl(`${X_API}/2/media/upload/initialize`, {
        method: 'POST',
        headers: { ...auth(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({
          media_type: image.mimeType,
          total_bytes: image.bytes.byteLength,
          media_category: 'tweet_image',
        }),
        signal: signal(),
      });
      if (!init.ok) throw await xError(init, 'X media initialize');
      const { data: { id } } = (await init.json()) as { data: { id: string } };

      // One segment: images are capped at 5 MB, the per-segment maximum.
      const form = new FormData();
      form.append('segment_index', '0');
      form.append('media', new Blob([image.bytes], { type: image.mimeType }), 'image');
      const append = await fetchImpl(`${X_API}/2/media/upload/${id}/append`, {
        method: 'POST',
        headers: auth(tokens),
        body: form,
        signal: signal(),
      });
      if (!append.ok) throw await xError(append, 'X media append');

      const fin = await fetchImpl(`${X_API}/2/media/upload/${id}/finalize`, {
        method: 'POST',
        headers: auth(tokens),
        signal: signal(),
      });
      if (!fin.ok) throw await xError(fin, 'X media finalize');
      const finJson = (await fin.json()) as { data?: { processing_info?: ProcessingInfo } };
      if (finJson.data?.processing_info) await waitForProcessing(tokens, id, finJson.data.processing_info);
      return id;
    },

    async post(tokens, text, media, replyTo): Promise<PostRef> {
      const body: Record<string, unknown> = { text };
      if (media.length > 0) body.media = { media_ids: media };
      if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo.parent.id };
      const res = await fetchImpl(`${X_API}/2/tweets`, {
        method: 'POST',
        headers: { ...auth(tokens), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal(),
      });
      if (!res.ok) throw await xError(res, 'X create post');
      const j = (await res.json()) as { data: { id: string } };
      return { id: j.data.id, url: `https://x.com/${tokens.handle}/status/${j.data.id}` };
    },
  };
}
```

Note for the implementer: X sometimes returns HTTP 201 for a created post; `res.ok` covers it. If `deno lint` flags the nested ternary in `xError`, rewrite it as if/else.

- [ ] **Step 4: Run tests** — `deno test supabase/functions/_shared/adapters/x.test.ts` → `ok | 11 passed`.

- [ ] **Step 5: Commit** — `git commit -m "feat(x): v2 adapter with token rotation, chunked media upload, error mapping"`.

---

### Task 3: Wire X into the scheduler, seed script, smoke `--targets`

**Files:**
- Modify: `supabase/functions/run-due-posts/index.ts`
- Create: `scripts/seed-x-account.ts`
- Modify: `scripts/live-smoke.ts`
- Modify: `deno.json`, `docs/SETUP.md`

- [ ] **Step 1: `run-due-posts/index.ts`** — register X only when configured, so a missing secret never breaks Bluesky:

```ts
import { createXAdapter } from '../_shared/adapters/x.ts';
...
  const xClientId = Deno.env.get('X_CLIENT_ID');
  const xClientSecret = Deno.env.get('X_CLIENT_SECRET');
  const deps: JobDeps = {
    db: makeJobDb(supabase),
    key,
    adapters: {
      bluesky: createBlueskyAdapter(fetch),
      ...(xClientId && xClientSecret
        ? { x: createXAdapter({ clientId: xClientId, clientSecret: xClientSecret }, fetch) }
        : {}),
    },
    ...
```

- [ ] **Step 2: `scripts/seed-x-account.ts`**

```ts
// Seeds (or re-seeds) the owner's X account from tokens generated in the
// X developer console. Performs one refresh right away so a wrong client
// secret or an already-spent refresh token fails here, not in the cron.
// Run: deno task seed-x   (reads .env.smoke)

import { createClient } from '@supabase/supabase-js';
import { createXAdapter, fetchMe } from '../supabase/functions/_shared/adapters/x.ts';
import { encryptJson, importTokenKey } from '../supabase/functions/_shared/crypto.ts';
import type { XTokens } from '../supabase/functions/_shared/types.ts';

const need = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing ${k} in .env.smoke`);
  return v;
};

const admin = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = need('OWNER_EMAIL');
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
if (listErr) throw listErr;
const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) throw new Error(`owner ${email} has no auth user yet; run the Bluesky smoke test first`);

const me = await fetchMe(need('X_ACCESS_TOKEN'), fetch);
console.log('X token is valid for @' + me.username, `(id ${me.id})`);

const adapter = createXAdapter({ clientId: need('X_CLIENT_ID'), clientSecret: need('X_CLIENT_SECRET') });
const seeded: XTokens = {
  accessToken: need('X_ACCESS_TOKEN'),
  refreshToken: need('X_REFRESH_TOKEN'),
  userId: me.id,
  handle: me.username,
  expiresAt: 0, // unknown: force a refresh now
};
const refreshed = await adapter.refreshIfNeeded(seeded, Date.now());
console.log('refresh ok; access token expires', refreshed.expiresAt?.toISOString());
console.log('NOTE: the console refresh token is now spent; the rotated pair is what the server holds.');

const key = await importTokenKey(need('TOKEN_KEY'));
const { error } = await admin.from('accounts').upsert({
  user_id: user.id,
  platform: 'x',
  handle: me.username,
  secret: await encryptJson(key, refreshed.tokens),
  expires_at: refreshed.expiresAt?.toISOString() ?? null,
  status: 'ok',
});
if (error) throw error;
console.log('accounts row upserted for x');
```

`deno.json` tasks: add `"seed-x": "deno run --allow-net --allow-env --env-file=.env.smoke scripts/seed-x-account.ts"`.

- [ ] **Step 3: `scripts/live-smoke.ts`** — add a `targets` string flag (default `bluesky`), skip `connect-bluesky` when bluesky is not a target, insert `targets: targetList`, and after printing the row, for an X target, read the post back with one paid read so the result is verified externally:

```ts
const args = parseArgs(argv, { string: ['image', 'text', 'targets'] });
const targetList = (args.targets ?? 'bluesky').split(',').map((t) => t.trim()) as Array<'bluesky' | 'x'>;
...
if (targetList.includes('bluesky')) { /* existing connect-bluesky block */ }
...
  targets: targetList,
...
// 7. verify X externally (GET /2/tweets/:id is a paid read, ~$0.005)
const xId = (row?.results as Record<string, { remoteId?: string }> | null)?.x?.remoteId;
if (xId) {
  const { data: acct } = await admin.from('accounts').select('secret').eq('user_id', user.id).eq('platform', 'x').single();
  const { decryptJson, importTokenKey } = await import('../supabase/functions/_shared/crypto.ts');
  const tok = await decryptJson<{ accessToken: string }>(await importTokenKey(need('TOKEN_KEY')), acct!.secret);
  const v = await fetch(`https://api.x.com/2/tweets/${xId}?tweet.fields=attachments,referenced_tweets,text`, { headers: { authorization: `Bearer ${tok.accessToken}` } });
  console.log('X verify', v.status, (await v.text()).slice(0, 400));
}
```

(Move the crypto imports to the top of the file rather than a dynamic import; the snippet shows intent.) Update the header comment and `docs/SETUP.md` step 8 with the X commands from Task 4.

- [ ] **Step 4: `deno task check`** clean; commit `feat(x): wire adapter into run-due-posts; seed script; smoke --targets`.

---

### Task 4: Deploy, seed, live smoke on X

- [ ] **Step 1: Secrets and deploy** (values read from `.env.smoke`, never echoed):

```bash
set -a && . ./.env.smoke && set +a
npx supabase@latest secrets set X_CLIENT_ID="$X_CLIENT_ID" X_CLIENT_SECRET="$X_CLIENT_SECRET"
npx supabase@latest functions deploy run-due-posts
```

- [ ] **Step 2: Seed** — `deno task seed-x`. Expected: `X token is valid for @<handle>`, `refresh ok`, `accounts row upserted for x`. If the refresh is rejected, the console pair was already spent: generate a new pair, update `.env.smoke`, re-run.

- [ ] **Step 3: Smoke tests** (each ~$0.015–0.20):
  - `deno task smoke -- --targets x --text "CrossPosty X smoke test <timestamp>, no link"` → `done`; `X verify 200` shows the text.
  - `deno task smoke -- --targets x --image <png>` → `done`; verify output includes `attachments.media_keys`.
  - `deno task smoke -- --targets x --text "<700 chars>"` → `done`; verify output for the head shows no `referenced_tweets`; open the head URL in a browser and confirm `2/3`, `3/3` replies.
  - `deno task smoke -- --targets bluesky,x` → both `sent`.
  - Wait 2+ hours (or set `expiresAt` back via a seed re-run) and post once more to prove refresh rotation works in the cron: check `accounts.updated_at` moved and the post is `done`.
- [ ] **Step 4: Cost check** — Developer Console → usage: confirm the charges match (posts × $0.015, the link post $0.20) and record the media-upload price in `docs/SETUP.md`.
- [ ] **Step 5: Push** — `git push`.

---

## Self-review

**Spec coverage:** X via v2 API with OAuth 2.0 tokens ✔ (Task 2, seeded instead of a sign-in flow, recorded in Decisions); chunked media upload with STATUS polling ✔; `POST /2/tweets` with `media.media_ids` and `reply.in_reply_to_tweet_id`, 2 s pacing, images on head only ✔ (Task 1 chain runner + Task 2); URL weighting for chain sizing ✔ (Task 1 `measure`); client ID/secret in function secrets only ✔ (Task 4); error classes 429/401/403 ✔; cost estimate display is Plan 3 (PWA). Plan 1 carry-forwards resolved: `measure`/`urlWeight`, `maxImages`, `PostError` metadata; atproto-specific ones remain deferred by decision.

**Placeholders:** none; every step has code or an exact command. The one deliberately loose spot is Task 3 step 3's "move the imports to the top", which is a mechanical instruction, not missing content.

**Type consistency:** `Adapter.measure?: (text) => number` (Task 1) is what `post-chain.ts` passes to `splitIntoChain(text, limit, measure)` and what `x.ts` sets. `PostError(message, kind, info?)` signature is used identically in Tasks 1–2 and the job reads `pe.info.retryAfterMs`. `XTokens.expiresAt` (ms) is what `x.ts` compares against `nowMs` and what the seed script sets to 0. `createXAdapter(config, fetchImpl?, sleep?)` matches both the tests and `run-due-posts`.
