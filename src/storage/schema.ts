import type { AccountCredentials } from '../platforms/types';

export type StoredCredentialsBlob = {
  version: 1;
  encrypted: string;
  iv: string;
};

export type DecryptedCredentialsArray = AccountCredentials[];

export type UserSettings = {
  version: 1;
  enabledDestinations: string[];
  composerMode: 'auto' | 'manual';
  passphraseSet: boolean;
  // Phone relay behavior when a message arrives on the desktop:
  //   'auto'   — receiver tab cross-posts to every destination on mount
  //              with no user click. Compose-and-forget UX.
  //   'review' — receiver tab opens the full composer (per-platform
  //              variants, edit textareas, destination checkboxes) and
  //              waits for a manual Cross-post click. Lets the user
  //              tweak text per platform before sending.
  phoneMode: 'auto' | 'review';
};

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  enabledDestinations: [],
  composerMode: 'auto',
  passphraseSet: false,
  phoneMode: 'auto',
};
