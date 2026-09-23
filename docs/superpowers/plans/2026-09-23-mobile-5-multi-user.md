# CrossPosty Mobile — Plan 5: Multiple Users

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any email on an allowlist can sign in and connect their own Bluesky and X accounts from the app; X is connected through the real OAuth 2.0 flow against the owner's developer app.

**Architecture:** An `allowed_emails` table replaces the single-owner Vault check in the `auth.users` trigger. A new `x-oauth-callback` Edge Function exchanges an authorization code (with the PKCE verifier the PWA generated) using the client secret, verifies the granted scopes include `media.write`, and stores encrypted tokens under the signed-in user. The PWA gains a "Connect X" button and a `/oauth/x/callback` route. Nothing changes in posting: every table was already per-user.

**Tech Stack:** existing Supabase/Deno backend, X OAuth 2.0 authorization-code + PKCE (`https://x.com/i/oauth2/authorize`, `POST https://api.x.com/2/oauth2/token`), existing PWA.

**Repo:** `C:\Users\drice\CrossPosty-mobile` (HEAD `a3dea0e`). Callback URI `https://crossposty-phone.netlify.app/oauth/x/callback` is already registered on the X app (confirm in the developer portal before Task 4).

**Decisions:** all users' X posts bill the owner's developer balance (option A). Owner adds emails by SQL; no admin UI. Connecting X works from any browser where the user is signed in (the result is server-side); the docs recommend Safari on iPhone rather than the installed app for that one step.

---

## File structure

```
supabase/migrations/20260923000008_allowed_emails.sql
supabase/functions/_shared/x-oauth.ts (+ .test.ts)    # exchangeAuthCode, X_SCOPES, missingScopes
supabase/functions/x-oauth-callback/index.ts
supabase/config.toml                                   # [functions.x-oauth-callback]
scripts/authorize-x.ts                                 # reuse exchange helper (optional)
app/src/lib/xoauth.ts                                  # startXConnect / finishXConnect
app/src/screens/XCallback.tsx
app/src/App.tsx                                        # /oauth/x/callback route
app/src/screens/Accounts.tsx                           # Connect X / Reconnect X
docs/SETUP.md                                          # §14 adding a user, connecting X
```

---

### Task 1: Allowlist migration

**Files:** `supabase/migrations/20260923000008_allowed_emails.sql`

```sql
-- Who may sign in. Replaces the single owner_email Vault check. The owner
-- adds rows by SQL:  insert into allowed_emails (email) values ('x@y.z');
create table allowed_emails (
  email    text primary key,
  added_at timestamptz not null default now()
);
-- Only the trigger (security definer) reads it; nobody writes it from the app.
revoke all on allowed_emails from anon, authenticated;

-- Seed with the existing owner so nothing changes for them.
insert into allowed_emails (email)
select lower(decrypted_secret) from vault.decrypted_secrets where name = 'owner_email'
on conflict do nothing;

create or replace function enforce_allowed_email() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is null
     or not exists (select 1 from allowed_emails where email = lower(new.email)) then
    -- Surfaces to the client as an opaque 500 "Database error saving new user".
    raise exception 'sign-ups are closed';
  end if;
  return new;
end $$;

drop trigger if exists enforce_owner_email on auth.users;
drop function if exists enforce_owner_email();
create trigger enforce_allowed_email before insert on auth.users
  for each row execute function enforce_allowed_email();
```

- [ ] Write, `npx supabase db push --yes`, verify `select email from allowed_emails` shows the owner, commit `feat(db): allowed_emails replaces the single owner lock`.

---

### Task 2: `exchangeAuthCode` + `x-oauth-callback` function

**Files:** `supabase/functions/_shared/x-oauth.ts`, `x-oauth.test.ts`, `supabase/functions/x-oauth-callback/index.ts`, `config.toml`.

- [ ] **Tests first** (`x-oauth.test.ts`):

