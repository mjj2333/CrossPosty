import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';

export default defineContentScript({
  matches: ['*://x.com/*'],
  runAt: 'document_start',
  main() {
    injectMainWorldHook();
    xInterceptor.install((post) => {
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
