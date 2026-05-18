import type { MediaAttachment } from '../platforms/types';
import { getAssembledBlob } from '../storage/media-cache';
import type { InterceptedPost, SourceInterceptor } from './types';

type CreateTweetVariables = {
  tweet_text?: string;
  media?: {
    media_entities?: Array<{ media_id?: string; tagged_users?: unknown[] }>;
    possibly_sensitive?: boolean;
  };
};

function extractMediaIds(body: string): string[] {
  try {
    const json = JSON.parse(body) as { variables?: CreateTweetVariables };
    const entities = json.variables?.media?.media_entities ?? [];
    const ids: string[] = [];
    for (const e of entities) {
      if (typeof e.media_id === 'string') ids.push(e.media_id);
    }
    return ids;
  } catch {
    return [];
  }
}

async function parseCreateTweetBody(body: string): Promise<InterceptedPost | null> {
  try {
    const json = JSON.parse(body) as { variables?: CreateTweetVariables };
    const text = json.variables?.tweet_text;
    if (typeof text !== 'string') return null;
    const mediaIds = extractMediaIds(body);
    const media: MediaAttachment[] = [];
    for (const id of mediaIds) {
      const found = await getAssembledBlob('x', id);
      if (found) {
        media.push({ blob: found.blob, mimeType: found.mimeType });
      } else {
        console.warn('[CrossPosty] X compose references media_id we did not capture', id);
      }
    }
    return { sourcePlatformId: 'x', text, media };
  } catch {
    return null;
  }
}

export const xInterceptor: SourceInterceptor = {
  platformId: 'x',
  hostMatchPattern: '*://x.com/*',
  install(onIntercept) {
    async function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!/(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
      const post = await parseCreateTweetBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
