#!/usr/bin/env node
// demo-reel — record a scripted walkthrough of a web app as a frame-exact MP4.
//
//   node record.mjs <scenario.mjs> [--out demo.mp4] [--fps 60] [--size 1920x1080]
//                   [--crf 17] [--png] [--headed] [--capture screenshot|beginframe]
//
// Every frame is rendered at an exact 1/fps step of a virtual clock (see
// inject.js), so the video is smooth no matter how slowly the page renders.
// `--capture beginframe` (headless only) puts the compositor on that clock too:
// each frame is produced on demand by HeadlessExperimental.beginFrame, so tile
// raster and image decode can't lag the page. Opt-in: animated GIF/APNG freeze
// and smooth scrolls jump under it (see SKILL.md).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createVoice } from "./voice.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) {return def;}
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
};
const scenarioPath = argv[0];
if (!scenarioPath || scenarioPath.startsWith("--")) {
    console.error("usage: node record.mjs <scenario.mjs> [--out demo.mp4] [--fps 60] [--size 1920x1080] [--crf 17] [--png] [--headed] [--capture screenshot|beginframe]");
    process.exit(1);
}
const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
const scenario = typeof mod.default === "function" ? { run: mod.default } : mod.default;

const FPS = Number(flag("fps", scenario.fps ?? 60));
const [OW, OH] = String(flag("size", scenario.size ?? "1920x1080")).split("x").map(Number);
const OUT = path.resolve(flag("out", scenario.out ?? path.basename(scenarioPath).replace(/\.(scenario\.)?m?js$/, "") + ".mp4"));
const CRF = String(flag("crf", 17));
const PNG = Boolean(flag("png", false));
const DT = 1000 / FPS;
const HEADED = Boolean(flag("headed", false));
// Headed Chrome has no BeginFrameControl: it always uses Page.captureScreenshot.
const BEGIN_FRAME = !HEADED && flag("capture", "screenshot") === "beginframe";
// Software WebGL so three.js / canvas scenes render headless.
const BASE_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"];
// Voice-over: provider is named by the scenario, checked before the take starts.
const VOICE = scenario.voice ? await createVoice(scenario.voice) : null;
// Music bed (ducked under the voice) and click / key sounds, all mixed after the take.
const AUDIO = scenario.audio ?? {};
const sfxCfg = AUDIO.sfx === true ? {} : AUDIO.sfx || null;
const SFX = sfxCfg ? { click: true, key: true, volume: 0.4, ...sfxCfg } : null;

// ---------------------------------------------------------------- styled frame
// `frame` puts the page in a rounded window, inset on a background, with a soft
// shadow — zero per-frame cost: it's a single plate image composited by ffmpeg,
// not drawn every frame. Omitted => output is byte-for-byte today's behaviour.
const frameCfg = scenario.frame === true ? {} : scenario.frame || null;
const FRAME = frameCfg ? {
    background: frameCfg.background ?? "linear-gradient(135deg, #1c1f3d, #3a2a1a)",
    padding: Math.round(frameCfg.padding ?? OW * 0.04),
    radius: frameCfg.radius ?? 14,
    shadow: frameCfg.shadow ?? true,
} : null;

// W/H stay the *viewport* size (what the page/camera/cursor see); OW/OH is the
// final video size. Round to even numbers — required for yuv420p.
let W = OW, H = OH, padX = 0, padY = 0;
if (FRAME) {
    W = OW - 2 * FRAME.padding; H = OH - 2 * FRAME.padding;
    W -= W % 2; H -= H % 2;
    padX = (OW - W) / 2; padY = (OH - H) / 2;
}

