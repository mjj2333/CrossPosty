# CrossPosty Mobile — Plan 6: UI/UX Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the PWA to the approved dark visual system, replace the post-now text dump with a result card, and ship the amber monogram icon. No flow or data changes.

**Architecture:** Tailwind theme tokens in `tailwind.config.js`; a small `src/ui/` folder of presentational components (`Button`, `Chip`, `Card`, `Notice`, `Input`, `Textarea`, `Pill`, `ScreenHeader`) that screens compose; a `PostResultCard` component fed by the existing `postNow` result; icons regenerated from an SVG source. Screens keep their state and handlers; only markup/classes change.

**Tech Stack:** existing Vite 8 / React 19 / Tailwind 3 app in `C:\Users\drice\CrossPosty-mobile\app`. Verification: `npm run build`, `npm test` (6), `npx oxlint`; desktop check in Chrome phone emulation; phone check.

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-ui-pass-design.md`. **Repo HEAD:** `ee5cd92`.

---

## File structure

```
app/tailwind.config.js            # tokens
app/src/index.css                 # dark body, focus ring, transitions
app/index.html                    # theme-color #0b0f19
app/vite.config.ts                # manifest colours, maskable icon
app/public/icon.svg + icon-512.png, icon-192.png, icon-maskable-512.png, apple-touch-icon.png
app/scripts/make-icons.mjs        # renders the PNGs from icon.svg (sharp)
app/src/ui/Button.tsx, Chip.tsx, Card.tsx, Notice.tsx, Input.tsx, Pill.tsx, ScreenHeader.tsx, index.ts
app/src/components/PostResultCard.tsx (+ test of the header/rows mapping)
app/src/components/TabBar.tsx     # extracted from App.tsx, with glyphs
app/src/screens/*.tsx             # restyled
app/src/components/{ImagePicker,TargetToggles,VariantEditor,PostCard}.tsx  # restyled
```

---

### Task 1: Tokens, base styles, UI primitives

- [ ] **`tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0f19',
        surface: { DEFAULT: '#111827', 2: '#1f2937' },
        ink: { DEFAULT: '#e5e7eb', muted: '#9ca3af' },
        accent: { DEFAULT: '#f59e0b', hover: '#fbbf24' },
        select: { DEFAULT: '#1d4ed8', ring: '#3b82f6' },
        ok: '#22c55e',
        danger: '#ef4444',
      },
      borderRadius: { xl: '12px', lg: '10px' },
    },
  },
  plugins: [],
};
```

- [ ] **`src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { @apply bg-bg text-ink antialiased; padding-bottom: env(safe-area-inset-bottom); }
textarea, input, button, select { font-size: 16px; } /* stops iOS zoom on focus */
input[type="datetime-local"] { color-scheme: dark; }
:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
* { transition: background-color 150ms, border-color 150ms, color 150ms, opacity 150ms; }
```

- [ ] **`src/ui/`** — one file each, all `export function`, props typed, `className` passthrough:

```tsx
// Button.tsx
import type { ButtonHTMLAttributes } from 'react';
type Variant = 'primary' | 'ghost' | 'danger' | 'quiet';
const styles: Record<Variant, string> = {
  primary: 'bg-accent text-bg font-semibold hover:bg-accent-hover',
  ghost: 'border border-accent text-accent font-semibold',
  danger: 'text-danger',
  quiet: 'text-ink-muted',
};
export function Button({ variant = 'primary', busy, className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: string }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || Boolean(busy)}
      className={`min-h-[44px] px-4 rounded-lg inline-flex items-center justify-center disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {busy ?? children}
    </button>
  );
}
```

```tsx
// Chip.tsx — the target toggle
export function Chip({ on, disabled, title, sub, onClick }: { on: boolean; disabled?: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      className={`flex-1 min-h-[52px] rounded-lg border px-3 py-2 text-left disabled:opacity-40 ${on ? 'bg-select border-select-ring text-white' : 'bg-surface border-surface-2 text-ink'}`}
    >
      <div className="font-semibold">{title}</div>
      <div className={`text-xs ${on ? 'text-blue-100' : 'text-ink-muted'}`}>{sub}</div>
    </button>
  );
}
```

```tsx
// Card.tsx
import type { HTMLAttributes, ReactNode } from 'react';
export function Card({ title, action, children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { title?: string; action?: ReactNode }) {
  return (
    <section {...rest} className={`bg-surface border border-surface-2 rounded-xl ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between px-4 pt-3 pb-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
```

```tsx
// Notice.tsx
import type { ReactNode } from 'react';
const tone = { ok: 'border-ok', warn: 'border-accent', danger: 'border-danger', info: 'border-select-ring' };
export function Notice({ kind = 'info', onDismiss, children }: { kind?: keyof typeof tone; onDismiss?: () => void; children: ReactNode }) {
  return (
    <div role="status" className={`flex items-start gap-3 bg-surface border-l-4 ${tone[kind]} rounded-lg px-3 py-2 text-sm`}>
      <div className="flex-1 whitespace-pre-wrap">{children}</div>
      {onDismiss && <button type="button" aria-label="Dismiss" onClick={onDismiss} className="min-h-[44px] -my-2 px-2 text-ink-muted">×</button>}
    </div>
  );
}
```

```tsx
// Input.tsx — Input and Textarea with the same look
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
const base = 'w-full bg-surface border border-surface-2 rounded-xl px-3 py-3 text-ink placeholder:text-ink-muted focus:border-select-ring';
export function Input(p: InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={`${base} ${p.className ?? ''}`} />; }
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={`${base} ${p.className ?? ''}`} />; }
```

```tsx
// Pill.tsx — status pill
const tones = { scheduled: 'bg-accent/15 text-accent', done: 'bg-ok/15 text-ok', failed: 'bg-danger/15 text-danger', draft: 'bg-surface-2 text-ink-muted', posting: 'bg-select/20 text-blue-200' };
export function Pill({ status }: { status: keyof typeof tones }) {
  const label = { scheduled: 'Scheduled', done: 'Sent', failed: 'Failed', draft: 'Draft', posting: 'Sending' }[status];
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${tones[status]}`}>{label}</span>;
}
```

```tsx
// ScreenHeader.tsx
import type { ReactNode } from 'react';
export function ScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h1 className="text-[22px] font-extrabold tracking-tight">{title}</h1>
      {action}
    </div>
  );
}
```

`index.ts` re-exports all of them. Tailwind's `bg-ok/15` opacity syntax works with the hex tokens above.

- [ ] Build green; commit `feat(ui): dark theme tokens and UI primitives`.

---

### Task 2: App shell, tab bar, Sign in, X callback

- [ ] **`components/TabBar.tsx`**: extracted from `App.tsx`; three items with inline SVG glyphs (pencil, list, person; 20 px, `stroke="currentColor"`), label under the glyph, active item `text-accent` with a 2 px `bg-accent` bar at the top of the item; container `bg-bg border-t border-surface-2`, safe-area padding kept. App keeps its state; `main` gets `px-4 pt-4 pb-28`.
- [ ] **`SignIn.tsx`**: dark background; a `Card` centred (`max-w-sm mx-auto mt-16`) with the monogram (`<img src="/icon-192.png" className="w-14 h-14 rounded-xl mx-auto mb-3" />`), the title, the two-step form using `Input`/`Button`; errors as `Notice kind="danger"`, the "check your email" hint as `Notice kind="info"`.
- [ ] **`XCallback.tsx`**: same centred `Card`; working/ok/error as Notices; `Button` back.
- [ ] Build, oxlint; commit `feat(ui): app shell, tab bar, sign-in and callback screens`.

---

### Task 3: Compose + result card

- [ ] **`components/PostResultCard.tsx`** with a pure mapping function and a test:

```ts
// mapping (exported for the test)
import type { Platform, PostRow } from '../lib/types';
export type ResultRow = { platform: Platform; handle?: string; ok: boolean; url?: string; error?: string };
export function summarize(targets: Platform[], results: PostRow['results'], handles: Partial<Record<Platform, string>>) {
  const rows: ResultRow[] = targets.map((p) => {
    const r = results[p];
    return { platform: p, handle: handles[p], ok: r?.state === 'sent', url: r?.url, error: r?.state === 'sent' ? undefined : (r?.error ?? 'No response') };
  });
  const okCount = rows.filter((r) => r.ok).length;
  const title = okCount === rows.length ? 'Posted' : okCount === 0 ? 'Not posted' : 'Partly posted';
  return { title, rows };
}
```

Test (`PostResultCard.test.ts`, vitest): all sent → 'Posted' with urls; one failed → 'Partly posted' and the error on that row; none → 'Not posted'.

Component: `PostResultCard({ title, rows, pending?: boolean, onDismiss })` renders a `Card` with header `title · just now` and ×; rows as `✓` (ok, `bg-ok text-bg` 20 px circle) or `✕` (`bg-danger`), `LABEL[platform]` bold, handle muted, `Open ›` link (`text-accent font-semibold`, `target="_blank" rel="noreferrer"`) or the error text muted; `pending` renders the single amber row *Still sending — check the Queue in a moment* with a `Queue ›` link (`/?tab=queue`).

- [ ] **`Compose.tsx`**: `ScreenHeader "New post"`; textarea in a `Card`; `ImagePicker` restyled (64 px tiles, ✕ overlay, alt `Input` under each, the add tile dashed `border-surface-2`); `TargetToggles` uses `Chip` (sub text = the existing hints); `VariantEditor` rows inside a `Card` titled "Per-platform text"; time row as a surface `Input type=datetime-local`; `Button`s; replace the `<pre>` message with: result state → `PostResultCard`; other messages → `Notice`. Handles for the card come from `accounts` already loaded. The card is cleared by `onChange` of the textarea or ×.
- [ ] Build, test (7), oxlint; commit `feat(ui): compose screen with post result card`.

---

### Task 4: Queue and Accounts

- [ ] **`PostCard.tsx`**: `Card` with top row `Pill status` + relative time (muted) + image count; text `line-clamp-2`; per-platform rows (tick/✕ + label + `Open ›` or error muted, dropped mentions amber); action row of `Button variant="quiet"/"danger"` (edit, cancel, retry, delete) with the existing gating.
- [ ] **`Queue.tsx`**: `ScreenHeader "Queue"` with a refresh icon `Button variant="quiet"`; group headings as muted uppercase `text-xs tracking-wide`; notices via `Notice`; empty state centred muted text.
- [ ] **`Accounts.tsx`**: each section a `Card` with `title`: Bluesky, X, Notifications (toggle rendered as a `role="switch"` button: 44×26 track, `bg-select` when on), Default targets (`Chip`s), Mentions (`Input`s per row, add/save `Button`s), People (list with `Pill`-like member/admin tags, remove danger, invite `Input` + `Button`), then `Button variant="ghost"` Sign out. Connected state shows a green dot before the handle. Messages via `Notice` inside their section.
- [ ] Build, oxlint; commit `feat(ui): queue and accounts screens`.

---

### Task 5: Icon and manifest

- [ ] `app/public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#d97706"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <text x="256" y="340" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="300" fill="#0b0f19">cp</text>
</svg>
```

- [ ] `app/scripts/make-icons.mjs` using `sharp` (dev dep): render 512, 192, 180 (apple), and a maskable 512 where the artwork is scaled to 80 % on the same gradient. Add `"icons": "node scripts/make-icons.mjs"` to package.json scripts and run it. If font rendering of the SVG text is unreliable in sharp (no Georgia on the machine), fall back to rendering with System.Drawing in PowerShell as Plan 3 did, using `Georgia` bold at ~60 % of the tile.
- [ ] `vite.config.ts` manifest: `theme_color: '#0b0f19'`, `background_color: '#0b0f19'`, icons array adds `{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }`. `index.html` `theme-color` → `#0b0f19`; add `<meta name="mobile-web-app-capable" content="yes">` alongside the apple one.
- [ ] Build; commit `feat(ui): amber monogram icon, dark manifest colours`.

---

### Task 6: Deploy and check

- [ ] Desktop: `npm run dev`, Chrome device emulation (iPhone 14), walk every screen; fix anything obviously off.
- [ ] Deploy (same commands as Plan 3 Task 8 with the four `VITE_*` vars); push.
- [ ] Phone: remove the old home-screen icon and add it again (icons only refresh on re-add); sign in; compose with an image; Post now → result card; force a failure (duplicate X text) → result card with ✕; Queue; Accounts. Report anything off for a follow-up.

---

## Self-review

**Spec coverage:** tokens/typography/shapes ✔ T1; components ✔ T1; result card with Posted/Partly/Not posted, pending row, dismiss on typing ✔ T3; icon + manifest ✔ T5; every screen ✔ T2–T4; verification ✔ T6. Out-of-scope items untouched.

**Placeholders:** the screen restyles are described by component and class rather than full JSX, deliberately: the screens' logic exists and the implementer edits markup in place; the primitives that define the look are given in full.

**Type consistency:** `Chip` props match what `TargetToggles` computes today (`on`, `disabled`, title, sub); `summarize` consumes `PostRow['results']` and the `targets` array exactly as `Compose` has them; `Pill` statuses match `PostStatus`.
