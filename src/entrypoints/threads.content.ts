import { mountComposerPanel } from '../composer/mount';
import {
  parseThreadsComposeBody,
  threadsInterceptor,
  THREADS_COMPOSE_RE,
} from '../interceptors/threads';
import { installOrphanRejectionSuppressor, isContextAlive } from '../lib/context';
import { debugLog } from '../lib/debug';
import {
  buildThreadsTemplate,
  saveThreadsTemplate,
} from '../storage/threads-template';

export default defineContentScript({
  matches: [
    '*://www.threads.net/*',
    '*://threads.net/*',
    '*://www.threads.com/*',
    '*://threads.com/*',
  ],
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

// The actual compose endpoints Meta uses. Notification queries, timeline
// fetches, etc. all share /graphql/query and sometimes have a `text` field
// in their body — narrowing to these URL patterns is the surest signal
// that what we're capturing is actually the post-creation request.
const THREADS_COMPOSE_URL_RE =
  /\/api\/v1\/media\/(?:configure_text_only_post|configure_post|configure_to_clips)\b/i;

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    if (!isContextAlive()) return;
    const detail = (
      ev as CustomEvent<{ url: string; body: string; headers: Record<string, string> }>
    ).detail;
    if (!THREADS_COMPOSE_RE.test(detail.url)) return;
    if (detail.body.length === 0) return;
    // Two-stage filter: URL must look like a compose endpoint, AND the body
    // parser must find a text field. The body-field check alone was matching
    // unrelated requests (notification badge queries with `text` somewhere
    // in their response data).
    if (!THREADS_COMPOSE_URL_RE.test(detail.url)) return;
    const parsed = parseThreadsComposeBody(detail.body);
    if (!parsed) return;
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
