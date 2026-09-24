// Web2Audio showcase — clip 2/3: the iOS app.
//   node skills/demo-reel/scripts/record.mjs docs/web2audio/phone.scenario.mjs --out docs/web2audio-phone.mp4
//
// Recorded WITHOUT a frame — full 1920x1080. phone.html's own background is
// the same wallpaper as browser.scenario.mjs's frame.background, so the cut
// from clip 1 flows straight through.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "phone.html")
).href;

export default {
    size: "1920x1080",
    fps: 60,
    theme: {
        accent: "#c4832c",
        cursorStyle: "auto",
        autoZoom: false,
    },

    async run(d) {
        const { page } = d;
        // No captions in this clip — the headline lives in the page itself
        // (left of the phone), so nothing should overlap the device.
        d.caption(null);
        await d.open(app, { settle: 1000 });
        await d.hold(1600); // library, synced pill visible

        await d.step("open player", async () => {
            await d.click(page.getByRole("listitem", { name: /The slow interest of doing one thing well/ }));
            await d.settle(500); // sheet slide-up
            await d.hold(1400);
        });

        await d.step("play", async () => {
            await d.click(page.getByRole("button", { name: "Play" }));
            await d.hold(1300);
        });

        await d.step("zoom on scrubber", async () => {
            await d.zoom("#p-seek", { scale: 1.5, ms: 900 });
            await d.hold(2800); // scrubber/timecode live
            await d.zoom(null, { ms: 800 });
        });

        await d.hold(700);
    },
};
