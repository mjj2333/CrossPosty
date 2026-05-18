import { createRoot, type Root } from 'react-dom/client';
import type { InterceptedPost } from '../interceptors/types';
import { ComposerPanel } from './ComposerPanel';
import css from './styles.css?raw';

let host: HTMLElement | null = null;
let root: Root | null = null;

export function mountComposerPanel(intercepted: InterceptedPost): void {
  console.log('[CrossPosty] mountComposerPanel called', {
    source: intercepted.sourcePlatformId,
    textChars: intercepted.text.length,
  });
  if (host) unmount();
  host = document.createElement('div');
  host.id = 'crossposty-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  if (!document.body) {
    console.error('[CrossPosty] document.body missing - cannot mount panel');
    return;
  }
  document.body.appendChild(host);
  root = createRoot(mountPoint);
  root.render(<ComposerPanel intercepted={intercepted} onClose={unmount} />);
  console.log('[CrossPosty] panel mounted in shadow DOM');
}

function unmount(): void {
  if (root) root.unmount();
  if (host) host.remove();
  root = null;
  host = null;
}