```ts
import { assertEquals, assertRejects } from '@std/assert';
import { bodyJson, fakeFetch, json } from '../test-utils.ts';
import { exchangeAuthCode, missingScopes, X_SCOPES } from './x-oauth.ts';
import { PostError } from './adapters/types.ts';

const cfg = { clientId: 'cid', clientSecret: 'csecret' };

Deno.test('exchangeAuthCode posts the code grant with PKCE and Basic auth, returns tokens + scopes', async () => {
  const fetch = fakeFetch({
    'oauth2/token': (_u, init) => {
      const h = init.headers as Record<string, string>;
      assertEquals(h.authorization, `Basic ${btoa('cid:csecret')}`);
      const body = String(init.body);
      for (const part of ['grant_type=authorization_code', 'code=abc', 'code_verifier=ver', 'client_id=cid']) {
        assertEquals(body.includes(part), true, part);
      }
      assertEquals(body.includes('redirect_uri=https%3A%2F%2Fapp%2Foauth%2Fx%2Fcallback'), true);
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: X_SCOPES.join(' ') });
    },
    'users/me': () => json({ data: { id: '7', username: 'julia' } }),
  });
  const out = await exchangeAuthCode(
    { code: 'abc', codeVerifier: 'ver', redirectUri: 'https://app/oauth/x/callback' },
    cfg,
    fetch,
    1_700_000_000_000,
  );
  assertEquals(out.tokens, { accessToken: 'at', refreshToken: 'rt', userId: '7', handle: 'julia', expiresAt: 1_700_000_000_000 + 7200_000 });
  assertEquals(out.granted, X_SCOPES);
});

Deno.test('a rejected code is a permanent error with the provider detail', async () => {
  const fetch = fakeFetch({ 'oauth2/token': () => json({ error: 'invalid_request', error_description: 'code expired' }, 400) });
  const err = await assertRejects(
    () => exchangeAuthCode({ code: 'x', codeVerifier: 'v', redirectUri: 'r' }, cfg, fetch),
    PostError,
  );
  assertEquals(err.message.includes('code expired'), true);
});

Deno.test('missingScopes lists what the token lacks', () => {
  assertEquals(missingScopes(['tweet.read', 'tweet.write']), ['users.read', 'media.write', 'offline.access']);
  assertEquals(missingScopes(X_SCOPES), []);
});
```

- [ ] **`x-oauth.ts`**

