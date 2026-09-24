// Example scenario — the same Tasks app tour, in a styled frame: a rounded
// window with a soft shadow, inset on a gradient. Pairs well with zoom.
//   node scripts/record.mjs examples/framed.scenario.mjs --out examples/framed.mp4
import tasks from "./tasks.scenario.mjs";

export default {
    ...tasks,
    frame: true, // sensible defaults: dark gradient, ~4% padding, 14px radius, shadow on
};
