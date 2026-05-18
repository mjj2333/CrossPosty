import type { InterceptedPost, SourceInterceptor } from './types';

type CreateTweetVariables = {
  tweet_text?: string;
  media?: { media_entities?: Array<{ media_id: string }> };
};

function parseCreateTweetBody(body: string): InterceptedPost | null {
  try {
    const json = JSON.parse(body) as { variables?: CreateTweetVariables };
    const text = json.variables?.tweet_text;
    if (typeof text !== 'string') return null;
    return { sourcePlatformId: 'x', text, media: [] };
  } catch {
    return null;
  }
}

export const xInterceptor: SourceInterceptor = {
  platformId: 'x',
  hostMatchPattern: '*://x.com/*',
  install(onIntercept) {
    function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!/(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
      const post = parseCreateTweetBody(detail.body);
      if (!post) {
        console.warn('[CrossPosty] CreateTweet body parsed but no tweet_text found', {
          bodyPreview: detail.body.slice(0, 200),
        });
        return;
      }
      onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
