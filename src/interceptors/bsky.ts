import type { InterceptedPost, SourceInterceptor } from './types';

type CreateRecordBody = {
  record?: { text?: string };
};

function parseCreateRecordBody(body: string): InterceptedPost | null {
  try {
    const json = JSON.parse(body) as CreateRecordBody;
    const text = json.record?.text;
    if (typeof text !== 'string') return null;
    return { sourcePlatformId: 'bluesky', text, media: [] };
  } catch {
    return null;
  }
}

export const bskyInterceptor: SourceInterceptor = {
  platformId: 'bluesky',
  hostMatchPattern: '*://bsky.app/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      // Match any AT Protocol PDS host (bsky.social, *.bsky.network, custom).
      if (!/\/xrpc\/com\.atproto\.repo\.createRecord/.test(detail.url)) return;
      const post = parseCreateRecordBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
