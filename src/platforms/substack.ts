import {
  loadSubstackTemplate,
  type SubstackNoteTemplate,
} from '../storage/substack-template';
import type {
  AccountCredentials,
  MediaAttachment,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

const MAX_IMAGES = 4;

// Headers that get filled in by the browser per-request. Strip them out
// of the captured template so fetch fills in correct values for the
// replay rather than sending stale data.
const VOLATILE_HEADERS = new Set([
  'content-length',
  'host',
  'cookie', // browser attaches via credentials: 'include'
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

// Detects an active Substack login. Substack uses a single session cookie
// called `substack.sid`, set on the .substack.com root domain so it's
// shared across every user-publication subdomain.
async function readSessionCookie(): Promise<chrome.cookies.Cookie | null> {
  // substack.sid is the auth cookie at the apex domain.
  const c = await chrome.cookies.get({
    url: 'https://substack.com',
    name: 'substack.sid',
  });
  return c ?? null;
}

// Live auth probe. Cookie-existence alone isn't proof the session is good —
// Substack can invalidate server-side (logout-elsewhere, expiry) while the
// cookie still sits in Chrome's store. We hit a known auth-required endpoint
// and read the response:
//   200 JSON  -> live
//   401/403   -> invalidated server-side; treat as logged-out
//   other     -> network blip / endpoint moved; don't flip the user red on
//                this, let other signals (cookie presence + expiry) decide.
async function probeSubstackSession(): Promise<'live' | 'invalid' | 'unknown'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://substack.com/api/v1/subscriptions', {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (res.status === 200) {
      // Some Substack endpoints respond 200 with an HTML login page for
      // unauthenticated requests instead of a JSON 401. Require a JSON
      // content-type to count as actually-authenticated.
      const ct = res.headers.get('content-type') ?? '';
      return ct.toLowerCase().includes('json') ? 'live' : 'invalid';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

// Rebuild the Tiptap document for the cross-post. We replace the whole
// `bodyJson` rather than mutating the captured tree — paragraph-per-line
// split lets multi-line cross-posts render as multiple paragraphs.
function buildBodyJson(text: string): unknown {
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const content =
    paragraphs.length === 0
      ? [{ type: 'paragraph' }]
      : paragraphs.map((line) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        }));
  return {
    type: 'doc',
    attrs: { schemaVersion: 'v1', title: null },
    content,
  };
}

// Substack the comment-create response (status 200) gives us the new
// comment object including its id. We use that to construct a permalink
// when possible.
type CommentCreateResponse = {
  id?: number | string;
  // ...other fields we don't need
};

// Three-step Substack image flow (mirroring what the web client does):
//   1. POST /api/v1/image   with {image: "data:image/...;base64,..."}
//      -> {url: "https://substack-post-media.s3.amazonaws.com/..."}
//   2. POST /api/v1/comment/attachment with {url, type:"image"}
//      -> {id: "<uuid>", ...}
//   3. POST /api/v1/comment/feed with attachmentIds in the body
// Returns the attachment id (the uuid the server gave us in step 2).
async function uploadImageToSubstack(
  attachment: MediaAttachment,
  template: SubstackNoteTemplate,
  headers: Record<string, string>,
): Promise<string> {
  // FileReader isn't available in MV3 service workers, so we hand-roll
  // the data-URL build from the blob's bytes.
  const dataUrl = await blobToDataUrl(attachment.blob, attachment.mimeType);

  const imageEndpoint = withPath(template.url, '/api/v1/image');
  const upRes = await fetch(imageEndpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!upRes.ok) {
    const preview = await safePreview(upRes);
    throw new Error(`image upload HTTP ${upRes.status}: ${preview}`);
  }
  const upJson = (await upRes.json()) as { url?: string };
  if (!upJson.url) throw new Error('image upload returned no url');

  const attachEndpoint = withPath(template.url, '/api/v1/comment/attachment');
  const attRes = await fetch(attachEndpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ url: upJson.url, type: 'image' }),
  });
  if (!attRes.ok) {
    const preview = await safePreview(attRes);
    throw new Error(`attachment register HTTP ${attRes.status}: ${preview}`);
  }
  const attJson = (await attRes.json()) as { id?: string };
  if (!attJson.id) throw new Error('attachment register returned no id');
  return attJson.id;
}

// Substitute the path of a captured Substack URL while keeping the user's
// publication subdomain. This is how we reach the /image and
// /comment/attachment endpoints — each user's publication has its own
// subdomain (e.g. drice233.substack.com).
function withPath(originalUrl: string, newPath: string): string {
  const u = new URL(originalUrl);
  u.pathname = newPath;
  u.search = '';
  return u.toString();
}

async function safePreview(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '(no body)';
  }
}

async function blobToDataUrl(blob: Blob, mimeType: string): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunk to avoid String.fromCharCode argument-count limits on big images.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function permalinkFromResponse(templateUrl: string, json: CommentCreateResponse): string {
  // Substack notes live under the global substack.com namespace at
  //   https://substack.com/@<handle>/note/c-<id>
  // not on the publication subdomain (the publication subdomain serves a
  // 404 for /notes/note/...). Extract the handle from the captured
  // template's subdomain — drice233.substack.com -> drice233.
  const fallback = 'https://substack.com/notes';
  let handle: string | null = null;
  try {
    const host = new URL(templateUrl).host;
    const m = /^([^.]+)\.substack\.com$/.exec(host);
    if (m) handle = m[1] ?? null;
  } catch {
    // fall through to fallback
  }
  if (!json.id) return fallback;
  if (handle) return `https://substack.com/@${handle}/note/c-${json.id}`;
  return `${fallback}#c-${json.id}`;
}

