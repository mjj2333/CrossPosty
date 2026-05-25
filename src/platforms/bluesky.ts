import { BskyAgent } from '@atproto/api';
import { pdsFetch } from '../lib/atproto-oauth/client';
import {
  authenticateWithBluesky,
  type AtprotoOAuthSession,
} from '../lib/atproto-oauth/flow';
import { updateCredential } from '../storage/credentials';
import { splitIntoChain } from '../lib/thread-split';
import { buildBskyFacets } from './bluesky-facets';
import type {
  AccountCredentials,
  MediaAttachment,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

// BlueSky enforces a max of 4 images per post and ~1MB per image.
const MAX_IMAGES = 4;
// Shared between the adapter declaration and the chain splitter so we
// don't drift if the platform raises the limit.
const BSKY_CHAR_LIMIT = 300;

// Stored session shapes. The two auth paths produce different credential
// blobs; we use a discriminator field. Records created before authType
// existed are treated as 'apppassword' for backwards compatibility.
type AppPasswordSessionData = {
  authType?: 'apppassword';
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
};

type OAuthSessionData = AtprotoOAuthSession & { authType: 'oauth' };

type BlueskySessionData = AppPasswordSessionData | OAuthSessionData;

function isOAuth(data: BlueskySessionData): data is OAuthSessionData {
  return data.authType === 'oauth';
}

// ---- app-password path -------------------------------------------------

async function makeAgent(data: AppPasswordSessionData): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.resumeSession({
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    active: true,
  });
  return agent;
}

async function persistIfAppPasswordRotated(
  credentials: AccountCredentials,
  agent: BskyAgent,
): Promise<void> {
  const before = credentials.data as unknown as AppPasswordSessionData;
  const after = agent.session;
  if (!after) return;
  if (
    after.accessJwt === before.accessJwt &&
    after.refreshJwt === before.refreshJwt
  ) {
    return;
  }
  const updated: AccountCredentials = {
    ...credentials,
    data: {
      authType: 'apppassword',
      did: after.did,
      handle: after.handle,
      accessJwt: after.accessJwt,
      refreshJwt: after.refreshJwt,
    } as unknown as Record<string, unknown>,
  };
  try {
    await updateCredential(updated);
  } catch (err) {
    console.warn('[CrossPosty] failed to persist rotated BSky tokens', err);
  }
}

async function uploadImagesAppPassword(
  agent: BskyAgent,
  images: MediaAttachment[],
): Promise<unknown | null> {
  if (images.length === 0) return null;
  const limited = images.slice(0, MAX_IMAGES);
  const uploaded = await Promise.all(
    limited.map(async (m) => {
      const bytes = new Uint8Array(await m.blob.arrayBuffer());
      const up = await agent.uploadBlob(bytes, { encoding: m.mimeType });
      return { alt: m.alt ?? '', image: up.data.blob };
    }),
  );
  return { $type: 'app.bsky.embed.images', images: uploaded };
}

async function postAppPassword(
  content: PostContent,
  credentials: AccountCredentials,
): Promise<PostResult> {
  try {
    const data = credentials.data as unknown as AppPasswordSessionData;
    const agent = await makeAgent(data);
    const imageMedia = (content.media ?? []).filter((m) =>
      m.mimeType.startsWith('image/'),
    );
    const embed = await uploadImagesAppPassword(agent, imageMedia);
    const record: { text: string; embed?: unknown } = { text: content.text };
    if (embed) record.embed = embed;
    const res = await agent.post(record as Parameters<typeof agent.post>[0]);
    await persistIfAppPasswordRotated(credentials, agent);
    const rkey = res.uri.split('/').pop() ?? '';
    return {
      success: true,
      url: `https://bsky.app/profile/${data.handle}/post/${rkey}`,
      remoteId: res.uri,
    };
  } catch (err) {
    return { success: false, error: String(err), retryable: true };
  }
}

