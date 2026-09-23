/**
 * transport.js — shared play/pause/scrub state machine for the demo scenes.
 * No setTimeout/setInterval anywhere: every visible transition (loading spin,
 * progress fill, timecode) is driven by requestAnimationFrame + performance.now(),
 * which the demo-reel recorder virtualises. Purely local — zero network calls.
 *
 * States mirror the real Web2Audio Studio Console (ConsoleView / useConsolePlayer):
 *   idle -> loading -> playing <-> paused -> ended ("idle-after-play")
 */
(function (global) {
  const LOADING_MS = 1400; // "Preparing audio" — extract/summarize/TTS collapsed for the demo

  function createTransport({ duration, onChange, instantStart = false }) {
    let state = "idle"; // idle | loading | playing | paused | ended
    let elapsed = 0; // seconds into the track
    let speed = 1;
    let loadStart = null;
    let playStart = null; // performance.now() when the current play segment began
    let playStartElapsed = 0;
    let rafId = null;

    function emit() {
      const progress = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 0;
      onChange({ state, progress, elapsed, duration, speed });
    }

    function frame(now) {
      if (state === "loading") {
        if (now - loadStart >= LOADING_MS) {
          state = "playing";
          playStart = now;
          playStartElapsed = 0;
          elapsed = 0;
        }
        emit();
        rafId = requestAnimationFrame(frame);
        return;
      }
      if (state === "playing") {
        const dt = ((now - playStart) / 1000) * speed;
        elapsed = playStartElapsed + dt;
        if (elapsed >= duration) {
          elapsed = duration;
          state = "ended";
          emit();
          rafId = null;
          return;
        }
        emit();
        rafId = requestAnimationFrame(frame);
        return;
      }
    }

    function ensureLoop() {
      if (rafId === null) rafId = requestAnimationFrame(frame);
    }

    function activate() {
      if (state === "idle" || state === "error") {
        if (instantStart) {
          state = "playing";
          playStart = performance.now();
          playStartElapsed = elapsed;
          emit();
          ensureLoop();
          return;
        }
        state = "loading";
        loadStart = performance.now();
        emit();
        ensureLoop();
        return;
      }
      if (state === "playing") {
        state = "paused";
        emit();
        return;
      }
      if (state === "paused") {
        state = "playing";
        playStart = performance.now();
        playStartElapsed = elapsed;
        emit();
        ensureLoop();
        return;
      }
      if (state === "ended") {
        state = "playing";
        elapsed = 0;
        playStart = performance.now();
        playStartElapsed = 0;
        emit();
        ensureLoop();
        return;
      }
    }

    function skip(deltaSeconds) {
      if (state === "idle" || state === "loading") return;
      elapsed = Math.min(duration, Math.max(0, elapsed + deltaSeconds));
      if (state === "playing") {
        playStart = performance.now();
        playStartElapsed = elapsed;
      }
      if (state === "ended" && elapsed < duration) state = "paused";
      emit();
    }

    function seekFraction(frac) {
      if (state === "idle" || state === "loading") return;
      elapsed = Math.min(duration, Math.max(0, frac * duration));
      if (state === "playing") {
        playStart = performance.now();
        playStartElapsed = elapsed;
      }
      if (state === "ended" && elapsed < duration) state = "paused";
      emit();
    }

    function cycleSpeed() {
      speed = speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : 1;
      if (state === "playing") {
        playStart = performance.now();
        playStartElapsed = elapsed;
      }
      emit();
    }

    function reset() {
      state = "idle";
      elapsed = 0;
      speed = 1;
      rafId = null;
      emit();
    }

    emit();
    return { activate, skip, seekFraction, cycleSpeed, reset, getState: () => state };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  global.W2A = { createTransport, formatTime };
})(window);
