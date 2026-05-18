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

export type PlatformId = 'bluesky' | 'mastodon' | 'linkedin' | 'x';

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

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  characterLimit: number;
  mediaSupport: MediaSupport;
  authenticate(params: Record<string, string>): Promise<AccountCredentials>;
  post(content: PostContent, credentials: AccountCredentials): Promise<PostResult>;
  validateCredentials(credentials: AccountCredentials): Promise<boolean>;
}
