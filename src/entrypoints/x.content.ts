import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { buildTemplate, saveXTemplate } from '../storage/x-template';

export default defineContentScript({
  matches: ['*://x.com/*'],
  runAt: 'document_start',
  main() {
    injectMainWorldHook();
    xInterceptor.install((post) => {
      mountComposerPanel(post);
    });
    installTemplateCapture();
  },
});

function injectMainWorldHook(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/inject-fetch-hook.js');
  script.onload = () => script.remove();
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
