// Stage navigation through the stage's own handlers: a Stage made with Object.create(Stage.prototype) runs its real
// _bindControls (pointer, key and wheel handlers in stage.mjs), then installNavigation and installViewNav as the
// constructor does, so the hook lines in stage.mjs (chord, notClick, nav.key before D-means-Drive, the eased snap, the
// one shot-key write) run under test. Events go through a small DOM-style dispatcher (capture, then bubble;
// stopImmediatePropagation honoured). The clock and requestAnimationFrame are driven by hand.
// node --test tests/js/navigation_stagehooks.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// ---- the clock and the frame loop, by hand
let T = 1000;
performance.now = () => T;
let rafQ = new Map(), rafN = 0;
globalThis.requestAnimationFrame = (f) => { rafQ.set(++rafN, f); return rafN; };
globalThis.cancelAnimationFrame = (id) => { rafQ.delete(id); };
/** Run frames ms apart until nothing is queued (or n frames). */
function frames(n = 400, ms = 16) {
  for (let i = 0; i < n && rafQ.size; i++) {
    T += ms;
    const q = [...rafQ.values()]; rafQ = new Map();
    for (const f of q) f(T);
  }
}
globalThis.MouseEvent = class { constructor(type, init = {}) { Object.assign(this, init, { type }); } };

// ---- a window and a canvas that dispatch like the DOM
function node() {
  return {
    ls: [],
    addEventListener(type, fn, opt) { this.ls.push({ type, fn, capture: opt === true || !!opt?.capture }); },
    removeEventListener(type, fn, opt) {
      const cap = opt === true || !!opt?.capture;
      const i = this.ls.findIndex((l) => l.type === type && l.fn === fn && l.capture === cap);
      if (i >= 0) this.ls.splice(i, 1);
    },
  };
}
const win = node();
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.removeEventListener = win.removeEventListener.bind(win);
globalThis.window ??= globalThis;   // the stage's wheel router listens on window (once per page)

const THREE = await import("../../web/vendor/three.module.min.mjs");
const { Stage } = await import("../../web/stage/stage.mjs");
const { installNavigation } = await import("../../web/stage/navigation.mjs");
const { installViewNav } = await import("../../web/stage/viewnav.mjs");

function makeCanvas() {
  const cv = node();
  Object.assign(cv, {
    style: {}, clientWidth: 800, clientHeight: 450, offsetWidth: 800, offsetHeight: 450,
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
  });
  cv.dispatchEvent = (ev) => dispatch(cv, ev, ev.type);
  return cv;
}
function dispatch(cv, init, type = init.type) {
  let stopAll = false, stop = false;
  const ev = Object.assign(init, { type, target: cv, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { stop = true; },
    stopImmediatePropagation() { stop = true; stopAll = true; } });
  const run = (n, capture) => {
    for (const l of [...n.ls]) {
      if (l.type !== type || l.capture !== capture) continue;
      l.fn(ev);
      if (stopAll) return false;
    }
    return true;
  };
  if (!run(win, true)) return ev;
  if (!run(cv, true) || !run(cv, false)) return ev;   // at the target: capture listeners, then the rest
  if (!stop) run(win, false);
  return ev;
}

