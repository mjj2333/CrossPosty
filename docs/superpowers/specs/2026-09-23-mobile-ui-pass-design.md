# CrossPosty Mobile — UI/UX pass (design)

**Date:** 2026-09-23
**Scope:** look and feel of the existing PWA (`C:\Users\drice\CrossPosty-mobile\app`), plus the post-now result display. No flow changes, no new features.
**Decided with the visual companion:** direction **C (dark bold)**, post result **A (inline result card)**, icon **B (amber serif monogram)**.

## 1. Visual system

One theme, dark. (A light theme is out of scope; the manifest and meta `theme-color` switch to the dark background.)

| Token | Value | Use |
|---|---|---|
| `bg` | `#0b0f19` | page background |
| `surface` | `#111827` | cards, inputs, chips |
| `surface-2` | `#1f2937` | borders, dividers, pressed states |
| `text` | `#e5e7eb` | primary text |
| `muted` | `#9ca3af` | secondary text, counters |
| `accent` | `#f59e0b` (hover `#fbbf24`) | primary buttons, active tab, links |
| `select` | `#1d4ed8` (border `#3b82f6`) | selected chips |
| `ok` | `#22c55e` | success ticks |
| `warn` | `#f59e0b` | warnings (same as accent, used with text) |
| `danger` | `#ef4444` | errors, destructive actions |

Typography: system sans (`-apple-system, Segoe UI, Roboto`), headings `font-extrabold tracking-tight` at 22 px, body 15–16 px (inputs stay ≥16 px to avoid iOS zoom), captions 12 px `muted`.

Shapes: cards and inputs `rounded-xl` (12 px), chips and buttons `rounded-lg` (10 px), tab bar flat with a top border. No shadows on dark (borders carry the structure). Tap targets stay ≥44 px.

Components (Tailwind classes in a small `ui/` folder so screens don't repeat them):
- **Button**: primary (amber fill, dark text, bold), ghost (amber outline/text), danger (red text), each with a disabled state at 40 % opacity and a busy label.
- **Chip** (target toggle): surface with border; selected = blue fill/border and white text; disabled = 40 %.
- **Input / Textarea**: surface, border `surface-2`, focus ring `select`.
- **Card**: surface + border.
- **Notice**: inline message with a coloured left border (ok / warn / danger) and an optional dismiss ×; replaces today's plain `<p>` messages everywhere.
- **Tab bar**: three items, active in amber with a 2 px top indicator; icons are simple inline SVG glyphs (pencil, list, person) above the label.
- **Screen header**: title at the top of each screen ("New post", "Queue", "Accounts").

## 2. Post-now result card

After a successful `Post now` call, the composer clears and a **result card** appears directly under the Schedule / Post now buttons:

```
┌ Posted · just now ───────────────── × ┐
│ ✓  Bluesky   @mjj2323.bsky.social  Open › │
│ ✓  X         @Drice4523            Open › │
└──────────────────────────────────────────┘
```

- One row per target: green tick + platform + handle + `Open ›` (the post URL, opens in a new tab); or a red ✕ + platform + the error text (wrapped, muted) and no link.
- Header text: `Posted` when all sent, `Partly posted` when mixed, `Not posted` when all failed. Timestamp `just now`.
- "Already sending" and "still sending" outcomes render as a single amber row: *Still sending — check the Queue in a moment* with a `Queue ›` link.
- The card dismisses on × or as soon as the user types in the composer. It never appears for Schedule (that path navigates to the Queue as today).
- Replaces the current `<pre>` message block; other Compose messages (offline, validation) become Notices.

## 3. Icon

Amber gradient tile (`#f59e0b → #d97706`, 135°), lower-case serif **cp** (Georgia/Times, bold) in `#0b0f19`, centred, occupying ~60 % of the width. Delivered as `icon-512.png`, `icon-192.png`, `apple-touch-icon.png` (180, no rounded corners — iOS applies its own mask), and a maskable 512 variant with extra padding. Source kept as `app/public/icon.svg`. Manifest `theme_color` and `background_color` become `#0b0f19`; `index.html` `theme-color` likewise.

## 4. Screen-by-screen

- **Sign in**: centred card on the dark background, monogram above the title, the two-step form in the new inputs/buttons. "This app is private." as a danger Notice.
- **Compose**: header "New post"; textarea card; image thumbnails as 64 px rounded tiles with a small ✕ and the alt field beneath each; target chips; variant editors as collapsible rows inside a card; time picker as a surface row; the two buttons; result card / notices below.
- **Queue**: header with a Refresh icon button; each post a card: first line of text (2-line clamp), a status pill (Scheduled amber / Sent green / Failed red / Draft muted) and the relative time; per-platform rows with tick/✕ and Open; actions as ghost/danger text buttons in a row. Empty state: "Nothing scheduled. Compose something."
- **Accounts**: each section a card with a header; connected accounts show a green dot + handle; Connect X / Connect are primary buttons; disconnect/remove are danger text; Notifications toggle as a switch; Mentions rows in the new inputs; People list with member/admin pills; Sign out as a ghost button at the bottom.
- **X callback**: same centred-card treatment as Sign in.

## 5. Out of scope

Light theme, animations beyond 150 ms transitions, any change to flows or data, drafts persistence, thumbnails in the Queue (needs signed URLs; later if wanted).

## 6. Verification

`npm run build`, `npm test`, `npx oxlint` green; a desktop pass in Chrome's phone emulation for each screen; then the phone: install fresh (icon renders), sign in, compose with an image, Post now (result card), a failure case (result card with ✕), Queue, Accounts.
