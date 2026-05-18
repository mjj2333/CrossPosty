// Patches window.fetch in MAIN world before page scripts run.
//
// This MUST be a `world: 'MAIN'` content script (declared in the manifest)
// rather than a script-tag injection from an ISOLATED content script. The
// script-tag approach loses a race against the page's own bundle —
// X captures window.fetch into its closure before our async-loaded script
// has a chance to patch it, so internal X fetch calls bypass our hook.
//
// World-level content scripts are guaranteed by Chrome to execute before
// any page scripts at the specified runAt, which means we patch fetch
// before anyone gets a chance to capture a reference to it.

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*', '*://bsky.app/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    type Marker = { __crossposty_installed?: boolean };
    if ((window as unknown as Marker).__crossposty_installed) return;
    (window as unknown as Marker).__crossposty_installed = true;
    console.log('[CrossPosty] fetch hook installed in MAIN world (manifest world:MAIN)');

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        const interesting =
          /(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(url) ||
          /bsky\.social\/xrpc\/com\.atproto\.repo\.createRecord/.test(url);
        if (interesting) {
          console.log('[CrossPosty] fetch hook saw interesting URL', url);
        }
        if (interesting && init?.body) {
          let bodyText = '';
          if (typeof init.body === 'string') bodyText = init.body;
          else if (init.body instanceof Blob) bodyText = await init.body.text();
          const headers = normalizeHeaders(init.headers);
          console.log('[CrossPosty] dispatching crossposty:intercept', {
            urlMatched: url,
            bodyChars: bodyText.length,
          });
          window.dispatchEvent(
            new CustomEvent('crossposty:intercept', {
              detail: { url, body: bodyText, headers },
            }),
          );
        }
      } catch {
        // Never block the original fetch on observability failure.
      }
      return origFetch(input, init);
    };

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
