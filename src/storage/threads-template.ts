// Threads' web client uses Meta's internal API with a rotating operation
// hash and feature-flag payload — same brittleness profile as X. Same
// solution: snapshot the user's most recent native compose request and
// replay its shape when cross-posting. The template self-updates every
// time the user posts natively on threads.net.

export type ThreadsCreatePostTemplate = {
  version: 1;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  contentType: 'json' | 'urlencoded' | 'multipart' | 'unknown';
  capturedAt: number;
};

const KEY = 'threadsTemplate';

export async function loadThreadsTemplate(): Promise<ThreadsCreatePostTemplate | null> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ThreadsCreatePostTemplate | undefined) ?? null;
}

export async function saveThreadsTemplate(t: ThreadsCreatePostTemplate): Promise<void> {
  await chrome.storage.local.set({ [KEY]: t });
}

export function buildThreadsTemplate(
  url: string,
  headers: Record<string, string>,
  bodyText: string,
): ThreadsCreatePostTemplate {
  const ct = (headers['content-type'] ?? '').toLowerCase();
  const contentType: ThreadsCreatePostTemplate['contentType'] =
    ct.includes('application/json')
      ? 'json'
      : ct.includes('application/x-www-form-urlencoded')
        ? 'urlencoded'
        : ct.includes('multipart/form-data')
          ? 'multipart'
          : 'unknown';
  return { version: 1, url, headers, bodyText, contentType, capturedAt: Date.now() };
}
