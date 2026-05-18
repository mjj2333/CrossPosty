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
    web_accessible_resources: [
      {
        resources: ['/inject-fetch-hook.js'],
        matches: ['*://x.com/*', '*://bsky.app/*'],
      },
    ],
  },
});
