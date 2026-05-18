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
  // Direct error: Chrome's explicit "Extension context invalidated." message.
  if (/context invalidated|Extension context/i.test(err.message)) return true;
  // Indirect: after invalidation, chrome.runtime / chrome.storage / chrome.cookies
  // become `undefined`, so dereferencing them throws TypeError with messages like
  // "Cannot read properties of undefined (reading 'sendMessage')" or
  // "Cannot read properties of undefined (reading 'local')". Treat those the same
  // — they all mean the same thing in practice.
  if (err instanceof TypeError && /Cannot read propert(ies|y)/i.test(err.message)) {
    if (
      /(sendMessage|onMessage|runtime|storage|cookies|tabs|identity|alarms|offscreen|scripting|permissions|local|sync|managed)/i.test(
        err.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

// Installs a window-level handler that swallows "Extension context invalidated"
// unhandled rejections. These are inevitable when the user reloads the
// extension while a tab is still open — Chrome reports them loudly even when
// our code catches them properly elsewhere. We surface a single info-level
// hint instead of a stack-trace per orphaned async chain.
export function installOrphanRejectionSuppressor(): void {
  let warned = false;
  window.addEventListener('unhandledrejection', (ev) => {
    if (isContextInvalidatedError(ev.reason)) {
      ev.preventDefault();
      if (!warned) {
        warned = true;
        console.info(
          '[CrossPosty] extension was reloaded; orphaned async calls suppressed. Refresh this tab to resume.',
        );
      }
    }
  });
}
