// The atproto OAuth handshake, end-to-end:
//
//   1. resolve handle -> DID -> PDS -> auth server metadata
//   2. generate a DPoP keypair (per-session, ECDSA P-256)
//   3. PAR (Pushed Authorization Request) -- POST our auth params to the
//      auth server, signed with DPoP, with PKCE challenge. First attempt
//      typically 400s with a DPoP-Nonce header; we retry once with the
//      nonce. Server returns a request_uri.
//   4. open the user's auth server URL via chrome.identity.launchWebAuthFlow;
//      user logs in + grants scopes. Chrome catches the redirect to
//      chromiumapp.org and hands us the URL with code + state.
//   5. validate state, then exchange code at the token endpoint (also DPoP-
//      signed, also with nonce). Server returns access + refresh tokens,
//      bound to our DPoP key.
//
// All HTTP requests to the auth server are DPoP-bound. Resource (PDS)
// requests are handled by ./client.ts, which adds the `ath` claim
// (access-token hash) on top.

import { generateDpopKey, sha256B64Url, signDpopJwt, type DpopKeyMaterial } from './dpop';
import { resolveAtprotoAuthTarget } from './resolve';

const CLIENT_ID = 'https://mjj2333.github.io/CrossPosty/client-metadata.json';
const SCOPE = 'atproto transition:generic';

export type AtprotoOAuthSession = {
  did: string;
  handle: string;
  pdsUrl: string;
  authServerUrl: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  dpopKey: DpopKeyMaterial;
  dpopNonce?: string;
};

function base64UrlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomB64Url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlBytes(bytes);
}

// DPoP-bound fetch used during the handshake (no access token yet for PAR;
// access token present for refresh). Retries once with a server-issued
// nonce if the first response demands it.
async function dpopFetch(args: {
  url: string;
  method: string;
  dpopKey: DpopKeyMaterial;
  accessToken?: string;
  body?: string;
  contentType?: string;
  nonce?: string;
  // Internal: set on the recursive call so we never loop forever.
  _retried?: boolean;
}): Promise<Response> {
  const { url, method, dpopKey, accessToken, body, contentType, nonce, _retried } = args;
  const claims = {
    htm: method,
    htu: url,
    ...(nonce ? { nonce } : {}),
    ...(accessToken ? { ath: await sha256B64Url(accessToken) } : {}),
  };
  const dpopJwt = await signDpopJwt(dpopKey, claims);
  const headers: Record<string, string> = { DPoP: dpopJwt };
  if (contentType) headers['content-type'] = contentType;
  if (accessToken) headers.Authorization = `DPoP ${accessToken}`;
  const resp = await fetch(url, { method, headers, body });
  // Retry on DPoP nonce mismatch — happens even when we DID pass a
  // nonce, because each server (PDS vs auth server) keeps its own
  // nonce stream and our caller may pass a stale one (e.g. refresh
  // uses the PDS nonce against the auth server). Single retry; if it
  // still fails after that, surface the error to the caller.
  if (!_retried && (resp.status === 400 || resp.status === 401)) {
    const serverNonce = resp.headers.get('DPoP-Nonce');
    if (serverNonce && serverNonce !== nonce) {
      return dpopFetch({ ...args, nonce: serverNonce, _retried: true });
    }
  }
  return resp;
}

export async function authenticateWithBluesky(
  handle: string,
): Promise<AtprotoOAuthSession> {
  const redirectUri = chrome.identity.getRedirectURL();
  const target = await resolveAtprotoAuthTarget(handle);
  const dpopKey = await generateDpopKey();

  // PKCE
  const codeVerifier = randomB64Url(64);
  const codeChallenge = await sha256B64Url(codeVerifier);
  const state = randomB64Url(16);

  // Step 1: PAR
  const parParams = new URLSearchParams({
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    client_id: CLIENT_ID,
    state,
    redirect_uri: redirectUri,
    scope: SCOPE,
    login_hint: handle,
  });
  const parResp = await dpopFetch({
    url: target.authServerMetadata.pushed_authorization_request_endpoint,
    method: 'POST',
    dpopKey,
    contentType: 'application/x-www-form-urlencoded',
    body: parParams.toString(),
  });
  if (!parResp.ok) {
    const body = await parResp.text();
    throw new Error(
      `PAR failed (HTTP ${parResp.status}): ${body.slice(0, 200)}`,
    );
  }
  const parJson = (await parResp.json()) as { request_uri: string };

  // Step 2: redirect user to authorization endpoint
  const authUrl =
    `${target.authServerMetadata.authorization_endpoint}?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      request_uri: parJson.request_uri,
    }).toString();

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });
  if (!callbackUrl) throw new Error('BlueSky authorization was cancelled.');

  const cb = new URL(callbackUrl);
  const code = cb.searchParams.get('code');
  const returnedState = cb.searchParams.get('state');
  const returnedIss = cb.searchParams.get('iss');
  const cbError = cb.searchParams.get('error');
  if (cbError) {
    const desc = cb.searchParams.get('error_description') ?? '';
    throw new Error(`Authorization error: ${cbError} ${desc}`.trim());
  }
  if (!code) throw new Error('Authorization server returned no code.');
  if (returnedState !== state) throw new Error('State mismatch (possible CSRF).');
  // atproto OAuth requires verifying that the issuer on the callback
  // matches the auth server we initiated PAR against — protects against
  // issuer mix-up attacks.
  if (returnedIss && returnedIss !== target.authServerMetadata.issuer) {
    throw new Error(
      `Issuer mismatch on callback: got ${returnedIss}, expected ${target.authServerMetadata.issuer}`,
    );
  }

  // Step 3: token exchange
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const tokenResp = await dpopFetch({
    url: target.authServerMetadata.token_endpoint,
    method: 'POST',
    dpopKey,
    contentType: 'application/x-www-form-urlencoded',
    body: tokenParams.toString(),
  });
  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `Token exchange failed (HTTP ${tokenResp.status}): ${body.slice(0, 200)}`,
    );
  }
  const tokenJson = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    sub?: string;
    token_type: string;
  };
  return {
    did: target.did,
    handle: target.handle,
    pdsUrl: target.pdsUrl,
    authServerUrl: target.authServerUrl,
    tokenEndpoint: target.authServerMetadata.token_endpoint,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + tokenJson.expires_in,
    dpopKey,
    dpopNonce: tokenResp.headers.get('DPoP-Nonce') ?? undefined,
  };
}

export async function refreshAtprotoOAuthSession(
  session: AtprotoOAuthSession,
): Promise<AtprotoOAuthSession> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
  });
  const resp = await dpopFetch({
    url: session.tokenEndpoint,
    method: 'POST',
    dpopKey: session.dpopKey,
    contentType: 'application/x-www-form-urlencoded',
    body: params.toString(),
    nonce: session.dpopNonce,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Refresh failed (HTTP ${resp.status}): ${body.slice(0, 200)}`);
  }
  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    ...session,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
    dpopNonce: resp.headers.get('DPoP-Nonce') ?? session.dpopNonce,
  };
}
