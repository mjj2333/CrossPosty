import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadCredentials,
  saveCredentials,
  deleteCredential,
  addCredential,
} from '../../src/storage/credentials';
import type { AccountCredentials } from '../../src/platforms/types';

const store: Record<string, unknown> = {};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const result: Record<string, unknown> = {};
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) if (k in store) result[k] = store[k];
          return result;
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(store, entries);
        }),
      },
    },
  };
});

const sample = (id: string): AccountCredentials => ({
  platformId: 'bluesky',
  accountId: id,
  displayName: `@user-${id}`,
  data: { token: 'abc123' },
});

describe('credentials storage', () => {
  it('round-trips an empty list', async () => {
    expect(await loadCredentials()).toEqual([]);
  });

  it('saves and loads credentials', async () => {
    await saveCredentials([sample('a')]);
    expect(await loadCredentials()).toEqual([sample('a')]);
  });

  it('addCredential appends', async () => {
    await addCredential(sample('a'));
    await addCredential(sample('b'));
    const all = await loadCredentials();
    expect(all.map((c) => c.accountId)).toEqual(['a', 'b']);
  });

  it('deleteCredential removes by id', async () => {
    await addCredential(sample('a'));
    await addCredential(sample('b'));
    await deleteCredential('a');
    const all = await loadCredentials();
    expect(all.map((c) => c.accountId)).toEqual(['b']);
  });

  it('persists across reloads (same encryption key)', async () => {
    await addCredential(sample('a'));
    const reloaded = await loadCredentials();
    expect(reloaded).toEqual([sample('a')]);
  });
});
