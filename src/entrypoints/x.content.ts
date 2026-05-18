import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { installOrphanRejectionSuppressor, isContextAlive } from '../lib/context';
import { debugLog } from '../lib/debug';
import { sniffImageMime } from '../lib/mime-sniff';
import { storeSegment } from '../storage/media-cache';
import { buildTemplate, saveXTemplate } from '../storage/x-template';

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] x.com ISOLATED content script loaded');
    installOrphanRejectionSuppressor();
    xInterceptor.install((post) => {
      if (!isContextAlive()) {
        console.warn(
          '[CrossPosty] extension context invalidated (probably reloaded). Refresh this tab to use CrossPosty.',
        );
        return;
      }
      console.log('[CrossPosty] x interceptor fired - mounting panel');
      mountComposerPanel(post);
    });
    installTemplateCapture();
    installMediaSegmentSink();
  },
});

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    if (!isContextAlive()) return;
    const detail = (
      ev as CustomEvent<{ url: string; body: string; headers: Record<string, string> }>
    ).detail;
    if (!/(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
    const template = buildTemplate(detail.url, detail.headers, detail.body);
    if (template) {
      // Diagnostic: log the captured variables.media shape so we can compare
      // to what our adapter actually replays. Gated to debug since it fires
      // on every native X post.
      try {
        const body = template.bodyJson as { variables?: Record<string, unknown> } | null;
        const v = body?.variables ?? {};
        debugLog('[CrossPosty] captured X template', {
          tweet_text: (v as { tweet_text?: string }).tweet_text,
          media: (v as { media?: unknown }).media,
          variableKeys: Object.keys(v),
        });
      } catch {
        // never block on logging
      }
      void saveXTemplate(template).catch((err) =>
        console.warn('[CrossPosty] saveXTemplate failed', err),
      );
    }
  });
}

function installMediaSegmentSink(): void {
  window.addEventListener('crossposty:media-segment', (ev) => {
    if (!isContextAlive()) return;
    const detail = (
      ev as CustomEvent<{
        sourcePlatform: 'x' | 'bluesky';
        mediaId: string;
        segmentIndex: number;
        blob: Blob;
        mimeType: string;
      }>
    ).detail;
    if (detail.sourcePlatform !== 'x') return;
    // X's FormData upload strips the original MIME — the captured blob comes
    // through as application/octet-stream. Sniff the magic bytes to recover
    // it so downstream filters (e.g. BlueSky adapter's image/* filter) work.
    void (async () => {
      const mimeType = await sniffImageMime(detail.blob);
      if (mimeType !== detail.mimeType) {
        console.log('[CrossPosty] sniffed X media MIME', {
          original: detail.mimeType,
          sniffed: mimeType,
        });
      }
      await storeSegment({
        sourcePlatform: 'x',
        mediaId: detail.mediaId,
        segmentIndex: detail.segmentIndex,
        blob: detail.blob,
        mimeType,
      });
    })().catch((err) => {
      console.warn('[CrossPosty] storeSegment failed', err);
    });
  });
}
