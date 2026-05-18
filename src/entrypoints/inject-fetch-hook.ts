// Runs in MAIN world on x.com and bsky.app. Monkey-patches window.fetch so we
// can observe outgoing compose requests (X CreateTweet, BlueSky createRecord)
// and emit a `crossposty:intercept` CustomEvent that our content script picks up.
//
// We never block the original fetch — observing only. This is the whole point
// of the native-posting trick: X's UI posts via its own request through their
// own infra. We just snoop the payload.

export default defineUnlistedScript(() => {
  type Marker = { __crossposty_installed?: boolean };
  if ((window as unknown as Marker).__crossposty_installed) return;
  (window as unknown as Marker).__crossposty_installed = true;

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
      // Never block the original fetch on observability failure.
    }
    return origFetch(input, init);
  };
});