export const substackAdapter: PlatformAdapter = {
  id: 'substack',
  displayName: 'Substack',
  characterLimit: 1000,
  mediaSupport: {
    maxImages: MAX_IMAGES,
    maxVideoSeconds: 0,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  },

  async authenticate(): Promise<AccountCredentials> {
    const c = await readSessionCookie();
    if (!c?.value) {
      throw new Error(
        'Substack session not found. Log in at substack.com in this browser first.',
      );
    }
    return {
      platformId: 'substack',
      accountId: crypto.randomUUID(),
      displayName: 'Substack session',
      data: { capturedAt: Date.now() } as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent): Promise<PostResult> {
    const template: SubstackNoteTemplate | null = await loadSubstackTemplate();
    if (!template) {
      return {
        success: false,
        error:
          'No Substack request template captured yet. Post a Note natively on your Substack publication once so CrossPosty can learn the request shape, then try again.',
        retryable: false,
      };
    }

    const headers = stripVolatile(template.headers);
    if (!hasHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }

    // Upload images sequentially. Substack's flow is: image upload -> register
    // as attachment -> then reference attachment IDs in the comment POST.
    // Sequential is safer than parallel: rate limits + we keep error
    // attribution simple (we know which image failed if one does).
    const images = (content.media ?? []).filter((m) =>
      m.mimeType.startsWith('image/'),
    );
    const limitedImages = images.slice(0, MAX_IMAGES);
    const attachmentIds: string[] = [];
    for (const m of limitedImages) {
      try {
        const id = await uploadImageToSubstack(m, template, headers);
        attachmentIds.push(id);
      } catch (err) {
        return {
          success: false,
          error: `Substack image upload failed: ${String(err).slice(0, 200)}`,
          retryable: true,
        };
      }
    }

    // Build the new body: keep all top-level fields from the captured
    // body (e.g. replyMinimumRole) and replace bodyJson + attachmentIds
    // with our values. When the user posts text-only natively but is now
    // cross-posting image-only, bodyJson goes to null.
    const sourceBody =
      typeof template.bodyJson === 'object' && template.bodyJson !== null
        ? (template.bodyJson as Record<string, unknown>)
        : {};
    const trimmed = content.text.trim();
    const newBody: Record<string, unknown> = {
      ...sourceBody,
      bodyJson: trimmed.length > 0 ? buildBodyJson(content.text) : null,
    };
    if (attachmentIds.length > 0) {
      newBody.attachmentIds = attachmentIds;
    } else {
      // Make sure we don't replay an attachmentIds field captured from a
      // previous image-bearing native post when our cross-post is text-only.
      delete newBody.attachmentIds;
    }
    const newBodyText = JSON.stringify(newBody);

    try {
      const res = await fetch(template.url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: newBodyText,
      });
      if (!res.ok) {
        let preview = '';
        try {
          preview = (await res.text()).slice(0, 200);
        } catch {
          preview = '(could not read body)';
        }
        return {
          success: false,
          error: `Substack HTTP ${res.status}: ${preview}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      let json: CommentCreateResponse = {};
      let rawBody = '';
      try {
        rawBody = await res.text();
        json = JSON.parse(rawBody) as CommentCreateResponse;
      } catch {
        // Body wasn't JSON — still treat the 2xx as success.
      }
      console.log('[CrossPosty] Substack comment/feed response', {
        bodyChars: rawBody.length,
        preview: rawBody.slice(0, 400),
        attachmentIdsUsed: attachmentIds,
      });
      return {
        success: true,
        url: permalinkFromResponse(template.url, json),
        remoteId: String(json.id ?? ''),
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(): Promise<boolean> {
    const c = await readSessionCookie();
    return Boolean(c?.value);
  },

  async getStatus() {
    const cookie = await readSessionCookie();
    if (!cookie?.value) {
      return {
        ok: false,
        severity: 'red',
        message: 'Not logged in to substack.com. Log in there, then return here.',
      };
    }
    const expiresAt = cookie.expirationDate;
    // Chrome can hold a cookie past its expirationDate before garbage-
    // collecting it. Treat that as logged-out.
    if (expiresAt && expiresAt * 1000 < Date.now()) {
      return {
        ok: false,
        severity: 'red',
        message: 'Substack session expired. Log in at substack.com.',
        expiresAt,
      };
    }
    // Cookie is present and not expired — but Substack may have invalidated
    // it server-side. Probe an auth-required endpoint to find out.
    const probe = await probeSubstackSession();
    if (probe === 'invalid') {
      return {
        ok: false,
        severity: 'red',
        message: 'Substack session invalidated server-side. Log in at substack.com.',
        expiresAt,
      };
    }
    const template = await loadSubstackTemplate();
    if (!template) {
      return {
        ok: false,
        severity: 'yellow',
        message:
          'No request template yet. Post one Note natively on your Substack publication to enable cross-posting.',
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
