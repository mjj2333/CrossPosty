import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { bytesToBase64, exportKey, generateDeviceKey } from '../../../lib/crypto';
import { sendTestMessage } from '../../../lib/relay/client';
import {
  DEFAULT_ANON_KEY,
  DEFAULT_RELAY_URL,
  hasDefaultRelayConfig,
} from '../../../lib/relay/defaults';
import { pollRelayOnce } from '../../../lib/relay/poll';
import type { PairingPayload, RelayPairing } from '../../../lib/relay/types';
import {
  clearRelayPairing,
  loadRelayPairing,
  saveRelayPairing,
} from '../../../storage/relay-pairing';
import { loadSettings, updateSettings } from '../../../storage/settings';
import type { UserSettings } from '../../../storage/schema';

// Deployed PWA URL the QR points at. Phone's camera detects this as a
// link and offers "open" — tapping it lands the user on the PWA with
// the pairing code in the query string for auto-import.
const PWA_BASE_URL = 'https://crossposty-phone.netlify.app';

type Stage =
  | { name: 'loading' }
  | { name: 'unpaired' }                                  // no pairing yet, no inputs collected
  | { name: 'configuring'; relayUrl: string; anonKey: string }
  | { name: 'paired'; pairing: RelayPairing; payloadB64: string };

export function PhonePairingPage({ onBack }: { onBack: () => void }) {
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const existing = await loadRelayPairing();
      if (existing) {
        setStage({
          name: 'paired',
          pairing: existing,
          payloadB64: encodePairingPayload(existing),
        });
      } else {
        setStage({ name: 'unpaired' });
      }
    })();
  }, []);

  async function generate(relayUrl: string, anonKey: string): Promise<void> {
    const cleanedUrl = relayUrl.trim().replace(/\/+$/, '');
    const cleanedKey = anonKey.trim();
    if (!cleanedUrl || !cleanedKey) return;
    const key = await generateDeviceKey();
    const jwk = await exportKey(key);
    const pairIdBytes = crypto.getRandomValues(new Uint8Array(16));
    const pairId = Array.from(pairIdBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const pairing: RelayPairing = {
      version: 1,
      relayUrl: cleanedUrl,
      anonKey: cleanedKey,
      pairId,
      jwk,
      pairedAt: Date.now(),
    };
    await saveRelayPairing(pairing);
    setStage({
      name: 'paired',
      pairing,
      payloadB64: encodePairingPayload(pairing),
    });
  }

  async function unpair(): Promise<void> {
    await clearRelayPairing();
    setStage({ name: 'unpaired' });
  }

  async function copyPayload(payload: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can be blocked in some popup contexts; fall back
      // to a manual selection prompt is overkill — surface the value
      // and let the user select+copy by hand.
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="font-medium">Phone pairing</h2>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-gray-500 hover:underline"
        >
          ← back
        </button>
      </div>

      {stage.name === 'loading' && (
        <p className="text-sm text-gray-500">Loading…</p>
      )}

      {stage.name === 'unpaired' && hasDefaultRelayConfig() && (
        <UnpairedDefaultsView onPair={() => generate(DEFAULT_RELAY_URL, DEFAULT_ANON_KEY)} />
      )}

      {stage.name === 'unpaired' && !hasDefaultRelayConfig() && (
        <>
          <p className="text-xs text-gray-500">
            Pair a phone so you can compose on the go. Your Supabase project
            holds an encrypted queue; only this extension and your paired
            phone hold the key to decrypt.
          </p>
          <p className="text-xs text-gray-500">
            Paste your Supabase project URL and anon (publishable) key.
            Both can be found in the Supabase dashboard under
            Settings → API.
          </p>
          <ConfigureForm onSubmit={generate} />
        </>
      )}

      {stage.name === 'configuring' && (
        <ConfigureForm
          initial={{ relayUrl: stage.relayUrl, anonKey: stage.anonKey }}
          onSubmit={generate}
        />
      )}

      {stage.name === 'paired' && (
        <>
          <p className="text-xs text-gray-500">
            Paired{' '}
            {new Date(stage.pairing.pairedAt).toLocaleString()}. Scan the
            QR code from your phone, or paste the code below into the
            CrossPosty phone web app.
          </p>
          <PairingQR payload={stage.payloadB64} />
          <details className="text-xs">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
              show raw pairing code
            </summary>
            <textarea
              value={stage.payloadB64}
              readOnly
              rows={4}
              className="w-full border rounded p-2 text-[10px] font-mono break-all mt-1"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => copyPayload(stage.payloadB64)}
              className="mt-1 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded text-xs"
            >
              {copied ? 'copied!' : 'copy'}
            </button>
          </details>
          <button
            type="button"
            onClick={unpair}
            className="text-red-600 text-sm hover:underline self-start"
          >
            unpair / rotate key
          </button>
          <PhoneModeToggle />
          <SendTestSection pairing={stage.pairing} />
        </>
      )}
    </div>
  );
}

