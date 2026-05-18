// Resolves a BlueSky handle (e.g. user.bsky.social) to the three pieces
// the OAuth flow needs:
//   - the user's DID
//   - the PDS that holds their data
//   - the authorization server that issues OAuth tokens for that PDS
//
// Hops:
//   handle  -> DID            via the public bsky.app resolveHandle XRPC
//   DID     -> PDS URL        via plc.directory (did:plc) or did:web .well-known
//   PDS     -> auth server    via PDS's /.well-known/oauth-protected-resource,
//                             then auth-server's /.well-known/oauth-authorization-server
//
// We use api.bsky.app for handle resolution because it works for handles
// on any TLD (some user-owned domains don't serve the .well-known route
// themselves but plc.directory has the mapping).

export type AuthServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  // ...additional fields exist but we don't read them
};

export type AtprotoAuthTarget = {
  did: string;
  handle: string;
  pdsUrl: string;
  authServerUrl: string;
  authServerMetadata: AuthServerMetadata;
};

const RESOLVE_HANDLE_BASE = 'https://api.bsky.app';

export async function resolveHandle(handle: string): Promise<string> {
  const url =
    `${RESOLVE_HANDLE_BASE}/xrpc/com.atproto.identity.resolveHandle` +
    `?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not resolve handle "${handle}" (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as { did?: string };
  if (!json.did) throw new Error(`Handle "${handle}" did not resolve to a DID.`);
  return json.did;
}

type DidDocService = { id?: string; type?: string; serviceEndpoint?: string };
type DidDocument = { service?: DidDocService[] };

function pdsFromDidDoc(doc: DidDocument, did: string): string {
  const entry = doc.service?.find(
    (s) =>
      s.id?.endsWith('#atproto_pds') ||
      s.type === 'AtprotoPersonalDataServer',
  );
  if (!entry?.serviceEndpoint) {
    throw new Error(`DID document for ${did} declares no PDS endpoint.`);
  }
  return entry.serviceEndpoint;
}

async function resolvePdsForDid(did: string): Promise<string> {
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) throw new Error(`PLC lookup failed for ${did} (HTTP ${res.status}).`);
    return pdsFromDidDoc((await res.json()) as DidDocument, did);
  }
  if (did.startsWith('did:web:')) {
    // did:web:example.com           -> https://example.com/.well-known/did.json
    // did:web:example.com:user:abc  -> https://example.com/user/abc/did.json
    const tail = did.slice('did:web:'.length);
    const parts = tail.split(':');
    const host = parts[0];
    const path = parts.length > 1 ? `/${parts.slice(1).join('/')}/did.json` : '/.well-known/did.json';
    const res = await fetch(`https://${host}${path}`);
    if (!res.ok) throw new Error(`did:web lookup failed for ${did} (HTTP ${res.status}).`);
    return pdsFromDidDoc((await res.json()) as DidDocument, did);
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

async function resolveAuthServer(pdsUrl: string): Promise<AuthServerMetadata> {
  const resourceUrl = new URL('/.well-known/oauth-protected-resource', pdsUrl).toString();
  const res = await fetch(resourceUrl);
  if (!res.ok) {
    throw new Error(
      `PDS ${pdsUrl} does not advertise OAuth protected-resource metadata (HTTP ${res.status}).`,
    );
  }
  const protectedRes = (await res.json()) as { authorization_servers?: string[] };
  const authServerUrl = protectedRes.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error(`PDS ${pdsUrl} declares no authorization servers.`);
  }
  const metaUrl = new URL(
    '/.well-known/oauth-authorization-server',
    authServerUrl,
  ).toString();
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(
      `Auth server ${authServerUrl} did not return metadata (HTTP ${metaRes.status}).`,
    );
  }
  return (await metaRes.json()) as AuthServerMetadata;
}

export async function resolveAtprotoAuthTarget(handle: string): Promise<AtprotoAuthTarget> {
  const did = await resolveHandle(handle);
  const pdsUrl = await resolvePdsForDid(did);
  const authServerMetadata = await resolveAuthServer(pdsUrl);
  return {
    did,
    handle,
    pdsUrl,
    authServerUrl: authServerMetadata.issuer,
    authServerMetadata,
  };
}
