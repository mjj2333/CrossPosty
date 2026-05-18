import { blueskyAdapter } from './bluesky';
import { linkedinAdapter } from './linkedin';
import { mastodonAdapter } from './mastodon';
import { threadsAdapter } from './threads';
import type { PlatformAdapter, PlatformId } from './types';
import { xAdapter } from './x';

const adapters: PlatformAdapter[] = [
  blueskyAdapter,
  mastodonAdapter,
  linkedinAdapter,
  xAdapter,
  threadsAdapter,
];

export const platformRegistry: Record<PlatformId, PlatformAdapter> = Object.fromEntries(
  adapters.map((a) => [a.id, a]),
) as Record<PlatformId, PlatformAdapter>;

export function getAdapter(id: PlatformId): PlatformAdapter {
  const a = platformRegistry[id];
  if (!a) throw new Error(`Unknown platform: ${id}`);
  return a;
}

export const allAdapters = adapters;
