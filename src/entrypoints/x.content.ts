import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { storeSegment } from '../storage/media-cache';
import { buildTemplate, saveXTemplate } from '../storage/x-template';

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] x.com ISOLATED content script loaded');
    xInterceptor.install((post) => {
      console.log('[CrossPosty] x interceptor fired - mounting panel');
      mountComposerPanel(post);
    });
    installTemplateCapture();
    installMediaSegmentSink();
  },
});

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    const detail = (
      ev as CustomEvent<{ url: string; body: string; headers: Record<string, string> }>
    ).detail;
    if (!/(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
    const template = buildTemplate(detail.url, detail.headers, detail.body);
    if (template) void saveXTemplate(template);
  });
}

function installMediaSegmentSink(): void {
  window.addEventListener('crossposty:media-segment', (ev) => {
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
    });
  });
}