const isLocalImage = (bg) => !/^(linear-gradient|radial-gradient|conic-gradient|repeating-|url\(|#|rgb|hsl|var\()/i.test(bg.trim())
    && /\.(png|jpe?g|webp|avif|gif)$/i.test(bg.trim());

/** SVG path for a rounded rect, for use inside an evenodd clip-path(). */
function roundedRectPath(x, y, w, h, r) {
    if (r <= 0) {return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;}
    return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} `
        + `A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} `
        + `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

/** Render the OWxOH plate once: background with a transparent rounded hole at
 * the window rect (an evenodd clip-path donut — reliable + anti-aliased under
 * headless omitBackground capture, unlike CSS mask-image), plus a soft outer
 * box-shadow. ffmpeg overlays it on every frame — the alpha edge of the hole
 * is what rounds the corners. */
async function renderPlate(browser) {
    // A begin-frame-controlled browser never paints on its own, so a Playwright
    // screenshot there would hang: render the plate in a plain one.
    const own = BEGIN_FRAME ? await chromium.launch({ args: BASE_ARGS }) : null;
    if (own) {browser = own;}
    const { background, radius, shadow } = FRAME;
    const shadowCss = shadow === false ? "none"
        : shadow === true ? "0 30px 70px -15px rgba(0,0,0,.55), 0 18px 36px -18px rgba(0,0,0,.65)"
        : shadow;
    const bgCss = isLocalImage(background)
        ? `url("${pathToFileURL(path.resolve(background)).href}") center / cover no-repeat`
        : background;
    const outer = `M0 0 H${OW} V${OH} H0 Z`;
    const hole = roundedRectPath(padX, padY, W, H, radius);
    const clip = `path(evenodd, "${outer} ${hole}")`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
        .bg{position:absolute;inset:0;width:${OW}px;height:${OH}px;background:${bgCss};
            clip-path:${clip};}
        .shadow{position:absolute;left:${padX}px;top:${padY}px;width:${W}px;height:${H}px;
            border-radius:${radius}px;box-shadow:${shadowCss};}
    </style></head><body><div class="bg"></div>${shadowCss === "none" ? "" : '<div class="shadow"></div>'}</body></html>`;
    const plate = await browser.newPage({ viewport: { width: OW, height: OH } });
    await plate.setContent(html, { waitUntil: "networkidle" });
    const buf = await plate.screenshot({ omitBackground: true });
    await plate.close();
    if (own) {await own.close();}
    const platePath = path.join(os.tmpdir(), `demo-reel-plate-${process.pid}.png`);
    writeFileSync(platePath, buf);
    return platePath;
}

const userTheme = scenario.theme ?? {};
const theme = {
    font: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
    cursorStyle: "arrow",   // arrow | mac | hand | ibeam | dot | auto
    cursorSize: 34,
    halo: true,
    haloStyle: "fill",      // fill | ring | glow
    haloSize: 64,
    haloFill: "rgba(250, 204, 21, .30)",
    haloStroke: "rgba(234, 179, 8, .85)",
    clickStyle: "ripple",   // ripple | ring | pulse | none
    captionSize: 26,
    captionPosition: "bottom",
    badgeTop: 84,
    // One colour for halo, click effects and highlights.
    ...(userTheme.accent ? {
        haloFill: `color-mix(in srgb, ${userTheme.accent} 30%, transparent)`,
        haloStroke: userTheme.accent,
    } : {}),
    ...userTheme,
};
// Cursor physics, each switchable; `cursorMotion: false` turns all three off.
theme.cursorMotion = {
    spring: true, arc: true, blur: true,
    ...(userTheme.cursorMotion === false ? { spring: false, arc: false, blur: false } : userTheme.cursorMotion),
};

// ---------------------------------------------------------------- browser + encoder
const browser = await chromium.launch({
    headless: !HEADED,
    args: BEGIN_FRAME ? [...BASE_ARGS,
        // Frames only happen on beginFrame, and every compositor stage (raster,
        // decode, scroll and animation ticks) runs on the main thread inside it.
        "--enable-begin-frame-control", "--run-all-compositor-stages-before-draw",
        "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging",
        "--disable-smooth-scrolling", "--disable-image-animation-resync",
    ] : BASE_ARGS,
});
const platePath = FRAME ? await renderPlate(browser) : null;

const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    locale: scenario.locale,
    colorScheme: scenario.colorScheme,
});
await context.addInitScript(readFileSync(path.join(HERE, "inject.js"), "utf8"));
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const ffArgs = [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", PNG ? "png" : "mjpeg", "-i", "-",
];
if (FRAME) {
    ffArgs.push(
        "-loop", "1", "-framerate", String(FPS), "-i", platePath,
        "-filter_complex",
        `[0:v]${PNG ? "" : "scale=in_range=full:out_range=tv,"}pad=${OW}:${OH}:${padX}:${padY}:color=black[p];`
        + `[p][1:v]overlay=0:0:shortest=1,format=yuv420p[outv]`,
        "-map", "[outv]",
    );
} else {
    ffArgs.push("-vf", `${PNG ? "" : "scale=in_range=full:out_range=tv,"}format=yuv420p`);
}
ffArgs.push(
    "-c:v", "libx264", "-preset", "slow", "-crf", CRF, "-r", String(FPS),
    "-color_range", "tv", "-movflags", "+faststart", "-an", OUT,
);
const ff = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((r) => ff.on("close", r));

// ---------------------------------------------------------------- state + frame loop
const state = {
    x: W / 2, y: H * 0.62, cursor: true, cursorStyle: theme.cursorStyle, pressed: false,
    caption: null, badge: null, card: null, clickSeq: 0, highlights: [], cam: { x: 0, y: 0, z: 1 }, theme,
};
let frames = 0;
let hlSeq = 0;
const cues = [];          // voice clips: { at (ms), file, dur (ms) }
let sayQueue = Promise.resolve();
const subs = [];          // captions: { text, start, end } in ms, frame-exact
const sfx = [];           // { kind: "click" | "key", at (ms) }
const sound = (kind) => { if (SFX?.[kind]) {sfx.push({ kind, at: now() });} };
// Karaoke captions: word spans (absolute ms) of the spoken caption, lit as they pass.
const KARAOKE = theme.captionStyle === "karaoke";
let karaoke = null, karaokeJob = null;

// ---------------------------------------------------------------- begin frames
// frameTimeTicks follows the virtual clock (captured and settle ticks alike) and
// must be strictly monotonic. The clock starts at the real monotonic time, which
// is what Chrome's TimeTicks count on Linux.
const T0 = Number(process.hrtime.bigint() / 1000000n);
let clock = 0, lastTicks = 0, queued = 0, lastFrameAt = 0, lastShot = null, frameQueue = Promise.resolve();

function beginFrame(opts) {
    queued++;
    const run = () => {
        lastTicks = Math.max(T0 + clock, lastTicks + 0.001);
        return cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: lastTicks, interval: DT, ...opts });
    };
    const p = frameQueue.then(run, run).finally(() => { queued--; lastFrameAt = performance.now(); });
    frameQueue = p.catch(() => {});
    return p;
}

// Mouse and wheel input is only acknowledged by a drawn frame, so Playwright waits
// for one. When the recorder is idle (a scenario awaiting input, a locator, a
// navigation), pump frames without a screenshot; the clock only creeps by 1 µs.
const pump = BEGIN_FRAME ? setInterval(() => {
    if (!queued && performance.now() - lastFrameAt > 10) {beginFrame({}).catch(() => {});}
}, 5) : null;

// ---------------------------------------------------------------- zoom camera
// Center (viewport px) and zoom, each chasing its target on a critically damped
// spring stepped once per recorded frame: it starts and stops with zero velocity,
// so every zoom and pan eases in and out. Zoom springs in log space, which makes
// 1→1.5 and 1.5→1 feel equally fast.
const cam = { x: W / 2, y: H / 2, lz: 0, vx: 0, vy: 0, vz: 0, tx: W / 2, ty: H / 2, tlz: 0, w: 4.7, follow: false, cx: 0, cy: 0 };
let emulated = false;

function spring(pos, vel, target, s, w = cam.w) {
    const d = pos - target, e = Math.exp(-w * s), k = (vel + w * d) * s;
    return [target + (d + k) * e, (vel - w * k) * e];
}

function stepCamera(dt) {
    const z = Math.exp(cam.tlz);
    // Follow the cursor once it moves: pan only when it leaves the middle of the view.
    if (cam.follow && z > 1 && (state.x !== cam.cx || state.y !== cam.cy)) {
        const mx = (W / z) * 0.3, my = (H / z) * 0.3;
        cam.tx = Math.min(Math.max(cam.tx, state.x - mx), state.x + mx);
        cam.ty = Math.min(Math.max(cam.ty, state.y - my), state.y + my);
    }
    cam.cx = state.x; cam.cy = state.y;
    // Never show anything outside the page.
    cam.tx = Math.min(Math.max(cam.tx, W / (2 * z)), W - W / (2 * z));
    cam.ty = Math.min(Math.max(cam.ty, H / (2 * z)), H - H / (2 * z));
    const s = dt / 1000;
    [cam.x, cam.vx] = spring(cam.x, cam.vx, cam.tx, s);
    [cam.y, cam.vy] = spring(cam.y, cam.vy, cam.ty, s);
    [cam.lz, cam.vz] = spring(cam.lz, cam.vz, cam.tlz, s);
    // The spring only approaches its target, and every sub-pixel creep re-rasters
    // the text at a new offset/scale, so letters shimmer long after the move looks
    // done. Snap once it is within a pixel / 0.4 % of scale and nearly still.
    if (Math.abs(cam.x - cam.tx) < 1 && Math.abs(cam.y - cam.ty) < 1 && Math.abs(cam.lz - cam.tlz) < 0.004
        && Math.abs(cam.vx) + Math.abs(cam.vy) < 40 && Math.abs(cam.vz) < 0.05) {
        cam.x = cam.tx; cam.y = cam.ty; cam.lz = cam.tlz; cam.vx = cam.vy = cam.vz = 0;
    }
    const zoom = Math.exp(cam.lz);
    const w = W / zoom, h = H / zoom;
    // Whole device pixels: a pan then shifts the raster instead of re-hinting glyphs.
    const x = Math.round(Math.min(Math.max(cam.x - w / 2, 0), W - w) * zoom) / zoom;
    const y = Math.round(Math.min(Math.max(cam.y - h / 2, 0), H - h) * zoom) / zoom;
    state.cam = { x, y, z: zoom };
}

/** Aim the camera at a box; `scale` defaults to fitting the box (1.25–1.8×). */
function aim(r, { scale, ms = 1000, follow = true } = {}) {
    cam.w = 4.7 / (ms / 1000);
    const fit = r.width && r.height ? Math.min((W * 0.6) / r.width, (H * 0.6) / r.height) : 1.5;
    cam.tlz = Math.log(Math.max(1, scale ?? Math.min(Math.max(fit, 1.25), 1.8)));
    cam.tx = r.x + r.width / 2; cam.ty = r.y + r.height / 2;
    cam.follow = follow; cam.cx = state.x; cam.cy = state.y;
}

function aimOut(ms = 1000) {
    cam.w = 4.7 / (ms / 1000);
    cam.tlz = 0; cam.tx = W / 2; cam.ty = H / 2; cam.follow = false;
}

// ---------------------------------------------------------------- auto zoom
// A few gentle zooms without asking: when typing starts, and (opt-in, `clicks`)
// on a click in the page body followed by a long hold — opt-in because a click's
// result often appears elsewhere (a side panel), off the zoomed frame. Rare (one per `gap`), shallow and slow, and
// out again after `dwell` or before a long cursor move, so it never feels busy.
// Clicks near the edges (toolbars, nav) don't zoom: their result shows elsewhere.
// A manual d.zoom() hands the camera to the scenario for the rest of the take.
const AUTO = theme.autoZoom === false ? null : {
    scale: 1.35, ms: 1400, gap: 10000, dwell: 4000, minHold: 1500, clicks: false,
    ...(typeof theme.autoZoom === "object" ? theme.autoZoom : {}),
};
const auto = { on: false, at: -Infinity, until: 0, typing: false, click: null, manual: false };
const now = () => frames * DT;

function autoIn(r) {
    if (!AUTO || auto.manual || auto.on || now() < 2000 || now() - auto.at < AUTO.gap) {return;}
    aim(r, { scale: AUTO.scale, ms: AUTO.ms });
    auto.on = true; auto.at = now(); auto.until = now() + AUTO.dwell;
}

function autoOut() {
    if (!auto.on) {return;}
    aimOut(AUTO.ms);
    auto.on = false;
}

const inBody = (p) => p.x > W * 0.15 && p.x < W * 0.85 && p.y > H * 0.12 && p.y < H * 0.88;

async function applyCamera(scroll) {
    const { x, y, z } = state.cam;
    const metrics = { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H };
    if (z > 1.0005) {
        // Re-rasters the visible area at the zoom (crisp, not upscaled). The page
        // doesn't see it: no resize, and mouse input stays in page coordinates.
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            ...metrics, viewport: { x: x + scroll[0], y: y + scroll[1], width: W / z, height: H / z, scale: z },
        });
        emulated = true;
    } else if (emulated) {
        await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
        emulated = false;
    }
}

async function tick(dt, capture) {
    if (capture && state.highlights.some((h) => h.until <= frames * DT)) {
        state.highlights = state.highlights.filter((h) => !(h.until <= frames * DT));
    }
    if (capture && auto.on && !auto.typing && now() > auto.until) {autoOut();}
    if (capture) {stepCamera(dt);}
    if (capture && karaokeJob) { await karaokeJob.catch(() => {}); karaokeJob = null; }   // word times before the frame
    state.capLit = KARAOKE && karaoke?.text === state.caption ? karaoke.words.filter((w) => w.start <= now()).length : -1;
    let scroll = [0, 0];
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            scroll = await page.evaluate(([dt, s]) => window.__demo?.tick(dt, s), [dt, state]) ?? scroll;
            break;
        } catch {
            // Mid-navigation: wait for the new document (inject.js re-runs there).
            await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
    }
    clock += dt;
    if (!capture) {
        if (BEGIN_FRAME) {await beginFrame({});}
        return;
    }
    await applyCamera(scroll);
    const format = PNG ? { format: "png" } : { format: "jpeg", quality: 92, optimizeForSpeed: true };
    let data;
    if (BEGIN_FRAME) {
        // No damage => no screenshot; the previous frame is still exact.
        data = (await beginFrame({ screenshot: format })).screenshotData ?? lastShot;
        if (!data) {throw new Error("demo-reel: first beginFrame returned no screenshot");}
        lastShot = data;
    } else {
        ({ data } = await cdp.send("Page.captureScreenshot", format));
    }
    if (!ff.stdin.write(Buffer.from(data, "base64"))) {await new Promise((r) => ff.stdin.once("drain", r));}
    frames++;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------- cursor path
// A move lasts longer the further it goes, rides the camera's spring (quick off
// the mark, long soft landing) and bows slightly, like a hand on a mouse.
const moveMs = (dist) => Math.min(Math.max(260 + dist * 0.55, 320), 1100);

/** Progress 0→1 on each of n frames. The spring only approaches its target, so
 * it is stepped to ~99 % and rescaled to land exactly on the last frame. */
function springProgress(n) {
    const w = 7 / ((n * DT) / 1000);
    const ks = [];
    let p = 0, v = 0;
    for (let i = 0; i < n; i++) { [p, v] = spring(p, v, 1, DT / 1000, w); ks.push(p); }
    return ks.map((k) => k / p);
}

/** Box of a target, in viewport px. A point ({x, y}) is a zero-size box. */
async function rect(target) {
    if (target == null) {return { x: state.x, y: state.y, width: 0, height: 0 };}
    if (typeof target === "function") {return { width: 0, height: 0, ...(await target(page)) };}
    if (typeof target.x === "number" && typeof target.y === "number") {return { width: 0, height: 0, ...target };}
    const loc = typeof target === "string" ? page.locator(target) : target;
    const b = await loc.first().boundingBox({ timeout: 5000 });
    if (!b) {throw new Error(`demo-reel: target not visible: ${String(target)}`);}
    return b;
}

async function point(target) {
    const r = await rect(target);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// ---------------------------------------------------------------- scenario API
const d = {
    page, context, fps: FPS, width: W, height: H,

    /** Record `ms` of the page as it is. */
    async hold(ms) {
        if (auto.click && AUTO?.clicks && ms >= AUTO.minHold && inBody(auto.click)) {autoIn({ ...auto.click, width: 0, height: 0 });}
        auto.click = null;
        for (let i = 0; i < Math.round(ms / DT); i++) {await tick(DT, true);}
    },
    /** Advance time without recording (loading, layout settling). */
    async settle(ms = 1000) {
        for (let t = 0; t < ms; t += 50) { await tick(50, false); await page.waitForTimeout(20); }
    },
    /** Navigate, then settle before the next recorded frame. */
    async open(url, { settle = 2500, prewarm = true } = {}) {
        await page.goto(url);
        await d.settle(settle);
        // No pop-in once recording starts: fonts loaded, every image fetched and
        // decoded, and (prewarm) lazy content below the fold triggered by a quick
        // unrecorded scroll to the bottom and back. "instant", not "auto": auto
        // obeys a page's `scroll-behavior: smooth`.
        await page.evaluate(async (prewarm) => {
            const images = () => {
                const imgs = [...document.images];
                for (const i of imgs) {i.loading = "eager";}
                const decoded = Promise.allSettled(imgs.map((i) => i.decode()));
                return Promise.race([decoded, new Promise((r) => setTimeout(r, 5000))]);
            };
            await document.fonts.ready;
            await images();
            if (!prewarm) {return;}
            const { scrollX: x, scrollY: y } = window;
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
            await new Promise((r) => setTimeout(r, 300));
            await images();
            window.scrollTo({ left: x, top: y, behavior: "instant" });
            await document.fonts.ready;
        }, prewarm).catch((e) => console.warn(`demo-reel: prewarm skipped: ${String(e.message).split("\n")[0]}`));
        await d.settle(250);
        await page.mouse.move(state.x, state.y);
    },
    /** Glide the cursor to a target (selector, Locator, {x,y} or async (page) => {x,y}). */
    async move(target, { ms } = {}) {
        const p = await point(target);
        const x0 = state.x, y0 = state.y, dx = p.x - x0, dy = p.y - y0, dist = Math.hypot(dx, dy);
        const n = Math.max(6, Math.round((ms ?? moveMs(dist)) / DT));
        const motion = theme.cursorMotion;
        const ks = motion.spring ? springProgress(n) : Array.from({ length: n }, (_, i) => ease((i + 1) / n));
        // Arc: bulge along the perpendicular on the upper side, peaking mid-move.
        const bow = motion.arc && dist ? (Math.min(dist * 0.06, 40) / dist) * (dx < 0 ? -1 : 1) : 0;
        auto.click = null;
        if (dist > Math.hypot(W, H) * 0.3) {autoOut();}
        for (const k of ks) {
            const b = Math.sin(Math.PI * k) * bow;
            state.x = x0 + dx * k + dy * b;
            state.y = y0 + dy * k - dx * b;
            // With beginFrame the move is only acknowledged by a frame: draw it now.
            const moved = page.mouse.move(state.x, state.y);
            if (!BEGIN_FRAME) {await moved;}
            await tick(DT, true);
            await moved;
        }
    },
    async hover(target, opts) { await d.move(target, opts); },
    /** Move, then click with a ripple. `button: "right"` for context menus. */
    async click(target, { ms, button = "left", pause = 80 } = {}) {
        await d.move(target, { ms });
        await d.hold(pause);
        state.clickSeq++;
        sound("click");
        state.pressed = true;
        await page.mouse.down({ button });
        await tick(DT, true); await tick(DT, true);
        await page.mouse.up({ button });
        state.pressed = false;
        await tick(DT, true);
        auto.click = { x: state.x, y: state.y };
    },
    async doubleClick(target, opts = {}) {
        await d.click(target, opts);
        state.clickSeq++;
        sound("click");
        await page.mouse.click(state.x, state.y, { button: opts.button ?? "left", clickCount: 2 });
        await tick(DT, true);
    },
    /** Type like a person, one frame-accurate key at a time. */
    async type(text, { delay = 90 } = {}) {
        const field = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) {return null;}
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }).catch(() => null);
        if (field) {autoIn(field);}
        auto.typing = true;
        try {
            for (const ch of text) { sound("key"); await page.keyboard.type(ch); await d.hold(delay); }
        } finally {
            auto.typing = false;
            if (auto.on) {auto.until = now() + AUTO.dwell;}
        }
    },
    async press(key) { sound("key"); await page.keyboard.press(key); await tick(DT, true); },
    /** Smooth wheel scroll by dy pixels. */
    async scroll(dy, { ms = 800 } = {}) {
        const n = Math.max(6, Math.round(ms / DT));
        let done = 0;
        for (let i = 1; i <= n; i++) {
            const want = Math.round(dy * ease(i / n));
            await page.mouse.wheel(0, want - done);
            done = want;
            await tick(DT, true);
        }
    },
    /** Caption pill (null hides it). Set it *after* the action it describes. */
    caption(text) {
        state.caption = text || null;
        const last = subs.at(-1);
        if (last && last.end == null) {last.end = now();}
        if (text) {subs.push({ text, start: now(), end: null });}
        // voice.captions: speak every caption too (non-blocking, errors only warn).
        if (text && VOICE && scenario.voice.captions) {
            d.say(text).catch((e) => console.warn(String(e.message)));
        }
    },
    /**
     * Speak `text` from this frame on. Synthesis runs between frames, so it costs
     * no video time; returns { at, dur } in ms. `wait: true` holds until the clip
     * ends (+200 ms). A clip that would overlap the previous one is pushed later.
     */
    say(text, { wait = false } = {}) {
        if (!VOICE) {throw new Error("demo-reel: d.say needs `voice: { provider }` in the scenario");}
        const at0 = now();
        const lit = KARAOKE && state.caption === text;
        const job = sayQueue.then(async () => {
            const { file, dur, words } = await VOICE.synth(text);
            const prev = cues.at(-1);
            let at = at0;
            if (prev && at < prev.at + prev.dur + 150) {
                at = prev.at + prev.dur + 150;
                console.warn(`voice: "${text.slice(0, 40)}" overlaps the previous clip, moved ${Math.round(at - at0)} ms later`);
            }
            cues.push({ at, file, dur });
            if (lit) {karaoke = { text, words: words.map((w) => ({ start: at + w.start, end: at + w.end })) };}
            return { at, dur };
        });
        sayQueue = job.catch(() => {});
        if (lit) {karaokeJob = job;}
        if (!wait) {return job;}
        return job.then(async (c) => { await d.hold(Math.max(0, c.at + c.dur + 200 - now())); return c; });
    },
    /** Corner badge, e.g. d.badge("BEFORE", "#b91c1c"); null hides it. */
    badge(text, color = "#15803d") { state.badge = text ? { text, color } : null; },
    /** true/false shows/hides the cursor; a name switches its shape (arrow, mac, hand, ibeam, dot, auto). */
    cursor(v) { if (typeof v === "string") {state.cursorStyle = v;} else {state.cursor = v;} },
    /**
     * Ease the camera onto a target (any target; an element's box is framed to
     * fit). Returns at once — the zoom plays over the following moves and holds,
     * and the camera then follows the cursor. `d.zoom(null)` eases back out.
     * `ms` is roughly how long the move takes to settle.
     */
    async zoom(target, { scale, ms = 1000, follow = true } = {}) {
        auto.manual = true; auto.on = false;
        if (target == null) { aimOut(ms); return; }
        aim(await rect(target), { scale, ms, follow });
    },
    /**
     * Mark a target: style "box" | "circle" | "spotlight" | "underline" | "marker".
     * Stays until `ms` has been recorded, or until `d.highlight(null)` clears all.
     */
    async highlight(target, { style = "box", color = theme.haloStroke, pad = 8, ms } = {}) {
        if (target == null) { state.highlights = []; return; }
        const r = await rect(target);
        state.highlights = [...state.highlights, {
            id: ++hlSeq, style, color, pad, x: r.x, y: r.y, w: r.width, h: r.height,
            until: ms ? frames * DT + ms : Infinity,
        }];
    },
    /**
     * Label a target: a caption-style pill beside it, joined by a leader line to a
     * dot on its edge. `side` "auto" picks the side with the most room. Clears
     * after `ms`, or with `d.callout(null)`; zooms with the page like highlights.
     */
    async callout(target, text, { side = "auto", color = theme.haloStroke, ms } = {}) {
        if (target == null) { state.highlights = state.highlights.filter((h) => h.style !== "callout"); return; }
        const r = await rect(target);
        if (side === "auto") {
            const room = { right: W - r.x - r.width, left: r.x, bottom: H - r.y - r.height, top: r.y };
            side = Object.keys(room).reduce((a, b) => (room[b] > room[a] ? b : a));
        }
        state.highlights = [...state.highlights, {
            id: ++hlSeq, style: "callout", text, side, color, pad: 0, x: r.x, y: r.y, w: r.width, h: r.height,
            until: ms ? frames * DT + ms : Infinity,
        }];
    },
    /**
     * Full-frame title / end card over the page (not zoomed): fades in, stays
     * `ms`, fades out, 350 ms each way on the virtual clock. Cursor hidden meanwhile.
     */
    async card({ title, subtitle, ms = 2500, bg = "#0f172a", align = "center" } = {}) {
        const cursor = state.cursor;
        state.cursor = false;
        state.card = { title, subtitle, bg, align };
        await d.hold(350 + ms);
        state.card = null;
        await d.hold(350);
        state.cursor = cursor;
    },
    /** Run a named step; a failure is logged and the recording continues. */
    async step(name, fn) {
        try { await fn(); } catch (e) { console.warn(`step "${name}" failed: ${String(e.message).split("\n")[0]}`); }
    },
    point,
};

const t0 = performance.now();
try {
    await scenario.run(d);
    await sayQueue;
} finally {
    if (pump) {clearInterval(pump);}
    ff.stdin.end();
    await ffDone;
    await browser.close();
    if (platePath) {try { unlinkSync(platePath); } catch { /* best effort */ }}
}
const msPerFrame = ((performance.now() - t0) / Math.max(frames, 1)).toFixed(1);

// ---------------------------------------------------------------- subtitles + audio
// Subtitles from the caption cues; times are frame-exact by construction.
const end = frames * DT;
const lines = subs.map((c) => ({ ...c, end: Math.min(c.end ?? end, end) })).filter((c) => c.end > c.start);
if (lines.length) {
    const ts = (ms, sep) => {
        const t = Math.round(ms), p = (n, w = 2) => String(n).padStart(w, "0");
        return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)}${sep}${p(t % 1000, 3)}`;
    };
    const base = OUT.replace(/\.[^.]+$/, "");
    writeFileSync(`${base}.srt`, lines.map((c, i) => `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n${c.text}\n`).join("\n"));
    writeFileSync(`${base}.vtt`, `WEBVTT\n\n${lines.map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}\n${c.text}\n`).join("\n")}`);
    console.log(`demo-reel: ${lines.length} subtitles → ${base}.srt / .vtt`);
}

// Voice clips and sounds, each delayed to its frame, plus the music bed, mixed
// under the untouched video. Sounds are generated by ffmpeg (lavfi), no assets.
if (cues.length || sfx.length || AUDIO.music) {
    const tmp = OUT.replace(/(\.[^.]+)?$/, ".voice$1");
    const inputs = [], graph = [], mix = [];
    const input = (...args) => { inputs.push(...args); return inputs.filter((a) => a === "-i").length; };
    if (cues.length) {
        cues.forEach((c, i) => graph.push(`[${input("-i", c.file)}:a]adelay=${Math.round(c.at)}:all=1[v${i}]`));
        graph.push(`${cues.map((_, i) => `[v${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,asplit=2[voice][vkey]`);
        mix.push("[voice]");
    }
    const SOUNDS = {
        click: "sine=f=1200:d=0.025:r=48000,afade=t=out:st=0.005:d=0.02",
        key: "anoisesrc=d=0.03:c=white:r=48000:a=0.5,bandpass=f=3500:width_type=h:w=3000,afade=t=out:st=0.005:d=0.025",
    };
    for (const kind of Object.keys(SOUNDS)) {
        const at = sfx.filter((c) => c.kind === kind).map((c) => Math.round(c.at));
        if (!at.length) {continue;}
        const i = input("-f", "lavfi", "-i", SOUNDS[kind]);
        graph.push(`[${i}:a]volume=${SFX.volume},asplit=${at.length}${at.map((_, k) => `[${kind}${k}]`).join("")}`);
        at.forEach((t, k) => graph.push(`[${kind}${k}]adelay=${t}:all=1[${kind}d${k}]`));
        graph.push(`${at.map((_, k) => `[${kind}d${k}]`).join("")}amix=inputs=${at.length}:normalize=0:dropout_transition=0[${kind}]`);
        mix.push(`[${kind}]`);
    }
    if (AUDIO.music) {
        const i = input("-stream_loop", "-1", "-i", path.resolve(AUDIO.music));
        const sec = end / 1000;
        graph.push(`[${i}:a]aresample=48000,volume=${AUDIO.musicVolume ?? 0.18},atrim=0:${sec},afade=t=in:d=1,`
            + `afade=t=out:st=${Math.max(0, sec - 1.5)}:d=1.5${cues.length && AUDIO.duck !== false ? "[bed]" : "[music]"}`);
        // Duck: the voice keys a compressor on the music.
        if (cues.length && AUDIO.duck !== false) {
            graph.push("[vkey]apad[key]", "[bed][key]sidechaincompress=threshold=0.05:ratio=8:attack=50:release=400[music]");
        }
        mix.push("[music]");
    }
    if (cues.length && !(AUDIO.music && AUDIO.duck !== false)) {graph.push("[vkey]anullsink");}
    graph.push(`${mix.join("")}amix=inputs=${mix.length}:normalize=0:dropout_transition=0,apad,aresample=48000[a]`);
    const code = await new Promise((r) => spawn("ffmpeg", [
        "-y", "-loglevel", "error", "-i", OUT, ...inputs,
        "-filter_complex", graph.join(";"), "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", tmp,
    ], { stdio: ["ignore", "inherit", "inherit"] }).on("close", r));
    if (code !== 0) {throw new Error(`demo-reel: audio mux failed (ffmpeg exit ${code})`);}
    renameSync(tmp, OUT);
    console.log(`demo-reel: audio mixed in: ${cues.length} voice clips, ${sfx.length} sounds${AUDIO.music ? ", music" : ""}`);
}
console.log(`demo-reel: ${frames} frames = ${(frames / FPS).toFixed(1)} s @ ${FPS} fps, ${OW}x${OH} → ${OUT}`
    + ` (${BEGIN_FRAME ? "beginFrame" : "screenshot"}, ${msPerFrame} ms/frame)`);
