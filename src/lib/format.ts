// Smart truncation for cross-posting. When source text exceeds a
// destination's character limit, the goal is to keep the result readable
// and informative: prefer cutting at a sentence boundary, fall back to a
// word boundary, and protect a trailing URL because that's typically the
// most important payload of the post.

import type { MentionMap } from '../storage/mention-map';
import type { PlatformId } from '../platforms/types';

const TRAILING_URL_RE = /(\s+)(https?:\/\/\S+)\s*$/;
const URL_RE_GLOBAL = /https?:\/\/\S+/g;
const ELLIPSIS = '\u2026';
// X silently shortens every URL to t.co/<10 chars> which counts as 23
// characters regardless of the original length. Treat URLs accordingly
// when budgeting for X variants so a long URL doesn't eat the whole post.
export const X_URL_WEIGHT = 23;

// How many characters a piece of text will actually consume on the
// destination platform. Equals string length unless a `urlWeight` is
// supplied — in which case every URL match contributes `urlWeight`
// instead of its real length (X's t.co rule).
export function effectiveLength(text: string, urlWeight?: number): number {
  if (urlWeight === undefined) return text.length;
  let total = 0;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  URL_RE_GLOBAL.lastIndex = 0;
  while ((m = URL_RE_GLOBAL.exec(text)) !== null) {
    total += m.index - lastIdx;
    total += urlWeight;
    lastIdx = m.index + m[0].length;
  }
  total += text.length - lastIdx;
  return total;
}
// Matches @handle at the start of input or after whitespace. Allows
// dots in handles for BSky-style "drice.bsky.social". Stops at any
// non-handle char so we don't grab punctuation that follows.
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_.]*)/g;
// Platforms where hashtags are stylistic noise rather than discovery —
// LinkedIn audiences generally treat them as spammy.
const STRIP_HASHTAGS_ON: ReadonlySet<PlatformId> = new Set(['linkedin']);
// Platforms where overflowing text becomes a reply chain instead of
// being truncated. The adapter handles the actual chaining — we just
// stop truncating here so the full text reaches the adapter intact.
const CHAIN_CAPABLE: ReadonlySet<PlatformId> = new Set(['x', 'bluesky']);

export function smartTruncate(
  text: string,
  limit: number,
  opts?: { urlWeight?: number },
): string {
  const urlWeight = opts?.urlWeight;
  if (effectiveLength(text, urlWeight) <= limit) return text;
  // Degenerate limits — no room to do anything intelligent.
  if (limit < 4) return text.slice(0, limit);

  // Protect a trailing URL if present. Cut from the body, glue the URL
  // back on the end. A space separator keeps it visually attached.
  const m = TRAILING_URL_RE.exec(text);
  let body = text;
  let urlSuffix = '';
  let urlSuffixCost = 0;
  if (m && typeof m.index === 'number' && m[2]) {
    const url = m[2];
    body = text.slice(0, m.index);
    urlSuffix = ` ${url}`;
    // On X the trailing URL costs `urlWeight` regardless of its real
    // length; elsewhere it costs its actual char count.
    urlSuffixCost = 1 + (urlWeight ?? url.length);
  }

  const budget = limit - ELLIPSIS.length - urlSuffixCost;
  if (budget <= 0) {
    // URL alone wouldn't fit — give up the URL-protection strategy and
    // just hard-cut the whole string.
    return text.slice(0, limit - ELLIPSIS.length) + ELLIPSIS;
  }

  const head = body.slice(0, budget);

  // Find the latest sentence-ending punctuation followed by whitespace
  // (or end of head). Doesn't match "..." mid-string because the regex
  // requires `\s|$` after the punctuation.
  let cut = -1;
  const sentenceRe = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(head)) !== null) {
    cut = match.index + 1;
  }
  // If the only sentence boundary is way back at the start, we'd lose
  // too much content — prefer the latest word boundary instead.
  if (cut < budget * 0.5) {
    const wordCut = head.lastIndexOf(' ');
    if (wordCut > cut) cut = wordCut;
  }
  // No usable break — hard-cut at the budget edge.
  if (cut <= 0) cut = budget;

  return head.slice(0, cut).trimEnd() + ELLIPSIS + urlSuffix;
}

