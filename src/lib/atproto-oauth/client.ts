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
    console.log('[CrossPosty] pdsFetch loop iter', { url, refreshed, nonceRetry });
    const ath = await sha256B64Url(session.accessToken);
    console.log('[CrossPosty] pdsFetch ath computed');
    const dpopJwt = await signDpopJwt(session.dpopKey, {
      htm: init.method,
      htu: url,
      ath,
      ...(session.dpopNonce ? { nonce: session.dpopNonce } : {}),
    });
    console.log('[CrossPosty] pdsFetch dpop signed', { jwtChars: dpopJwt.length });
    const headers: Record<string, string> = {
      Authorization: `DPoP ${session.accessToken}`,
      DPoP: dpopJwt,
    };
    if (init.contentType) headers['content-type'] = init.contentType;
    // Add a cache-busting query param on retries so Chrome's HTTP/2
    // stack treats the second fetch as a brand-new request rather than
    // reusing the keep-alive stream that just returned a 401. In SW
    // context the reuse path appears to hang indefinitely, even with
    // cache: 'no-store'. Path is unchanged; XRPC ignores unknown query
    // params, and `htu` in the DPoP JWT must match the actual request
    // URL (including the cache buster) so we use the same here.
    const reqUrl =
      nonceRetry || refreshed
        ? `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : url;
    // The DPoP htu claim must match the actual request URL on retries.
    // We re-sign here so retried JWTs encode the cache-busted URL.
    let actualDpopJwt = dpopJwt;
    if (reqUrl !== url) {
      actualDpopJwt = await signDpopJwt(session.dpopKey, {
        htm: init.method,
        htu: reqUrl,
        ath,
        ...(session.dpopNonce ? { nonce: session.dpopNonce } : {}),
      });
      headers.DPoP = actualDpopJwt;
    }
    console.log('[CrossPosty] pdsFetch sending fetch', { reqUrl });
    const ctrl = new AbortController();
    const fetchTimeout = setTimeout(() => ctrl.abort(), 8000);
    let resp: Response;
    try {
      resp = await fetch(reqUrl, {
        method: init.method,
        headers,
        body: init.body,
        signal: ctrl.signal,
        cache: 'no-store',
        keepalive: false,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }
    console.log('[CrossPosty] pdsFetch response received', {
      status: resp.status,
      hasNonce: !!resp.headers.get('DPoP-Nonce'),
    });

    const newNonce = resp.headers.get('DPoP-Nonce');
    if (newNonce && newNonce !== session.dpopNonce) {
      session = { ...session, dpopNonce: newNonce };
    }

    if (resp.status === 401) {
      const wwwAuth = resp.headers.get('WWW-Authenticate') ?? '';
      const willRetry =
        (!nonceRetry && /use_dpop_nonce/.test(wwwAuth)) ||
        (!refreshed && /invalid_token|invalid_dpop_proof/.test(wwwAuth));
      if (willRetry) {
        // Drain the unread body so Chrome can free the keep-alive
        // connection. Without this the next fetch on the same origin
        // can stall waiting for the previous stream to be consumed.
        await resp.text().catch(() => undefined);
        console.log('[CrossPosty] pdsFetch retrying', {
          nonce: session.dpopNonce,
          nonceChars: session.dpopNonce?.length,
          wwwAuth,
        });
        // Brief breathing room before reopening a TCP/HTTP2 stream to
        // the same origin — without this Chrome's HTTP stack appears
        // to keep the second fetch pending indefinitely in SW context.
        await new Promise((r) => setTimeout(r, 250));
      }
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
