import {
  decryptJSON,
  encryptJSON,
  exportKey,
  generateDeviceKey,
  importKey,
} from '../lib/crypto';
import type { AccountCredentials } from '../platforms/types';
import type { DecryptedCredentialsArray, StoredCredentialsBlob } from './schema';

const KEY_BLOB = 'credentials';
const KEY_DEVICE_KEY = 'deviceKey';

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const existing = await chrome.storage.local.get(KEY_DEVICE_KEY);
  if (existing[KEY_DEVICE_KEY]) return importKey(existing[KEY_DEVICE_KEY] as JsonWebKey);
  const key = await generateDeviceKey();
  await chrome.storage.local.set({ [KEY_DEVICE_KEY]: await exportKey(key) });
  return key;
}

export async function loadCredentials(): Promise<DecryptedCredentialsArray> {
  const stored = await chrome.storage.local.get(KEY_BLOB);
  const blob = stored[KEY_BLOB] as StoredCredentialsBlob | undefined;
  if (!blob) return [];
  const key = await getOrCreateDeviceKey();
  return decryptJSON<DecryptedCredentialsArray>(blob.encrypted, blob.iv, key);
}

export async function saveCredentials(creds: DecryptedCredentialsArray): Promise<void> {
  const key = await getOrCreateDeviceKey();
  const { ciphertext, iv } = await encryptJSON(creds, key);
  const blob: StoredCredentialsBlob = { version: 1, encrypted: ciphertext, iv };
  await chrome.storage.local.set({ [KEY_BLOB]: blob });
}

export async function addCredential(cred: AccountCredentials): Promise<void> {
  const all = await loadCredentials();
  all.push(cred);
  await saveCredentials(all);
}

export async function deleteCredential(accountId: string): Promise<void> {
  const all = await loadCredentials();
  await saveCredentials(all.filter((c) => c.accountId !== accountId));
}
