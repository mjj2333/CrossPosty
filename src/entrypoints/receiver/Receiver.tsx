import { useEffect, useRef, useState } from 'react';
import { ComposerPanel } from '../../composer/ComposerPanel';
import '../../composer/styles.css';
import type { InterceptedPost } from '../../interceptors/types';
import { isContextInvalidatedError } from '../../lib/context';
import { formatForPlatform } from '../../lib/format';
import { serializeMediaAttachments } from '../../lib/media-transport';
import type { CrossPostResultEntry, Message } from '../../lib/messaging';
import {
  decryptMessage,
  fetchMessageById,
  markMessageConsumed,
} from '../../lib/relay/client';
import type { AccountCredentials, MediaAttachment, PlatformId } from '../../platforms/types';
import { loadMentionMap, type MentionMap } from '../../storage/mention-map';
import { loadRelayPairing } from '../../storage/relay-pairing';
import { loadSettings } from '../../storage/settings';

// Char limits mirrored from ComposerPanel — auto-post path doesn't go
// through ComposerPanel, so we apply formatForPlatform here.
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

type DestinationResult = {
  account: AccountCredentials;
  state: 'pending' | 'posting' | 'success' | 'failed';
  message?: string;
  url?: string;
};

type Stage =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'already-consumed' }
  | { name: 'auto-posting'; results: DestinationResult[] }
  | {
      name: 'review';
      intercepted: InterceptedPost;
      msgId: string;
      pairing: import('../../lib/relay/types').RelayPairing;
    };

