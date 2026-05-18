import type { MediaAttachment, PlatformId } from '../platforms/types';

export type InterceptedPost = {
  sourcePlatformId: PlatformId;
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
