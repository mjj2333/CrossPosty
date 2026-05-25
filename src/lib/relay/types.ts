// Shapes for the phone-to-extension relay. Three pieces touch these
// types: the extension popup (pairing UI), the background SW (polling +
// decrypt), and the phone PWA (separate repo). Keep this file dependency-
// free so it can be copy-pasted into the PWA codebase if needed.

// Stored extension-side in chrome.storage.local.relayPairing after the
// user generates a QR. Contains everything the extension needs to talk
// to Supabase + decrypt incoming messages.
export type RelayPairing = {
  version: 1;
  relayUrl: string;       // e.g. "https://abcd.supabase.co"
  anonKey: string;        // Supabase anon (publishable) key — safe to embed
  pairId: string;         // random 32-byte hex; acts as bearer token in RLS
  jwk: JsonWebKey;        // AES-GCM 256 key — extension's copy
  pairedAt: number;       // Date.now()
};

// The payload encoded into the pairing string/QR. Phone parses this and
// stores its own copy in IndexedDB. Identical shape to RelayPairing
// minus pairedAt (phone records its own pairing timestamp).
export type PairingPayload = {
  version: 1;
  relayUrl: string;
  anonKey: string;
  pairId: string;
  jwk: JsonWebKey;
};

// One Supabase relay_messages row decrypted into a usable payload. The
// `text` and `destinationHints` come from the encrypted JSON; media is
// fetched and decrypted from Storage separately, then assembled into a
// MediaAttachment[] before mounting the composer.
export type DecryptedRelayMessage = {
  id: string;
  text: string;
  mediaCount: number;
};

// Shape of the encrypted JSON blob the phone uploads. We send this
// minimal shape rather than the full InterceptedPost because the phone
// shouldn't need to know the InterceptedPost / MediaAttachment internals.
export type RelayPlaintext = {
  text: string;
  // Each media item references the encrypted blob in Storage by index.
  // Bytes live in storage; only metadata is in the encrypted text row.
  media: Array<{
    index: number;
    mimeType: string;
    iv: string;          // base64; the IV used to encrypt that blob
    alt?: string;
  }>;
};
