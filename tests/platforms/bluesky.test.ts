import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blueskyAdapter } from '../../src/platforms/bluesky';

const loginMock = vi.fn();
const postMock = vi.fn();
const getProfileMock = vi.fn();
const resumeSessionMock = vi.fn();
const uploadBlobMock = vi.fn();

vi.mock('@atproto/api', () => {
  class BskyAgent {
    login = loginMock;
    post = postMock;
    getProfile = getProfileMock;
    resumeSession = resumeSessionMock;
    uploadBlob = uploadBlobMock;
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
  uploadBlobMock.mockReset();
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

  it('uploads attached images and includes them in the post embed', async () => {
    postMock.mockResolvedValue({
      uri: 'at://did:plc:test/app.bsky.feed.post/withimg',
      cid: 'cid2',
    });
    uploadBlobMock.mockResolvedValue({
      data: { blob: { $type: 'blob', ref: { $link: 'bafkreiUPLOAD' }, mimeType: 'image/jpeg', size: 4 } },
    });
    const result = await blueskyAdapter.post(
      {
        text: 'hello with image',
        media: [{ blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), mimeType: 'image/jpeg' }],
      },
      {
        platformId: 'bluesky',
        accountId: 'a',
        displayName: '@test.bsky.social',
        data: { did: 'did:plc:test', handle: 'test.bsky.social', accessJwt: 'a', refreshJwt: 'r' },
      },
    );
    expect(result.success).toBe(true);
    expect(uploadBlobMock).toHaveBeenCalledOnce();
    const postArgs = postMock.mock.calls[0]?.[0] as { embed?: { $type: string; images: unknown[] } };
    expect(postArgs.embed?.$type).toBe('app.bsky.embed.images');
    expect(postArgs.embed?.images).toHaveLength(1);
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