/** A stage with one car (a 2 m box at the origin) and the real handlers. */
function makeStage({ freeView = true, selected = null, grabbable = true } = {}) {
  win.ls.length = 0;
  rafQ = new Map();
  const cv = makeCanvas();
  const st = Object.create(Stage.prototype);
  const car = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  car.position.set(0, 1, 0);
  car.userData.actorId = "car1";
  car.updateMatrixWorld(true);
  const log = { changes: 0, selects: [], posKeys: 0, liveBegins: 0, driveStarts: 0, menus: 0, framed: [] };
  Object.assign(st, {
    canvas: cv, camera: new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 600), scene: new THREE.Scene(),
    state: { actors: [{ id: "car1", kind: "car", position: [0, 0, 0] }], environment: {} },
    actorMeshes: new Map([["car1", car]]), selected, log,
    render() {}, setFrame() {}, undo() {}, redo() {},
    toJSON() { return {}; },
    onChange() { log.changes++; },
    select(id) { this.selected = id; log.selects.push(id); },
    _nearOnScreen: () => null, _isSetPiece: () => false, _grabbable: () => grabbable,
    _tightCamera: () => false, _tightNow: () => false, _setCollidersCached: () => [],
    _editActorKey() { log.posKeys++; return {}; },
    _frameActor(id) { log.framed.push(id); return true; },
    live: { busy: false, begin() { log.liveBegins++; return true; }, move() {}, end() {}, finish() {} },
    drive: { on: false, canDrive: () => true, start() { log.driveStarts++; } },
  });
  st._bindControls();
  st.tc.enabled = false;   // the gizmo isn't attached to anything here (and it reaches for document)
  st.freeView = freeView;
  st.free = { position: [0, 2, 10], target: [0, 1, 0] };
  st.shot = { position: [0, 2, 10], target: [0, 1, 0] };
  st._activeOrbit = function () { return this.freeView ? this.free : this.shot; };
  st._viewportCamera = function () { return this.freeView ? this.viewCam : this.camera; };
  st._applyActive = function () {
    const o = this._activeOrbit(), cam = this._viewportCamera();
    cam.position.set(...o.position);
    cam.lookAt(new THREE.Vector3(...o.target));
    cam.updateMatrixWorld(true);
  };
  st._applyActive();
  installNavigation(st);
  installViewNav(st);
  st.nav.settings.damping = false;
  st.nav.settings.style = "soundstage";
  cv.addEventListener("contextmenu", () => log.menus++);   // the 3D view's own right-click menu (Compare's Fix menu)
  st.ev = (type, init) => dispatch(cv, { pointerId: 1, ...init }, type);
  st.key = (k, extra = {}) => dispatch(cv, { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...extra }, "keydown");
  st.keyup = (k, extra = {}) => dispatch(cv, { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...extra }, "keyup");
  return st;
}
const CAR = { clientX: 400, clientY: 225 };   // the middle of the view: the car
const SKY = { clientX: 400, clientY: 4 };     // the top edge: above the horizon, nothing there
const EMPTY = { clientX: 60, clientY: 400 };  // the floor off to the side, no object
const done = (st) => { st.nav.dispose(); frames(); };

test("both buttons on the selected car: a pan, the car never moves and no position key is written", () => {
  const st = makeStage({ selected: "car1" });
  const p0 = [...st.free.position], t0 = [...st.free.target];
  st.ev("pointerdown", { button: 0, buttons: 1, ...CAR });
  st.ev("pointermove", { button: -1, buttons: 3, clientX: 402, clientY: 225 });   // right joins before the 4 px grab
  st.ev("pointermove", { button: -1, buttons: 3, clientX: 440, clientY: 240 });
  st.ev("pointermove", { button: -1, buttons: 3, clientX: 470, clientY: 250 });
  T += 200;   // a pause before letting go: no flick glide
  st.ev("pointerup", { button: 0, buttons: 2, clientX: 470, clientY: 250 });
  st.ev("pointerup", { button: 2, buttons: 0, clientX: 470, clientY: 250 });
  frames();
  assert.equal(st.log.liveBegins, 0, "no grab started");
  assert.equal(st.log.posKeys, 0, "no position key written");
  assert.deepEqual(st.state.actors[0].position, [0, 0, 0]);
  const d0 = p0.map((v, i) => v - t0[i]), d1 = st.free.position.map((v, i) => v - st.free.target[i]);
  assert.ok(Math.hypot(...st.free.position.map((v, i) => v - p0[i])) > 0.05, "the camera moved");
  d0.forEach((v, i) => assert.ok(Math.abs(v - d1[i]) < 2e-3, "it translated without turning"));
  assert.deepEqual(st.log.selects, [], "a chord release is not a click");
  done(st);
});

