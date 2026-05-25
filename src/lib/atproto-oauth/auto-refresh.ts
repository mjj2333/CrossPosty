import { loadCredentials, updateCredential } from '../../storage/credentials';
import type { AccountCredentials } from '../../platforms/types';
import { logger } from '../logger';
import { refreshAtprotoOAuthSession, type AtprotoOAuthSession } from './flow';

// BSky atproto OAuth access tokens are short-lived (typically ~30 min).
// Refresh tokens last much longer (months) and can be redeemed for new
// access tokens without user interaction. This module periodically
// pre-refreshes any access token that's near expiry so the user never
// has to click "reconnect" for the routine case (token expired during
// SW sleep). The reactive 401-driven refresh in client.ts stays as a
// fallback for race-with-expiry scenarios.

// Refresh when an access token is within this window of expiring. The
// 5-minute buffer means we never use a token that's about to expire
// mid-request — which would burn one of our retries on a token that
// could have been refreshed cheaply ahead of time.
const REFRESH_WINDOW_SECONDS = 5 * 60;

type StoredOAuth = AtprotoOAuthSession & { authType?: string };

function isOAuthCredential(c: AccountCredentials): boolean {
  if (c.platformId !== 'bluesky') return false;
  const data = c.data as Partial<StoredOAuth> | undefined;
  return data?.authType === 'oauth';
}

function needsRefresh(session: AtprotoOAuthSession, nowSec: number): boolean {
  return session.expiresAt - nowSec < REFRESH_WINDOW_SECONDS;
}

async function refreshOne(cred: AccountCredentials): Promise<'ok' | 'skipped' | 'failed'> {
  const session = cred.data as unknown as StoredOAuth;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!needsRefresh(session, nowSec)) return 'skipped';
  try {
    const refreshed = await refreshAtprotoOAuthSession(session);
    const updated: AccountCredentials = {
      ...cred,
      data: { ...refreshed, authType: 'oauth' } as unknown as Record<string, unknown>,
    };
    await updateCredential(updated);
    logger.info('BSky session pre-refreshed', {
      handle: session.handle,
      newExpiresIn: refreshed.expiresAt - nowSec,
    });
    return 'ok';
  } catch (err) {
    // Refresh failure usually means the refresh_token itself was revoked
    // (logged out elsewhere, account state change). Leave the credential
    // as-is so the popup's status check + Reconnect button still surface
    // the bad state to the user.
    logger.warn('BSky pre-refresh failed', {
      handle: session.handle,
      error: String(err).slice(0, 200),
    });
    return 'failed';
  }
}

export async function refreshAllStaleBskySessions(): Promise<void> {
  const creds = await loadCredentials();
  const targets = creds.filter(isOAuthCredential);
  if (targets.length === 0) return;
  let refreshed = 0;
  let failed = 0;
  for (const c of targets) {
    const r = await refreshOne(c);
    if (r === 'ok') refreshed++;
    else if (r === 'failed') failed++;
  }
  if (refreshed > 0 || failed > 0) {
    logger.info('BSky pre-refresh sweep', { refreshed, failed, total: targets.length });
  }
}

const ALARM_NAME = 'crossposty:bsky-refresh';
const PERIOD_MINUTES = 5;

export function installBskyRefreshAlarm(): void {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: PERIOD_MINUTES,
        delayInMinutes: PERIOD_MINUTES,
      });
      logger.info('BSky refresh alarm installed');
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void refreshAllStaleBskySessions().catch((err) =>
      logger.warn('BSky refresh sweep failed', { error: String(err) }),
    );
  });
}
