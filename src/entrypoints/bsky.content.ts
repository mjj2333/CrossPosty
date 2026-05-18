import { mountComposerPanel } from '../composer/mount';
import { bskyInterceptor } from '../interceptors/bsky';

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] bsky.app ISOLATED content script loaded');
    bskyInterceptor.install((post) => {
      console.log('[CrossPosty] bsky interceptor fired — mounting panel');
      mountComposerPanel(post);
    });
  },
});
