# CrossPosty Mobile — Plan 1: Backend + Bluesky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Supabase backend that, every minute, posts due `posts` rows to Bluesky (text, up to 4 images with alt text, link/mention/hashtag facets, thread chaining), with encrypted server-side tokens and idempotent retries.

**Architecture:** A new repo `CrossPosty-mobile`. Postgres holds `accounts`, `posts`, `settings`; a `claim_due_posts()` SQL function does the locked claim. `pg_cron` calls the `run-due-posts` Edge Function (Deno) each minute; it decrypts tokens with a key held only in function secrets, posts through a platform adapter, and writes per-target results as it goes. `connect-bluesky` stores an app-password session. All shared code lives in `supabase/functions/_shared/` so the Edge Functions can bundle it and the PWA (Plan 3) can import it.

**Tech Stack:** Supabase (Postgres, Storage, Auth, Edge Functions, pg_cron, pg_net, Vault), Deno 2 (`Deno.serve`, `deno test`, `@std/assert`), `@supabase/supabase-js@2`, Web Crypto AES-GCM, atproto XRPC over plain `fetch` (no `@atproto/api`).

**Spec:** `C:\Users\drice\CrossPosty\docs\superpowers\specs\2026-09-21-crossposty-mobile-design.md`. Deviations recorded there under "Plan 1 amendments": shared code lives under `supabase/functions/_shared/`; all backend tests use `deno test`; `accounts.secret` is base64 text; image compression moves to the phone (the server rejects >2 MB for Bluesky); the cron authenticates with a `CRON_SECRET` header rather than the service-role JWT.

**Plans that follow:** 2 = X adapter + OAuth, 3 = PWA, 4 = push, cleanup, migration.

---

## File structure

```
C:\Users\drice\CrossPosty-mobile\
  .gitignore
  README.md
  deno.json                          # importMap + tasks for `deno test` / scripts
  docs/SETUP.md                      # one-time owner setup checklist
  scripts/live-smoke.ts              # hand-run end-to-end test against real Supabase + Bluesky
  supabase/
    config.toml                      # from `supabase init`, plus per-function verify_jwt = false
    migrations/
      20260921000001_init.sql        # enums, tables, RLS, claim/set_target_result functions, bucket, owner trigger
      20260921000002_cron.sql        # pg_cron + pg_net schedule
    functions/
      import_map.json                # same imports as deno.json, for `supabase functions deploy`
      _shared/
        types.ts                     # Platform, PostRow, TargetResult, token shapes
        crypto.ts                    # AES-GCM encrypt/decrypt of token JSON
        crypto.test.ts
        http.ts                      # CORS, jsonResponse, requireUser
        text/
          thread-split.ts            # ported unchanged
          thread-split.test.ts
          format.ts                  # mention translation + whitespace; effectiveLength for X
          format.test.ts
        adapters/
          types.ts                   # Adapter interface, PostError, classifyHttp
          bluesky-facets.ts          # ported, resolver injected
          bluesky-facets.test.ts
          bluesky.ts                 # createSession, refresh, uploadBlob, createRecord
          bluesky.test.ts
        post-chain.ts                # upload images once, post chunks as replies
        post-chain.test.ts
        job.ts                       # processPost: per-target loop, retry classification
        job.test.ts
        db.ts                        # JobDb backed by supabase-js
        test-utils.ts                # fakeFetch, json(), fakeJwt()
      run-due-posts/index.ts
      connect-bluesky/index.ts
```

Each file has one job. `job.ts` knows nothing about Supabase (it takes a `JobDb` interface) so it is tested with an in-memory fake; `db.ts` is the only file that touches supabase-js for the job.

## Prerequisites (do once, before Task 1)

- [ ] Install Deno 2: `winget install DenoLand.Deno`, then open a new terminal and run `deno --version` (expect `deno 2.x`).
- [ ] Node is already installed (used for `npx supabase`).
- [ ] You need the Supabase project ref `zexbkbkobqdosezkuuqj` (from `src/lib/relay/defaults.ts` in the extension repo) and dashboard access.

---

### Task 1: Scaffold the repo

**Files:**
- Create: `C:\Users\drice\CrossPosty-mobile\.gitignore`
- Create: `C:\Users\drice\CrossPosty-mobile\deno.json`
- Create: `C:\Users\drice\CrossPosty-mobile\supabase\functions\import_map.json`
- Create: `C:\Users\drice\CrossPosty-mobile\README.md`
- Create (via CLI): `C:\Users\drice\CrossPosty-mobile\supabase\config.toml`

- [ ] **Step 1: Create the repo and init Supabase**

```powershell
New-Item -ItemType Directory C:\Users\drice\CrossPosty-mobile
Set-Location C:\Users\drice\CrossPosty-mobile
git init -b main
npx supabase@latest init
```

Expected: `supabase/config.toml` exists. Answer "N" to any prompt about generating VS Code / IntelliJ Deno settings.

- [ ] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
.env
.env.*
supabase/.temp/
supabase/.branches/
.DS_Store
```

- [ ] **Step 3: Write `deno.json`**

```json
{
  "importMap": "./supabase/functions/import_map.json",
  "tasks": {
    "test": "deno test supabase/functions/_shared",
    "smoke": "deno run --allow-net --allow-env --allow-read --env-file=.env.smoke scripts/live-smoke.ts"
  },
  "compilerOptions": {
    "strict": true,
    "lib": ["deno.window", "dom"]
  }
}
```

- [ ] **Step 4: Write `supabase/functions/import_map.json`**

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "@std/assert": "jsr:@std/assert@1"
  }
}
```

- [ ] **Step 5: Point each function at the import map and disable gateway JWT checks**

Append to `supabase/config.toml`:

```toml
[functions.run-due-posts]
verify_jwt = false
import_map = "./functions/import_map.json"

[functions.connect-bluesky]
verify_jwt = false
import_map = "./functions/import_map.json"
```

`verify_jwt = false` because we validate callers ourselves: `run-due-posts` checks a `CRON_SECRET` header, `connect-bluesky` resolves the user from the bearer token via `auth.getUser`. This keeps the functions independent of whether the project uses legacy JWT keys or the newer `sb_secret_...` keys.

- [ ] **Step 6: Write a minimal `README.md`**

```markdown
# CrossPosty Mobile

Phone-only scheduled posting to Bluesky and X. Backend is Supabase (Postgres + Edge Functions); the phone app is a PWA (Plan 3).

- `deno task test` — backend unit tests
- `deno task smoke` — live end-to-end test (needs `.env.smoke`, see `docs/SETUP.md`)
- `npx supabase db push` / `npx supabase functions deploy` — deploy

Design: see the spec in the CrossPosty extension repo, `docs/superpowers/specs/2026-09-21-crossposty-mobile-design.md`.
```

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "chore: scaffold CrossPosty-mobile (deno + supabase)"
```

---

### Task 2: Shared types

**Files:**
- Create: `supabase/functions/_shared/types.ts`

- [ ] **Step 1: Write the types**

```ts
// Row and payload shapes shared by the Edge Functions and (later) the PWA.
// Keep this file free of runtime imports so either side can pull it in.

export type Platform = 'bluesky' | 'x';
export const PLATFORMS: readonly Platform[] = ['bluesky', 'x'];

export type PostStatus = 'draft' | 'scheduled' | 'posting' | 'done' | 'failed';

export type MediaItem = {
  storagePath: string; // "<user_id>/<post_id>/<index>" in the post-media bucket
  mimeType: string;
  alt: string;
};

export type TargetState = 'pending' | 'sent' | 'failed';

export type TargetResult = {
  state: TargetState;
  attempts: number;
  url?: string;
  remoteId?: string;
  error?: string;
  nextAttemptAt?: string; // ISO; only meaningful while state === 'pending'
};

export type PostRow = {
  id: string;
  user_id: string;
  status: PostStatus;
  scheduled_at: string | null;
  text: string;
  variants: Partial<Record<Platform, string>>;
  media: MediaItem[];
  targets: Platform[];
  results: Partial<Record<Platform, TargetResult>>;
  posting_started_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountStatus = 'ok' | 'needs_reconnect';

export type AccountRow = {
  user_id: string;
  platform: Platform;
  handle: string;
  secret: string; // base64(iv || AES-GCM ciphertext of the token JSON)
  expires_at: string | null;
  status: AccountStatus;
  updated_at: string;
};

// One entry per real person: their handle on each platform, no leading "@".
export type MentionEntry = Partial<Record<Platform, string>>;
export type MentionMap = MentionEntry[];

// Decrypted token blobs. Never leave an Edge Function.
export type BlueskyTokens = {
  identifier: string;
  appPassword: string;
  did: string;
  handle: string;
  pdsUrl: string;
  accessJwt: string;
  refreshJwt: string;
};

export type XTokens = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  handle: string;
};
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/_shared/types.ts`
Expected: no output (success).

- [ ] **Step 3: Commit**

```powershell
git add supabase/functions/_shared/types.ts
git commit -m "feat(shared): row and token types"
```

---

### Task 3: Port the thread splitter

**Files:**
- Create: `supabase/functions/_shared/text/thread-split.ts`
- Test: `supabase/functions/_shared/text/thread-split.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from '@std/assert';
import { splitIntoChain } from './thread-split.ts';

Deno.test('returns [] for empty or whitespace text', () => {
  assertEquals(splitIntoChain('', 280), []);
  assertEquals(splitIntoChain('   \n ', 280), []);
});

Deno.test('returns a single trimmed chunk with no suffix when it fits', () => {
  assertEquals(splitIntoChain('  hello world  ', 280), ['hello world']);
});

Deno.test('splits at sentence boundaries and numbers every chunk', () => {
  const text = 'First sentence here. Second sentence here. Third sentence here.';
  const chunks = splitIntoChain(text, 40);
  assertEquals(chunks, [
    'First sentence here. 1/3',
    'Second sentence here. 2/3',
    'Third sentence here. 3/3',
  ]);
  for (const c of chunks) assertEquals(c.length <= 40, true);
});

Deno.test('falls back to a word boundary when no sentence break is usable', () => {
  const text = 'one two three four five six seven eight nine ten';
  const chunks = splitIntoChain(text, 20);
  assertEquals(chunks.every((c) => c.length <= 20), true);
  assertEquals(chunks.every((c) => !c.startsWith(' ')), true);
  assertEquals(chunks.at(-1)?.endsWith(`/${chunks.length}`), true);
});

