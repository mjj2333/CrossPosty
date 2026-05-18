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

// Headers we strip from the template - these are computed per-request and X
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

function mutateTweetText(bodyJson: unknown, text: string, newMediaIds: string[]): unknown {
  if (typeof bodyJson !== 'object' || bodyJson === null) return bodyJson;
  const root = bodyJson as Record<string, unknown>;
  const variables = root.variables;
  if (typeof variables === 'object' && variables !== null) {
    const v = variables as Record<string, unknown>;
    v.tweet_text = text;
    // Posting fresh content - drop any reply/quote linkage from the template.
    delete v.reply;
    delete v.quote_tweet_id;
    // Replace captured media references with the fresh IDs we just uploaded
    // (or clear entirely if no media).
    if (newMediaIds.length > 0) {
      const mediaContainer =
        typeof v.media === 'object' && v.media !== null
          ? (v.media as Record<string, unknown>)
          : {};
      mediaContainer.media_entities = newMediaIds.map((id) => ({
        media_id: id,
        tagged_users: [],
      }));
      mediaContainer.possibly_sensitive = false;
      v.media = mediaContainer;
    } else if (typeof v.media === 'object' && v.media !== null) {
      (v.media as Record<string, unknown>).media_entities = [];
    }
  }
  return root;
}

// Uploads one media blob to X using their INIT/APPEND/FINALIZE chunked
// protocol. Returns the new media_id_string we can reference in CreateTweet.
async function uploadXMedia(
  blob: Blob,
  mimeType: string,
  templateHeaders: Record<string, string>,
  ct0: string,
): Promise<string> {
  // X's web client uses upload.x.com (the legacy upload.twitter.com host is
  // getting gated for many accounts and returns 403). We match the host the
  // user's own browser uses to match the same anti-bot signals.
  const baseUrl = 'https://upload.x.com/i/media/upload.json';
  const authHeader =
    templateHeaders.authorization ?? templateHeaders.Authorization ?? '';
  const commonHeaders: Record<string, string> = {
    authorization: authHeader,
    'x-csrf-token': ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
  };

  async function describeFailure(res: Response, step: string): Promise<string> {
    let bodyPreview = '';
    try {
      bodyPreview = (await res.text()).slice(0, 200);
    } catch {
      bodyPreview = '(could not read body)';
    }
    return `X media ${step} failed (HTTP ${res.status}): ${bodyPreview}`;
  }

  // INIT
  const initParams = new URLSearchParams({
    command: 'INIT',
    total_bytes: String(blob.size),
    media_type: mimeType,
    media_category: mimeType.startsWith('video/') ? 'tweet_video' : 'tweet_image',
  });
  const initRes = await fetch(`${baseUrl}?${initParams.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: commonHeaders,
  });
  if (!initRes.ok) {
    throw new Error(await describeFailure(initRes, 'INIT'));
  }
  const initJson = (await initRes.json()) as { media_id_string?: string };
  if (!initJson.media_id_string) {
    throw new Error('X media INIT returned no media_id_string');
  }
  const mediaId = initJson.media_id_string;

  // APPEND - single segment for v1 (sufficient for typical images).
  const appendForm = new FormData();
  appendForm.append('command', 'APPEND');
  appendForm.append('media_id', mediaId);
  appendForm.append('segment_index', '0');
  appendForm.append('media', blob);
  const appendRes = await fetch(baseUrl, {
    method: 'POST',
    credentials: 'include',
    // Don't set content-type - fetch fills in the multipart boundary.
    headers: commonHeaders,
    body: appendForm,
  });
  if (!appendRes.ok) {
    throw new Error(await describeFailure(appendRes, 'APPEND'));
  }

  // FINALIZE
  const finalizeParams = new URLSearchParams({
    command: 'FINALIZE',
    media_id: mediaId,
  });
  const finalizeRes = await fetch(`${baseUrl}?${finalizeParams.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: commonHeaders,
  });
  if (!finalizeRes.ok) {
    throw new Error(await describeFailure(finalizeRes, 'FINALIZE'));
  }
  return mediaId;
}

async function readCookie(name: string): Promise<string | null> {
  const c = await chrome.cookies.get({ url: 'https://x.com', name });
  return c?.value ?? null;
}

// X's CreateTweet response shape has shifted over time and contains the
// tweet ID at several possible paths. Walk known locations + a generic
// deep-scan for any "rest_id"/"id_str" near a result/legacy object so we
// don't break on minor shape changes.
function extractTweetId(json: unknown): string {
  const knownPaths: Array<(j: any) => unknown> = [
    (j) => j?.data?.create_tweet?.tweet_results?.result?.rest_id,
    (j) => j?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str,
    (j) => j?.data?.create_tweet?.tweet_results?.result?.tweet?.rest_id,
    (j) => j?.data?.tweet_results?.result?.rest_id,
    (j) => j?.create_tweet?.tweet_results?.result?.rest_id,
  ];
  for (const get of knownPaths) {
    const v = get(json);
    if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  }
  // Generic fallback: walk the object looking for the first numeric string
  // that matches rest_id or id_str.
  const seen = new WeakSet<object>();
  function walk(node: unknown): string | null {
    if (typeof node !== 'object' || node === null) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'rest_id' || k === 'id_str') && typeof v === 'string' && /^\d{8,}$/.test(v)) {
        return v;
      }
    }
    for (const v of Object.values(obj)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  }
  return walk(json) ?? '';
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

    // Upload any attached images to X first. X allows max 4 per tweet.
    const newMediaIds: string[] = [];
    const imageMedia = (content.media ?? []).filter((m) =>
      m.mimeType.startsWith('image/'),
    );
    try {
      for (const m of imageMedia.slice(0, 4)) {
        const id = await uploadXMedia(m.blob, m.mimeType, template.headers, ct0);
        newMediaIds.push(id);
      }
    } catch (err) {
      return {
        success: false,
        error: `Media upload to X failed: ${String(err)}`,
        retryable: true,
      };
    }

    const body = mutateTweetText(template.bodyJson, content.text, newMediaIds);
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
      const json = (await res.json()) as unknown;
      const restId = extractTweetId(json);
      if (!restId) {
        // 2xx but we couldn't find an ID - could mean the response shape
        // changed, or the post was rejected with a soft error. Log the
        // top-level shape (not contents) so we can fix the extractor.
        console.warn('[CrossPosty] X post 2xx but no rest_id extracted', {
          topLevelKeys: typeof json === 'object' && json !== null ? Object.keys(json) : null,
        });
      }
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
