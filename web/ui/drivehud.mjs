// The Drive mode HUD (Milestone 29, web/stage/drive.mjs): what you are driving, the hints for it, speed / gear / gait,
// ● REC with its countdown and timecode, context prompts at the things you can use ("E · Get in"), the take review
// bar (Keep / Discard / Again, smoothing), the camera choice, a bindings sheet to remap keys and controller buttons,
// and an optional drawing of the controller and keys showing what is pressed (for screen recordings and teaching).
import { ACTIONS, SMOOTHING, remap, resetBindings } from "../stage/drive.mjs";

const CSS = `.ss-drive{position:absolute;z-index:6;pointer-events:none;font:500 12px/1.3 "Soundstage Grotesk",system-ui,sans-serif;color:#f1ecf6}
.ss-drive *{box-sizing:border-box}
.ss-drive [hidden]{display:none!important}
.ss-drive .pill{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:999px;background:rgba(24,18,30,.82);
 border:1px solid rgba(255,255,255,.14);box-shadow:0 4px 14px rgba(0,0,0,.3);backdrop-filter:blur(6px)}
.ss-drive button,.ss-drive select{all:unset;cursor:pointer;padding:3px 8px;border-radius:999px;font:600 11px/1.2 inherit;color:#efe9f5;white-space:nowrap}
.ss-drive select{background:rgba(255,255,255,.06)}
.ss-drive button:hover,.ss-drive select:hover{background:rgba(255,255,255,.12)}
.ss-drive button:focus-visible,.ss-drive select:focus-visible{outline:2px solid #f2ff59}
.ss-drive .tag{font:700 10.5px/1 inherit;letter-spacing:.08em;text-transform:uppercase;color:#1d1622;background:#f2ff59;padding:4px 7px;border-radius:999px}
.ss-drive .name{font-weight:650;padding-right:4px}
.ss-drive kbd{display:inline-block;min-width:17px;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);
 font:650 10px/1.2 ui-monospace,monospace;text-align:center;color:#fff}
.ss-drive .tl{position:absolute;left:10px;top:10px}
.ss-drive .tr{position:absolute;left:50%;top:10px;transform:translateX(-50%)}   /* top centre: the App keeps its own chips top right */
.ss-drive .rec{color:#ff6b6b}
.ss-drive .rec[aria-pressed=true]{background:#e5484d;color:#fff}
.ss-drive .tc{font:650 11.5px/1 ui-monospace,monospace;padding:0 4px;opacity:.9}
.ss-drive .bl{position:absolute;left:10px;bottom:10px;display:flex;flex-wrap:wrap;gap:4px 10px;max-width:62%;padding:6px 10px;border-radius:10px;
 background:rgba(24,18,30,.7);border:1px solid rgba(255,255,255,.1);font-size:11px;opacity:.95}
.ss-drive .bl span{white-space:nowrap}
.ss-drive .br{position:absolute;right:12px;bottom:10px;text-align:right;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.ss-drive .spd{font:700 34px/1 ui-monospace,monospace;letter-spacing:-.02em}
.ss-drive .unit{font:600 11px/1 inherit;opacity:.7;margin-left:3px}
.ss-drive .sub{font:600 11px/1.4 inherit;opacity:.85}
.ss-drive .gear{display:inline-block;min-width:22px;text-align:center;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.14);font:700 13px/1.2 ui-monospace,monospace;margin-left:6px}
.ss-drive .count{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);font:800 96px/1 ui-monospace,monospace;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.6)}
.ss-drive .recdot{position:absolute;left:50%;top:52px;transform:translateX(-50%);display:flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;background:rgba(229,72,77,.92);color:#fff;font:700 11.5px/1 ui-monospace,monospace}
.ss-drive .recdot i{width:8px;height:8px;border-radius:50%;background:#fff;animation:ssdr 1s steps(2) infinite}
@keyframes ssdr{50%{opacity:.2}}
.ss-drive .prompt{position:absolute;transform:translate(-50%,-100%);display:flex;gap:5px;align-items:center;padding:4px 9px;border-radius:999px;
 background:rgba(24,18,30,.88);border:1px solid rgba(242,255,89,.55);font:650 11.5px/1 inherit;white-space:nowrap}
.ss-drive .prompt kbd{background:#f2ff59;color:#1d1622;border-color:#f2ff59}
.ss-drive .stack{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);display:flex;gap:6px}
.ss-drive .stack .prompt{position:static;transform:none}
.ss-drive .take{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);pointer-events:auto;display:flex;gap:6px;align-items:center;padding:6px 8px;
 border-radius:12px;background:rgba(24,18,30,.92);border:1px solid rgba(255,255,255,.16);max-width:92%}
.ss-drive .take .sum{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85;padding:0 6px}
.ss-drive .take .keep{background:#f2ff59;color:#1d1622}
.ss-drive .busy{position:absolute;left:50%;top:22%;transform:translateX(-50%);padding:4px 10px;border-radius:999px;background:rgba(24,18,30,.75);font-weight:650}
.ss-drive .binds{position:absolute;left:10px;top:46px;width:330px;max-height:70%;overflow:auto;pointer-events:auto;padding:8px;border-radius:12px;
 background:rgba(24,18,30,.95);border:1px solid rgba(255,255,255,.16)}
.ss-drive .binds .row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.ss-drive .binds .row button{padding:2px 6px;background:rgba(255,255,255,.08);border-radius:5px;font:600 10.5px/1.2 ui-monospace,monospace}
.ss-drive .binds .row button.wait{background:#f2ff59;color:#1d1622}
.ss-drive .pad{position:absolute;left:50%;bottom:74px;transform:translateX(-50%);opacity:.95}
`;

