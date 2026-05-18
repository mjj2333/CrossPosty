// Helpers for detecting the "Extension context invalidated" state.
//
// When the user reloads the extension at chrome://extensions, any content
// scripts still running on open tabs become orphaned: their chrome.runtime
// reference points to a destroyed extension context. Any sendMessage /
// storage / etc. call throws "Extension context invalidated."
//
// Until the user refreshes the tab, the orphaned script can't do anything
// useful. We detect this state and bail out early instead of crashing.

export function isContextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export function isContextInvalidatedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /context invalidated|Extension context/i.test(err.message);
}
