// Splits long text into a chain of posts that each fit a platform's
// character limit, with " N/M" suffix appended to every chunk so
// readers can follow the order. Sentence-boundary first, word-boundary
// fallback, hard-cut as last resort. Pure function — no platform-specific
// API knowledge.

// Worst case suffix width: " 99/99" = 6 chars. Reserve that up front
// when estimating chunk count, then refine with the actual width once
// we know the real total.
const MAX_SUFFIX_WIDTH = 6;

export function splitIntoChain(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Single-post case — no suffix, no chain. Saves the user a " 1/1"
  // attached to short posts that don't actually overflow.
  if (trimmed.length <= limit) return [trimmed];

  // First pass: estimate count assuming worst-case suffix width.
  let chunks = greedySplit(trimmed, limit - MAX_SUFFIX_WIDTH);
  // Second pass: recompute budget with the real suffix width given the
  // estimated count. If the budget grew (count is small enough that
  // " N/M" is shorter than the worst case), the chunks may merge. If
  // it shrank, chunks may grow in number.
  let suffix = suffixWidth(chunks.length);
  if (suffix !== MAX_SUFFIX_WIDTH) {
    chunks = greedySplit(trimmed, limit - suffix);
  }
  // Third pass: catch the edge case where the second pass changed the
  // total. One more iteration almost always converges.
  if (suffixWidth(chunks.length) !== suffix) {
    suffix = suffixWidth(chunks.length);
    chunks = greedySplit(trimmed, limit - suffix);
  }
  const total = chunks.length;
  return chunks.map((c, i) => `${c} ${i + 1}/${total}`);
}

function suffixWidth(total: number): number {
  // " N/M" — both numerals are `total`, separated by `/`, preceded by a space.
  return 1 + String(total).length + 1 + String(total).length;
}

function greedySplit(text: string, budget: number): string[] {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > budget) {
    const head = remaining.slice(0, budget);
    let cut = -1;
    // Sentence boundary (latest within budget). Reuse smartTruncate's
    // pattern: punctuation followed by whitespace OR end of head.
    const sentenceRe = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceRe.exec(head)) !== null) cut = m.index + 1;
    // If the only sentence boundary is in the first half, prefer a
    // later word boundary so we don't lose too much content per chunk.
    if (cut < budget * 0.5) {
      const wordCut = head.lastIndexOf(' ');
      if (wordCut > cut) cut = wordCut;
    }
    if (cut <= 0) cut = budget;
    const piece = remaining.slice(0, cut).trim();
    if (piece) result.push(piece);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) result.push(remaining);
  return result;
}