Deno.test('hard-cuts a single word longer than the budget', () => {
  const text = 'a'.repeat(50);
  const chunks = splitIntoChain(text, 20);
  assertEquals(chunks.every((c) => c.length <= 20), true);
  assertEquals(chunks.join('').replace(/ \d+\/\d+/g, ''), text);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/text/thread-split.test.ts`
Expected: error `Module not found ... thread-split.ts`.

- [ ] **Step 3: Write the implementation (verbatim port of `src/lib/thread-split.ts` from the extension repo)**

```ts
// Splits long text into a chain of posts that each fit a platform's
// character limit, with " N/M" suffix appended to every chunk so
// readers can follow the order. Sentence-boundary first, word-boundary
// fallback, hard-cut as last resort. Pure function — no platform-specific
// API knowledge.

// Worst case suffix width: " 99/99" = 6 chars. Reserve that up front
// when estimating chunk count, then refine with the actual width once
// we know the real total.
const MAX_SUFFIX_WIDTH = 6;

export function splitIntoChain(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Single-post case — no suffix, no chain.
  if (trimmed.length <= limit) return [trimmed];

  let chunks = greedySplit(trimmed, limit - MAX_SUFFIX_WIDTH);
  let suffix = suffixWidth(chunks.length);
  if (suffix !== MAX_SUFFIX_WIDTH) {
    chunks = greedySplit(trimmed, limit - suffix);
  }
  if (suffixWidth(chunks.length) !== suffix) {
    suffix = suffixWidth(chunks.length);
    chunks = greedySplit(trimmed, limit - suffix);
  }
  const total = chunks.length;
  return chunks.map((c, i) => `${c} ${i + 1}/${total}`);
}

function suffixWidth(total: number): number {
  // " N/M" — both numerals are `total`, separated by `/`, preceded by a space.
  return 1 + String(total).length + 1 + String(total).length;
}

function greedySplit(text: string, budget: number): string[] {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > budget) {
    const head = remaining.slice(0, budget);
    let cut = -1;
    const sentenceRe = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceRe.exec(head)) !== null) cut = m.index + 1;
    // If the only sentence boundary is in the first half, prefer a
    // later word boundary so we don't lose too much content per chunk.
    if (cut < budget * 0.5) {
      const wordCut = head.lastIndexOf(' ');
      if (wordCut > cut) cut = wordCut;
    }
    if (cut <= 0) cut = budget;
    const piece = remaining.slice(0, cut).trim();
    if (piece) result.push(piece);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) result.push(remaining);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/text/thread-split.test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/text
git commit -m "feat(shared): port thread splitter"
```

---

### Task 4: Port text formatting (mentions, whitespace, X URL weight)

**Files:**
- Create: `supabase/functions/_shared/text/format.ts`
- Test: `supabase/functions/_shared/text/format.test.ts`

Both remaining platforms chain rather than truncate, so `smartTruncate` is not ported. `effectiveLength` stays because the PWA's X character counter needs it.

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from '@std/assert';
import { effectiveLength, formatForPlatform, X_URL_WEIGHT } from './format.ts';

Deno.test('effectiveLength counts every URL as the X t.co weight', () => {
  const text = 'look https://example.com/a/very/long/path/that/goes/on ok';
  assertEquals(effectiveLength(text), text.length);
  assertEquals(effectiveLength(text, X_URL_WEIGHT), 'look '.length + X_URL_WEIGHT + ' ok'.length);
});

Deno.test('collapses 3+ newlines to a paragraph break and trims', () => {
  const out = formatForPlatform('  a\n\n\n\nb  ', { platform: 'bluesky', mentionMap: [] });
  assertEquals(out.text, 'a\n\nb');
});

Deno.test('translates a mapped mention to the destination handle', () => {
  const map = [{ x: 'alice_x', bluesky: 'alice.bsky.social' }];
  const out = formatForPlatform('hi @alice_x!', { platform: 'bluesky', mentionMap: map });
  assertEquals(out.text, 'hi @alice.bsky.social!');
  assertEquals(out.unmappedMentions, []);
});

Deno.test('strips the @ from an unmapped mention and reports it', () => {
  const out = formatForPlatform('cc @stranger and @stranger', { platform: 'x', mentionMap: [] });
  assertEquals(out.text, 'cc stranger and stranger');
  assertEquals(out.unmappedMentions, ['stranger']);
});

Deno.test('a known person with no handle on the destination is stripped and reported', () => {
  const map = [{ x: 'bob' }];
  const out = formatForPlatform('@bob hello', { platform: 'bluesky', mentionMap: map });
  assertEquals(out.text, 'bob hello');
  assertEquals(out.unmappedMentions, ['bob']);
});

Deno.test('leaves email-like text alone (only whitespace-led @ is a mention)', () => {
  const out = formatForPlatform('mail me@example.com', { platform: 'x', mentionMap: [] });
  assertEquals(out.text, 'mail me@example.com');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/text/format.test.ts`
Expected: `Module not found ... format.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import type { MentionMap, Platform } from '../types.ts';

const URL_RE_GLOBAL = /https?:\/\/\S+/g;
// X shortens every URL to a t.co link that counts as 23 characters
// regardless of the original length.
export const X_URL_WEIGHT = 23;

// How many characters a piece of text consumes on the destination.
// Equals string length unless `urlWeight` is supplied, in which case
// every URL contributes `urlWeight` instead of its real length.
export function effectiveLength(text: string, urlWeight?: number): number {
  if (urlWeight === undefined) return text.length;
  let total = 0;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  URL_RE_GLOBAL.lastIndex = 0;
  while ((m = URL_RE_GLOBAL.exec(text)) !== null) {
    total += m.index - lastIdx;
    total += urlWeight;
    lastIdx = m.index + m[0].length;
  }
  total += text.length - lastIdx;
  return total;
}

// Matches @handle at the start of input or after whitespace. Allows
// dots for Bluesky-style "name.bsky.social".
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_.]*)/g;

export type FormatResult = {
  text: string;
  unmappedMentions: string[];
};

export type FormatOptions = {
  platform: Platform;
  mentionMap: MentionMap;
};

// Per-destination text transforms, in order:
//   1. Normalise whitespace.
//   2. Translate @handles via the user's mention map; strip the @ for
//      handles with no mapping so we don't ping the wrong stranger.
// No truncation: both platforms chain long text (see post-chain.ts).
export function formatForPlatform(text: string, opts: FormatOptions): FormatResult {
  const normalised = normalizeWhitespace(text);
  const { text: translated, unmapped } = translateMentions(
    normalised,
    opts.platform,
    opts.mentionMap,
  );
  return { text: translated, unmappedMentions: unmapped };
}

// Collapse runs of 3+ newlines down to one blank line and trim.
function normalizeWhitespace(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function translateMentions(
  text: string,
  destPlatform: Platform,
  map: MentionMap,
): { text: string; unmapped: string[] } {
  const unmapped: string[] = [];
  const result = text.replace(MENTION_RE, (_match, lead: string, handle: string) => {
    const needle = handle.toLowerCase();
    const entry = map.find((e) =>
      Object.values(e).some((v) => v?.toLowerCase() === needle),
    );
    const destHandle = entry?.[destPlatform];
    if (destHandle) return `${lead}@${destHandle}`;
    if (!unmapped.includes(handle)) unmapped.push(handle);
    return `${lead}${handle}`;
  });
  return { text: result, unmapped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/text/format.test.ts`
Expected: `ok | 6 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/text/format.ts supabase/functions/_shared/text/format.test.ts
git commit -m "feat(shared): port mention translation and X URL weighting"
```

---

### Task 5: Token encryption

**Files:**
- Create: `supabase/functions/_shared/crypto.ts`
- Test: `supabase/functions/_shared/crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { decryptJson, encryptJson, generateTokenKeyBase64, importTokenKey } from './crypto.ts';

Deno.test('round-trips an object through encrypt/decrypt', async () => {
  const key = await importTokenKey(generateTokenKeyBase64());
  const packed = await encryptJson(key, { a: 1, b: 'two' });
  assertEquals(await decryptJson(key, packed), { a: 1, b: 'two' });
});

Deno.test('uses a fresh IV each time so ciphertexts differ', async () => {
  const key = await importTokenKey(generateTokenKeyBase64());
  const one = await encryptJson(key, { x: 1 });
  const two = await encryptJson(key, { x: 1 });
  assertNotEquals(one, two);
});

Deno.test('rejects a key of the wrong length', async () => {
  await assertRejects(() => importTokenKey(btoa('short')), Error, '32 bytes');
});

Deno.test('fails to decrypt with a different key', async () => {
  const k1 = await importTokenKey(generateTokenKeyBase64());
  const k2 = await importTokenKey(generateTokenKeyBase64());
  const packed = await encryptJson(k1, { x: 1 });
  await assertRejects(() => decryptJson(k2, packed));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/crypto.test.ts`
Expected: `Module not found ... crypto.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// AES-GCM encryption of platform token blobs. The key (TOKEN_KEY) lives
// only in Edge Function secrets; Postgres stores base64(iv || ciphertext)
// and cannot decrypt on its own.

const IV_BYTES = 12;
const KEY_BYTES = 32;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateTokenKeyBase64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export async function importTokenKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(`TOKEN_KEY must be ${KEY_BYTES} bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.byteLength);
  return bytesToBase64(packed);
}

export async function decryptJson<T = unknown>(key: CryptoKey, packedB64: string): Promise<T> {
  const packed = base64ToBytes(packedB64);
  const iv = packed.slice(0, IV_BYTES);
  const ciphertext = packed.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/crypto.test.ts`
Expected: `ok | 4 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/crypto.ts supabase/functions/_shared/crypto.test.ts
git commit -m "feat(shared): AES-GCM token encryption"
```

---

### Task 6: Database schema migration

**Files:**
- Create: `supabase/migrations/20260921000001_init.sql`

No automated test for SQL in this plan; it is exercised by the live smoke test in Task 15. Verify it applies cleanly with `supabase db push` in Task 14.

- [ ] **Step 1: Write the migration**

```sql
-- CrossPosty Mobile: core schema.

create extension if not exists pgcrypto;

create type platform as enum ('bluesky', 'x');
create type post_status as enum ('draft', 'scheduled', 'posting', 'done', 'failed');
create type account_status as enum ('ok', 'needs_reconnect');

-- ---------------------------------------------------------------------
-- accounts: one row per platform per user. `secret` is
-- base64(iv || AES-GCM ciphertext) of the token JSON; only Edge
-- Functions hold the key.
create table accounts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   platform not null,
  handle     text not null,
  secret     text not null,
  expires_at timestamptz,
  status     account_status not null default 'ok',
  updated_at timestamptz not null default now(),
  primary key (user_id, platform)
);

