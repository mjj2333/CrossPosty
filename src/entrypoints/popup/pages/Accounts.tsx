import { useEffect, useState } from 'react';
import type { AccountCredentials, PlatformId } from '../../../platforms/types';
import { deleteCredential, loadCredentials } from '../../../storage/credentials';

type AddableId = Exclude<PlatformId, 'x'>;

export function AccountsPage({ onAdd }: { onAdd: (platformId: AddableId) => void }) {
  const [accounts, setAccounts] = useState<AccountCredentials[]>([]);

  async function refresh() {
    setAccounts(await loadCredentials());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(accountId: string) {
    await deleteCredential(accountId);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <section>
        <h2 className="font-medium mb-2">Connected accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts yet. Add one below.</p>
        ) : (
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li
                key={a.accountId}
                className="flex justify-between items-center text-sm border rounded p-2"
              >
                <span>
                  <strong className="capitalize">{a.platformId}</strong> — {a.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => remove(a.accountId)}
                  className="text-red-600 text-xs hover:underline"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="font-medium mb-2">Add account</h2>
        <div className="flex gap-2">
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