// ---- OAuth path --------------------------------------------------------

type BlobRef = {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
};

async function persistIfOAuthRotated(
  credentials: AccountCredentials,
  before: OAuthSessionData,
  after: AtprotoOAuthSession,
): Promise<void> {
  if (
    before.accessToken === after.accessToken &&
    before.refreshToken === after.refreshToken &&
    before.dpopNonce === after.dpopNonce
  ) {
    return;
  }
  const updated: AccountCredentials = {
    ...credentials,
    data: { ...after, authType: 'oauth' } as unknown as Record<string, unknown>,
  };
  try {
    await updateCredential(updated);
  } catch (err) {
    console.warn('[CrossPosty] failed to persist rotated BSky OAuth session', err);
  }
}

async function uploadBlobOAuth(
  session: AtprotoOAuthSession,
  attachment: MediaAttachment,
): Promise<{ blob: BlobRef; session: AtprotoOAuthSession }> {
  // BSky enforces a hard 2,000,000-byte cap on blob uploads. Modern
  // phone cameras easily produce 4-8MB JPEGs. Compress in-process
  // before the upload so the user gets the image through instead of
  // a cryptic 400 from the PDS.
  const ready = await compressForBsky(attachment);
  const result = await pdsFetch(session, '/xrpc/com.atproto.repo.uploadBlob', {
    method: 'POST',
    body: await ready.blob.arrayBuffer(),
    contentType: ready.mimeType,
  });
  if (!result.response.ok) {
    const txt = await result.response.text();
    throw new Error(`uploadBlob HTTP ${result.response.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await result.response.json()) as { blob: BlobRef };
  return { blob: json.blob, session: result.session };
}

// Compress an image to fit under BSky's 2MB blob ceiling. Skip if the
// blob already fits. Otherwise: decode -> downscale longest edge to
// 2048px -> re-encode as JPEG with a quality search loop. createImage
// Bitmap + OffscreenCanvas are both available in MV3 service workers
// on Chrome.
const BSKY_BLOB_CAP = 2_000_000;
const BSKY_BLOB_TARGET = 1_800_000; // safety margin under the cap
const MAX_DIM = 2048;

async function compressForBsky(attachment: MediaAttachment): Promise<MediaAttachment> {
  if (attachment.blob.size <= BSKY_BLOB_CAP) return attachment;
  if (!attachment.mimeType.startsWith('image/')) return attachment;
  try {
    const bitmap = await createImageBitmap(attachment.blob);
    let { width, height } = bitmap;
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    let quality = 0.85;
    let out: Blob | null = null;
    while (quality >= 0.4) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, width, height);
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (out.size <= BSKY_BLOB_TARGET) break;
      quality -= 0.1;
    }
    bitmap.close();
    if (!out || out.size > BSKY_BLOB_CAP) {
      console.warn('[CrossPosty] BSky compression could not fit under 2MB', {
        originalSize: attachment.blob.size,
        finalSize: out?.size,
      });
      return attachment;
    }
    console.log('[CrossPosty] BSky image compressed', {
      original: attachment.blob.size,
      compressed: out.size,
      qualityUsed: quality,
      dimensions: `${width}x${height}`,
    });
    return { blob: out, mimeType: 'image/jpeg', alt: attachment.alt };
  } catch (err) {
    console.warn('[CrossPosty] BSky compression failed, uploading original', err);
    return attachment;
  }
}

async function postOAuth(
  content: PostContent,
  credentials: AccountCredentials,
): Promise<PostResult> {
  try {
    const initial = credentials.data as unknown as OAuthSessionData;
    let session: AtprotoOAuthSession = initial;

    // Upload images sequentially so a single rotated nonce / refresh
    // propagates to the next call.
    const images = (content.media ?? []).filter((m) =>
      m.mimeType.startsWith('image/'),
    );
    const limited = images.slice(0, MAX_IMAGES);
    const uploaded: Array<{ alt: string; image: BlobRef }> = [];
    for (const m of limited) {
      const out = await uploadBlobOAuth(session, m);
      session = out.session;
      uploaded.push({ alt: m.alt ?? '', image: out.blob });
    }

    // Chain long posts. Single-post case yields a one-element array
    // and behaves identically to the pre-chain code path. Images go
    // on the head post only (standard thread shape).
    const chunks = splitIntoChain(content.text, BSKY_CHAR_LIMIT);

    let firstUri: string | undefined;
    let firstUrl: string | undefined;
    let rootRef: { uri: string; cid: string } | undefined;
    let parentRef: { uri: string; cid: string } | undefined;
    let chainError: { message: string; afterChunk: number } | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i] ?? '';
      const facetResult = await buildBskyFacets(chunkText, session);
      session = facetResult.session;

      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text: chunkText,
        createdAt: new Date().toISOString(),
      };
      if (facetResult.facets.length > 0) {
        record.facets = facetResult.facets;
      }
      if (i === 0 && uploaded.length > 0) {
        record.embed = { $type: 'app.bsky.embed.images', images: uploaded };
      }
      if (rootRef && parentRef) {
        record.reply = { root: rootRef, parent: parentRef };
      }
      const createRecordBody = {
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record,
      };

      // Brief pacing between chain chunks. BSky is more permissive
      // than X/Meta about bursts, but the PDS also rate-limits and
      // a couple seconds between requests keeps us comfortably under
      // any per-IP throttle.
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      const result = await pdsFetch(session, '/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        body: JSON.stringify(createRecordBody),
        contentType: 'application/json',
      });
      session = result.session;
      if (!result.response.ok) {
        const txt = await result.response.text();
        chainError = {
          message: `createRecord HTTP ${result.response.status}: ${txt.slice(0, 200)}`,
          afterChunk: i,
        };
        break;
      }
      const json = (await result.response.json()) as { uri: string; cid: string };
      if (i === 0) {
        firstUri = json.uri;
        const rkey = json.uri.split('/').pop() ?? '';
        firstUrl = `https://bsky.app/profile/${session.handle}/post/${rkey}`;
        rootRef = { uri: json.uri, cid: json.cid };
      }
      parentRef = { uri: json.uri, cid: json.cid };
    }

    await persistIfOAuthRotated(credentials, initial, session);

    if (chainError && chainError.afterChunk === 0) {
      return {
        success: false,
        error: chainError.message,
        retryable: false,
      };
    }
    if (chainError) {
      console.warn('[CrossPosty] BSky chain partial', {
        posted: chainError.afterChunk,
        of: chunks.length,
        error: chainError.message,
      });
    }
    return {
      success: true,
      url: firstUrl ?? `https://bsky.app/profile/${session.handle}`,
      remoteId: firstUri ?? '',
    };
  } catch (err) {
    return { success: false, error: String(err), retryable: true };
  }
}

