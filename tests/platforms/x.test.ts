import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xAdapter } from '../../src/platforms/x';
import type { XCreateTweetTemplate } from '../../src/storage/x-template';

const storageGet = vi.fn();
const cookieGet = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { get: storageGet } },
    cookies: { get: cookieGet },
  };
  storageGet.mockReset();
  cookieGet.mockReset();
});

function templateFixture(): XCreateTweetTemplate {
  return {
    version: 1,
    url: 'https://x.com/i/api/graphql/abc123HASH/CreateTweet',
    headers: {
      authorization: 'Bearer SOMETOKEN',
      'content-type': 'application/json',
      'x-csrf-token': 'old-csrf',
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
    },
    bodyJson: {
      variables: {
        tweet_text: 'original native tweet',
        dark_request: false,
        media: { media_entities: [], possibly_sensitive: false },
        semantic_annotation_ids: [],
      },
      features: { something: true },
      queryId: 'abc123HASH',
    },
    capturedAt: 1000,
  };
}

describe('xAdapter.authenticate', () => {
  it('captures auth_token + ct0 from cookies', async () => {
    cookieGet.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'auth_token') return { value: 'auth-tok-value' };
      if (name === 'ct0') return { value: 'csrf-ct0' };
      return null;
    });
    const creds = await xAdapter.authenticate({});
    expect(creds.platformId).toBe('x');
    expect(creds.data).toMatchObject({ authToken: 'auth-tok-value', ct0: 'csrf-ct0' });
  });

  it('throws if cookies missing', async () => {
    cookieGet.mockResolvedValue(null);
    await expect(xAdapter.authenticate({})).rejects.toThrow(/log in to x\.com/i);
  });
});

describe('xAdapter.post', () => {
  it('returns failure when no template captured yet', async () => {
    storageGet.mockResolvedValue({});
    cookieGet.mockImplementation(async ({ name }: { name: string }) =>
      name === 'ct0' ? { value: 'csrf' } : { value: 'tok' },
    );
    const result = await xAdapter.post(
      { text: 'hello' },
      {
        platformId: 'x',
        accountId: 'a',
        displayName: 'me',
        data: { authToken: 'tok', ct0: 'csrf' },
      },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/post natively on x\.com once/i);
  });

  it('replays the template with new tweet text and fresh csrf', async () => {
    storageGet.mockResolvedValue({ xTemplate: templateFixture() });
    cookieGet.mockImplementation(async ({ name }: { name: string }) =>
      name === 'ct0' ? { value: 'fresh-csrf' } : { value: 'tok' },
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              create_tweet: {
                tweet_results: { result: { rest_id: '1234567890', legacy: { full_text: 'cross-posted text' } } },
              },
            },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await xAdapter.post(
      { text: 'cross-posted text' },
      {
        platformId: 'x',
        accountId: 'a',
        displayName: '@me',
        data: { authToken: 'tok', ct0: 'fresh-csrf', screenName: 'me' },
      },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.remoteId).toBe('1234567890');
      expect(result.url).toBe('https://x.com/me/status/1234567890');
    }

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://x.com/i/api/graphql/abc123HASH/CreateTweet');
    const init = calls[0]?.[1];
    if (!init) throw new Error('fetch not called with init');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('fresh-csrf');
    const body = JSON.parse(init.body as string) as {
      variables: { tweet_text: string };
    };
    expect(body.variables.tweet_text).toBe('cross-posted text');
  });

  it('returns retryable failure on 5xx, non-retryable on 4xx', async () => {
    storageGet.mockResolvedValue({ xTemplate: templateFixture() });
    cookieGet.mockResolvedValue({ value: 'csrf' });
    globalThis.fetch = vi.fn(
      async () => new Response('bad', { status: 500 }),
    ) as unknown as typeof fetch;
    const result500 = await xAdapter.post(
      { text: 'x' },
      {
        platformId: 'x',
        accountId: 'a',
        displayName: 'me',
        data: { authToken: 't', ct0: 'c' },
      },
    );
    expect(result500.success).toBe(false);
    if (!result500.success) expect(result500.retryable).toBe(true);

    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    const result403 = await xAdapter.post(
      { text: 'x' },
      {
        platformId: 'x',
        accountId: 'a',
        displayName: 'me',
        data: { authToken: 't', ct0: 'c' },
      },
    );
    expect(result403.success).toBe(false);
    if (!result403.success) expect(result403.retryable).toBe(false);
  });
});
