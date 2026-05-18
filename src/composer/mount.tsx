import { createRoot, type Root } from 'react-dom/client';
import type { InterceptedPost } from '../interceptors/types';
import { ComposerPanel } from './ComposerPanel';
import css from './styles.css?raw';

let host: HTMLElement | null = null;
let root: Root | null = null;

export function mountComposerPanel(intercepted: InterceptedPost): void {
  if (host) unmount();
  host = document.createElement('div');
  host.id = 'crossposty-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.body.appendChild(host);
  root = createRoot(mountPoint);
  root.render(<ComposerPanel intercepted={intercepted} onClose={unmount} />);
}

function unmount(): void {
  if (root) root.unmount();
  if (host) host.remove();
  root = null;
  host = null;
}