const KEYNAME = (c) => (c || "").replace(/^Key/, "").replace(/^Digit/, "").replace("Arrow", "").replace("ShiftLeft", "Shift").replace("ShiftRight", "Shift")
  .replace("Space", "Space").replace("Escape", "Esc").replace("Backspace", "⌫").replace("Enter", "⏎");
const PADNAME = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "L3", "R3", "D↑", "D↓", "D←", "D→"];
const kb = (k) => `<kbd>${k}</kbd>`;

/** Hints for what you drive now (keyboard, or the controller when one is in use). */
export function hintsFor(kind, pad = false, carrying = false) {
  const P = pad;
  if (kind === "person") return [
    [P ? "L stick" : "WASD", "move"], [P ? "L3 / LB" : "Shift", "run"], [P ? "A" : "Space", "jump · climb"], [P ? "Y" : "E", "get in · mount · sit"],
    [P ? "X" : "C", carrying ? "set down" : "pick up"], ...(carrying ? [[P ? "RT" : "F", "throw"], [P ? "LT" : "RMB", "aim"], [P ? "B" : "X", "drop"]] : []),
    [P ? "R stick" : "drag", "look"], [P ? "Menu" : "R", "● REC"], [P ? "View" : "V", "camera"], ["Esc", "leave"]];
  if (kind === "car") return [[P ? "RT" : "W", "throttle"], [P ? "LT" : "S", "brake · reverse"], [P ? "L stick" : "A D", "steer"],
    [P ? "A / RB" : "Space", "handbrake"], [P ? "Y" : "E", "get out"], [P ? "D↑" : "L", "lights"], [P ? "D↓" : "O", "door"], [P ? "Menu" : "R", "● REC"], [P ? "View" : "V", "camera"], ["Esc", "leave"]];
  if (kind === "horse" || kind === "animal") return [[P ? "L stick ↑" : "W", "pace"], [P ? "L stick ↔" : "A D", "turn"], [P ? "L3 / LB" : "Shift", "gallop"],
    [P ? "L stick ↓" : "S", "stop · back"], [P ? "Y" : "E", "dismount"], [P ? "Menu" : "R", "● REC"], ["Esc", "leave"]];
  if (kind === "bike" || kind === "boat") return [[P ? "RT" : "W", "throttle"], [P ? "LT" : "S", "brake"], [P ? "L stick" : "A D", "steer"], [P ? "Y" : "E", "get off"], [P ? "Menu" : "R", "● REC"], ["Esc", "leave"]];
  return [[P ? "L stick" : "WASD", "move"], [P ? "A" : "Space", "rise"], [P ? "B" : "Q", "sink"], [P ? "LB RB" : "Z X", "turn"], [P ? "Menu" : "R", "● REC"], ["Esc", "leave"]];
}

