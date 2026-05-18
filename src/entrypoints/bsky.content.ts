import { mountComposerPanel } from '../composer/mount';
import { bskyInterceptor } from '../interceptors/bsky';
import { isContextAlive } from '../lib/context';
import { storeSegment } from '../storage/media-cache';

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] bsky.app ISOLATED content script loaded');
    bskyInterceptor.install((post) => {
      if (!isContextAlive()) {
        console.warn(
          '[CrossPosty] extension context invalidated (probably reloaded). Refresh this tab to use CrossPosty.',
        );
        return;
      }
      console.log('[CrossPosty] bsky interceptor fired - mounting panel');
      mountComposerPanel(post);
    });
    installMediaSegmentSink();
  },
});

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
    if (detail.sourcePlatform !== 'bluesky') return;
    void storeSegment({
      sourcePlatform: 'bluesky',
      mediaId: detail.mediaId,
      segmentIndex: detail.segmentIndex,
      blob: detail.blob,
      mimeType: detail.mimeType,
    }).catch((err) => {
      console.warn('[CrossPosty] storeSegment failed', err);
    });
  });
}
