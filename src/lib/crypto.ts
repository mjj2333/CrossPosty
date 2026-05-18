const ALGO = { name: 'AES-GCM', length: 256 } as const;
const USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

export async function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(ALGO, true, USAGES);
}

export async function exportKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

export async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALGO, true, USAGES);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptJSON(
  value: unknown,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { ciphertext: bytesToBase64(new Uint8Array(buf)), iv: bytesToBase64(iv) };
}

export async function decryptJSON<T>(ciphertext: string, iv: string, key: CryptoKey): Promise<T> {
  const ivBytes = base64ToBytes(iv);
  const ctBytes = base64ToBytes(ciphertext);
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ctBytes as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}
