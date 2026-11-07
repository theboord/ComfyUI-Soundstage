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

// ---- review round: held keys by e.code, set / interior geometry under the cursor, set-piece focus, one raycast, guards
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const WALL = { id: "w", half: [10, 3, 0.1], pos: [0, 3, 5], quat: [0, 0, 0, 1] };   // a wall across the view at z = 5

test("macOS: hold W, press Option (e.key turns to ∑): the held key lets go, the camera stops", () => {
  const st = makeStage();
  st.key("w");
  frames(3);
  assert.ok(st.nav._held.has("w"));
  st.key("Alt", { code: "AltLeft", altKey: true });
  assert.equal(st.nav._held.size, 0, "Option pressed: dropped");
  frames();
  const z = st.free.position[2];
  st.keyup("w", { key: "∑", code: "KeyW", altKey: true });   // the keyup macOS sends with Option down
  frames(5);
  assert.equal(st.free.position[2], z, "stopped");
  done(st);
});

test("a keyup whose e.key changed (Option pressed elsewhere) still lets go of the key by e.code", () => {
  const st = makeStage();
  st.key("w");
  st.key("d");
  assert.deepEqual([...st.nav._held].sort(), ["d", "w"]);
  st.nav.keyup({ key: "∑", code: "KeyW", altKey: false, shiftKey: false });
  assert.deepEqual([...st.nav._held], ["d"], "W let go by its code; D still held");
  st.keyup("d");
  assert.equal(st.nav._held.size, 0);
  done(st);
});

test("held keys drop on window blur, a hidden tab, the pointer leaving the window and Ctrl / ⌘", () => {
  const st = makeStage();
  const fire = (type, ev = {}) => { for (const l of [...win.ls]) if (l.type === type) l.fn(ev); };
  for (const [what, act] of [["blur", () => fire("blur")], ["pointer out of the window", () => fire("pointerout", { relatedTarget: null })],
    ["Control", () => st.key("Control", { code: "ControlLeft", ctrlKey: true })], ["Meta", () => st.key("Meta", { code: "MetaLeft", metaKey: true })]]) {
    st.key("w");
    assert.equal(st.nav._held.size, 1);
    act();
    assert.equal(st.nav._held.size, 0, what);
  }
  st.key("w");
  fire("pointerout", { relatedTarget: {} });   // onto another element of the page: still held
  assert.equal(st.nav._held.size, 1);
  st.key("w", { shiftKey: true });
  st.key("Shift", { code: "ShiftLeft", shiftKey: true });   // Shift is the 4x speed, not a let-go
  assert.equal(st.nav._held.size, 1);
  st.keyup("w");
  done(st);
});

test("the orbit pivot lands on a set wall in front of the car (the nearest hit wins)", () => {
  const st = makeStage();
  assert.ok(near(st.nav.pivotAt(CAR)[2], 1, 0.1), "no wall: the car's front");
  st._setCollidersCached = () => [WALL];
  const p = st.nav.begin({ button: 0, ...CAR }).pivot;
  assert.ok(near(p[2], 5.1), `on the wall's face (${p})`);
  done(st);
});

test("an interior wall the dollhouse cutaway hides is looked through; with the cutaway off the pivot lands on it", () => {
  const st = makeStage();
  const ig = new THREE.Group();
  for (const z of [5, -5]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 0.1));
    w.position.set(0, 1.2, z);
    w.userData.wall = { axis: "z", at: z };
    ig.add(w);
  }
  ig.updateMatrixWorld(true);
  st.interiorGroup = ig;
  st.state.interior = { ceiling_m: 2.4 };
  assert.ok(near(st.nav.pivotAt(CAR)[2], 1, 0.1), "the near wall is cut away from out here: the car");
  st.cutaway = false;
  assert.ok(near(st.nav.pivotAt(CAR)[2], 5.05), "cutaway off: the wall");
  done(st);
});

test("double-click inside a room never glides through the wall behind you", () => {
  const st = makeStage();
  st.actorMeshes.clear();
  // A room: you stand at z = 2 looking down at the floor 1.4 m ahead, a wall 0.2 m behind you.
  st._setCollidersCached = () => [{ id: "back", half: [5, 2, 0.1], pos: [0, 2, 2.3], quat: [0, 0, 0, 1] },
    { id: "front", half: [5, 2, 0.1], pos: [0, 2, -3], quat: [0, 0, 0, 1] }];
  st.free = { position: [0, 1, 2], target: [0, 0, 1] };
  st._applyActive();
  st.ev("dblclick", { button: 0, clientX: 400, clientY: 225 });
  frames();
  const z = st.free.position[2];
  assert.ok(z < 2.2 && z > -2.9, `still inside the room (z ${z})`);
  assert.ok(near(st.free.target[1], 0, 0.05), "the target is the clicked floor point");
  // Without the wall behind, the same double-click keeps the view direction and backs off to 2 m (focusView).
  const st2 = makeStage();
  st2.actorMeshes.clear();
  st2.free = { position: [0, 1, 2], target: [0, 0, 1] };
  st2._applyActive();
  st2.ev("dblclick", { button: 0, clientX: 400, clientY: 225 });
  frames();
  assert.ok(st2.free.position[2] > 2.2, "no wall: it backs off past where the wall was");
  done(st); done(st2);
});

