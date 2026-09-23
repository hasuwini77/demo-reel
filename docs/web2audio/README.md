# Web2Audio promo reel — static mock scenes

Three self-contained, zero-network HTML scenes for a Web2Audio promo reel. Each
page has no external requests at runtime (verified with a Playwright
`page.on('request')` listener — see below); fonts and icons are vendored in
`./assets/`. All visible animation is driven by `requestAnimationFrame` +
`performance.now()` (see `assets/transport.js`) — never `setTimeout`/`setInterval`
— so the demo-reel recorder's virtual clock can drive it deterministically.

## Scenes

### `browser.html` — Chrome window + extension popup
A faux Chrome window (tab strip, URL bar, extensions/puzzle icon, Web2Audio
toolbar icon) over a long-read article on an invented publication ("The Quiet
Ledger", byline "Mira Holt"). Clicking the toolbar icon opens the Studio
Console popup, styled and copy-matched to the real extension:

**Flow:** click toolbar icon → popup opens (idle) → click the transport circle
→ "Preparing audio" (loading, ring spins, ~1.4s) → playing (amber ring fills,
timecode counts up, glow) → pause/resume → skip ±15s → cycle speed → pick a
voice chip → open the transcript disclosure → scrub near the end → "DONE" /
idle-after-play ("Replay from where you left off").

Sized for both 1776×936 (recorder default, with padding) and 1920×1080.

### `phone.html` — iPhone running the Web2Audio app
A CSS iPhone (dynamic island, status bar, side buttons) showing the Library
(synced from Chrome — the same essay that was just generated, plus two other
invented items) and, on tap, the full-screen Player (artwork/waveform, title,
voice, scrubber with elapsed/remaining, skip ±15, play/pause, Summary text).

**Flow:** Library loads → tap a row → player sheet slides up → tap play →
scrubber/timecode animate via rAF → tap the grabber to dismiss back to Library.

### `end.html` — end card
Logo mark + "Web2Audio" wordmark, the site's own tagline, "Add to Chrome —
free" and a hand-drawn (no hotlinked/official assets) "Download on the App
Store" badge, and `www.web2audio.com`. Static, no interaction. Clean at 1080p
and at 1776×936.

## Accessible names / selectors for a scenario

**browser.html**
- `page.getByRole('button', { name: 'Web2Audio — summarize this page' })` — toolbar icon, opens/closes the popup
- `page.getByRole('button', { name: 'Play this page' })` — idle transport (label becomes `Preparing audio` / `Pause` / `Resume` / `Replay from where you left off` per state)
- `page.getByRole('button', { name: 'Skip back 15 seconds' })` / `'Skip forward 15 seconds'`
- `page.getByRole('button', { name: /Playback speed/ })` — cycles 1× → 1.25× → 1.5×
- `page.getByRole('listbox', { name: 'Select voice' })` → `.getByRole('option', { name: 'Schedar' | 'Leda' | 'Aoede' | 'Charon' | 'Fenrir' | 'Kore' | 'Puck' | 'Orus' })`
- `page.getByRole('group', { name: 'Summary length' })` → `.getByRole('button', { name: 'Brief' | 'Standard' | 'Detailed' })`
- `page.getByRole('button', { name: 'Transcript' })` — `aria-expanded` disclosure
- `page.locator('#w2a-seek')` — scrub input (`role="slider"` via native `<input type=range>`)

**phone.html**
- `page.getByRole('listitem', { name: /The slow interest of doing one thing well/ })` — library row (opens player)
- `page.getByRole('button', { name: 'Play' })` (becomes `'Pause'` / `'Replay'`)
- `page.getByRole('button', { name: 'Skip back 15 seconds' })` / `'Skip forward 15 seconds'`
- `page.getByRole('button', { name: 'Account' })`

**end.html**
- `page.getByRole('button', { name: 'Add to Chrome — free' })`
- `page.getByRole('button', { name: 'Download on the App Store' })`

## Internal animation timings

- Popup/loading spin: indeterminate ring, ~1.4s (`LOADING_MS` in `assets/transport.js`) before the pipeline "completes" and playback starts.
- Track duration used throughout (browser popup, phone player, library row): 96s (`1:36`) — matches the product's own marketing screenshots.
- All state transitions (idle → loading → playing → paused/ended) and every visible progress update run inside a single `requestAnimationFrame` loop keyed off `performance.now()`; nothing timer-based drives anything on screen.
- Popup open/close, player sheet slide-up, chip/segment selection: CSS transitions, 120–400ms (`--w2a-duration-press/state/live` tokens in `assets/brand.css`), not JS-timed.

## Sourcing

UI, voice names and copy match the shipping Web2Audio extension and iOS app;
brand (colors, fonts, tagline, CTA wording, logo mark) comes from
web2audio.com. Fonts (Hanken Grotesk 400/500/600 + Martian Mono 600, both SIL
Open Font License) are vendored locally as `.woff2` in `assets/fonts/` for
zero runtime network requests.

## What's weakest

The extension "popup" is modeled on the real product's **Studio Console** (an
extension-opened window, not a tiny toolbar dropdown) because that's the
actual, current UI in the source — but staged here as a toolbar-anchored
dropdown for the demo, which is a slightly different presentation than how the
real extension opens it (a separate window). Everything inside the panel is
otherwise faithful.
