import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { buildTemplate, saveXTemplate } from '../storage/x-template';

export default defineContentScript({
  matches: ['*://x.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] x.com content script loaded');
    injectMainWorldHook();
    xInterceptor.install((post) => {
      console.log('[CrossPosty] x interceptor fired — mounting panel');
      mountComposerPanel(post);
    });
    installTemplateCapture();
  },
});

function injectMainWorldHook(): void {
  const script = document.createElement('script');
  const src = chrome.runtime.getURL('/inject-fetch-hook.js');
  console.log('[CrossPosty] injecting MAIN-world hook from', src);
  script.src = src;
  script.onload = () => {
    console.log('[CrossPosty] MAIN-world hook script onload fired');
    script.remove();
  };
  script.onerror = (e) => {
    console.error('[CrossPosty] MAIN-world hook script FAILED to load', e);
  };
  (document.head || document.documentElement).appendChild(script);
}

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    const detail = (ev as CustomEvent<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }>).detail;
    if (!/x\.com\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
    const template = buildTemplate(detail.url, detail.headers, detail.body);
    if (template) void saveXTemplate(template);
  });
}
