import { loadRelayPairing } from '../../storage/relay-pairing';
import { logger } from '../logger';
import { fetchUnconsumedMessages } from './client';

const ALARM_NAME = 'crossposty:relay-poll';
// 30 seconds is the practical floor for chrome.alarms when an extension
// declares the `alarms` permission without "background"; values smaller
// than this are silently clamped by Chrome. 30s ≈ worst-case delay from
// "phone hit send" to "extension opens the receiver tab."
const PERIOD_MINUTES = 0.5;

// Per-SW-life dedupe so a poll cycle that runs while a receiver tab is
// already open for the same message doesn't spawn a second tab. Resets
// when the service worker restarts, which is fine — if a message is
// still unconsumed after an SW restart we genuinely want to reopen it.
const openedReceivers = new Set<string>();

export function installRelayAlarm(): void {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: PERIOD_MINUTES,
        delayInMinutes: PERIOD_MINUTES,
      });
      logger.info('relay poll alarm installed');
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void pollRelayOnce().catch((err) =>
      logger.warn('relay poll failed', { error: String(err) }),
    );
  });
}

// Single poll iteration: fetch any unconsumed messages and open a
// receiver tab per new one. Receivers handle fetch/decrypt/mount + the
// mark-consumed step themselves; this loop just dispatches.
export async function pollRelayOnce(): Promise<void> {
  const pairing = await loadRelayPairing();
  if (!pairing) return;
  const rows = await fetchUnconsumedMessages(pairing);
  for (const row of rows) {
    if (openedReceivers.has(row.id)) continue;
    openedReceivers.add(row.id);
    const url = chrome.runtime.getURL(`receiver.html?msgId=${encodeURIComponent(row.id)}`);
    await chrome.tabs.create({ url });
  }
}