/** A drawn controller (and the keys) showing what is pressed this frame: an SVG string. */
export function controllerSvg(inp = {}, down = new Set()) {
  const on = "#f2ff59", off = "rgba(255,255,255,.18)", line = "rgba(255,255,255,.55)";
  const ax = inp.rawAxes || [0, 0, 0, 0], bt = inp.rawButtons || [];
  const b = (i) => (bt[i] || 0) > 0.3;
  const stickAt = (cx, cy, x, y) => `<circle cx="${cx}" cy="${cy}" r="17" fill="rgba(0,0,0,.35)" stroke="${line}"/><circle cx="${cx + x * 11}" cy="${cy + y * 11}" r="9" fill="${Math.hypot(x, y) > 0.1 ? on : off}"/>`;
  const btn = (cx, cy, i, t) => `<circle cx="${cx}" cy="${cy}" r="8" fill="${b(i) ? on : off}"/><text x="${cx}" y="${cy + 3.5}" font-size="9" text-anchor="middle" fill="${b(i) ? "#1d1622" : "#fff"}" font-weight="700">${t}</text>`;
  const trig = (x, i, t) => `<rect x="${x}" y="4" width="34" height="9" rx="4" fill="rgba(0,0,0,.35)" stroke="${line}"/><rect x="${x}" y="4" width="${34 * Math.min(1, bt[i] || 0)}" height="9" rx="4" fill="${on}"/><text x="${x + 17}" y="22" font-size="8" text-anchor="middle" fill="#fff" opacity=".8">${t}</text>`;
  const key = (x, y, w, code, t) => `<rect x="${x}" y="${y}" width="${w}" height="20" rx="4" fill="${down.has(code) ? on : "rgba(0,0,0,.4)"}" stroke="${line}"/><text x="${x + w / 2}" y="${y + 14}" font-size="10" text-anchor="middle" fill="${down.has(code) ? "#1d1622" : "#fff"}" font-weight="700">${t}</text>`;
  return `<svg width="420" height="110" viewBox="0 0 420 110" xmlns="http://www.w3.org/2000/svg">
  <path d="M40 30 Q60 20 100 24 L140 24 Q180 20 200 30 Q222 60 214 92 Q206 106 188 98 L160 78 L80 78 L52 98 Q34 106 26 92 Q18 60 40 30Z" fill="rgba(24,18,30,.85)" stroke="${line}"/>
  ${trig(46, 6, "LT")}${trig(160, 7, "RT")}
  <rect x="46" y="22" width="34" height="5" rx="2" fill="${b(4) ? on : off}"/><rect x="160" y="22" width="34" height="5" rx="2" fill="${b(5) ? on : off}"/>
  ${stickAt(66, 50, ax[0], ax[1])}${stickAt(146, 68, ax[2], ax[3])}
  <rect x="88" y="60" width="9" height="24" fill="${b(12) || b(13) ? on : off}"/><rect x="80" y="68" width="25" height="9" fill="${b(14) || b(15) ? on : off}"/>
  ${btn(176, 58, 0, "A")}${btn(190, 46, 1, "B")}${btn(162, 46, 2, "X")}${btn(176, 34, 3, "Y")}
  <circle cx="110" cy="40" r="4" fill="${b(8) ? on : off}"/><circle cx="130" cy="40" r="4" fill="${b(9) ? on : off}"/>
  ${key(262, 18, 24, "KeyW", "W")}${key(236, 42, 24, "KeyA", "A")}${key(262, 42, 24, "KeyS", "S")}${key(288, 42, 24, "KeyD", "D")}
  ${key(236, 66, 40, "ShiftLeft", "Shift")}${key(280, 66, 70, "Space", "Space")}${key(316, 18, 24, "KeyE", "E")}${key(342, 18, 24, "KeyC", "C")}
  ${key(368, 18, 24, "KeyF", "F")}${key(316, 42, 24, "KeyR", "R")}${key(342, 42, 24, "KeyX", "X")}${key(368, 42, 24, "KeyL", "L")}
  <text x="236" y="102" font-size="9" fill="#fff" opacity=".7">${inp.lookPxSum ? "mouse look" : ""}</text>
</svg>`;
}

