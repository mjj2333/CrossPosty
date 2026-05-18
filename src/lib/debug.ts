// Per-request diagnostic logging — gated behind a runtime flag so production
// users don't see a wall of [CrossPosty] lines per page load.
//
// To enable in a given context (each JS realm is separate):
//   - x.com / bsky.app page console:     window.__CROSSPOSTY_DEBUG = true
//   - extension background console:      __CROSSPOSTY_DEBUG = true
//
// State-change logs (panel mounted, INIT ok, errors, warnings) still use
// console.log / .warn directly — those are useful even in the quiet path.

declare global {
  // biome-ignore lint/style/noVar: declared on globalThis for cross-realm access
  var __CROSSPOSTY_DEBUG: boolean | undefined;
}

export function debugLog(...args: unknown[]): void {
  if (globalThis.__CROSSPOSTY_DEBUG === true) {
    console.log(...args);
  }
}

export {};
