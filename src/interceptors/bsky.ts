import type { InterceptedPost, SourceInterceptor } from './types';

// bsky.app uses two AT Protocol RPCs for composing, depending on the action:
// - `createRecord` for a single new record (e.g. simple post via some clients)
// - `applyWrites` for an atomic batch write (the bsky.app web client's
//   default — wraps the post creation + any related writes like threadgate)
// Body shapes differ:
//   createRecord: { repo, collection: "app.bsky.feed.post", record: { text, ... } }
//   applyWrites:  { repo, writes: [ { $type: "...applyWrites#create",
//                                     collection: "app.bsky.feed.post",
//                                     value: { text, ... } }, ... ] }

type CreateRecordBody = {
  collection?: string;
  record?: { text?: string };
};

type ApplyWritesWrite = {
  $type?: string;
  collection?: string;
  value?: { text?: string };
};

type ApplyWritesBody = {
  writes?: ApplyWritesWrite[];
};

function parseComposeBody(body: string): InterceptedPost | null {
  try {
    const json = JSON.parse(body) as ApplyWritesBody & CreateRecordBody;

    // applyWrites: scan for the first feed.post create
    if (Array.isArray(json.writes)) {
      for (const write of json.writes) {
        if (write.collection !== 'app.bsky.feed.post') continue;
        if (write.$type && !/applyWrites#create$/.test(write.$type)) continue;
        const text = write.value?.text;
        if (typeof text === 'string') {
          return { sourcePlatformId: 'bluesky', text, media: [] };
        }
      }
      return null;
    }

    // createRecord: single create
    if (json.collection === 'app.bsky.feed.post') {
      const text = json.record?.text;
      if (typeof text === 'string') {
        return { sourcePlatformId: 'bluesky', text, media: [] };
      }
    }

    return null;
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
      // Match any AT Protocol PDS host using either compose RPC.
      if (!/\/xrpc\/com\.atproto\.repo\.(?:createRecord|applyWrites)/.test(detail.url)) return;
      const post = parseComposeBody(detail.body);
      if (post) onIntercept(post, () => undefined);
    }
    window.addEventListener('crossposty:intercept', handle);
    return () => window.removeEventListener('crossposty:intercept', handle);
  },
};
