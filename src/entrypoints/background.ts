import { logger } from '../lib/logger';
import { deserializeMediaAttachments } from '../lib/media-transport';
import type {
  AccountStatusEntry,
  AuthenticateResponse,
  CrossPostResultEntry,
  Message,
} from '../lib/messaging';
import { onMessage } from '../lib/messaging';
import { getAdapter } from '../platforms';
import type { AccountStatus, PostContent, PostResult } from '../platforms/types';
import { addCredential, loadCredentials } from '../storage/credentials';

const X_UPLOAD_DNR_RULE_ID = 1;
const THREADS_DNR_RULE_ID = 2;

async function installThreadsHeaderRewrite(): Promise<void> {
  // Same rationale as the X upload rewrite: when we replay Threads' compose
  // request from the background service worker, Chrome sends
  // `Origin: chrome-extension://<id>` and threads.com's edge serves the
  // marketing 404 page instead of routing to the API. Rewriting Origin and
  // Referer to threads.com makes the request look like a normal web-client
  // call. Cookies are attached automatically via credentials: 'include'.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [THREADS_DNR_RULE_ID],
      addRules: [
        {
          id: THREADS_DNR_RULE_ID,
          priority: 1,
          condition: {
            requestDomains: ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net', 'i.instagram.com'],
            resourceTypes: ['xmlhttprequest'],
          },
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'origin', operation: 'set', value: 'https://www.threads.com' },
              { header: 'referer', operation: 'set', value: 'https://www.threads.com/' },
            ],
          },
        },
      ],
    });
    logger.info('declarativeNetRequest rule installed for threads.com');
  } catch (err) {
    logger.warn('failed to install Threads DNR rule', err);
  }
}

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
  void installThreadsHeaderRewrite();

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

    if (msg.type === 'GET_ACCOUNT_STATUSES') {
      const creds = await loadCredentials();
      // Each adapter gets its own timeout. Without this, a single hung
      // network call (e.g. an unreachable PDS for a BSky OAuth account)
      // blocks the entire Promise.all and the popup spins forever.
      const STATUS_TIMEOUT_MS = 10_000;
      const entries = await Promise.all(
        creds.map(async (cred): Promise<AccountStatusEntry> => {
          const runStatus = async (): Promise<AccountStatus> => {
            const adapter = getAdapter(cred.platformId);
            if (adapter.getStatus) return adapter.getStatus(cred);
            const ok = await adapter.validateCredentials(cred);
            return { ok, severity: ok ? 'green' : 'red' };
          };
          try {
            const status = await Promise.race([
              runStatus(),
              new Promise<AccountStatus>((_resolve, reject) =>
                setTimeout(() => reject(new Error('status check timed out')), STATUS_TIMEOUT_MS),
              ),
            ]);
            return { accountId: cred.accountId, status };
          } catch (err) {
            logger.warn('status check failed', {
              platformId: cred.platformId,
              error: String(err),
            });
            return {
              accountId: cred.accountId,
              status: {
                ok: false,
                severity: 'red',
                message: String(err).slice(0, 200),
              },
            };
          }
        }),
      );
      return { type: 'GET_ACCOUNT_STATUSES_RESPONSE', payload: entries };
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