```ts
// OAuth 2.0 authorization-code exchange for X, shared by the
// x-oauth-callback function and the authorize-x script.
import { fetchMe, X_API, type XClientConfig } from './adapters/x.ts';
import { PostError } from './adapters/types.ts';
import type { XTokens } from './types.ts';

export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

export function missingScopes(granted: string[]): string[] {
  return X_SCOPES.filter((s) => !granted.includes(s));
}

export async function exchangeAuthCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: XClientConfig,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<{ tokens: XTokens; granted: string[] }> {
  const res = await fetchImpl(`${X_API}/2/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: config.clientId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = j.error_description ?? j.error ?? '';
    } catch { /* keep empty */ }
    throw new PostError(`X token exchange failed (HTTP ${res.status}): ${detail || 'no detail'}`, 'permanent', { status: res.status });
  }
  const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  if (!tok.refresh_token) throw new PostError('X returned no refresh token (offline.access missing?)', 'permanent');
  const me = await fetchMe(tok.access_token, fetchImpl);
  return {
    tokens: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      userId: me.id,
      handle: me.username,
      expiresAt: nowMs + tok.expires_in * 1000,
    },
    granted: (tok.scope ?? '').split(/\s+/).filter(Boolean),
  };
}
```

- [ ] **`x-oauth-callback/index.ts`**

```ts
// Completes "Connect X" for the signed-in user: exchanges the code the
// PWA received (with its PKCE verifier) using the client secret, checks
// the scopes, and stores the encrypted tokens under that user.
import { createClient } from '@supabase/supabase-js';
import { encryptJson, importTokenKey } from '../_shared/crypto.ts';
import { corsHeaders, env, jsonResponse, requireUser, serviceKey } from '../_shared/http.ts';
import { exchangeAuthCode, missingScopes } from '../_shared/x-oauth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  const user = await requireUser(req);
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  const clientId = Deno.env.get('X_CLIENT_ID');
  const clientSecret = Deno.env.get('X_CLIENT_SECRET');
  if (!clientId || !clientSecret) return jsonResponse({ error: 'X is not configured on the server' }, 503);

  let body: { code?: string; codeVerifier?: string; redirectUri?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  if (!body.code || !body.codeVerifier || !body.redirectUri) {
    return jsonResponse({ error: 'code, codeVerifier and redirectUri are required' }, 400);
  }

  try {
    const { tokens, granted } = await exchangeAuthCode(
      { code: body.code, codeVerifier: body.codeVerifier, redirectUri: body.redirectUri },
      { clientId, clientSecret },
      fetch,
    );
    const missing = missingScopes(granted);
    if (missing.length > 0) {
      return jsonResponse({ error: `X did not grant: ${missing.join(' ')}. Approve all permissions and try again.` }, 400);
    }
    const key = await importTokenKey(env('TOKEN_KEY'));
    const admin = createClient(env('SUPABASE_URL'), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await admin.from('accounts').upsert({
      user_id: user.id,
      platform: 'x',
      handle: tokens.handle,
      secret: await encryptJson(key, tokens),
      expires_at: new Date(tokens.expiresAt).toISOString(),
      status: 'ok',
    });
    if (error) throw error;
    return jsonResponse({ handle: tokens.handle });
  } catch (err) {
    console.error('x-oauth-callback failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg.startsWith('X ') ? msg : 'could not connect X' }, 502);
  }
});
```

`config.toml`: `[functions.x-oauth-callback]` with `verify_jwt = false`, import map. Optional: make `scripts/authorize-x.ts` call `exchangeAuthCode` instead of its inline copy.

- [ ] `deno task check` green (110 + 3), deploy `x-oauth-callback`, commit `feat(x): oauth callback function for per-user Connect X`.

---

### Task 3: App — Connect X button and callback route

**Files:** `app/src/lib/xoauth.ts`, `app/src/screens/XCallback.tsx`, `app/src/App.tsx`, `app/src/screens/Accounts.tsx`.

- [ ] **`lib/xoauth.ts`**

```ts
import { FUNCTIONS_URL, supabase } from './supabase';

const KEY = 'crossposty.xoauth';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
export const REDIRECT_URI = `${window.location.origin}/oauth/x/callback`;

type Pending = { verifier: string; state: string; startedAt: number };

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Builds the authorize URL and remembers the PKCE verifier for the callback.
export async function startXConnect(clientId: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  localStorage.setItem(KEY, JSON.stringify({ verifier, state, startedAt: Date.now() } satisfies Pending));
  const u = new URL('https://x.com/i/oauth2/authorize');
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

export async function finishXConnect(params: URLSearchParams): Promise<string> {
  const raw = localStorage.getItem(KEY);
  localStorage.removeItem(KEY);
  const err = params.get('error');
  if (err) throw new Error(err === 'access_denied' ? 'You cancelled on X.' : `X returned ${err}.`);
  if (!raw) throw new Error('No pending X connection in this browser. Start again from Accounts.');
  const pending = JSON.parse(raw) as Pending;
  if (Date.now() - pending.startedAt > 10 * 60_000) throw new Error('That took too long. Start again from Accounts.');
  if (params.get('state') !== pending.state) throw new Error('State mismatch. Start again from Accounts.');
  const code = params.get('code');
  if (!code) throw new Error('No code in the callback.');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('not signed in');
  const res = await fetch(`${FUNCTIONS_URL}/x-oauth-callback`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: pending.verifier, redirectUri: REDIRECT_URI }),
  });
  const body = (await res.json()) as { handle?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.handle ?? 'connected';
}
```

The client ID is public: add `VITE_X_CLIENT_ID` to `.env.example`, `.env.local`, the production env writer in the deploy step, and read it in Accounts (`import.meta.env.VITE_X_CLIENT_ID`).

- [ ] **`screens/XCallback.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { finishXConnect } from '../lib/xoauth';

