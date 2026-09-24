// Injected into every page before any app script runs (Playwright addInitScript).
// Two jobs:
//  1. Virtual clock — requestAnimationFrame, performance.now and Date.now only
//     advance when the recorder calls __demo.tick(dt). Timers (setTimeout /
//     setInterval) deliberately stay real: faking them makes zero-delay timer
//     chains (loaders, schedulers) spin forever.
//  2. Overlay — cursor, halo, click effects, highlights, caption and badge. It is
//     driven entirely by the state the recorder passes in, so it survives full
//     page navigations.
(() => {
  if (window.__demo) return;

  // ---- 1. virtual clock ---------------------------------------------------
  const realPerf = performance.now.bind(performance);
  const perfBase = realPerf();
  const dateBase = Date.now();
  const RealDate = Date;
  let vt = 0;
  let queue = [];
  let seq = 0;
  performance.now = () => perfBase + vt;
  Date.now = () => dateBase + vt;
  // `new Date()` with no args should also follow the virtual clock.
  // eslint-disable-next-line no-global-assign
  Date = new Proxy(RealDate, {
    construct(target, args) { return args.length ? new target(...args) : new target(dateBase + vt); },
    apply(target, self, args) { return args.length ? target(...args) : new target(dateBase + vt).toString(); },
  });
  window.requestAnimationFrame = (cb) => { queue.push({ id: ++seq, cb }); return seq; };
  window.cancelAnimationFrame = (id) => { queue = queue.filter((e) => e.id !== id); };

  const animStart = new WeakMap();
  /** Step every CSS/Web animation to the virtual time it has been alive. */
  function stepAnimations() {
    for (const a of document.getAnimations()) {
      if (!animStart.has(a)) { animStart.set(a, vt); a.pause(); }
      const t = vt - animStart.get(a);
      const end = a.effect ? a.effect.getComputedTiming().endTime : 0;
      if (end !== Infinity && t >= end) {
        try { a.finish(); } catch { a.currentTime = end; }
      } else {
        a.currentTime = t;
      }
    }
  }

  // ---- 2. overlay -----------------------------------------------------------
  // Cursor shapes on a 24-unit grid; [svg body, hotspot x, hotspot y].
  const CURSORS = {
    arrow: ['<path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/>', 3, 2],
    mac: ['<path d="M5 2.5v17.2l4.3-4.2 2.9 6.6 2.9-1.3-2.9-6.5h6.1z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>', 5, 2.5],
    hand: ['<path d="M6 4a2 2 0 0 1 4 0v5a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L6 15z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 9v3.5M14 10v2.5M18 11v2" stroke="#111" stroke-width="1.2" stroke-linecap="round"/>', 8, 2],
    ibeam: ['<path d="M9 3.5c1.7 0 3 .6 3 2v13c0 1.4-1.3 2-3 2M15 3.5c-1.7 0-3 .6-3 2v13c0 1.4 1.3 2 3 2M10 12h4" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M9 3.5c1.7 0 3 .6 3 2v13c0 1.4-1.3 2-3 2M15 3.5c-1.7 0-3 .6-3 2v13c0 1.4 1.3 2 3 2M10 12h4" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>', 12, 12],
    dot: ['<circle cx="12" cy="12" r="7" fill="rgba(17,17,17,.78)" stroke="#fff" stroke-width="2"/>', 12, 12],
  };
  const HALO = {
    fill: (t) => `background: ${t.haloFill}; border: 2px solid ${t.haloStroke}; box-shadow: 0 0 18px ${t.haloFill};`,
    ring: (t) => `border: 2.5px solid ${t.haloStroke};`,
    glow: (t) => `background: radial-gradient(circle, ${t.haloFill} 0 40%, transparent 70%); transform: scale(1.4);`,
  };

  let ui = null;
  let lastClick = 0;
  function mount(theme) {
    if (ui && document.documentElement.contains(ui.root)) return ui;
    const root = document.createElement("div");
    root.id = "__demo-overlay";
    root.setAttribute("aria-hidden", "true");
    const t = theme;
    root.innerHTML = `
      <style>
        #__demo-overlay { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
        #__demo-overlay .cur { position: absolute; left: 0; top: 0; width: 0; height: 0; }
        #__demo-overlay .halo { position: absolute; left: -${t.haloSize / 2}px; top: -${t.haloSize / 2}px;
          width: ${t.haloSize}px; height: ${t.haloSize}px; border-radius: 50%; box-sizing: border-box;
          ${(HALO[t.haloStyle] ?? HALO.fill)(t)} }
        #__demo-overlay .ptr { position: absolute; filter: drop-shadow(0 2px 4px rgba(0,0,0,.4)); }
        #__demo-overlay .cur.down .ptr { scale: .86; }
        #__demo-overlay .cur.down .halo { scale: .82; }
        #__demo-overlay .ripple { position: absolute; width: 72px; height: 72px; margin: -36px 0 0 -36px; border-radius: 50%;
          border: 4px solid ${t.haloStroke}; background: ${t.haloFill}; box-sizing: border-box;
          animation: __demo-ripple .6s cubic-bezier(.2,.7,.3,1) forwards; }
        #__demo-overlay .ring { position: absolute; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
          border: 2px solid ${t.haloStroke}; box-sizing: border-box; opacity: 0;
          animation: __demo-ripple .55s cubic-bezier(.2,.7,.3,1) forwards; }
        @keyframes __demo-ripple { from { transform: scale(.35); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
        #__demo-overlay .hl { position: absolute; box-sizing: border-box;
          animation: __demo-hl-in .45s cubic-bezier(.2,.7,.3,1) both; }
        #__demo-overlay .hl-box { border: 3px solid var(--c); border-radius: 12px;
          box-shadow: 0 0 0 5px color-mix(in srgb, var(--c) 22%, transparent), 0 0 28px color-mix(in srgb, var(--c) 35%, transparent); }
        #__demo-overlay .hl-circle { border: 3px solid var(--c); border-radius: 50%;
          box-shadow: 0 0 22px color-mix(in srgb, var(--c) 35%, transparent); }
        #__demo-overlay .hl-spotlight { border-radius: 14px; box-shadow: 0 0 0 200vmax rgba(6, 8, 18, .58);
          animation-name: __demo-fade-in; }
        #__demo-overlay .hl-underline { border-radius: 3px; background: var(--c); transform-origin: left center;
          animation-name: __demo-draw; animation-duration: .5s; }
        #__demo-overlay .hl-marker { border-radius: 4px; background: color-mix(in srgb, var(--c) 32%, transparent);
          transform-origin: left center; animation-name: __demo-draw; animation-duration: .5s; }
        #__demo-overlay .hl.out { animation: __demo-fade-out .3s ease forwards; }
        @keyframes __demo-hl-in { from { opacity: 0; transform: scale(1.08) } to { opacity: 1; transform: none } }
        @keyframes __demo-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes __demo-fade-out { from { opacity: 1 } to { opacity: 0 } }
        @keyframes __demo-draw { from { transform: scaleX(0) } to { transform: none } }
        #__demo-overlay .hud { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; transform-origin: 0 0; }
        #__demo-overlay .cap { position: absolute; left: 50%; ${t.captionPosition === "top" ? "top: 88px" : "bottom: 96px"};
          transform: translateX(-50%); max-width: 80vw; white-space: nowrap;
          font: 600 ${t.captionSize}px/1.2 ${t.font}; color: #fff; background: rgba(15,23,42,.86);
          padding: 14px 26px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25);
          opacity: 0; transition: opacity .35s ease; }
        #__demo-overlay .cap.on { opacity: 1; }
        #__demo-overlay .badge { position: absolute; right: 24px; top: ${t.badgeTop}px; display: none;
          font: 700 20px/1 ${t.font}; letter-spacing: .06em; color: #fff; padding: 10px 16px; border-radius: 10px; }
      </style>
      <div class="hls"></div>
      <div class="cur"><div class="halo"></div><svg class="ptr" viewBox="0 0 24 24" width="${t.cursorSize}" height="${t.cursorSize}"></svg></div>
      <div class="hud"><div class="cap"></div><div class="badge"></div></div>`;
    (document.body || document.documentElement).appendChild(root);
    const $ = (sel) => root.querySelector(sel);
    ui = { root, cur: $(".cur"), halo: $(".halo"), ptr: $(".ptr"), hls: $(".hls"), hud: $(".hud"),
      cap: $(".cap"), badge: $(".badge"), shape: null, hl: new Map() };
    return ui;
  }

  /** "auto" follows the page: hand over links/buttons, I-beam over text fields. */
  function cursorShape(s) {
    if (s.cursorStyle !== "auto") return CURSORS[s.cursorStyle] ? s.cursorStyle : "arrow";
    const el = document.elementFromPoint(s.x, s.y);
    const c = el ? getComputedStyle(el).cursor : "";
    return c === "pointer" ? "hand" : c === "text" ? "ibeam" : "arrow";
  }

  function highlight(h) {
    const el = document.createElement("div");
    el.className = `hl hl-${h.style}`;
    el.style.setProperty("--c", h.color);
    const p = h.pad;
    let [x, y, w, ht] = [h.x - p, h.y - p, h.w + 2 * p, h.h + 2 * p];
    if (h.style === "circle") { x -= h.w * 0.1; w += h.w * 0.2; y -= h.h * 0.18; ht += h.h * 0.36; }
    if (h.style === "underline") { x = h.x; w = h.w; y = h.y + h.h + p / 2; ht = 4; }
    if (h.style === "marker") { x = h.x - 4; w = h.w + 8; y = h.y; ht = h.h; }
    Object.assign(el.style, { left: x + "px", top: y + "px", width: w + "px", height: ht + "px" });
    return el;
  }

  function sync(s) {
    if (!document.body) return;
    const u = mount(s.theme);
    const c = s.cam;
    // The recorder zooms the whole view; keep caption + badge at their normal screen size.
    u.hud.style.transform = c.z > 1 ? `translate(${c.x}px, ${c.y}px) scale(${1 / c.z})` : "";
    u.cur.style.display = s.cursor ? "block" : "none";
    u.halo.style.display = s.theme.halo ? "block" : "none";
    u.cur.style.transform = `translate(${s.x}px, ${s.y}px)`;
    u.cur.classList.toggle("down", s.pressed);
    const shape = cursorShape(s);
    if (shape !== u.shape) {
      u.shape = shape;
      const [svg, hx, hy] = CURSORS[shape];
      const k = s.theme.cursorSize / 24;
      u.ptr.innerHTML = svg;
      Object.assign(u.ptr.style, { left: -hx * k + "px", top: -hy * k + "px", transformOrigin: `${hx * k}px ${hy * k}px` });
    }
    if (s.caption) { if (u.cap.textContent !== s.caption) u.cap.textContent = s.caption; u.cap.classList.add("on"); }
    else u.cap.classList.remove("on");
    if (s.badge) { u.badge.style.display = "block"; u.badge.textContent = s.badge.text; u.badge.style.background = s.badge.color; }
    else u.badge.style.display = "none";

    const live = new Set();
    for (const h of s.highlights) {
      live.add(h.id);
      if (!u.hl.has(h.id)) { const el = highlight(h); u.hls.appendChild(el); u.hl.set(h.id, el); }
    }
    for (const [id, el] of u.hl) {
      if (live.has(id)) continue;
      u.hl.delete(id);
      el.classList.add("out");
      el.addEventListener("animationend", () => el.remove());
    }

    if (s.clickSeq !== lastClick) {
      lastClick = s.clickSeq;
      const style = s.theme.clickStyle;
      const n = style === "none" || s.clickSeq === 0 ? 0 : style === "pulse" ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const r = document.createElement("div");
        r.className = style === "ripple" ? "ripple" : "ring";
        r.style.left = s.x + "px"; r.style.top = s.y + "px"; r.style.animationDelay = i * 0.14 + "s";
        r.addEventListener("animationend", () => r.remove());
        u.root.insertBefore(r, u.cur);
      }
    }
  }

  window.__demo = {
    /** Advance virtual time by dt ms, run due rAF callbacks, sync overlay + animations.
     *  Returns the scroll offset, which the recorder's zoom camera needs. */
    tick(dt, state) {
      vt += dt;
      const now = perfBase + vt;
      const run = queue; queue = [];
      for (const e of run) { try { e.cb(now); } catch (err) { console.error(err); } }
      if (state) sync(state);
      stepAnimations();
      return [scrollX, scrollY];
    },
    now: () => vt,
  };
})();
