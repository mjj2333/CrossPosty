import { decryptJSON, decryptRawBytes, encryptJSON, importKey } from '../crypto';
import type { RelayPairing, RelayPlaintext } from './types';

// Direct REST calls to Supabase (PostgREST for the table, storage-api for
// blobs) — avoids pulling supabase-js into the extension bundle. Every
// request sends the same three header trio: `apikey` + `Authorization`
// (both the anon key) + `x-pair-id` (the per-device bearer token that
// RLS policies match against current_setting('request.headers')).

export type UnconsumedMessageRow = {
  id: string;
  pair_id: string;
  created_at: string;
  iv: string;
  ciphertext: string;
  media_count: number;
  consumed_at: string | null;
};

function relayHeaders(pairing: RelayPairing): Record<string, string> {
  return {
    apikey: pairing.anonKey,
    Authorization: `Bearer ${pairing.anonKey}`,
    'x-pair-id': pairing.pairId,
  };
}

export async function fetchUnconsumedMessages(
  pairing: RelayPairing,
): Promise<UnconsumedMessageRow[]> {
  const url = new URL(`${pairing.relayUrl}/rest/v1/relay_messages`);
  url.searchParams.set('pair_id', `eq.${pairing.pairId}`);
  url.searchParams.set('consumed_at', 'is.null');
  url.searchParams.set('order', 'created_at.asc');
  url.searchParams.set('limit', '10');
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { ...relayHeaders(pairing), accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`relay list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as UnconsumedMessageRow[];
}

export async function fetchMessageById(
  pairing: RelayPairing,
  id: string,
): Promise<UnconsumedMessageRow | null> {
  const url = new URL(`${pairing.relayUrl}/rest/v1/relay_messages`);
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('limit', '1');
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { ...relayHeaders(pairing), accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`relay get HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as UnconsumedMessageRow[];
  return rows[0] ?? null;
}

export async function markMessageConsumed(
  pairing: RelayPairing,
  id: string,
): Promise<void> {
  const url = new URL(`${pairing.relayUrl}/rest/v1/relay_messages`);
  url.searchParams.set('id', `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      ...relayHeaders(pairing),
      'content-type': 'application/json',
      // Without this PostgREST returns the updated rows; we don't need them.
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`relay consume HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// Storage object fetch. Path convention: <pairId>/<messageId>/<index>.bin.
// The RLS policy on storage.objects allows the anon role only when the
// object's first path segment matches the x-pair-id header.
export async function fetchEncryptedBlob(
  pairing: RelayPairing,
  messageId: string,
  index: number,
): Promise<Uint8Array> {
  const objectPath = `${pairing.pairId}/${messageId}/${index}.bin`;
  const url = `${pairing.relayUrl}/storage/v1/object/relay-media/${objectPath}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: relayHeaders(pairing),
  });
  if (!res.ok) {
    throw new Error(`relay blob HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Convenience: pull a message row, decrypt the JSON payload, fetch +
// decrypt each media blob. Returns a usable payload ready to feed into
// ComposerPanel. Caller separately calls markMessageConsumed once the
// user has interacted with the content (so closing the tab without
// cross-posting keeps the message in the queue for next time).
export type DecryptedMessage = {
  id: string;
  text: string;
  media: Array<{ bytes: Uint8Array; mimeType: string; alt?: string }>;
};

// Test-path helper: pretends to be the phone PWA by encrypting a payload
// with the same key and POSTing it into Supabase. Used by the popup's
// "send test" button so the user can verify the full pipeline without
// the phone PWA being built yet. Phone-PWA-side code will look almost
// identical (same encryption, same headers, same endpoint).
export async function sendTestMessage(
  pairing: RelayPairing,
  text: string,
): Promise<{ id: string }> {
  const key = await importKey(pairing.jwk);
  const plaintext: RelayPlaintext = { text, media: [] };
  const { ciphertext, iv } = await encryptJSON(plaintext, key);
  const url = `${pairing.relayUrl}/rest/v1/relay_messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...relayHeaders(pairing),
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      pair_id: pairing.pairId,
      iv,
      ciphertext,
      media_count: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`relay send HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as Array<{ id: string }>;
  const first = rows[0];
  if (!first) throw new Error('relay send returned no row');
  return { id: first.id };
}

export async function decryptMessage(
  pairing: RelayPairing,
  row: UnconsumedMessageRow,
): Promise<DecryptedMessage> {
  const key = await importKey(pairing.jwk);
  const payload = await decryptJSON<RelayPlaintext>(row.ciphertext, row.iv, key);
  const media: DecryptedMessage['media'] = [];
  for (const item of payload.media) {
    const ct = await fetchEncryptedBlob(pairing, row.id, item.index);
    const bytes = await decryptRawBytes(ct, item.iv, key);
    media.push({ bytes, mimeType: item.mimeType, alt: item.alt });
  }
  return { id: row.id, text: payload.text, media };
}