export function XCallback() {
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'ok'; handle: string } | { kind: 'error'; message: string }>({ kind: 'working' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke; the code is single-use
    started.current = true;
    finishXConnect(new URLSearchParams(window.location.search))
      .then((handle) => setState({ kind: 'ok', handle }))
      .catch((err) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, []);
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-4 p-6 text-center">
      {state.kind === 'working' && <p className="text-gray-600">Connecting X…</p>}
      {state.kind === 'ok' && <p className="text-emerald-700">Connected @{state.handle}.</p>}
      {state.kind === 'error' && <p className="text-red-600">{state.message}</p>}
      {state.kind !== 'working' && (
        <button type="button" className="bg-emerald-600 text-white rounded px-4 py-3" onClick={() => window.location.replace('/?tab=accounts')}>
          Back to the app
        </button>
      )}
    </div>
  );
}
```

- [ ] **`App.tsx`**: after the session gate (`if (!session) return <SignIn />`), add `if (window.location.pathname === '/oauth/x/callback') return <XCallback />;`. (If the user isn't signed in, SignIn shows first; the pending verifier survives in localStorage, and after sign-in the callback renders.)

- [ ] **`Accounts.tsx`** X section: replace the script hint with a button. `const xClientId = import.meta.env.VITE_X_CLIENT_ID as string | undefined;` If missing, show "X connection isn't configured for this build." Else a button labelled `Connect X` (no account) or `Reconnect X` (`needs_reconnect`), and when connected show `@handle · connected` with a smaller `Reconnect` link; also `disconnect` with confirm, like Bluesky. On tap: `startXConnect(xClientId).then((url) => window.location.assign(url))`. Add a one-line hint under it: "Opens X to approve. On iPhone, do this once in Safari if the installed app doesn't come back here."

- [ ] Build/test/lint green; commit `feat(app): connect X in-app via OAuth`.

---

### Task 4: Deploy, add Julia, verify

- [ ] Confirm in the X developer portal that `https://crossposty-phone.netlify.app/oauth/x/callback` is a registered callback URI, and update the app's use-case description to mention a family member on their own account.
- [ ] Add `VITE_X_CLIENT_ID=<X_CLIENT_ID>` to `.env.smoke`'s app section; extend the `app/.env.production` writer; build; `netlify deploy --prod`.
- [ ] `npx supabase db query --linked "insert into allowed_emails (email) values ('<julia email, lowercase>')"`.
- [ ] **Owner self-test** in Safari on the phone or a desktop browser: Accounts → Reconnect X → approve → "Connected @Drice4523". Then Post now a text post to X to prove the new tokens work.
- [ ] **Julia**: opens the URL, signs in with her email and code, Accounts → Bluesky (handle + app password) → Connect X (approve) → Compose a post to both → Post now. Owner confirms the X charge appears on the developer account.
- [ ] `docs/SETUP.md` §14: adding a user (SQL), connecting X, Safari note; commit and push.

---

## Self-review

**Spec amendment coverage:** allowlist ✔ T1; in-app Connect X with PKCE, server-side exchange, `media.write` check, per-user storage ✔ T2–T3; Bluesky unchanged ✔; option A billing ✔ T4. Nothing extra.

**Type consistency:** `exchangeAuthCode` returns `XTokens` matching `types.ts` (with `expiresAt`); the callback's upsert matches the `accounts` columns; `finishXConnect` posts exactly the three fields the function requires; `VITE_X_CLIENT_ID` is read in one place.
