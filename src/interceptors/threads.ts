import type { InterceptedPost, SourceInterceptor } from './types';

// We don't know the exact compose body shape yet — threads.net uses Meta's
// internal GraphQL with a Barcelona* mutation. As a first pass we look for
// common text-field names in the body, regardless of transport.
function parseThreadsComposeBody(body: string): InterceptedPost | null {
  // Try JSON first (covers application/json bodies)
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Fall through to URL-encoded / form-data probing below
  }

  const text = findTextField(parsed) ?? findTextInFormBody(body);
  if (typeof text !== 'string' || text.length === 0) return null;
  return { sourcePlatformId: 'threads', text, media: [] };
}

// Walk an arbitrary object tree looking for a string field whose key suggests
// "the user's post text". Threads' GraphQL mutation likely uses one of these
// names; we pick the first match we find.
const TEXT_KEYS = new Set([
  'caption',
  'text',
  'post_text',
  'content',
  'text_post',
  'composer_text',
]);

function findTextField(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof node !== 'object' || node === null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTextField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && TEXT_KEYS.has(k.toLowerCase())) {
      return v;
    }
  }
  for (const v of Object.values(obj)) {
    const found = findTextField(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function findTextInFormBody(body: string): string | null {
  if (!body || body.length > 100_000) return null;
  try {
    const params = new URLSearchParams(body);
    for (const key of TEXT_KEYS) {
      const v = params.get(key);
      if (v) return v;
    }
  } catch {
    // not URL-encoded
  }
  return null;
}

// Broad URL match: any threads.{net,com} or i.instagram.com API endpoint
// that's a POST with a body. The body-parse step filters out non-compose
// traffic by requiring a text-shaped field.
const THREADS_COMPOSE_RE =
  /(?:threads\.(?:net|com)|i\.instagram\.com)\/(?:api|graphql)/i;

export const threadsInterceptor: SourceInterceptor = {
  platformId: 'threads',
  hostMatchPattern: '*://www.threads.com/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!THREADS_COMPOSE_RE.test(detail.url)) return;
      const post = parseThreadsComposeBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};

export { THREADS_COMPOSE_RE };