export class DriveHud {
  constructor(dm) {
    this.dm = dm;
    const s = dm.s, host = s.canvas.parentElement;
    if (!document.getElementById("ss-drive-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-drive-css", textContent: CSS }));
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const el = this.el = document.createElement("div");
    el.className = "ss-drive";
    el.setAttribute("role", "region"); el.setAttribute("aria-label", "Drive mode");
    el.innerHTML = `
      <div class="tl pill"><span class="tag">🎮 Drive</span><span class="name"></span>
        <select data-cam title="Camera while driving (V)"><option value="chase">Follow cam</option><option value="shot">Shot camera</option><option value="orbit">Orbit</option></select>
        <button data-inputs title="Draw the controller and keys on screen (for recordings)">Inputs</button>
        <button data-binds title="Remap keys and controller buttons">Bindings</button>
        <button data-exit title="Leave Drive mode (Esc)">Exit <kbd>Esc</kbd></button></div>
      <div class="tr pill"><button class="rec" data-rec title="Record a take (R or the controller's Menu button): a 3-2-1 countdown, then the timeline plays while you drive">● REC</button>
        <span class="tc">00:00:00:00</span>
        <select data-from title="Where a take starts"><option value="start">from frame 0</option><option value="here">from the playhead</option></select>
        <select data-smooth title="Smoothing applied to the recorded path">${Object.keys(SMOOTHING).map((k) => `<option value="${k}">${k === "none" ? "raw" : k}</option>`).join("")}</select></div>
      <div class="count" hidden></div><div class="recdot" hidden><i></i><span></span></div>
      <div class="busy" hidden></div>
      <div class="stack"></div><div class="prompts"></div>
      <div class="bl"></div>
      <div class="br"><div><span class="spd">0</span><span class="unit">km/h</span><span class="gear" hidden></span></div><div class="sub"></div></div>
      <div class="take" hidden><strong>Take</strong><span class="sum"></span>
        <button class="keep" data-keep title="Keep it: one undo step (Enter)">Keep <kbd>⏎</kbd></button>
        <button data-discard title="Throw it away (Backspace)">Discard <kbd>⌫</kbd></button>
        <button data-again title="Record it again (R)">Again <kbd>R</kbd></button></div>
      <div class="pad" hidden></div>
      <div class="binds" hidden></div>`;
    host.append(el);
    const q = (sel) => el.querySelector(sel);
    this.$ = { name: q(".name"), cam: q("[data-cam]"), rec: q("[data-rec]"), tc: q(".tc"), from: q("[data-from]"), smooth: q("[data-smooth]"), count: q(".count"),
      recdot: q(".recdot"), busy: q(".busy"), stack: q(".stack"), prompts: q(".prompts"), hints: q(".bl"), spd: q(".spd"), unit: q(".unit"), gear: q(".gear"), sub: q(".sub"),
      take: q(".take"), sum: q(".take .sum"), pad: q(".pad"), binds: q(".binds") };
    for (const e of ["pointerdown", "wheel", "keydown"]) el.addEventListener(e, (ev) => { if (ev.target.closest(".pill,.take,.binds")) ev.stopPropagation(); });
    this.$.cam.addEventListener("change", () => dm.setCamera(this.$.cam.value));
    this.$.from.addEventListener("change", () => { dm.fromStart = this.$.from.value === "start"; });
    this.$.smooth.addEventListener("change", () => dm.setSmoothing(this.$.smooth.value));
    this.$.rec.addEventListener("click", () => (dm.rec ? dm.stopRec() : dm.pending ? dm.again() : dm.record()));
    q("[data-exit]").addEventListener("click", () => dm.stop());
    q("[data-keep]").addEventListener("click", () => dm.keep());
    q("[data-discard]").addEventListener("click", () => dm.discard());
    q("[data-again]").addEventListener("click", () => dm.again());
    q("[data-binds]").addEventListener("click", () => this.toggleBindings());
    q("[data-inputs]").addEventListener("click", () => this.showInputs(this.$.pad.hidden));
    try { if (localStorage.getItem("ss_drive_inputs") === "1") this.showInputs(true); } catch { /* */ }
    this._fit = () => {
      const c = s.canvas;
      Object.assign(el.style, { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: `${c.offsetWidth}px`, height: `${c.offsetHeight}px` });
      // A narrow viewport: the REC bar drops under the name bar instead of running into it.
      const tr = el.querySelector(".tr");
      if (tr) tr.style.top = c.offsetWidth < 1150 ? "46px" : "10px";
    };
    this._fit();
    this._ro = new ResizeObserver(this._fit);
    this._ro.observe(s.canvas);
  }

  close() { this._ro?.disconnect(); this.el.remove(); }

  showInputs(on) {
    this.$.pad.hidden = !on;
    try { localStorage.setItem("ss_drive_inputs", on ? "1" : "0"); } catch { /* */ }
  }

  toggleBindings() {
    const B = this.$.binds;
    B.hidden = !B.hidden;
    if (!B.hidden) this._bindsUi();
  }

  _bindsUi() {
    const dm = this.dm, B = this.$.binds;
    B.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><strong>Bindings</strong><button data-reset>Reset</button></div>
      <div class="sub" style="margin-bottom:6px;opacity:.7">Click a key or a button, then press the new one (Esc cancels).</div>`;
    for (const a of ACTIONS) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span>${a.label}</span><button data-k>${(dm.bindings.keys[a.id] || []).map(KEYNAME).join(" / ") || "—"}</button><button data-p>${(dm.bindings.pad[a.id] || []).map((i) => PADNAME[i] || i).join(" / ") || "—"}</button>`;
      row.querySelector("[data-k]").addEventListener("click", (e) => this._capture(e.currentTarget, a.id, "key"));
      row.querySelector("[data-p]").addEventListener("click", (e) => this._capture(e.currentTarget, a.id, "pad"));
      B.append(row);
    }
    B.querySelector("[data-reset]").addEventListener("click", () => { dm.bindings = resetBindings(); this._bindsUi(); });
  }

  _capture(btnEl, action, how) {
    const dm = this.dm;
    btnEl.classList.add("wait"); btnEl.textContent = how === "key" ? "press a key…" : "press a button…";
    this.capturing = true;
    const done = () => { this.capturing = false; removeEventListener("keydown", onKey, true); clearInterval(poll); this._bindsUi(); };
    const onKey = (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code !== "Escape" && how === "key") dm.bindings = remap(dm.bindings, action, { key: e.code });
      done();
    };
    addEventListener("keydown", onKey, true);
    const poll = setInterval(() => {
      if (how !== "pad") return;
      const p = dm._pad();
      const i = p?.buttons?.findIndex((b) => b.pressed);
      if (i >= 0) { dm.bindings = remap(dm.bindings, action, { button: i }); done(); }
    }, 50);
  }

  update(I) {
    const $ = this.$, dm = this.dm;
    $.name.textContent = I.name || "";
    if ($.cam.value !== I.camera) $.cam.value = I.camera;
    if ($.smooth.value !== I.smoothing) $.smooth.value = I.smoothing;
    $.from.value = I.fromStart ? "start" : "here";
    const fps = I.rec?.fps || dm.fps;
    const f = I.rec?.phase === "rec" ? I.rec.frame : I.frame;
    $.tc.textContent = tc(f, fps) + (I.rec?.phase === "rec" ? ` · ${f}/${I.last}` : "");
    $.rec.setAttribute("aria-pressed", String(!!I.rec));
    $.rec.textContent = I.rec ? "■ Stop" : I.pending ? "● Again" : "● REC";
    $.count.hidden = I.rec?.phase !== "count";
    if (!$.count.hidden) $.count.textContent = String(Math.max(1, I.rec.count));
    $.recdot.hidden = I.rec?.phase !== "rec";
    if (!$.recdot.hidden) $.recdot.querySelector("span").textContent = `REC ${tc(f, fps)}`;
    $.busy.hidden = !I.busy;
    if (I.busy) $.busy.textContent = I.busy + "…";
    // Speed: km/h for vehicles and horses, m/s for people (and the gait).
    const person = I.kind === "person";
    $.spd.textContent = person ? Math.abs(I.speed).toFixed(1) : Math.round(I.kmh);
    $.unit.textContent = person ? "m/s" : "km/h";
    $.gear.hidden = !I.gear;
    if (I.gear) $.gear.textContent = I.gear;
    $.sub.textContent = [I.gait, I.slip > 4 ? `slide ${I.slip}°` : null, I.takes ? `${I.takes} take${I.takes > 1 ? "s" : ""} kept` : null].filter(Boolean).join(" · ");
    // Hints.
    const hs = hintsFor(I.kind, I.pad, (I.prompts || []).some((p) => p.act === "throw"));
    const sig = JSON.stringify(hs);
    if (sig !== this._hsig) { this._hsig = sig; $.hints.innerHTML = hs.map(([k, w]) => `<span>${k.split(" / ").map(kb).join(" ")} ${w}</span>`).join(""); }
    // Prompts: at the thing in the world, or in a row above the hints.
    const placed = [], stacked = [];
    for (const p of I.prompts || []) {
      const key = I.pad ? ({ E: "Y", C: "X", F: "RT", X: "B", Space: "A" }[p.key] || p.key) : p.key;
      const html = `${kb(key)} ${p.label}`;
      const at = p.at && dm.project(p.at);
      if (at) placed.push(`<div class="prompt" style="left:${at[0]}px;top:${at[1]}px">${html}</div>`); else stacked.push(`<div class="prompt">${html}</div>`);
    }
    $.prompts.innerHTML = placed.join("");
    $.stack.innerHTML = stacked.join("");
    // Take review.
    $.take.hidden = !I.pending;
    if (I.pending) $.sum.textContent = `${tc(I.pending.start, fps)}–${tc(I.pending.end, fps)} · ${I.pending.summary.join("; ")}`;
    if (!$.pad.hidden) {
      const pad = dm._pad();
      const inp = { ...I.input, rawAxes: pad ? [...pad.axes] : [0, 0, 0, 0], rawButtons: pad ? pad.buttons.map((b) => (typeof b === "number" ? b : b.value || (b.pressed ? 1 : 0))) : [] };
      $.pad.innerHTML = controllerSvg(inp, dm.down);
    }
  }
}

const tc = (frames, fps = 24) => {
  const f = Math.max(0, Math.floor(frames)), r = Math.round(fps), s = Math.floor(f / r), p = (x) => String(x).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f % r)}`;
};
