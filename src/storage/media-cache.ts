// IndexedDB-backed cache of media segments captured during platform uploads.
//
// Captured by main-world.content.ts → dispatched via CustomEvent →
// stashed here by the ISOLATED content script → looked up by the source
// interceptor when a compose request fires referencing those IDs.
//
// Keyed by (sourcePlatform, mediaId). For X the mediaId is the
// media_id_string; for BlueSky it's the blob cid. Multi-segment uploads
// (X chunked) accumulate by segmentIndex; getAssembledBlob concatenates
// in order.
//
// TTL: 1 hour. Cleanup runs opportunistically on each storeSegment call.

import Dexie, { type Table } from 'dexie';

export type MediaSourcePlatform = 'x' | 'bluesky';

export type StoredMediaSegment = {
  id?: number; // auto-increment primary key
  sourcePlatform: MediaSourcePlatform;
  mediaId: string;
  segmentIndex: number;
  mimeType: string;
  blob: Blob;
  capturedAt: number; // epoch ms
};

const TTL_MS = 60 * 60 * 1000; // 1 hour

class MediaCacheDB extends Dexie {
  segments!: Table<StoredMediaSegment, number>;

  constructor() {
    super('crossposty-media');
    this.version(1).stores({
      // Index by composite for lookup, plus capturedAt for TTL cleanup.
      segments: '++id, [sourcePlatform+mediaId], capturedAt',
    });
  }
}

let dbInstance: MediaCacheDB | null = null;
function db(): MediaCacheDB {
  if (!dbInstance) dbInstance = new MediaCacheDB();
  return dbInstance;
}

export async function storeSegment(seg: Omit<StoredMediaSegment, 'id' | 'capturedAt'>): Promise<void> {
  await db().segments.add({
    ...seg,
    capturedAt: Date.now(),
  });
  // Fire-and-forget TTL cleanup
  void cleanup();
}

export async function getAssembledBlob(
  sourcePlatform: MediaSourcePlatform,
  mediaId: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
  const rows = await db()
    .segments.where('[sourcePlatform+mediaId]')
    .equals([sourcePlatform, mediaId])
    .toArray();
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.segmentIndex - b.segmentIndex);
  const blobs = rows.map((r) => r.blob);
  const mimeType = rows[0]?.mimeType ?? 'application/octet-stream';
  if (blobs.length === 1) {
    const only = blobs[0];
    if (!only) return null;
    return { blob: only, mimeType };
  }
  return { blob: new Blob(blobs, { type: mimeType }), mimeType };
}

export async function cleanup(): Promise<void> {
  const cutoff = Date.now() - TTL_MS;
  await db().segments.where('capturedAt').below(cutoff).delete();
}

export async function clearAll(): Promise<void> {
  await db().segments.clear();
}
