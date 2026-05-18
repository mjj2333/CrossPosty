# Decisions & open questions

## 2026-05-17 — Package manager: npm instead of pnpm

The Phase 1 plan called for pnpm. Corepack on this machine couldn't install pnpm without admin rights (`EPERM` writing to `C:\Program Files\nodejs`). Substituted npm. The plan's `pnpm exec X` and `pnpm X` commands map to `npx X` and `npm run X` respectively. No functional difference for this project.

## 2026-05-17 — X-as-destination via template capture (option A)

Phase 1 originally shipped X as source-only and deferred destination posting to Phase 2 (offscreen-doc native UI driving). After Phase 1 wrapped, the user pivoted: X is the must-have destination platform; LinkedIn and Mastodon are deprioritized.

**Picked approach (option A):** session-cookie POST to X's internal GraphQL `CreateTweet` endpoint. Risk: X may engagement-throttle API-style posts. Acceptable while we don't yet know if the throttling claim is real for *internal* GraphQL posting (vs. the official v2 API).

**The template trick:** rather than hardcoding the rotating GraphQL operation hash, evolving features payload, and rotating bearer token, we snapshot the most recent native `CreateTweet` request the user makes on x.com (via the existing MAIN-world fetch hook, now also capturing headers) and replay its shape for cross-posts. The template lives in `chrome.storage.local["xTemplate"]` and self-updates every time the user posts natively. CSRF (`x-csrf-token`) is read fresh from the `ct0` cookie at post time instead of from the template, since `ct0` rotates.

**Volatile headers stripped** before replay (see `VOLATILE_HEADERS` in `src/platforms/x.ts`): `x-csrf-token` (substituted from cookie), `x-client-transaction-id` (per-request signed value we can't currently recompute — dropping it; if X starts requiring it, posts will 4xx and we'll need to implement the signing algorithm), `content-length`, `host`, `cookie`.

**Known limitation:** user must post natively on x.com at least once after installing CrossPosty so the template can be captured. If they cross-post to X before that, `xAdapter.post` returns a friendly failure asking them to prime it. Document in popup + README.

**If X breaks this:** likely failure modes are (a) 4xx because they started requiring `x-client-transaction-id` — then we implement the signing — or (b) the response shape changes and `rest_id` lives somewhere else. Inspect a real native post via x.com DevTools Network tab and update accordingly. The template-capture approach insulates us from operation-hash and feature-flag drift automatically.

## 2026-05-17 — LinkedIn voyager endpoint

`src/platforms/linkedin.ts` POSTs to `https://www.linkedin.com/voyager/api/contentcreation/normShares` using session cookies (`li_at`, `JSESSIONID`) with `csrf-token` derived from `JSESSIONID` (surrounding quotes stripped) and `x-restli-protocol-version: 2.0.0`. The endpoint and body shape are undocumented; if it stops working, open linkedin.com → DevTools Network tab → post something → inspect the actual normShares request and update `buildNormShareBody` in that file. Phase 1 ships text-only, no media; that's a known shape mismatch with current LinkedIn UI which may break — verify on first manual integration test.
