// Mastodon supports dynamic app registration: any caller can POST /api/v1/apps
// to get a client_id + client_secret, no admin approval required. We register
// CrossPosty once per instance and cache the registration so each subsequent
// login skips straight to the authorize step.

export type MastodonApp = {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

const KEY = 'mastodonApps';

type AppMap = Record<string, MastodonApp>; // keyed by instanceUrl (normalized)

async function loadAll(): Promise<AppMap> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as AppMap | undefined) ?? {};
}

export async function loadMastodonApp(instanceUrl: string): Promise<MastodonApp | null> {
  const all = await loadAll();
  return all[instanceUrl] ?? null;
}

export async function saveMastodonApp(app: MastodonApp): Promise<void> {
  const all = await loadAll();
  all[app.instanceUrl] = app;
  await chrome.storage.local.set({ [KEY]: all });
}
