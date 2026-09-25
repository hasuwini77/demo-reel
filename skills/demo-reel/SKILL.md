---
name: demo-reel
description: Record a smooth, frame-exact 60 fps demo video of any web app from a short script — scripted cursor (arrow, hand, dot…) with a halo, click effects, smooth zooms, highlighters (box, circle, spotlight, marker), captions and a corner badge, rendered on a virtual clock so it never stutters, encoded to an MP4 that loops in PowerPoint, Keynote or on the web. Use when the user wants a demo video, product walkthrough, screen recording, feature tour, before/after comparison video, a clip for a slide deck or landing page, or says "record the app", "make a video of", "screen capture", "show how it feels", "demo reel". Also for turning a Playwright flow into a video or making an existing recording smoother (60 fps).
---

# demo-reel

Turn a scripted walk through a web app into a video that looks like a polished screen recording: smooth 60 fps motion, a visible cursor with a halo, click ripples, captions. It drives the **real app** in headless Chromium — the footage is the product, not a mock-up.

## Why the video is smooth

A normal screen recording captures frames when the browser happens to paint; on a slow machine (or software WebGL) that is ~10–15 fps and it stutters. demo-reel instead injects a **virtual clock** (`scripts/inject.js`): `requestAnimationFrame`, `performance.now` and `Date` only advance when the recorder says so, and CSS/Web animations are stepped via `document.getAnimations()`. Each frame is advanced exactly 1/fps, screenshotted, and piped into ffmpeg. However long a frame takes to render, the result plays back perfectly smooth.

