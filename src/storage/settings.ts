import { DEFAULT_SETTINGS, type UserSettings } from './schema';

const KEY = 'settings';

export async function loadSettings(): Promise<UserSettings> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as UserSettings | undefined) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