export type FormatResult = {
  text: string;
  unmappedMentions: string[];
};

export type FormatOptions = {
  platformId: PlatformId;
  sourcePlatformId?: PlatformId;
  charLimit: number;
  mentionMap?: MentionMap;
};

// Composes the per-destination text transforms in the right order:
//   1. Strip hashtags where they don't fit the audience.
//   2. Translate @handles via the user's mapping; strip the @ for handles
//      the user hasn't mapped so we don't ping the wrong stranger.
//   3. Truncate to the destination's character limit.
// Returns the resulting text plus a list of handles whose @ was stripped
// because no mapping existed — the UI surfaces these so the user can add
// mappings as they encounter unfamiliar names.
export function formatForPlatform(text: string, opts: FormatOptions): FormatResult {
  let out = normalizeWhitespace(text);
  if (STRIP_HASHTAGS_ON.has(opts.platformId)) {
    out = stripHashtags(out);
  }
  const { text: translated, unmapped } = translateMentions(
    out,
    opts.platformId,
    opts.mentionMap ?? [],
    opts.sourcePlatformId,
  );
  // Chain-capable platforms receive the full text; their adapters
  // split into a reply chain. Truncating here would discard text the
  // adapter could happily fan into multiple posts.
  if (CHAIN_CAPABLE.has(opts.platformId)) {
    return { text: translated, unmappedMentions: unmapped };
  }
  out = smartTruncate(translated, opts.charLimit, {
    urlWeight: opts.platformId === 'x' ? X_URL_WEIGHT : undefined,
  });
  return { text: out, unmappedMentions: unmapped };
}

// Collapse runs of 3+ newlines down to 2 (one blank line) and trim
// surrounding whitespace. X auto-collapses on its end, but BSky / Threads
// / Substack / Mastodon / LinkedIn preserve whatever the user typed —
// without this a "raw paste" with quadruple newlines renders as a giant
// gap on those platforms. Two newlines (one blank line) is the universal
// paragraph break, so we cap there rather than collapsing to a single
// newline (which would mash paragraphs together).
function normalizeWhitespace(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// Drop "#tag" tokens while preserving surrounding whitespace. Trailing
// hashtag walls ("post text   #a #b #c") leave a tidy result with their
// preceding space collapsed.
function stripHashtags(text: string): string {
  return text.replace(/(^|\s)#[\w]+/g, '$1').replace(/[ \t]{2,}/g, ' ').trimEnd();
}

function translateMentions(
  text: string,
  destPlatform: PlatformId,
  map: MentionMap,
  sourcePlatform?: PlatformId,
): { text: string; unmapped: string[] } {
  const unmapped: string[] = [];
  const result = text.replace(MENTION_RE, (_match, lead: string, handle: string) => {
    const entry = findEntryForHandle(map, handle, sourcePlatform);
    if (entry) {
      const destHandle = entry[destPlatform];
      if (destHandle) return `${lead}@${destHandle}`;
      // Known person, but the user hasn't supplied a destination handle —
      // strip the @ rather than guess. Still counts as "unmapped" so the
      // UI surfaces it.
    }
    if (!unmapped.includes(handle)) unmapped.push(handle);
    return `${lead}${handle}`;
  });
  return { text: result, unmapped };
}

function findEntryForHandle(
  map: MentionMap,
  handle: string,
  sourcePlatform?: PlatformId,
) {
  const needle = handle.toLowerCase();
  // Prefer matching against the source platform's handle — that's the
  // platform the user typed the original @mention on, so it's the most
  // likely to be the authoritative identity.
  if (sourcePlatform) {
    const hit = map.find((e) => e[sourcePlatform]?.toLowerCase() === needle);
    if (hit) return hit;
  }
  return map.find((e) =>
    Object.values(e).some((v) => v?.toLowerCase() === needle),
  );
}
