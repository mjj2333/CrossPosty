// DPoP (Demonstrating Proof of Possession) signs every authenticated
// request with a per-session keypair. atproto binds access + refresh
// tokens to this key, so a leaked token without the private key is
// useless to an attacker.
//
// Each DPoP JWT proves:
//   htm  - the HTTP method
//   htu  - the request URL (sans query/fragment is permitted; we keep
//          the path+query for the PDS API to disambiguate similar paths)
//   iat  - issued-at
//   jti  - unique nonce
//   ath  - SHA-256 of the access token (only when one is presented)
//   nonce - server-issued anti-replay value, added after first 401/400
//
// The keypair is ECDSA P-256, generated as extractable so we can export
// to JWK and persist inside the encrypted credentials record. Storage
// boundary is the same as any other token we keep.

export type DpopKeyMaterial = {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
};

export async function generateDpopKey(): Promise<DpopKeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // The public JWK that goes in the JWS header must not include the
  // private scalar 'd' nor any key_ops/ext metadata that confuse verifiers.
  const cleanPublic: JsonWebKey = {
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  };
  return { privateJwk, publicJwk: cleanPublic };
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

function base64UrlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlString(s: string): string {
  return base64UrlBytes(new TextEncoder().encode(s));
}

export async function sha256B64Url(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlBytes(new Uint8Array(hash));
}

export type DpopClaims = {
  htm: string;
  htu: string;
  nonce?: string;
  ath?: string;
};

export async function signDpopJwt(
  key: DpopKeyMaterial,
  claims: DpopClaims,
): Promise<string> {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: key.publicJwk };
  const payload = {
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  };
  const headerB64 = base64UrlString(JSON.stringify(header));
  const payloadB64 = base64UrlString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const privateKey = await importPrivateKey(key.privateJwk);
  // WebCrypto returns ECDSA signatures as raw r||s (64 bytes for P-256),
  // which is exactly the format JWS ES256 expects. No DER unwrap needed.
  const sigRaw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(sigRaw))}`;
}
