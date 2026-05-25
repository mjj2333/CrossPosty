import {
  checkGuard,
  formatGuardError,
  pauseAccount,
  recordAttempt,
} from '../storage/platform-guard';
import {
  loadThreadsTemplate,
  loadThreadsTemplates,
  type ThreadsCreatePostTemplate,
} from '../storage/threads-template';
import type {
  AccountCredentials,
  MediaAttachment,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

const MAX_IMAGES = 1;

// Meta moved Threads from threads.net to threads.com in 2024; new users
// see threads.com. We accept either as evidence of a logged-in session.
async function readSessionCookie(): Promise<{ value: string } | null> {
  for (const url of ['https://www.threads.com', 'https://www.threads.net']) {
    const c = await chrome.cookies.get({ url, name: 'sessionid' });
    if (c?.value) return { value: c.value };
  }
  return null;
}

// Threads checks `x-csrftoken` header against the `csrftoken` cookie at
// request time. The captured template's CSRF header rotates whenever
// Meta cycles the cookie (every few hours/days). Rather than force a
// re-capture, read the current cookie and override the header right
// before we replay.
// Detects Meta's anti-automation checkpoint response. Threads/Instagram
// return a JSON body like:
//   {"message":"checkpoint_required","checkpoint_url":"https://...","lock":true,...}
// The URL leads to a human-verification flow on instagram.com. Parsing
// it out lets us open it for the user rather than dumping raw JSON at
// them.
function tryParseCheckpoint(body: string): { url: string } | null {
  try {
    const json = JSON.parse(body) as {
      message?: string;
      checkpoint_url?: string;
    };
    if (json.message === 'checkpoint_required' && typeof json.checkpoint_url === 'string') {
      return { url: json.checkpoint_url };
    }
  } catch {
    // not JSON; fall through
  }
  return null;
}

// 1x1 transparent PNG as a data URL — chrome.notifications.create
// requires iconUrl for type='basic'. We don't ship a real icon asset
// yet, so use this placeholder. The notification text is what matters.
const NOTIF_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function openCheckpoint(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (err) {
    console.warn('[CrossPosty] failed to open checkpoint tab', err);
  }
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: NOTIF_ICON,
      title: 'CrossPosty: Threads needs verification',
      message:
        "Meta is asking you to verify the account. Opened the checkpoint page — tap through it, then try the cross-post again.",
    });
  } catch (err) {
    console.warn('[CrossPosty] failed to fire checkpoint notification', err);
  }
}

async function readCsrfCookie(): Promise<string | null> {
  for (const url of ['https://www.threads.com', 'https://www.threads.net']) {
    const c = await chrome.cookies.get({ url, name: 'csrftoken' });
    if (c?.value) return c.value;
  }
  return null;
}

type ThreadsSessionData = {
  // We don't introspect specific cookies — we just verify the user has a
  // logged-in threads.net session via the captured template's cookies.
  // chrome.cookies.get on the relevant host returns these at post time.
  capturedAt: number;
};

// Headers that are browser-controlled. Strip these before replaying —
// fetch will fill in the right values. NOTE: we used to also strip
// x-fb-lsd / x-ig-www-claim / x-asbd-id as "rotating tokens", but in
// practice Meta's API rejects (404 → marketing page) without them.
// The captured values are session-bound and valid for the lifetime of
// the user's threads.com login, which is fine — re-capture if a session
// rotates out.
const VOLATILE_HEADERS = new Set([
  'content-length',
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const needle = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === needle);
}

// Replace the original tweet/post text in the template body with our new
// content. We try common shapes: JSON with a known text-key, then
// urlencoded form. If neither matches we return the original body
// unchanged and warn — the user can prime the template again.
function mutatePostText(body: string, newText: string, contentType: string): string {
  // JSON
  if (contentType === 'json') {
    try {
      const json = JSON.parse(body) as unknown;
      mutateJsonText(json, newText);
      return JSON.stringify(json);
    } catch {
      return body;
    }
  }
  // URL-encoded form — also tried for 'unknown' since older captures may
  // lack a content-type label even though the body is form-encoded.
  if (contentType === 'urlencoded' || contentType === 'unknown') {
    try {
      const params = new URLSearchParams(body);
      for (const key of TEXT_KEYS) {
        if (params.has(key)) {
          params.set(key, newText);
          return params.toString();
        }
      }
      // GraphQL variables often nested in form-encoded `variables=<json>`.
      // Replace the first JSON-shaped value that contains a text field.
      if (params.has('variables')) {
        const raw = params.get('variables');
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (mutateJsonText(parsed, newText)) {
              params.set('variables', JSON.stringify(parsed));
              return params.toString();
            }
          } catch {
            // not JSON in variables; fall through
          }
        }
      }
    } catch {
      // not URL-encodable; fall through
    }
  }
  return body;
}

