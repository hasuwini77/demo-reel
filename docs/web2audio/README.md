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

## Real product facts used, and where they came from

- **Extension description** — "Convert any webpage into an AI-powered audio summary with premium text-to-speech voices" — `manifest.json` in the private repo `hasuwini77/Web2Audio` (`gh api repos/hasuwini77/Web2Audio/contents/manifest.json`).
- **Voice names** — Schedar, Leda, Aoede, Charon, Fenrir, Kore, Puck, Orus — `src/window/views/console/ControlRail.tsx` (`VOICES` array, Chirp3-HD Google TTS voices), same repo. Cross-checked against the iOS app's own real screenshots (`web2audio-ios/screenshots/iphone/02-library.png`, `03-player.png`), which show "Schedar · HD voice", "Fenrir · HD voice", "Aoede · HD voice", "Leda · HD voice" — so "HD voice" (not "premium voice") is the product's actual on-screen wording, used verbatim in `phone.html`.
- **Summary length options** — Brief / Standard / Detailed — same `ControlRail.tsx`.
- **Studio Console UI structure and exact design tokens** (colors as oklch, Hanken Grotesk + Martian Mono, radii, durations, shadow, easing) — `src/index.css` `@theme` block, `src/window/views/ConsoleView.tsx`, `ControlRail.tsx`, `TopBar.tsx`, `components/ui/Transport.tsx` (all in the private repo). The transport states (`idle`/`loading`/`playing`/`paused`/`idle-after-play`/`error`) and their aria-labels ("Play this page", "Preparing audio", "Pause", "Resume", "Replay from where you left off") are copied verbatim from `Transport.tsx`'s `STATE_ARIA` map and `useConsolePlayer.ts`.
- **iOS app screens** — Library row layout (title, relative time, voice·HD voice, duration) and Player layout (240×240 gradient artwork with a fixed 15-bar waveform placeholder, scrubber with elapsed/-remaining, ±15s skip, large play/pause circle, uppercase "SUMMARY" section) — `web2audio-ios/Sources/Library/LibraryView.swift` and `Sources/Player/PlayerView.swift`, confirmed pixel-for-pixel against the real screenshots in `web2audio-ios/screenshots/iphone/`.
- **"Synced from Chrome" / companion-device copy** — `web2audio-ios/Sources/Onboarding/CompanionGuideView.swift`: "Web2Audio turns articles into natural audio. Create it with the Chrome extension on your computer — it lands here to play anywhere" and "Your library syncs to this app for listening on the go." Confirms the product genuinely syncs extension → app, so the `phone.html` "Synced from Chrome" pill is accurate, not invented.
- **Brand mark** — the amber ring + pause-bars icon — `web2audio-ios/branding/brand-mark.svg` and the extension's own `public/icon_128.png`/`icon_32.png` (vendored into `assets/`), both from the sources above.
- **Tagline / CTA wording** — "Any webpage. Audio in one click." and "Add to Chrome — free" — fetched from the public site `https://www.web2audio.com`.
- **Fonts** — Hanken Grotesk (400/500/600) + Martian Mono (600), both SIL Open Font License, vendored as `.woff2` in `assets/fonts/` (downloaded once from Google Fonts, zero runtime network calls). Same two families the product itself uses (`src/index.css`).

## What's weakest

The extension "popup" is modeled on the real product's **Studio Console** (an
extension-opened window, not a tiny toolbar dropdown) because that's the
actual, current UI in the source — but staged here as a toolbar-anchored
dropdown for the demo, which is a slightly different presentation than how the
real extension opens it (a separate window). Everything inside the panel is
otherwise faithful.
