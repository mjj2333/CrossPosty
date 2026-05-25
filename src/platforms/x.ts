import { debugLog } from '../lib/debug';
import { splitIntoChain } from '../lib/thread-split';
import {
  checkGuard,
  formatGuardError,
  pauseAccount,
  recordAttempt,
} from '../storage/platform-guard';
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

// Single source of truth for the X character limit. The adapter's
// `characterLimit` field below references it; the chain splitter
// uses it to decide chunk boundaries.
const X_CHAR_LIMIT = 280;

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

function mutateTweetText(
  bodyJson: unknown,
  text: string,
  newMediaIds: string[],
  inReplyToTweetId?: string,
): unknown {
  if (typeof bodyJson !== 'object' || bodyJson === null) return bodyJson;
  // Deep clone the template body so chained calls don't mutate each
  // other's state — the template object is shared across the chain.
  const root = JSON.parse(JSON.stringify(bodyJson)) as Record<string, unknown>;
  const variables = root.variables;
  if (typeof variables === 'object' && variables !== null) {
    const v = variables as Record<string, unknown>;
    v.tweet_text = text;
    // Posting fresh content - drop any reply/quote linkage from the template.
    delete v.reply;
    delete v.quote_tweet_id;
    // For chain continuations, re-attach a reply pointer to the prior
    // tweet so X threads them together visually.
    if (inReplyToTweetId) {
      v.reply = {
        in_reply_to_tweet_id: inReplyToTweetId,
        exclude_reply_user_ids: [],
      };
    }
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
  console.log('[CrossPosty] X INIT ok', { mediaId, bytes: blob.size, mimeType });

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
  console.log('[CrossPosty] X APPEND ok', { mediaId, status: appendRes.status });

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
  const finalizeJson = (await finalizeRes.json()) as {
    media_id_string?: string;
    processing_info?: {
      state?: string;
      check_after_secs?: number;
      progress_percent?: number;
      error?: { name?: string; message?: string };
    };
  };
  console.log('[CrossPosty] X FINALIZE ok', {
    mediaId,
    processing: finalizeJson.processing_info ?? null,
  });

  // If the media needs background processing, poll STATUS until done. For
  // static images this branch never fires; X typically returns processing_info
  // null on FINALIZE. For larger images / GIFs / videos we have to wait.
  if (finalizeJson.processing_info) {
    await waitForXMediaProcessing(mediaId, finalizeJson.processing_info, commonHeaders, baseUrl);
  }

  return mediaId;
}

async function waitForXMediaProcessing(
  mediaId: string,
  initial: { state?: string; check_after_secs?: number; error?: { message?: string } },
  commonHeaders: Record<string, string>,
  baseUrl: string,
): Promise<void> {
  let current = initial;
  const maxWaitMs = 60_000;
  const startedAt = Date.now();
  while (current.state && current.state !== 'succeeded') {
    if (current.state === 'failed') {
      throw new Error(`X media processing failed: ${current.error?.message ?? 'unknown'}`);
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error('X media processing timed out');
    }
    const wait = Math.max(1, current.check_after_secs ?? 1) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    const statusUrl = `${baseUrl}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
    const res = await fetch(statusUrl, {
      method: 'GET',
      credentials: 'include',
      headers: commonHeaders,
    });
    if (!res.ok) throw new Error(`X media STATUS failed (HTTP ${res.status})`);
    const json = (await res.json()) as {
      processing_info?: typeof initial;
    };
    current = json.processing_info ?? { state: 'succeeded' };
    console.log('[CrossPosty] X STATUS poll', { mediaId, state: current.state });
  }
}

async function readCookie(name: string): Promise<string | null> {
  const c = await chrome.cookies.get({ url: 'https://x.com', name });
  return c?.value ?? null;
}

// X occasionally returns HTTP 200 with an `errors` array instead of a real
// tweet result (content policy, duplicate, soft rate-limit, etc.). Pull out
// the first human-readable message if one is present.
function extractXErrorMessage(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as { errors?: unknown };
  if (!Array.isArray(root.errors) || root.errors.length === 0) return null;
  const first = root.errors[0] as { message?: unknown; code?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  const message = typeof first.message === 'string' ? first.message : null;
  const code = first.code;
  if (message && code !== undefined) return `${message} (code ${String(code)})`;
  return message ?? `errors[0] code=${String(code)}`;
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
  characterLimit: X_CHAR_LIMIT,
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
    // Refuse early if this account is rate-limited or paused after a
    // recent automation flag (X code 226). Same rationale as Threads
    // guard: hammering a flagged account is how it escalates to a
    // permanent suspension.
    const guard = await checkGuard('x', _credentials.accountId);
    if (!guard.ok) {
      return {
        success: false,
        error: formatGuardError('x', guard),
        retryable: false,
      };
    }
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

    const headers: Record<string, string> = {
      ...stripVolatile(template.headers),
      'content-type': 'application/json',
      'x-csrf-token': ct0,
    };

    // Chain long posts. Single-post case yields a one-element array
    // and behaves exactly as before. Images attach to the head tweet
    // only — typical thread shape (image on the hook, text replies
    // after).
    const chunks = splitIntoChain(content.text, X_CHAR_LIMIT);
    const cred = _credentials.data as unknown as XSessionData;
    const screen = cred.screenName ?? 'i';

    // Record ONCE per chain (not per chunk). Treat the whole thread
    // as one user-intent post for rate-limit purposes; the per-chunk
    // pacing handles burst-detection separately.
    await recordAttempt(_credentials.accountId);

    let firstRestId: string | undefined;
    let prevTweetId: string | undefined;
    let chainError: { message: string; afterChunk: number } | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i] ?? '';
      const mediaForThisChunk = i === 0 ? newMediaIds : [];
      const body = mutateTweetText(template.bodyJson, chunkText, mediaForThisChunk, prevTweetId);

      try {
        const bodyForLog = body as { variables?: Record<string, unknown> } | null;
        const v = bodyForLog?.variables ?? {};
        debugLog('[CrossPosty] X CreateTweet body', {
          chunk: `${i + 1}/${chunks.length}`,
          tweet_text: (v as { tweet_text?: string }).tweet_text,
          inReplyTo: prevTweetId,
        });
      } catch {
        // never block on logging
      }

      // Pace between chain chunks: bursting the API is exactly the
      // signal X's anti-automation looks for. 2s spread per chunk is
      // a cheap-enough delay that users barely notice but breaks the
      // burst pattern.
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      let res: Response;
      try {
        res = await fetch(template.url, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        chainError = { message: String(err), afterChunk: i };
        break;
      }
      if (!res.ok) {
        chainError = { message: `HTTP ${res.status}`, afterChunk: i };
        break;
      }
      const json = (await res.json()) as unknown;

      const errorMessage = extractXErrorMessage(json);
      if (errorMessage) {
        console.warn('[CrossPosty] X CreateTweet 2xx but errors[] present', {
          chunk: `${i + 1}/${chunks.length}`,
          errorMessage,
        });
        if (/\bcode\s+226\b/.test(errorMessage) || /automated/i.test(errorMessage)) {
          await pauseAccount(_credentials.accountId, {
            reason: `X anti-automation: ${errorMessage.slice(0, 150)}`,
          });
          chainError = {
            message: 'X flagged this request as automated and paused the account for 24h. Browse / post natively on x.com, then unpause from the popup.',
            afterChunk: i,
          };
          break;
        }
        // Code 344 = "daily Tweet limit reached." Healthy accounts get
        // thousands/day; flagged accounts get cut to single digits.
        // Pause locally for 24h so we don't keep poking the cap on
        // every attempt. The pause aligns with the cap's natural reset.
        if (/\bcode\s+344\b/.test(errorMessage) || /daily limit/i.test(errorMessage)) {
          await pauseAccount(_credentials.accountId, {
            reason: `X daily limit: ${errorMessage.slice(0, 150)}`,
          });
          chainError = {
            message: 'X says this account hit its daily post limit and paused for 24h. Note: limits are quietly lowered for accounts X considers risky — if this trips again immediately tomorrow, browse natively for a few days to rebuild trust.',
            afterChunk: i,
          };
          break;
        }
        chainError = { message: `X rejected: ${errorMessage}`, afterChunk: i };
        break;
      }

      const restId = extractTweetId(json);
      if (!restId) {
        let preview = '';
        try {
          preview = JSON.stringify(json).slice(0, 500);
        } catch {
          preview = '(unserializable)';
        }
        console.warn('[CrossPosty] X post 2xx but no rest_id extracted', {
          chunk: `${i + 1}/${chunks.length}`,
          preview,
        });
      }
      if (i === 0) firstRestId = restId;
      prevTweetId = restId;
    }

    if (chainError && chainError.afterChunk === 0) {
      // Nothing posted — surface the error like a normal failure.
      return { success: false, error: chainError.message, retryable: false };
    }

    const firstUrl = firstRestId
      ? `https://x.com/${screen}/status/${firstRestId}`
      : 'https://x.com/';
    if (chainError) {
      // Partial chain: head tweet is up, later chunks failed. Return
      // success so the user sees a link to what landed, but log the
      // partial detail for visibility.
      console.warn('[CrossPosty] X chain partial', {
        posted: chainError.afterChunk,
        of: chunks.length,
        error: chainError.message,
      });
    }
    return {
      success: true,
      url: firstUrl,
      remoteId: firstRestId ?? '',
    };
  },

  async validateCredentials(credentials): Promise<boolean> {
    const data = credentials.data as unknown as XSessionData;
    return Boolean(data.authToken && data.ct0);
  },

  // Pre-flight status reflects two independent pieces:
  //   - whether the user is still logged in to x.com (auth_token + ct0 cookies)
  //   - whether we have a fresh template captured from a native compose
  // Cross-posting needs both. Yellow = "you can fix this by posting once".
  async getStatus(_credentials) {
    const cookies = await chrome.cookies.getAll({ domain: 'x.com' });
    const authCookie = cookies.find((c) => c.name === 'auth_token');
    const hasCt0 = cookies.some((c) => c.name === 'ct0');
    if (!authCookie || !hasCt0) {
      return {
        ok: false,
        severity: 'red',
        message: 'Not logged in to x.com. Log in there, then return here.',
      };
    }
    const expiresAt = authCookie.expirationDate;
    // Surface a paused account in the popup so the user sees why
    // posts aren't going through and how long until auto-unpause.
    if (_credentials) {
      const guard = await checkGuard('x', _credentials.accountId);
      if (!guard.ok && guard.reason === 'paused') {
        const hours = Math.max(1, Math.ceil((guard.pausedUntil - Date.now()) / 3_600_000));
        return {
          ok: false,
          severity: 'red',
          message: `Paused after X flagged us as automated. Auto-unpauses in ${hours}h, or clear from popup after browsing x.com natively.`,
          expiresAt,
        };
      }
    }
    const template = await loadXTemplate();
    if (!template) {
      return {
        ok: false,
        severity: 'yellow',
        message: 'No request template yet. Post one tweet natively on x.com to enable cross-posting.',
        expiresAt,
      };
    }
    const ageDays = (Date.now() - template.capturedAt) / 86_400_000;
    if (ageDays > 7) {
      return {
        ok: true,
        severity: 'yellow',
        message: `Template ${Math.floor(ageDays)} days old. Post natively to refresh.`,
        expiresAt,
      };
    }
    const ageHours = (Date.now() - template.capturedAt) / 3_600_000;
    const ageLabel =
      ageHours < 1
        ? 'just now'
        : ageHours < 24
          ? `${Math.floor(ageHours)}h ago`
          : `${Math.floor(ageDays)}d ago`;
    return {
      ok: true,
      severity: 'green',
      message: `Logged in. Template captured ${ageLabel}.`,
      expiresAt,
    };
  },
};
