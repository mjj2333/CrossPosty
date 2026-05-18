import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blueskyAdapter } from '../../src/platforms/bluesky';

const loginMock = vi.fn();
const postMock = vi.fn();
const getProfileMock = vi.fn();
const resumeSessionMock = vi.fn();

vi.mock('@atproto/api', () => {
  class BskyAgent {
    login = loginMock;
    post = postMock;
    getProfile = getProfileMock;
    resumeSession = resumeSessionMock;
    session = {
      did: 'did:plc:test',
      handle: 'test.bsky.social',
      accessJwt: 'access-jwt',
      refreshJwt: 'refresh-jwt',
    };
  }
  return { BskyAgent };
});

beforeEach(() => {
  loginMock.mockReset();
  postMock.mockReset();
  getProfileMock.mockReset();
  resumeSessionMock.mockReset();
  resumeSessionMock.mockResolvedValue(undefined);
});

describe('blueskyAdapter', () => {
  it('reports basic metadata', () => {
    expect(blueskyAdapter.id).toBe('bluesky');
    expect(blueskyAdapter.characterLimit).toBe(300);
  });

  it('authenticates with app password', async () => {
    loginMock.mockResolvedValue(undefined);
    const creds = await blueskyAdapter.authenticate({
      identifier: 'test.bsky.social',
      appPassword: 'xxxx-xxxx-xxxx-xxxx',
    });
    expect(loginMock).toHaveBeenCalledWith({
      identifier: 'test.bsky.social',
      password: 'xxxx-xxxx-xxxx-xxxx',
    });
    expect(creds.platformId).toBe('bluesky');
    expect(creds.displayName).toContain('test.bsky.social');
    expect(creds.data).toMatchObject({ did: 'did:plc:test', handle: 'test.bsky.social' });
  });

  it('posts text and returns a permalink', async () => {
    postMock.mockResolvedValue({
      uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
      cid: 'cid1',
    });
    const result = await blueskyAdapter.post(
      { text: 'hello world' },
      {
        platformId: 'bluesky',
        accountId: 'a',
        displayName: '@test.bsky.social',
        data: {
          did: 'did:plc:test',
          handle: 'test.bsky.social',
          accessJwt: 'a',
          refreshJwt: 'r',
        },
      },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe('https://bsky.app/profile/test.bsky.social/post/abc123');
      expect(result.remoteId).toBe('at://did:plc:test/app.bsky.feed.post/abc123');
    }
  });

  it('returns retryable failure on network error', async () => {
    postMock.mockRejectedValue(new Error('network'));
    const result = await blueskyAdapter.post(
      { text: 'x' },
      {
        platformId: 'bluesky',
        accountId: 'a',
        displayName: 'x',
        data: { did: 'd', handle: 'h', accessJwt: 'a', refreshJwt: 'r' },
      },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.retryable).toBe(true);
  });
});
