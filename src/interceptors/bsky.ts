import type { MediaAttachment } from '../platforms/types';
import { getAssembledBlob } from '../storage/media-cache';
import type { InterceptedPost, SourceInterceptor } from './types';

// bsky.app uses two AT Protocol RPCs for composing:
// - `createRecord` for a single new record
// - `applyWrites` for an atomic batch write (bsky.app's web client default)
// Both can include media via embed.images[].image.ref.$link (cid).

type BskyImage = {
  alt?: string;
  image?: {
    $type?: string;
    ref?: { $link?: string };
    mimeType?: string;
  };
};

type BskyEmbed = {
  $type?: string;
  images?: BskyImage[];
};

type BskyPostRecord = {
  $type?: string;
  text?: string;
  embed?: BskyEmbed;
};

type CreateRecordBody = {
  collection?: string;
  record?: BskyPostRecord;
};

type ApplyWritesWrite = {
  $type?: string;
  collection?: string;
  value?: BskyPostRecord;
};

type ApplyWritesBody = {
  writes?: ApplyWritesWrite[];
};

function findFeedPost(json: ApplyWritesBody & CreateRecordBody): BskyPostRecord | null {
  if (Array.isArray(json.writes)) {
    for (const write of json.writes) {
      if (write.collection !== 'app.bsky.feed.post') continue;
      if (write.$type && !/applyWrites#create$/.test(write.$type)) continue;
      if (write.value) return write.value;
    }
    return null;
  }
  if (json.collection === 'app.bsky.feed.post' && json.record) return json.record;
  return null;
}

function extractImageCids(record: BskyPostRecord): Array<{ cid: string; alt?: string }> {
  const out: Array<{ cid: string; alt?: string }> = [];
  const images = record.embed?.images;
  if (!Array.isArray(images)) return out;
  for (const img of images) {
    const cid = img.image?.ref?.$link;
    if (typeof cid === 'string') {
      out.push({ cid, alt: img.alt });
    }
  }
  return out;
}

async function parseComposeBody(body: string): Promise<InterceptedPost | null> {
  try {
    const json = JSON.parse(body) as ApplyWritesBody & CreateRecordBody;
    const record = findFeedPost(json);
    if (!record) return null;
    const text = record.text;
    if (typeof text !== 'string') return null;

    const refs = extractImageCids(record);
    const media: MediaAttachment[] = [];
    for (const ref of refs) {
      const found = await getAssembledBlob('bluesky', ref.cid);
      if (found) {
        media.push({ blob: found.blob, mimeType: found.mimeType, alt: ref.alt });
      } else {
        console.warn('[CrossPosty] BlueSky compose references cid we did not capture', ref.cid);
      }
    }
    return { sourcePlatformId: 'bluesky', text, media };
  } catch {
    return null;
  }
}

export const bskyInterceptor: SourceInterceptor = {
  platformId: 'bluesky',
  hostMatchPattern: '*://bsky.app/*',
  install(onIntercept) {
    async function handle(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; body: string }>).detail;
      if (!/\/xrpc\/com\.atproto\.repo\.(?:createRecord|applyWrites)/.test(detail.url)) return;
      const post = await parseComposeBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