test("double-click on a set piece moves the target to the clicked point and keeps the view direction (no framing)", () => {
  const st = makeStage();
  st._isSetPiece = (id) => id === "car1";
  const d0 = st.free.position.map((v, i) => v - st.free.target[i]);
  st.ev("dblclick", { button: 0, ...CAR });
  frames();
  assert.deepEqual(st.log.framed, [], "not framed whole");
  assert.ok(near(st.free.target[2], 1, 0.1) && Math.abs(st.free.target[0]) < 0.05, `target on the clicked face (${st.free.target})`);
  const d1 = st.free.position.map((v, i) => v - st.free.target[i]);
  const n = (v) => v.map((x) => x / Math.hypot(...v));
  n(d0).forEach((v, i) => assert.ok(Math.abs(v - n(d1)[i]) < 1e-3, "same view direction"));
  done(st);
});

test("Ctrl + wheel from a mouse zooms at 1x; a trackpad pinch (fractional) at 5x", () => {
  const st = makeStage();
  st._zoomAcc = 0;
  st._onWheel({ deltaY: 40, deltaX: 0, deltaMode: 0, wheelDeltaY: -120, ctrlKey: true, ...EMPTY });
  assert.equal(st._zoomAcc, 40, "mouse Ctrl + wheel: 1x");
  frames();
  st._zoomAcc = 0;
  st._onWheel({ deltaY: 2.5, deltaX: 0, deltaMode: 0, ctrlKey: true, ...EMPTY });
  assert.equal(st._zoomAcc, 12.5, "pinch: 5x");
  frames();
  done(st);
});

test("a press casts the actor ray once (the orbit pivot reuses the stage's hit)", () => {
  const st = makeStage();
  const ray = st._pickRay(EMPTY);
  const orig = ray.intersectObjects.bind(ray);
  let n = 0;
  ray.intersectObjects = (objs, rec) => { if (objs.includes(st.actorMeshes.get("car1"))) n++; return orig(objs, rec); };
  st.ev("pointerdown", { button: 0, buttons: 1, ...CAR });
  st.ev("pointerup", { button: 0, buttons: 0, ...CAR });
  assert.equal(n, 1);
  done(st);
});

test("RotateTools: Alt + drag on the selected object turns it in Soundstage, and leaves the press to the camera in Maya", async () => {
  const { RotateTools } = await import("../../web/stage/rotate.mjs");
  for (const [style, turns] of [["soundstage", true], ["blender", true], ["maya", false], ["unreal", false]]) {
    const st = makeStage({ selected: "car1" });
    st.tc.disconnect();
    st.nav.settings.style = style;
    st._gizmoOn = true;
    st.tc.object = st.actorMeshes.get("car1");
    const rt = new RotateTools(st);
    const p0 = [...st.free.position];
    st.ev("pointerdown", { button: 0, buttons: 1, altKey: true, ...CAR });
    assert.equal(rt.drag?.kind === "alt", turns, `${style}: ${turns ? "turns" : "orbits"}`);
    if (!turns) {
      st.ev("pointermove", { button: -1, buttons: 1, altKey: true, clientX: CAR.clientX + 60, clientY: CAR.clientY });
      T += 200;
      st.ev("pointerup", { button: 0, buttons: 0, altKey: true, clientX: CAR.clientX + 60, clientY: CAR.clientY });
      assert.ok(Math.hypot(...st.free.position.map((v, i) => v - p0[i])) > 0.05, `${style}: the camera orbited`);
    }
    rt.drag = null;
    rt.dispose();
    done(st);
  }
});

test("Maya / Unreal: Alt over a gizmo arrow pauses the gizmo and orbits; Soundstage leaves the arrow its press", () => {
  for (const [style, orbits] of [["maya", true], ["unreal", true], ["soundstage", false]]) {
    const st = makeStage({ selected: "car1" });
    st.tc.disconnect();
    st.tc.attach(st.actorMeshes.get("car1"));
    st.tcHelper.visible = true;
    st.tc.enabled = true;
    st.tc.axis = "X";   // the cursor is over an arrow
    st.nav.settings.style = style;
    const p0 = [...st.free.position];
    st.ev("pointerdown", { button: 0, buttons: 1, altKey: true, ...CAR });
    assert.equal(st._tcPaused === true, orbits, `${style}: gizmo paused`);
    assert.equal(st.tc.enabled, !orbits);
    st.ev("pointermove", { button: -1, buttons: 1, altKey: true, clientX: CAR.clientX + 60, clientY: CAR.clientY });
    T += 200;
    st.ev("pointerup", { button: 0, buttons: 0, altKey: true, clientX: CAR.clientX + 60, clientY: CAR.clientY });
    const moved = Math.hypot(...st.free.position.map((v, i) => v - p0[i])) > 0.05;
    assert.equal(moved, orbits, `${style}: camera ${orbits ? "orbits" : "stays (the arrow has it)"}`);
    assert.equal(st.tc.enabled, true, "the gizmo is back on after the release");
    st.tc.detach();
    done(st);
  }
});

