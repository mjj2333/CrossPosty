import { mountComposerPanel } from '../composer/mount';
import { bskyInterceptor } from '../interceptors/bsky';

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  runAt: 'document_start',
  main() {
    injectMainWorldHook();
    bskyInterceptor.install((post) => {
      mountComposerPanel(post);
    });
  },
});

function injectMainWorldHook(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/inject-fetch-hook.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
