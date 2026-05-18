import { useEffect, useState } from 'react';
import type { AccountStatusEntry } from '../../../lib/messaging';
import type { AccountCredentials, PlatformId } from '../../../platforms/types';
import { deleteCredential, loadCredentials } from '../../../storage/credentials';

type AddableId = PlatformId;

function dotColor(severity: 'green' | 'yellow' | 'red'): string {
  switch (severity) {
    case 'green':
      return 'bg-emerald-500';
    case 'yellow':
      return 'bg-amber-400';
    case 'red':
      return 'bg-red-500';
  }
}

// Human-readable expiry. Short durations get "in X hours/days"; anything
// further out gets the absolute date so the user can compare at a glance.
function formatExpiry(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = ms / 60_000;
  const hours = ms / 3_600_000;
  const days = ms / 86_400_000;
  if (minutes < 60) return `expires in ${Math.max(1, Math.floor(minutes))}m`;
  if (hours < 24) return `expires in ${Math.floor(hours)}h`;
  if (days < 30) return `expires in ${Math.floor(days)}d`;
  return `expires ${new Date(epochSeconds * 1000).toLocaleDateString()}`;
}

function formatAge(epochMs: number, nowMs: number): string {
  const ms = nowMs - epochMs;
  if (ms < 10_000) return 'just now';
  const minutes = ms / 60_000;
  const hours = ms / 3_600_000;
  if (minutes < 1) return `${Math.floor(ms / 1000)}s ago`;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AccountsPage({ onAdd }: { onAdd: (platformId: AddableId) => void }) {
  const [accounts, setAccounts] = useState<AccountCredentials[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AccountStatusEntry['status']>>({});
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<{ id: string; msg: string } | null>(null);
  // Re-render every 30s so the relative "checked X ago" label stays
  // accurate while the popup is open. Popup is short-lived in practice,
  // but this matters when the user leaves it pinned.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function refresh() {
    const creds = await loadCredentials();
    setAccounts(creds);
    // Always refresh statuses — even on an empty list, this lets the
    // background SW clear the icon badge after the user removes their
    // last account.
    void refreshStatuses();
  }

  async function refreshStatuses() {
    setRefreshing(true);
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'GET_ACCOUNT_STATUSES',
        payload: null,
      })) as { payload: AccountStatusEntry[] } | null | undefined;
      const map: Record<string, AccountStatusEntry['status']> = {};
      for (const entry of resp?.payload ?? []) {
        map[entry.accountId] = entry.status;
      }
      setStatuses(map);
      setLastCheckedAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(accountId: string) {
    await deleteCredential(accountId);
    await refresh();
  }

  async function reconnect(accountId: string) {
    setReconnectingId(accountId);
    setReconnectError(null);
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'RECONNECT_ACCOUNT',
        payload: { accountId },
      })) as { payload: { success: true } | { success: false; error: string } } | null;
      if (!resp) {
        setReconnectError({ id: accountId, msg: 'No response from background.' });
        return;
      }
      if (resp.payload.success) {
        await refresh();
      } else {
        setReconnectError({ id: accountId, msg: resp.payload.error });
      }
    } catch (err) {
      setReconnectError({ id: accountId, msg: String(err) });
    } finally {
      setReconnectingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <section>
        <div className="flex justify-between items-center mb-2">
          <h2 className="font-medium">Connected accounts</h2>
          {accounts.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              {lastCheckedAt && (
                <span className="text-gray-400">
                  checked {formatAge(lastCheckedAt, now)}
                </span>
              )}
              <button
                type="button"
                onClick={refreshStatuses}
                disabled={refreshing}
                className="text-gray-500 hover:underline disabled:opacity-50"
              >
                {refreshing ? 'checking…' : 'recheck'}
              </button>
            </div>
          )}
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts yet. Add one below.</p>
        ) : (
          <ul className="space-y-1">
            {accounts.map((a) => {
              const status = statuses[a.accountId];
              return (
                <li
                  key={a.accountId}
                  className="text-sm border rounded p-2 space-y-0.5"
                >
                  <div className="flex justify-between items-center">
                    <span className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          status ? dotColor(status.severity) : 'bg-gray-300'
                        }`}
                        title={
                          status
                            ? status.message ?? status.severity
                            : 'checking…'
                        }
                      />
                      <span>
                        <strong className="capitalize">{a.platformId}</strong> -{' '}
                        {a.displayName}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {status?.severity === 'red' && (
                        <button
                          type="button"
                          onClick={() => reconnect(a.accountId)}
                          disabled={reconnectingId === a.accountId}
                          className="text-emerald-700 text-xs hover:underline disabled:opacity-50"
                        >
                          {reconnectingId === a.accountId ? 'reconnecting…' : 'reconnect'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => remove(a.accountId)}
                        className="text-red-600 text-xs hover:underline"
                      >
                        remove
                      </button>
                    </span>
                  </div>
                  {reconnectError?.id === a.accountId && (
                    <p className="text-xs pl-4 text-red-600">
                      Reconnect failed: {reconnectError.msg}
                    </p>
                  )}
                  {status && (status.message || status.expiresAt) && (
                    <p
                      className={`text-xs pl-4 ${
                        status.severity === 'red'
                          ? 'text-red-600'
                          : status.severity === 'yellow'
                            ? 'text-amber-700'
                            : 'text-gray-500'
                      }`}
                    >
                      {status.message}
                      {status.expiresAt && (
                        <span className="text-gray-400">
                          {status.message ? ' — ' : ''}
                          {formatExpiry(status.expiresAt)}
                        </span>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h2 className="font-medium mb-2">Add account</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onAdd('x')}
            className="bg-black hover:bg-gray-800 text-white px-3 py-1 rounded text-sm"
          >
            X
          </button>
          <button
            type="button"
            onClick={() => onAdd('bluesky')}
            className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-1 rounded text-sm"
          >
            BlueSky
          </button>
          <button
            type="button"
            onClick={() => onAdd('mastodon')}
            className="bg-violet-600 hover:bg-violet-700 text-white px-3 py-1 rounded text-sm"
          >
            Mastodon
          </button>
          <button
            type="button"
            onClick={() => onAdd('threads')}
            className="bg-zinc-900 hover:bg-black text-white px-3 py-1 rounded text-sm"
          >
            Threads
          </button>
          <button
            type="button"
            onClick={() => onAdd('linkedin')}
            className="bg-blue-700 hover:bg-blue-800 text-white px-3 py-1 rounded text-sm"
          >
            LinkedIn
          </button>
        </div>
      </section>
    </div>
  );
}
