# Installing CrossPosty (closed tester build)

CrossPosty isn't on the Chrome Web Store yet. This guide walks you
through installing the development build from a ZIP file you've been
sent.

## What you need

- Google Chrome (or any Chromium-based browser: Brave, Edge, Arc, Vivaldi).
- The CrossPosty ZIP file (`crosspost-ext-X.Y.Z-chrome.zip`).

## Install (Mac)

1. Save the ZIP somewhere you can find it (Downloads is fine).
2. Double-click the ZIP to unzip. You'll get a folder called
   `chrome-mv3` (or similar).
3. Open Chrome. In the URL bar, type `chrome://extensions` and press
   Enter.
4. **Top-right corner: toggle "Developer mode" ON.**
5. Three new buttons appear at top-left. Click **Load unpacked**.
6. Pick the unzipped `chrome-mv3` folder and click **Select**.
7. CrossPosty appears in your extension list. The icon shows in the
   toolbar (click the puzzle-piece icon to pin it for easy access).

## Install (Windows)

1. Save the ZIP somewhere you can find it.
2. Right-click the ZIP → **Extract All** → confirm. You'll get a
   folder called `chrome-mv3`.
3. Open Chrome. Paste `chrome://extensions` into the URL bar.
4. **Top-right corner: toggle "Developer mode" ON.**
5. Click **Load unpacked** (appears top-left).
6. Pick the unzipped `chrome-mv3` folder and click **Select Folder**.
7. CrossPosty appears in your extension list. Pin its icon via the
   puzzle-piece menu in Chrome's toolbar.

## First-time setup

Click the CrossPosty icon in the toolbar to open the popup.

1. **Add accounts** for the platforms you want to cross-post to (X,
   BlueSky, Threads, Mastodon, Substack, LinkedIn). Follow the
   per-platform instructions in the popup — most use your existing
   logged-in session in this browser, so make sure you're signed in
   to each platform before clicking Connect.
2. **(Optional) Pair a phone** if you want to compose on mobile.
   Click "phone pairing" in the popup, hit "pair phone," then on your
   phone open `https://crossposty-phone.netlify.app` and scan the QR.
3. **(Optional) Handle mappings** lets you maintain a translation
   table so `@yourhandle` on X auto-becomes `@yourhandle.bsky.social`
   on BlueSky, etc.

## Using it

Cross-post natively:

1. Compose a post the normal way on x.com, bsky.app, threads.com, or
   substack.com.
2. When you submit, a small CrossPosty panel appears overlaid on the
   page showing your other connected accounts as destinations.
3. Edit per-platform text if you want, untoggle anything you don't
   want, hit **Cross-post**.

Cross-post from your phone (if paired):

1. Open `https://crossposty-phone.netlify.app` on your phone.
2. Type your post, attach images if you want, hit Send.
3. Within ~30 seconds, a tab opens on your desktop and either
   auto-posts to all destinations (default) or shows the composer for
   review (configurable in the popup under "phone pairing").

## Troubleshooting

- **"Manifest file is missing or unreadable" on load:** you selected
  the ZIP file, not the unzipped folder. Unzip first, then point
  Chrome at the folder that contains `manifest.json`.
- **The CrossPosty icon doesn't appear:** click the puzzle-piece icon
  next to your Chrome toolbar; CrossPosty is in the list. Click the
  pin icon next to it.
- **An account's status dot is yellow or red:** open the popup, hover
  the dot for an explanation. Common: you need to post once natively
  on that platform so CrossPosty can learn the current request shape.
- **A cross-post fails with a confusing error:** open
  `chrome://extensions`, find CrossPosty, click "service worker" to
  open its console. The error usually has a clear message there.

## Updates

Updates are manual for now (no auto-update outside the Chrome Web
Store). When you receive a new ZIP:

1. Unzip it (overwrite the old folder if you used the same name, or
   keep both versions and load the new folder).
2. In `chrome://extensions`, click the reload icon (↻) on the
   CrossPosty card.

If the ZIP was extracted into a brand-new folder, you can also click
"Remove" on the old version and "Load unpacked" on the new one.

## Privacy

CrossPosty runs locally in your browser. Your account credentials
(cookies, OAuth tokens) never leave your machine. The phone pairing
relay encrypts content end-to-end with a key only your extension and
phone hold — the relay server only ever sees ciphertext.

## Reporting issues

Email the developer or hit the project repo on GitHub
(github.com/mjj2333/CrossPosty). Include:

- What you were doing
- What you expected
- What actually happened
- A copy of the relevant lines from the service worker console
  (`chrome://extensions` → CrossPosty → "service worker")