// ---- adapter -----------------------------------------------------------

export const blueskyAdapter: PlatformAdapter = {
  id: 'bluesky',
  displayName: 'BlueSky',
  characterLimit: BSKY_CHAR_LIMIT,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 0,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },

  async authenticate(params): Promise<AccountCredentials> {
    // OAuth path -- params.authType === 'oauth', params.handle is the
    // user's BlueSky handle. Browser pops the BlueSky auth screen.
    if (params.authType === 'oauth') {
      const handle = params.handle?.trim();
      if (!handle) throw new Error('BlueSky handle required for OAuth.');
      const session = await authenticateWithBluesky(handle);
      return {
        platformId: 'bluesky',
        accountId: crypto.randomUUID(),
        displayName: `@${session.handle}`,
        data: { ...session, authType: 'oauth' } as unknown as Record<string, unknown>,
      };
    }

    // Legacy app-password path.
    const { identifier, appPassword } = params;
    if (!identifier || !appPassword) {
      throw new Error('identifier and appPassword required');
    }
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier, password: appPassword });
    const session = agent.session;
    if (!session) throw new Error('login failed: no session');
    return {
      platformId: 'bluesky',
      accountId: crypto.randomUUID(),
      displayName: `@${session.handle}`,
      data: {
        authType: 'apppassword',
        did: session.did,
        handle: session.handle,
        accessJwt: session.accessJwt,
        refreshJwt: session.refreshJwt,
      } as unknown as Record<string, unknown>,
    };
  },

  async post(content, credentials): Promise<PostResult> {
    const data = credentials.data as unknown as BlueskySessionData;
    return isOAuth(data)
      ? postOAuth(content, credentials)
      : postAppPassword(content, credentials);
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const data = credentials.data as unknown as BlueskySessionData;
      if (isOAuth(data)) {
        let session: AtprotoOAuthSession = data;
        const r = await pdsFetch(session, '/xrpc/com.atproto.server.getSession', {
          method: 'GET',
        });
        session = r.session;
        await persistIfOAuthRotated(credentials, data, session);
        return r.response.ok;
      }
      const agent = await makeAgent(data);
      await agent.getProfile({ actor: data.handle });
      await persistIfAppPasswordRotated(credentials, agent);
      return true;
    } catch {
      return false;
    }
  },

  async getStatus(credentials) {
    const data = credentials.data as unknown as BlueskySessionData;
    if (isOAuth(data)) {
      // Liveness check + report the access token's expiry. Refresh is
      // continuous so the meaningful "you must re-auth" moment is when
      // the refresh token expires — but atproto refresh tokens are opaque
      // and we don't know that timestamp client-side. Surface the access
      // token expiry instead so the user can see the session is healthy.
      // Local-only check. We previously tried a live getSession call here,
      // but DPoP+nonce requests in the SW context hung indefinitely on the
      // second fetch (the nonce-bearing retry). Status uses stored data:
      // access token not expired => green, expired => yellow (refresh on
      // next post will probably recover), no token => red. Cross-posting
      // itself will surface a real error if the session is dead.
      const nowSec = Math.floor(Date.now() / 1000);
      if (!data.accessToken || !data.refreshToken) {
        return {
          ok: false,
          severity: 'red',
          message: 'OAuth session is missing tokens. Reconnect this account.',
        };
      }
      if (nowSec >= data.expiresAt) {
        return {
          ok: true,
          severity: 'yellow',
          message: 'Access token expired. Will auto-refresh on next post.',
          expiresAt: data.expiresAt,
        };
      }
      return {
        ok: true,
        severity: 'green',
        message: 'OAuth session looks healthy. Access token auto-refreshes.',
        expiresAt: data.expiresAt,
      };
    }
    // App-password path: validate via @atproto/api and decode the refresh
    // JWT's exp claim. Refresh JWT lifetime is the practical "needs
    // re-auth" point — once expired we can't get fresh access tokens.
    try {
      const agent = await makeAgent(data);
      await agent.getProfile({ actor: data.handle });
      await persistIfAppPasswordRotated(credentials, agent);
      const refreshExp = decodeJwtExp(data.refreshJwt);
      return {
        ok: true,
        severity: 'green',
        message: 'App-password session healthy.',
        expiresAt: refreshExp ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        severity: 'red',
        message: `Session check failed: ${String(err).slice(0, 120)}`,
      };
    }
  },
};

// Reads the `exp` claim from a JWT without verifying the signature. atproto
// app-password refresh JWTs carry this claim and we only need the value
// for display, not authorization.
function decodeJwtExp(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1] ?? '';
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '==='.slice((padded.length + 3) % 4));
    const parsed = JSON.parse(json) as { exp?: unknown };
    return typeof parsed.exp === 'number' ? parsed.exp : null;
  } catch {
    return null;
  }
}
