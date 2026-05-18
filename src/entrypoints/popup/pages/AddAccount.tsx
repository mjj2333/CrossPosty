import { useState } from 'react';
import type { AuthenticateResponse, Message } from '../../../lib/messaging';
import type { PlatformId } from '../../../platforms/types';

type AddableId = PlatformId;

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
          placeholder: 'mastodon.social',
        },
      ];
    case 'linkedin':
      return [];
    case 'x':
      return [];
  }
}

function helperFor(platformId: AddableId): string | null {
  switch (platformId) {
    case 'linkedin':
      return "Make sure you're logged in at linkedin.com in this browser, then click Connect. We read your session cookies directly — they stay on this device.";
    case 'x':
      return "Make sure you're logged in at x.com, then click Connect. After connecting, post one tweet natively so CrossPosty can learn the current request shape — then cross-posts to X work.";
    case 'mastodon':
      return 'Enter your instance (e.g. mastodon.social). A login window will open — sign in once and authorize CrossPosty.';
    case 'bluesky':
      return null;
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
  const helper = helperFor(platformId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const req: Message = { type: 'AUTHENTICATE', payload: { platformId, params } };
      const response = (await chrome.runtime.sendMessage(req)) as AuthenticateResponse;
      if (response.success) {
        onDone();
      } else {
        setError(response.error);
      }
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
      {helper && <p className="text-xs text-gray-600">{helper}</p>}
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
