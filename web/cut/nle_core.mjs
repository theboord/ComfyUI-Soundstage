// D12 (the Cut as an NLE) core, owner S0a. Design: nle_design_v1.md §3.3 and §9.
// Panes, workspaces, the monitor interface, the key-map switch and the core key-map actions. DOM; does nothing at import:
// everything happens in install(panel), called once from the CutPanel constructor.

import * as KM from "./keymap.mjs";

const LS_WS = "ss_cut_ws";
const LS_KEYMAP = "ss_cut_keymap";
const LS_OFFERED = "ss_cut_keymap_offered";
const AVID_SHUTTLE = [1, 2, 3, 5, 8];   // Media Composer: repeated J or L
const WORKSPACES = ["simple", "edit", "audio"];

const lsGet = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch { /* private window */ } };

/** 10 frames, 8 at 24-based rates (Avid: "8 frames in 24p"). */
export function bigStep(panel) {
  const base = Math.round(panel?.fi?.base || panel?.rate || 24);
  return base === 24 ? 8 : 10;
}

/** The next Avid shuttle speed: the same direction steps up 1, 2, 3, 5, 8; the other way (or stopped) plays 1x. */
export function avidShuttle(speed, dir) {
  const cur = Math.abs(speed);
  if (!cur || Math.sign(speed) !== dir) return dir;
  const i = AVID_SHUTTLE.indexOf(cur);
  return dir * AVID_SHUTTLE[Math.min(AVID_SHUTTLE.length - 1, i < 0 ? 1 : i + 1)];
}

/** One speed step down (toward 1x) or up, keeping the direction (Alt+J / Alt+L while shuttling). */
export function avidShuttleStep(speed, up) {
  if (!speed) return 0;
  const d = Math.sign(speed);
  let i = AVID_SHUTTLE.indexOf(Math.abs(speed));
  if (i < 0) i = 0;
  return d * AVID_SHUTTLE[Math.max(0, Math.min(AVID_SHUTTLE.length - 1, i + (up ? 1 : -1)))];
}

/** The record monitor's side of the monitor interface (§3.3): today's CutPanel methods. */
function recMonitor(panel) {
  const touch = () => { panel._updateButtons(); panel.requestDraw(); };
  return {
    name: "rec",
    get frame() { return Math.floor(panel.frame); },
    get marks() { return panel.marks; },
    get speed() { return panel.speed; },
    get length() { return panel.seqLen || 0; },
    play: (speed = 1) => panel.play(speed),
    stop: () => panel.stop(),
    togglePlay: () => panel.togglePlay(),
    shuttle: (dir) => panel.shuttle(dir),
    step: (n) => panel.step(n),
    seek: (f) => { panel.stop(); panel.seek(f); },
    markIn: () => panel.markIn(),
    markOut: () => panel.markOut(),
    clearIn: () => { panel.marks.in = null; touch(); },
    clearOut: () => { panel.marks.out = null; touch(); },
    clearMarks: () => panel.clearMarks(),
    gotoIn: () => { if (panel.marks.in == null) return false; panel.stop(); panel.seek(panel.marks.in); },
    gotoOut: () => { if (panel.marks.out == null) return false; panel.stop(); panel.seek(panel.marks.out - 1); },
  };
}

