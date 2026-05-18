import { BskyAgent } from '@atproto/api';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

type BlueskySessionData = {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
};

async function makeAgent(data: BlueskySessionData): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.resumeSession({
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    active: true,
  });
  return agent;
}

export const blueskyAdapter: PlatformAdapter = {
  id: 'bluesky',
  displayName: 'BlueSky',
  characterLimit: 300,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 0,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },

  async authenticate(params): Promise<AccountCredentials> {
    const { identifier, appPassword } = params;
    if (!identifier || !appPassword) throw new Error('identifier and appPassword required');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier, password: appPassword });
    const session = agent.session;
    if (!session) throw new Error('login failed: no session');
    const data: BlueskySessionData = {
      did: session.did,
      handle: session.handle,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
    };
    return {
      platformId: 'bluesky',
      accountId: crypto.randomUUID(),
      displayName: `@${session.handle}`,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    try {
      const data = credentials.data as unknown as BlueskySessionData;
      const agent = await makeAgent(data);
      const res = await agent.post({ text: content.text });
      const rkey = res.uri.split('/').pop() ?? '';
      return {
        success: true,
        url: `https://bsky.app/profile/${data.handle}/post/${rkey}`,
        remoteId: res.uri,
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const data = credentials.data as unknown as BlueskySessionData;
      const agent = await makeAgent(data);
      await agent.getProfile({ actor: data.handle });
      return true;
    } catch {
      return false;
    }
  },
};
