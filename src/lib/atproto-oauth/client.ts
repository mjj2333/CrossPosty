// Authenticated, DPoP-bound fetch to the user's PDS.
//
// On top of plain DPoP signing this layer handles:
//   - DPoP-Nonce rotation: the resource server can demand a nonce; we
//     remember the latest one and replay it on the next request so we
//     usually fit in one round-trip.
//   - 401 with "use_dpop_nonce": retry with the new nonce.
//   - 401 with "invalid_token": refresh the access token and retry.
//
// Returns the (possibly rotated) session alongside the response so
// callers can persist updates. The BSky adapter calls updateCredential()
// whenever the returned session differs from what it loaded.

import { sha256B64Url, signDpopJwt } from './dpop';
import { refreshAtprotoOAuthSession, type AtprotoOAuthSession } from './flow';

export type PdsCallResult = {
  response: Response;
  session: AtprotoOAuthSession;
};

export async function pdsFetch(
  initialSession: AtprotoOAuthSession,
  path: string,
  init: { method: string; body?: BodyInit; contentType?: string },
): Promise<PdsCallResult> {
  const url = new URL(path, initialSession.pdsUrl).toString();
  let session = initialSession;
  let refreshed = false;
  let nonceRetry = false;

  while (true) {
    const ath = await sha256B64Url(session.accessToken);
    const dpopJwt = await signDpopJwt(session.dpopKey, {
      htm: init.method,
      htu: url,
      ath,
      ...(session.dpopNonce ? { nonce: session.dpopNonce } : {}),
    });
    const headers: Record<string, string> = {
      Authorization: `DPoP ${session.accessToken}`,
      DPoP: dpopJwt,
    };
    if (init.contentType) headers['content-type'] = init.contentType;
    const resp = await fetch(url, { method: init.method, headers, body: init.body });

    const newNonce = resp.headers.get('DPoP-Nonce');
    if (newNonce && newNonce !== session.dpopNonce) {
      session = { ...session, dpopNonce: newNonce };
    }

    if (resp.status === 401) {
      const wwwAuth = resp.headers.get('WWW-Authenticate') ?? '';
      if (!nonceRetry && /use_dpop_nonce/.test(wwwAuth)) {
        nonceRetry = true;
        continue;
      }
      if (!refreshed && /invalid_token|invalid_dpop_proof/.test(wwwAuth)) {
        session = await refreshAtprotoOAuthSession(session);
        refreshed = true;
        continue;
      }
    }
    return { response: resp, session };
  }
}