// One-click pairing UI when the build has a default relay configured.
// Hides the BYO form behind an "advanced" disclosure for power users
// who want to point their phone at their own Supabase project instead.
function UnpairedDefaultsView({ onPair }: { onPair: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Pair a phone so you can compose on the go. CrossPosty's managed
        relay holds an encrypted queue; only this extension and your
        paired phone hold the key to decrypt. The server only ever sees
        ciphertext.
      </p>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          try {
            await onPair();
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm"
      >
        {busy ? 'generating…' : 'pair phone'}
      </button>
    </div>
  );
}

function ConfigureForm({
  initial,
  onSubmit,
}: {
  initial?: { relayUrl: string; anonKey: string };
  onSubmit: (relayUrl: string, anonKey: string) => Promise<void>;
}) {
  const [relayUrl, setRelayUrl] = useState(initial?.relayUrl ?? '');
  const [anonKey, setAnonKey] = useState(initial?.anonKey ?? '');
  const [busy, setBusy] = useState(false);
  const canSubmit = relayUrl.trim().length > 0 && anonKey.trim().length > 0 && !busy;
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setBusy(true);
        try {
          await onSubmit(relayUrl, anonKey);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-xs">
        <span className="text-gray-500">Supabase URL</span>
        <input
          type="url"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder="https://abcdefg.supabase.co"
          className="block w-full border rounded px-2 py-1 text-xs"
        />
      </label>
      <label className="block text-xs">
        <span className="text-gray-500">Supabase anon key</span>
        <textarea
          value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          placeholder="eyJhbGciOi..."
          rows={3}
          className="block w-full border rounded px-2 py-1 text-[10px] font-mono break-all"
        />
      </label>
      <button
        type="submit"
        disabled={!canSubmit}
        className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm"
      >
        {busy ? 'generating…' : 'generate pairing code'}
      </button>
    </form>
  );
}

// Render a QR pointing at PWA_BASE_URL?pair=<urlsafe-base64>. Phone
// camera apps recognize URLs and offer a tap to open; the PWA then
// auto-imports the pairing from the query string. Error-correction L
// keeps the code low-density — the URL+payload runs ~700 chars total,
// still comfortable under QR byte-mode's 2,953-byte ceiling.
function PairingQR({ payload }: { payload: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `${PWA_BASE_URL}/?pair=${toUrlSafe(payload)}`;
  useEffect(() => {
    QRCode.toDataURL(url, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 280,
    })
      .then(setDataUrl)
      .catch((e: unknown) => setError(String(e).slice(0, 150)));
  }, [url]);
  if (error) {
    return <p className="text-xs text-red-600">QR generation failed: {error}</p>;
  }
  if (!dataUrl) {
    return <p className="text-xs text-gray-500">generating QR…</p>;
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <img
        src={dataUrl}
        alt="Pairing QR"
        width={280}
        height={280}
        className="border rounded"
      />
      <p className="text-[10px] text-gray-400 text-center">
        Scan with your phone's camera app
      </p>
    </div>
  );
}

// base64 (standard) -> base64url so it's safe in a URL query string.
// '+' -> '-', '/' -> '_', strip trailing '='.
function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Lets the user choose how the desktop handles incoming phone posts.
// 'auto' is the headline UX (compose-and-forget); 'review' restores the
// per-platform editing flow for users who want to tweak before sending.
function PhoneModeToggle() {
  const [mode, setMode] = useState<UserSettings['phoneMode'] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadSettings().then((s) => setMode(s.phoneMode));
  }, []);

  async function set(next: UserSettings['phoneMode']): Promise<void> {
    setSaving(true);
    try {
      await updateSettings({ phoneMode: next });
      setMode(next);
    } finally {
      setSaving(false);
    }
  }

  if (mode === null) return null;
  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <p className="text-xs text-gray-500 font-medium">
        When a phone post arrives on desktop…
      </p>
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          onClick={() => set('auto')}
          disabled={saving}
          className={`flex-1 px-2 py-1 rounded border ${
            mode === 'auto'
              ? 'bg-emerald-50 border-emerald-600 text-emerald-700'
              : 'border-gray-300 text-gray-600'
          }`}
        >
          Auto-post
        </button>
        <button
          type="button"
          onClick={() => set('review')}
          disabled={saving}
          className={`flex-1 px-2 py-1 rounded border ${
            mode === 'review'
              ? 'bg-emerald-50 border-emerald-600 text-emerald-700'
              : 'border-gray-300 text-gray-600'
          }`}
        >
          Review first
        </button>
      </div>
      <p className="text-[10px] text-gray-500">
        {mode === 'auto'
          ? 'Auto-post: receiver tab cross-posts to every destination immediately. No desktop click.'
          : 'Review first: receiver tab opens the composer so you can edit text per platform and choose destinations before sending.'}
      </p>
    </div>
  );
}