test("a click under 5 px selects what's under it; a click on empty space deselects", () => {
  const st = makeStage({ grabbable: false });
  st.ev("pointerdown", { button: 0, buttons: 1, ...CAR });
  st.ev("pointermove", { button: -1, buttons: 1, clientX: 403, clientY: 226 });
  st.ev("pointerup", { button: 0, buttons: 0, clientX: 403, clientY: 226 });
  assert.equal(st.selected, "car1");
  st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
  st.ev("pointerup", { button: 0, buttons: 0, ...EMPTY });
  assert.equal(st.selected, null);
  assert.deepEqual(st.log.selects, ["car1", null]);
  done(st);
});

test("a right click selects and replays exactly one context menu; a right drag opens none", () => {
  const st = makeStage({ grabbable: false });
  st.ev("pointerdown", { button: 2, buttons: 2, ...CAR });
  st.ev("contextmenu", { button: 2, buttons: 2, ...CAR });   // macOS: the menu event comes on the press
  assert.equal(st.log.menus, 0, "held back until we know it's a click");
  st.ev("pointerup", { button: 2, buttons: 0, ...CAR });
  assert.equal(st.selected, "car1", "selected");
  assert.equal(st.log.menus, 1, "one replayed menu");
  // A right drag (fly / look): no menu, before or after.
  st.ev("pointerdown", { button: 2, buttons: 2, ...EMPTY });
  st.ev("contextmenu", { button: 2, buttons: 2, ...EMPTY });
  st.ev("pointermove", { button: -1, buttons: 2, clientX: EMPTY.clientX + 40, clientY: EMPTY.clientY });
  T += 200;
  st.ev("pointerup", { button: 2, buttons: 0, clientX: EMPTY.clientX + 40, clientY: EMPTY.clientY });
  st.ev("contextmenu", { button: 2, buttons: 0, clientX: EMPTY.clientX + 40, clientY: EMPTY.clientY });   // Windows: on release
  assert.equal(st.log.menus, 1);
  done(st);
});

test("right held + D with a drivable car selected flies right (drive.start 0 times); without right, D drives", () => {
  const st = makeStage({ selected: "car1" });
  st.ev("pointerdown", { button: 2, buttons: 2, ...SKY });
  const x0 = st.free.position[0];
  st.key("d");
  frames(5);
  assert.equal(st.log.driveStarts, 0, "Drive not started");
  assert.ok(st.free.position[0] > x0, "flew right");
  st.keyup("d");
  st.ev("pointerup", { button: 2, buttons: 0, ...SKY });
  frames();
  st.key("d");
  assert.equal(st.log.driveStarts, 1, "plain D starts Drive");
  done(st);
});

test("an eased compass snap marks the view history and lands", () => {
  const st = makeStage();
  const n0 = st.viewNav.history.list.length;
  st.snapView("+y");
  assert.equal(st.viewNav.history.list.length, n0 + 1, "marked before the jump");
  assert.equal(st.nav.settings.damping, false);
  st.nav.settings.damping = true;
  st.snapView("+x");
  assert.equal(st.viewNav.history.list.length, n0 + 2, "an eased snap marks too");
  frames();
  assert.ok(Math.abs(st.free.position[0] - Math.sqrt(101)) < 0.01 && Math.abs(st.free.position[2]) < 0.01, `landed on +x (${st.free.position})`);
  done(st);
});

test("Camera view: a snap cut short by a press is written where it stopped (not left moved and unsaved)", () => {
  const st = makeStage({ freeView: false });
  st.nav.settings.damping = true;
  st.snapView("+x");
  frames(8);   // ~130 ms of the 300 ms ease
  const mid = [...st.shot.position];
  assert.ok(mid[0] > 0.5 && mid[2] > 0.5, `part-way (${mid})`);
  assert.equal(st.log.changes, 0);
  st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
  assert.equal(st.log.changes, 1, "written at the press");
  st.ev("pointerup", { button: 0, buttons: 0, ...EMPTY });
  frames();
  assert.deepEqual(st.shot.position, mid, "the ease stopped there");
  assert.equal(st.log.changes, 1, "once");
  done(st);
});

