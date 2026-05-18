import { describe, it, expect, vi, beforeEach } from 'vitest';
import { linkedinAdapter } from '../../src/platforms/linkedin';

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    cookies: {
      get: vi.fn(async ({ name }: { name: string }) => {
        if (name === 'li_at') return { value: 'li-at-value' };
        if (name === 'JSESSIONID') return { value: '"ajax:1234567890"' };
        return null;
      }),
    },
  };
});

describe('linkedinAdapter', () => {
  it('captures a session from cookies', async () => {
    const creds = await linkedinAdapter.authenticate({});
    expect(creds.platformId).toBe('linkedin');
    expect(creds.data).toMatchObject({ liAt: 'li-at-value', jsessionId: '"ajax:1234567890"' });
  });

  it('posts content and returns success', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ updateUrn: 'urn:li:share:abc' }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await linkedinAdapter.post(
      { text: 'hello' },
      {
        platformId: 'linkedin',
        accountId: 'a',
        displayName: 'me',
        data: { liAt: 'li-at-value', jsessionId: '"ajax:1234567890"' },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.remoteId).toBe('urn:li:share:abc');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    const init = calls[0]?.[1];
    if (!init) throw new Error('fetch was not called with init');
    expect((init.headers as Record<string, string>)['csrf-token']).toBe('ajax:1234567890');
    expect((init.headers as Record<string, string>)['x-restli-protocol-version']).toBe('2.0.0');
  });

  it('returns retryable failure on non-2xx', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    const result = await linkedinAdapter.post(
      { text: 'hi' },
      {
        platformId: 'linkedin',
        accountId: 'a',
        displayName: 'me',
        data: { liAt: 'li', jsessionId: '"ajax:1"' },
      },
    );
    expect(result.success).toBe(false);
  });
});
