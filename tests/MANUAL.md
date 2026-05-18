# Manual test checklist

Phase 1 ships without UI tests; this checklist is the gate for cutting a release.

## Setup

- [ ] `npm install`
- [ ] `npm run build`
- [ ] `npm test` — all unit tests pass
- [ ] Load `.output/chrome-mv3/` as unpacked extension at `chrome://extensions` (Developer mode on)
- [ ] No errors in service-worker console (chrome://extensions → CrossPosty → "service worker")

## Accounts

- [ ] Open popup; empty state renders
- [ ] Add BlueSky: handle + app password → success, account appears in list
- [ ] Add Mastodon: instance URL + access token → success, account appears with `@user@instance` label
- [ ] Add LinkedIn (logged in at linkedin.com): click LinkedIn → Connect → success, "LinkedIn session" appears
- [ ] Remove each account — list updates
- [ ] Re-add all three for the next steps

## Source: X

- [ ] On x.com, compose a tweet (~30 chars), hit Post
- [ ] **Tweet appears natively in your X feed** (this is the whole point — verify it actually posted)
- [ ] CrossPosty panel appears upper-right with variants for BlueSky / Mastodon / LinkedIn
- [ ] Each variant pre-filled with the tweet text, checkbox enabled
- [ ] Edit each variant independently — character counts update; over-limit turns red
- [ ] Uncheck one variant — it stays in the panel but won't post
- [ ] Click Cross-post → posts land on the checked destinations; result row shows green link
- [ ] Click the link → opens the correct post on each platform

## Source: BlueSky

- [ ] On bsky.app, compose + post — original post lands natively
- [ ] Panel shows Mastodon + LinkedIn variants (BlueSky filtered out as the source)
- [ ] Cross-post → both succeed

## Error handling

- [ ] Disconnect WiFi, then compose on x.com → original may or may not send (X-side problem; not ours)
- [ ] Re-enable WiFi mid-flow → still need to be able to dismiss the panel
- [ ] With one expired credential (manually corrupt one in chrome.storage), other variants still succeed and the broken one shows "Failed: …"
- [ ] Remove all accounts, compose on x.com → panel shows "No destination accounts connected"

## Persistence

- [ ] Reload the extension (chrome://extensions → reload) — accounts persist
- [ ] Disable + re-enable extension — accounts persist
- [ ] Uninstall + reinstall — accounts gone (storage cleared by Chrome)

## Bundle sanity

- [ ] `.output/chrome-mv3/content-scripts/x.js` < 200 kB
- [ ] `.output/chrome-mv3/inject-fetch-hook.js` < 5 kB
- [ ] No `console.log` of raw credentials anywhere in `.output/`
