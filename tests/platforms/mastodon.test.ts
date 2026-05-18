import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mastodonAdapter } from '../../src/platforms/mastodon';

const verifyCredentialsMock = vi.fn();
const createStatusMock = vi.fn();

vi.mock('masto', () => ({
  createRestAPIClient: vi.fn(() => ({
    v1: {
      accounts: { verifyCredentials: verifyCredentialsMock },
      statuses: { create: createStatusMock },
    },
  })),
}));

const storageGet = vi.fn();
const storageSet = vi.fn();
const launchWebAuthFlow = vi.fn();
const getRedirectURL = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  verifyCredentialsMock.mockReset();
  createStatusMock.mockReset();
  storageGet.mockReset();
  storageSet.mockReset();
  launchWebAuthFlow.mockReset();
  getRedirectURL.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
    identity: {
      launchWebAuthFlow,
      getRedirectURL,
    },
  };
});

describe('mastodonAdapter.authenticate', () => {
  it('registers an app, runs OAuth, exchanges code, and returns credentials', async () => {
    storageGet.mockResolvedValue({}); // no cached app
    storageSet.mockResolvedValue(undefined);
    getRedirectURL.mockReturnValue('https://abcdef.chromiumapp.org/');

    // Successful OAuth redirect: ...?code=AUTH_CODE
    launchWebAuthFlow.mockResolvedValue(
      'https://abcdef.chromiumapp.org/?code=AUTH_CODE',
    );

    const appResponse = new Response(
      JSON.stringify({ client_id: 'CID', client_secret: 'CSEC' }),
      { status: 200 },
    );
    const tokenResponse = new Response(
      JSON.stringify({ access_token: 'TOK', token_type: 'Bearer' }),
      { status: 200 },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(appResponse)
      .mockResolvedValueOnce(tokenResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    verifyCredentialsMock.mockResolvedValue({ acct: 'user' });

    const creds = await mastodonAdapter.authenticate({ instanceUrl: 'https://mastodon.social' });

    expect(creds.platformId).toBe('mastodon');
    expect(creds.displayName).toBe('@user@mastodon.social');
    expect(creds.data).toMatchObject({
      instanceUrl: 'https://mastodon.social',
      accessToken: 'TOK',
    });

    // App registration POST
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://mastodon.social/api/v1/apps');
    const registerBody = JSON.parse(calls[0]?.[1].body as string) as {
      client_name: string;
      redirect_uris: string;
      scopes: string;
    };
    expect(registerBody.client_name).toBe('CrossPosty');
    expect(registerBody.redirect_uris).toBe('https://abcdef.chromiumapp.org/');
    expect(registerBody.scopes).toBe('read:accounts write:statuses');

    // OAuth flow opens correct authorize URL
    const launchCall = launchWebAuthFlow.mock.calls[0]?.[0] as { url: string };
    expect(launchCall.url).toContain('https://mastodon.social/oauth/authorize?');
    expect(launchCall.url).toContain('client_id=CID');
    expect(launchCall.url).toContain('redirect_uri=https%3A%2F%2Fabcdef.chromiumapp.org%2F');

    // Token exchange
    expect(calls[1]?.[0]).toBe('https://mastodon.social/oauth/token');
    const tokenBody = JSON.parse(calls[1]?.[1].body as string) as {
      grant_type: string;
      code: string;
      client_id: string;
      client_secret: string;
    };
    expect(tokenBody.grant_type).toBe('authorization_code');
    expect(tokenBody.code).toBe('AUTH_CODE');
    expect(tokenBody.client_id).toBe('CID');
    expect(tokenBody.client_secret).toBe('CSEC');

    // App was cached
    expect(storageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        mastodonApps: expect.objectContaining({
          'https://mastodon.social': expect.objectContaining({ clientId: 'CID' }),
        }),
      }),
    );
  });

  it('reuses a cached app registration for the same instance', async () => {
    storageGet.mockResolvedValue({
      mastodonApps: {
        'https://mastodon.social': {
          instanceUrl: 'https://mastodon.social',
          clientId: 'CACHED_CID',
          clientSecret: 'CACHED_CSEC',
          redirectUri: 'https://abcdef.chromiumapp.org/',
        },
      },
    });
    getRedirectURL.mockReturnValue('https://abcdef.chromiumapp.org/');
    launchWebAuthFlow.mockResolvedValue(
      'https://abcdef.chromiumapp.org/?code=NEW_CODE',
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'TOK' }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    verifyCredentialsMock.mockResolvedValue({ acct: 'user' });

    await mastodonAdapter.authenticate({ instanceUrl: 'https://mastodon.social' });

    // Only the token exchange should have been fetched — no app registration
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://mastodon.social/oauth/token');
    const body = JSON.parse(calls[0]?.[1].body as string) as { client_id: string };
    expect(body.client_id).toBe('CACHED_CID');
  });

  it('normalizes instance URL (adds https://, strips trailing slash)', async () => {
    storageGet.mockResolvedValue({});
    storageSet.mockResolvedValue(undefined);
    getRedirectURL.mockReturnValue('https://abcdef.chromiumapp.org/');
    launchWebAuthFlow.mockResolvedValue(
      'https://abcdef.chromiumapp.org/?code=AUTH_CODE',
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'C', client_secret: 'S' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'T' }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    verifyCredentialsMock.mockResolvedValue({ acct: 'user' });

    await mastodonAdapter.authenticate({ instanceUrl: 'mastodon.social/' });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://mastodon.social/api/v1/apps');
  });

  it('throws if OAuth is cancelled', async () => {
    storageGet.mockResolvedValue({
      mastodonApps: {
        'https://mastodon.social': {
          instanceUrl: 'https://mastodon.social',
          clientId: 'C',
          clientSecret: 'S',
          redirectUri: 'https://abcdef.chromiumapp.org/',
        },
      },
    });
    getRedirectURL.mockReturnValue('https://abcdef.chromiumapp.org/');
    launchWebAuthFlow.mockResolvedValue(undefined); // cancelled

    await expect(
      mastodonAdapter.authenticate({ instanceUrl: 'https://mastodon.social' }),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe('mastodonAdapter.post', () => {
  it('posts text and returns the URL from the API response', async () => {
    createStatusMock.mockResolvedValue({ id: '999', url: 'https://mastodon.social/@user/999' });
    const result = await mastodonAdapter.post(
      { text: 'toot' },
      {
        platformId: 'mastodon',
        accountId: 'a',
        displayName: '@user@mastodon.social',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.url).toBe('https://mastodon.social/@user/999');
  });

  it('reports failure on API error', async () => {
    createStatusMock.mockRejectedValue(new Error('500'));
    const result = await mastodonAdapter.post(
      { text: 'toot' },
      {
        platformId: 'mastodon',
        accountId: 'a',
        displayName: '@user@mastodon.social',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      },
    );
    expect(result.success).toBe(false);
  });

  it('validateCredentials returns true on success', async () => {
    verifyCredentialsMock.mockResolvedValue({ acct: 'user' });
    expect(
      await mastodonAdapter.validateCredentials({
        platformId: 'mastodon',
        accountId: 'a',
        displayName: 'x',
        data: { instanceUrl: 'https://mastodon.social', accessToken: 'token' },
      }),
    ).toBe(true);
  });
});
