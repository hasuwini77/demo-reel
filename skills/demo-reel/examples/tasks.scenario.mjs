// Example scenario — a 20-second tour of the bundled Tasks app (no network).
//   node scripts/record.mjs examples/tasks.scenario.mjs --out examples/tasks.mp4
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "tasks/index.html")).href;

export default {
    size: "1920x1080",
    fps: 60,
    theme: { captionPosition: "bottom" },

    async run(d) {
        const { page } = d;
        await d.open(app);
        d.badge("DEMO", "#4f46e5");
        d.caption("A small task app");
        await d.hold(1500);

        await d.step("add", async () => {
            await d.click(page.getByLabel("New task"));
            d.caption("Add a task");
            await d.type("Ship the demo video");
            await d.hold(300);
            await d.click(page.getByRole("button", { name: "Add" }));
            await d.hold(1200);
        });

        await d.step("complete", async () => {
            await d.click(page.getByRole("checkbox").nth(1));
            d.caption("Tick it off");
            await d.hold(1200);
        });

        await d.step("filter", async () => {
            await d.click(page.getByRole("button", { name: "Done" }));
            d.caption("Filter to what's done");
            await d.hold(1400);
            await d.click(page.getByRole("button", { name: "All" }));
            await d.hold(900);
        });

        await d.step("details", async () => {
            await d.click(page.locator("li").first());
            d.caption("Details slide in");
            await d.hold(1800);
            await d.press("Escape");
            await d.hold(900);
        });

        d.caption(null);
        await d.move({ x: d.width * 0.5, y: d.height * 0.8 }, { ms: 900 });
        await d.hold(800);
    },
};
