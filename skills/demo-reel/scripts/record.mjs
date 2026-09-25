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
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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
    caption: null, badge: null, clickSeq: 0, highlights: [], cam: { x: 0, y: 0, z: 1 }, theme,
};
let frames = 0;
let hlSeq = 0;

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

function spring(pos, vel, target, s) {
    const d = pos - target, e = Math.exp(-cam.w * s), k = (vel + cam.w * d) * s;
    return [target + (d + k) * e, (vel - cam.w * k) * e];
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
    async open(url, { settle = 2500 } = {}) {
        await page.goto(url);
        await d.settle(settle);
        await page.mouse.move(state.x, state.y);
    },
    /** Glide the cursor to a target (selector, Locator, {x,y} or async (page) => {x,y}). */
    async move(target, { ms = 650 } = {}) {
        const p = await point(target);
        const n = Math.max(6, Math.round(ms / DT));
        const x0 = state.x, y0 = state.y;
        auto.click = null;
        if (Math.hypot(p.x - x0, p.y - y0) > Math.hypot(W, H) * 0.3) {autoOut();}
        for (let i = 1; i <= n; i++) {
            const k = ease(i / n);
            state.x = x0 + (p.x - x0) * k;
            state.y = y0 + (p.y - y0) * k;
            // With beginFrame the move is only acknowledged by a frame: draw it now.
            const moved = page.mouse.move(state.x, state.y);
            if (!BEGIN_FRAME) {await moved;}
            await tick(DT, true);
            await moved;
        }
    },
    async hover(target, opts) { await d.move(target, opts); },
    /** Move, then click with a ripple. `button: "right"` for context menus. */
    async click(target, { ms = 650, button = "left", pause = 80 } = {}) {
        await d.move(target, { ms });
        await d.hold(pause);
        state.clickSeq++;
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
            for (const ch of text) { await page.keyboard.type(ch); await d.hold(delay); }
        } finally {
            auto.typing = false;
            if (auto.on) {auto.until = now() + AUTO.dwell;}
        }
    },
    async press(key) { await page.keyboard.press(key); await tick(DT, true); },
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
    caption(text) { state.caption = text || null; },
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
    /** Run a named step; a failure is logged and the recording continues. */
    async step(name, fn) {
        try { await fn(); } catch (e) { console.warn(`step "${name}" failed: ${String(e.message).split("\n")[0]}`); }
    },
    point,
};

const t0 = performance.now();
try {
    await scenario.run(d);
} finally {
    if (pump) {clearInterval(pump);}
    ff.stdin.end();
    await ffDone;
    await browser.close();
    if (platePath) {try { unlinkSync(platePath); } catch { /* best effort */ }}
}
const msPerFrame = ((performance.now() - t0) / Math.max(frames, 1)).toFixed(1);
console.log(`demo-reel: ${frames} frames = ${(frames / FPS).toFixed(1)} s @ ${FPS} fps, ${OW}x${OH} → ${OUT}`
    + ` (${BEGIN_FRAME ? "beginFrame" : "screenshot"}, ${msPerFrame} ms/frame)`);