test("Camera view: a damped drag writes the shot key exactly once, after the motion settles", () => {
  const st = makeStage({ freeView: false });
  st.nav.settings.damping = true;
  st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
  for (let i = 1; i <= 6; i++) { T += 16; st.ev("pointermove", { button: -1, buttons: 1, clientX: EMPTY.clientX + i * 12, clientY: EMPTY.clientY }); }
  T += 200;   // held still before release: no flick
  st.ev("pointerup", { button: 0, buttons: 0, clientX: EMPTY.clientX + 72, clientY: EMPTY.clientY });
  assert.equal(st.log.changes, 0, "not yet: the drag is still easing in");
  frames();
  assert.equal(st.log.changes, 1, "one write once it settled");
  assert.equal(st.nav.pending(), false);
  done(st);
});

test("Camera view: a flick hands the drag's leftover to the glide (not both moving the camera), one write", () => {
  const st = makeStage({ freeView: false });
  st.nav.settings.damping = true;
  st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
  for (let i = 1; i <= 4; i++) { T += 10; st.ev("pointermove", { button: -1, buttons: 1, clientX: EMPTY.clientX + i * 20, clientY: EMPTY.clientY }); }
  st.ev("pointerup", { button: 0, buttons: 0, clientX: EMPTY.clientX + 80, clientY: EMPTY.clientY });
  assert.equal(st.nav.pending(), false, "the glide took the leftover");
  frames();
  assert.equal(st.log.changes, 1, "written once, when the glide stopped");
  done(st);
});

test("a drag that arrives as one jump doesn't glide on (only a real flick does)", () => {
  const run = (moves) => {
    const st = makeStage();
    st.nav.settings.damping = true;
    st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
    for (let i = 1; i <= moves; i++) { T += 10; st.ev("pointermove", { button: -1, buttons: 1, clientX: EMPTY.clientX + (i * 40) / moves, clientY: EMPTY.clientY }); }
    st.ev("pointerup", { button: 0, buttons: 0, clientX: EMPTY.clientX + 40, clientY: EMPTY.clientY });
    const glides = !!st._glideRaf;
    frames();
    done(st);
    return glides;
  };
  assert.equal(run(1), false, "one 40 px jump: no glide (it read as a fast flick and swung the view ~75°)");
  assert.equal(run(4), true, "four quick moves then letting go: still a flick that glides on");
});

test("double-click: on the car it frames it; on the sky nothing moves", () => {
  const st = makeStage();
  st.free = { position: [0, 2, 40], target: [0, 1, 0] };
  st._applyActive();
  st.ev("dblclick", { button: 0, ...SKY });
  frames();
  assert.deepEqual(st.free.position, [0, 2, 40], "a miss leaves a far camera where it was");
  assert.deepEqual(st.log.framed, []);
  st.ev("dblclick", { button: 0, ...CAR });
  assert.deepEqual(st.log.framed, ["car1"]);
  done(st);
});

test("macOS: hold W, then ⌘Z, then let go of W with no keyup: the camera stops", () => {
  const st = makeStage({ freeView: false });
  st.key("w");
  frames(3);
  assert.ok(st.nav._held.has("w"));
  st.key("Meta", { metaKey: true });
  st.key("z", { metaKey: true });   // the stage's own ⌘Z returns early; the capture listener still saw ⌘
  assert.equal(st.nav._held.size, 0);
  frames();
  const z = st.shot.position[2];
  frames(5);
  assert.equal(st.shot.position[2], z, "stopped");
  assert.equal(st.log.changes, 1, "the shot key written once");
  done(st);
});

test("Maya: Alt + right drag is a dolly, not fly mode (the wheel zooms, W doesn't fly at fly speed)", () => {
  const st = makeStage({ selected: "car1" });
  st.nav.settings.style = "maya";
  st.ev("pointerdown", { button: 2, buttons: 2, altKey: true, ...EMPTY });
  assert.equal(st.nav.wheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120, ...EMPTY }), false, "the wheel zooms");
  st.key("d");
  assert.equal(st.log.driveStarts, 1, "D is Drive, not fly right");
  st.ev("pointerup", { button: 2, buttons: 0, altKey: true, ...EMPTY });
  done(st);
});
