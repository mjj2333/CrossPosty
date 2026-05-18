// Patches window.fetch AND XMLHttpRequest in MAIN world before page scripts run.
//
// MUST be a `world: 'MAIN'` content script (declared in the manifest) so it
// executes synchronously before any page scripts - otherwise the page bundle
// can capture references to fetch/XHR into its closure before we patch them.
//
// We hook two classes of requests:
//
//   1. *Compose* requests (CreateTweet on X, applyWrites/createRecord on
//      BlueSky). We dispatch `crossposty:intercept` so the ISOLATED-world
//      content script can mount the cross-post panel.
//
//   2. *Media upload* requests (upload.twitter.com APPEND on X,
//      xrpc/uploadBlob on BlueSky). We capture binary bodies + the media
//      identifier and dispatch `crossposty:media-segment`. The ISOLATED
//      content script stashes them in IndexedDB so that when a compose
//      request fires referencing those IDs, we can resurrect the bytes and
//      forward them to other destinations.

import { debugLog } from '../lib/debug';

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*', '*://bsky.app/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    type Marker = { __crossposty_installed?: boolean };
    if ((window as unknown as Marker).__crossposty_installed) return;
    (window as unknown as Marker).__crossposty_installed = true;
    console.log('[CrossPosty] main-world hook installed (fetch + XHR)');

    patchFetch();
    patchXHR();

    // ---- URL matchers ----------------------------------------------------

    function isInteresting(url: string): boolean {
      return (
        /(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(url) ||
        /\/xrpc\/com\.atproto\.repo\.(?:createRecord|applyWrites)/.test(url)
      );
    }

    function isGraphqlish(url: string): boolean {
      return (
        /\/graphql\//.test(url) ||
        /CreateTweet|CreatePost|CreateNote/i.test(url) ||
        /\/xrpc\/com\.atproto/.test(url)
      );
    }

    // Pure read-only CDN hosts - bypass entirely.
    const CDN_BYPASS_RE = /(?:^https?:\/\/)?(?:pbs\.twimg\.com|video\.twimg\.com|ton\.x\.com)\//;
    // Media upload endpoints - we tap these for capture.
    // Match any path under upload.(twitter|x).com so we don't miss new
    // endpoint variants. The capture functions still filter further by
    // command=APPEND etc.
    const X_MEDIA_UPLOAD_RE = /upload\.(?:twitter|x)\.com\//;
    // Diagnostic regex: log ANY URL on an X-related upload-ish host so we
    // can see what X is actually using when our specific capture misses.
    const X_UPLOAD_HOST_LOG_RE = /(?:upload|ads-api|api)\.(?:twitter|x)\.com\//;
    const BSKY_UPLOAD_BLOB_RE = /\/xrpc\/com\.atproto\.repo\.uploadBlob/;

    // ---- Compose intercept dispatch -------------------------------------

    function dispatchIntercept(url: string, body: string, headers: Record<string, string>): void {
      console.log('[CrossPosty] dispatching crossposty:intercept', {
        url,
        bodyChars: body.length,
      });
      window.dispatchEvent(
        new CustomEvent('crossposty:intercept', {
          detail: { url, body, headers },
        }),
      );
    }

    // ---- Media capture dispatch -----------------------------------------

    type MediaSegmentDetail = {
      sourcePlatform: 'x' | 'bluesky';
      mediaId: string;
      segmentIndex: number;
      blob: Blob;
      mimeType: string;
    };

    function dispatchMediaSegment(d: MediaSegmentDetail): void {
      console.log('[CrossPosty] media segment captured', {
        platform: d.sourcePlatform,
        mediaId: d.mediaId,
        segmentIndex: d.segmentIndex,
        bytes: d.blob.size,
        mime: d.mimeType,
      });
      window.dispatchEvent(new CustomEvent('crossposty:media-segment', { detail: d }));
    }

    // ---- fetch patch ----------------------------------------------------

    function patchFetch() {
      const origFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        try {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;

          if (CDN_BYPASS_RE.test(url)) return origFetch(input, init);

          // Diagnostic: log all upload-host hits so we can see what URL X
          // is actually using if our specific capture path doesn't fire.
          if (X_UPLOAD_HOST_LOG_RE.test(url)) {
            debugLog('[CrossPosty] fetch upload-host URL', url, {
              method: init?.method ?? 'GET',
              hasInit: !!init,
              hasInitBody: !!init?.body,
              inputIsRequest: input instanceof Request,
            });
          }

          // Media uploads: BlueSky needs response tap to learn cid; X has
          // media_id in the request body so we can capture without awaiting
          // the response.
          if (BSKY_UPLOAD_BLOB_RE.test(url)) {
            return await tapBskyUpload(url, input, init, origFetch);
          }
          if (X_MEDIA_UPLOAD_RE.test(url)) {
            console.log('[CrossPosty] X media tap firing for', url);
            tapXMediaUpload(input, init).catch((err) =>
              console.warn('[CrossPosty] X media tap failed', err),
            );
            return origFetch(input, init);
          }

          if (isGraphqlish(url)) {
            debugLog('[CrossPosty] fetch graphql-ish URL', url);
          }
          if (isInteresting(url)) {
            const bodyText = await readFetchBody(input, init);
            const headers = readFetchHeaders(input, init);
            if (bodyText) {
              dispatchIntercept(url, bodyText, headers);
            } else {
              console.warn(
                '[CrossPosty] interesting URL but body unreadable - body type unsupported?',
                { url, hasInit: !!init, inputIsRequest: input instanceof Request },
              );
            }
          }
        } catch (err) {
          console.warn('[CrossPosty] fetch hook threw', err);
        }
        return origFetch(input, init);
      };
    }

    async function readFetchBody(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<string> {
      const body = init?.body;
      if (body != null) {
        if (typeof body === 'string') return body;
        if (body instanceof Blob) return body.text();
        if (body instanceof URLSearchParams) return body.toString();
        if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
        if (ArrayBuffer.isView(body)) {
          return new TextDecoder().decode(body as Uint8Array);
        }
        return '';
      }
      if (input instanceof Request) {
        try {
          return await input.clone().text();
        } catch {
          return '';
        }
      }
      return '';
    }

    function readFetchHeaders(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Record<string, string> {
      if (init?.headers) return normalizeHeaders(init.headers);
      if (input instanceof Request) return normalizeHeaders(input.headers);
      return {};
    }

    async function readBodyAsBlob(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Blob | null> {
      const body = init?.body;
      if (body instanceof Blob) return body;
      if (body instanceof ArrayBuffer) return new Blob([body]);
      if (ArrayBuffer.isView(body)) return new Blob([body as BlobPart]);
      if (input instanceof Request) {
        try {
          return await input.clone().blob();
        } catch {
          return null;
        }
      }
      return null;
    }

    // ---- BlueSky media capture ------------------------------------------

    async function tapBskyUpload(
      _url: string,
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      origFetch: typeof fetch,
    ): Promise<Response> {
      // Read the request body BEFORE firing the fetch - the body is the
      // raw image bytes that we want to keep a copy of.
      const reqBlob = await readBodyAsBlob(input, init);
      const response = await origFetch(input, init);

      if (reqBlob && response.ok) {
        // Tap response asynchronously to learn the cid. Cloning before
        // .json() keeps the original response stream intact for the caller.
        response
          .clone()
          .json()
          .then((json: unknown) => {
            const cid = extractBskyCid(json);
            if (cid) {
              dispatchMediaSegment({
                sourcePlatform: 'bluesky',
                mediaId: cid,
                segmentIndex: 0,
                blob: reqBlob,
                mimeType: reqBlob.type || 'application/octet-stream',
              });
            } else {
              console.warn(
                '[CrossPosty] bsky uploadBlob 2xx but no cid in response',
                json,
              );
            }
          })
          .catch((err) => {
            console.warn('[CrossPosty] bsky uploadBlob response read failed', err);
          });
      }

      return response;
    }

    function extractBskyCid(json: unknown): string | null {
      if (typeof json !== 'object' || json === null) return null;
      const root = json as { blob?: { ref?: { $link?: unknown } } };
      const cid = root.blob?.ref?.$link;
      return typeof cid === 'string' ? cid : null;
    }

    // ---- X media capture ------------------------------------------------

    async function tapXMediaUpload(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<void> {
      // The X media-upload endpoint serves INIT, APPEND, and FINALIZE.
      // We only care about APPEND, which carries the binary segment.
      // Both query-string and FormData call-shapes are observed in the wild.
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      const commandFromQuery = (() => {
        try {
          return new URL(url, location.origin).searchParams.get('command');
        } catch {
          return null;
        }
      })();

      // FormData via init
      if (init?.body instanceof FormData) {
        captureXAppendFromFormData(init.body, url, commandFromQuery);
        return;
      }
      // FormData via Request body
      if (input instanceof Request) {
        try {
          const form = await input.clone().formData();
          captureXAppendFromFormData(form, url, commandFromQuery);
          return;
        } catch {
          // not form-data; fall through
        }
      }
      // Some X paths send the binary as the raw body with the command in the
      // query string. Capture those too.
      if (commandFromQuery === 'APPEND') {
        const reqBlob = await readBodyAsBlob(input, init);
        if (!reqBlob || reqBlob.size === 0) return;
        const mediaId = new URL(url, location.origin).searchParams.get('media_id');
        const segmentIndex = Number(
          new URL(url, location.origin).searchParams.get('segment_index') ?? '0',
        );
        if (!mediaId) return;
        dispatchMediaSegment({
          sourcePlatform: 'x',
          mediaId,
          segmentIndex: Number.isFinite(segmentIndex) ? segmentIndex : 0,
          blob: reqBlob,
          mimeType: reqBlob.type || 'application/octet-stream',
        });
      }
    }

    // X's chunked upload protocol puts command/media_id/segment_index in the
    // URL query string when called via XHR, and in the FormData body when
    // called via fetch (older clients). This function looks in both places —
    // FormData first, URL query as fallback — so we capture either shape.
    function captureXAppendFromFormData(
      form: FormData,
      url: string | null,
      commandFromQueryOverride: string | null = null,
    ): void {
      const urlParams = (() => {
        if (!url) return null;
        try {
          return new URL(url, location.origin).searchParams;
        } catch {
          return null;
        }
      })();

      const fromForm = (k: string): string | null => {
        const v = form.get(k);
        return typeof v === 'string' ? v : null;
      };
      const fromQuery = (k: string): string | null => urlParams?.get(k) ?? null;

      const command = fromForm('command') ?? commandFromQueryOverride ?? fromQuery('command');
      if (command !== 'APPEND') return;
      const mediaId = fromForm('media_id') ?? fromQuery('media_id');
      if (!mediaId) {
        console.warn('[CrossPosty] X APPEND with no media_id', { url });
        return;
      }
      const segIdxStr = fromForm('segment_index') ?? fromQuery('segment_index') ?? '0';
      const idx = Number(segIdxStr);
      const media = form.get('media');
      if (!(media instanceof Blob)) {
        console.warn('[CrossPosty] X APPEND but FormData.media is not a Blob', {
          url,
          mediaCtor: (media as { constructor?: { name?: string } } | null)?.constructor?.name,
        });
        return;
      }
      dispatchMediaSegment({
        sourcePlatform: 'x',
        mediaId,
        segmentIndex: Number.isFinite(idx) ? idx : 0,
        blob: media,
        mimeType: media.type || 'application/octet-stream',
      });
    }

    // ---- XHR patch ------------------------------------------------------

    function patchXHR() {
      const XHR = XMLHttpRequest.prototype;
      const origOpen = XHR.open;
      const origSend = XHR.send;
      const origSetRequestHeader = XHR.setRequestHeader;

      type Tagged = XMLHttpRequest & {
        __crossposty_url?: string;
        __crossposty_method?: string;
        __crossposty_headers?: Record<string, string>;
      };

      XHR.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
        const t = this as Tagged;
        const method = args[0];
        const url = args[1];
        if (typeof method === 'string') t.__crossposty_method = method;
        if (typeof url === 'string') t.__crossposty_url = url;
        else if (url instanceof URL) t.__crossposty_url = url.toString();
        t.__crossposty_headers = {};
        return (origOpen as (...a: unknown[]) => void).apply(this, args);
      };

      XHR.setRequestHeader = function (name: string, value: string): void {
        const t = this as Tagged;
        if (!t.__crossposty_headers) t.__crossposty_headers = {};
        t.__crossposty_headers[name.toLowerCase()] = value;
        return origSetRequestHeader.call(this, name, value);
      };

      XHR.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
        const t = this as Tagged;
        const url = t.__crossposty_url ?? '';

        if (CDN_BYPASS_RE.test(url)) return origSend.call(this, body);

        // Diagnostic: log XHRs to any upload host (URL + body type) so we
        // can see how X is uploading when capture misses.
        if (X_UPLOAD_HOST_LOG_RE.test(url)) {
          debugLog('[CrossPosty] XHR upload-host URL', url, {
            method: t.__crossposty_method,
            bodyType:
              body == null
                ? 'null'
                : typeof body === 'string'
                  ? 'string'
                  : (body.constructor?.name ?? typeof body),
          });
        }

        if (X_MEDIA_UPLOAD_RE.test(url)) {
          if (body instanceof FormData) {
            debugLog('[CrossPosty] X XHR media tap firing (FormData)', url);
            captureXAppendFromFormData(body, url);
          } else {
            // INIT and FINALIZE come through here with null body — that's fine,
            // we don't need to capture them. APPEND should always be FormData.
            debugLog('[CrossPosty] X XHR upload command (non-FormData, ignored)', url);
          }
          return origSend.call(this, body);
        }
        if (BSKY_UPLOAD_BLOB_RE.test(url)) {
          return origSend.call(this, body);
        }

        try {
          if (isGraphqlish(url)) {
            debugLog('[CrossPosty] XHR graphql-ish URL', url, t.__crossposty_method);
          }
          if (isInteresting(url) && body) {
            let bodyText = '';
            if (typeof body === 'string') bodyText = body;
            else if (body instanceof Blob) {
              body.text().then((txt) =>
                dispatchIntercept(url, txt, t.__crossposty_headers ?? {}),
              );
              return origSend.call(this, body);
            } else if (body instanceof URLSearchParams) {
              bodyText = body.toString();
            }
            if (bodyText) {
              dispatchIntercept(url, bodyText, t.__crossposty_headers ?? {});
            }
          }
        } catch {
          // never block original send
        }
        return origSend.call(this, body);
      };
    }

    function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
      if (!h) return {};
      if (h instanceof Headers) {
        const out: Record<string, string> = {};
        h.forEach((value, key) => {
          out[key.toLowerCase()] = value;
        });
        return out;
      }
      if (Array.isArray(h)) {
        const out: Record<string, string> = {};
        for (const [k, v] of h) out[k.toLowerCase()] = v;
        return out;
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
      return out;
    }
  },
});
