import { mountComposerPanel } from '../composer/mount';
import { threadsInterceptor, THREADS_COMPOSE_RE } from '../interceptors/threads';
import { installOrphanRejectionSuppressor, isContextAlive } from '../lib/context';
import { debugLog } from '../lib/debug';
import {
  buildThreadsTemplate,
  saveThreadsTemplate,
} from '../storage/threads-template';

export default defineContentScript({
  matches: ['*://www.threads.net/*', '*://threads.net/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] threads.net ISOLATED content script loaded');
    installOrphanRejectionSuppressor();
    threadsInterceptor.install((post) => {
      if (!isContextAlive()) {
        console.warn(
          '[CrossPosty] extension context invalidated (probably reloaded). Refresh this tab to use CrossPosty.',
        );
        return;
      }
      console.log('[CrossPosty] threads interceptor fired - mounting panel');
      mountComposerPanel(post);
    });
    installTemplateCapture();
  },
});

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    if (!isContextAlive()) return;
    const detail = (
      ev as CustomEvent<{ url: string; body: string; headers: Record<string, string> }>
    ).detail;
    if (!THREADS_COMPOSE_RE.test(detail.url)) return;
    // Only capture compose-shaped bodies (have a text field) to avoid
    // saving every threads.net GraphQL read as a "template".
    if (detail.body.length === 0) return;
    const template = buildThreadsTemplate(detail.url, detail.headers, detail.body);
    debugLog('[CrossPosty] captured Threads template', {
      url: template.url,
      bodyChars: template.bodyText.length,
      contentType: template.contentType,
    });
    void saveThreadsTemplate(template).catch((err) =>
      console.warn('[CrossPosty] saveThreadsTemplate failed', err),
    );
  });
}
