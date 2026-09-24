#!/usr/bin/env node
// demo-reel — record a scripted walkthrough of a web app as a frame-exact MP4.
//
//   node record.mjs <scenario.mjs> [--out demo.mp4] [--fps 60] [--size 1920x1080]
//                   [--crf 17] [--png] [--headed]
//
// Every frame is rendered at an exact 1/fps step of a virtual clock (see
// inject.js), so the video is smooth no matter how slowly the page renders.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
    console.error("usage: node record.mjs <scenario.mjs> [--out demo.mp4] [--fps 60] [--size 1920x1080] [--crf 17] [--png] [--headed]");
    process.exit(1);
}
const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
const scenario = typeof mod.default === "function" ? { run: mod.default } : mod.default;

const FPS = Number(flag("fps", scenario.fps ?? 60));
const [W, H] = String(flag("size", scenario.size ?? "1920x1080")).split("x").map(Number);
const OUT = path.resolve(flag("out", scenario.out ?? path.basename(scenarioPath).replace(/\.(scenario\.)?m?js$/, "") + ".mp4"));
const CRF = String(flag("crf", 17));
const PNG = Boolean(flag("png", false));
const DT = 1000 / FPS;

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
    headless: !flag("headed", false),
    // Software WebGL so three.js / canvas scenes render headless.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
});
const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    locale: scenario.locale,
    colorScheme: scenario.colorScheme,
});
await context.addInitScript(readFileSync(path.join(HERE, "inject.js"), "utf8"));
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const ff = spawn("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", PNG ? "png" : "mjpeg", "-i", "-",
    "-vf", `${PNG ? "" : "scale=in_range=full:out_range=tv,"}format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", CRF, "-r", String(FPS),
    "-color_range", "tv", "-movflags", "+faststart", "-an", OUT,
], { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((r) => ff.on("close", r));

// ---------------------------------------------------------------- state + frame loop
const state = {
    x: W / 2, y: H * 0.62, cursor: true, cursorStyle: theme.cursorStyle, pressed: false,
    caption: null, badge: null, clickSeq: 0, highlights: [], cam: { x: 0, y: 0, z: 1 }, theme,
};
let frames = 0;
let hlSeq = 0;

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
    const zoom = Math.exp(cam.lz);
    const w = W / zoom, h = H / zoom;
    const x = Math.min(Math.max(cam.x - w / 2, 0), W - w);
    const y = Math.min(Math.max(cam.y - h / 2, 0), H - h);
    state.cam = { x, y, z: zoom };
}

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
    if (!capture) {return;}
    await applyCamera(scroll);
    const { data } = await cdp.send("Page.captureScreenshot", PNG
        ? { format: "png" }
        : { format: "jpeg", quality: 92, optimizeForSpeed: true });
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
    async hold(ms) { for (let i = 0; i < Math.round(ms / DT); i++) {await tick(DT, true);} },
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
        for (let i = 1; i <= n; i++) {
            const k = ease(i / n);
            state.x = x0 + (p.x - x0) * k;
            state.y = y0 + (p.y - y0) * k;
            await page.mouse.move(state.x, state.y);
            await tick(DT, true);
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
    },
    async doubleClick(target, opts = {}) {
        await d.click(target, opts);
        state.clickSeq++;
        await page.mouse.click(state.x, state.y, { button: opts.button ?? "left", clickCount: 2 });
        await tick(DT, true);
    },
    /** Type like a person, one frame-accurate key at a time. */
    async type(text, { delay = 90 } = {}) {
        for (const ch of text) { await page.keyboard.type(ch); await d.hold(delay); }
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
        cam.w = 4.7 / (ms / 1000);
        if (target == null) { cam.tlz = 0; cam.tx = W / 2; cam.ty = H / 2; cam.follow = false; return; }
        const r = await rect(target);
        const fit = r.width && r.height ? Math.min((W * 0.6) / r.width, (H * 0.6) / r.height) : 1.5;
        cam.tlz = Math.log(Math.max(1, scale ?? Math.min(Math.max(fit, 1.25), 1.8)));
        cam.tx = r.x + r.width / 2; cam.ty = r.y + r.height / 2;
        cam.follow = follow; cam.cx = state.x; cam.cy = state.y;
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

try {
    await scenario.run(d);
} finally {
    ff.stdin.end();
    await ffDone;
    await browser.close();
}
console.log(`demo-reel: ${frames} frames = ${(frames / FPS).toFixed(1)} s @ ${FPS} fps, ${W}x${H} → ${OUT}`);
