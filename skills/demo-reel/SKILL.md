---
name: demo-reel
description: Record a smooth, frame-exact 60 fps demo video of any web app from a short script — scripted cursor with a highlight halo, click ripples, captions and a corner badge, rendered on a virtual clock so it never stutters, encoded to an MP4 that loops in PowerPoint, Keynote or on the web. Use when the user wants a demo video, product walkthrough, screen recording, feature tour, before/after comparison video, a clip for a slide deck or landing page, or says "record the app", "make a video of", "screen capture", "show how it feels", "demo reel". Also for turning a Playwright flow into a video or making an existing recording smoother (60 fps).
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
  size: "1920x1080",          // viewport = video size
  fps: 60,
  theme: { captionPosition: "bottom", haloFill: "rgba(250,204,21,.30)" }, // optional
  async run(d) {
    await d.open("http://localhost:4173/");     // navigate + settle (not recorded)
    d.badge("NEW", "#15803d");                  // corner badge (null hides)
    d.caption("The new dashboard");             // caption pill (null hides)
    await d.hold(1500);                          // record 1.5 s as-is
    await d.click(d.page.getByRole("button", { name: "Filters" }));
    d.caption("Filters live in one panel");     // set captions AFTER the action
    await d.hold(1200);
    await d.type("Stockholm");                  // human-speed typing
    await d.press("Enter");
    await d.scroll(600);                        // smooth wheel scroll
    await d.step("optional part", async () => { /* failures are logged, recording continues */ });
  },
};
```

| Call | Does |
|---|---|
| `d.open(url, { settle })` | Navigate, let the page settle (unrecorded, default 2500 ms). |
| `d.hold(ms)` | Record the page as it is. |
| `d.settle(ms)` | Advance time **without** recording — skip loading states, lazy chunks, layout animations you don't want to show. |
| `d.move(target, { ms })` / `d.hover` | Glide the cursor (eased) to a target. |
| `d.click(target, { ms, button })` | Move, click with a ripple. `button: "right"` for context menus. |
| `d.doubleClick(target)` | Double click. |
| `d.type(text, { delay })` | Type one key at a time (default 90 ms/key). |
| `d.press(key)` | Keyboard shortcut, e.g. `"Escape"`, `"Control+K"`. |
| `d.scroll(dy, { ms })` | Smooth wheel scroll. |
| `d.caption(text)` / `d.badge(text, color)` / `d.cursor(bool)` | Overlay state; survives full page navigations. |
| `d.step(name, fn)` | Named step; errors are logged, not fatal. |
| `d.page`, `d.point(target)`, `d.width`, `d.height` | Escape hatches. |

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

## Writing good demos

- **Captions tell the truth.** Only claim what the footage shows. If a bug you want to show doesn't reproduce in the take, change the caption — don't keep it.
- **Caption after the action**, not before — otherwise the caption for the next screen appears over the previous one.
- **Show outcomes, not clicks.** Hold 1–2 s on every result; cut loading with `d.settle`.
- **Before/after**: record two scenarios with the same story and steps, badge `BEFORE`/`AFTER` (red/green), and keep them separate files plus an optional concatenation.
- **Hero moments** (a landing page, an animation): give them 5–10 s — viewers need a moment to take it in.
- **Keep the cursor calm**: 600–900 ms per move, park it away from content while holding.
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
| Text slightly soft | `--png` captures lossless frames (slower, larger). |
