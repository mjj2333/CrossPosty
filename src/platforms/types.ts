export type MediaAttachment = {
  blob: Blob;
  mimeType: string;
  alt?: string;
};

export type PostContent = {
  text: string;
  media?: MediaAttachment[];
  reply?: { uri: string; rootUri?: string };
};

export type PostResult =
  | { success: true; url: string; remoteId: string }
  | { success: false; error: string; retryable: boolean };

export type PlatformId = 'bluesky' | 'mastodon' | 'linkedin' | 'x' | 'threads';

export type AccountCredentials = {
  platformId: PlatformId;
  accountId: string;
  displayName: string;
  data: Record<string, unknown>;
};

export type MediaSupport = {
  maxImages: number;
  maxVideoSeconds: number;
  supportedMimeTypes: string[];
};

// Per-account status used by the popup's pre-flight check. Adapters that
// need to distinguish "broken" from "working but needs attention" (e.g.
// X/Threads with a stale template) implement getStatus(); everything else
// gets a green/red mapping from validateCredentials() by default.
export type AccountStatus = {
  ok: boolean;
  severity: 'green' | 'yellow' | 'red';
  message?: string;
};

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  characterLimit: number;
  mediaSupport: MediaSupport;
  authenticate(params: Record<string, string>): Promise<AccountCredentials>;
  post(content: PostContent, credentials: AccountCredentials): Promise<PostResult>;
  validateCredentials(credentials: AccountCredentials): Promise<boolean>;
  getStatus?(credentials: AccountCredentials): Promise<AccountStatus>;
}