export function Receiver() {
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  // Track whether we've already kicked off the auto-post so React's
  // strict-mode double-invoke of useEffect doesn't fire it twice.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run().catch((err) => {
      setStage({ name: 'error', message: String(err).slice(0, 250) });
    });
  }, []);

  async function run(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const msgId = params.get('msgId');
    if (!msgId) throw new Error('missing msgId in URL');
    const pairing = await loadRelayPairing();
    if (!pairing) throw new Error('no phone pairing configured');

    const row = await fetchMessageById(pairing, msgId);
    if (!row) throw new Error('message not found (may have been deleted)');
    if (row.consumed_at) {
      setStage({ name: 'already-consumed' });
      return;
    }

    const decrypted = await decryptMessage(pairing, row);
    const media: MediaAttachment[] = decrypted.media.map((m) => ({
      blob: new Blob([m.bytes as BlobPart], { type: m.mimeType }),
      mimeType: m.mimeType,
      alt: m.alt,
    }));
    const intercepted: InterceptedPost = {
      sourcePlatformId: 'phone',
      text: decrypted.text,
      media,
    };

    // Branch on the user's stored preference. 'review' hands off to
    // the standard ComposerPanel UI so the user can edit per-platform
    // before sending. 'auto' continues into the fan-out below.
    const settings = await loadSettings();
    if (settings.phoneMode === 'review') {
      setStage({ name: 'review', intercepted, msgId, pairing });
      return;
    }

    const [credsResp, mentionMap] = await Promise.all([
      chrome.runtime.sendMessage({
        type: 'LIST_CREDENTIALS',
        payload: null,
      } satisfies Message) as Promise<{
        type: 'LIST_CREDENTIALS_RESPONSE';
        payload: AccountCredentials[];
      }>,
      loadMentionMap(),
    ]);
    // No phone-sourced filter needed: 'phone' isn't a real PlatformId
    // for credentials. Every connected account is a valid destination
    // for a phone-relay post.
    const destinations = credsResp.payload;
    if (destinations.length === 0) {
      throw new Error('No destination accounts connected. Add one in the popup, then retry the phone send.');
    }

    setStage({
      name: 'auto-posting',
      results: destinations.map((account) => ({ account, state: 'posting' })),
    });

    // Cross-post in parallel. Each variant gets its own formatted text
    // (mention swaps, hashtag stripping for LinkedIn, smart truncation
    // per char limit). One serialized media payload reused across all.
    const serializedMedia = await serializeMediaAttachments(media);
    const settled = await Promise.all(
      destinations.map(async (account) => {
        const formatted = formatForPlatform(intercepted.text, {
          platformId: account.platformId,
          // 'phone' isn't a real source for mention lookup.
          sourcePlatformId: undefined,
          charLimit: charLimitFor(account.platformId),
          mentionMap: mentionMap as MentionMap,
        });
        try {
          const req: Message = {
            type: 'CROSSPOST_REQUEST',
            payload: {
              content: { text: formatted.text, media: serializedMedia },
              accountIds: [account.accountId],
            },
          };
          const res = (await chrome.runtime.sendMessage(req)) as CrossPostResultEntry[];
          const entry = res[0];
          if (!entry) {
            return { account, state: 'failed' as const, message: 'No response' };
          }
          if (entry.result.success) {
            return {
              account,
              state: 'success' as const,
              url: entry.result.url,
              message: entry.result.url ? `Posted → ${entry.result.url}` : 'Posted',
            };
          }
          return {
            account,
            state: 'failed' as const,
            message: entry.result.error,
          };
        } catch (err) {
          if (isContextInvalidatedError(err)) {
            return {
              account,
              state: 'failed' as const,
              message: 'Extension reloaded mid-post — refresh and try again.',
            };
          }
          return { account, state: 'failed' as const, message: String(err).slice(0, 200) };
        }
      }),
    );

    setStage({ name: 'auto-posting', results: settled });

    // Mark consumed regardless of per-destination success. The user
    // already sent the message from their phone — we don't want to
    // re-deliver it if half the destinations failed. Failure detail
    // is in the results UI for them to see.
    try {
      await markMessageConsumed(pairing, msgId);
    } catch (err) {
      console.warn('[CrossPosty] markMessageConsumed failed', err);
    }
  }

  if (stage.name === 'loading') {
    return <CenteredCard>Loading phone post…</CenteredCard>;
  }
  if (stage.name === 'error') {
    return (
      <CenteredCard>
        <h2 className="text-lg font-semibold text-red-700">Couldn't load the post</h2>
        <p className="text-sm text-gray-600 mt-2">{stage.message}</p>
      </CenteredCard>
    );
  }
  if (stage.name === 'already-consumed') {
    return (
      <CenteredCard>
        <h2 className="text-lg font-semibold">Already cross-posted</h2>
        <p className="text-sm text-gray-600 mt-2">
          This relayed post was already handled. You can close this tab.
        </p>
      </CenteredCard>
    );
  }
  if (stage.name === 'review') {
    return (
      <>
        <PhoneSourceBanner />
        <ComposerPanel
          intercepted={stage.intercepted}
          onClose={() => window.close()}
          onCrossPosted={() => {
            // Mark consumed once the user has actually sent. Failure
            // case: leave unconsumed so the next poll retries.
            void markMessageConsumed(stage.pairing, stage.msgId).catch((err) =>
              console.warn('[CrossPosty] markMessageConsumed failed', err),
            );
          }}
        />
      </>
    );
  }

  const allDone = stage.results.every((r) => r.state === 'success' || r.state === 'failed');
  const successes = stage.results.filter((r) => r.state === 'success').length;
  const failures = stage.results.filter((r) => r.state === 'failed').length;

  return (
    <CenteredCard>
      <h2 className="text-lg font-semibold">📱 Phone cross-post</h2>
      <p className="text-sm text-gray-600 mt-1">
        {allDone
          ? `${successes} succeeded, ${failures} failed.`
          : 'Posting to your connected accounts…'}
      </p>
      <ul className="mt-4 space-y-2 text-left">
        {stage.results.map((r) => (
          <li
            key={r.account.accountId}
            className="border rounded p-2 flex items-start gap-2"
          >
            <span className="w-2 h-2 mt-1.5 rounded-full shrink-0" style={{ background: dotColor(r.state) }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm">
                <strong style={{ textTransform: 'capitalize' }}>{r.account.platformId}</strong>{' '}
                <span className="text-gray-500">— {r.account.displayName}</span>
              </div>
              {r.message && (
                <div className={`text-xs mt-0.5 ${r.state === 'failed' ? 'text-red-600' : 'text-gray-600'}`}>
                  {r.state === 'success' && r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline">
                      {r.message}
                    </a>
                  ) : (
                    r.message
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {allDone && (
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-1.5 rounded text-sm"
        >
          Close tab
        </button>
      )}
    </CenteredCard>
  );
}

function PhoneSourceBanner() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        left: 16,
        padding: '8px 12px',
        background: '#fef3c7',
        border: '1px solid #f59e0b',
        borderRadius: 8,
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 13,
        color: '#78350f',
        zIndex: 2147483647,
      }}
    >
      📱 Composed on your phone. Pick destinations, then cross-post.
    </div>
  );
}

function dotColor(state: DestinationResult['state']): string {
  switch (state) {
    case 'pending':
    case 'posting':
      return '#9ca3af';
    case 'success':
      return '#10b981';
    case 'failed':
      return '#ef4444';
  }
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        background: '#f9fafb',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: 24,
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
