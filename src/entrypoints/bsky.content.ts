import { mountComposerPanel } from '../composer/mount';
import { bskyInterceptor } from '../interceptors/bsky';
import { storeSegment } from '../storage/media-cache';

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] bsky.app ISOLATED content script loaded');
    bskyInterceptor.install((post) => {
      console.log('[CrossPosty] bsky interceptor fired - mounting panel');
      mountComposerPanel(post);
    });
    installMediaSegmentSink();
  },
});

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
    if (detail.sourcePlatform !== 'bluesky') return;
    void storeSegment({
      sourcePlatform: 'bluesky',
      mediaId: detail.mediaId,
      segmentIndex: detail.segmentIndex,
      blob: detail.blob,
      mimeType: detail.mimeType,
    });
  });
}
