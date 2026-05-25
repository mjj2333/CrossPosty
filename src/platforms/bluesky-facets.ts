import { pdsFetch } from '../lib/atproto-oauth/client';
import type { AtprotoOAuthSession } from '../lib/atproto-oauth/flow';

// BSky stores post text raw and uses a separate `facets` array to mark
// byte ranges as links, mentions, or tags. Without facets, URLs and
// @handles render as plain text — not clickable, no notifications. We
// scan the cross-post text, compute byte (not char) offsets, and resolve
// mention handles to DIDs via the PDS.

export type BskyFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
};

const URL_RE = /https?:\/\/[^\s]+/g;
const TAG_RE = /(^|\s)#([A-Za-z0-9_]+)/g;
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;
// Punctuation we trim off the tail of a URL match because it's almost
// always sentence punctuation, not part of the URL itself.
const URL_TAIL_PUNCT_RE = /[.,;:!?)\]'"]+$/;

export async function buildBskyFacets(
  text: string,
  session: AtprotoOAuthSession,
): Promise<{ facets: BskyFacet[]; session: AtprotoOAuthSession }> {
  const encoder = new TextEncoder();
  const byteOffset = (charIdx: number): number =>
    encoder.encode(text.slice(0, charIdx)).length;

  const facets: BskyFacet[] = [];

  // Links — strip trailing sentence punctuation so "see https://x.com." doesn't
  // include the period in the clickable target.
  for (const m of text.matchAll(URL_RE)) {
    if (typeof m.index !== 'number') continue;
    let raw = m[0];
    const stripped = raw.replace(URL_TAIL_PUNCT_RE, '');
    raw = stripped;
    const start = m.index;
    const end = start + raw.length;
    facets.push({
      index: { byteStart: byteOffset(start), byteEnd: byteOffset(end) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: raw }],
    });
  }

  // Tags
  for (const m of text.matchAll(TAG_RE)) {
    if (typeof m.index !== 'number') continue;
    const lead = m[1] ?? '';
    const tag = m[2];
    if (!tag) continue;
    const hashIdx = m.index + lead.length;
    const start = hashIdx;
    const end = hashIdx + 1 + tag.length;
    facets.push({
      index: { byteStart: byteOffset(start), byteEnd: byteOffset(end) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }

  // Mentions — resolve in parallel so multiple handles don't serialize
  // the PDS roundtrip. resolveHandle returns 400 if the handle doesn't
  // exist; we just skip those (text stays as written, no facet).
  type MentionHit = { start: number; end: number; handle: string };
  const mentions: MentionHit[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (typeof m.index !== 'number') continue;
    const lead = m[1] ?? '';
    const handle = m[2];
    if (!handle) continue;
    const atIdx = m.index + lead.length;
    mentions.push({ start: atIdx, end: atIdx + 1 + handle.length, handle });
  }
  let currentSession = session;
  const resolved = await Promise.all(
    mentions.map(async (mn) => {
      const out = await resolveHandle(currentSession, mn.handle);
      currentSession = out.session;
      return { ...mn, did: out.did };
    }),
  );
  for (const r of resolved) {
    if (!r.did) continue;
    facets.push({
      index: { byteStart: byteOffset(r.start), byteEnd: byteOffset(r.end) },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did: r.did }],
    });
  }

  return { facets, session: currentSession };
}

async function resolveHandle(
  session: AtprotoOAuthSession,
  handle: string,
): Promise<{ did: string | null; session: AtprotoOAuthSession }> {
  try {
    const result = await pdsFetch(
      session,
      `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      { method: 'GET' },
    );
    if (!result.response.ok) return { did: null, session: result.session };
    const json = (await result.response.json()) as { did?: string };
    return { did: json.did ?? null, session: result.session };
  } catch {
    return { did: null, session };
  }
}
