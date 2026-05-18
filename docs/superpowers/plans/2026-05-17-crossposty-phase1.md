# CrossPosty Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MV3 Chrome extension that intercepts compose actions on X and BlueSky, surfaces a per-platform editable composer panel, and cross-posts to BlueSky, Mastodon, and LinkedIn with encrypted local credentials.

**Architecture:** WXT-based extension. Content scripts monkey-patch `window.fetch` in MAIN world on x.com / bsky.app to capture compose payloads, then mount a Shadow-DOM React composer panel. A platform-adapter registry fans out posts (BlueSky AT Proto, Mastodon `masto`, LinkedIn voyager session-cookie). Credentials live in `chrome.storage.local`, encrypted with a device-local AES-GCM WebCrypto key.

**Tech Stack:** TypeScript 5.3+, WXT, React 18, Tailwind, shadcn/ui, Zustand, Dexie, `@atproto/api`, `masto`, Vitest, Biome, pnpm.

**Source spec:** `C:\Users\drice\Downloads\Readme.md` (treat that as the authoritative product spec; this plan is the execution sequence).

---

## Conventions

- Working directory: `C:\Users\drice\CrossPosty` (currently empty; first task initializes it).
- Shell: bash (Windows). Use Unix-style paths in commands. `pnpm` is the package manager.
- Commit after every task. Use Conventional Commits (`feat:`, `chore:`, `test:`, `docs:`, `fix:`).
- Tests use Vitest. Only platform adapters, crypto, and credentials storage are required to have tests in Phase 1. UI is manually verified.
- Never log credentials. Use `lib/logger.ts` which strips obvious secrets.
- TypeScript strict mode on. No `any` without an inline justification comment.
- Each step is ≤5 min of work. If a task feels bigger, split it.

---

## File Structure

```
crosspost-ext/
├── package.json
├── pnpm-lock.yaml
├── wxt.config.ts
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── README.md
├── NOTES.md
├── LICENSE
├── .gitignore
├── docs/superpowers/plans/2026-05-17-crossposty-phase1.md  (this file)
├── src/
│   ├── entrypoints/
│   │   ├── background.ts
│   │   ├── popup/
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   └── pages/{Accounts,Settings,About}.tsx
│   │   ├── x.content.ts
│   │   └── bsky.content.ts
│   ├── platforms/
│   │   ├── types.ts
│   │   ├── bluesky.ts
│   │   ├── mastodon.ts
│   │   ├── linkedin.ts
│   │   ├── x.ts
│   │   └── index.ts
│   ├── interceptors/
│   │   ├── types.ts
│   │   ├── x.ts
│   │   └── bsky.ts
│   ├── composer/
│   │   ├── ComposerPanel.tsx
│   │   ├── PlatformVariant.tsx
│   │   ├── mount.ts
│   │   └── styles.css
│   ├── storage/
│   │   ├── credentials.ts
│   │   ├── settings.ts
│   │   └── schema.ts
│   ├── lib/
│   │   ├── crypto.ts
│   │   ├── messaging.ts
│   │   └── logger.ts
│   └── assets/{icon-16,icon-48,icon-128}.png
└── tests/
    ├── platforms/{bluesky,mastodon,linkedin}.test.ts
    └── crypto.test.ts
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md`, `NOTES.md`
- Create: `src/entrypoints/background.ts`, `src/entrypoints/popup/{index.html,main.tsx,App.tsx}`

- [ ] **Step 1.1: Initialize git + pnpm**

```bash
cd /c/Users/drice/CrossPosty
git init -b main
pnpm init
```

- [ ] **Step 1.2: Install WXT and bootstrap**

```bash
pnpm add -D wxt typescript@^5.3 @types/node
pnpm dlx wxt@latest init . --template react --pm pnpm
```

If `wxt init` refuses because the directory is non-empty, run it into `.tmp-wxt/` and merge files manually; document the chosen approach in `NOTES.md`.

- [ ] **Step 1.3: Install runtime deps**

```bash
pnpm add react@^18.3 react-dom@^18.3 zustand@^4.5 dexie@^4 @atproto/api masto
pnpm add -D @types/react @types/react-dom tailwindcss postcss autoprefixer @biomejs/biome vitest @vitest/ui happy-dom
```

- [ ] **Step 1.4: Configure Tailwind**

Create `tailwind.config.ts` and `postcss.config.js` per shadcn/ui standard. Add `@tailwind` directives in `src/entrypoints/popup/style.css`. Wire into popup `index.html`.

