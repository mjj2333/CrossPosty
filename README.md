# CrossPosty

Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn — a Manifest V3 browser extension that hooks the compose flow on X and BlueSky and lets you fan the post out to all your other accounts, with per-platform edits.

Credentials live encrypted in `chrome.storage.local`. They never leave your browser.

## Features (Phase 1)

- Compose on **X** or **BlueSky** as usual — the original post still fires natively (no API engagement penalty)
- Composer panel pops up after each post with per-platform variants
- Cross-post to **X**, **BlueSky**, **Mastodon** (any instance), and **LinkedIn**
- Each variant is independently editable, with live character-count and per-platform limits
- Per-platform success/failure shown inline — one platform failing won't block the others
- All credentials encrypted at rest with AES-GCM (WebCrypto), device-local key

## Install (developer / unpacked)

Phase 1 is not yet on the Chrome Web Store. To try it:

1. `npm install`
2. `npm run build`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, point at `.output/chrome-mv3/`

## Connecting accounts

Click the CrossPosty icon to open the popup, then choose a platform:

### X
- Make sure you're logged in at x.com **in this browser**
- Click X in the popup → Connect. We read your session cookies (`auth_token`, `ct0`) directly.
- **Important:** post one tweet natively on x.com *after* installing CrossPosty. Our fetch hook captures the request shape from that post and uses it as a template for cross-posts. Without it, X cross-posts return "post natively once first." The template self-refreshes every time you post natively, so it survives X's periodic endpoint rotations.
- See `NOTES.md` for the gnarly details (volatile headers, throttling caveats).

### BlueSky
- BlueSky → Settings → **App Passwords** → create one
- In the popup, enter your handle (e.g. `you.bsky.social`) and the app password

### Mastodon (any instance)
- Click Mastodon in the popup → enter your instance URL (e.g. `mastodon.social`) → **Connect**
- A login window opens on your instance — sign in if you aren't already, click **Authorize**
- CrossPosty registers itself as an app on your instance the first time and caches the registration, so future logins skip straight to the authorize step

### LinkedIn
- Make sure you're logged in at linkedin.com **in this browser**
- Click LinkedIn in the popup → Connect. We read your session cookies directly.
- Note: posting uses an undocumented endpoint (`voyager/api/contentcreation/normShares`); if LinkedIn changes it, see `NOTES.md` for how to update.

## How it works

```
┌── x.com / bsky.app (you compose normally) ────────┐
│  MAIN-world fetch hook observes CreateTweet /     │
│  createRecord, emits a DOM CustomEvent.           │
└────────────────────┬──────────────────────────────┘
                     ▼
┌── content script (ISOLATED world) ────────────────┐
│  Catches event → mounts Shadow-DOM composer panel │
└────────────────────┬──────────────────────────────┘
                     ▼
┌── background service worker ──────────────────────┐
│  Reads encrypted credentials, fans out via per-   │
│  platform PlatformAdapter (Promise.allSettled).   │
└───────────────────────────────────────────────────┘
```

The X post fires natively through X's own web request — we never block or replicate it through the API, so engagement throttling shouldn't apply.

## Development

```bash
npm run dev        # WXT dev server, launches Chrome with extension auto-reload
npm run build      # production build into .output/chrome-mv3/
npm test           # Vitest unit tests (crypto, storage, platform adapters)
npm run compile    # tsc --noEmit (type-check)
npm run lint       # Biome
npm run format     # Biome format --write
```

### Verbose debug logs

Per-request diagnostic logs are gated behind a runtime flag. By default only state changes (panel mounted, INIT/APPEND/FINALIZE, errors) appear in the console. To turn on the verbose `[CrossPosty] XHR graphql-ish URL ...` and similar diagnostics:

```js
// In the x.com / bsky.app page console:
window.__CROSSPOSTY_DEBUG = true;

// In the extension background console (chrome://extensions → CrossPosty → service worker):
__CROSSPOSTY_DEBUG = true;
```

Each JS realm is independent, so set it in whichever console you're debugging from. Set to `false` to silence again.

Tests cover crypto round-trips, encrypted credential storage, and each platform adapter's post/auth/validate paths. The composer panel and content scripts are exercised manually — see [`tests/MANUAL.md`](tests/MANUAL.md).

## Status & roadmap

**Phase 1 (in progress):** scaffold + 4 destinations (X, BlueSky, Mastodon, LinkedIn) + 2 sources (X, BlueSky). X destination uses session-cookie POST to X's internal GraphQL with template auto-captured from your native posts — see `NOTES.md` for the trade-offs.

**Not yet in Phase 1:**
- Image / media cross-posting (intercepted but not yet forwarded)
- Threads, Substack Notes (next up)
- X-as-destination via offscreen UI driving (deferred — fall back from session-cookie POST if X turns out to throttle it)
- Reddit (Phase 2/3)
- Scheduling, reply inbox, analytics (Phase 2/3)
- Firefox / Safari / mobile (Phase 4)

See [`docs/superpowers/plans/2026-05-17-crossposty-phase1.md`](docs/superpowers/plans/2026-05-17-crossposty-phase1.md) for the Phase 1 implementation plan and [`NOTES.md`](NOTES.md) for decisions made during the build.

## License

MIT — see [`LICENSE`](LICENSE).
