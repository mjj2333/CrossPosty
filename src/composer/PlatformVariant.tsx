import type { AccountCredentials, PlatformId } from '../platforms/types';

export type VariantResult = { success: boolean; message: string; url?: string };

// Destinations that currently forward images. Mastodon/LinkedIn media
// support comes in a later slice.
const MEDIA_SUPPORTED: ReadonlySet<PlatformId> = new Set(['bluesky', 'x']);

export function PlatformVariant({
  account,
  text,
  charLimit,
  enabled,
  mediaCount,
  onTextChange,
  onToggle,
  result,
}: {
  account: AccountCredentials;
  text: string;
  charLimit: number;
  enabled: boolean;
  mediaCount: number;
  onTextChange: (s: string) => void;
  onToggle: (on: boolean) => void;
  result?: VariantResult;
}) {
  const over = text.length > charLimit;
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
          <span style={{ color: '#888' }}>— {account.displayName}</span>
        </label>
        <span className={over ? 'crossposty-overlimit' : undefined}>
          {text.length} / {charLimit}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        disabled={!enabled}
      />
      {mediaCount > 0 && (
        <div className="crossposty-media-indicator">
          {supportsMedia
            ? `📎 ${mediaCount} image${mediaCount === 1 ? '' : 's'} attached`
            : `⚠️ ${mediaCount} image${mediaCount === 1 ? '' : 's'} — not forwarded to ${account.platformId} (text only)`}
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
