// Stage navigation with real DOM-style event dispatch (capture → target → bubble, stopImmediatePropagation honoured),
// and Drive's own window/canvas capture listeners attached from drive.mjs (DriveMode.prototype._bind, unchanged).
// Review finding 1: a right press while driving left fly mode stuck on after Drive (the wheel set fly speed, D flew
// instead of starting Drive), because Drive's window-capture pointerup swallowed the release.
// node --test tests/js/navigation_stage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// ---- a tiny two-node DOM: window ⟶ canvas
function node(name, parent = null) {
  const ls = [];
  const n = {
    name, parent, ls,
    addEventListener(type, fn, opt) { ls.push({ type, fn, capture: opt === true || !!opt?.capture }); },
    removeEventListener(type, fn, opt) {
      const cap = opt === true || !!opt?.capture;
      const i = ls.findIndex((l) => l.type === type && l.fn === fn && l.capture === cap);
      if (i >= 0) ls.splice(i, 1);
    },
  };
  return n;
}
const win = node("window");
globalThis.addEventListener = win.addEventListener;
globalThis.removeEventListener = win.removeEventListener;
globalThis.requestAnimationFrame = () => 0;     // the test drives the frame loop by hand (nav._tick)
globalThis.cancelAnimationFrame = () => {};
globalThis.MouseEvent = class { constructor(type, init = {}) { Object.assign(this, init, { type }); } };

const cv = node("canvas", win);
cv.setPointerCapture = () => {};
cv.focus = () => {};
cv.dispatchEvent = (ev) => dispatch(ev, ev.type);

/** Dispatch at the canvas (or at another element when `target` says so): window capture, target (capture, then bubble), window bubble. */
function dispatch(init, type = init.type, target = cv) {
  let stopAll = false, stop = false;
  const ev = Object.assign(init, { type, target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { stop = true; },
    stopImmediatePropagation() { stop = true; stopAll = true; } });
  const run = (n, capture) => {
    for (const l of [...n.ls]) {
      if (l.type !== type || l.capture !== capture) continue;
      l.fn(ev);
      if (stopAll) return false;
    }
    return !stop;
  };
  if (!run(win, true)) return ev;
  if (target === cv) { if (!run(cv, true) || !run(cv, false)) return ev; }
  run(win, false);
  return ev;
}
const ptr = (type, button, buttons, x = 100, y = 100, extra = {}) => dispatch({ button, buttons, clientX: x, clientY: y, pointerId: 1, ...extra }, type);
const keyEv = (k) => ({ key: k, code: `Key${k.toUpperCase()}`, preventDefault() {}, stopPropagation() {} });

const { installNavigation } = await import("../../web/stage/navigation.mjs");
const { DriveMode, DEFAULT_BINDINGS } = await import("../../web/stage/drive.mjs");

function makeStage(over = {}) {
  const st = {
    canvas: cv, freeView: true, selected: "car1", state: { environment: {}, actors: [] }, actorMeshes: new Map(), changes: 0,
    orbit: { position: [0, 2, 10], target: [0, 1, 0] },
    _activeOrbit() { return this.orbit; },
    _applyActive() {},
    _navDrag() {},
    _tightNow() { return false; },
    onChange() { this.changes++; },
    toJSON() { return {}; },
    _onWheel() {},
    ...over,
  };
  installNavigation(st);
  const d = Object.create(DriveMode.prototype);
  Object.assign(d, { s: st, on: false, bindings: DEFAULT_BINDINGS, down: new Set(), mouse: [0, 0], mbuttons: new Set(), cam: { dist: 5 },
    canDrive: () => true, say() {} });
  st.drive = d;
  return st;
}
const enterDrive = (st) => { st.drive.on = true; st.drive._bind(); };
const leaveDrive = (st) => { st.drive._unbind(); st.drive.on = false; };

test("a right press while driving (Drive swallows the release) leaves fly mode off after Drive", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage();
  enterDrive(st);
  ptr("pointerdown", 2, 2);
  ptr("pointermove", -1, 2, 160, 140);
  ptr("pointerup", 2, 0, 160, 140);
  assert.equal(st.drive.mbuttons.size, 0, "Drive saw its own press and release");
  leaveDrive(st);
  assert.equal(st.nav._rmb.down, false, "not flying after Drive");
  assert.equal(st.nav.wheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }), false, "the wheel zooms again");
  assert.equal(st.nav.key(keyEv("d")), false, "D starts Drive again (falls through)");
  st.nav.dispose();
});

