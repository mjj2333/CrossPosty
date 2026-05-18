// Patches window.fetch AND XMLHttpRequest in MAIN world before page scripts run.
//
// MUST be a `world: 'MAIN'` content script (declared in the manifest) so it
// executes synchronously before any page scripts — otherwise the page bundle
// can capture references to fetch/XHR into its closure before we patch them.
//
// We hook both because different X surfaces use different transports. Some
// pages route POST /graphql/.../CreateTweet through fetch, others through
// XHR. We dispatch a `crossposty:intercept` CustomEvent for either source so
// the ISOLATED-world listener can react uniformly.

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

    function isInteresting(url: string): boolean {
      return (
        /(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(url) ||
        /bsky\.social\/xrpc\/com\.atproto\.repo\.createRecord/.test(url)
      );
    }

    // Loose match for any GraphQL-shaped URL — used as a debug log so we can
    // see what's actually happening even if X renames CreateTweet to something
    // else.
    function isGraphqlish(url: string): boolean {
      return /\/graphql\//.test(url) || /CreateTweet|CreatePost|CreateNote/i.test(url);
    }

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

    const UPLOAD_HOST_RE =
      /(?:^https?:\/\/)?(?:upload\.(?:twitter|x)\.com|pbs\.twimg\.com|video\.twimg\.com|ton\.x\.com)\//;

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
          // Skip *all* observation on upload hosts — never touch binary bodies.
          if (UPLOAD_HOST_RE.test(url)) {
            return origFetch(input, init);
          }
          if (isGraphqlish(url)) {
            console.log('[CrossPosty] fetch graphql-ish URL', url);
          }
          if (isInteresting(url) && init?.body) {
            let bodyText = '';
            if (typeof init.body === 'string') bodyText = init.body;
            else if (init.body instanceof Blob) bodyText = await init.body.text();
            dispatchIntercept(url, bodyText, normalizeHeaders(init.headers));
          }
        } catch {
          // never block original fetch on observability failure
        }
        return origFetch(input, init);
      };
    }

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

      // Use rest args so we pass *exactly* what the caller passed — never
      // change the arity of the call to origOpen. Calling open(...) with 5
      // explicit args when X only passed 2 can subtly change X's request
      // handling and (per user report) appears to break media upload.
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

        // Fast-path: skip *all* observation for upload hosts.
        if (UPLOAD_HOST_RE.test(url)) {
          return origSend.call(this, body);
        }

        try {
          if (isGraphqlish(url)) {
            console.log('[CrossPosty] XHR graphql-ish URL', url, t.__crossposty_method);
          }
          if (isInteresting(url) && body) {
            let bodyText = '';
            if (typeof body === 'string') bodyText = body;
            else if (body instanceof Blob) {
              // Async — fire off without blocking send
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
          // never block original send on observability failure
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