- [ ] **Step 1.5: Configure Biome**

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": { "include": ["src/**", "tests/**"] },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "organizeImports": { "enabled": true }
}
```

- [ ] **Step 1.6: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 1.7: Configure wxt.config.ts**

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'CrossPosty',
    description: 'Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn.',
    permissions: ['storage', 'cookies', 'scripting', 'identity', 'alarms', 'offscreen'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://bsky.app/*',
      'https://bsky.social/*',
      'https://www.linkedin.com/*',
    ],
  },
  modules: ['@wxt-dev/module-react'],
});
```

```bash
pnpm add -D @wxt-dev/module-react
```

- [ ] **Step 1.8: Stub entrypoints**

`src/entrypoints/background.ts`:

```ts
export default defineBackground(() => {
  console.log('[CrossPosty] background loaded');
});
```

Popup files: minimal React app that renders `<App />` with a heading "CrossPosty".

- [ ] **Step 1.9: Add LICENSE (MIT) and README**

`LICENSE`: standard MIT, copyright 2026 drice233.

`README.md`: Title, one-paragraph description, install/dev instructions:

```markdown
# CrossPosty

Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn.

## Development

1. `pnpm install`
2. `pnpm dev` — launches Chrome with the extension loaded
3. `pnpm build` — produces `.output/chrome-mv3/` (loadable as unpacked extension)
4. `pnpm test` — runs unit tests

## Status

Phase 1 in progress. See `docs/superpowers/plans/` for the implementation plan.
```

`NOTES.md`: empty header section "Decisions & open questions".

- [ ] **Step 1.10: Verify build**

```bash
pnpm build
```

Expected: `.output/chrome-mv3/manifest.json` exists. No TypeScript errors.

- [ ] **Step 1.11: Commit**

```bash
git add -A
git commit -m "chore: scaffold WXT + React + TS + Tailwind project"
```

---

## Task 2: Storage schema & types

**Files:**
- Create: `src/storage/schema.ts`, `src/platforms/types.ts`, `src/interceptors/types.ts`

- [ ] **Step 2.1: Write `src/platforms/types.ts`**

```ts
export type MediaAttachment = {
  blob: Blob;
  mimeType: string;
  alt?: string;
};

export type PostContent = {
  text: string;
  media?: MediaAttachment[];
  reply?: { uri: string; rootUri?: string };
};

export type PostResult =
  | { success: true; url: string; remoteId: string }
  | { success: false; error: string; retryable: boolean };

export type PlatformId = 'bluesky' | 'mastodon' | 'linkedin' | 'x';

export type AccountCredentials = {
  platformId: PlatformId;
  accountId: string;
  displayName: string;
  data: Record<string, unknown>;
};

export type MediaSupport = {
  maxImages: number;
  maxVideoSeconds: number;
  supportedMimeTypes: string[];
};

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  characterLimit: number;
  mediaSupport: MediaSupport;
  authenticate(params: Record<string, string>): Promise<AccountCredentials>;
  post(content: PostContent, credentials: AccountCredentials): Promise<PostResult>;
  validateCredentials(credentials: AccountCredentials): Promise<boolean>;
}
```

- [ ] **Step 2.2: Write `src/interceptors/types.ts`**

```ts
import type { MediaAttachment, PlatformId } from '../platforms/types';

export type InterceptedPost = {
  sourcePlatformId: PlatformId;
  text: string;
  media: MediaAttachment[];
  sourceMetadata?: Record<string, unknown>;
};

export interface SourceInterceptor {
  platformId: PlatformId;
  hostMatchPattern: string;
  install(
    onIntercept: (post: InterceptedPost, complete: (allow: boolean) => void) => void,
  ): () => void;
}
```

- [ ] **Step 2.3: Write `src/storage/schema.ts`**

```ts
import type { AccountCredentials } from '../platforms/types';

export type StoredCredentialsBlob = {
  version: 1;
  encrypted: string; // base64 AES-GCM ciphertext
  iv: string; // base64 IV
};

export type DecryptedCredentialsArray = AccountCredentials[];

export type UserSettings = {
  version: 1;
  enabledDestinations: string[]; // account IDs
  composerMode: 'auto' | 'manual';
  passphraseSet: boolean;
};

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  enabledDestinations: [],
  composerMode: 'auto',
  passphraseSet: false,
};
```

- [ ] **Step 2.4: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.5: Commit**

```bash
git add src/
git commit -m "feat(types): define PlatformAdapter, SourceInterceptor, storage schema"
```

---

## Task 3: WebCrypto helpers

**Files:**
- Create: `src/lib/crypto.ts`, `tests/crypto.test.ts`

- [ ] **Step 3.1: Write failing test `tests/crypto.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generateDeviceKey, exportKey, importKey, encryptJSON, decryptJSON } from '../src/lib/crypto';

describe('crypto', () => {
  it('encrypts and decrypts a JSON object round-trip', async () => {
    const key = await generateDeviceKey();
    const payload = { foo: 'bar', n: 42 };
    const { ciphertext, iv } = await encryptJSON(payload, key);
    const decrypted = await decryptJSON<typeof payload>(ciphertext, iv, key);
    expect(decrypted).toEqual(payload);
  });

  it('exports and re-imports a key', async () => {
    const key = await generateDeviceKey();
    const jwk = await exportKey(key);
    const reimported = await importKey(jwk);
    const { ciphertext, iv } = await encryptJSON({ x: 1 }, key);
    const decrypted = await decryptJSON<{ x: number }>(ciphertext, iv, reimported);
    expect(decrypted).toEqual({ x: 1 });
  });

  it('rejects tampered ciphertext', async () => {
    const key = await generateDeviceKey();
    const { ciphertext, iv } = await encryptJSON({ a: 1 }, key);
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('A') ? 'B' : 'A') + ciphertext.slice(-1);
    await expect(decryptJSON(tampered, iv, key)).rejects.toThrow();
  });
});
```

- [ ] **Step 3.2: Run test, verify it fails**

```bash
pnpm exec vitest run tests/crypto.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3.3: Implement `src/lib/crypto.ts`**

```ts
const ALGO = { name: 'AES-GCM', length: 256 } as const;
const USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

export async function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(ALGO, true, USAGES);
}

export async function exportKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

export async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALGO, true, USAGES);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptJSON(value: unknown, key: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { ciphertext: bytesToBase64(new Uint8Array(buf)), iv: bytesToBase64(iv) };
}

export async function decryptJSON<T>(ciphertext: string, iv: string, key: CryptoKey): Promise<T> {
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}
```

- [ ] **Step 3.4: Run test, verify it passes**

```bash
pnpm exec vitest run tests/crypto.test.ts
```

Expected: 3 passed.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/crypto.ts tests/crypto.test.ts
git commit -m "feat(crypto): AES-GCM encrypt/decrypt with WebCrypto"
```

---

## Task 4: Encrypted credentials storage

**Files:**
- Create: `src/storage/credentials.ts`, `tests/storage/credentials.test.ts`
- Create: `src/lib/logger.ts` (used by storage; defined here so tests don't dangle)

- [ ] **Step 4.1: Write `src/lib/logger.ts`**

```ts
const SECRET_KEYS = ['password', 'token', 'accessToken', 'cookie', 'jwk', 'secret', 'csrf'];

function redact(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s)) ? '[REDACTED]' : redact(v);
  }
  return out;
}

export const logger = {
  info: (...args: unknown[]) => console.info('[CrossPosty]', ...args.map(redact)),
  warn: (...args: unknown[]) => console.warn('[CrossPosty]', ...args.map(redact)),
  error: (...args: unknown[]) => console.error('[CrossPosty]', ...args.map(redact)),
  debug: (...args: unknown[]) => console.debug('[CrossPosty]', ...args.map(redact)),
};
```

- [ ] **Step 4.2: Write failing test `tests/storage/credentials.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadCredentials, saveCredentials, deleteCredential, addCredential } from '../../src/storage/credentials';
import type { AccountCredentials } from '../../src/platforms/types';

const store: Record<string, unknown> = {};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const result: Record<string, unknown> = {};
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) if (k in store) result[k] = store[k];
          return result;
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(store, entries);
        }),
      },
    },
  };
});

const sample = (id: string): AccountCredentials => ({
  platformId: 'bluesky',
  accountId: id,
  displayName: `@user-${id}`,
  data: { token: 'abc123' },
});

describe('credentials storage', () => {
  it('round-trips an empty list', async () => {
    expect(await loadCredentials()).toEqual([]);
  });

  it('saves and loads credentials', async () => {
    await saveCredentials([sample('a')]);
    expect(await loadCredentials()).toEqual([sample('a')]);
  });

  it('addCredential appends', async () => {
    await addCredential(sample('a'));
    await addCredential(sample('b'));
    const all = await loadCredentials();
    expect(all.map((c) => c.accountId)).toEqual(['a', 'b']);
  });

  it('deleteCredential removes by id', async () => {
    await addCredential(sample('a'));
    await addCredential(sample('b'));
    await deleteCredential('a');
    const all = await loadCredentials();
    expect(all.map((c) => c.accountId)).toEqual(['b']);
  });

  it('persists across reloads (same encryption key)', async () => {
    await addCredential(sample('a'));
    const reloaded = await loadCredentials();
    expect(reloaded).toEqual([sample('a')]);
  });
});
```

- [ ] **Step 4.3: Run test, verify it fails**

```bash
pnpm exec vitest run tests/storage/credentials.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.4: Implement `src/storage/credentials.ts`**

```ts
import { decryptJSON, encryptJSON, exportKey, generateDeviceKey, importKey } from '../lib/crypto';
import type { AccountCredentials } from '../platforms/types';
import type { DecryptedCredentialsArray, StoredCredentialsBlob } from './schema';

const KEY_BLOB = 'credentials';
const KEY_DEVICE_KEY = 'deviceKey';

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const existing = await chrome.storage.local.get(KEY_DEVICE_KEY);
  if (existing[KEY_DEVICE_KEY]) return importKey(existing[KEY_DEVICE_KEY] as JsonWebKey);
  const key = await generateDeviceKey();
  await chrome.storage.local.set({ [KEY_DEVICE_KEY]: await exportKey(key) });
  return key;
}

export async function loadCredentials(): Promise<DecryptedCredentialsArray> {
  const stored = await chrome.storage.local.get(KEY_BLOB);
  const blob = stored[KEY_BLOB] as StoredCredentialsBlob | undefined;
  if (!blob) return [];
  const key = await getOrCreateDeviceKey();
  return decryptJSON<DecryptedCredentialsArray>(blob.encrypted, blob.iv, key);
}

export async function saveCredentials(creds: DecryptedCredentialsArray): Promise<void> {
  const key = await getOrCreateDeviceKey();
  const { ciphertext, iv } = await encryptJSON(creds, key);
  const blob: StoredCredentialsBlob = { version: 1, encrypted: ciphertext, iv };
  await chrome.storage.local.set({ [KEY_BLOB]: blob });
}

export async function addCredential(cred: AccountCredentials): Promise<void> {
  const all = await loadCredentials();
  all.push(cred);
  await saveCredentials(all);
}

export async function deleteCredential(accountId: string): Promise<void> {
  const all = await loadCredentials();
  await saveCredentials(all.filter((c) => c.accountId !== accountId));
}
```

- [ ] **Step 4.5: Run tests, verify they pass**

```bash
pnpm exec vitest run tests/storage/credentials.test.ts
```

Expected: 5 passed.

- [ ] **Step 4.6: Commit**

```bash
git add src/storage src/lib/logger.ts tests/storage
git commit -m "feat(storage): encrypted credentials store with chrome.storage.local"
```

---

## Task 5: BlueSky platform adapter

**Files:**
- Create: `src/platforms/bluesky.ts`, `tests/platforms/bluesky.test.ts`

- [ ] **Step 5.1: Write failing test `tests/platforms/bluesky.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blueskyAdapter } from '../../src/platforms/bluesky';

const loginMock = vi.fn();
const postMock = vi.fn();
const getProfileMock = vi.fn();

vi.mock('@atproto/api', () => ({
  BskyAgent: vi.fn().mockImplementation(() => ({
    login: loginMock,
    post: postMock,
    getProfile: getProfileMock,
    session: { did: 'did:plc:test', handle: 'test.bsky.social', accessJwt: 'access-jwt', refreshJwt: 'refresh-jwt' },
  })),
}));

beforeEach(() => {
  loginMock.mockReset();
  postMock.mockReset();
  getProfileMock.mockReset();
});

describe('blueskyAdapter', () => {
  it('reports basic metadata', () => {
    expect(blueskyAdapter.id).toBe('bluesky');
    expect(blueskyAdapter.characterLimit).toBe(300);
  });

  it('authenticates with app password', async () => {
    loginMock.mockResolvedValue(undefined);
    const creds = await blueskyAdapter.authenticate({
      identifier: 'test.bsky.social',
      appPassword: 'xxxx-xxxx-xxxx-xxxx',
    });
    expect(loginMock).toHaveBeenCalledWith({ identifier: 'test.bsky.social', password: 'xxxx-xxxx-xxxx-xxxx' });
    expect(creds.platformId).toBe('bluesky');
    expect(creds.displayName).toContain('test.bsky.social');
    expect(creds.data).toMatchObject({ did: 'did:plc:test', handle: 'test.bsky.social' });
  });

  it('posts text and returns a permalink', async () => {
    loginMock.mockResolvedValue(undefined);
    postMock.mockResolvedValue({ uri: 'at://did:plc:test/app.bsky.feed.post/abc123', cid: 'cid1' });
    const result = await blueskyAdapter.post(
      { text: 'hello world' },
      {
        platformId: 'bluesky',
        accountId: 'a',
        displayName: '@test.bsky.social',
        data: { did: 'did:plc:test', handle: 'test.bsky.social', accessJwt: 'a', refreshJwt: 'r' },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe('https://bsky.app/profile/test.bsky.social/post/abc123');
      expect(result.remoteId).toBe('at://did:plc:test/app.bsky.feed.post/abc123');
    }
  });

  it('returns retryable failure on network error', async () => {
    loginMock.mockResolvedValue(undefined);
    postMock.mockRejectedValue(new Error('network'));
    const result = await blueskyAdapter.post(
      { text: 'x' },
      { platformId: 'bluesky', accountId: 'a', displayName: 'x', data: { did: 'd', handle: 'h', accessJwt: 'a', refreshJwt: 'r' } },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.retryable).toBe(true);
  });
});
```

- [ ] **Step 5.2: Run test, verify it fails**

```bash
pnpm exec vitest run tests/platforms/bluesky.test.ts
```

Expected: FAIL.

- [ ] **Step 5.3: Implement `src/platforms/bluesky.ts`**

```ts
import { BskyAgent } from '@atproto/api';
import type { AccountCredentials, PlatformAdapter, PostContent, PostResult } from './types';

type BlueskySessionData = {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
};

async function makeAgent(data: BlueskySessionData): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.resumeSession({
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    active: true,
  });
  return agent;
}

export const blueskyAdapter: PlatformAdapter = {
  id: 'bluesky',
  displayName: 'BlueSky',
  characterLimit: 300,
  mediaSupport: { maxImages: 4, maxVideoSeconds: 0, supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },

  async authenticate(params): Promise<AccountCredentials> {
    const { identifier, appPassword } = params;
    if (!identifier || !appPassword) throw new Error('identifier and appPassword required');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier, password: appPassword });
    const session = agent.session;
    if (!session) throw new Error('login failed: no session');
    const data: BlueskySessionData = {
      did: session.did,
      handle: session.handle,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
    };
    return {
      platformId: 'bluesky',
      accountId: crypto.randomUUID(),
      displayName: `@${session.handle}`,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    try {
      const agent = await makeAgent(credentials.data as unknown as BlueskySessionData);
      const res = await agent.post({ text: content.text });
      const rkey = res.uri.split('/').pop() ?? '';
      const handle = (credentials.data as BlueskySessionData).handle;
      return { success: true, url: `https://bsky.app/profile/${handle}/post/${rkey}`, remoteId: res.uri };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const agent = await makeAgent(credentials.data as unknown as BlueskySessionData);
      await agent.getProfile({ actor: (credentials.data as BlueskySessionData).handle });
      return true;
    } catch {
      return false;
    }
  },
};
```

- [ ] **Step 5.4: Update mock to include `resumeSession`**

The test mock above uses `login`, but `post` path uses `resumeSession`. Update `tests/platforms/bluesky.test.ts` mock to add `resumeSession: vi.fn().mockResolvedValue(undefined)` to the `BskyAgent` mock implementation.

- [ ] **Step 5.5: Run tests, verify they pass**

```bash
pnpm exec vitest run tests/platforms/bluesky.test.ts
```

Expected: 4 passed.

- [ ] **Step 5.6: Commit**

```bash
git add src/platforms/bluesky.ts tests/platforms/bluesky.test.ts
git commit -m "feat(platforms): BlueSky adapter via @atproto/api"
```

---

## Task 6: Mastodon platform adapter

**Files:**
- Create: `src/platforms/mastodon.ts`, `tests/platforms/mastodon.test.ts`

- [ ] **Step 6.1: Write failing test `tests/platforms/mastodon.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mastodonAdapter } from '../../src/platforms/mastodon';

const verifyCredentialsMock = vi.fn();
const createStatusMock = vi.fn();

vi.mock('masto', () => ({
  createRestAPIClient: vi.fn(() => ({
    v1: {
      accounts: { verifyCredentials: verifyCredentialsMock },
      statuses: { create: createStatusMock },
    },
  })),
}));

beforeEach(() => {
  verifyCredentialsMock.mockReset();
  createStatusMock.mockReset();
});

describe('mastodonAdapter', () => {
  it('posts text and returns the URL from the API response', async () => {
    createStatusMock.mockResolvedValue({ id: '999', url: 'https://mastodon.social/@user/999' });
    const result = await mastodonAdapter.post(
      { text: 'toot' },
      {
        platformId: 'mastodon',
        accountId: 'a',
        displayName: '@user@mastodon.social',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.url).toBe('https://mastodon.social/@user/999');
  });

  it('reports failure on API error', async () => {
    createStatusMock.mockRejectedValue(new Error('500'));
    const result = await mastodonAdapter.post(
      { text: 'toot' },
      {
        platformId: 'mastodon',
        accountId: 'a',
        displayName: '@user@mastodon.social',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      },
    );
    expect(result.success).toBe(false);
  });

  it('validateCredentials returns true on success', async () => {
    verifyCredentialsMock.mockResolvedValue({ acct: 'user' });
    expect(
      await mastodonAdapter.validateCredentials({
        platformId: 'mastodon',
        accountId: 'a',
        displayName: 'x',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 6.2: Run test, verify it fails**

```bash
pnpm exec vitest run tests/platforms/mastodon.test.ts
```

Expected: FAIL.

- [ ] **Step 6.3: Implement `src/platforms/mastodon.ts`**

```ts
import { createRestAPIClient } from 'masto';
import type { AccountCredentials, PlatformAdapter, PostContent, PostResult } from './types';

type MastodonSessionData = {
  instanceUrl: string;
  accessToken: string;
};

function client(data: MastodonSessionData) {
  return createRestAPIClient({ url: data.instanceUrl, accessToken: data.accessToken });
}

export const mastodonAdapter: PlatformAdapter = {
  id: 'mastodon',
  displayName: 'Mastodon',
  characterLimit: 500,
  mediaSupport: { maxImages: 4, maxVideoSeconds: 60, supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },

  async authenticate(params): Promise<AccountCredentials> {
    const { instanceUrl, accessToken } = params;
    if (!instanceUrl || !accessToken) throw new Error('instanceUrl and accessToken required');
    const c = client({ instanceUrl, accessToken });
    const me = await c.v1.accounts.verifyCredentials();
    const host = new URL(instanceUrl).host;
    return {
      platformId: 'mastodon',
      accountId: crypto.randomUUID(),
      displayName: `@${me.acct}@${host}`,
      data: { instanceUrl, accessToken } as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      const status = await c.v1.statuses.create({ status: content.text });
      return { success: true, url: status.url ?? '', remoteId: status.id };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      await c.v1.accounts.verifyCredentials();
      return true;
    } catch {
      return false;
    }
  },
};
```

- [ ] **Step 6.4: Run tests, verify they pass**

```bash
pnpm exec vitest run tests/platforms/mastodon.test.ts
```

Expected: 3 passed.

- [ ] **Step 6.5: Commit**

```bash
git add src/platforms/mastodon.ts tests/platforms/mastodon.test.ts
git commit -m "feat(platforms): Mastodon adapter via masto"
```

---

## Task 7: LinkedIn platform adapter

**Files:**
- Create: `src/platforms/linkedin.ts`, `tests/platforms/linkedin.test.ts`

LinkedIn's `voyager` API expects session cookies (`li_at`, `JSESSIONID`) and a CSRF token derived from `JSESSIONID` (quotes stripped). We POST to `https://www.linkedin.com/voyager/api/contentcreation/normShares` with the `normShare` body shape.

- [ ] **Step 7.1: Write failing test `tests/platforms/linkedin.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { linkedinAdapter } from '../../src/platforms/linkedin';

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).chrome = {
    cookies: {
      get: vi.fn(async ({ name }: { name: string }) => {
        if (name === 'li_at') return { value: 'li-at-value' };
        if (name === 'JSESSIONID') return { value: '"ajax:1234567890"' };
        return null;
      }),
    },
  };
});

describe('linkedinAdapter', () => {
  it('captures a session from cookies', async () => {
    const creds = await linkedinAdapter.authenticate({});
    expect(creds.platformId).toBe('linkedin');
    expect(creds.data).toMatchObject({ liAt: 'li-at-value', jsessionId: '"ajax:1234567890"' });
  });

  it('posts content and returns success', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ updateUrn: 'urn:li:share:abc' }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await linkedinAdapter.post(
      { text: 'hello' },
      {
        platformId: 'linkedin',
        accountId: 'a',
        displayName: 'me',
        data: { liAt: 'li-at-value', jsessionId: '"ajax:1234567890"' },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.remoteId).toBe('urn:li:share:abc');

    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['csrf-token']).toBe('ajax:1234567890');
    expect((init.headers as Record<string, string>)['x-restli-protocol-version']).toBe('2.0.0');
  });

  it('returns retryable failure on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const result = await linkedinAdapter.post(
      { text: 'hi' },
      {
        platformId: 'linkedin',
        accountId: 'a',
        displayName: 'me',
        data: { liAt: 'li', jsessionId: '"ajax:1"' },
      },
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 7.2: Run test, verify it fails**

```bash
pnpm exec vitest run tests/platforms/linkedin.test.ts
```

Expected: FAIL.

- [ ] **Step 7.3: Implement `src/platforms/linkedin.ts`**

```ts
import type { AccountCredentials, PlatformAdapter, PostContent, PostResult } from './types';

type LinkedInSessionData = {
  liAt: string;
  jsessionId: string;
};

const NORMSHARES_URL = 'https://www.linkedin.com/voyager/api/contentcreation/normShares';

function csrfFromJsessionId(jsessionId: string): string {
  return jsessionId.replace(/^"|"$/g, '');
}

function buildNormShareBody(text: string): unknown {
  return {
    visibleToConnectionsOnly: false,
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: 'FEED_DETAIL',
    allowedCommentersScope: 'ALL',
    postState: 'PUBLISHED',
    media: [],
  };
}

export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  characterLimit: 3000,
  mediaSupport: { maxImages: 9, maxVideoSeconds: 600, supportedMimeTypes: ['image/jpeg', 'image/png'] },

  async authenticate(): Promise<AccountCredentials> {
    const liAtCookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
    const jsessionCookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' });
    if (!liAtCookie?.value || !jsessionCookie?.value) {
      throw new Error('LinkedIn session cookies not found. Log in to linkedin.com first.');
    }
    const data: LinkedInSessionData = { liAt: liAtCookie.value, jsessionId: jsessionCookie.value };
    return {
      platformId: 'linkedin',
      accountId: crypto.randomUUID(),
      displayName: 'LinkedIn session',
      data: data as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    const data = credentials.data as unknown as LinkedInSessionData;
    try {
      const res = await fetch(NORMSHARES_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'csrf-token': csrfFromJsessionId(data.jsessionId),
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify(buildNormShareBody(content.text)),
      });
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
      }
      const json = (await res.json()) as { updateUrn?: string };
      const urn = json.updateUrn ?? '';
      return {
        success: true,
        url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : 'https://www.linkedin.com/feed/',
        remoteId: urn,
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    const data = credentials.data as unknown as LinkedInSessionData;
    return Boolean(data.liAt && data.jsessionId);
  },
};
```

- [ ] **Step 7.4: Add NOTES.md entry about LinkedIn endpoint**

Append to `NOTES.md`:

```
## 2026-05-17 — LinkedIn voyager endpoint

We post to `https://www.linkedin.com/voyager/api/contentcreation/normShares` using session
cookies (`li_at`, `JSESSIONID`) with `csrf-token` derived from `JSESSIONID` (quotes stripped)
and `x-restli-protocol-version: 2.0.0`. The endpoint is undocumented; if the request shape
or URL changes, capture a real linkedin.com post via DevTools Network tab and update
`src/platforms/linkedin.ts:buildNormShareBody`.
```

- [ ] **Step 7.5: Run tests, verify they pass**

```bash
pnpm exec vitest run tests/platforms/linkedin.test.ts
```

Expected: 3 passed.

- [ ] **Step 7.6: Commit**

```bash
git add src/platforms/linkedin.ts tests/platforms/linkedin.test.ts NOTES.md
git commit -m "feat(platforms): LinkedIn voyager session-cookie adapter"
```

---

## Task 8: X adapter stub + platform registry

**Files:**
- Create: `src/platforms/x.ts`, `src/platforms/index.ts`

- [ ] **Step 8.1: Implement `src/platforms/x.ts`**

```ts
import type { PlatformAdapter, PostResult } from './types';

export const xAdapter: PlatformAdapter = {
  id: 'x',
  displayName: 'X',
  characterLimit: 280,
  mediaSupport: { maxImages: 4, maxVideoSeconds: 140, supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'] },

  async authenticate(): Promise<never> {
    throw new Error('X authentication is implicit (browser session). Not used in Phase 1 destination flow.');
  },

  async post(): Promise<PostResult> {
    // Phase 1: X is source-only. When X is the source, the original post fires natively
    // through the web UI; cross-posting to X as destination is Phase 2 (web-UI scheduled posting).
    return { success: true, url: '', remoteId: 'x-source-native' };
  },

  async validateCredentials(): Promise<boolean> {
    return true;
  },
};
```

- [ ] **Step 8.2: Implement `src/platforms/index.ts`**

```ts
import { blueskyAdapter } from './bluesky';
import { linkedinAdapter } from './linkedin';
import { mastodonAdapter } from './mastodon';
import type { PlatformAdapter, PlatformId } from './types';
import { xAdapter } from './x';

const adapters: PlatformAdapter[] = [blueskyAdapter, mastodonAdapter, linkedinAdapter, xAdapter];

export const platformRegistry: Record<PlatformId, PlatformAdapter> = Object.fromEntries(
  adapters.map((a) => [a.id, a]),
) as Record<PlatformId, PlatformAdapter>;

export function getAdapter(id: PlatformId): PlatformAdapter {
  const a = platformRegistry[id];
  if (!a) throw new Error(`Unknown platform: ${id}`);
  return a;
}

export const allAdapters = adapters;
```

- [ ] **Step 8.3: Type-check**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
```

Expected: no errors; all existing tests still pass.

- [ ] **Step 8.4: Commit**

```bash
git add src/platforms/x.ts src/platforms/index.ts
git commit -m "feat(platforms): X adapter stub + platform registry"
```

---

## Task 9: Settings storage helper

**Files:**
- Create: `src/storage/settings.ts`

- [ ] **Step 9.1: Implement `src/storage/settings.ts`**

```ts
import { DEFAULT_SETTINGS, type UserSettings } from './schema';

const KEY = 'settings';

export async function loadSettings(): Promise<UserSettings> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as UserSettings | undefined) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
```

- [ ] **Step 9.2: Commit**

```bash
git add src/storage/settings.ts
git commit -m "feat(storage): settings load/save helpers"
```

---

## Task 10: Typed messaging layer

**Files:**
- Create: `src/lib/messaging.ts`

Background and content scripts need typed messages: "intercepted post", "cross-post request", "cross-post result".

- [ ] **Step 10.1: Implement `src/lib/messaging.ts`**

```ts
import type { InterceptedPost } from '../interceptors/types';
import type { AccountCredentials, PlatformId, PostContent, PostResult } from '../platforms/types';

export type Message =
  | { type: 'CROSSPOST_REQUEST'; payload: { content: PostContent; accountIds: string[] } }
  | { type: 'CROSSPOST_RESULT'; payload: { accountId: string; platformId: PlatformId; result: PostResult } }
  | { type: 'LIST_CREDENTIALS'; payload: null }
  | { type: 'LIST_CREDENTIALS_RESPONSE'; payload: AccountCredentials[] }
  | { type: 'INTERCEPTED_POST'; payload: InterceptedPost };

export type MessageOf<T extends Message['type']> = Extract<Message, { type: T }>;

export function sendMessage<T extends Message['type']>(msg: MessageOf<T>): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export function onMessage(handler: (msg: Message, sender: chrome.runtime.MessageSender) => unknown): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const result = handler(msg as Message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }
    sendResponse(result);
    return false;
  });
}
```

- [ ] **Step 10.2: Commit**

```bash
git add src/lib/messaging.ts
git commit -m "feat(lib): typed chrome.runtime messaging"
```

---

## Task 11: Background service worker — orchestration

**Files:**
- Modify: `src/entrypoints/background.ts`

- [ ] **Step 11.1: Implement orchestrator**

```ts
import { onMessage } from '../lib/messaging';
import { logger } from '../lib/logger';
import { getAdapter } from '../platforms';
import { loadCredentials } from '../storage/credentials';
import type { Message } from '../lib/messaging';

export default defineBackground(() => {
  logger.info('background loaded');

  onMessage(async (msg: Message) => {
    if (msg.type === 'LIST_CREDENTIALS') {
      const creds = await loadCredentials();
      return { type: 'LIST_CREDENTIALS_RESPONSE', payload: creds };
    }

    if (msg.type === 'CROSSPOST_REQUEST') {
      const { content, accountIds } = msg.payload;
      const allCreds = await loadCredentials();
      const targets = allCreds.filter((c) => accountIds.includes(c.accountId));
      const results = await Promise.allSettled(
        targets.map(async (cred) => {
          const adapter = getAdapter(cred.platformId);
          const result = await adapter.post(content, cred);
          return { accountId: cred.accountId, platformId: cred.platformId, result };
        }),
      );
      return results.map((r) =>
        r.status === 'fulfilled'
          ? r.value
          : { accountId: 'unknown', platformId: 'bluesky', result: { success: false, error: String(r.reason), retryable: true } },
      );
    }

    return undefined;
  });
});
```

- [ ] **Step 11.2: Build to verify compilation**

```bash
pnpm build
```

Expected: builds without TypeScript errors.

- [ ] **Step 11.3: Commit**

```bash
git add src/entrypoints/background.ts
git commit -m "feat(background): orchestrate cross-post fan-out"
```

---

## Task 12: Popup UI — account management

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`, `main.tsx`
- Create: `src/entrypoints/popup/pages/Accounts.tsx`
- Create: `src/entrypoints/popup/pages/AddAccount.tsx`

Popup is a small React app with two views: list accounts, add account.

- [ ] **Step 12.1: Implement `App.tsx`**

```tsx
import { useState } from 'react';
import { AccountsPage } from './pages/Accounts';
import { AddAccountPage } from './pages/AddAccount';

export type View = { name: 'accounts' } | { name: 'add'; platformId: 'bluesky' | 'mastodon' | 'linkedin' };

export function App() {
  const [view, setView] = useState<View>({ name: 'accounts' });
  return (
    <div className="w-[400px] min-h-[500px] p-4 font-sans">
      <h1 className="text-xl font-semibold mb-4">CrossPosty</h1>
      {view.name === 'accounts' ? (
        <AccountsPage onAdd={(platformId) => setView({ name: 'add', platformId })} />
      ) : (
        <AddAccountPage platformId={view.platformId} onDone={() => setView({ name: 'accounts' })} />
      )}
    </div>
  );
}
```

- [ ] **Step 12.2: Implement `pages/Accounts.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { AccountCredentials, PlatformId } from '../../../platforms/types';
import { loadCredentials, deleteCredential } from '../../../storage/credentials';

export function AccountsPage({ onAdd }: { onAdd: (platformId: PlatformId) => void }) {
  const [accounts, setAccounts] = useState<AccountCredentials[]>([]);

  async function refresh() {
    setAccounts(await loadCredentials());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(accountId: string) {
    await deleteCredential(accountId);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <section>
        <h2 className="font-medium mb-2">Connected accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts yet. Add one below.</p>
        ) : (
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li key={a.accountId} className="flex justify-between text-sm border rounded p-2">
                <span><strong>{a.platformId}</strong> — {a.displayName}</span>
                <button onClick={() => remove(a.accountId)} className="text-red-600 text-xs">remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="font-medium mb-2">Add account</h2>
        <div className="flex gap-2">
          <button onClick={() => onAdd('bluesky')} className="bg-sky-600 text-white px-3 py-1 rounded text-sm">BlueSky</button>
          <button onClick={() => onAdd('mastodon')} className="bg-violet-600 text-white px-3 py-1 rounded text-sm">Mastodon</button>
          <button onClick={() => onAdd('linkedin')} className="bg-blue-700 text-white px-3 py-1 rounded text-sm">LinkedIn</button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 12.3: Implement `pages/AddAccount.tsx`**

```tsx
import { useState } from 'react';
import { getAdapter } from '../../../platforms';
import type { PlatformId } from '../../../platforms/types';
import { addCredential } from '../../../storage/credentials';

export function AddAccountPage({ platformId, onDone }: { platformId: PlatformId; onDone: () => void }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = fieldsFor(platformId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const adapter = getAdapter(platformId);
      const creds = await adapter.authenticate(params);
      await addCredential(creds);
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={onDone} className="text-xs text-gray-500">← back</button>
      <h2 className="font-medium">Add {platformId} account</h2>
      {fields.map((f) => (
        <label key={f.name} className="block text-sm">
          <span className="block text-gray-700">{f.label}</span>
          <input
            type={f.type}
            className="w-full border rounded px-2 py-1 text-sm"
            value={params[f.name] ?? ''}
            onChange={(e) => setParams((p) => ({ ...p, [f.name]: e.target.value }))}
            placeholder={f.placeholder}
          />
        </label>
      ))}
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="bg-emerald-600 text-white px-3 py-1 rounded text-sm disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}

function fieldsFor(platformId: PlatformId): Array<{ name: string; label: string; type: string; placeholder?: string }> {
  switch (platformId) {
    case 'bluesky':
      return [
        { name: 'identifier', label: 'Handle (e.g. you.bsky.social)', type: 'text', placeholder: 'you.bsky.social' },
        { name: 'appPassword', label: 'App password (Settings → App Passwords)', type: 'password', placeholder: 'xxxx-xxxx-xxxx-xxxx' },
      ];
    case 'mastodon':
      return [
        { name: 'instanceUrl', label: 'Instance URL', type: 'text', placeholder: 'https://mastodon.social' },
        { name: 'accessToken', label: 'Access token (Preferences → Development → New application)', type: 'password' },
      ];
    case 'linkedin':
      return []; // no fields; uses cookies
    default:
      return [];
  }
}
```

For LinkedIn (no fields), the form still works — submit calls `authenticate({})` which reads cookies via `chrome.cookies.get`.

- [ ] **Step 12.4: Manual test**

```bash
pnpm dev
```

Open the popup. Verify:
- Empty state renders.
- Clicking "BlueSky" shows the form with two fields.
- Clicking "back" returns to the list.
- Filling real BlueSky credentials saves an account (visible after returning).

- [ ] **Step 12.5: Commit**

```bash
git add src/entrypoints/popup
git commit -m "feat(popup): account list + add-account flow"
```

---

## Task 13: X source interceptor

**Files:**
- Create: `src/entrypoints/x.content.ts`
- Create: `src/interceptors/x.ts`
- Create: `src/interceptors/inject-fetch-hook.ts` (the MAIN-world script)

The content script lives in ISOLATED world. To monkey-patch `window.fetch`, we inject a script into MAIN world via a `<script>` tag (simplest cross-WXT approach). MAIN-world script dispatches `CustomEvent`s back to the content script.

- [ ] **Step 13.1: Implement `src/interceptors/inject-fetch-hook.ts`**

```ts
// This file is injected into MAIN world; it patches window.fetch and emits
// `crossposty:intercept` CustomEvents observed by the content script.

(function () {
  if ((window as unknown as { __crossposty_installed?: boolean }).__crossposty_installed) return;
  (window as unknown as { __crossposty_installed?: boolean }).__crossposty_installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const interesting =
        /x\.com\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(url) ||
        /bsky\.social\/xrpc\/com\.atproto\.repo\.createRecord/.test(url);
      if (interesting && init?.body) {
        let bodyText = '';
        if (typeof init.body === 'string') bodyText = init.body;
        else if (init.body instanceof Blob) bodyText = await init.body.text();
        window.dispatchEvent(
          new CustomEvent('crossposty:intercept', { detail: { url, body: bodyText } }),
        );
      }
    } catch {
      // Never block the original fetch
    }
    return origFetch(input, init);
  };
})();
```

- [ ] **Step 13.2: Implement `src/interceptors/x.ts`**

```ts
import type { InterceptedPost, SourceInterceptor } from './types';

type CreateTweetVariables = {
  tweet_text?: string;
  media?: { media_entities?: Array<{ media_id: string }> };
};

function parseCreateTweetBody(body: string): InterceptedPost | null {
  try {
    const json = JSON.parse(body) as { variables?: CreateTweetVariables };
    const text = json.variables?.tweet_text;
    if (typeof text !== 'string') return null;
    return { sourcePlatformId: 'x', text, media: [] };
  } catch {
    return null;
  }
}

export const xInterceptor: SourceInterceptor = {
  platformId: 'x',
  hostMatchPattern: '*://x.com/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!/x\.com\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
      const post = parseCreateTweetBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
```

- [ ] **Step 13.3: Implement `src/interceptors/bsky.ts`**

```ts
import type { InterceptedPost, SourceInterceptor } from './types';

type CreateRecordBody = {
  record?: { text?: string };
};

function parseCreateRecordBody(body: string): InterceptedPost | null {
  try {
    const json = JSON.parse(body) as CreateRecordBody;
    const text = json.record?.text;
    if (typeof text !== 'string') return null;
    return { sourcePlatformId: 'bluesky', text, media: [] };
  } catch {
    return null;
  }
}

export const bskyInterceptor: SourceInterceptor = {
  platformId: 'bluesky',
  hostMatchPattern: '*://bsky.app/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!/bsky\.social\/xrpc\/com\.atproto\.repo\.createRecord/.test(detail.url)) return;
      const post = parseCreateRecordBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
```

- [ ] **Step 13.4: Implement `src/entrypoints/x.content.ts`**

```ts
import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';

export default defineContentScript({
  matches: ['*://x.com/*'],
  runAt: 'document_start',
  main() {
    injectMainWorld();
    xInterceptor.install((post) => {
      mountComposerPanel(post);
    });
  },
});

function injectMainWorld() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/inject-fetch-hook.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
```

- [ ] **Step 13.5: Implement `src/entrypoints/bsky.content.ts`**

```ts
import { mountComposerPanel } from '../composer/mount';
import { bskyInterceptor } from '../interceptors/bsky';

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  runAt: 'document_start',
  main() {
    injectMainWorld();
    bskyInterceptor.install((post) => {
      mountComposerPanel(post);
    });
  },
});

function injectMainWorld() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/inject-fetch-hook.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
```

- [ ] **Step 13.6: Wire `inject-fetch-hook.js` as a web-accessible resource**

In `wxt.config.ts`, add an unlisted entrypoint for the MAIN-world script. Create `src/entrypoints/inject-fetch-hook.ts` that re-exports the IIFE content of `src/interceptors/inject-fetch-hook.ts` (WXT bundles each entrypoint as a standalone JS file). Update manifest:

```ts
manifest: {
  // ...existing...
  web_accessible_resources: [
    { resources: ['inject-fetch-hook.js'], matches: ['*://x.com/*', '*://bsky.app/*'] },
  ],
},
```

If WXT auto-generates a different file name, adjust the `chrome.runtime.getURL` argument accordingly.

- [ ] **Step 13.7: Build**

```bash
pnpm build
```

Expected: clean build. Verify `.output/chrome-mv3/inject-fetch-hook.js` exists.

- [ ] **Step 13.8: Commit**

```bash
git add src/interceptors src/entrypoints/x.content.ts src/entrypoints/bsky.content.ts src/entrypoints/inject-fetch-hook.ts wxt.config.ts
git commit -m "feat(interceptors): fetch monkey-patch on x.com and bsky.app"
```

---

## Task 14: Composer panel UI

**Files:**
- Create: `src/composer/mount.ts`, `src/composer/ComposerPanel.tsx`, `src/composer/PlatformVariant.tsx`, `src/composer/styles.css`

Mount into a Shadow DOM root so host CSS doesn't bleed in.

- [ ] **Step 14.1: Implement `src/composer/styles.css`**

Tailwind compiled CSS for the shadow root. Simplest path: inline a minimal stylesheet with the styles we actually use (no Tailwind in shadow DOM for v1):

```css
.crossposty-panel { position: fixed; right: 16px; top: 80px; width: 380px; max-height: 80vh; background: #fff; color: #111; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 12px 24px rgba(0,0,0,.15); overflow: auto; z-index: 2147483646; font-family: system-ui, sans-serif; }
.crossposty-header { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
.crossposty-title { font-weight: 600; }
.crossposty-close { background: none; border: 0; font-size: 18px; cursor: pointer; }
.crossposty-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.crossposty-variant { border: 1px solid #eee; border-radius: 6px; padding: 8px; }
.crossposty-variant-head { display: flex; justify-content: space-between; font-size: 12px; color: #555; margin-bottom: 4px; }
.crossposty-variant textarea { width: 100%; min-height: 80px; border: 1px solid #ddd; border-radius: 4px; padding: 6px; font: inherit; resize: vertical; }
.crossposty-cta { background: #059669; color: white; border: 0; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
.crossposty-cta:disabled { opacity: .5; }
.crossposty-result { font-size: 12px; }
.crossposty-result.success { color: #059669; }
.crossposty-result.fail { color: #dc2626; }
```

- [ ] **Step 14.2: Implement `src/composer/PlatformVariant.tsx`**

```tsx
import type { AccountCredentials } from '../platforms/types';

export function PlatformVariant({
  account,
  text,
  charLimit,
  enabled,
  onTextChange,
  onToggle,
  result,
}: {
  account: AccountCredentials;
  text: string;
  charLimit: number;
  enabled: boolean;
  onTextChange: (s: string) => void;
  onToggle: (on: boolean) => void;
  result?: { success: boolean; message: string };
}) {
  const over = text.length > charLimit;
  return (
    <div className="crossposty-variant">
      <div className="crossposty-variant-head">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />{' '}
          {account.platformId} — {account.displayName}
        </label>
        <span style={{ color: over ? '#dc2626' : undefined }}>
          {text.length} / {charLimit}
        </span>
      </div>
      <textarea value={text} onChange={(e) => onTextChange(e.target.value)} />
      {result && (
        <div className={`crossposty-result ${result.success ? 'success' : 'fail'}`}>{result.message}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 14.3: Implement `src/composer/ComposerPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { InterceptedPost } from '../interceptors/types';
import type { AccountCredentials, PostResult } from '../platforms/types';
import { getAdapter } from '../platforms';
import { PlatformVariant } from './PlatformVariant';

type VariantState = {
  account: AccountCredentials;
  text: string;
  enabled: boolean;
  result?: { success: boolean; message: string };
};

export function ComposerPanel({ intercepted, onClose }: { intercepted: InterceptedPost; onClose: () => void }) {
  const [variants, setVariants] = useState<VariantState[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const response = (await chrome.runtime.sendMessage({ type: 'LIST_CREDENTIALS', payload: null })) as {
        type: 'LIST_CREDENTIALS_RESPONSE';
        payload: AccountCredentials[];
      };
      const destinations = response.payload.filter((c) => c.platformId !== intercepted.sourcePlatformId);
      setVariants(destinations.map((account) => ({ account, text: intercepted.text, enabled: true })));
    })();
  }, [intercepted]);

  function update(i: number, patch: Partial<VariantState>) {
    setVariants((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  async function crosspost() {
    setBusy(true);
    const active = variants.filter((v) => v.enabled);
    const results = await Promise.allSettled(
      active.map(async (v) => {
        const adapter = getAdapter(v.account.platformId);
        const result: PostResult = await adapter.post({ text: v.text }, v.account);
        return { accountId: v.account.accountId, result };
      }),
    );
    setVariants((vs) =>
      vs.map((v) => {
        const r = results.find((x) => x.status === 'fulfilled' && x.value.accountId === v.account.accountId);
        if (!r || r.status !== 'fulfilled') return v;
        const result = r.value.result;
        return {
          ...v,
          result: result.success
            ? { success: true, message: `Posted: ${result.url || 'ok'}` }
            : { success: false, message: `Failed: ${result.error}` },
        };
      }),
    );
    setBusy(false);
  }

  return (
    <div className="crossposty-panel">
      <div className="crossposty-header">
        <span className="crossposty-title">Cross-post to…</span>
        <button className="crossposty-close" onClick={onClose}>×</button>
      </div>
      <div className="crossposty-body">
        {variants.length === 0 ? (
          <p style={{ fontSize: 12, color: '#666' }}>No destination accounts connected. Open the extension popup to add one.</p>
        ) : (
          variants.map((v, i) => (
            <PlatformVariant
              key={v.account.accountId}
              account={v.account}
              text={v.text}
              charLimit={getAdapter(v.account.platformId).characterLimit}
              enabled={v.enabled}
              onTextChange={(text) => update(i, { text })}
              onToggle={(enabled) => update(i, { enabled })}
              result={v.result}
            />
          ))
        )}
        <button className="crossposty-cta" disabled={busy || variants.length === 0} onClick={crosspost}>
          {busy ? 'Posting…' : 'Cross-post'}
        </button>
      </div>
    </div>
  );
}
```

Note: `getAdapter` is used directly in the content script context. This works because adapters use `fetch`/`chrome.cookies`/`chrome.storage` which are available in content scripts for permissioned hosts. If LinkedIn cookie access fails from content script context (origin restrictions), Task 16 will move posting into the background worker via `CROSSPOST_REQUEST`.

- [ ] **Step 14.4: Implement `src/composer/mount.ts`**

```tsx
import { createRoot, type Root } from 'react-dom/client';
import type { InterceptedPost } from '../interceptors/types';
import { ComposerPanel } from './ComposerPanel';
import css from './styles.css?raw';

let host: HTMLElement | null = null;
let root: Root | null = null;

export function mountComposerPanel(intercepted: InterceptedPost) {
  if (host) unmount();
  host = document.createElement('div');
  host.id = 'crossposty-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.body.appendChild(host);
  root = createRoot(mountPoint);
  root.render(<ComposerPanel intercepted={intercepted} onClose={unmount} />);
}

function unmount() {
  if (root) root.unmount();
  if (host) host.remove();
  root = null;
  host = null;
}
```

- [ ] **Step 14.5: Build and manual-test on x.com**

```bash
pnpm dev
```

Open x.com (logged-in), compose a tweet, hit Post. Expected: original tweet posts natively; CrossPosty panel appears in the upper right with destinations checked.

- [ ] **Step 14.6: Commit**

```bash
git add src/composer
git commit -m "feat(composer): Shadow-DOM panel with per-platform editable variants"
```

---

## Task 15: Cross-post wiring through background (security boundary)

**Goal:** Posting from a content-script context may fail for LinkedIn (cookie access). Route cross-post requests through the background worker, which already has `chrome.cookies` access.

**Files:**
- Modify: `src/composer/ComposerPanel.tsx` — replace direct `adapter.post()` with `chrome.runtime.sendMessage({ type: 'CROSSPOST_REQUEST', ... })`.

- [ ] **Step 15.1: Replace direct adapter calls in `ComposerPanel.tsx:crosspost`**

```tsx
async function crosspost() {
  setBusy(true);
  const active = variants.filter((v) => v.enabled);
  // Note: backend expects one shared content; we send per-account because text may differ.
  const results = await Promise.all(
    active.map(async (v) => {
      const response = (await chrome.runtime.sendMessage({
        type: 'CROSSPOST_REQUEST',
        payload: { content: { text: v.text }, accountIds: [v.account.accountId] },
      })) as Array<{ accountId: string; result: PostResult }>;
      return response[0];
    }),
  );
  setVariants((vs) =>
    vs.map((v) => {
      const r = results.find((x) => x?.accountId === v.account.accountId);
      if (!r) return v;
      return {
        ...v,
        result: r.result.success
          ? { success: true, message: `Posted: ${r.result.url || 'ok'}` }
          : { success: false, message: `Failed: ${r.result.error}` },
      };
    }),
  );
  setBusy(false);
}
```

Remove the `getAdapter` import path from `ComposerPanel.tsx` if no longer referenced (keep it for `characterLimit` lookup).

- [ ] **Step 15.2: Build and manual-test end-to-end**

```bash
pnpm build
```

Reload extension. Compose on x.com → tweet posts natively → panel appears → "Cross-post" → BlueSky + Mastodon + LinkedIn all post. Disconnect WiFi mid-flow → see per-variant failure messages.

- [ ] **Step 15.3: Commit**

```bash
git add src/composer/ComposerPanel.tsx
git commit -m "feat(composer): route cross-post requests through background worker"
```

---

## Task 16: README polish + manual test doc

**Files:**
- Modify: `README.md`
- Create: `tests/MANUAL.md`

- [ ] **Step 16.1: Expand `README.md`**

Add sections: features list, supported platforms, install (load unpacked), connecting accounts (per-platform instructions: BlueSky app password URL, Mastodon access-token instructions, LinkedIn login), known limitations, license.

- [ ] **Step 16.2: Write `tests/MANUAL.md`**

```markdown
# Manual test checklist

## Setup
- [ ] `pnpm install && pnpm build`
- [ ] Load `.output/chrome-mv3/` as unpacked extension in Chrome

## Accounts
- [ ] Connect BlueSky with handle + app password
- [ ] Connect Mastodon: paste instance URL + access token from Preferences → Development
- [ ] Connect LinkedIn: log in at linkedin.com, then click "LinkedIn" in popup
- [ ] Each account shows in the list; remove works

## Source: X
- [ ] Compose on x.com, hit Post — tweet appears natively
- [ ] Panel appears with BlueSky / Mastodon / LinkedIn entries
- [ ] Edit each variant independently
- [ ] Click Cross-post — verify all three posts land

## Source: BlueSky
- [ ] Compose on bsky.app, hit Post — post appears natively
- [ ] Panel appears with Mastodon / LinkedIn entries (BlueSky filtered as source)
- [ ] Click Cross-post — verify both posts land

## Error handling
- [ ] Disconnect WiFi mid-cross-post — failures show per-variant; successes still succeed
- [ ] Remove all accounts, then compose — panel shows "no destinations" message

## Persistence
- [ ] Reload extension — accounts persist
- [ ] Disable + re-enable extension — accounts persist
```

- [ ] **Step 16.3: Commit**

```bash
git add README.md tests/MANUAL.md
git commit -m "docs: expand README and add manual test checklist"
```

---

## Task 17: Final verification + tag

- [ ] **Step 17.1: Full test pass**

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm build
```

All green.

- [ ] **Step 17.2: Manual smoke (run through `tests/MANUAL.md`)**

Document any failed checks in `NOTES.md`.

- [ ] **Step 17.3: Tag**

```bash
git tag v0.1.0-alpha
```

---

## Out of scope (do not implement)

- Scheduling, alarms, offscreen documents
- Reply inbox, analytics
- Threads, Reddit, Substack Notes, Tumblr
- Image upload (Phase 1 ships text-only cross-post; media is captured but not yet forwarded — note in README)
- Passphrase-derived encryption keys
- Firefox / Safari ports

These belong to Phase 2+ per the source spec.
