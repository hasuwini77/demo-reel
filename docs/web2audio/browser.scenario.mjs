// Web2Audio showcase — clip 1/3: the Chrome extension.
//   node skills/demo-reel/scripts/record.mjs docs/web2audio/browser.scenario.mjs --out docs/web2audio-browser.mp4
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "browser.html")
).href;

// Same wallpaper as phone.html's body background — keep this string
// byte-for-byte identical to the one in phone.html so the cut between
// clips flows. Ignored by engines that don't yet support `frame`.
const WALLPAPER =
    "radial-gradient(140% 100% at 50% -10%, oklch(0.76 0.17 65 / 0.16) 0%, oklch(0.4 0.1 55 / 0.06) 35%, transparent 65%), linear-gradient(160deg, oklch(0.19 0.01 60), oklch(0.1 0.006 70))";

export default {
    size: "1920x1080",
    fps: 60,
    frame: { background: WALLPAPER, padding: 64, radius: 14, shadow: true },
    theme: {
        accent: "#c4832c", // brand amber (~oklch(0.76 0.17 65) in sRGB)
        cursorStyle: "auto",
        autoZoom: false, // every zoom below is deliberate
    },

    async run(d) {
        const { page } = d;
        await d.open(app, { settle: 1000 });
        await d.hold(1200);

        await d.step("open popup", async () => {
            await d.click(page.getByRole("button", { name: "Web2Audio — summarize this page" }));
            await d.hold(500);
            d.caption("Any webpage");
            await d.hold(1400);
        });

        await d.step("zoom to popup", async () => {
            await d.zoom("#w2a-popup", { scale: 1.6, ms: 1000 });
            await d.hold(300);
        });

        await d.step("play / summarize", async () => {
            await d.click(page.getByRole("button", { name: "Play this page" }));
            d.caption("Audio summary, one click");
            await d.hold(1600); // "Preparing audio" spinning
            await d.settle(300); // let playback pick up cleanly
            await d.hold(1600); // playing — ring fills, timecode live
        });

        await d.step("voice picker", async () => {
            await d.click(page.getByRole("option", { name: "Fenrir" }), { ms: 700 });
            d.caption("HD voices");
            await d.hold(1200);
        });

        await d.step("length", async () => {
            await d.click(page.getByRole("button", { name: "Standard" }));
            await d.hold(1000);
        });

        await d.zoom(null, { ms: 900 });
        d.caption(null);
        await d.move({ x: d.width * 0.5, y: d.height * 0.85 }, { ms: 800 });
        await d.hold(700);
    },
};
