import type { RelayPairing } from '../lib/relay/types';

const KEY = 'relayPairing';

export async function loadRelayPairing(): Promise<RelayPairing | null> {
  const stored = await chrome.storage.local.get(KEY);
  const v = stored[KEY] as RelayPairing | undefined;
  return v && v.version === 1 ? v : null;
}

export async function saveRelayPairing(p: RelayPairing): Promise<void> {
  await chrome.storage.local.set({ [KEY]: p });
}

export async function clearRelayPairing(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
