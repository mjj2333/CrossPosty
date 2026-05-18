// Detects Substack Note compose requests by URL pattern + body shape.
// Substack uses a Tiptap JSON document under `bodyJson` — that's our
// signal this is a Note compose and not some other /api/v1/* mutation.

import type { InterceptedPost, SourceInterceptor } from './types';

const SUBSTACK_NOTE_URL_RE = /substack\.com\/api\/v1\/comment\/feed\b/i;

// Walk a Tiptap document tree pulling out all text leaves so we can
// surface the user's post text to the rest of the pipeline. We
// concatenate paragraph text with \n\n.
function extractText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const obj = node as { type?: string; text?: string; content?: unknown[] };
  if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  const children = Array.isArray(obj.content) ? obj.content : [];
  if (obj.type === 'paragraph') {
    return children.map(extractText).join('');
  }
  return children.map(extractText).filter(Boolean).join('\n\n');
}

export function parseSubstackComposeBody(body: string): InterceptedPost | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = parsed as { bodyJson?: unknown };
  if (!root.bodyJson) return null;
  const text = extractText(root.bodyJson);
  if (!text) return null;
  return { sourcePlatformId: 'substack', text, media: [] };
}

export const substackInterceptor: SourceInterceptor = {
  platformId: 'substack',
  hostMatchPattern: '*://*.substack.com/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!SUBSTACK_NOTE_URL_RE.test(detail.url)) return;
      const post = parseSubstackComposeBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};

export { SUBSTACK_NOTE_URL_RE };