-- posts: the queue.
create table posts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  status             post_status not null default 'draft',
  scheduled_at       timestamptz,
  text               text not null default '',
  variants           jsonb not null default '{}'::jsonb,
  media              jsonb not null default '[]'::jsonb,
  targets            platform[] not null default '{}',
  results            jsonb not null default '{}'::jsonb,
  posting_started_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint scheduled_needs_time
    check (status <> 'scheduled' or scheduled_at is not null),
  constraint scheduled_needs_targets
    check (status <> 'scheduled' or cardinality(targets) > 0)
);
create index posts_due_idx on posts (scheduled_at) where status = 'scheduled';
create index posts_user_idx on posts (user_id, status, scheduled_at desc);

create table settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  mention_map     jsonb not null default '[]'::jsonb,
  default_targets platform[] not null default '{bluesky,x}',
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- updated_at maintenance
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger accounts_set_updated_at before update on accounts
  for each row execute function set_updated_at();
create trigger posts_set_updated_at before update on posts
  for each row execute function set_updated_at();
create trigger settings_set_updated_at before update on settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Row-level security: users see only their own rows. The service role
-- (Edge Functions) bypasses RLS.
alter table accounts enable row level security;
alter table posts    enable row level security;
alter table settings enable row level security;

create policy "own accounts" on accounts
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own posts" on posts
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own settings" on settings
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The PWA may read account metadata and disconnect an account, but
-- never read `secret` and never write accounts directly (Edge
-- Functions do that with the service role). Column-level grants: the
-- PWA must select explicit columns, not `*`.
revoke all on accounts from anon, authenticated;
grant select (user_id, platform, handle, expires_at, status, updated_at) on accounts to authenticated;
grant delete on accounts to authenticated;

-- ---------------------------------------------------------------------
-- claim_due_posts: atomically requeue crashed runs, then claim a batch
-- of due posts. FOR UPDATE SKIP LOCKED means two overlapping runs never
-- take the same row. Service role only.
create or replace function claim_due_posts(batch int default 5)
returns setof posts
language plpgsql
security definer
set search_path = public
as $$
begin
  update posts
     set status = 'scheduled', posting_started_at = null
   where status = 'posting'
     and posting_started_at < now() - interval '10 minutes';

  return query
    update posts p
       set status = 'posting', posting_started_at = now()
      from (
        select id from posts
         where status = 'scheduled' and scheduled_at <= now()
         order by scheduled_at
         limit batch
         for update skip locked
      ) picked
     where p.id = picked.id
    returning p.*;
end $$;
revoke execute on function claim_due_posts(int) from public, anon, authenticated;

