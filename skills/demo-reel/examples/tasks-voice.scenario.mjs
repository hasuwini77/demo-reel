// The Tasks tour with a voice-over: every caption is also spoken, locally.
//   npm i kokoro-js   # once, ~830 MB, CPU only
//   node scripts/record.mjs examples/tasks-voice.scenario.mjs --out examples/tasks-voice.mp4
import tasks from "./tasks.scenario.mjs";

export default { ...tasks, voice: { provider: "kokoro", captions: true } };