test("Camera view: a double-click writes no key and leaves the shot camera where it is", () => {
  const st = makeStage({ freeView: false });
  const msgs = [];
  st.onInteract = (m) => msgs.push(m);
  const p0 = [...st.shot.position], t0 = [...st.shot.target];
  st.ev("dblclick", { button: 0, ...EMPTY });
  st.ev("dblclick", { button: 0, ...CAR });
  frames();
  assert.equal(st.log.changes, 0, "no shot key");
  assert.deepEqual(st.log.framed, []);
  assert.deepEqual([st.shot.position, st.shot.target], [p0, t0]);
  assert.ok(msgs.some((m) => /Free view/.test(m)), "it says why");
  done(st);
});

test("a double-click on a key camera keeps its click: no focus", () => {
  const st = makeStage();
  st.camViz = { _keyCamAt: () => true };
  const p0 = [...st.free.position];
  st.ev("dblclick", { button: 0, ...CAR });
  st.ev("dblclick", { button: 0, ...EMPTY });
  frames();
  assert.deepEqual(st.log.framed, []);
  assert.deepEqual(st.free.position, p0);
  done(st);
});

test("while driving, the stage's own wheel, WASD and double-click handlers leave the view alone", () => {
  // The real Drive also swaps _onWheel and swallows letter keys in a window listener; this checks the stage's own
  // handlers don't move the view even when they do see the event (a probe zoomed ~2 m before the guard).
  const st = makeStage();
  st.drive.on = true;
  const p0 = [...st.free.position], t0 = [...st.free.target];
  st._zoomAcc = 0;
  st._onWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120, ...CAR });   // a mouse notch
  st._onWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120, ctrlKey: true, ...CAR });
  st.nav.settings.trackpad = "trackpad";
  st._onWheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, ...EMPTY });                       // a two-finger scroll
  frames();
  assert.equal(st._zoomAcc, 0, "no zoom queued");
  for (const k of ["w", "a", "s", "d", "q", "e"]) { st.key(k); frames(5); st.keyup(k); }
  frames();
  assert.equal(st.nav._held.size, 0);
  st.ev("dblclick", { button: 0, ...CAR });
  st.ev("dblclick", { button: 0, ...EMPTY });
  frames();
  assert.deepEqual(st.log.framed, []);
  assert.deepEqual([st.free.position, st.free.target], [p0, t0], "the camera did not move");
  st.drive.on = false;
  st.nav.settings.trackpad = "auto";
  st._onWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120, ...CAR });
  frames();
  assert.ok(Math.hypot(...st.free.position.map((v, i) => v - p0[i])) > 0.05, "out of Drive the same wheel zooms (the check is real)");
  done(st);
});

test("while the gizmo is dragging, both buttons held on pointermove don't turn the drag into a pan", () => {
  const run = (gizmo) => {
    const st = makeStage({ selected: "car1" });
    st.live.settle = () => true;   // the gizmo's dragging-changed handler settles a moved prop
    const d0 = st.free.position.map((v, i) => v - st.free.target[i]);
    st.ev("pointerdown", { button: 0, buttons: 1, ...EMPTY });
    st.tc.dragging = gizmo;
    for (let i = 1; i <= 4; i++) { T += 16; st.ev("pointermove", { button: -1, buttons: 3, clientX: EMPTY.clientX + i * 15, clientY: EMPTY.clientY }); }
    T += 200;
    st.tc.dragging = false;
    st.ev("pointerup", { button: 0, buttons: 2, clientX: EMPTY.clientX + 60, clientY: EMPTY.clientY });
    st.ev("pointerup", { button: 2, buttons: 0, clientX: EMPTY.clientX + 60, clientY: EMPTY.clientY });
    frames();
    const d1 = st.free.position.map((v, i) => v - st.free.target[i]);
    const n = (v) => v.map((x) => x / Math.hypot(...v));
    const turned = Math.hypot(...n(d0).map((v, i) => v - n(d1)[i])) > 1e-3;
    const moved = Math.hypot(...st.free.position.map((v, i) => v - [0, 2, 10][i])) > 0.05;
    done(st);
    return { turned, moved };
  };
  const g = run(true), plain = run(false);
  assert.ok(g.moved && g.turned, "gizmo dragging: the chord is ignored, the drag stays an orbit (the view turns)");
  assert.ok(plain.moved && !plain.turned, "no gizmo: both buttons make it a pan (it translates, no turn)");
});