-- set_target_result: merge one platform's result into posts.results
-- without a read-modify-write from the function.
create or replace function set_target_result(p_post_id uuid, p_platform platform, p_result jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update posts
     set results = results || jsonb_build_object(p_platform::text, p_result)
   where id = p_post_id;
$$;
revoke execute on function set_target_result(uuid, platform, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Storage: private bucket, path "<user_id>/<post_id>/<index>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'post-media', 'post-media', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

create policy "own post media" on storage.objects
  for all to authenticated
  using (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------
-- Single-user lock: only the owner email (stored in Vault under
-- 'owner_email') may sign up. Set it with:
--   select vault.create_secret('you@example.com', 'owner_email');
create or replace function enforce_owner_email() returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  allowed text;
begin
  select decrypted_secret into allowed
    from vault.decrypted_secrets
   where name = 'owner_email'
   limit 1;
  if allowed is null then
    raise exception 'owner_email is not configured in Vault';
  end if;
  if lower(new.email) is distinct from lower(allowed) then
    raise exception 'sign-ups are closed';
  end if;
  return new;
end $$;

create trigger enforce_owner_email before insert on auth.users
  for each row execute function enforce_owner_email();
```

- [ ] **Step 2: Re-read the file for unbalanced `$$` blocks and missing semicolons**

There is no local Postgres in this plan (no Docker); the migration is applied for real by `npx supabase db push` in Task 14, which reports any syntax error with a line number.

- [ ] **Step 3: Commit**

```powershell
git add supabase/migrations/20260921000001_init.sql
git commit -m "feat(db): accounts, posts, settings, claim + result functions, bucket, owner lock"
```

---

### Task 7: Adapter interface and error classification

**Files:**
- Create: `supabase/functions/_shared/adapters/types.ts`
- Create: `supabase/functions/_shared/test-utils.ts`
- Test: `supabase/functions/_shared/adapters/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from '@std/assert';
import { classifyHttp, PostError, toPostError } from './types.ts';

Deno.test('classifyHttp maps status codes to retry kinds', () => {
  assertEquals(classifyHttp(401), 'reauth');
  assertEquals(classifyHttp(429), 'transient');
  assertEquals(classifyHttp(500), 'transient');
  assertEquals(classifyHttp(503), 'transient');
  assertEquals(classifyHttp(400), 'permanent');
  assertEquals(classifyHttp(403), 'permanent');
});

Deno.test('toPostError passes PostError through and wraps anything else as transient', () => {
  const pe = new PostError('nope', 'permanent');
  assertEquals(toPostError(pe), pe);
  const wrapped = toPostError(new TypeError('fetch failed'));
  assertEquals(wrapped.kind, 'transient');
  assertEquals(wrapped.message, 'TypeError: fetch failed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/adapters/types.test.ts`
Expected: `Module not found ... adapters/types.ts`.

- [ ] **Step 3: Write the adapter types**

```ts
import type { Platform } from '../types.ts';

// How the job should react to a failure:
//   transient — retry later (network, 5xx, 429)
//   reauth    — mark the account needs_reconnect, fail the target
//   permanent — fail the target, no retry
export type ErrorKind = 'transient' | 'reauth' | 'permanent';

export class PostError extends Error {
  constructor(message: string, public readonly kind: ErrorKind) {
    super(message);
    this.name = 'PostError';
  }
}

export function classifyHttp(status: number): ErrorKind {
  if (status === 401) return 'reauth';
  if (status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

export async function httpError(res: Response, what: string): Promise<PostError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    body = '(unreadable body)';
  }
  return new PostError(`${what} HTTP ${res.status}: ${body}`, classifyHttp(res.status));
}

// Anything that isn't already a PostError (a thrown TypeError from fetch,
// a JSON parse error) is treated as transient: it gets three attempts
// before the target fails, which bounds the damage from a real bug.
export function toPostError(err: unknown): PostError {
  if (err instanceof PostError) return err;
  return new PostError(String(err), 'transient');
}

export type PostRef = { id: string; url: string; uri?: string; cid?: string };

export type ImageInput = { bytes: Uint8Array; mimeType: string; alt: string };

export type RefreshOutcome<T> = { tokens: T; changed: boolean; expiresAt: Date | null };

// T = decrypted token blob, M = the platform's opaque uploaded-media ref.
export interface Adapter<T, M> {
  platform: Platform;
  characterLimit: number;
  pacingMs: number;
  refreshIfNeeded(tokens: T, nowMs: number): Promise<RefreshOutcome<T>>;
  uploadImage(tokens: T, image: ImageInput): Promise<M>;
  post(
    tokens: T,
    text: string,
    media: M[],
    replyTo?: { root: PostRef; parent: PostRef },
  ): Promise<PostRef>;
}

// deno-lint-ignore no-explicit-any
export type AnyAdapter = Adapter<any, any>;
```

- [ ] **Step 4: Write the shared test helpers**

```ts
// Helpers for adapter tests: a fetch stub keyed by URL substring, a JSON
// Response builder, and a fake JWT with a chosen expiry.

export type FetchCall = { url: string; init: RequestInit };
export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

export function fakeFetch(routes: Record<string, Route>, calls: FetchCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    return await routes[key](url, init);
  }) as typeof fetch;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function fakeJwt(expSeconds: number): string {
  const seg = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ exp: expSeconds })}.sig`;
}

export function bodyJson(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/adapters/types.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/_shared/adapters supabase/functions/_shared/test-utils.ts
git commit -m "feat(shared): adapter interface, error classification, test helpers"
```

---

### Task 8: Bluesky facets (links, tags, mentions)

**Files:**
- Create: `supabase/functions/_shared/adapters/bluesky-facets.ts`
- Test: `supabase/functions/_shared/adapters/bluesky-facets.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from '@std/assert';
import { buildBskyFacets } from './bluesky-facets.ts';

const noResolve = () => Promise.resolve(null);

Deno.test('marks a URL as a link facet with trailing punctuation stripped', async () => {
  const facets = await buildBskyFacets('see https://example.com/a.', noResolve);
  assertEquals(facets, [{
    index: { byteStart: 4, byteEnd: 4 + 'https://example.com/a'.length },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a' }],
  }]);
});

Deno.test('uses byte offsets, not char offsets, for non-ASCII text', async () => {
  // "é" is 2 bytes in UTF-8.
  const facets = await buildBskyFacets('café #tag', noResolve);
  assertEquals(facets[0].index, { byteStart: 6, byteEnd: 10 });
  assertEquals(facets[0].features, [{ $type: 'app.bsky.richtext.facet#tag', tag: 'tag' }]);
});

Deno.test('resolves mentions to DIDs and skips ones that fail', async () => {
  const resolve = (h: string) => Promise.resolve(h === 'alice.bsky.social' ? 'did:plc:alice' : null);
  const facets = await buildBskyFacets('@alice.bsky.social and @nobody.example', resolve);
  assertEquals(facets.length, 1);
  assertEquals(facets[0].index, { byteStart: 0, byteEnd: '@alice.bsky.social'.length });
  assertEquals(facets[0].features, [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/adapters/bluesky-facets.test.ts`
Expected: `Module not found ... bluesky-facets.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// Bluesky stores post text raw and uses a `facets` array to mark byte
// ranges as links, mentions or tags. Without facets, URLs and @handles
// render as plain text. Byte offsets, not char offsets.

export type BskyFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
};

export type ResolveHandle = (handle: string) => Promise<string | null>;

const URL_RE = /https?:\/\/[^\s]+/g;
const TAG_RE = /(^|\s)#([A-Za-z0-9_]+)/g;
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;
// Sentence punctuation glued to the end of a URL is almost never part of it.
const URL_TAIL_PUNCT_RE = /[.,;:!?)\]'"]+$/;

export async function buildBskyFacets(
  text: string,
  resolveHandle: ResolveHandle,
): Promise<BskyFacet[]> {
  const encoder = new TextEncoder();
  const byteOffset = (charIdx: number): number => encoder.encode(text.slice(0, charIdx)).length;
  const facets: BskyFacet[] = [];

  for (const m of text.matchAll(URL_RE)) {
    if (typeof m.index !== 'number') continue;
    const uri = m[0].replace(URL_TAIL_PUNCT_RE, '');
    facets.push({
      index: { byteStart: byteOffset(m.index), byteEnd: byteOffset(m.index + uri.length) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }

  for (const m of text.matchAll(TAG_RE)) {
    if (typeof m.index !== 'number') continue;
    const lead = m[1] ?? '';
    const tag = m[2];
    if (!tag) continue;
    const start = m.index + lead.length;
    facets.push({
      index: { byteStart: byteOffset(start), byteEnd: byteOffset(start + 1 + tag.length) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }

  const mentions: Array<{ start: number; end: number; handle: string }> = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (typeof m.index !== 'number') continue;
    const lead = m[1] ?? '';
    const handle = m[2];
    if (!handle) continue;
    const start = m.index + lead.length;
    mentions.push({ start, end: start + 1 + handle.length, handle });
  }
  const resolved = await Promise.all(
    mentions.map(async (mn) => ({ ...mn, did: await resolveHandle(mn.handle) })),
  );
  for (const r of resolved) {
    if (!r.did) continue;
    facets.push({
      index: { byteStart: byteOffset(r.start), byteEnd: byteOffset(r.end) },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did: r.did }],
    });
  }

  return facets;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/adapters/bluesky-facets.test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/adapters/bluesky-facets.ts supabase/functions/_shared/adapters/bluesky-facets.test.ts
git commit -m "feat(bluesky): rich-text facets with injected handle resolver"
```

---

### Task 9: Bluesky adapter

**Files:**
- Create: `supabase/functions/_shared/adapters/bluesky.ts`
- Test: `supabase/functions/_shared/adapters/bluesky.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals, assertRejects } from '@std/assert';
import type { BlueskyTokens } from '../types.ts';
import { bodyJson, fakeFetch, fakeJwt, json, type FetchCall } from '../test-utils.ts';
import { createBlueskyAdapter, createSession } from './bluesky.ts';
import { PostError } from './types.ts';

const NOW = 1_700_000_000_000;
const inOneHour = fakeJwt(Math.floor(NOW / 1000) + 3600);
const inOneMinute = fakeJwt(Math.floor(NOW / 1000) + 60);

function tokens(accessJwt = inOneHour): BlueskyTokens {
  return {
    identifier: 'me.bsky.social',
    appPassword: 'aaaa-bbbb-cccc-dddd',
    did: 'did:plc:me',
    handle: 'me.bsky.social',
    pdsUrl: 'https://pds.example',
    accessJwt,
    refreshJwt: 'refresh-1',
  };
}

Deno.test('createSession logs in and reads the PDS from the DID doc', async () => {
  const calls: FetchCall[] = [];
  const fetch = fakeFetch({
    'com.atproto.server.createSession': (_u, init) => {
      assertEquals(bodyJson(init), { identifier: 'me.bsky.social', password: 'aaaa-bbbb-cccc-dddd' });
      return json({
        did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: inOneHour, refreshJwt: 'r',
        didDoc: { service: [{ type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] },
      });
    },
  }, calls);
  const t = await createSession('me.bsky.social', 'aaaa-bbbb-cccc-dddd', fetch);
  assertEquals(t.pdsUrl, 'https://pds.example');
  assertEquals(t.did, 'did:plc:me');
  assertEquals(calls[0].url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
});

Deno.test('createSession with a bad password is a reauth error', async () => {
  const fetch = fakeFetch({ createSession: () => json({ error: 'AuthenticationRequired' }, 401) });
  const err = await assertRejects(() => createSession('me', 'bad', fetch), PostError);
  assertEquals(err.kind, 'reauth');
});

Deno.test('refreshIfNeeded is a no-op when the access token is fresh', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(fakeFetch({}, calls));
  const out = await adapter.refreshIfNeeded(tokens(), NOW);
  assertEquals(out.changed, false);
  assertEquals(calls.length, 0);
});

Deno.test('refreshIfNeeded refreshes within the 5-minute window', async () => {
  const fetch = fakeFetch({
    'com.atproto.server.refreshSession': (_u, init) => {
      assertEquals((init.headers as Record<string, string>).authorization, 'Bearer refresh-1');
      return json({ did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: inOneHour, refreshJwt: 'refresh-2' });
    },
  });
  const adapter = createBlueskyAdapter(fetch);
  const out = await adapter.refreshIfNeeded(tokens(inOneMinute), NOW);
  assertEquals(out.changed, true);
  assertEquals(out.tokens.refreshJwt, 'refresh-2');
  assertEquals(out.tokens.appPassword, 'aaaa-bbbb-cccc-dddd'); // preserved
});

Deno.test('refreshIfNeeded falls back to a fresh login when the refresh token is dead', async () => {
  const fetch = fakeFetch({
    refreshSession: () => json({ error: 'ExpiredToken' }, 400),
    createSession: () => json({ did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: inOneHour, refreshJwt: 'refresh-3' }),
  });
  const adapter = createBlueskyAdapter(fetch);
  const out = await adapter.refreshIfNeeded(tokens(inOneMinute), NOW);
  assertEquals(out.changed, true);
  assertEquals(out.tokens.refreshJwt, 'refresh-3');
});

Deno.test('uploadImage rejects blobs over 2,000,000 bytes without a network call', async () => {
  const calls: FetchCall[] = [];
  const adapter = createBlueskyAdapter(fakeFetch({}, calls));
  const err = await assertRejects(
    () => adapter.uploadImage(tokens(), { bytes: new Uint8Array(2_000_001), mimeType: 'image/jpeg', alt: '' }),
    PostError,
  );
  assertEquals(err.kind, 'permanent');
  assertEquals(calls.length, 0);
});

Deno.test('uploadImage posts raw bytes and returns an embed image', async () => {
  const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'image/png', size: 3 };
  const fetch = fakeFetch({
    'com.atproto.repo.uploadBlob': (_u, init) => {
      assertEquals((init.headers as Record<string, string>)['content-type'], 'image/png');
      return json({ blob });
    },
  });
  const adapter = createBlueskyAdapter(fetch);
  const out = await adapter.uploadImage(tokens(), { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', alt: 'three bytes' });
  assertEquals(out, { alt: 'three bytes', image: blob });
});

Deno.test('post builds the record with facets, embed and reply refs', async () => {
  const fetch = fakeFetch({
    'com.atproto.identity.resolveHandle': () => json({ did: 'did:plc:alice' }),
    'com.atproto.repo.createRecord': (_u, init) => {
      const body = bodyJson(init) as { repo: string; collection: string; record: Record<string, unknown> };
      assertEquals(body.repo, 'did:plc:me');
      assertEquals(body.collection, 'app.bsky.feed.post');
      assertEquals(body.record.text, 'hi @alice.bsky.social');
      assertEquals((body.record.facets as unknown[]).length, 1);
      assertEquals(body.record.embed, { $type: 'app.bsky.embed.images', images: [{ alt: 'a', image: 'BLOB' }] });
      assertEquals(body.record.reply, { root: { uri: 'at://root', cid: 'c0' }, parent: { uri: 'at://p', cid: 'c1' } });
      return json({ uri: 'at://did:plc:me/app.bsky.feed.post/rkey1', cid: 'c2' });
    },
  });
  const adapter = createBlueskyAdapter(fetch);
  const ref = await adapter.post(
    tokens(),
    'hi @alice.bsky.social',
    [{ alt: 'a', image: 'BLOB' as unknown as never }],
    {
      root: { id: 'at://root', url: '', uri: 'at://root', cid: 'c0' },
      parent: { id: 'at://p', url: '', uri: 'at://p', cid: 'c1' },
    },
  );
  assertEquals(ref.url, 'https://bsky.app/profile/me.bsky.social/post/rkey1');
  assertEquals(ref.uri, 'at://did:plc:me/app.bsky.feed.post/rkey1');
  assertEquals(ref.cid, 'c2');
});

Deno.test('post surfaces a 5xx as transient', async () => {
  const fetch = fakeFetch({ createRecord: () => new Response('boom', { status: 502 }) });
  const adapter = createBlueskyAdapter(fetch);
  const err = await assertRejects(() => adapter.post(tokens(), 'x', []), PostError);
  assertEquals(err.kind, 'transient');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/adapters/bluesky.test.ts`
Expected: `Module not found ... bluesky.ts`.

- [ ] **Step 3: Write the adapter**

```ts
// Bluesky adapter over plain XRPC fetch. App-password sessions only.
// Session refresh happens here; the caller persists rotated tokens when
// `changed` is true.

import type { BlueskyTokens } from '../types.ts';
import { buildBskyFacets } from './bluesky-facets.ts';
import {
  type Adapter,
  classifyHttp,
  httpError,
  type ImageInput,
  PostError,
  type PostRef,
  type RefreshOutcome,
} from './types.ts';

export const DEFAULT_PDS = 'https://bsky.social';
const BSKY_CHAR_LIMIT = 300;
const BLOB_CAP = 2_000_000; // PDS hard limit
const REFRESH_WINDOW_MS = 5 * 60_000;

export type BskyBlobRef = {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
};
export type BskyImage = { alt: string; image: BskyBlobRef };

type SessionResponse = {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  didDoc?: { service?: Array<{ type?: string; serviceEndpoint?: string }> };
};

export function jwtExpiryMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiryDate(jwt: string): Date | null {
  const ms = jwtExpiryMs(jwt);
  return ms === null ? null : new Date(ms);
}

function pdsFromDidDoc(doc: SessionResponse['didDoc'], fallback: string): string {
  const svc = doc?.service?.find((s) => s.type === 'AtprotoPersonalDataServer');
  return svc?.serviceEndpoint ?? fallback;
}

export async function createSession(
  identifier: string,
  appPassword: string,
  fetchImpl: typeof fetch,
): Promise<BlueskyTokens> {
  const res = await fetchImpl(`${DEFAULT_PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!res.ok) {
    // 400/401 here mean the identifier or app password is wrong.
    const kind = res.status === 400 || res.status === 401 ? 'reauth' : classifyHttp(res.status);
    const body = (await res.text()).slice(0, 200);
    throw new PostError(`Bluesky login failed (HTTP ${res.status}): ${body}`, kind);
  }
  const s = (await res.json()) as SessionResponse;
  return {
    identifier,
    appPassword,
    did: s.did,
    handle: s.handle,
    pdsUrl: pdsFromDidDoc(s.didDoc, DEFAULT_PDS),
    accessJwt: s.accessJwt,
    refreshJwt: s.refreshJwt,
  };
}

export function createBlueskyAdapter(fetchImpl: typeof fetch = fetch): Adapter<BlueskyTokens, BskyImage> {
  function authHeaders(tokens: BlueskyTokens): Record<string, string> {
    return { authorization: `Bearer ${tokens.accessJwt}` };
  }

  async function resolveHandle(tokens: BlueskyTokens, handle: string): Promise<string | null> {
    try {
      const res = await fetchImpl(
        `${tokens.pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
        { method: 'GET', headers: authHeaders(tokens) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { did?: string };
      return json.did ?? null;
    } catch {
      return null;
    }
  }

  return {
    platform: 'bluesky',
    characterLimit: BSKY_CHAR_LIMIT,
    pacingMs: 1000,

    async refreshIfNeeded(tokens, nowMs): Promise<RefreshOutcome<BlueskyTokens>> {
      const exp = jwtExpiryMs(tokens.accessJwt);
      if (exp !== null && exp - nowMs > REFRESH_WINDOW_MS) {
        return { tokens, changed: false, expiresAt: new Date(exp) };
      }
      const res = await fetchImpl(`${tokens.pdsUrl}/xrpc/com.atproto.server.refreshSession`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.refreshJwt}` },
      });
      if (res.ok) {
        const s = (await res.json()) as SessionResponse;
        const next: BlueskyTokens = {
          ...tokens,
          did: s.did,
          handle: s.handle,
          accessJwt: s.accessJwt,
          refreshJwt: s.refreshJwt,
        };
        return { tokens: next, changed: true, expiresAt: expiryDate(next.accessJwt) };
      }
      if (res.status === 429 || res.status >= 500) throw await httpError(res, 'refreshSession');
      // Refresh token is dead: log in again with the stored app password.
      // If that fails too, createSession throws a reauth error.
      const fresh = await createSession(tokens.identifier, tokens.appPassword, fetchImpl);
      return { tokens: fresh, changed: true, expiresAt: expiryDate(fresh.accessJwt) };
    },

    async uploadImage(tokens, image: ImageInput): Promise<BskyImage> {
      if (image.bytes.byteLength > BLOB_CAP) {
        throw new PostError(
          `Image is ${image.bytes.byteLength} bytes; Bluesky allows at most ${BLOB_CAP}`,
          'permanent',
        );
      }
      const res = await fetchImpl(`${tokens.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { ...authHeaders(tokens), 'content-type': image.mimeType },
        body: image.bytes,
      });
      if (!res.ok) throw await httpError(res, 'uploadBlob');
      const json = (await res.json()) as { blob: BskyBlobRef };
      return { alt: image.alt, image: json.blob };
    },

    async post(tokens, text, media, replyTo): Promise<PostRef> {
      const facets = await buildBskyFacets(text, (h) => resolveHandle(tokens, h));
      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
      };
      if (facets.length > 0) record.facets = facets;
      if (media.length > 0) record.embed = { $type: 'app.bsky.embed.images', images: media };
      if (replyTo) {
        record.reply = {
          root: { uri: replyTo.root.uri, cid: replyTo.root.cid },
          parent: { uri: replyTo.parent.uri, cid: replyTo.parent.cid },
        };
      }
      const res = await fetchImpl(`${tokens.pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: { ...authHeaders(tokens), 'content-type': 'application/json' },
        body: JSON.stringify({ repo: tokens.did, collection: 'app.bsky.feed.post', record }),
      });
      if (!res.ok) throw await httpError(res, 'createRecord');
      const { uri, cid } = (await res.json()) as { uri: string; cid: string };
      const rkey = uri.split('/').pop() ?? '';
      return {
        id: uri,
        uri,
        cid,
        url: `https://bsky.app/profile/${tokens.handle}/post/${rkey}`,
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/adapters/bluesky.test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/adapters/bluesky.ts supabase/functions/_shared/adapters/bluesky.test.ts
git commit -m "feat(bluesky): XRPC adapter with session refresh, uploads, facets"
```

---

### Task 10: Chain runner

**Files:**
- Create: `supabase/functions/_shared/post-chain.ts`
- Test: `supabase/functions/_shared/post-chain.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals, assertRejects } from '@std/assert';
import type { Adapter, ImageInput, PostRef } from './adapters/types.ts';
import { PostError } from './adapters/types.ts';
import { postChain } from './post-chain.ts';

type Call = { text: string; media: string[]; replyTo?: { root: string; parent: string } };

function fakeAdapter(opts: { limit?: number; failAt?: number } = {}) {
  const calls: Call[] = [];
  const uploads: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const adapter: Adapter<{ t: string }, string> = {
    platform: 'x',
    characterLimit: opts.limit ?? 280,
    pacingMs: 2000,
    refreshIfNeeded: (tokens) => Promise.resolve({ tokens, changed: false, expiresAt: null }),
    uploadImage: (_t, img: ImageInput) => {
      uploads.push(img.alt);
      return Promise.resolve(`media-${img.alt}`);
    },
    post: (_t, text, media, replyTo) => {
      n++;
      if (opts.failAt === n) return Promise.reject(new PostError('nope', 'permanent'));
      calls.push({ text, media, replyTo: replyTo && { root: replyTo.root.id, parent: replyTo.parent.id } });
      const ref: PostRef = { id: `p${n}`, url: `https://example/${n}` };
      return Promise.resolve(ref);
    },
  };
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { adapter, calls, uploads, sleeps, sleep };
}

const img = (alt: string): ImageInput => ({ bytes: new Uint8Array(1), mimeType: 'image/png', alt });

Deno.test('single post: no suffix, images attached, no sleep', async () => {
  const f = fakeAdapter();
  const out = await postChain(f.adapter, { t: '' }, 'hello', [img('a'), img('b')], f.sleep);
  assertEquals(f.calls, [{ text: 'hello', media: ['media-a', 'media-b'], replyTo: undefined }]);
  assertEquals(f.sleeps, []);
  assertEquals(out, { url: 'https://example/1', remoteId: 'p1', posted: 1, total: 1 });
});

Deno.test('chain: images on head only, each chunk replies to the previous, paced', async () => {
  const f = fakeAdapter({ limit: 30 });
  const text = 'First sentence here. Second sentence here. Third sentence here.';
  const out = await postChain(f.adapter, { t: '' }, text, [img('a')], f.sleep);
  assertEquals(f.calls.length, 3);
  assertEquals(f.calls[0].media, ['media-a']);
  assertEquals(f.calls[1].media, []);
  assertEquals(f.calls[1].replyTo, { root: 'p1', parent: 'p1' });
  assertEquals(f.calls[2].replyTo, { root: 'p1', parent: 'p2' });
  assertEquals(f.sleeps, [2000, 2000]);
  assertEquals(out.posted, 3);
  assertEquals(out.url, 'https://example/1');
});

Deno.test('only the first four images are uploaded', async () => {
  const f = fakeAdapter();
  await postChain(f.adapter, { t: '' }, 'x', ['a', 'b', 'c', 'd', 'e'].map(img), f.sleep);
  assertEquals(f.uploads, ['a', 'b', 'c', 'd']);
});

Deno.test('head failure rethrows', async () => {
  const f = fakeAdapter({ failAt: 1 });
  await assertRejects(() => postChain(f.adapter, { t: '' }, 'x', [], f.sleep), PostError, 'nope');
});

Deno.test('later chunk failure returns the head with a partial error', async () => {
  const f = fakeAdapter({ limit: 30, failAt: 2 });
  const text = 'First sentence here. Second sentence here. Third sentence here.';
  const out = await postChain(f.adapter, { t: '' }, text, [], f.sleep);
  assertEquals(out.url, 'https://example/1');
  assertEquals(out.posted, 1);
  assertEquals(out.total, 3);
  assertEquals(out.partialError, 'nope');
});

Deno.test('empty text with no images is a permanent error', async () => {
  const f = fakeAdapter();
  const err = await assertRejects(() => postChain(f.adapter, { t: '' }, '  ', [], f.sleep), PostError);
  assertEquals(err.kind, 'permanent');
});

Deno.test('image-only post sends one empty-text chunk', async () => {
  const f = fakeAdapter();
  await postChain(f.adapter, { t: '' }, '', [img('a')], f.sleep);
  assertEquals(f.calls, [{ text: '', media: ['media-a'], replyTo: undefined }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/post-chain.test.ts`
Expected: `Module not found ... post-chain.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// Posts one piece of content to one platform: uploads the images once,
// splits the text into a chain if it overflows the platform limit, and
// posts each chunk as a reply to the previous one. Head-post failure
// throws; a later-chunk failure returns what landed plus the error.

import { type Adapter, type ImageInput, PostError, type PostRef, toPostError } from './adapters/types.ts';
import { splitIntoChain } from './text/thread-split.ts';

const MAX_IMAGES = 4;

export type ChainOutcome = {
  url: string;
  remoteId: string;
  posted: number;
  total: number;
  partialError?: string;
};

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function postChain<T, M>(
  adapter: Adapter<T, M>,
  tokens: T,
  text: string,
  images: ImageInput[],
  sleep: Sleep = realSleep,
): Promise<ChainOutcome> {
  const chunks = splitIntoChain(text, adapter.characterLimit);
  if (chunks.length === 0 && images.length === 0) {
    throw new PostError('Nothing to post: no text and no images', 'permanent');
  }
  if (chunks.length === 0) chunks.push(''); // image-only post

  const media: M[] = [];
  for (const image of images.slice(0, MAX_IMAGES)) {
    media.push(await adapter.uploadImage(tokens, image));
  }

  let head: PostRef | undefined;
  let parent: PostRef | undefined;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(adapter.pacingMs);
    try {
      const ref = await adapter.post(
        tokens,
        chunks[i],
        i === 0 ? media : [],
        head && parent ? { root: head, parent } : undefined,
      );
      if (i === 0) head = ref;
      parent = ref;
    } catch (err) {
      if (i === 0 || !head) throw err;
      return {
        url: head.url,
        remoteId: head.id,
        posted: i,
        total: chunks.length,
        partialError: toPostError(err).message,
      };
    }
  }
  return { url: head!.url, remoteId: head!.id, posted: chunks.length, total: chunks.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/post-chain.test.ts`
Expected: `ok | 7 passed | 0 failed`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/post-chain.ts supabase/functions/_shared/post-chain.test.ts
git commit -m "feat(shared): chain runner with head-only images and partial results"
```

---

### Task 11: The job (`processPost`)

**Files:**
- Create: `supabase/functions/_shared/job.ts`
- Test: `supabase/functions/_shared/job.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from '@std/assert';
import type { Adapter, ImageInput, PostRef } from './adapters/types.ts';
import { PostError } from './adapters/types.ts';
import { encryptJson, generateTokenKeyBase64, importTokenKey } from './crypto.ts';
import { type JobDb, type JobDeps, processPost } from './job.ts';
import type { AccountRow, MentionMap, Platform, PostRow, TargetResult } from './types.ts';

const NOW = new Date('2026-09-21T09:00:00Z');

class MemoryDb implements JobDb {
  accounts = new Map<string, AccountRow>();
  results = new Map<string, Partial<Record<Platform, TargetResult>>>();
  finished: Array<{ postId: string; status: string; scheduledAt?: string }> = [];
  reconnects: string[] = [];
  secrets: Array<{ platform: Platform; secret: string }> = [];
  mentionMap: MentionMap = [];

  getAccount(userId: string, platform: Platform) {
    return Promise.resolve(this.accounts.get(`${userId}:${platform}`) ?? null);
  }
  saveAccountSecret(_u: string, platform: Platform, secret: string) {
    this.secrets.push({ platform, secret });
    return Promise.resolve();
  }
  markAccountNeedsReconnect(_u: string, platform: Platform) {
    this.reconnects.push(platform);
    return Promise.resolve();
  }
  getMentionMap() {
    return Promise.resolve(this.mentionMap);
  }
  saveTargetResult(postId: string, platform: Platform, result: TargetResult) {
    this.results.set(postId, { ...(this.results.get(postId) ?? {}), [platform]: result });
    return Promise.resolve();
  }
  finishPost(postId: string, status: 'scheduled' | 'done' | 'failed', scheduledAt?: string) {
    this.finished.push({ postId, status, scheduledAt });
    return Promise.resolve();
  }
}

function stubAdapter(platform: Platform, behaviour: { fail?: PostError; refresh?: boolean } = {}) {
  const posted: string[] = [];
  const adapter: Adapter<{ tok: string }, string> = {
    platform,
    characterLimit: 300,
    pacingMs: 0,
    refreshIfNeeded: (tokens) =>
      Promise.resolve(
        behaviour.refresh
          ? { tokens: { tok: 'rotated' }, changed: true, expiresAt: new Date(NOW.getTime() + 3600_000) }
          : { tokens, changed: false, expiresAt: null },
      ),
    uploadImage: (_t, img: ImageInput) => Promise.resolve(`m-${img.alt}`),
    post: (_t, text) => {
      if (behaviour.fail) return Promise.reject(behaviour.fail);
      posted.push(text);
      const ref: PostRef = { id: `${platform}-1`, url: `https://${platform}/1` };
      return Promise.resolve(ref);
    },
  };
  return { adapter, posted };
}

async function setup(opts: {
  targets?: Platform[];
  results?: PostRow['results'];
  bluesky?: ReturnType<typeof stubAdapter>;
  x?: ReturnType<typeof stubAdapter>;
  accountStatus?: 'ok' | 'needs_reconnect';
} = {}) {
  const key = await importTokenKey(generateTokenKeyBase64());
  const db = new MemoryDb();
  for (const p of ['bluesky', 'x'] as Platform[]) {
    db.accounts.set(`u1:${p}`, {
      user_id: 'u1', platform: p, handle: `me@${p}`, secret: await encryptJson(key, { tok: 'orig' }),
      expires_at: null, status: opts.accountStatus ?? 'ok', updated_at: NOW.toISOString(),
    });
  }
  const bluesky = opts.bluesky ?? stubAdapter('bluesky');
  const x = opts.x ?? stubAdapter('x');
  const post: PostRow = {
    id: 'p1', user_id: 'u1', status: 'posting', scheduled_at: NOW.toISOString(),
    text: 'hello @alice', variants: {}, media: [], targets: opts.targets ?? ['bluesky', 'x'],
    results: opts.results ?? {}, posting_started_at: NOW.toISOString(),
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  const deps: JobDeps = {
    db, key, now: () => NOW, sleep: () => Promise.resolve(),
    adapters: { bluesky: bluesky.adapter, x: x.adapter },
    downloadMedia: () => Promise.resolve(new Uint8Array([1])),
  };
  return { db, post, deps, bluesky, x };
}

Deno.test('posts to every target and finishes done', async () => {
  const s = await setup();
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'done');
  assertEquals(out.results.bluesky?.state, 'sent');
  assertEquals(out.results.bluesky?.url, 'https://bluesky/1');
  assertEquals(out.results.x?.state, 'sent');
  assertEquals(s.db.finished, [{ postId: 'p1', status: 'done', scheduledAt: undefined }]);
});

Deno.test('applies the mention map per platform', async () => {
  const s = await setup();
  s.db.mentionMap = [{ bluesky: 'alice.bsky.social', x: 'alice_x' }];
  await processPost(s.post, s.deps);
  assertEquals(s.bluesky.posted, ['hello @alice.bsky.social']);
  assertEquals(s.x.posted, ['hello @alice_x']);
});

Deno.test('uses a per-platform variant when present', async () => {
  const s = await setup();
  s.post.variants = { x: 'x-only text' };
  await processPost(s.post, s.deps);
  assertEquals(s.bluesky.posted, ['hello alice']);
  assertEquals(s.x.posted, ['x-only text']);
});

Deno.test('skips targets already sent (rerun after a crash is idempotent)', async () => {
  const s = await setup({ results: { bluesky: { state: 'sent', attempts: 1, url: 'https://bluesky/old' } } });
  const out = await processPost(s.post, s.deps);
  assertEquals(s.bluesky.posted, []);
  assertEquals(s.x.posted.length, 1);
  assertEquals(out.results.bluesky?.url, 'https://bluesky/old');
  assertEquals(out.status, 'done');
});

Deno.test('transient failure schedules a retry 5 minutes later', async () => {
  const x = stubAdapter('x', { fail: new PostError('HTTP 503', 'transient') });
  const s = await setup({ x });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'scheduled');
  assertEquals(out.results.x, {
    state: 'pending', attempts: 1, error: 'HTTP 503',
    nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  });
  assertEquals(out.results.bluesky?.state, 'sent');
  assertEquals(s.db.finished[0].scheduledAt, new Date(NOW.getTime() + 5 * 60_000).toISOString());
});

Deno.test('third transient failure becomes permanent', async () => {
  const x = stubAdapter('x', { fail: new PostError('HTTP 503', 'transient') });
  const s = await setup({ x, targets: ['x'], results: { x: { state: 'pending', attempts: 2 } } });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'failed');
  assertEquals(out.results.x?.state, 'failed');
  assertEquals(out.results.x?.attempts, 3);
});

Deno.test('permanent failure fails the target immediately', async () => {
  const x = stubAdapter('x', { fail: new PostError('duplicate', 'permanent') });
  const s = await setup({ x, targets: ['x'] });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'failed');
  assertEquals(out.results.x, { state: 'failed', attempts: 1, error: 'duplicate' });
});

Deno.test('reauth failure marks the account and fails the target', async () => {
  const x = stubAdapter('x', { fail: new PostError('token revoked', 'reauth') });
  const s = await setup({ x, targets: ['x'] });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'failed');
  assertEquals(s.db.reconnects, ['x']);
});

Deno.test('an account already needing reconnect fails without posting', async () => {
  const s = await setup({ targets: ['bluesky'], accountStatus: 'needs_reconnect' });
  const out = await processPost(s.post, s.deps);
  assertEquals(out.status, 'failed');
  assertEquals(s.bluesky.posted, []);
  assertEquals(out.results.bluesky?.error?.includes('reconnect'), true);
});

Deno.test('a pending target whose retry time is in the future is left alone', async () => {
  const later = new Date(NOW.getTime() + 60_000).toISOString();
  const s = await setup({ targets: ['x'], results: { x: { state: 'pending', attempts: 1, nextAttemptAt: later } } });
  const out = await processPost(s.post, s.deps);
  assertEquals(s.x.posted, []);
  assertEquals(out.status, 'scheduled');
  assertEquals(s.db.finished[0].scheduledAt, later);
});

Deno.test('persists rotated tokens when the adapter refreshed', async () => {
  const bluesky = stubAdapter('bluesky', { refresh: true });
  const s = await setup({ bluesky, targets: ['bluesky'] });
  await processPost(s.post, s.deps);
  assertEquals(s.db.secrets.length, 1);
  assertEquals(s.db.secrets[0].platform, 'bluesky');
});

Deno.test('downloads media once and passes it to every target', async () => {
  let downloads = 0;
  const s = await setup();
  s.post.media = [{ storagePath: 'u1/p1/0', mimeType: 'image/png', alt: 'pic' }];
  s.deps.downloadMedia = () => {
    downloads++;
    return Promise.resolve(new Uint8Array([1]));
  };
  const out = await processPost(s.post, s.deps);
  assertEquals(downloads, 1);
  assertEquals(out.status, 'done');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/job.test.ts`
Expected: `Module not found ... job.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// processPost: post one claimed row to each of its targets, writing each
// target's result as soon as it is known so a crash mid-way never causes
// a duplicate on the next run. Pure of Supabase: everything it needs
// comes through JobDeps.

import { type AnyAdapter, PostError, toPostError, type ImageInput } from './adapters/types.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { postChain, type Sleep } from './post-chain.ts';
import { formatForPlatform } from './text/format.ts';
import type { AccountRow, MentionMap, Platform, PostRow, TargetResult } from './types.ts';

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 5 * 60_000;
const MAX_IMAGES = 4;

export interface JobDb {
  getAccount(userId: string, platform: Platform): Promise<AccountRow | null>;
  saveAccountSecret(
    userId: string,
    platform: Platform,
    secret: string,
    expiresAt: string | null,
  ): Promise<void>;
  markAccountNeedsReconnect(userId: string, platform: Platform): Promise<void>;
  getMentionMap(userId: string): Promise<MentionMap>;
  saveTargetResult(postId: string, platform: Platform, result: TargetResult): Promise<void>;
  finishPost(
    postId: string,
    status: 'scheduled' | 'done' | 'failed',
    scheduledAt?: string,
  ): Promise<void>;
}

export type JobDeps = {
  db: JobDb;
  key: CryptoKey;
  adapters: Partial<Record<Platform, AnyAdapter>>;
  now: () => Date;
  sleep: Sleep;
  downloadMedia: (storagePath: string) => Promise<Uint8Array>;
};

export type JobResult = {
  status: 'scheduled' | 'done' | 'failed';
  results: PostRow['results'];
};

export async function processPost(post: PostRow, deps: JobDeps): Promise<JobResult> {
  const now = deps.now();
  const results: PostRow['results'] = { ...post.results };
  const mentionMap = await deps.db.getMentionMap(post.user_id);

  // Images are downloaded lazily and once, then shared across targets.
  let images: Promise<ImageInput[]> | null = null;
  const loadImages = (): Promise<ImageInput[]> => {
    images ??= Promise.all(
      post.media.slice(0, MAX_IMAGES).map(async (m) => ({
        bytes: await deps.downloadMedia(m.storagePath),
        mimeType: m.mimeType,
        alt: m.alt,
      })),
    );
    return images;
  };

  for (const platform of post.targets) {
    const prev: TargetResult = results[platform] ?? { state: 'pending', attempts: 0 };
    if (prev.state !== 'pending') continue; // sent, or failed awaiting manual retry
    if (prev.nextAttemptAt && new Date(prev.nextAttemptAt) > now) continue;

    const result = await postToTarget(post, platform, prev, deps, mentionMap, loadImages, now);
    results[platform] = result;
    await deps.db.saveTargetResult(post.id, platform, result);
  }

  const states = post.targets.map((p) => results[p]?.state ?? 'pending');
  let status: JobResult['status'];
  let scheduledAt: string | undefined;
  if (states.every((s) => s === 'sent')) {
    status = 'done';
  } else if (states.some((s) => s === 'pending')) {
    status = 'scheduled';
    // Wake up again at the earliest pending retry time.
    scheduledAt = post.targets
      .map((p) => results[p]?.nextAttemptAt)
      .filter((t): t is string => Boolean(t))
      .sort()[0];
  } else {
    status = 'failed';
  }
  await deps.db.finishPost(post.id, status, scheduledAt);
  return { status, results };
}

async function postToTarget(
  post: PostRow,
  platform: Platform,
  prev: TargetResult,
  deps: JobDeps,
  mentionMap: MentionMap,
  loadImages: () => Promise<ImageInput[]>,
  now: Date,
): Promise<TargetResult> {
  const attempts = prev.attempts + 1;
  try {
    const adapter = deps.adapters[platform];
    if (!adapter) throw new PostError(`${platform} is not configured on the server`, 'permanent');

    const account = await deps.db.getAccount(post.user_id, platform);
    if (!account) throw new PostError(`No ${platform} account connected`, 'permanent');
    if (account.status === 'needs_reconnect') {
      throw new PostError(`${platform} account needs to be reconnected`, 'permanent');
    }

    let tokens = await decryptJson(deps.key, account.secret);
    const refreshed = await adapter.refreshIfNeeded(tokens, now.getTime());
    if (refreshed.changed) {
      await deps.db.saveAccountSecret(
        post.user_id,
        platform,
        await encryptJson(deps.key, refreshed.tokens),
        refreshed.expiresAt?.toISOString() ?? null,
      );
    }
    tokens = refreshed.tokens;

    const text = formatForPlatform(post.variants[platform] ?? post.text, { platform, mentionMap }).text;
    const images = post.media.length > 0 ? await loadImages() : [];
    const out = await postChain(adapter, tokens, text, images, deps.sleep);

    const result: TargetResult = { state: 'sent', attempts, url: out.url, remoteId: out.remoteId };
    if (out.partialError) {
      result.error = `Posted ${out.posted} of ${out.total}: ${out.partialError}`;
    }
    return result;
  } catch (err) {
    const pe = toPostError(err);
    if (pe.kind === 'reauth') {
      await deps.db.markAccountNeedsReconnect(post.user_id, platform);
      return { state: 'failed', attempts, error: pe.message };
    }
    if (pe.kind === 'transient' && attempts < MAX_ATTEMPTS) {
      return {
        state: 'pending',
        attempts,
        error: pe.message,
        nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      };
    }
    return { state: 'failed', attempts, error: pe.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/job.test.ts`
Expected: `ok | 12 passed | 0 failed`.

- [ ] **Step 5: Run the whole suite**

Run: `deno task test`
Expected: all tests pass (5 + 6 + 4 + 2 + 3 + 9 + 7 + 12 = 48).

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/_shared/job.ts supabase/functions/_shared/job.test.ts
git commit -m "feat(job): per-target posting with idempotent results and retry classification"
```

---

### Task 12: Supabase-backed JobDb and HTTP helpers

**Files:**
- Create: `supabase/functions/_shared/db.ts`
- Create: `supabase/functions/_shared/http.ts`

These are thin wrappers over supabase-js with no unit tests; the live smoke test in Task 15 covers them.

- [ ] **Step 1: Write `db.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobDb } from './job.ts';
import type { AccountRow, MentionMap, Platform, TargetResult } from './types.ts';

export function makeJobDb(supabase: SupabaseClient): JobDb {
  return {
    async getAccount(userId, platform) {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', platform)
        .maybeSingle();
      if (error) throw error;
      return (data as AccountRow | null) ?? null;
    },

    async saveAccountSecret(userId, platform, secret, expiresAt) {
      const { error } = await supabase
        .from('accounts')
        .update({ secret, expires_at: expiresAt, status: 'ok' })
        .eq('user_id', userId)
        .eq('platform', platform);
      if (error) throw error;
    },

    async markAccountNeedsReconnect(userId, platform) {
      const { error } = await supabase
        .from('accounts')
        .update({ status: 'needs_reconnect' })
        .eq('user_id', userId)
        .eq('platform', platform);
      if (error) throw error;
    },

    async getMentionMap(userId) {
      const { data, error } = await supabase
        .from('settings')
        .select('mention_map')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return ((data?.mention_map as MentionMap | undefined) ?? []);
    },

    async saveTargetResult(postId, platform: Platform, result: TargetResult) {
      const { error } = await supabase.rpc('set_target_result', {
        p_post_id: postId,
        p_platform: platform,
        p_result: result,
      });
      if (error) throw error;
    },

    async finishPost(postId, status, scheduledAt) {
      const patch: Record<string, unknown> = { status, posting_started_at: null };
      if (scheduledAt) patch.scheduled_at = scheduledAt;
      const { error } = await supabase.from('posts').update(patch).eq('id', postId);
      if (error) throw error;
    },
  };
}

export async function downloadMedia(supabase: SupabaseClient, storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from('post-media').download(storagePath);
  if (error || !data) throw new Error(`download ${storagePath}: ${error?.message ?? 'no data'}`);
  return new Uint8Array(await data.arrayBuffer());
}
```

- [ ] **Step 2: Write `http.ts`**

```ts
import { createClient } from '@supabase/supabase-js';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// Resolves the calling user from the bearer token. Returns null for a
// missing or invalid token. Uses the anon key so RLS semantics match
// what the PWA would see.
export async function requireUser(req: Request): Promise<{ id: string; email?: string } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? undefined };
}
```

- [ ] **Step 3: Type-check**

Run: `deno check supabase/functions/_shared/db.ts supabase/functions/_shared/http.ts`
Expected: success (the first run downloads `npm:@supabase/supabase-js@2`).

- [ ] **Step 4: Commit**

```powershell
git add supabase/functions/_shared/db.ts supabase/functions/_shared/http.ts
git commit -m "feat(shared): supabase-backed JobDb and HTTP helpers"
```

---

### Task 13: Edge Functions `run-due-posts` and `connect-bluesky`

**Files:**
- Create: `supabase/functions/run-due-posts/index.ts`
- Create: `supabase/functions/connect-bluesky/index.ts`

- [ ] **Step 1: Write `run-due-posts/index.ts`**

```ts
// Called every minute by pg_cron (see migrations/..._cron.sql). Claims
// due posts and processes them sequentially so per-platform pacing is
// honoured. Authenticated by a shared CRON_SECRET header, independent
// of Supabase key formats.

import { createClient } from '@supabase/supabase-js';
import { createBlueskyAdapter } from '../_shared/adapters/bluesky.ts';
import { importTokenKey } from '../_shared/crypto.ts';
import { downloadMedia, makeJobDb } from '../_shared/db.ts';
import { env, jsonResponse } from '../_shared/http.ts';
import { type JobDeps, processPost } from '../_shared/job.ts';
import { realSleep } from '../_shared/post-chain.ts';
import type { PostRow } from '../_shared/types.ts';

const BATCH = 5;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (req.headers.get('x-cron-secret') !== env('CRON_SECRET')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const key = await importTokenKey(env('TOKEN_KEY'));

  const { data, error } = await supabase.rpc('claim_due_posts', { batch: BATCH });
  if (error) return jsonResponse({ error: error.message }, 500);
  const posts = (data ?? []) as PostRow[];

  const deps: JobDeps = {
    db: makeJobDb(supabase),
    key,
    adapters: { bluesky: createBlueskyAdapter(fetch) },
    now: () => new Date(),
    sleep: realSleep,
    downloadMedia: (path) => downloadMedia(supabase, path),
  };

  const summary: Array<{ id: string; status: string }> = [];
  for (const post of posts) {
    try {
      const out = await processPost(post, deps);
      summary.push({ id: post.id, status: out.status });
    } catch (err) {
      // processPost handles adapter errors itself; this catches DB
      // failures. Leave the row in 'posting' — claim_due_posts requeues
      // it after 10 minutes.
      console.error('processPost crashed', post.id, err);
      summary.push({ id: post.id, status: `crashed: ${String(err).slice(0, 200)}` });
    }
  }
  return jsonResponse({ claimed: posts.length, summary });
});
```

- [ ] **Step 2: Write `connect-bluesky/index.ts`**

```ts
// Stores a Bluesky app-password session for the calling user. The PWA
// posts { identifier, appPassword }; we log in once to validate, then
// keep the encrypted session + app password so the job can refresh or
// re-login without user involvement.

import { createClient } from '@supabase/supabase-js';
import { createSession, jwtExpiryMs } from '../_shared/adapters/bluesky.ts';
import { PostError } from '../_shared/adapters/types.ts';
import { encryptJson, importTokenKey } from '../_shared/crypto.ts';
import { corsHeaders, env, jsonResponse, requireUser } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  const user = await requireUser(req);
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { identifier?: string; appPassword?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  const identifier = body.identifier?.trim().replace(/^@/, '');
  const appPassword = body.appPassword?.trim();
  if (!identifier || !appPassword) {
    return jsonResponse({ error: 'identifier and appPassword are required' }, 400);
  }

  try {
    const tokens = await createSession(identifier, appPassword, fetch);
    const key = await importTokenKey(env('TOKEN_KEY'));
    const exp = jwtExpiryMs(tokens.accessJwt);
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin.from('accounts').upsert({
      user_id: user.id,
      platform: 'bluesky',
      handle: tokens.handle,
      secret: await encryptJson(key, tokens),
      expires_at: exp === null ? null : new Date(exp).toISOString(),
      status: 'ok',
    });
    if (error) throw error;
    return jsonResponse({ handle: tokens.handle });
  } catch (err) {
    const status = err instanceof PostError && err.kind === 'reauth' ? 401 : 502;
    return jsonResponse({ error: String(err).slice(0, 300) }, status);
  }
});
```

- [ ] **Step 3: Type-check both functions**

Run: `deno check supabase/functions/run-due-posts/index.ts supabase/functions/connect-bluesky/index.ts`
Expected: success.

- [ ] **Step 4: Commit**

```powershell
git add supabase/functions/run-due-posts supabase/functions/connect-bluesky
git commit -m "feat(functions): run-due-posts scheduler and connect-bluesky"
```

---

### Task 14: Cron migration, secrets, and deploy

**Files:**
- Create: `supabase/migrations/20260921000002_cron.sql`
- Create: `docs/SETUP.md`

- [ ] **Step 1: Write the cron migration**

```sql
-- Every minute, call the run-due-posts Edge Function. The function URL
-- and the shared secret are read from Vault so nothing sensitive is in
-- the migration. Set them once with:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random>', 'cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'run-due-posts',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/run-due-posts',
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

- [ ] **Step 2: Write `docs/SETUP.md`**

```markdown
# One-time setup

## 1. Generate secrets (PowerShell)

```powershell
$tokenKey  = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
$cronSecret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
"TOKEN_KEY=$tokenKey"; "CRON_SECRET=$cronSecret"
```

Keep both somewhere safe (a password manager). Losing TOKEN_KEY means reconnecting every account.

## 2. Link and push the schema

```powershell
npx supabase login
npx supabase link --project-ref zexbkbkobqdosezkuuqj
npx supabase db push
```

## 3. Vault secrets (Supabase dashboard → SQL editor)

```sql
select vault.create_secret('you@example.com', 'owner_email');
select vault.create_secret('https://zexbkbkobqdosezkuuqj.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET from step 1>', 'cron_secret');
```

## 4. Edge Function secrets

```powershell
npx supabase secrets set TOKEN_KEY="<TOKEN_KEY>" CRON_SECRET="<CRON_SECRET>"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 5. Deploy the functions

```powershell
npx supabase functions deploy run-due-posts connect-bluesky
```

## 6. Bluesky app password

Bluesky app → Settings → Privacy and security → App passwords → Add. Name it "CrossPosty".

## 7. Live smoke test

Create `.env.smoke` in the repo root (gitignored):

```
SUPABASE_URL=https://zexbkbkobqdosezkuuqj.supabase.co
SUPABASE_ANON_KEY=<anon / publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service role / secret key>
CRON_SECRET=<CRON_SECRET>
OWNER_EMAIL=you@example.com
BSKY_IDENTIFIER=you.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

Then `deno task smoke` (text only) or `deno task smoke -- --image C:\path\to\small.jpg`.
```

- [ ] **Step 3: Run the setup through step 5**

Follow `docs/SETUP.md` steps 1–5. Expected outputs:

- `npx supabase db push`: lists both migrations and ends with `Finished supabase db push.`
- `npx supabase functions deploy ...`: ends with both functions listed as deployed.

If `db push` fails on `create trigger ... on auth.users`, the linked database role lacks rights on `auth`; run that trigger's `create function` + `create trigger` statements in the dashboard SQL editor instead and re-run `db push`.

- [ ] **Step 4: Confirm the cron is firing**

Dashboard → SQL editor:

```sql
select jobid, status, return_message, start_time
  from cron.job_run_details
 order by start_time desc limit 5;
```

Expected: rows appearing each minute with `status = succeeded`. Then check the function logs (Dashboard → Edge Functions → run-due-posts → Logs) for 200 responses with `{"claimed":0,"summary":[]}`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260921000002_cron.sql docs/SETUP.md
git commit -m "feat(db): pg_cron schedule for run-due-posts; setup docs"
```

---

### Task 15: Live smoke test

**Files:**
- Create: `scripts/live-smoke.ts`

- [ ] **Step 1: Write the script**

```ts
// End-to-end check against the real project and a real Bluesky account:
//   1. ensure the owner user exists and mint a session for it
//   2. connect Bluesky through the connect-bluesky function
//   3. optionally upload an image to post-media
//   4. insert a post scheduled for now, targets ['bluesky']
//   5. invoke run-due-posts with the cron secret
//   6. print the resulting row
// Run: deno task smoke [-- --image path.jpg] [--text "..."]

import { createClient } from '@supabase/supabase-js';
import { parseArgs } from 'jsr:@std/cli@1/parse-args';

const need = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing ${k} in .env.smoke`);
  return v;
};

const args = parseArgs(Deno.args, { string: ['image', 'text'] });
const url = need('SUPABASE_URL');
const admin = createClient(url, need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, need('SUPABASE_ANON_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1. owner user + session
const email = need('OWNER_EMAIL');
const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
let user = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  user = data.user;
  console.log('created owner user', user.id);
}
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
if (linkErr) throw linkErr;
const { data: session, error: otpErr } = await anon.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type: 'magiclink',
});
if (otpErr || !session.session) throw otpErr ?? new Error('no session');
const jwt = session.session.access_token;
console.log('session ok for', user.id);

// 2. connect Bluesky
const connect = await fetch(`${url}/functions/v1/connect-bluesky`, {
  method: 'POST',
  headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: need('BSKY_IDENTIFIER'), appPassword: need('BSKY_APP_PASSWORD') }),
});
console.log('connect-bluesky', connect.status, await connect.text());
if (!connect.ok) Deno.exit(1);

// 3. optional image
const postId = crypto.randomUUID();
const media: Array<{ storagePath: string; mimeType: string; alt: string }> = [];
if (args.image) {
  const bytes = await Deno.readFile(args.image);
  const mimeType = args.image.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const storagePath = `${user.id}/${postId}/0`;
  const { error } = await admin.storage.from('post-media').upload(storagePath, bytes, { contentType: mimeType });
  if (error) throw error;
  media.push({ storagePath, mimeType, alt: 'CrossPosty smoke test image' });
  console.log('uploaded', storagePath, bytes.byteLength, 'bytes');
}

// 4. insert the post
const text = args.text ?? `CrossPosty smoke test ${new Date().toISOString()} https://example.com #crossposty`;
const { error: insErr } = await admin.from('posts').insert({
  id: postId,
  user_id: user.id,
  status: 'scheduled',
  scheduled_at: new Date().toISOString(),
  text,
  media,
  targets: ['bluesky'],
});
if (insErr) throw insErr;
console.log('inserted post', postId);

// 5. run the job now
const run = await fetch(`${url}/functions/v1/run-due-posts`, {
  method: 'POST',
  headers: { 'x-cron-secret': need('CRON_SECRET'), 'content-type': 'application/json' },
  body: '{}',
});
console.log('run-due-posts', run.status, await run.text());

// 6. show the row
const { data: row } = await admin.from('posts').select('status, results').eq('id', postId).single();
console.log(JSON.stringify(row, null, 2));
Deno.exit(row?.status === 'done' ? 0 : 1);
```

- [ ] **Step 2: Add the cli import to the import map**

Edit `supabase/functions/import_map.json` to:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "@std/assert": "jsr:@std/assert@1",
    "@std/cli": "jsr:@std/cli@1"
  }
}
```

And change the script's import to `import { parseArgs } from '@std/cli/parse-args';`.

- [ ] **Step 3: Create `.env.smoke`** per `docs/SETUP.md` step 7.

- [ ] **Step 4: Run the text-only smoke test**

Run: `deno task smoke`
Expected: ends with a row like

```json
{
  "status": "done",
  "results": { "bluesky": { "state": "sent", "attempts": 1, "url": "https://bsky.app/profile/<handle>/post/<rkey>", "remoteId": "at://..." } }
}
```

Open the URL: the post exists, the link is clickable, the hashtag is a tag.

- [ ] **Step 5: Run the image and thread smoke tests**

Run: `deno task smoke -- --image C:\path\to\a-small.jpg` (under 2 MB)
Expected: `status: done`, and the Bluesky post shows the image with alt text.

Run: `deno task smoke -- --text "<paste 700+ characters of prose with several sentences>"`
Expected: `status: done`; on Bluesky the head post is followed by replies numbered `2/3`, `3/3`.

- [ ] **Step 6: Verify the scheduled path (not just the direct invoke)**

Dashboard → SQL editor:

```sql
insert into posts (user_id, status, scheduled_at, text, targets)
values ('<owner user id>', 'scheduled', now() + interval '2 minutes', 'CrossPosty cron test', '{bluesky}');
```

Wait 3 minutes, then `select status, results from posts order by created_at desc limit 1;`
Expected: `done` with a Bluesky URL, without running anything by hand.

- [ ] **Step 7: Commit**

```powershell
git add scripts/live-smoke.ts supabase/functions/import_map.json
git commit -m "test: live smoke script for Bluesky end to end"
```

---

### Task 16: Push the repo and record the state

- [ ] **Step 1: Create the GitHub repo and push**

```powershell
gh repo create CrossPosty-mobile --private --source . --push
```

Expected: repo created under your GitHub account, `main` pushed.

- [ ] **Step 2: Add a pointer in the old extension repo's README**

In `C:\Users\drice\CrossPosty\README.md`, insert after the first heading:

```markdown
> **Superseded.** Development moved to [CrossPosty-mobile](https://github.com/<your-account>/CrossPosty-mobile): a phone-only PWA with server-side scheduling. This extension is kept for its history (Threads / Substack adapters) and is no longer maintained.
```

Commit there:

```powershell
Set-Location C:\Users\drice\CrossPosty
git add README.md
git commit -m "docs: point at CrossPosty-mobile as the successor"
```

Done. Plan 2 (X adapter + OAuth) starts from this state.

---

## Self-review

**Spec coverage (Plan 1 scope):** data model ✔ (Task 6); token encryption ✔ (5); claim with SKIP LOCKED + 10-minute requeue ✔ (6); per-target immediate result writes ✔ (11, 12); transient/permanent/reauth classification, 3 attempts, 5-minute delay ✔ (7, 11); Bluesky: app password, refresh + fallback login, images with alt, facets, chaining with 1 s pacing ✔ (9, 10); cron every minute ✔ (14); owner-email lock ✔ (6); private bucket with per-user paths ✔ (6); live smoke ✔ (15). Deferred to later plans: X (2), PWA + `post-now` + settings UI (3), push notifications + storage cleanup cron + relay teardown (4). The spec's "image resize" moved to the PWA (Plan 3), recorded in the spec amendments.

**Placeholders:** none. Every code step is complete. Task 6 step 2 and Task 12 note deliberately that SQL / thin wrappers are verified by the smoke test rather than unit tests.

**Type consistency:** `Adapter<T, M>` (Task 7) is used identically in Tasks 9, 10, 11. `PostRef` carries `id`, `url`, optional `uri`/`cid`; the Bluesky adapter fills all four and the chain runner passes `{root, parent}` back. `JobDb` methods in Task 11's test fake, Task 11's interface, and Task 12's implementation share the same names and signatures (`finishPost(postId, status, scheduledAt?)`). `TargetResult.attempts` is required everywhere. `formatForPlatform` takes `{ platform, mentionMap }` in Tasks 4 and 11.
