// Threads' web client uses Meta's internal API with a rotating operation
// hash and feature-flag payload — same brittleness profile as X. Same
// solution: snapshot the user's most recent native compose request and
// replay its shape when cross-posting. We keep two templates: one for
// the text-only endpoint and one for the image-bearing endpoint. The
// captured body shape differs between them (image bodies carry
// upload_id + caption_with_entities + extra fields), and Meta's edge
// 404s when we send the wrong body to a given endpoint. Each template
// self-updates every time the user posts that shape natively.

export type ThreadsCreatePostTemplate = {
  version: 1;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  contentType: 'json' | 'urlencoded' | 'multipart' | 'unknown';
  capturedAt: number;
};

// Slot key derived from the captured URL.
//   "textOnly"   -> /api/v1/media/configure_text_only_post/
//   "withMedia"  -> /api/v1/media/configure_text_post_app_feed/
//   Anything else (configure_post, configure_to_clips, ...) maps to
//   "withMedia" since those also carry an upload_id.
export type ThreadsTemplateSlot = 'textOnly' | 'withMedia';

type ThreadsTemplateStore = {
  version: 2;
  textOnly?: ThreadsCreatePostTemplate;
  withMedia?: ThreadsCreatePostTemplate;
};

const KEY = 'threadsTemplate';

export function classifyEndpoint(url: string): ThreadsTemplateSlot {
  return /\/configure_text_only_post\b/i.test(url) ? 'textOnly' : 'withMedia';
}

// Backwards compat: prior versions stored a single ThreadsCreatePostTemplate
// at this key. Read that and route it into the right slot so older users
// don't lose their captured shape on upgrade.
export async function loadThreadsTemplates(): Promise<ThreadsTemplateStore> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as ThreadsTemplateStore | ThreadsCreatePostTemplate | undefined;
  if (!raw) return { version: 2 };
  if ('version' in raw && raw.version === 2) {
    return raw as ThreadsTemplateStore;
  }
  // Treat anything else as a legacy single-template record.
  const legacy = raw as ThreadsCreatePostTemplate;
  if (!legacy.url) return { version: 2 };
  const slot = classifyEndpoint(legacy.url);
  return { version: 2, [slot]: legacy };
}

// Picks the right template for a given content shape. Returns null only
// if there's no template at all for that slot — caller surfaces a
// "capture by posting natively" message.
export async function loadThreadsTemplate(
  slot: ThreadsTemplateSlot = 'textOnly',
): Promise<ThreadsCreatePostTemplate | null> {
  const store = await loadThreadsTemplates();
  return store[slot] ?? null;
}

export async function saveThreadsTemplate(t: ThreadsCreatePostTemplate): Promise<void> {
  const slot = classifyEndpoint(t.url);
  const store = await loadThreadsTemplates();
  store[slot] = t;
  store.version = 2;
  await chrome.storage.local.set({ [KEY]: store });
}

export function buildThreadsTemplate(
  url: string,
  headers: Record<string, string>,
  bodyText: string,
): ThreadsCreatePostTemplate {
  const ct = (headers['content-type'] ?? '').toLowerCase();
  let contentType: ThreadsCreatePostTemplate['contentType'] = ct.includes(
    'application/json',
  )
    ? 'json'
    : ct.includes('application/x-www-form-urlencoded')
      ? 'urlencoded'
      : ct.includes('multipart/form-data')
        ? 'multipart'
        : 'unknown';
  // Threads' web client sometimes captures without a content-type header set
  // on the original request (or under a label our matcher doesn't recognise).
  // Body-sniff so we still classify correctly: JSON starts with { or [;
  // form bodies look like key=value(&key=value)+.
  if (contentType === 'unknown') {
    const trimmed = bodyText.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(bodyText);
        contentType = 'json';
      } catch {
        // not JSON after all
      }
    } else if (/^[\w%.\-]+=[^&]*(?:&[\w%.\-]+=[^&]*)*$/.test(bodyText)) {
      contentType = 'urlencoded';
    }
  }
  return { version: 1, url, headers, bodyText, contentType, capturedAt: Date.now() };
}