// ---- review round 2: distant double-click, the shared pick ray, hidden / moved set pieces
test("double-click on an object ~80 m away frames it (the orbit pivot's distance cap is not the double-click's)", () => {
  const st = makeStage();
  const car = st.actorMeshes.get("car1");
  car.position.set(0, 1, -70);
  car.updateMatrixWorld(true);
  st.free = { position: [0, 2, 10], target: [0, 1.9, 0] };   // orbit distance ~10 m: the pivot cap is 50 m
  st._applyActive();
  const t0 = [...st.free.target];
  assert.deepEqual(st.nav.pivotAt(CAR), t0, "the orbit pivot still ignores a hit far beyond the target");
  st.ev("dblclick", { button: 0, ...CAR });
  assert.deepEqual(st.log.framed, ["car1"], "framed");
  // A far set box (no object): the target glides to the clicked point.
  const st2 = makeStage();
  st2.actorMeshes.clear();
  st2._setCollidersCached = () => [{ id: "far", half: [10, 5, 0.5], pos: [0, 5, -70], quat: [0, 0, 0, 1] }];
  st2.free = { position: [0, 2, 10], target: [0, 1.9, 0] };
  st2._applyActive();
  st2.ev("dblclick", { button: 0, ...CAR });
  frames();
  assert.ok(near(st2.free.target[2], -69.5, 0.1), `target on the far wall (${st2.free.target})`);
  done(st); done(st2);
});

test("the sightline checks of a double-click never change the stage's shared pick ray", () => {
  const st = makeStage();
  st.actorMeshes.clear();
  st._setCollidersCached = () => [{ id: "back", half: [5, 2, 0.1], pos: [0, 2, 2.3], quat: [0, 0, 0, 1] },
    { id: "front", half: [5, 2, 0.1], pos: [0, 2, -3], quat: [0, 0, 0, 1] }];
  st.free = { position: [0, 1, 2], target: [0, 0, 1] };
  st._applyActive();
  const pickRay = st._pickRay;
  let rc = null, o0 = null, d0 = null;
  st._pickRay = (e) => { rc = pickRay(e); o0 = rc.ray.origin.clone(); d0 = rc.ray.direction.clone(); return rc; };
  st.ev("dblclick", { button: 0, clientX: 400, clientY: 225 });
  assert.ok(rc, "picked");
  assert.ok(rc.ray.origin.equals(o0) && rc.ray.direction.equals(d0), "origin and direction as the pick left them");
  frames();
  done(st);
});

/** The stage's real set-collider cache over one set-piece wall at z = 5 (a box mesh on the root). */
function wallStage() {
  const st = makeStage();
  delete st._setCollidersCached;   // the prototype's own, over st.root
  st.root = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(20, 6, 0.2));
  wall.position.set(0, 3, 5);
  wall.userData.setPiece = true;
  st.root.add(wall);
  return { st, wall };
}

test("a hidden set piece neither catches the orbit pivot nor stops a double-click", () => {
  const { st, wall } = wallStage();
  assert.ok(near(st.nav.pivotAt(CAR)[2], 5.1), "shown: on the wall");
  st.ev("dblclick", { button: 0, ...CAR });
  frames();
  assert.deepEqual(st.log.framed, [], "the wall is in front of the car: not framed");
  wall.visible = false;
  assert.ok(near(st.nav.pivotAt(CAR)[2], 1, 0.1), "hidden: through to the car");
  st.free = { position: [0, 2, 10], target: [0, 1, 0] };
  st._applyActive();
  st.ev("dblclick", { button: 0, ...CAR });
  assert.deepEqual(st.log.framed, ["car1"], "hidden: the car is framed");
  done(st);
});

test("moving a set piece refreshes the collider cache (the old place catches nothing)", () => {
  const { st, wall } = wallStage();
  assert.ok(near(st.nav.pivotAt(CAR)[2], 5.1), "on the wall");
  const list0 = st._setCollidersCached();
  assert.equal(st._setCollidersCached(), list0, "cached while nothing moves");
  wall.position.z = -20;   // behind the car now
  const list1 = st._setCollidersCached();
  assert.notEqual(list1, list0);
  assert.ok(near(list1[0].pos[2], -20, 1e-6), "the box is where the wall is");
  assert.ok(near(st.nav.pivotAt(CAR)[2], 1, 0.1), "the pivot is the car, not the wall's old place");
  assert.equal(Object.keys(list1[0]).includes("src"), false, "src is not enumerable (the physics world and presets copy these)");
  done(st);
});
