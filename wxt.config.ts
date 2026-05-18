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
    permissions: ['storage', 'cookies', 'scripting', 'identity', 'alarms', 'offscreen'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://upload.twitter.com/*',
      'https://upload.x.com/*',
      'https://bsky.app/*',
      'https://bsky.social/*',
      'https://*.bsky.network/*',
      'https://www.linkedin.com/*',
    ],
    // Mastodon is federated — instance hostname not known until login time.
    // Popup calls chrome.permissions.request() with the typed instance before
    // kicking off OAuth. User sees a one-time per-instance allow prompt.
    optional_host_permissions: ['https://*/*'],
    // No web_accessible_resources needed — fetch-hook is now a MAIN-world
    // content script declared in the manifest (see entrypoints/main-world.content.ts).
  },
});