test("right held when Drive starts, released inside Drive: still not flying afterwards", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage();
  ptr("pointerdown", 2, 2);
  assert.equal(st.nav._rmb.down, true);
  enterDrive(st);
  ptr("pointerup", 2, 0);           // Drive's window-capture _onUp has no drag, but our window fallback ran first anyway
  leaveDrive(st);
  assert.equal(st.nav._rmb.down, false);
  assert.equal(st.nav.key(keyEv("d")), false, "D is Drive");
  st.nav.dispose();
});

test("right pressed on the canvas, released off it (no pointer capture): the window fallback ends fly mode", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage();
  ptr("pointerdown", 2, 2);
  dispatch({ button: 2, buttons: 0, clientX: 900, clientY: 10 }, "pointerup", { tagName: "DIV" });
  assert.equal(st.nav._rmb.down, false);
  assert.equal(st.nav.wheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }), false);
  st.nav.dispose();
});

test("a lost right release is noticed on the next pointer event without the right button", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage();
  ptr("pointerdown", 2, 2);
  st.nav.key(keyEv("w"));
  assert.ok(st.nav._held.has("w"));
  ptr("pointermove", -1, 0, 120, 120);
  assert.equal(st.nav._rmb.down, false);
  assert.equal(st.nav._held.size, 0, "held fly keys cleared");
  ptr("pointerdown", 2, 2);
  ptr("pointerdown", 0, 1);           // a left press with right no longer held
  assert.equal(st.nav._rmb.down, false);
  st.nav.dispose();
});

test("inside a car, holding right flies at the tight step, not the set's fly speed", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage({ _tightNow: () => true, orbit: { position: [0, 1.2, 0.5], target: [0, 1.2, -1] } });
  st.nav.settings.damping = false;
  st.nav.settings.flySpeed = 16;
  ptr("pointerdown", 2, 2);
  st.nav.key(keyEv("w"));
  const z0 = st.orbit.position[2];
  st.nav._tick();   // dt is clamped at ≥ 1 ms on the first frame
  const t0 = performance.now(); while (performance.now() - t0 < 20) { /* let ~20 ms pass */ }
  const z1 = st.orbit.position[2];
  st.nav._tick();
  const step = Math.abs(st.orbit.position[2] - z1);
  assert.ok(st.orbit.position[2] < z0, "it moves forward");
  assert.ok(step < 0.1, `tight step (${step.toFixed(4)} m in ~20 ms); 16 m/s would be ~0.32 m`);
  st.nav.dispose();
});

test("Windows: left released first in a both-buttons pan, then right: the context menu that follows is suppressed", () => {
  cv.ls.length = 0; win.ls.length = 0;
  while (performance.now() < 1000) { /* past the 400 ms after-a-right-drag window measured from a zero clock */ }
  const st = makeStage();
  ptr("pointerdown", 0, 1);
  st._dragging = true;
  st.nav.chord({ mode: "orbit", x0: 100, y0: 100 }, { buttons: 3, clientX: 130, clientY: 100 });
  ptr("pointermove", -1, 2, 140, 100);   // left came up, right still held
  ptr("pointerup", 2, 0, 150, 100);
  st._dragging = false;
  const menu = dispatch({ button: 2, buttons: 0, clientX: 150, clientY: 100 }, "contextmenu");
  assert.equal(menu.defaultPrevented, true, "no Fix menu after a pan");
  st.nav.dispose();
});

test("Camera view: a trackpad orbit, then a quick click, still reports the shot-camera move", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage({ freeView: false });
  st.nav.settings.trackpad = "trackpad";   // ⚙ Scrolling: Trackpad (Auto needs a few events to be sure)
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), true, "trackpad scroll orbits");
  st.nav._tick();
  // The press lands before the loop settles.
  st._dragging = true;
  st.nav.halt();
  assert.equal(st.changes, 1, "written at the press, not lost");
  st.nav.end();
  st._dragging = false;
  st.nav._tick();
  assert.equal(st.changes, 1, "exactly once");
  st.nav.dispose();
});

test("dispose removes the window and canvas listeners it added", () => {
  cv.ls.length = 0; win.ls.length = 0;
  const st = makeStage();
  assert.ok(win.ls.length > 0 && cv.ls.length > 0);
  st.nav.dispose();
  assert.equal(win.ls.length, 0);
  assert.equal(cv.ls.length, 0);
});
