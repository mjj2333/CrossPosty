import { logger } from '../lib/logger';
import { deserializeMediaAttachments } from '../lib/media-transport';
import type { AuthenticateResponse, CrossPostResultEntry, Message } from '../lib/messaging';
import { onMessage } from '../lib/messaging';
import { getAdapter } from '../platforms';
import type { PostContent, PostResult } from '../platforms/types';
import { addCredential, loadCredentials } from '../storage/credentials';

const X_UPLOAD_DNR_RULE_ID = 1;

async function installXUploadHeaderRewrite(): Promise<void> {
  // Our background fetch to X's media upload endpoint sends
  // `Origin: chrome-extension://<ext-id>`, which X's edge rejects with 403
  // before the request reaches the upload service. Rewrite Origin + Referer
  // to look like a normal x.com web-client request. The rule applies to all
  // requests on this URL pattern — for the user's own page-context uploads
  // the Origin is already https://x.com so the rewrite is a no-op; only our
  // background requests get the meaningful substitution.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [X_UPLOAD_DNR_RULE_ID],
      addRules: [
        {
          id: X_UPLOAD_DNR_RULE_ID,
          priority: 1,
          condition: {
            urlFilter: '||upload.x.com/i/media/upload.json',
            resourceTypes: ['xmlhttprequest'],
          },
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'origin', operation: 'set', value: 'https://x.com' },
              { header: 'referer', operation: 'set', value: 'https://x.com/' },
            ],
          },
        },
      ],
    });
    logger.info('declarativeNetRequest rule installed for upload.x.com');
  } catch (err) {
    logger.warn('failed to install DNR rule', err);
  }
}

export default defineBackground(() => {
  logger.info('background loaded');
  void installXUploadHeaderRewrite();

  onMessage(async (msg: Message) => {
    if (msg.type === 'LIST_CREDENTIALS') {
      const creds = await loadCredentials();
      return { type: 'LIST_CREDENTIALS_RESPONSE', payload: creds };
    }

    if (msg.type === 'AUTHENTICATE') {
      const { platformId, params } = msg.payload;
      try {
        const adapter = getAdapter(platformId);
        const creds = await adapter.authenticate(params);
        await addCredential(creds);
        const response: AuthenticateResponse = { success: true, credentials: creds };
        return response;
      } catch (err) {
        logger.warn('authenticate failed', { platformId, error: String(err) });
        const response: AuthenticateResponse = { success: false, error: String(err) };
        return response;
      }
    }

    if (msg.type === 'CROSSPOST_REQUEST') {
      const { content: serialized, accountIds } = msg.payload;
      // Deserialize media base64 -> real Blob before handing to adapters.
      const content: PostContent = {
        text: serialized.text,
        media: serialized.media ? deserializeMediaAttachments(serialized.media) : undefined,
      };
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
