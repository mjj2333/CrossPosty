import { effectiveLength, X_URL_WEIGHT } from '../lib/format';
import { splitIntoChain } from '../lib/thread-split';
import type { AccountCredentials, PlatformId } from '../platforms/types';

export type VariantResult = { success: boolean; message: string; url?: string };

// Destinations that currently forward images. Mastodon / LinkedIn
// media support comes in a later slice.
const MEDIA_SUPPORTED: ReadonlySet<PlatformId> = new Set([
  'bluesky',
  'x',
  'substack',
  'threads',
]);

// Destinations where overflowing text becomes a reply chain (instead
// of being truncated or counted as over-limit). Mirrors the
// CHAIN_CAPABLE set in lib/format.ts — keep in sync.
const CHAIN_CAPABLE: ReadonlySet<PlatformId> = new Set(['bluesky', 'x']);

export function PlatformVariant({
  account,
  text,
  charLimit,
  enabled,
  mediaCount,
  unmappedMentions,
  onTextChange,
  onToggle,
  result,
}: {
  account: AccountCredentials;
  text: string;
  charLimit: number;
  enabled: boolean;
  mediaCount: number;
  unmappedMentions?: string[];
  onTextChange: (s: string) => void;
  onToggle: (on: boolean) => void;
  result?: VariantResult;
}) {
  // X collapses every URL to t.co/<id> which counts as 23 chars regardless
  // of real length — count effective chars so the counter doesn't go red
  // when the post will actually fit after shortening.
  const effLen =
    account.platformId === 'x' ? effectiveLength(text, X_URL_WEIGHT) : text.length;
  const overSingle = effLen > charLimit;
  const canChain = CHAIN_CAPABLE.has(account.platformId);
  // On chain-capable platforms we don't really go "over limit" — text
  // just chains. Compute how many chunks it'll become so we can hint.
  const chainCount = canChain && overSingle ? splitIntoChain(text, charLimit).length : 1;
  const over = overSingle && !canChain;
  const supportsMedia = MEDIA_SUPPORTED.has(account.platformId);
  return (
    <div className="crossposty-variant">
      <div className="crossposty-variant-head">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span style={{ textTransform: 'capitalize' }}>{account.platformId}</span>
          <span style={{ color: '#888' }}>- {account.displayName}</span>
        </label>
        <span className={over ? 'crossposty-overlimit' : undefined}>
          {effLen} / {charLimit}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        disabled={!enabled}
      />
      {chainCount > 1 && (
        <div className="crossposty-media-indicator">
          {`Will chain into ${chainCount} posts (each suffixed N/${chainCount}). Images attach to the first post only.`}
        </div>
      )}
      {mediaCount > 0 && (
        <div className="crossposty-media-indicator">
          {supportsMedia
            ? `${mediaCount} image${mediaCount === 1 ? '' : 's'} attached`
            : `(!) ${mediaCount} image${mediaCount === 1 ? '' : 's'} - not forwarded to ${account.platformId} (text only)`}
        </div>
      )}
      {unmappedMentions && unmappedMentions.length > 0 && (
        <div className="crossposty-media-indicator">
          {`(!) stripped @ from unmapped: ${unmappedMentions.map((h) => `@${h}`).join(', ')}. Add mappings in the extension popup to translate instead.`}
        </div>
      )}
      {result && (
        <div className={`crossposty-result ${result.success ? 'success' : 'fail'}`}>
          {result.success && result.url ? (
            <a href={result.url} target="_blank" rel="noopener noreferrer">
              {result.message}
            </a>
          ) : (
            result.message
          )}
        </div>
      )}
    </div>
  );
}
