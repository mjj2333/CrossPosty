import {
  loadSubstackTemplate,
  type SubstackNoteTemplate,
} from '../storage/substack-template';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

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

function permalinkFromResponse(templateUrl: string, json: CommentCreateResponse): string {
  // The user's publication base (everything up to /api/...).
  const apiIndex = templateUrl.indexOf('/api/');
  const base =
    apiIndex >= 0 ? templateUrl.slice(0, apiIndex) : 'https://substack.com';
  if (json.id) return `${base}/notes/note/c-${json.id}`;
  return `${base}/notes`;
}

export const substackAdapter: PlatformAdapter = {
  id: 'substack',
  displayName: 'Substack',
  characterLimit: 1000,
  mediaSupport: {
    maxImages: 0,
    maxVideoSeconds: 0,
    supportedMimeTypes: [],
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

    // Build the new body: keep all top-level fields from the captured
    // body (e.g. replyMinimumRole) and only replace bodyJson with our
    // freshly-generated document.
    const sourceBody =
      typeof template.bodyJson === 'object' && template.bodyJson !== null
        ? (template.bodyJson as Record<string, unknown>)
        : {};
    const newBody = { ...sourceBody, bodyJson: buildBodyJson(content.text) };
    const newBodyText = JSON.stringify(newBody);

    const headers = stripVolatile(template.headers);
    if (!hasHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }

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
      try {
        json = (await res.json()) as CommentCreateResponse;
      } catch {
        // Body wasn't JSON — still treat the 2xx as success.
      }
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
