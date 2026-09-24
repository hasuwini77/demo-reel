// Web2Audio showcase — clip 3/3: end card.
//   node skills/demo-reel/scripts/record.mjs docs/web2audio/end.scenario.mjs --out docs/web2audio-end.mp4
//
// Recorded WITHOUT a frame — full 1920x1080, static card, no captions/badge.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "end.html")
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
        await d.open(app, { settle: 800 });
        d.caption(null);
        d.badge(null);
        await d.hold(900);

        await d.move(page.getByRole("button", { name: "Add to Chrome — free" }), { ms: 800 });
        await d.highlight(page.getByRole("button", { name: "Add to Chrome — free" }), {
            style: "box",
            pad: 8,
            ms: 1200,
        });
        await d.hold(1200);

        await d.move(page.getByRole("button", { name: "Download on the App Store" }), { ms: 700 });
        await d.hold(1100);
    },
};
