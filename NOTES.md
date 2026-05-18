# Decisions & open questions

## 2026-05-17 — Package manager: npm instead of pnpm

The Phase 1 plan called for pnpm. Corepack on this machine couldn't install pnpm without admin rights (`EPERM` writing to `C:\Program Files\nodejs`). Substituted npm. The plan's `pnpm exec X` and `pnpm X` commands map to `npx X` and `npm run X` respectively. No functional difference for this project.