const TEXT_KEYS = new Set([
  'caption',
  'text',
  'post_text',
  'content',
  'text_post',
  'composer_text',
]);

// Threads chunked image upload, mirroring what the web client does:
//   POST https://www.threads.com/rupload_igphoto/fb_uploader_<upload_id>
//   body: raw image bytes
//   headers: x-entity-* + x-instagram-rupload-params (JSON with dims)
// Returns the upload_id we generated — that same id is then attached as
// `upload_id` on the configure POST so the server pairs the two together.
async function uploadImageToThreads(
  attachment: MediaAttachment,
  baseHeaders: Record<string, string>,
): Promise<string> {
  const uploadId = String(Date.now());
  const { width, height } = await getImageDimensions(attachment.blob);
  const ruploadParams = JSON.stringify({
    is_sidecar: '0',
    is_threads: '1',
    media_type: 1,
    upload_id: uploadId,
    upload_media_height: height,
    upload_media_width: width,
  });

  // Reuse the template's session headers (cookies, x-ig-app-id, x-csrftoken,
  // user-agent, etc.) but swap the body content-type and add the
  // upload-specific x-entity-* / x-instagram-rupload-params headers.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseHeaders)) {
    if (k.toLowerCase() === 'content-type') continue;
    headers[k] = v;
  }
  headers['content-type'] = attachment.mimeType;
  headers['x-entity-length'] = String(attachment.blob.size);
  headers['x-entity-name'] = `fb_uploader_${uploadId}`;
  headers['x-entity-type'] = attachment.mimeType;
  headers['x-instagram-rupload-params'] = ruploadParams;
  headers['offset'] = '0';

  const url = `https://www.threads.com/rupload_igphoto/fb_uploader_${uploadId}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: attachment.blob,
  });
  if (!res.ok) {
    const preview = await safePreview(res);
    throw new Error(`image upload HTTP ${res.status}: ${preview}`);
  }
  return uploadId;
}

// createImageBitmap is available in MV3 service workers (Chrome). Falls
// back to 1x1 if decode fails — Threads still seems to accept the upload
// in that case, but a real value is preferred so the image isn't
// downscaled to nothing.
async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return { width: 1, height: 1 };
  }
}

async function safePreview(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '(no body)';
  }
}

// Once we've uploaded the image and have an upload_id, inject it onto the
// configure body so the configure POST attaches the freshly-uploaded
// media. The captured template body may or may not already contain an
// upload_id (depends on whether the native capture was text-only or
// text+image) — set unconditionally so we end up with our id either way.
function addUploadIdToBody(body: string, uploadId: string, contentType: string): string {
  if (contentType === 'json') {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      json.upload_id = uploadId;
      return JSON.stringify(json);
    } catch {
      return body;
    }
  }
  try {
    const params = new URLSearchParams(body);
    params.set('upload_id', uploadId);
    return params.toString();
  } catch {
    return body;
  }
}

function mutateJsonText(node: unknown, newText: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (mutateJsonText(item, newText, depth + 1)) return true;
    }
    return false;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && TEXT_KEYS.has(k.toLowerCase())) {
      obj[k] = newText;
      return true;
    }
  }
  for (const v of Object.values(obj)) {
    if (mutateJsonText(v, newText, depth + 1)) return true;
  }
  return false;
}

export const threadsAdapter: PlatformAdapter = {
  id: 'threads',
  displayName: 'Threads',
  characterLimit: 500,
  mediaSupport: {
    maxImages: MAX_IMAGES,
    maxVideoSeconds: 0,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  },

  async authenticate(): Promise<AccountCredentials> {
    // Threads uses a Meta session cookie. We don't need to inspect specific
    // cookies — the user has either logged in to threads.net or hasn't.
    // The browser's session cookies travel with our fetch via
    // credentials: 'include' at post time.
    const session = await readSessionCookie();
    if (!session?.value) {
      throw new Error(
        'Threads session not found. Log in to threads.net in this browser first.',
      );
    }
    const data: ThreadsSessionData = { capturedAt: Date.now() };
    return {
      platformId: 'threads',
      accountId: crypto.randomUUID(),
      displayName: 'Threads session',
      data: data as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    // Refuse early if the account is rate-limited or paused after a
    // recent checkpoint. Meta permabans accounts that look automated;
    // these guards exist to make sure our extension can't be the thing
    // that pushes the user over the line.
    const guard = await checkGuard('threads', credentials.accountId);
    if (!guard.ok) {
      return {
        success: false,
        error: formatGuardError('threads', guard),
        retryable: false,
      };
    }
    // Pick the right captured template up front: text-only vs image
    // endpoint take genuinely different body shapes. We need the
    // matching capture or the request 400/404s.
    const willHaveImages = (content.media ?? []).some((m) =>
      m.mimeType.startsWith('image/'),
    );
    const slot = willHaveImages ? 'withMedia' : 'textOnly';
    const template: ThreadsCreatePostTemplate | null = await loadThreadsTemplate(slot);
    if (!template) {
      const hint = willHaveImages
        ? 'Post a text + image Note natively on threads.com once so CrossPosty can learn the image-bearing request shape, then try again.'
        : 'Post a text-only Note natively on threads.com once so CrossPosty can learn the text-only request shape, then try again.';
      return {
        success: false,
        error: `No matching Threads template captured yet. ${hint}`,
        retryable: false,
      };
    }

    const headers = stripVolatile(template.headers);
    // Refresh the CSRF header from the live cookie. Meta rotates this
    // every few hours; without the refresh, replays past the rotation
    // window return "CSRF token missing or incorrect" 403. Carefully
    // remove ALL case-variants of the header before writing the fresh
    // one so we don't double up — the captured template might use any
    // of x-csrftoken / X-CSRFToken / X-Csrftoken.
    const csrf = await readCsrfCookie();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-csrftoken') delete headers[k];
    }
    if (csrf) {
      headers['x-csrftoken'] = csrf;
      console.log('[CrossPosty] Threads CSRF refreshed from cookie', { len: csrf.length });
    } else {
      console.warn('[CrossPosty] Threads csrftoken cookie missing — request likely to fail. Are you logged in to threads.com?');
    }

    // Upload images first — Threads' flow is upload -> configure with
    // upload_id. Sequential keeps error attribution clean (we'd know
    // which image failed) and v1 caps at a single image anyway, which
    // is all the current configure-body template can pair with.
    const images = (content.media ?? []).filter((m) =>
      m.mimeType.startsWith('image/'),
    );
    const limitedImages = images.slice(0, MAX_IMAGES);
    const uploadIds: string[] = [];
    for (const m of limitedImages) {
      try {
        const id = await uploadImageToThreads(m, headers);
        uploadIds.push(id);
      } catch (err) {
        return {
          success: false,
          error: `Threads image upload failed: ${String(err).slice(0, 200)}`,
          retryable: true,
        };
      }
    }

    let newBody = mutatePostText(template.bodyText, content.text, template.contentType);
    if (newBody === template.bodyText) {
      console.warn(
        '[CrossPosty] Threads template body mutation found no text field — replaying captured body unchanged. Post may duplicate the previous template content.',
      );
    }
    const firstUploadId = uploadIds[0];
    if (firstUploadId) {
      newBody = addUploadIdToBody(newBody, firstUploadId, template.contentType);
    }
    // Template was selected up front for the matching endpoint (text-only
    // vs withMedia) — its URL is already correct for our content shape.
    const targetUrl = template.url;
    // The captured fetch headers won't include Content-Type when the page
    // passed a typed body (URLSearchParams, FormData) — the browser fills
    // that in automatically and it never lands in init.headers. When we
    // replay with a string body, fetch defaults to text/plain, which
    // Threads' edge rejects with the Instagram 404 page. Set the right
    // Content-Type based on our content-type classification.
    if (!hasHeader(headers, 'content-type')) {
      if (template.contentType === 'json') {
        headers['content-type'] = 'application/json';
      } else if (
        template.contentType === 'urlencoded' ||
        template.contentType === 'unknown'
      ) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }
    console.log('[CrossPosty] Threads adapter posting', {
      url: targetUrl,
      slot,
      contentType: template.contentType,
      headerKeys: Object.keys(headers).join(', '),
      bodyMutated: newBody !== template.bodyText,
      bodyChars: newBody.length,
      uploadIdsUsed: uploadIds,
    });

    // Record the attempt BEFORE the fetch — Meta sees the request
    // either way, so the rate counter must include attempts even when
    // they fail. Otherwise repeated failures (checkpoint loops) could
    // burn through Meta's tolerance without us throttling at all.
    await recordAttempt(credentials.accountId);

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: newBody,
      });
      console.log('[CrossPosty] Threads response', {
        status: res.status,
        ok: res.ok,
        finalUrl: res.url,
        contentType: res.headers.get('content-type'),
      });
      if (!res.ok) {
        let preview = '';
        try {
          preview = (await res.text()).slice(0, 500);
        } catch {
          preview = '(could not read body)';
        }
        console.warn('[CrossPosty] Threads error body', preview);
        // Meta's checkpoint_required response carries a checkpoint_url
        // the user has to clear manually. Open it for them + fire a
        // notification + pause this account locally for 24h so we don't
        // keep poking the lock and risk a permanent ban.
        const checkpoint = tryParseCheckpoint(preview);
        if (checkpoint) {
          await pauseAccount(credentials.accountId, {
            reason: 'Meta checkpoint_required',
            checkpointUrl: checkpoint.url,
          });
          await openCheckpoint(checkpoint.url);
          return {
            success: false,
            error:
              'Threads checkpoint — opened a tab for you to clear it, and paused this account for 24h to protect it from a permanent ban. Unpause from the popup after verifying.',
            retryable: false,
          };
        }
        return {
          success: false,
          error: `Threads HTTP ${res.status}: ${preview.slice(0, 200)}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      const responsePreview = await res.text();
      // We can't reliably extract a permalink from Meta's response without
      // knowing the exact shape. For v1 we return success with a profile-
      // level URL; the user can verify on threads.net.
      console.log('[CrossPosty] Threads post 2xx', {
        bodyChars: responsePreview.length,
        preview: responsePreview.slice(0, 200),
      });
      return {
        success: true,
        url: 'https://www.threads.net/',
        remoteId: '',
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(): Promise<boolean> {
    const session = await readSessionCookie();
    return Boolean(session?.value);
  },

  async getStatus(credentials) {
    // Find the sessionid cookie on either host so we can also surface
    // its expiration to the popup.
    let sessionCookie: chrome.cookies.Cookie | undefined;
    for (const url of ['https://www.threads.com', 'https://www.threads.net']) {
      const c = await chrome.cookies.get({ url, name: 'sessionid' });
      if (c?.value) {
        sessionCookie = c;
        break;
      }
    }
    if (!sessionCookie) {
      return {
        ok: false,
        severity: 'red',
        message: 'Not logged in to threads.com. Log in there, then return here.',
      };
    }
    const expiresAt = sessionCookie.expirationDate;
    // Surface a paused account in the popup so the user sees why posts
    // aren't going through and how long until auto-unpause.
    if (credentials) {
      const guard = await checkGuard('threads', credentials.accountId);
      if (!guard.ok && guard.reason === 'paused') {
        const hours = Math.max(1, Math.ceil((guard.pausedUntil - Date.now()) / 3_600_000));
        return {
          ok: false,
          severity: 'red',
          message: `Paused after Meta checkpoint. Auto-unpauses in ${hours}h, or clear from popup after verifying at ${guard.checkpointUrl ?? 'instagram.com'}.`,
          expiresAt,
        };
      }
    }
    const store = await loadThreadsTemplates();
    const template = store.textOnly ?? store.withMedia ?? null;
    if (!template) {
      return {
        ok: false,
        severity: 'yellow',
        message: 'No request template yet. Post once natively on threads.com to enable cross-posting.',
        expiresAt,
      };
    }
    if (!store.textOnly || !store.withMedia) {
      const missing = !store.textOnly ? 'text-only' : 'text + image';
      return {
        ok: true,
        severity: 'yellow',
        message: `Only one shape captured. Post a ${missing} Note natively to enable both cross-post modes.`,
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
