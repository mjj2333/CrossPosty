import { createRestAPIClient } from 'masto';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

type MastodonSessionData = {
  instanceUrl: string;
  accessToken: string;
};

function client(data: MastodonSessionData) {
  return createRestAPIClient({ url: data.instanceUrl, accessToken: data.accessToken });
}

export const mastodonAdapter: PlatformAdapter = {
  id: 'mastodon',
  displayName: 'Mastodon',
  characterLimit: 500,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 60,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  },

  async authenticate(params): Promise<AccountCredentials> {
    const { instanceUrl, accessToken } = params;
    if (!instanceUrl || !accessToken) throw new Error('instanceUrl and accessToken required');
    const c = client({ instanceUrl, accessToken });
    const me = await c.v1.accounts.verifyCredentials();
    const host = new URL(instanceUrl).host;
    return {
      platformId: 'mastodon',
      accountId: crypto.randomUUID(),
      displayName: `@${me.acct}@${host}`,
      data: { instanceUrl, accessToken } as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      const status = await c.v1.statuses.create({ status: content.text });
      return { success: true, url: status.url ?? '', remoteId: status.id };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      await c.v1.accounts.verifyCredentials();
      return true;
    } catch {
      return false;
    }
  },
};
