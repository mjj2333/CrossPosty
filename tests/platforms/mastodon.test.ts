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

beforeEach(() => {
  verifyCredentialsMock.mockReset();
  createStatusMock.mockReset();
});

describe('mastodonAdapter', () => {
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
