import { loadXTemplate, type XCreateTweetTemplate } from '../storage/x-template';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

type XSessionData = {
  authToken: string;
  ct0: string;
  screenName?: string;
};

// Headers we strip from the template — these are computed per-request and X
// either auto-generates them or doesn't care. Keeping them stale causes 4xx.
const VOLATILE_HEADERS = new Set([
  'x-csrf-token', // rotates per session; we substitute from current ct0 cookie
  'x-client-transaction-id', // per-request signed value; safer to drop than send stale
  'content-length', // fetch computes this
  'host',
  'cookie', // browser attaches automatically via credentials: 'include'
]);

function stripVolatile(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!VOLATILE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function mutateTweetText(bodyJson: unknown, text: string): unknown {
  if (typeof bodyJson !== 'object' || bodyJson === null) return bodyJson;
  const root = bodyJson as Record<string, unknown>;
  const variables = root.variables;
  if (typeof variables === 'object' && variables !== null) {
    const v = variables as Record<string, unknown>;
    v.tweet_text = text;
    // Posting fresh content — drop any reply/quote linkage from the template.
    delete v.reply;
    delete v.quote_tweet_id;
    // Drop captured media references; Phase 1 X-as-destination is text-only.
    if (typeof v.media === 'object' && v.media !== null) {
      (v.media as Record<string, unknown>).media_entities = [];
    }
  }
  return root;
}

async function readCookie(name: string): Promise<string | null> {
  const c = await chrome.cookies.get({ url: 'https://x.com', name });
  return c?.value ?? null;
}

export const xAdapter: PlatformAdapter = {
  id: 'x',
  displayName: 'X',
  characterLimit: 280,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 140,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
  },

  async authenticate(): Promise<AccountCredentials> {
    const authToken = await readCookie('auth_token');
    const ct0 = await readCookie('ct0');
    if (!authToken || !ct0) {
      throw new Error('X session cookies not found. Log in to x.com first.');
    }
    return {
      platformId: 'x',
      accountId: crypto.randomUUID(),
      displayName: 'X session',
      data: { authToken, ct0 } as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, _credentials: AccountCredentials): Promise<PostResult> {
    const template: XCreateTweetTemplate | null = await loadXTemplate();
    if (!template) {
      return {
        success: false,
        error:
          'No X request template captured yet. Post natively on x.com once so CrossPosty can learn the current request shape, then try again.',
        retryable: false,
      };
    }

    const ct0 = await readCookie('ct0');
    if (!ct0) {
      return {
        success: false,
        error: 'X session expired. Log in to x.com and retry.',
        retryable: false,
      };
    }

    const body = mutateTweetText(template.bodyJson, content.text);
    const headers: Record<string, string> = {
      ...stripVolatile(template.headers),
      'content-type': 'application/json',
      'x-csrf-token': ct0,
    };

    try {
      const res = await fetch(template.url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return {
          success: false,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      const json = (await res.json()) as {
        data?: {
          create_tweet?: { tweet_results?: { result?: { rest_id?: string } } };
        };
      };
      const restId = json.data?.create_tweet?.tweet_results?.result?.rest_id ?? '';
      const cred = _credentials.data as unknown as XSessionData;
      const screen = cred.screenName ?? 'i';
      return {
        success: true,
        url: restId ? `https://x.com/${screen}/status/${restId}` : 'https://x.com/',
        remoteId: restId,
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    const data = credentials.data as unknown as XSessionData;
    return Boolean(data.authToken && data.ct0);
  },
};
