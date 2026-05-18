import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { installOrphanRejectionSuppressor, isContextAlive } from '../lib/context';
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
    void storeSegment({
      sourcePlatform: 'x',
      mediaId: detail.mediaId,
      segmentIndex: detail.segmentIndex,
      blob: detail.blob,
      mimeType: detail.mimeType,
    }).catch((err) => {
      console.warn('[CrossPosty] storeSegment failed', err);
    });
  });
}
