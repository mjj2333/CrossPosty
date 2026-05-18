// Tiny image MIME sniffer. X's web client packs the upload binary into a
// FormData field without preserving the original MIME, so we receive blobs
// with type 'application/octet-stream'. The BlueSky adapter (and human
// reviewers of any saved blob) want a real image/<type>, so we sniff the
// first 12 bytes to recover it.

const SIGNATURES: Array<{ mime: string; matches: (h: Uint8Array) => boolean }> = [
  {
    mime: 'image/png',
    matches: (h) =>
      h.length >= 8 &&
      h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47 &&
      h[4] === 0x0d && h[5] === 0x0a && h[6] === 0x1a && h[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    matches: (h) => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  },
  {
    mime: 'image/gif',
    matches: (h) =>
      h.length >= 6 &&
      h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38 &&
      (h[4] === 0x37 || h[4] === 0x39) && h[5] === 0x61,
  },
  {
    mime: 'image/webp',
    matches: (h) =>
      h.length >= 12 &&
      h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
      h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50,
  },
];

export async function sniffImageMime(blob: Blob): Promise<string> {
  // Trust an explicit non-generic MIME if the platform set one.
  if (blob.type && blob.type !== 'application/octet-stream') return blob.type;
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  for (const sig of SIGNATURES) {
    if (sig.matches(head)) return sig.mime;
  }
  return blob.type || 'application/octet-stream';
}
