// Blob doesn't survive chrome.runtime.sendMessage cleanly between content-
// script and service-worker contexts: the raw bytes arrive but the receiver
// gets a plain object without Blob methods (.arrayBuffer / .text / .slice).
// So we serialize each attachment to base64 on the sender, then reconstruct
// a real Blob on the receiver.
//
// Size cost: base64 is ~33% larger than raw. For typical images
// (under a few MB) the encoded payload still fits comfortably under
// chrome.runtime.sendMessage's effective limit.

import type { MediaAttachment } from '../platforms/types';

export type SerializedMedia = {
  base64: string;
  mimeType: string;
  alt?: string;
};

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Build the binary string in 32KB chunks to avoid argument-count limits on
  // String.fromCharCode for large blobs.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function serializeMediaAttachments(
  attachments: MediaAttachment[],
): Promise<SerializedMedia[]> {
  return Promise.all(
    attachments.map(async (m) => ({
      base64: await blobToBase64(m.blob),
      mimeType: m.mimeType,
      alt: m.alt,
    })),
  );
}

export function deserializeMediaAttachments(
  serialized: SerializedMedia[],
): MediaAttachment[] {
  return serialized.map((s) => ({
    blob: base64ToBlob(s.base64, s.mimeType),
    mimeType: s.mimeType,
    alt: s.alt,
  }));
}
