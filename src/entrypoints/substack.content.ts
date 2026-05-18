import { installOrphanRejectionSuppressor, isContextAlive } from '../lib/context';
import { debugLog } from '../lib/debug';
import { SUBSTACK_NOTE_URL_RE } from '../interceptors/substack';
import {
  buildSubstackTemplate,
  saveSubstackTemplate,
} from '../storage/substack-template';

// Substack is destination-only for now (source platforms are X / BSky /
// Threads), so this content script only captures the user's native Note
// compose request shape — it does NOT mount the cross-post composer
// panel. Whenever the user posts a Note natively, we overwrite the
// stored template so the next cross-post replays a fresh request.
export default defineContentScript({
  matches: ['*://*.substack.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[CrossPosty] substack.com ISOLATED content script loaded');
    installOrphanRejectionSuppressor();
    installTemplateCapture();
  },
});

function installTemplateCapture(): void {
  window.addEventListener('crossposty:intercept', (ev) => {
    if (!isContextAlive()) return;
    const detail = (
      ev as CustomEvent<{ url: string; body: string; headers: Record<string, string> }>
    ).detail;
    if (!SUBSTACK_NOTE_URL_RE.test(detail.url)) return;
    if (detail.body.length === 0) return;
    const template = buildSubstackTemplate(detail.url, detail.headers, detail.body);
    if (!template) return;
    debugLog('[CrossPosty] captured Substack template', {
      url: template.url,
      bodyChars: detail.body.length,
    });
    void saveSubstackTemplate(template).catch((err) =>
      console.warn('[CrossPosty] saveSubstackTemplate failed', err),
    );
  });
}
