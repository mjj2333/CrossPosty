import { BskyAgent } from '@atproto/api';
import type {
  AccountCredentials,
  MediaAttachment,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

// BlueSky enforces a max of 4 images per post and ~1MB per image.
const MAX_IMAGES = 4;

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

async function uploadImagesAndBuildEmbed(
  agent: BskyAgent,
  images: MediaAttachment[],
): Promise<unknown | null> {
  if (images.length === 0) return null;
  const limited = images.slice(0, MAX_IMAGES);
  const uploaded = await Promise.all(
    limited.map(async (m) => {
      const bytes = new Uint8Array(await m.blob.arrayBuffer());
      const upload = await agent.uploadBlob(bytes, { encoding: m.mimeType });
      return {
        alt: m.alt ?? '',
        image: upload.data.blob,
      };
    }),
  );
  return {
    $type: 'app.bsky.embed.images',
    images: uploaded,
  };
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

      // Upload any attached media as blobs and build an embed.
      const imageMedia = (content.media ?? []).filter((m) =>
        m.mimeType.startsWith('image/'),
      );
      const embed = await uploadImagesAndBuildEmbed(agent, imageMedia);

      const record: { text: string; embed?: unknown } = { text: content.text };
      if (embed) record.embed = embed;

      // agent.post types embed as a specific union; we've built a valid
      // app.bsky.embed.images shape but TS can't verify it through `unknown`.
      const res = await agent.post(record as Parameters<typeof agent.post>[0]);
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