// Dev-test path: encrypt + POST a fake "from phone" message using the
// current pairing. Lets the user verify the whole pipeline (Supabase
// insert -> background poll -> receiver tab opens -> ComposerPanel
// renders -> consumed marking) without the phone PWA being built yet.
// Identical encryption path the phone PWA will use, so a green here
// means the protocol is correct.
function SendTestSection({ pairing }: { pairing: RelayPairing }) {
  const [text, setText] = useState('Test from CrossPosty pairing page.');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  async function send(): Promise<void> {
    setSending(true);
    setStatus(null);
    try {
      const { id } = await sendTestMessage(pairing, text);
      setStatus(`Sent ${id.slice(0, 8)}…. Receiver tab should open within 30s.`);
      // Kick off an immediate poll so the user doesn't wait the full
      // alarm period to see the receiver tab.
      void pollRelayOnce().catch(() => undefined);
    } catch (err) {
      setStatus(`Failed: ${String(err).slice(0, 150)}`);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <p className="text-xs text-gray-500">
        Test the pipeline end-to-end. Sends an encrypted message to your
        Supabase queue as if it came from the phone. A receiver tab
        should open within ~30s.
      </p>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full border rounded px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={send}
        disabled={sending || text.trim().length === 0}
        className="bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm"
      >
        {sending ? 'sending…' : 'send test message'}
      </button>
      {status && <p className="text-xs text-gray-600">{status}</p>}
    </div>
  );
}

// Base64-encode the JSON pairing payload so it travels as a single
// blob — phone parses by base64-decoding then JSON.parse. Smaller than
// raw JSON URI-encoding and easier to paste without losing characters.
function encodePairingPayload(pairing: RelayPairing): string {
  const payload: PairingPayload = {
    version: 1,
    relayUrl: pairing.relayUrl,
    anonKey: pairing.anonKey,
    pairId: pairing.pairId,
    jwk: pairing.jwk,
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64(bytes);
}
