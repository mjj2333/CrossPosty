// Account health is the per-platform getStatus result aggregated into a
// single roll-up the background SW can act on. We poll periodically via
// chrome.alarms so the extension icon's badge reflects the current state
// without the user having to open the popup.
//
// The badge is the only attention-grab we have — keep it sparse:
//   - red number: one or more accounts are *broken* (cookie gone,
//                 tokens revoked, anything that means cross-posting
//                 will fail right now)
//   - amber "!" : everything works, but at least one account is in a
//                 degraded state (e.g. X/Threads template > 7 days
//                 old — post natively to refresh)
//   - empty     : all green

import { logger } from './logger';
import { getAdapter } from '../platforms';
import type { AccountStatus } from '../platforms/types';
import { loadCredentials } from '../storage/credentials';

const ALARM_NAME = 'crossposty:account-health';
const PERIOD_MINUTES = 120; // every 2 hours
const PER_ACCOUNT_TIMEOUT_MS = 10_000;

export type HealthSummary = {
  red: number;
  yellow: number;
  green: number;
};

async function statusFor(
  cred: Awaited<ReturnType<typeof loadCredentials>>[number],
): Promise<AccountStatus> {
  const adapter = getAdapter(cred.platformId);
  const run = async (): Promise<AccountStatus> => {
    if (adapter.getStatus) return adapter.getStatus(cred);
    const ok = await adapter.validateCredentials(cred);
    return { ok, severity: ok ? 'green' : 'red' };
  };
  try {
    return await Promise.race([
      run(),
      new Promise<AccountStatus>((_resolve, reject) =>
        setTimeout(() => reject(new Error('status check timed out')), PER_ACCOUNT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    return { ok: false, severity: 'red', message: String(err).slice(0, 200) };
  }
}

export async function computeHealthSummary(): Promise<HealthSummary> {
  const creds = await loadCredentials();
  const statuses = await Promise.all(creds.map(statusFor));
  let red = 0;
  let yellow = 0;
  let green = 0;
  for (const s of statuses) {
    if (s.severity === 'red') red++;
    else if (s.severity === 'yellow') yellow++;
    else green++;
  }
  return { red, yellow, green };
}

export async function updateBadge(summary: HealthSummary): Promise<void> {
  if (summary.red > 0) {
    await chrome.action.setBadgeText({ text: String(summary.red) });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); // red-600
    await chrome.action.setTitle({
      title: `CrossPosty — ${summary.red} account${summary.red === 1 ? '' : 's'} need attention`,
    });
    return;
  }
  if (summary.yellow > 0) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // amber-500
    await chrome.action.setTitle({
      title: `CrossPosty — ${summary.yellow} account${summary.yellow === 1 ? '' : 's'} degraded`,
    });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'CrossPosty' });
}

export async function runHealthCheckAndBadge(): Promise<HealthSummary> {
  logger.info('health check running');
  try {
    const summary = await computeHealthSummary();
    await updateBadge(summary);
    logger.info('health check done', summary);
    return summary;
  } catch (err) {
    logger.warn('runHealthCheckAndBadge failed', { error: String(err) });
    return { red: 0, yellow: 0, green: 0 };
  }
}

export function installHealthCheckAlarm(): void {
  // Idempotent — chrome.alarms.create with an existing name overwrites
  // the schedule, which is exactly what we want on SW startup.
  void chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: PERIOD_MINUTES,
    when: Date.now() + 60_000, // first fire 60s after SW boot
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void runHealthCheckAndBadge();
  });
}
