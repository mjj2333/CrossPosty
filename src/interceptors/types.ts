import type { MediaAttachment, PlatformId } from '../platforms/types';

// 'phone' is a synthetic source — not a destination platform — used when
// the post arrived via the Supabase E2EE relay rather than a native
// compose on X / BSky / Threads. The composer filters destinations by
// `c.platformId !== sourcePlatformId`; since no credential ever has
// platformId 'phone', a phone-sourced post yields ALL accounts as
// destinations.
export type SourceId = PlatformId | 'phone';

export type InterceptedPost = {
  sourcePlatformId: SourceId;
  text: string;
  media: MediaAttachment[];
  sourceMetadata?: Record<string, unknown>;
};

export interface SourceInterceptor {
  platformId: PlatformId;
  hostMatchPattern: string;
  install(
    onIntercept: (post: InterceptedPost, complete: (allow: boolean) => void) => void,
  ): () => void;
}
