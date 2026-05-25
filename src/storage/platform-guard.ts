// Generic rate-limit + auto-pause guard for platforms with aggressive
// anti-automation systems (Threads/Meta, X). Both platforms have
// permabanned real CrossPosty accounts during testing. Cheap mitigation:
// cap per-account post rate AND auto-pause for 24h on any
// "you look automated" response so we don't keep poking the lock.
//
// Originally Threads-specific (src/storage/threads-guard.ts), generalized
// 2026-05-23 when X started returning code 226 in similar conditions.

export type PlatformGuardState = {
  // Epoch-ms timestamps of recent post attempts. Pruned to the last
  // hour on every read; used to enforce per-platform rate caps.
  recentAttempts: number[];
  // Set when the platform tells us "stop posting" (Meta checkpoint,
  // X code 226). Posts to this account are refused locally until this
  // time passes.
  pausedUntil?: number;
  // Free-text reason from the platform's lock response, for surfacing
  // in the popup so the user knows why they're paused.
  pauseReason?: string;
  // Optional checkpoint URL (Meta only — X has no comparable URL).
  checkpointUrl?: string;
};

// Per-platform conservative caps. Tune only if a real user reports the
// rate as too restrictive in practice — these exist specifically to
// prevent permabans, which can't be undone.
export const RATE_LIMITS: Record<string, number> = {
  threads: 3,
  x: 3,
};

export const PAUSE_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const KEY = 'platformGuard';

type Store = Record<string, PlatformGuardState>;

async function loadStore(): Promise<Store> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as Store | undefined) ?? {};
}

async function saveStore(store: Store): Promise<void> {
  await chrome.storage.local.set({ [KEY]: store });
}

function pruneAttempts(now: number, attempts: number[]): number[] {
  const cutoff = now - RATE_WINDOW_MS;
  return attempts.filter((t) => t > cutoff);
}

export type GuardCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'paused';
      pausedUntil: number;
      pauseReason?: string;
      checkpointUrl?: string;
    }
  | { ok: false; reason: 'rate-limited'; resetsAt: number; limit: number };

function rateLimitFor(platformId: string): number {
  return RATE_LIMITS[platformId] ?? 10;
}

export async function checkGuard(
  platformId: string,
  accountId: string,
): Promise<GuardCheck> {
  const now = Date.now();
  const store = await loadStore();
  const state = store[accountId];
  if (!state) return { ok: true };
  if (state.pausedUntil && state.pausedUntil > now) {
    return {
      ok: false,
      reason: 'paused',
      pausedUntil: state.pausedUntil,
      pauseReason: state.pauseReason,
      checkpointUrl: state.checkpointUrl,
    };
  }
  const recent = pruneAttempts(now, state.recentAttempts ?? []);
  const limit = rateLimitFor(platformId);
  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    return { ok: false, reason: 'rate-limited', resetsAt: oldest + RATE_WINDOW_MS, limit };
  }
  return { ok: true };
}

export async function recordAttempt(accountId: string): Promise<void> {
  const now = Date.now();
  const store = await loadStore();
  const state = store[accountId] ?? { recentAttempts: [] };
  state.recentAttempts = [...pruneAttempts(now, state.recentAttempts ?? []), now];
  store[accountId] = state;
  await saveStore(store);
}

export async function pauseAccount(
  accountId: string,
  opts: { reason: string; checkpointUrl?: string },
): Promise<void> {
  const store = await loadStore();
  const state = store[accountId] ?? { recentAttempts: [] };
  state.pausedUntil = Date.now() + PAUSE_MS;
  state.pauseReason = opts.reason;
  if (opts.checkpointUrl) state.checkpointUrl = opts.checkpointUrl;
  store[accountId] = state;
  await saveStore(store);
}

export async function clearPause(accountId: string): Promise<void> {
  const store = await loadStore();
  if (!store[accountId]) return;
  delete store[accountId].pausedUntil;
  delete store[accountId].pauseReason;
  delete store[accountId].checkpointUrl;
  await saveStore(store);
}

export function formatGuardError(
  platformId: string,
  check: Exclude<GuardCheck, { ok: true }>,
): string {
  const platform = platformId.charAt(0).toUpperCase() + platformId.slice(1);
  if (check.reason === 'paused') {
    const hoursLeft = Math.max(1, Math.ceil((check.pausedUntil - Date.now()) / 3_600_000));
    const where = check.checkpointUrl ?? (platformId === 'threads' ? 'instagram.com' : `${platformId}.com`);
    return `${platform} is paused for ${hoursLeft}h after the platform flagged us as automated. Clear the lock at ${where} by browsing/posting natively, then unpause from the popup. Reason: ${check.pauseReason ?? 'platform anti-automation response'}.`;
  }
  const minutesLeft = Math.max(1, Math.ceil((check.resetsAt - Date.now()) / 60_000));
  return `${platform} rate limit reached (${check.limit}/hr). Try again in ${minutesLeft} min — posting faster risks an account ban.`;
}
