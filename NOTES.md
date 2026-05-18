# Decisions & open questions

## 2026-05-17 — Package manager: npm instead of pnpm

The Phase 1 plan called for pnpm. Corepack on this machine couldn't install pnpm without admin rights (`EPERM` writing to `C:\Program Files\nodejs`). Substituted npm. The plan's `pnpm exec X` and `pnpm X` commands map to `npx X` and `npm run X` respectively. No functional difference for this project.

## 2026-05-17 — LinkedIn voyager endpoint

`src/platforms/linkedin.ts` POSTs to `https://www.linkedin.com/voyager/api/contentcreation/normShares` using session cookies (`li_at`, `JSESSIONID`) with `csrf-token` derived from `JSESSIONID` (surrounding quotes stripped) and `x-restli-protocol-version: 2.0.0`. The endpoint and body shape are undocumented; if it stops working, open linkedin.com → DevTools Network tab → post something → inspect the actual normShares request and update `buildNormShareBody` in that file. Phase 1 ships text-only, no media; that's a known shape mismatch with current LinkedIn UI which may break — verify on first manual integration test.
