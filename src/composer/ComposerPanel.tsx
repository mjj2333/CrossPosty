import { useEffect, useState } from 'react';
import type { InterceptedPost } from '../interceptors/types';
import { isContextInvalidatedError } from '../lib/context';
import { formatForPlatform } from '../lib/format';
import { serializeMediaAttachments } from '../lib/media-transport';
import type { CrossPostResultEntry, Message } from '../lib/messaging';
import type { AccountCredentials, PlatformId } from '../platforms/types';
import { loadMentionMap, type MentionMap } from '../storage/mention-map';
import { PlatformVariant, type VariantResult } from './PlatformVariant';

type VariantState = {
  account: AccountCredentials;
  text: string;
  enabled: boolean;
  unmappedMentions: string[];
  result?: VariantResult;
};

// Inlined to avoid pulling @atproto/api + masto into content-script bundles.
// Keep in sync with characterLimit on each PlatformAdapter.
const CHAR_LIMITS: Record<PlatformId, number> = {
  bluesky: 300,
  mastodon: 500,
  linkedin: 3000,
  x: 280,
  threads: 500,
  substack: 1000,
};

function charLimitFor(platformId: PlatformId): number {
  return CHAR_LIMITS[platformId] ?? 280;
}

export function ComposerPanel({
  intercepted,
  onClose,
  onCrossPosted,
}: {
  intercepted: InterceptedPost;
  onClose: () => void;
  // Fires once the cross-post fan-out has resolved (success or failure
  // for at least one variant). The receiver page uses this to mark the
  // relay message consumed — so a phone post stays in the queue until
  // the user has actually attempted to send it on the desktop.
  onCrossPosted?: () => void;
}) {
  const [variants, setVariants] = useState<VariantState[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [orphaned, setOrphaned] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [listResponse, mentionMap] = await Promise.all([
          chrome.runtime.sendMessage({
            type: 'LIST_CREDENTIALS',
            payload: null,
          } satisfies Message) as Promise<{
            type: 'LIST_CREDENTIALS_RESPONSE';
            payload: AccountCredentials[];
          }>,
          loadMentionMap(),
        ]);
        const destinations = listResponse.payload.filter(
          (c) => c.platformId !== intercepted.sourcePlatformId,
        );
        setVariants(
          destinations.map((account) => {
            const formatted = formatForPlatform(intercepted.text, {
              platformId: account.platformId,
              // 'phone' isn't a real platform identity for mention
              // lookup — leave undefined so the mention map searches
              // across all platforms for a match.
              sourcePlatformId:
                intercepted.sourcePlatformId === 'phone'
                  ? undefined
                  : intercepted.sourcePlatformId,
              charLimit: charLimitFor(account.platformId),
              mentionMap: mentionMap as MentionMap,
            });
            return {
              account,
              text: formatted.text,
              enabled: true,
              unmappedMentions: formatted.unmappedMentions,
            };
          }),
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

    // Serialize media once for all variants. Blob doesn't survive
    // chrome.runtime.sendMessage's structured cloning reliably — the
    // receiver gets the bytes but loses .arrayBuffer / .text methods. We
    // base64 here, reconstruct as Blob on the background side.
    const serializedMedia = await serializeMediaAttachments(intercepted.media);

    let responses: Array<CrossPostResultEntry | undefined>;
    try {
      responses = await Promise.all(
        active.map(async (v) => {
          const req: Message = {
            type: 'CROSSPOST_REQUEST',
            payload: {
              content: { text: v.text, media: serializedMedia },
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
    // Signal the host (e.g. the relay receiver tab) that the fan-out
    // has finished. Fires regardless of per-variant success — we mark
    // consumed on attempt, not on success, since the user has seen the
    // content and acted on it either way.
    onCrossPosted?.();
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
              unmappedMentions={v.unmappedMentions}
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
