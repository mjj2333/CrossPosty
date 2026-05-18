import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // Note: ASCII-safety is enforced by scripts/ascii-safe-output.mjs, run as
  // a post-build step from the `build` npm script. Rolldown's charset option
  // doesn't currently escape noncharacters embedded in string literals (Dexie
  // ships a literal U+FFFF for IndexedDB range queries that Chrome rejects).
  manifest: {
    name: 'CrossPosty',
    description:
      'Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn.',
    // Deterministic extension ID so the chromiumapp.org redirect URI stays
    // stable across reloads. Required for BlueSky atproto OAuth — the
    // redirect URI is committed to client-metadata.json published on
    // GitHub Pages, and the extension ID is derived from this key.
    // Computed ID: mfhnecceaeljjgkaoijfdjhpedhhnjlg
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqKb24rB0e6Scm3MEmtmH5Gml4ahsSvMtLMrtkQ/+slJMHGtirC9TZpbKuEehuiem6rd0XUTooGjB0j4QMr1SD16ItON/ciszZ6NJJmqQ4fTsImvjj+QAMj3+6DE5nS1ARMiPp+X5/PLZCyy1+kROagdcBQhaZTx3rMxCXxeUx4fc3kAvXg4/5Le4giYLnS3aQ1SO/wn2mpchVZOtKzDuduEsYCXAIRmR/+ORVI5tAvwEpzVNpMvasmjKIWOx9wkhC/doQvU6JrJ+Hm3fvujPSvPpX//1WTRVmv2k/6FnMCfEBm9WXCvO3G1E3rtdvKX27y3oLczs2dEjIRAKEEYp9QIDAQAB',
    permissions: [
      'storage',
      'cookies',
      'scripting',
      'identity',
      'alarms',
      'offscreen',
      'declarativeNetRequest',
    ],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://upload.twitter.com/*',
      'https://upload.x.com/*',
      'https://bsky.app/*',
      'https://bsky.social/*',
      'https://*.bsky.network/*',
      'https://www.linkedin.com/*',
      'https://www.threads.net/*',
      'https://threads.net/*',
      'https://www.threads.com/*',
      'https://threads.com/*',
      'https://i.instagram.com/*',
    ],
    // Mastodon is federated — instance hostname not known until login time.
    // Popup calls chrome.permissions.request() with the typed instance before
    // kicking off OAuth. User sees a one-time per-instance allow prompt.
    optional_host_permissions: ['https://*/*'],
    // No web_accessible_resources needed — fetch-hook is now a MAIN-world
    // content script declared in the manifest (see entrypoints/main-world.content.ts).
  },
});
