// Substack Notes use a Tiptap-style JSON document and a publication-scoped
// API host (drice233.substack.com/api/v1/comment/feed). The URL pattern,
// auth (cookies), and content-type are stable, so we only really need to
// snapshot the user's most recent native compose request to learn:
//   - which subdomain the user posts under (each user has their own)
//   - the exact request URL
//   - the auxiliary fields the request body carries beyond the document
//     (replyMinimumRole etc.) so we don't drop a field the server now
//     requires
//
// The bodyJson itself we rebuild from scratch on each cross-post rather
// than mutating in place — the document is small and pure data, so a
// regeneration is simpler than walking the Tiptap tree.

export type SubstackNoteTemplate = {
  version: 1;
  url: string;
  headers: Record<string, string>;
  bodyJson: unknown;
  capturedAt: number;
};

const KEY = 'substackTemplate';

export async function loadSubstackTemplate(): Promise<SubstackNoteTemplate | null> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as SubstackNoteTemplate | undefined) ?? null;
}

export async function saveSubstackTemplate(t: SubstackNoteTemplate): Promise<void> {
  await chrome.storage.local.set({ [KEY]: t });
}

export function buildSubstackTemplate(
  url: string,
  headers: Record<string, string>,
  bodyText: string,
): SubstackNoteTemplate | null {
  try {
    const bodyJson = JSON.parse(bodyText) as unknown;
    return { version: 1, url, headers, bodyJson, capturedAt: Date.now() };
  } catch {
    return null;
  }
}