export function install(panel) {
  const root = panel.root;
  panel.monitors = { rec: recMonitor(panel), src: null };   // src: P1a's srcmon.mjs
  /** The monitor keys act on: the source monitor when it is active and loaded, else the record monitor. */
  panel.mon = () => (panel.activeMon === "src" && panel.monitors.src) || panel.monitors.rec;
  panel.setActiveMon = (m) => {
    panel.activeMon = m === "src" && panel.monitors.src && !panel.slots.source.hidden ? "src" : "rec";
    panel.slots.rec.classList.toggle("active", panel.activeMon === "rec");
    panel.slots.source.classList.toggle("active", panel.activeMon === "src");
    panel._hook("monitor", panel.activeMon);
  };

  // ---- panes: one tab strip, one pane at a time (Bins, Mixer, Markers register here)
  const tabs = document.createElement("div");
  tabs.className = "ss-cut-panetabs";
  const body = document.createElement("div");
  body.className = "ss-cut-panebody";
  panel.slots.pane.append(tabs, body);
  panel.panes = [];
  panel.pane = null;
  panel.addPane = (id, label, el, order = 0) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, className: "ss-cut-panetab" });
    b.addEventListener("click", () => panel.showPane(id));
    el.hidden = true;
    panel.panes.push({ id, label, el, order, tab: b });
    panel.panes.sort((x, y) => x.order - y.order);
    tabs.replaceChildren(...panel.panes.map((p) => p.tab));
    body.append(el);
  };
  panel.showPane = (id) => {
    const has = panel.panes.some((p) => p.id === id);
    for (const p of panel.panes) {
      p.el.hidden = p.id !== id;
      p.tab.setAttribute("aria-pressed", String(p.id === id));
    }
    panel.slots.pane.hidden = !has;
    panel.pane = has ? id : null;
    panel._fitLayout();
    panel.requestDraw();
  };

  // ---- workspaces (§3.3): Simple = the Cut as before; Edit = bins + source monitor; Audio = mixer
  panel.setWorkspace = (ws, { save = true } = {}) => {
    ws = WORKSPACES.includes(ws) ? ws : "simple";
    const first = ws === "edit" && panel.workspace !== "edit";
    panel.workspace = ws;
    root.dataset.ws = ws;
    if (panel.b?.ws) panel.b.ws.value = ws;
    panel._viewerShare = ws === "simple" ? undefined : 0.45;
    const narrow = (root.clientWidth || 1200) < 900;
    panel.slots.source.hidden = ws !== "edit" || narrow || !panel.monitors.src;
    if (ws === "edit" && narrow && panel.monitors.src) panel.say("The source monitor hides under 900 px wide: widen the Cut to see it.");
    if (panel.activeMon === "src" && panel.slots.source.hidden) panel.setActiveMon("rec");
    panel.showPane(ws === "edit" ? "bins" : ws === "audio" ? "mixer" : null);
    if (save) lsSet(LS_WS, ws);
    if (first) offerKeymap();
  };

  // ---- key maps (§9.1): Soundstage stays the default; the first Edit offers Avid first, then Premiere
  panel.setKeymap = (name, { save = true } = {}) => {
    name = KM.MAPS[name] ? name : KM.DEFAULT_KEYMAP;
    panel.keymapName = name;
    if (panel.b?.keymap) panel.b.keymap.value = name;
    if (panel._helpEl) {
      panel._helpEl.textContent = name === KM.DEFAULT_KEYMAP ? panel._legacyHelp : KM.helpLines(name).join(" · ");
      panel._helpEl.title = panel._helpEl.textContent;
    }
    if (save) lsSet(LS_KEYMAP, name);
  };
  const offerKeymap = () => {
    if (lsGet(LS_OFFERED) || panel.keymapName !== KM.DEFAULT_KEYMAP) return;
    lsSet(LS_OFFERED, "1");
    const pick = (name, text) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: "ss-cut-offer" });
      b.addEventListener("click", () => { panel.setKeymap(name); panel.say(`${KM.MAPS[name]?.label || name} keys on (the keys select changes them).`); });
      return b;
    };
    panel.say("", { html: [document.createTextNode("Keyboard: "), pick("avid", "Use Avid keys"), document.createTextNode(" · "),
      pick("premiere", "Premiere keys"), document.createTextNode(" · "), pick("soundstage", "Keep Soundstage")] });
  };

  // ---- core actions (§5 S0): the bindings live in keymap.mjs, the behaviour here. An action returns false when it
  // did not apply, so the key falls through.
  const A = panel.actions;
  const mon = () => panel.mon();
  let zoomBack = null;
  const remember = () => { zoomBack = { ppf: panel.ppf, scrollX: panel.scrollX }; };
  let kHeld = false, slow = null;
  // Play IN to OUT (6) and loop it (Alt+6), on the active monitor.
  const playRange = (loop) => {
    const m = mon(), mk = m.marks || {};
    const a = mk.in ?? 0, b = mk.out ?? m.length;
    if (b <= a) return false;
    if (m === panel.monitors.rec && loop) { panel.loop = true; panel._updateButtons(); }
    m.seek(a);
    m.play(1);
  };
  // Avid J / K / L: repeated J or L 1, 2, 3, 5, 8x; K held with J or L tapped steps a frame, held plays at about 1/4.
  const kShuttle = (e, dir) => {
    if (e?.repeat) return;
    const m = mon();
    if (kHeld) {
      m.step(dir);
      clearTimeout(slow?.t);
      slow = { dir, t: setTimeout(() => { slow = { dir, playing: true }; m.play(dir * 0.25); }, 250) };
      return;
    }
    if (panel.keymapName === "avid") m.play(avidShuttle(m.speed, dir));
    else m.shuttle(dir);
  };
  Object.assign(A, {
    togglePlay: () => mon().togglePlay(),
    stop: () => mon().stop(),
    shuttleRev: (e) => kShuttle(e, -1),
    shuttleFwd: (e) => kShuttle(e, 1),
    shuttleDown: () => { const m = mon(); if (!m.speed) return false; m.play(avidShuttleStep(m.speed, false)); },
    shuttleUp: () => { const m = mon(); if (!m.speed) return false; m.play(avidShuttleStep(m.speed, true)); },
    pause: (e) => { if (!e?.repeat) kHeld = true; mon().stop(); },
    step: (e, b) => mon().step(b.arg),
    stepBig: (e, b) => mon().step(Math.sign(b.arg) * bigStep(panel)),
    stepSecond: (e, b) => mon().step(Math.sign(b.arg) * Math.round(panel.fi?.base || 24)),
    markIn: () => mon().markIn(),
    markOut: () => mon().markOut(),
    markClip: () => {
      if (panel.activeMon === "src") return false;
      const f = Math.floor(panel.frame);
      let at = 0;
      for (const c of panel.project.cut) {
        const len = c.out - c.in;
        if (f < at + len) { panel.marks = { in: at, out: at + len }; panel._updateButtons(); panel.requestDraw(); return; }
        at += len;
      }
      return false;
    },
    clearIn: () => mon().clearIn(),
    clearOut: () => mon().clearOut(),
    clearMarks: () => mon().clearMarks(),
    gotoIn: () => mon().gotoIn(),
    gotoOut: () => mon().gotoOut(),
    prevEdit: () => panel.gotoEdit(-1),
    nextEdit: () => panel.gotoEdit(1),
    head: () => mon().seek(0),
    tail: () => mon().seek(Math.max(0, mon().length - 1)),
    playInOut: () => playRange(false),
    loopInOut: () => playRange(true),
    toggleMon: () => {
      if (panel._drag) { panel._cancelDrag(); return; }
      if (!panel.monitors.src || panel.slots.source.hidden) return false;
      panel.setActiveMon(panel.activeMon === "src" ? "rec" : "src");
    },
    focus: () => {
      if (panel._focusZoom) { Object.assign(panel, panel._focusZoom); panel._focusZoom = null; panel._clampScroll(); panel.requestDraw(); return; }
      panel._focusZoom = { ppf: panel.ppf, scrollX: panel.scrollX };
      remember();
      panel.zoom(4, panel._x(Math.floor(panel.frame)));
    },
    undo: () => panel.undo(),
    redo: () => panel.redo(),
    zoomIn: () => { remember(); panel.zoom(1.5); },
    zoomOut: () => { remember(); panel.zoom(1 / 1.5); },
    fit: () => { remember(); panel.fit(); },
    zoomBack: () => {
      if (!zoomBack) return false;
      const z = zoomBack;
      remember();
      Object.assign(panel, z);
      panel._clampScroll();
      panel.requestDraw();
    },
    split: () => panel.split(),
    extract: () => panel.extract(),
    rippleDelete: () => panel.rippleDelete(),
    dissolve: () => panel.setTransition(panel._nearestEdit(panel._x(Math.floor(panel.frame))), "dissolve"),
    matchAction: () => panel.matchSelected(),
    keysMode: () => { panel.keysMode = !panel.keysMode; panel._updateButtons(); panel.requestDraw(); },
    slip: (e, b) => { if (panel.sel < 0) return false; panel.slipClip(panel.sel, b.arg); },
    clipGain: (e, b) => {
      const a = panel.aSel && panel.project.audio.find((x) => x.id === panel.aSel);
      if (!a) return false;
      panel.updateAudioClip(panel.aSel, { gain_db: a.gain_db + b.arg });
    },
    escape: (e) => {   // Avid's Esc: cancel a drag, else toggle the source / record monitor, else deselect
      if (panel._drag) { panel._cancelDrag(); return; }
      if (A.toggleMon(e) !== false) return;
      A.deselect();
    },
    monSrc: () => { if (!panel.monitors.src || panel.slots.source.hidden) return false; panel.setActiveMon("src"); },
    monRec: () => panel.setActiveMon("rec"),
    legacy: (e) => panel._legacyKey(e),   // the same meaning as today's key (Delete / Backspace)
    deselect: () => { panel._cancelDrag(); panel.sel = -1; panel.aSel = null; panel._inspect(); panel._updateButtons(); },
    // Bound in a map but built by a later piece (P1a, P1b, P2, P3): the key says so instead of doing something else.
    later: (e, b) => { panel.say(b.note || "Not built yet in this Cut.", { error: true }); },
  });

  root.addEventListener("keyup", (e) => {
    if (e.code === "KeyK") kHeld = false;
    if (slow && (e.code === "KeyJ" || e.code === "KeyL")) {
      clearTimeout(slow.t);
      if (slow.playing) mon().stop();
      slow = null;
    }
  });
  root.addEventListener("blur", () => { kHeld = false; });

  // ---- monitor activation: in Edit and Audio a click on a monitor only activates it (Avid); Simple plays as before
  panel.slots.source.addEventListener("pointerdown", () => panel.setActiveMon("src"));
  panel.slots.rec.addEventListener("pointerdown", () => { if (panel.workspace !== "simple") panel.setActiveMon("rec"); });

  // ---- saved choices (read here, never at import)
  panel.setKeymap(lsGet(LS_KEYMAP) || KM.DEFAULT_KEYMAP, { save: false });
  root.dataset.ws = "simple";
  const ws = lsGet(LS_WS);
  if (ws && ws !== "simple") panel.setWorkspace(ws, { save: false });
}
