// X's GraphQL CreateTweet endpoint uses a rotating operation hash, evolving
// feature flags, and rotating bearer tokens. Rather than tracking those by
// hand, we snapshot the most recent native CreateTweet request the user
// made on x.com and replay its shape when cross-posting. The template
// self-updates every time the user posts natively.

export type XCreateTweetTemplate = {
  version: 1;
  url: string;
  headers: Record<string, string>;
  bodyJson: unknown;
  capturedAt: number;
};

const KEY = 'xTemplate';

export async function loadXTemplate(): Promise<XCreateTweetTemplate | null> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as XCreateTweetTemplate | undefined) ?? null;
}

export async function saveXTemplate(t: XCreateTweetTemplate): Promise<void> {
  await chrome.storage.local.set({ [KEY]: t });
}

export function buildTemplate(
  url: string,
  headers: Record<string, string>,
  bodyText: string,
): XCreateTweetTemplate | null {
  try {
    const bodyJson = JSON.parse(bodyText) as unknown;
    return { version: 1, url, headers, bodyJson, capturedAt: Date.now() };
  } catch {
    return null;
  }
}
