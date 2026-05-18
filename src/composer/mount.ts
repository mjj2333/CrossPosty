import type { InterceptedPost } from '../interceptors/types';

// Stubbed in Task 13; real Shadow-DOM React mount lands in Task 14.
export function mountComposerPanel(intercepted: InterceptedPost): void {
  console.log('[CrossPosty] intercepted post (panel mount pending)', {
    source: intercepted.sourcePlatformId,
    textPreview: intercepted.text.slice(0, 80),
  });
}
