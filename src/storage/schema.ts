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
};

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  enabledDestinations: [],
  composerMode: 'auto',
  passphraseSet: false,
};
