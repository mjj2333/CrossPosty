import {
  loadThreadsTemplate,
  type ThreadsCreatePostTemplate,
} from '../storage/threads-template';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

// Meta moved Threads from threads.net to threads.com in 2024; new users
// see threads.com. We accept either as evidence of a logged-in session.
async function readSessionCookie(): Promise<{ value: string } | null> {
  for (const url of ['https://www.threads.com', 'https://www.threads.net']) {
    const c = await chrome.cookies.get({ url, name: 'sessionid' });
    if (c?.value) return { value: c.value };
  }
  return null;
}

type ThreadsSessionData = {
  // We don't introspect specific cookies — we just verify the user has a
  // logged-in threads.net session via the captured template's cookies.
  // chrome.cookies.get on the relevant host returns these at post time.
  capturedAt: number;
};

// Headers that are per-request signed or browser-controlled. Strip these
// before replaying — fetch will fill in the right values.
const VOLATILE_HEADERS = new Set([
  'content-length',
  'host',
  'cookie', // browser attaches automatically via credentials: 'include'
  'x-asbd-id', // per-request anti-bot signed ID
  'x-ig-www-claim', // session-bound claim string
  'x-fb-lsd', // lsd token, rotates
]);

function stripVolatile(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!VOLATILE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
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
  // URL-encoded form
  if (contentType === 'urlencoded') {
    try {
      const params = new URLSearchParams(body);
      for (const key of TEXT_KEYS) {
        if (params.has(key)) {
          params.set(key, newText);
          return params.toString();
        }
      }
    } catch {
      return body;
    }
  }
  // GraphQL variables often nested in form-encoded `variables=<json>`
  // We try replacing the first JSON-shaped value that contains a text field.
  if (contentType === 'urlencoded' || contentType === 'unknown') {
    const params = new URLSearchParams(body);
    if (params.has('variables')) {
      try {
        const raw = params.get('variables');
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (mutateJsonText(parsed, newText)) {
            params.set('variables', JSON.stringify(parsed));
            return params.toString();
          }
        }
      } catch {
        // give up
      }
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
    maxImages: 10,
    maxVideoSeconds: 300,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
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

  async post(content: PostContent): Promise<PostResult> {
    const template: ThreadsCreatePostTemplate | null = await loadThreadsTemplate();
    if (!template) {
      return {
        success: false,
        error:
          'No Threads request template captured yet. Post natively on threads.net once so CrossPosty can learn the current request shape, then try again.',
        retryable: false,
      };
    }

    const newBody = mutatePostText(template.bodyText, content.text, template.contentType);
    if (newBody === template.bodyText) {
      console.warn(
        '[CrossPosty] Threads template body mutation found no text field — replaying captured body unchanged. Post may duplicate the previous template content.',
      );
    }

    const headers = stripVolatile(template.headers);

    try {
      const res = await fetch(template.url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: newBody,
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
          error: `Threads HTTP ${res.status}: ${preview}`,
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
};
