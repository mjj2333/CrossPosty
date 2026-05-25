import type { PlatformId } from '../platforms/types';

// One entry per real person. Each platform key holds that person's handle
// on that platform — without the leading "@". When cross-posting, we look
// up the source-platform handle and substitute the destination's. Any
// handle the user doesn't add to the map is treated as "unknown" and its
// @-prefix gets stripped on the destination so we don't accidentally ping
// a stranger who happens to own that handle elsewhere.
export type MentionEntry = Partial<Record<PlatformId, string>>;
export type MentionMap = MentionEntry[];

const KEY = 'mentionMap';

export async function loadMentionMap(): Promise<MentionMap> {
  const stored = await chrome.storage.local.get(KEY);
  const v = stored[KEY] as MentionMap | undefined;
  return Array.isArray(v) ? v : [];
}

export async function saveMentionMap(map: MentionMap): Promise<void> {
  await chrome.storage.local.set({ [KEY]: map });
}
