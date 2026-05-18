import { useState } from 'react';
import type { AuthenticateResponse, Message } from '../../../lib/messaging';
import type { PlatformId } from '../../../platforms/types';

type AddableId = PlatformId;

type Field = { name: string; label: string; type: 'text' | 'password'; placeholder?: string };

type BskyAuthMethod = 'oauth' | 'apppassword';

function fieldsFor(platformId: AddableId, bskyMethod: BskyAuthMethod): Field[] {
  switch (platformId) {
    case 'bluesky':
      if (bskyMethod === 'oauth') {
        return [
          {
            name: 'handle',
            label: 'Handle (e.g. you.bsky.social)',
            type: 'text',
            placeholder: 'you.bsky.social',
          },
        ];
      }
      return [
        {
          name: 'identifier',
          label: 'Handle (e.g. you.bsky.social)',
          type: 'text',
          placeholder: 'you.bsky.social',
        },
        {
          name: 'appPassword',
          label: 'App password (BlueSky -> Settings -> App Passwords)',
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
    case 'threads':
      return [];
    case 'substack':
      return [];
  }
}

function helperFor(platformId: AddableId, bskyMethod: BskyAuthMethod): string | null {
  switch (platformId) {
    case 'linkedin':
      return "Make sure you're logged in at linkedin.com in this browser, then click Connect. We read your session cookies directly - they stay on this device.";
    case 'x':
      return "Make sure you're logged in at x.com, then click Connect. After connecting, post one tweet natively so CrossPosty can learn the current request shape - then cross-posts to X work.";
    case 'mastodon':
      return 'Enter your instance (e.g. mastodon.social). A login window will open - sign in once and authorize CrossPosty.';
    case 'threads':
      return "Make sure you're logged in at threads.net, then click Connect. After connecting, post one thread natively so CrossPosty can learn the current request shape - then cross-posts to Threads work.";
    case 'substack':
      return "Make sure you're logged in at substack.com, then click Connect. After connecting, post one Note natively on your publication so CrossPosty can learn the current request shape - then cross-posts to Substack work.";
    case 'bluesky':
      return bskyMethod === 'oauth'
        ? 'Enter your handle. A login window will open — sign in once on bsky.app and authorize CrossPosty. No app password needed.'
        : 'Generate an app password at BlueSky -> Settings -> App Passwords, then paste it here. Fully local, no browser redirect.';
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
  const [bskyMethod, setBskyMethod] = useState<BskyAuthMethod>('oauth');

  const fields = fieldsFor(platformId, bskyMethod);
  const helper = helperFor(platformId, bskyMethod);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Federated platforms (Mastodon) need host permission granted at runtime
      // for whatever instance the user typed - we can't list every server in
      // host_permissions upfront. Chrome will show a one-time allow prompt
      // per instance.
      if (platformId === 'mastodon') {
        const raw = (params.instanceUrl ?? '').trim();
        const normalized = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
        try {
          const url = new URL(normalized);
          const granted = await chrome.permissions.request({
            origins: [`${url.origin}/*`],
          });
          if (!granted) {
            setError(`Permission to access ${url.host} was denied. Try again and click Allow.`);
            return;
          }
        } catch {
          setError('That instance URL looks invalid. Try just "mastodon.social" (no http).');
          return;
        }
      }

      // BlueSky OAuth needs the discriminator so the adapter routes to
      // the OAuth path instead of the app-password path.
      const finalParams =
        platformId === 'bluesky' && bskyMethod === 'oauth'
          ? { ...params, authType: 'oauth' }
          : params;

      const req: Message = {
        type: 'AUTHENTICATE',
        payload: { platformId, params: finalParams },
      };
      const response = (await chrome.runtime.sendMessage(req)) as
        | AuthenticateResponse
        | null
        | undefined;
      if (!response) {
        setError(
          'No response from background. Reload the extension at chrome://extensions (click the reload icon on the CrossPosty card) and try again.',
        );
        return;
      }
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
        {'<- back'}
      </button>
      <h2 className="font-medium capitalize">Add {platformId} account</h2>
      {platformId === 'bluesky' && (
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => {
              setBskyMethod('oauth');
              setParams({});
              setError(null);
            }}
            className={`flex-1 px-2 py-1 rounded border ${
              bskyMethod === 'oauth'
                ? 'bg-emerald-50 border-emerald-600 text-emerald-700'
                : 'border-gray-300 text-gray-600'
            }`}
          >
            OAuth (recommended)
          </button>
          <button
            type="button"
            onClick={() => {
              setBskyMethod('apppassword');
              setParams({});
              setError(null);
            }}
            className={`flex-1 px-2 py-1 rounded border ${
              bskyMethod === 'apppassword'
                ? 'bg-emerald-50 border-emerald-600 text-emerald-700'
                : 'border-gray-300 text-gray-600'
            }`}
          >
            App password
          </button>
        </div>
      )}
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
        {busy ? 'Connecting...' : 'Connect'}
      </button>
    </div>
  );
}
