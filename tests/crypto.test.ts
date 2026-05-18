import { describe, it, expect } from 'vitest';
import {
  generateDeviceKey,
  exportKey,
  importKey,
  encryptJSON,
  decryptJSON,
} from '../src/lib/crypto';

describe('crypto', () => {
  it('encrypts and decrypts a JSON object round-trip', async () => {
    const key = await generateDeviceKey();
    const payload = { foo: 'bar', n: 42 };
    const { ciphertext, iv } = await encryptJSON(payload, key);
    const decrypted = await decryptJSON<typeof payload>(ciphertext, iv, key);
    expect(decrypted).toEqual(payload);
  });

  it('exports and re-imports a key', async () => {
    const key = await generateDeviceKey();
    const jwk = await exportKey(key);
    const reimported = await importKey(jwk);
    const { ciphertext, iv } = await encryptJSON({ x: 1 }, key);
    const decrypted = await decryptJSON<{ x: number }>(ciphertext, iv, reimported);
    expect(decrypted).toEqual({ x: 1 });
  });

  it('rejects tampered ciphertext', async () => {
    const key = await generateDeviceKey();
    const { ciphertext, iv } = await encryptJSON({ a: 1 }, key);
    const lastChar = ciphertext.slice(-1);
    const replacement = lastChar === 'A' ? 'B' : 'A';
    const tampered = ciphertext.slice(0, -1) + replacement;
    await expect(decryptJSON(tampered, iv, key)).rejects.toThrow();
  });
});
