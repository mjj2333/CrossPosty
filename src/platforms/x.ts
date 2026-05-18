import type { PlatformAdapter, PostResult } from './types';

export const xAdapter: PlatformAdapter = {
  id: 'x',
  displayName: 'X',
  characterLimit: 280,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 140,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
  },

  async authenticate(): Promise<never> {
    throw new Error(
      'X authentication is implicit (browser session). Not used in Phase 1 destination flow.',
    );
  },

  async post(): Promise<PostResult> {
    // Phase 1: X is source-only. When X is the source, the original post fires natively
    // through the web UI. X-as-destination (scheduled web-UI posting) is Phase 2.
    return { success: true, url: '', remoteId: 'x-source-native' };
  },

  async validateCredentials(): Promise<boolean> {
    return true;
  },
};
