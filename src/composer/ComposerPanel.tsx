import { useEffect, useState } from 'react';
import type { InterceptedPost } from '../interceptors/types';
import { isContextInvalidatedError } from '../lib/context';
import type { CrossPostResultEntry, Message } from '../lib/messaging';
import type { AccountCredentials, PlatformId } from '../platforms/types';
import { PlatformVariant, type VariantResult } from './PlatformVariant';

type VariantState = {
  account: AccountCredentials;
  text: string;
  enabled: boolean;
  result?: VariantResult;
};

// Inlined to avoid pulling @atproto/api + masto into content-script bundles.
// Keep in sync with characterLimit on each PlatformAdapter.
const CHAR_LIMITS: Record<PlatformId, number> = {
  bluesky: 300,
  mastodon: 500,
  linkedin: 3000,
  x: 280,
};

function charLimitFor(platformId: PlatformId): number {
  return CHAR_LIMITS[platformId] ?? 280;
}

export function ComposerPanel({
  intercepted,
  onClose,
}: {
  intercepted: InterceptedPost;
  onClose: () => void;
}) {
  const [variants, setVariants] = useState<VariantState[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [orphaned, setOrphaned] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const listMsg: Message = { type: 'LIST_CREDENTIALS', payload: null };
        const response = (await chrome.runtime.sendMessage(listMsg)) as {
          type: 'LIST_CREDENTIALS_RESPONSE';
          payload: AccountCredentials[];
        };
        const destinations = response.payload.filter(
          (c) => c.platformId !== intercepted.sourcePlatformId,
        );
        setVariants(
          destinations.map((account) => ({ account, text: intercepted.text, enabled: true })),
        );
        setLoaded(true);
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          setOrphaned(true);
          setLoaded(true);
        } else {
          throw err;
        }
      }
    })();
  }, [intercepted]);

  function update(i: number, patch: Partial<VariantState>) {
    setVariants((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  async function crosspost() {
    setBusy(true);
    const active = variants.filter((v) => v.enabled);

    // Media is shared across variants (same images); per-platform edits in
    // future. We pass intercepted.media on every request - adapters decide
    // whether/how to upload (e.g. LinkedIn currently ignores media in v1).
    const media = intercepted.media;

    let responses: Array<CrossPostResultEntry | undefined>;
    try {
      responses = await Promise.all(
        active.map(async (v) => {
          const req: Message = {
            type: 'CROSSPOST_REQUEST',
            payload: {
              content: { text: v.text, media },
              accountIds: [v.account.accountId],
            },
          };
          const res = (await chrome.runtime.sendMessage(req)) as CrossPostResultEntry[];
          return res[0];
        }),
      );
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        setOrphaned(true);
        setBusy(false);
        return;
      }
      throw err;
    }

    setVariants((vs) =>
      vs.map((v) => {
        const entry = responses.find((r) => r?.accountId === v.account.accountId);
        if (!entry) return v;
        const r = entry.result;
        return {
          ...v,
          result: r.success
            ? { success: true, message: r.url ? `Posted -> ${r.url}` : 'Posted', url: r.url }
            : { success: false, message: `Failed: ${r.error}` },
        };
      }),
    );
    setBusy(false);
  }

  return (
    <div className="crossposty-panel">
      <div className="crossposty-header">
        <span className="crossposty-title">Cross-post to...</span>
        <button type="button" className="crossposty-close" onClick={onClose}>
          x
        </button>
      </div>
      <div className="crossposty-body">
        {orphaned ? (
          <p className="crossposty-empty">
            CrossPosty was reloaded. Refresh this tab to keep cross-posting.
          </p>
        ) : !loaded ? (
          <p className="crossposty-empty">Loading destinations...</p>
        ) : variants.length === 0 ? (
          <p className="crossposty-empty">
            No destination accounts connected. Open the extension popup to add one.
          </p>
        ) : (
          variants.map((v, i) => (
            <PlatformVariant
              key={v.account.accountId}
              account={v.account}
              text={v.text}
              charLimit={charLimitFor(v.account.platformId)}
              enabled={v.enabled}
              mediaCount={intercepted.media.length}
              onTextChange={(text) => update(i, { text })}
              onToggle={(enabled) => update(i, { enabled })}
              result={v.result}
            />
          ))
        )}
        {variants.length > 0 && (
          <button
            type="button"
            className="crossposty-cta"
            disabled={busy || !variants.some((v) => v.enabled)}
            onClick={crosspost}
          >
            {busy ? 'Posting...' : 'Cross-post'}
          </button>
        )}
      </div>
    </div>
  );
}
