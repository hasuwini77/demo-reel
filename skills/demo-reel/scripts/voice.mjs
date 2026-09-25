// demo-reel voice — text-to-speech for d.say / captions.
//
//   const voice = await createVoice({ provider: "kokoro", voice: "af_heart" });
//   const { file, dur } = await voice.synth("Hello");   // dur in ms
//
// The provider is always named by the scenario: cloud providers send the text
// off the machine, so that is opt-in per take. API keys come from the
// environment only and are never logged. Clips are cached by
// sha1(provider|voice|model|speed|text), so a re-take neither re-bills nor
// re-synthesizes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULTS = {
    kokoro: { voice: "af_heart", model: "onnx-community/Kokoro-82M-v1.0-ONNX", ext: "wav" },
    elevenlabs: { voice: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_flash_v2_5", ext: "mp3" },
    openai: { voice: "alloy", model: "gpt-4o-mini-tts", ext: "wav" },
    piper: { voice: "", model: undefined, ext: "wav" },
    command: { voice: "", model: undefined, ext: "wav" },
};

const fail = (msg) => { throw new Error(`demo-reel voice: ${msg}`); };

function run(cmd, args, { input } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "";
        p.stdout.on("data", (b) => { out += b; });
        p.stderr.on("data", (b) => { err += b; });
        p.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`demo-reel voice: "${cmd}" not found on PATH`) : e));
        p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`demo-reel voice: ${cmd} exited ${code}: ${err.trim().split("\n").pop()}`))));
        p.stdin.end(input ?? "");
    });
}

/** Clip length in ms. */
async function probe(file) {
    const s = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return Math.round(Number(s.trim()) * 1000);
}

async function post(url, headers, body, keyVar) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (!res.ok) {
        const hint = res.status === 401 ? ` (check ${keyVar})` : "";
        fail(`${new URL(url).host} returned ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

let kokoroModel = null;   // one load per process (~4 s)

export async function createVoice(cfg, { cacheDir = path.resolve(".demo-reel-cache/voice") } = {}) {
    const provider = cfg?.provider;
    if (!DEFAULTS[provider]) {
        fail(`set voice.provider to one of ${Object.keys(DEFAULTS).join(", ")} (it is never picked automatically)`);
    }
    const o = { ...DEFAULTS[provider], speed: 1, ...cfg };
    const key = (name) => process.env[name] || fail(`provider "${provider}" needs ${name} in the environment`);

    // Fail before the take starts, not halfway through it.
    let synthesize;
    if (provider === "elevenlabs") {
        const k = key("ELEVENLABS_API_KEY");
        synthesize = async (text) => post(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(o.voice)}?output_format=mp3_44100_128`,
            { "xi-api-key": k },
            { text, model_id: o.model, ...(o.speed !== 1 ? { voice_settings: { speed: o.speed } } : {}) },
            "ELEVENLABS_API_KEY",
        );
    } else if (provider === "openai") {
        const k = key("OPENAI_API_KEY");
        synthesize = async (text) => post(
            "https://api.openai.com/v1/audio/speech",
            { authorization: `Bearer ${k}` },
            { model: o.model, voice: o.voice, input: text, response_format: "wav", speed: o.speed },
            "OPENAI_API_KEY",
        );
    } else if (provider === "kokoro") {
        let KokoroTTS;
        try {
            ({ KokoroTTS } = await import("kokoro-js"));
        } catch {
            fail('provider "kokoro" needs kokoro-js (~830 MB, CPU only): run `npm i kokoro-js` in the demo-reel skill folder');
        }
        synthesize = async (text, out) => {
            kokoroModel ??= KokoroTTS.from_pretrained(o.model, { dtype: o.dtype ?? "q8", device: "cpu" });
            const audio = await (await kokoroModel).generate(text, { voice: o.voice, speed: o.speed });
            await audio.save(out);
        };
    } else if (provider === "piper") {
        if (!o.model) {fail('provider "piper" needs voice.model (path to a .onnx voice)');}
        synthesize = async (text, out) => {
            const args = ["--model", o.model, "--output_file", out];
            if (o.speed !== 1) {args.push("--length_scale", String(1 / o.speed));}
            await run("piper", args, { input: text });
        };
    } else {
        // Template, e.g. "say -o {out} {text}". Split on spaces, no shell: the
        // text is passed as one argument and can't inject anything.
        if (typeof o.command !== "string" || !o.command.includes("{out}")) {
            fail('provider "command" needs voice.command, a template with {text} and {out}');
        }
        synthesize = async (text, out) => {
            const [cmd, ...args] = o.command.trim().split(/\s+/).map((t) => t.replaceAll("{text}", text).replaceAll("{out}", out));
            await run(cmd, args);
        };
    }

    mkdirSync(cacheDir, { recursive: true });
    return {
        async synth(text) {
            const id = createHash("sha1").update([provider, o.voice, o.model ?? "", o.speed, text].join("|")).digest("hex");
            const file = path.join(cacheDir, `${id}.wav`);
            const short = text.length > 48 ? `${text.slice(0, 47)}…` : text;
            if (existsSync(file)) {
                console.log(`voice: cache hit  "${short}"`);
            } else {
                const t0 = Date.now();
                const raw = `${file}.raw.${o.ext}`, tmp = `${file}.part.wav`;
                const buf = await synthesize(text, raw);
                if (buf) {writeFileSync(raw, buf);}
                // Clips open with silence (Kokoro: 0.33–0.39 s): trim it, so speech
                // starts on the frame the line was said and `dur` is honest.
                await run("ffmpeg", ["-y", "-loglevel", "error", "-i", raw,
                    "-af", "silenceremove=start_periods=1:start_threshold=-50dB", tmp]);
                unlinkSync(raw);
                renameSync(tmp, file);
                console.log(`voice: ${provider} "${short}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
            }
            return { file, dur: await probe(file) };
        },
    };
}
