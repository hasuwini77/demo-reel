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
        await d.open(app, { settle: 1000 });
        await d.hold(1300); // library, synced pill visible

        await d.step("open player", async () => {
            await d.click(page.getByRole("listitem", { name: /The slow interest of doing one thing well/ }));
            await d.settle(500); // sheet slide-up
            d.caption("Keep listening on the go");
            await d.hold(1200);
        });

        await d.step("play", async () => {
            await d.click(page.getByRole("button", { name: "Play" }));
            await d.hold(900);
        });

        await d.step("zoom on scrubber", async () => {
            await d.zoom("#p-seek", { scale: 1.5, ms: 900 });
            await d.hold(2200); // scrubber/timecode live
            await d.zoom(null, { ms: 800 });
        });

        d.caption(null);
        await d.hold(500);
    },
};
