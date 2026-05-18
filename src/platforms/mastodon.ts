import { createRestAPIClient } from 'masto';
import { loadMastodonApp, saveMastodonApp, type MastodonApp } from '../storage/mastodon-apps';
import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

type MastodonSessionData = {
  instanceUrl: string;
  accessToken: string;
};

const SCOPES = 'read:accounts write:statuses';
const APP_NAME = 'CrossPosty';
const APP_WEBSITE = 'https://github.com/drice233/crossposty';

function client(data: MastodonSessionData) {
  return createRestAPIClient({ url: data.instanceUrl, accessToken: data.accessToken });
}

function normalizeInstanceUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function registerOrGetApp(instanceUrl: string, redirectUri: string): Promise<MastodonApp> {
  const existing = await loadMastodonApp(instanceUrl);
  if (existing && existing.redirectUri === redirectUri) return existing;

  const res = await fetch(`${instanceUrl}/api/v1/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: APP_NAME,
      redirect_uris: redirectUri,
      scopes: SCOPES,
      website: APP_WEBSITE,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to register app on ${instanceUrl} (HTTP ${res.status}). Is the URL correct?`);
  }
  const json = (await res.json()) as { client_id: string; client_secret: string };
  const app: MastodonApp = {
    instanceUrl,
    clientId: json.client_id,
    clientSecret: json.client_secret,
    redirectUri,
  };
  await saveMastodonApp(app);
  return app;
}

async function launchOAuth(
  instanceUrl: string,
  clientId: string,
  redirectUri: string,
): Promise<string> {
  const authUrl =
    `${instanceUrl}/oauth/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
    }).toString();

  const result = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!result) throw new Error('Mastodon login was cancelled.');

  const code = new URL(result).searchParams.get('code');
  if (!code) throw new Error('Mastodon did not return an authorization code.');
  return code;
}

async function exchangeCodeForToken(
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${instanceUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}).`);
  const json = (await res.json()) as { access_token: string };
  if (!json.access_token) throw new Error('Token exchange returned no access_token.');
  return json.access_token;
}

export const mastodonAdapter: PlatformAdapter = {
  id: 'mastodon',
  displayName: 'Mastodon',
  characterLimit: 500,
  mediaSupport: {
    maxImages: 4,
    maxVideoSeconds: 60,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  },

  async authenticate(params): Promise<AccountCredentials> {
    if (!params.instanceUrl) throw new Error('instanceUrl required');
    const instanceUrl = normalizeInstanceUrl(params.instanceUrl);
    const redirectUri = chrome.identity.getRedirectURL();
    const app = await registerOrGetApp(instanceUrl, redirectUri);
    const code = await launchOAuth(instanceUrl, app.clientId, redirectUri);
    const accessToken = await exchangeCodeForToken(
      instanceUrl,
      app.clientId,
      app.clientSecret,
      redirectUri,
      code,
    );
    const c = client({ instanceUrl, accessToken });
    const me = await c.v1.accounts.verifyCredentials();
    const host = new URL(instanceUrl).host;
    return {
      platformId: 'mastodon',
      accountId: crypto.randomUUID(),
      displayName: `@${me.acct}@${host}`,
      data: { instanceUrl, accessToken } as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      const status = await c.v1.statuses.create({ status: content.text });
      return { success: true, url: status.url ?? '', remoteId: status.id };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      await c.v1.accounts.verifyCredentials();
      return true;
    } catch {
      return false;
    }
  },

  async getStatus(credentials) {
    try {
      const c = client(credentials.data as unknown as MastodonSessionData);
      await c.v1.accounts.verifyCredentials();
      // Mastodon access tokens issued via OAuth are typically non-expiring
      // (no expires_in on the token response). We surface that explicitly
      // so the popup doesn't claim a missing expiry is a problem.
      return {
        ok: true,
        severity: 'green',
        message: 'Mastodon session healthy. Token does not expire.',
      };
    } catch (err) {
      return {
        ok: false,
        severity: 'red',
        message: `Mastodon check failed: ${String(err).slice(0, 120)}`,
      };
    }
  },
};
