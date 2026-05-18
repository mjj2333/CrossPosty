import { mountComposerPanel } from '../composer/mount';
import { xInterceptor } from '../interceptors/x';
import { buildTemplate, saveXTemplate } from '../storage/x-template';

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] x.com ISOLATED content script loaded');
    xInterceptor.install((post) => {
      console.log('[CrossPosty] x interceptor fired — mounting panel');
      mountComposerPanel(post);
    });
    installTemplateCapture();
  },
});

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    const detail = (ev as CustomEvent<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }>).detail;
    if (!/(?:x\.com|twitter\.com)\/i\/api\/graphql\/[^/]+\/CreateTweet/.test(detail.url)) return;
    const template = buildTemplate(detail.url, detail.headers, detail.body);
    if (template) void saveXTemplate(template);
  });
}
