import { logger } from '../lib/logger';
import type { CrossPostResultEntry, Message } from '../lib/messaging';
import { onMessage } from '../lib/messaging';
import { getAdapter } from '../platforms';
import type { PostResult } from '../platforms/types';
import { loadCredentials } from '../storage/credentials';

export default defineBackground(() => {
  logger.info('background loaded');

  onMessage(async (msg: Message) => {
    if (msg.type === 'LIST_CREDENTIALS') {
      const creds = await loadCredentials();
      return { type: 'LIST_CREDENTIALS_RESPONSE', payload: creds };
    }

    if (msg.type === 'CROSSPOST_REQUEST') {
      const { content, accountIds } = msg.payload;
      const allCreds = await loadCredentials();
      const targets = allCreds.filter((c) => accountIds.includes(c.accountId));
      const settled = await Promise.allSettled(
        targets.map(async (cred): Promise<CrossPostResultEntry> => {
          const adapter = getAdapter(cred.platformId);
          const result = await adapter.post(content, cred);
          return { accountId: cred.accountId, platformId: cred.platformId, result };
        }),
      );
      return settled.map((r): CrossPostResultEntry => {
        if (r.status === 'fulfilled') return r.value;
        const failure: PostResult = {
          success: false,
          error: String(r.reason),
          retryable: true,
        };
        return { accountId: 'unknown', platformId: 'bluesky', result: failure };
      });
    }

    return undefined;
  });
});