Timers (`setTimeout`/`setInterval`) are deliberately left real — faking them makes zero-delay timer chains in loaders and schedulers spin forever (this is why Playwright's own `page.clock` hangs on many WebGL pages).

## Requirements

- Node 18+, **ffmpeg** on PATH.
- Once, in this skill's directory: `npm install && npx playwright install chromium`.

## Workflow

1. **Serve the app** the way users see it — ideally a production build (`vite build && vite preview`, `next build && next start`) against local or mock data. Dev servers work but are slower and may show dev overlays. **Never record real or sensitive data** — seed demo data.
2. **Write a scenario** (`*.scenario.mjs`, see API below). Start from `examples/tasks.scenario.mjs`. Plan it as a story: 20–60 s, one idea per caption, 1–2 s holds after each result so viewers can read it.
3. **Record**: `node scripts/record.mjs my.scenario.mjs --out demo.mp4`
   A 60 s clip at 1080p takes roughly 3–10 min (heavy WebGL pages are slowest). Run it in the background.
4. **QA**: `scripts/sheet.sh demo.mp4` writes a contact sheet (one frame every 2.5 s). Look at it: captions match what is on screen, no loading spinners, nothing covered by the caption, badge/cursor visible. Spot-check smoothness by extracting a few consecutive frames — each should differ slightly during motion.
5. **Deliver** (see "Using the video").

## Scenario API

```js
export default {
  size: "1920x1080",          // output video size
  fps: 60,
  theme: { captionPosition: "bottom", accent: "#6366f1", cursorStyle: "auto" }, // optional, see Theme
  frame: true,                 // optional — rounded window + shadow on a background, see Frame
  async run(d) {
    await d.open("http://localhost:4173/");     // navigate + settle (not recorded)
    d.badge("NEW", "#15803d");                  // corner badge (null hides)
    d.caption("The new dashboard");             // caption pill (null hides)
    await d.hold(1500);                          // record 1.5 s as-is
    await d.click(d.page.getByRole("button", { name: "Filters" }));
    await d.zoom("#filters");                  // ease in; the camera follows the cursor
    d.caption("Filters live in one panel");     // set captions AFTER the action
    await d.hold(1200);
    await d.type("Stockholm");                  // human-speed typing
    await d.press("Enter");
    await d.highlight(".results", { style: "box", ms: 1500 });
    await d.zoom(null);                         // ease back out
    await d.scroll(600);                        // smooth wheel scroll
    await d.step("optional part", async () => { /* failures are logged, recording continues */ });
  },
};
```

| Call | Does |
|---|---|
| `d.open(url, { settle, prewarm })` | Navigate, let the page settle (unrecorded, default 2500 ms), wait for fonts, load + decode every image; `prewarm` (default on) scrolls to the bottom and back unrecorded so lazy content is in before the first recorded scroll. |
| `d.hold(ms)` | Record the page as it is. |
| `d.settle(ms)` | Advance time **without** recording — skip loading states, lazy chunks, layout animations you don't want to show. |
| `d.move(target, { ms })` / `d.hover` | Glide the cursor to a target. Without `ms` the duration follows the distance (320–1100 ms); spring-eased, slightly arced, motion-blurred. |
| `d.click(target, { ms, button })` | Move, click with a ripple. `button: "right"` for context menus. |
| `d.doubleClick(target)` | Double click. |
| `d.type(text, { delay })` | Type one key at a time (default 90 ms/key). |
| `d.press(key)` | Keyboard shortcut, e.g. `"Escape"`, `"Control+K"`. |
| `d.scroll(dy, { ms })` | Smooth wheel scroll. |
| `d.zoom(target, { scale, ms, follow })` | Ease the camera onto a target (boxes are framed to fit, max 1.8×), then follow the cursor. Non-blocking — plays over the next moves/holds. `d.zoom(null)` eases out. |
| `d.highlight(target, { style, color, pad, ms })` | Mark a target: `box`, `circle`, `spotlight`, `underline`, `marker`. Clears after `ms`, or all at once with `d.highlight(null)`. |
| `d.caption(text)` / `d.badge(text, color)` / `d.cursor(bool \| style)` | Overlay state; survives full page navigations. `d.cursor("hand")` switches shape mid-take. |
| `d.say(text, { wait })` | Voice-over from this frame (needs `voice`, see Voice-over). Returns `{ at, dur }` at once; `wait: true` holds until the clip ends. |
| `d.step(name, fn)` | Named step; errors are logged, not fatal. |
| `d.page`, `d.point(target)`, `d.width`, `d.height` | Escape hatches. |

**Theme** (all optional): `accent` (one colour for halo, click effect and highlights), `cursorStyle` (`arrow` · `mac` · `hand` · `ibeam` · `dot` · `auto` = hand over links/buttons, I-beam over text fields), `cursorSize` (34), `halo` (true), `haloStyle` (`fill` · `ring` · `glow`), `haloSize`, `haloFill`, `haloStroke`, `clickStyle` (`ripple` · `ring` · `pulse` · `none`), `caret` (true: the text caret is drawn on the virtual clock — solid while typing, then a steady blink; `false` keeps Chromium's, which flickers at random in the video), `cursorMotion` (`{ spring, arc, blur }`, all on; `false` turns all off — cubic ease, straight line, no blur), `autoZoom` (on by default; `false` turns it off, or `{ scale, ms, gap, dwell, minHold, clicks }` — defaults 1.35, 1400, 10000, 4000, 1500, false), `captionPosition`, `captionSize`, `badgeTop`, `font`.

**Frame**: `frame: true` sits the page in a rounded window with a soft shadow, inset on a wallpaper/gradient — omit it and output is unchanged. It costs nothing per frame (one plate image, composited by ffmpeg), and pairs well with zoom — the window stays put while the camera moves inside it.

| Key | Does |
|---|---|
| `background` | Any CSS `background` value (gradient, colour…) or a path to a local image (cover-fit). |
| `padding` | px inset on every side; the recorded page becomes `size - 2*padding`. |
| `radius` | Window corner radius, px. |
| `shadow` | `true` (soft default), `false`, or a CSS `box-shadow` string. |

**Zoom** re-renders the visible area at the zoom level (Chromium device-metrics emulation), so text stays sharp; the page never sees a resize and clicks still land where you aim. Camera moves ride a critically damped spring stepped once per frame — they always ease in and out. Captions and the badge keep their screen size; cursor and highlights zoom with the page.

**Auto-zoom** (default): a few gentle zooms without writing any — when typing starts (onto the field), and with `clicks: true` also on a click in the page body followed by a hold ≥ 1.5 s (onto the click; off by default because a click's result often opens elsewhere, e.g. a side panel). At most one per 10 s, 1.35×, slow; out again after 4 s or before a long cursor move. Clicks near the edges (toolbars, nav) never zoom — their result shows elsewhere. The first manual `d.zoom()` hands the camera to the scenario for the rest of the take.

**Targets** can be a Playwright `Locator`, a CSS selector string, `{ x, y }`, or an async function `(page) => ({ x, y })`.

**Canvas-rendered UIs** (graphs, maps, charts) have no DOM element per item — pass a function that asks the library for screen coordinates. Example for Cytoscape.js:

```js
const node = (label) => (page) => page.evaluate((label) => {
  const el = [...document.querySelectorAll("div")].find((e) => e._cyreg?.cy);
  const n = el._cyreg.cy.nodes().filter((n) => n.data("label") === label)[0];
  const r = el.getBoundingClientRect(), p = n.renderedPosition();
  return { x: r.left + p.x, y: r.top + p.y };
}, label);
await d.click(node("Server A"));
```

## Voice-over

Name a provider and the take gets an audio track; captions also become subtitles. Nothing is spoken unless the scenario names a provider — there is no key auto-detection, because cloud providers send the text off the machine.

```js
export default {
  voice: { provider: "kokoro", voice: "af_heart", speed: 1, captions: true }, // captions: true speaks every d.caption
  async run(d) {
    await d.say("Filters live in one panel.");                 // starts at this frame, doesn't hold
    await d.say("Results update as you type.", { wait: true }); // holds until the clip ends (+200 ms)
  },
};
```

| `provider` | Needs | Defaults |
|---|---|---|
| `kokoro` | `npm i kokoro-js` in the skill folder (~830 MB, CPU only; not installed by default). First use downloads the model (~80 MB). Local, free. | voice `af_heart`, `dtype: "q8"` |
| `elevenlabs` | `ELEVENLABS_API_KEY` in the environment | model `eleven_flash_v2_5` (`eleven_multilingual_v2` for quality), `voice` = voice id |
| `openai` | `OPENAI_API_KEY` in the environment | model `gpt-4o-mini-tts`, voice `alloy` |
| `piper` | `piper` on PATH, `model: "path/to/voice.onnx"` | — |
| `command` | `command: "my-tts --out {out} {text}"` (split on spaces, no shell) | writes a WAV to `{out}` |

- Keys are read from the environment only — never pass them as CLI arguments; they are never logged.
- Synthesis happens between frames, so it costs no video time. Clips are cached in `.demo-reel-cache/voice/` by provider, voice, model, speed and text: a re-take re-bills and re-synthesizes nothing (`voice: cache hit`).
- Clips never overlap: one that would start within 150 ms of the previous clip's end is moved later, with a warning. Give long lines `wait: true` or a longer `d.hold`.
- The clips are mixed under the untouched video (`-c:v copy`, AAC 160k, 48 kHz). No voice → the MP4 stays silent, as before.
- **Subtitles**: every take with captions also writes `<out>.srt` and `<out>.vtt` next to the MP4 — a line starts on the frame the caption was set and ends when it is replaced or cleared.

## Writing good demos

- **Captions tell the truth.** Only claim what the footage shows. If a bug you want to show doesn't reproduce in the take, change the caption — don't keep it.
- **Caption after the action**, not before — otherwise the caption for the next screen appears over the previous one.
- **Show outcomes, not clicks.** Hold 1–2 s on every result; cut loading with `d.settle`.
- **Before/after**: record two scenarios with the same story and steps, badge `BEFORE`/`AFTER` (red/green), and keep them separate files plus an optional concatenation.
- **Hero moments** (a landing page, an animation): give them 5–10 s — viewers need a moment to take it in.
- **Keep the cursor calm**: leave `ms` off — moves are timed by distance — and park it away from content while holding.
- **Zoom sparingly**: auto-zoom covers typing (and click-then-hold with `clicks: true`); add a manual `d.zoom` only where it misses (it then takes over). One or two zooms per minute, 1.3–1.5×, on the moment that matters (a value changing, small text). Zoom out before a big move across the screen. A highlight is often enough.
- Real timers keep running while frames render (~50–300 ms real time per frame), so timer-driven UI — toasts, debounced search, auto-dismissing tooltips — may disappear sooner in the video than in real life. Trigger them right before you want them on screen, or hold less.

## Using the video

- **PowerPoint**: Insert → Video → This Device. Playback tab: *Start: Automatically* and *Loop until Stopped*. H.264 `yuv420p` MP4 (what demo-reel writes) plays on Windows and macOS.
- **Keynote**: drag in; Movie → Repeat: Loop.
- **Web**: `<video src="demo.mp4" autoplay loop muted playsinline></video>`.
- **GIF** (README, chat): `ffmpeg -i demo.mp4 -vf "fps=20,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" demo.gif`
- **Concatenate** clips of the same size/fps: `printf "file 'a.mp4'\nfile 'b.mp4'\n" > l.txt && ffmpeg -f concat -safe 0 -i l.txt -c copy both.mp4`

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank / "Loading…" frames | Longer `settle` in `d.open`, or `await d.settle(1500)` after a navigation click. |
| Target not visible | It's off-screen or inside a closed menu — open/scroll first; for canvas items use a point function. |
| WebGL/3D renders black | Keep the default launch flags (`--use-angle=swiftshader`); it is slow (~0.25 s/frame) but correct. |
| Video too short/long vs plan | Durations are exact: sum of `hold` + moves. `settle` time is never recorded. |
| Colours look washed out in PowerPoint | Don't re-encode without `-pix_fmt yuv420p`; demo-reel's output is already correct. |
| Typed text flickers / letters hop | Fixed in v0.4.1: caret on the virtual clock, camera snaps when settled. Letters still re-render *during* a zoom move — keep zooms slow and shallow. |
| Text slightly soft | `--png` captures lossless frames (slower, larger). |
