// Injected into every page before any app script runs (Playwright addInitScript).
// Two jobs:
//  1. Virtual clock — requestAnimationFrame, performance.now and Date.now only
//     advance when the recorder calls __demo.tick(dt). Timers (setTimeout /
//     setInterval) deliberately stay real: faking them makes zero-delay timer
//     chains (loaders, schedulers) spin forever.
//  2. Overlay — cursor with halo, click ripples, caption and corner badge. It is
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
          width: ${t.haloSize}px; height: ${t.haloSize}px; border-radius: 50%;
          background: ${t.haloFill}; border: 2px solid ${t.haloStroke}; box-shadow: 0 0 18px ${t.haloFill}; }
        #__demo-overlay .arrow { position: absolute; left: -4px; top: -3px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.4)); }
        #__demo-overlay .ripple { position: absolute; width: 72px; height: 72px; margin: -36px 0 0 -36px; border-radius: 50%;
          border: 4px solid ${t.haloStroke}; background: ${t.haloFill};
          animation: __demo-ripple .6s cubic-bezier(.2,.7,.3,1) forwards; }
        @keyframes __demo-ripple { from { transform: scale(.35); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
        #__demo-overlay .cap { position: absolute; left: 50%; ${t.captionPosition === "top" ? "top: 88px" : "bottom: 96px"};
          transform: translateX(-50%); max-width: 80vw; white-space: nowrap;
          font: 600 ${t.captionSize}px/1.2 ${t.font}; color: #fff; background: rgba(15,23,42,.86);
          padding: 14px 26px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25);
          opacity: 0; transition: opacity .35s ease; }
        #__demo-overlay .cap.on { opacity: 1; }
        #__demo-overlay .badge { position: absolute; right: 24px; top: ${t.badgeTop}px; display: none;
          font: 700 20px/1 ${t.font}; letter-spacing: .06em; color: #fff; padding: 10px 16px; border-radius: 10px; }
      </style>
      <div class="cap"></div><div class="badge"></div>
      <div class="cur"><div class="halo"></div>
        <svg class="arrow" viewBox="0 0 24 24" width="34" height="34"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </div>`;
    (document.body || document.documentElement).appendChild(root);
    ui = { root, cur: root.querySelector(".cur"), cap: root.querySelector(".cap"), badge: root.querySelector(".badge") };
    ui.halo = root.querySelector(".halo");
    return ui;
  }

  function sync(s) {
    if (!document.body) return;
    const u = mount(s.theme);
    u.cur.style.display = s.cursor ? "block" : "none";
    u.halo.style.display = s.theme.halo ? "block" : "none";
    u.cur.style.transform = `translate(${s.x}px, ${s.y}px)`;
    if (s.caption) { if (u.cap.textContent !== s.caption) u.cap.textContent = s.caption; u.cap.classList.add("on"); }
    else u.cap.classList.remove("on");
    if (s.badge) { u.badge.style.display = "block"; u.badge.textContent = s.badge.text; u.badge.style.background = s.badge.color; }
    else u.badge.style.display = "none";
    if (s.clickSeq !== lastClick) {
      lastClick = s.clickSeq;
      if (s.clickSeq > 0) {
        const r = document.createElement("div");
        r.className = "ripple";
        r.style.left = s.x + "px"; r.style.top = s.y + "px";
        r.addEventListener("animationend", () => r.remove());
        u.root.appendChild(r);
      }
    }
  }

  window.__demo = {
    /** Advance virtual time by dt ms, run due rAF callbacks, sync overlay + animations. */
    tick(dt, state) {
      vt += dt;
      const now = perfBase + vt;
      const run = queue; queue = [];
      for (const e of run) { try { e.cb(now); } catch (err) { console.error(err); } }
      if (state) sync(state);
      stepAnimations();
      return run.length;
    },
    now: () => vt,
  };
})();
