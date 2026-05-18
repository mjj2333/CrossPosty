# CrossPosty

Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn.

A Manifest V3 browser extension that intercepts your compose actions on X and BlueSky and surfaces a per-platform editable composer panel for cross-posting. Credentials live encrypted in `chrome.storage.local` — they never leave your browser.

## Status

**Phase 1 in progress.** See [`docs/superpowers/plans/2026-05-17-crossposty-phase1.md`](docs/superpowers/plans/2026-05-17-crossposty-phase1.md) for the implementation plan.

## Development

Requires Node 22+. The plan calls for `pnpm`, but this repo currently uses `npm` (corepack needed admin to enable pnpm on this machine).

```bash
npm install
npm run dev      # launches Chrome with the unpacked extension
npm run build    # produces .output/chrome-mv3/ (loadable as unpacked extension)
npm test         # runs Vitest
npm run compile  # tsc --noEmit
```

## License

MIT — see [`LICENSE`](LICENSE).
