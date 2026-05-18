import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'CrossPosty',
    description:
      'Cross-post natively from X and BlueSky to BlueSky, Mastodon, and LinkedIn.',
    permissions: ['storage', 'cookies', 'scripting', 'identity', 'alarms', 'offscreen'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://bsky.app/*',
      'https://bsky.social/*',
      'https://www.linkedin.com/*',
    ],
    // Mastodon is federated — instance hostname not known until login time.
    // Popup calls chrome.permissions.request() with the typed instance before
    // kicking off OAuth. User sees a one-time per-instance allow prompt.
    optional_host_permissions: ['https://*/*'],
    web_accessible_resources: [
      {
        resources: ['/inject-fetch-hook.js'],
        matches: ['*://x.com/*', '*://bsky.app/*'],
      },
    ],
  },
});
