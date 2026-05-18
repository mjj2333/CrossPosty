import { useState } from 'react';
import { getAdapter } from '../../../platforms';
import type { PlatformId } from '../../../platforms/types';
import { addCredential } from '../../../storage/credentials';

type AddableId = Exclude<PlatformId, 'x'>;

type Field = { name: string; label: string; type: 'text' | 'password'; placeholder?: string };

function fieldsFor(platformId: AddableId): Field[] {
  switch (platformId) {
    case 'bluesky':
      return [
        {
          name: 'identifier',
          label: 'Handle (e.g. you.bsky.social)',
          type: 'text',
          placeholder: 'you.bsky.social',
        },
        {
          name: 'appPassword',
          label: 'App password (BlueSky → Settings → App Passwords)',
          type: 'password',
          placeholder: 'xxxx-xxxx-xxxx-xxxx',
        },
      ];
    case 'mastodon':
      return [
        {
          name: 'instanceUrl',
          label: 'Instance URL',
          type: 'text',
          placeholder: 'https://mastodon.social',
        },
        {
          name: 'accessToken',
          label: 'Access token (Preferences → Development → New application)',
          type: 'password',
        },
      ];
    case 'linkedin':
      return [];
  }
}

export function AddAccountPage({
  platformId,
  onDone,
}: {
  platformId: AddableId;
  onDone: () => void;
}) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = fieldsFor(platformId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const adapter = getAdapter(platformId);
      const creds = await adapter.authenticate(params);
      await addCredential(creds);
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button type="button" onClick={onDone} className="text-xs text-gray-500 hover:underline">
        ← back
      </button>
      <h2 className="font-medium capitalize">Add {platformId} account</h2>
      {platformId === 'linkedin' && (
        <p className="text-xs text-gray-600">
          Make sure you&apos;re logged in at linkedin.com in this browser, then click Connect. We
          read your session cookies directly — they stay on this device.
        </p>
      )}
      {fields.map((f) => (
        <label key={f.name} className="block text-sm">
          <span className="block text-gray-700 mb-0.5">{f.label}</span>
          <input
            type={f.type}
            className="w-full border rounded px-2 py-1 text-sm"
            value={params[f.name] ?? ''}
            onChange={(e) =>
              setParams((p) => ({ ...p, [f.name]: e.target.value }))
            }
            placeholder={f.placeholder}
          />
        </label>
      ))}
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded text-sm disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}
