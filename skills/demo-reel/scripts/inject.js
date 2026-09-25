// Injected into every page before any app script runs (Playwright addInitScript).
// Three jobs:
//  1. Virtual clock — requestAnimationFrame, performance.now and Date.now only
//     advance when the recorder calls __demo.tick(dt). Timers (setTimeout /
//     setInterval) stay real by default: faking them all makes zero-delay timer
//     chains (loaders, schedulers) spin forever. The opt-in hybrid clock fakes
//     only delays of 16 ms or more, and steps smooth scrolls too.
//  2. Overlay — cursor, halo, click effects, highlights, caption and badge. It is
//     driven entirely by the state the recorder passes in, so it survives full
//     page navigations.
//  3. Text caret — drawn on the virtual clock instead of Chromium's (see below).
(() => {
  if (window.__demo) return;

  // ---- 0. seeded Math.random (theme.seed, prepended by the recorder) -------
  if (typeof __demoSeed === "number") {
    let a = __demoSeed >>> 0;
    // mulberry32
    Math.random = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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

  // Hybrid clock (opt-in, `clock: "hybrid"`): timers of 16 ms or more wait on
  // the virtual clock and fire inside tick() when it reaches them, so a 3 s toast
  // lasts 3 s of video. Shorter delays stay real (zero-delay chains can't spin),
  // and so do microtasks, MessageChannel and string callbacks.
  const HYBRID = window.__demoClock === "hybrid";
  const realSetTimeout = window.setTimeout.bind(window);
  const timers = [];        // min-heap on [due, id]
  const live = new Map();   // id -> timer; ids start high so they never meet real ones
  let timerSeq = 1 << 30;
  const before = (a, b) => a.due < b.due || (a.due === b.due && a.id < b.id);
  function heapPush(t) {
    let i = timers.push(t) - 1;
    while (i && before(t, timers[(i - 1) >> 1])) { timers[i] = timers[(i - 1) >> 1]; i = (i - 1) >> 1; }
    timers[i] = t;
  }
  function heapPop() {
    const top = timers[0], last = timers.pop();
    if (timers.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = last;
        if (l < timers.length && before(timers[l], m)) m = timers[l];
        if (r < timers.length && before(timers[r], m)) m = timers[r];
        if (m === last) break;
        const c = m === timers[l] ? l : r;
        timers[i] = m; i = c;
      }
      timers[i] = last;
    }
    return top;
  }
  /** Fire due virtual timers in order, each at its own due time, then land on `to`. */
  let ticking = false;
  function runTimers(to) {
    while (timers.length && timers[0].due <= to + 1e-6) {   // float slack
      const t = heapPop();
      if (live.get(t.id) !== t) continue;   // cleared
      vt = Math.max(vt, t.due);
      if (t.every) { t.due += t.every; heapPush(t); } else live.delete(t.id);
      try { t.fn.apply(window, t.args); } catch (err) { console.error(err); }
    }
    vt = to;
  }
  if (HYBRID) {
    const real = { st: window.setTimeout, si: window.setInterval, ct: window.clearTimeout, ci: window.clearInterval };
    const virtual = (realFn, every) => function (fn, delay, ...args) {
      const ms = Number(delay) || 0;
      if (ms < 16 || typeof fn !== "function") return realFn.call(window, fn, delay, ...args);
      // Set between ticks (an input handler), a timer starts just after the last
      // frame, so one due on a frame boundary fires after that frame: a 3 s toast
      // shown by a click is on exactly 180 frames at 60 fps.
      const t = { id: ++timerSeq, due: vt + ms + (ticking ? 0 : 1e-3), every: every ? ms : 0, fn, args };
      live.set(t.id, t);
      heapPush(t);
      return t.id;
    };
    const clear = (realFn) => function (id) { if (!live.delete(id)) realFn.call(window, id); };
    window.setTimeout = virtual(real.st, false);
    window.setInterval = virtual(real.si, true);
    window.clearTimeout = clear(real.ct);
    window.clearInterval = clear(real.ci);
  }

  // Smooth scrolls (hybrid only): Chromium animates `behavior: "smooth"` on its
  // own compositor clock (and jumps under --capture beginframe), so it becomes a
  // 400 ms eased scroll stepped in tick(). scrollIntoView jumps natively, notes
  // which scrollers moved, puts them back, then animates each one.
  const scrolls = new Map();   // element -> { x0, y0, x1, y1, t0 }
  const SCROLL_MS = 400;
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const nativeTo = Element.prototype.scrollTo;
  const jump = (el, x, y) => nativeTo.call(el, { left: x, top: y, behavior: "instant" });
  function animate(el, x1, y1) {
    scrolls.set(el, { x0: el.scrollLeft, y0: el.scrollTop, x1, y1, t0: vt });
  }
  function stepScrolls() {
    for (const [el, s] of scrolls) {
      const k = Math.min((vt - s.t0) / SCROLL_MS, 1), e = ease(k);
      jump(el, s.x0 + (s.x1 - s.x0) * e, s.y0 + (s.y1 - s.y0) * e);
      if (k >= 1) scrolls.delete(el);
    }
  }
  if (HYBRID) {
    const root = () => document.scrollingElement || document.documentElement;
    const smooth = (o) => o && typeof o === "object" && o.behavior === "smooth";
    const target = (el, o, by) => {
      const num = (v, cur) => (Number.isFinite(+v) ? +v + (by ? cur : 0) : cur);
      animate(el, num(o.left, el.scrollLeft), num(o.top, el.scrollTop));
    };
    const patch = (obj, name, by, elOf) => {
      const orig = obj[name];
      obj[name] = function (...a) {
        const el = elOf(this);
        if (!smooth(a[0])) { scrolls.delete(el); return orig.apply(this, a); }
        target(el, a[0], by);
      };
    };
    for (const [name, by] of [["scrollTo", false], ["scroll", false], ["scrollBy", true]]) {
      patch(window, name, by, root);
      patch(Element.prototype, name, by, (el) => el);
    }
    const nativeIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg) {
      if (!smooth(arg)) return nativeIntoView.call(this, arg);
      const chain = [];
      for (let el = this; el; el = el.parentElement ?? el.getRootNode().host) chain.push([el, el.scrollLeft, el.scrollTop]);
      const sc = root();
      if (!chain.some(([el]) => el === sc)) chain.push([sc, sc.scrollLeft, sc.scrollTop]);
      nativeIntoView.call(this, { ...arg, behavior: "instant" });
      for (const [el, x, y] of chain) {
        const x1 = el.scrollLeft, y1 = el.scrollTop;
        if (x1 === x && y1 === y) continue;
        jump(el, x, y);
        animate(el, x1, y1);
      }
    };
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
  let caretKey = "", caretSince = 0;
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
        #__demo-overlay .ptr { position: absolute; overflow: visible; filter: drop-shadow(0 2px 4px rgba(0,0,0,.4)); }
        #__demo-overlay .trail { opacity: 0; box-shadow: none; }
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
        #__demo-overlay .hl-callout { width: 0; height: 0; animation-name: __demo-fade-in; }
        #__demo-overlay .hl-callout i { position: absolute; background: var(--c); }
        #__demo-overlay .hl-callout .dot { width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; box-shadow: 0 0 0 2px #fff; }
        #__demo-overlay .hl-callout .pill { position: absolute; white-space: nowrap; color: #fff; background: rgba(15,23,42,.86);
          font: 600 ${Math.round(t.captionSize * 0.8)}px/1.2 ${t.font}; padding: 10px 18px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
        #__demo-overlay .side-right .lead, #__demo-overlay .side-left .lead { top: -.75px; width: 44px; height: 1.5px; }
        #__demo-overlay .side-top .lead, #__demo-overlay .side-bottom .lead { left: -.75px; width: 1.5px; height: 44px; }
        #__demo-overlay .side-right .lead { left: 0; }   #__demo-overlay .side-right .pill { left: 44px; translate: 0 -50%; }
        #__demo-overlay .side-left .lead { right: 0; }   #__demo-overlay .side-left .pill { right: 44px; translate: 0 -50%; }
        #__demo-overlay .side-bottom .lead { top: 0; }   #__demo-overlay .side-bottom .pill { top: 44px; translate: -50% 0; }
        #__demo-overlay .side-top .lead { bottom: 0; }   #__demo-overlay .side-top .pill { bottom: 44px; translate: -50% 0; }
        #__demo-overlay .hl.out { animation: __demo-fade-out .3s ease forwards; }
        @keyframes __demo-hl-in { from { opacity: 0; transform: scale(1.08) } to { opacity: 1; transform: none } }
        @keyframes __demo-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes __demo-fade-out { from { opacity: 1 } to { opacity: 0 } }
        @keyframes __demo-draw { from { transform: scaleX(0) } to { transform: none } }
        #__demo-overlay .hud { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; transform-origin: 0 0; }
        #__demo-overlay .card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center;
          gap: 20px; padding: 0 12vw; font-family: ${t.font}; color: #fff; opacity: 0; transition: opacity .35s ease; }
        #__demo-overlay .card.on { opacity: 1; }
        #__demo-overlay .card h1 { margin: 0; font: 700 72px/1.1 ${t.font}; }
        #__demo-overlay .card p { margin: 0; font: 500 34px/1.3 ${t.font}; opacity: .72; }
        #__demo-overlay .cap { position: absolute; left: 50%; ${t.captionPosition === "top" ? "top: 88px" : "bottom: 96px"};
          transform: translateX(-50%); max-width: 80vw; white-space: nowrap;
          font: 600 ${t.captionSize}px/1.2 ${t.font}; color: #fff; background: rgba(15,23,42,.86);
          padding: 14px 26px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25);
          opacity: 0; transition: opacity .35s ease; }
        #__demo-overlay .cap.on { opacity: 1; }
        #__demo-overlay .cap .word { color: rgba(255,255,255,.4); transition: color .12s; }
        #__demo-overlay .cap .word.on { color: #fff; }
        #__demo-overlay .keys { position: absolute; left: 50%; transform: translateX(-50%); display: none; gap: 10px;
          ${t.captionPosition === "top" ? "top" : "bottom"}: ${(t.captionPosition === "top" ? 88 : 96) + Math.round(t.captionSize * 1.2) + 28 + 18}px; }
        #__demo-overlay .keys kbd { min-width: 30px; text-align: center; font: 600 ${t.captionSize}px/1.2 ${t.font}; color: #fff;
          background: rgba(15,23,42,.86); padding: 12px 18px; border-radius: 12px;
          box-shadow: inset 0 -3px 0 rgba(255,255,255,.14), 0 8px 30px rgba(0,0,0,.25); }
        ${t.caret === false ? "" : `input, textarea, [contenteditable] { caret-color: transparent !important; }`}
        #__demo-overlay .caret { position: absolute; width: 1px; display: none; }
        #__demo-overlay .mirror { position: absolute; left: -99999px; top: 0; visibility: hidden; border-style: solid; overflow-wrap: break-word; }
        #__demo-overlay .badge { position: absolute; right: 24px; top: ${t.badgeTop}px; display: none;
          font: 700 20px/1 ${t.font}; letter-spacing: .06em; color: #fff; padding: 10px 16px; border-radius: 10px; }
      </style>
      <div class="hls"></div><div class="caret"></div><div class="mirror"></div>
      <div class="cur"><div class="halo trail"></div><div class="halo"></div><svg class="ptr" viewBox="0 0 24 24" width="${t.cursorSize}" height="${t.cursorSize}"></svg></div>
      <div class="hud"><div class="card"><h1></h1><p></p></div><div class="keys"></div><div class="cap"></div><div class="badge"></div></div>`;
    (document.body || document.documentElement).appendChild(root);
    const $ = (sel) => root.querySelector(sel);
    ui = { root, cur: $(".cur"), halo: $(".halo:not(.trail)"), trail: $(".trail"), ptr: $(".ptr"), hls: $(".hls"), hud: $(".hud"),
      card: $(".card"), cap: $(".cap"), keys: $(".keys"), badge: $(".badge"), caret: $(".caret"), mirror: $(".mirror"), shape: null, hl: new Map() };
    return ui;
  }

  /** "auto" follows the page: hand over links/buttons, I-beam over text fields. */
  function cursorShape(s) {
    if (s.cursorStyle !== "auto") return CURSORS[s.cursorStyle] ? s.cursorStyle : "arrow";
    const el = document.elementFromPoint(s.x, s.y);
    const c = el ? getComputedStyle(el).cursor : "";
    return c === "pointer" ? "hand" : c === "text" ? "ibeam" : "arrow";
  }

  // ---- 3. text caret ---------------------------------------------------------
  // Chromium blinks the native caret on real time, so in the video it flickers at
  // random (a frame takes far longer than 1/fps to render). It is hidden and drawn
  // here instead: solid for 500 ms after every keystroke or caret move, then
  // blinking on the virtual clock — as in a real browser while someone types.
  const MIRRORED = ["font", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize", "lineHeight",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing"];

  /** Caret box in viewport px for the focused field, or null. */
  function caretRect(u) {
    const el = document.activeElement;
    if (!el) return null;
    if (el.isContentEditable) {
      const sel = getSelection();
      if (!sel.rangeCount || !sel.isCollapsed) return null;
      const r = sel.getRangeAt(0).getClientRects()[0];
      return r && r.height ? { x: r.left, y: r.top, h: r.height, key: sel.anchorOffset + el.textContent, el } : null;
    }
    const area = el.tagName === "TEXTAREA";
    if ((!area && el.tagName !== "INPUT") || el.readOnly || el.disabled) return null;
    let pos;
    try { pos = el.selectionStart; } catch { return null; }
    if (typeof pos !== "number" || pos !== el.selectionEnd) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), m = u.mirror;
    for (const p of MIRRORED) m.style[p] = cs[p];
    m.style.whiteSpace = area ? "pre-wrap" : "pre";
    m.style.width = area ? r.width + "px" : "auto";
    const text = el.type === "password" ? "\u2022".repeat(el.value.length) : el.value;
    m.textContent = text.slice(0, pos);
    const mark = m.appendChild(document.createElement("span"));
    mark.textContent = "\u200b";
    const mr = m.getBoundingClientRect(), k = mark.getBoundingClientRect();
    const h = Math.round(parseFloat(cs.fontSize) * 1.15);
    const x = r.left + (k.left - mr.left) - el.scrollLeft;
    // A single-line input centres its line; a textarea flows from the top.
    const y = area ? r.top + (k.top - mr.top) + (k.height - h) / 2 - el.scrollTop : r.top + (r.height - h) / 2;
    if (x < r.left || x > r.right || y < r.top || y + h > r.bottom + 1) return null;
    return { x, y, h, color: cs.color, key: pos + "|" + el.value, el };
  }

  function syncCaret(u, s) {
    const c = s.theme.caret === false ? null : caretRect(u);
    if (!c) { u.caret.style.display = "none"; caretKey = ""; return; }
    if (c.key !== caretKey) { caretKey = c.key; caretSince = vt; }
    const on = (vt - caretSince) % 1000 < 500;
    Object.assign(u.caret.style, {
      display: on ? "block" : "none", left: Math.round(c.x) + "px", top: c.y + "px", height: c.h + "px",
      background: c.color || "currentColor",
    });
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
    if (h.style === "callout") {
      // Anchored at the middle of the target's edge on `side`: dot, leader line, then the pill.
      const g = 6;
      x = { left: h.x - g, right: h.x + h.w + g }[h.side] ?? h.x + h.w / 2;
      y = { top: h.y - g, bottom: h.y + h.h + g }[h.side] ?? h.y + h.h / 2;
      w = ht = 0;
      el.classList.add(`side-${h.side}`);
      el.innerHTML = '<i class="dot"></i><i class="lead"></i><span class="pill"></span>';
      el.querySelector(".pill").textContent = h.text;
    }
    Object.assign(el.style, { left: x + "px", top: y + "px", width: w + "px", height: ht + "px" });
    return el;
  }

  /** Blur ∝ distance covered since the last frame (cap 3 px); the halo leaves a
   *  faint trail behind it. A still cursor renders exactly as without blur. */
  function motionBlur(u, s) {
    const mx = s.x - (u.px ?? s.x), my = s.y - (u.py ?? s.y);
    u.px = s.x; u.py = s.y;
    const speed = s.theme.cursorMotion?.blur ? Math.hypot(mx, my) : 0;
    const sd = Math.min(speed / 10, 3);
    if (sd < 0.05) {
      u.blur.removeAttribute("filter"); u.rot.removeAttribute("transform"); u.unrot.removeAttribute("transform");
      u.trail.style.opacity = 0;
      return;
    }
    const [hx, hy] = u.hot, deg = (Math.atan2(my, mx) * 180) / Math.PI;
    u.rot.setAttribute("transform", `rotate(${deg} ${hx} ${hy})`);
    u.unrot.setAttribute("transform", `rotate(${-deg} ${hx} ${hy})`);
    u.gauss.setAttribute("stdDeviation", `${(sd * 24) / s.theme.cursorSize} 0`);
    u.blur.setAttribute("filter", "url(#__demo-mb)");
    u.trail.style.opacity = Math.min(speed / 40, 1) * 0.35;
    // Trails 1.5 frames behind, but never further than half the halo: a smear, not a second disc.
    const lag = Math.min(1.5, (s.theme.haloSize * 0.45) / speed);
    u.trail.style.translate = `${-mx * lag}px ${-my * lag}px`;
  }

  function sync(s) {
    if (!document.body) return;
    const u = mount(s.theme);
    const c = s.cam;
    // The recorder zooms the whole view; keep caption + badge at their normal screen size.
    u.hud.style.transform = c.z > 1 ? `translate(${c.x}px, ${c.y}px) scale(${1 / c.z})` : "";
    u.cur.style.display = s.cursor ? "block" : "none";
    u.halo.style.display = u.trail.style.display = s.theme.halo ? "block" : "none";
    u.cur.style.transform = `translate(${s.x}px, ${s.y}px)`;
    u.cur.classList.toggle("down", s.pressed);
    const shape = cursorShape(s);
    if (shape !== u.shape) {
      u.shape = shape;
      const [svg, hx, hy] = CURSORS[shape];
      const k = s.theme.cursorSize / 24;
      // Blur group: rotated onto the direction of travel, blurred along its x only,
      // and the pointer counter-rotated inside it — a directional motion blur.
      u.ptr.innerHTML = `<defs><filter id="__demo-mb" x="-50%" y="-50%" width="200%" height="200%">`
        + `<feGaussianBlur stdDeviation="0 0"/></filter></defs><g><g><g>${svg}</g></g></g>`;
      const [rot, blur, unrot] = u.ptr.querySelectorAll("g");
      Object.assign(u, { rot, blur, unrot, gauss: u.ptr.querySelector("feGaussianBlur"), hot: [hx, hy] });
      Object.assign(u.ptr.style, { left: -hx * k + "px", top: -hy * k + "px", transformOrigin: `${hx * k}px ${hy * k}px` });
    }
    motionBlur(u, s);
    if (s.caption) {
      if (u.cap.textContent !== s.caption) {
        // Karaoke: one span per word, lit as the recorder's word times pass (capLit).
        if (s.theme.captionStyle === "karaoke") {
          u.cap.replaceChildren(...s.caption.split(/(\s+)/).map((p) => /\S/.test(p)
            ? Object.assign(document.createElement("span"), { className: "word", textContent: p }) : p));
        } else u.cap.textContent = s.caption;
      }
      u.cap.querySelectorAll(".word").forEach((w, i) => w.classList.toggle("on", s.capLit < 0 || i < s.capLit));
      u.cap.classList.add("on");
    }
    else u.cap.classList.remove("on");
    if (s.card) {
      const c = s.card, key = JSON.stringify(c);
      if (u.cardKey !== key) {
        u.cardKey = key;
        u.card.querySelector("h1").textContent = c.title || "";
        u.card.querySelector("p").textContent = c.subtitle || "";
        u.card.style.background = c.bg;
        u.card.style.alignItems = c.align === "left" ? "flex-start" : "center";
        u.card.style.textAlign = c.align === "left" ? "left" : "center";
      }
      u.card.classList.add("on");
    } else u.card.classList.remove("on");
    if (s.keycap) {
      const html = s.keycap.caps.map((c) => `<kbd>${c.replace(/[&<>]/g, (x) => `&#${x.charCodeAt(0)};`)}</kbd>`).join("");
      if (u.keys.dataset.k !== html) { u.keys.dataset.k = html; u.keys.innerHTML = html; }
      u.keys.style.display = "flex"; u.keys.style.opacity = s.keycap.o;
    } else u.keys.style.display = "none";
    if (s.badge) { u.badge.style.display = "block"; u.badge.textContent = s.badge.text; u.badge.style.background = s.badge.color; }
    else u.badge.style.display = "none";

    syncCaret(u, s);

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

  // ---- 4. change log ----------------------------------------------------------
  // Which elements changed, and when (virtual time), so the recorder's smart
  // click-zoom can tell whether a click's result shows up near it. Boxes are
  // measured when asked, so a panel mid-slide counts where it has got to.
  const changed = new Map();   // element → vt of its last change
  new MutationObserver((records) => {
    for (const r of records) {
      for (let n of r.type === "childList" ? [r.target, ...r.addedNodes] : [r.target]) {
        if (n.nodeType !== 1) n = n.parentElement;
        if (n && !n.closest("#__demo-overlay")) changed.set(n, vt);
      }
    }
    if (changed.size > 5000) for (const [el, t] of changed) if (t < vt - 2000 || !el.isConnected) changed.delete(el);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-expanded"] });

  /** Union box (viewport px) of visible elements changed at vt ∈ [since, until],
   *  clipped to the viewport; ignores anything over 60 % of it. null if none. */
  function changesSince(since, until = Infinity) {
    const vw = innerWidth, vh = innerHeight;
    let b = null;
    for (const [el, t] of changed) {
      if (t < since - 5000) { changed.delete(el); continue; }
      if (t < since || t > until || !el.isConnected) continue;
      if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
      const r = el.getBoundingClientRect();
      const x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0), x1 = Math.min(r.right, vw), y1 = Math.min(r.bottom, vh);
      if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 0.6 * vw * vh) continue;
      b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
    }
    return b && { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] };
  }

  window.__demo = {
    /** Advance virtual time by dt ms, run due rAF callbacks, sync overlay + animations.
     *  Returns the scroll offset, which the recorder's zoom camera needs. */
    tick(dt, state) {
      ticking = true;
      try {
        runTimers(vt + dt);
        stepScrolls();
        const now = perfBase + vt;
        const run = queue; queue = [];
        for (const e of run) { try { e.cb(now); } catch (err) { console.error(err); } }
        if (state) sync(state);
        stepAnimations();
      } finally {
        ticking = false;
      }
      return [scrollX, scrollY];
    },
    now: () => vt,
    changesSince,
    /** Real setTimeout, for the recorder's own waits inside the page. */
    realTimeout: realSetTimeout,
  };
})();
