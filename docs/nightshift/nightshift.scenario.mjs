// Nightshift — the demo-reel showcase reel.
//   node scripts/record.mjs docs/nightshift/nightshift.scenario.mjs --out docs/nightshift.mp4
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html")
).href;

// A point on the scrub bar at a given ratio (0..1) across its width.
const scrubPoint = (ratio) => async (page) => {
    const box = await page.locator("#scrub").boundingBox();
    return { x: box.x + box.width * ratio, y: box.y + box.height / 2 };
};

// A point inside the mixtape drop zone.
const mixtapeDropPoint = async (page) => {
    const box = await page.locator("#mixtape").boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };
};

export default {
    size: "1920x1080",
    fps: 60,
    theme: { captionPosition: "bottom", haloFill: "rgba(255, 201, 163, .30)", haloStroke: "rgba(255, 201, 163, .9)" },

    async run(d) {
        const { page } = d;
        await d.open(app, { settle: 1200 });
        d.badge("NIGHTSHIFT", "#FFC9A3");
        d.caption("A late-night mixtape studio");
        await d.hold(1800);

        await d.step("play", async () => {
            await d.click(page.getByRole("button", { name: "Play tape_03.wav by @midnight.loops" }));
            d.caption("Press play — the waveform comes alive");
            await d.hold(2200);
        });

        await d.step("tag", async () => {
            await d.click(page.getByLabel("Add tag"));
            d.caption('Tag the mood: "chill"');
            await d.type("chill");
            await d.hold(250);
            await d.click(page.getByRole("button", { name: "Add tag" }));
            await d.hold(1300);
        });

        await d.step("drag", async () => {
            const track = page.locator('.track[data-id="t2"]');
            await d.move(track, { ms: 650 });
            await page.mouse.down();
            d.caption("Drag a track into the mixtape");
            await d.hold(150);
            await d.move(mixtapeDropPoint, { ms: 950 });
            await d.hold(250);
            await page.mouse.up();
            await d.hold(1300);
        });

        await d.step("scrub", async () => {
            await d.click(scrubPoint(0.72));
            d.caption("Scrub to any moment");
            await d.hold(1300);
        });

        await d.step("export", async () => {
            await d.click(page.getByRole("button", { name: "Export mixtape" }));
            d.caption("Export — done in a beat");
            await d.hold(1500);
            await d.hold(2200);
        });

        d.badge(null);
        d.caption(null);
        await d.move({ x: d.width * 0.5, y: d.height * 0.85 }, { ms: 900 });
        await d.hold(900);
    },
};
