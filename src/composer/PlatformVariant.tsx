import type { AccountCredentials } from '../platforms/types';

export type VariantResult = { success: boolean; message: string; url?: string };

export function PlatformVariant({
  account,
  text,
  charLimit,
  enabled,
  onTextChange,
  onToggle,
  result,
}: {
  account: AccountCredentials;
  text: string;
  charLimit: number;
  enabled: boolean;
  onTextChange: (s: string) => void;
  onToggle: (on: boolean) => void;
  result?: VariantResult;
}) {
  const over = text.length > charLimit;
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
