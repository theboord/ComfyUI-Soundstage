// Stage navigation (web/stage/navigation.mjs): the pure helpers, plus the controller on a stub stage (no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import {
  NAV_STYLES, NAV_ACTIONS, PRESETS, NAV_DEFAULTS, TAKEN_KEYS, loadNavSettings, saveNavSettings, resolveGesture, chordUpgrade,
  altTurns, orbitAbout, panRate, pickPivot, easeShare, consume, tauFromSmooth, classifyWheel, flyDir, flyStep,
  flySpeedFromWheel, walkSpeed, focusView, hintText, bindingConflicts, installNavigation,
} from "../../web/stage/navigation.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const closeV = (a, b, eps = 1e-6) => a.forEach((v, i) => close(v, b[i], eps));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);
const norm = (a) => a.map((v) => v / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
/** A point in the camera's own frame (right, up, forward), up = world Y as the stage's lookAt uses. */
function camSpace(pos, tgt, p) {
  const f = norm(sub(tgt, pos)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), d = sub(p, pos);
  return [dot(d, r), dot(d, u), dot(d, f)];
}

test("every style binds every action and no style key collides with the App's keys", () => {
  for (const s of NAV_STYLES) {
    for (const a of NAV_ACTIONS) assert.ok(PRESETS[s][a], `${s} binds ${a}`);
    assert.deepEqual(bindingConflicts(s), [], s);
  }
  assert.deepEqual(bindingConflicts("blender", [...TAKEN_KEYS, "Home"]), ["Home"]);
});

test("resolveGesture: Soundstage default bindings", () => {
  assert.deepEqual(resolveGesture("soundstage", { button: 0 }), { mode: "orbit", look: false, fly: false });
  assert.equal(resolveGesture("soundstage", { button: 0, shift: true }).mode, "pan");
  assert.equal(resolveGesture("soundstage", { button: 1 }).mode, "pan");
  assert.deepEqual(resolveGesture("soundstage", { button: 0, alt: true }), { mode: "orbit", look: true, fly: false });
  assert.deepEqual(resolveGesture("soundstage", { button: 2 }), { mode: "orbit", look: true, fly: true });   // hold right = fly
});

test("resolveGesture: Blender, Maya, Unreal", () => {
  assert.equal(resolveGesture("blender", { button: 1 }).mode, "orbit");
  assert.equal(resolveGesture("blender", { button: 1, shift: true }).mode, "pan");
  assert.equal(resolveGesture("blender", { button: 1, ctrl: true }).mode, "dolly");
  assert.equal(resolveGesture("blender", { button: 0 }).mode, "orbit");      // drag empty space still looks around
  assert.equal(resolveGesture("maya", { button: 0, alt: true }).mode, "orbit");
  assert.equal(resolveGesture("maya", { button: 1, alt: true }).mode, "pan");
  assert.equal(resolveGesture("maya", { button: 2, alt: true }).mode, "dolly");
  assert.equal(resolveGesture("maya", { button: 0 }).mode, "orbit");
  assert.equal(resolveGesture("unreal", { button: 0 }).mode, "walk");
  assert.equal(resolveGesture("unreal", { button: 0, alt: true }).mode, "orbit");
  assert.equal(resolveGesture("unreal", { button: 2 }).fly, true);
  for (const s of NAV_STYLES) assert.equal(resolveGesture(s, { button: 2 }).fly, true, `${s}: right-hold flies`);
});

test("Alt + drag turns an object in Soundstage and Blender, orbits in Maya and Unreal", () => {
  assert.equal(altTurns("soundstage"), true);
  assert.equal(altTurns("blender"), true);
  assert.equal(altTurns("maya"), false);
  assert.equal(altTurns("unreal"), false);
});

test("chord: both buttons make orbit / pending grab a pan; live, actor, light and pose drags are left alone", () => {
  assert.equal(chordUpgrade("orbit", 3), "pan");
  assert.equal(chordUpgrade("pending", 3), "pan");
  assert.equal(chordUpgrade("walk", 3), "pan");
  for (const m of ["live", "actor", "light", "pose"]) assert.equal(chordUpgrade(m, 3), null, m);
  assert.equal(chordUpgrade("orbit", 1), null);
  assert.equal(chordUpgrade("orbit", 7), "pan");             // a middle button on top doesn't stop it
  assert.equal(chordUpgrade("orbit", 3, { gizmoDragging: true }), null);
});

test("orbitAbout keeps the distance to the pivot and the pivot's place on screen", () => {
  const pos = [6, 3, 8], tgt = [0, 1, 0], pivot = [2, 0, -1];
  const before = camSpace(pos, tgt, pivot), d0 = len(sub(pos, pivot));
  for (const [a, b] of [[0.3, 0], [0, 0.2], [-0.7, -0.25], [1.2, 0.4]]) {
    const o = orbitAbout(pos, tgt, pivot, a, b);
    close(len(sub(o.pos, pivot)), d0);
    closeV(camSpace(o.pos, o.tgt, pivot), before);
    close(len(sub(o.pos, o.tgt)), len(sub(pos, tgt)));
  }
});

test("orbitAbout clamps the tilt: the camera never flips over the pole", () => {
  const pos = [0, 2, 10], tgt = [0, 1, 0];
  const up = orbitAbout(pos, tgt, tgt, 0, -10);       // far past straight down
  const back = norm(sub(up.pos, up.tgt));
  assert.ok(back[1] < 1 && back[1] > 0.999, "stops just short of straight overhead");
  assert.ok(up.pos[2] > 0, "still on the same side");
  const down = orbitAbout(pos, tgt, tgt, 0, 10);
  assert.ok(norm(sub(down.pos, down.tgt))[1] > -1);
});

test("panRate moves the point under the cursor with the cursor", () => {
  close(panRate(10, 90, 1000), 0.02);   // 2·10·tan45° over 1000 px
  assert.ok(panRate(0, 50, 500) > 0);
});

test("pickPivot: object, then floor (within 400 m), then target; the water tank skips the floor", () => {
  const tgt = [0, 1, 0], cam = [0, 5, 10];
  assert.deepEqual(pickPivot({ mesh: [1, 1, 1], floor: [2, 0, 2] }, tgt, cam), [1, 1, 1]);
  assert.deepEqual(pickPivot({ mesh: null, floor: [2, 0, 2] }, tgt, cam), [2, 0, 2]);
  assert.deepEqual(pickPivot({ mesh: null, floor: [2, 0, 2] }, tgt, cam, { waterTank: true }), tgt);
  assert.deepEqual(pickPivot({ mesh: null, floor: null }, tgt, cam), tgt);
  assert.deepEqual(pickPivot({ floor: [0, 0, -500] }, tgt, cam), tgt);   // the horizon is not a pivot
});

test("consume is frame-rate independent and damping off takes it all at once", () => {
  const run = (fps) => {
    let acc = { dx: 100, dy: -40 }, got = 0, t = 0;
    const dt = 1 / fps;
    while ((acc.dx || acc.dy) && t < 5) { const [take, left] = consume(acc, dt, 0.06); got += take.dx; acc = left; t += dt; }
    return { got, t };
  };
  for (const fps of [30, 60, 144]) close(run(fps).got, 100);
  // Time to reach 95%: about the same at every frame rate.
  const t95 = (fps) => { let left = 1, t = 0; const k = easeShare(1 / fps, 0.06); while (left > 0.05) { left *= 1 - k; t += 1 / fps; } return t; };
  assert.ok(Math.abs(t95(30) - t95(144)) < 1 / 30 + 1e-9);
  const [take, left] = consume({ dx: 7, dy: 3 }, 0.016, 0.06, false);
  assert.deepEqual([take.dx, take.dy, left.dx, left.dy], [7, 3, 0, 0]);
  assert.ok(tauFromSmooth(0) < tauFromSmooth(1));
});

test("classifyWheel tells a mouse wheel, a trackpad and a pinch apart", () => {
  assert.equal(classifyWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, {}, 0), "mouse");
  const mem = {};
  assert.equal(classifyWheel({ deltaY: 3.2, deltaX: 1.1, deltaMode: 0, wheelDeltaY: -9 }, mem, 0), "trackpad");
  assert.equal(classifyWheel({ deltaY: 4, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, mem, 100), "trackpad", "sticky in the stream");
  assert.equal(classifyWheel({ deltaY: 4, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, mem, 900), "mouse", "a new stream");
  assert.equal(classifyWheel({ deltaY: 2, ctrlKey: true, deltaMode: 0 }, {}, 0), "pinch");
  assert.equal(classifyWheel({ deltaY: 3, deltaX: 0, deltaMode: 1 }, {}, 0), "mouse");
  assert.equal(classifyWheel({ deltaY: 3.2, deltaX: 1, deltaMode: 0 }, {}, 0, "mouse"), "mouse");
  assert.equal(classifyWheel({ deltaY: 100, deltaX: 0, deltaMode: 0 }, {}, 0, "trackpad"), "trackpad");
});

test("fly: held keys give a continuous step that scales with dt; Shift x4; opposite keys cancel; speed clamps", () => {
  assert.deepEqual(flyDir(new Set(["w", "s"])), [0, 0, 0]);
  const w = new Set(["w"]);
  closeV(flyStep(w, 4, 0.5), [0, 0, 2]);
  closeV(flyStep(w, 4, 0.5, true), [0, 0, 8]);
  closeV(flyStep(new Set(["w", "d"]), 1, 1).map(Math.abs), [Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.equal(flySpeedFromWheel(4, -100), 5);
  assert.equal(flySpeedFromWheel(4, 100), 3.2);
  assert.equal(flySpeedFromWheel(64, -1), 64);
  assert.equal(flySpeedFromWheel(0.25, 1), 0.25);
  close(walkSpeed(10), 3.6);
  close(walkSpeed(1000), 9);
  close(walkSpeed(0.1, true), 0.18);
});

test("focusView on a point keeps the view direction, 2..12 m away", () => {
  const f = focusView([0, 10, 50], [0, 0, 0], [4, 0, 4]);
  assert.deepEqual(f.tgt, [4, 0, 4]);
  close(len(sub(f.pos, f.tgt)), 12);
  closeV(norm(sub(f.pos, f.tgt)), norm([0, 10, 50]));
  const n = focusView([0, 0, 1], [0, 0, 0], [0, 0, 0.5]);
  close(len(sub(n.pos, n.tgt)), 2);
});

test("settings: blocked or empty storage gives defaults; save/load round-trips; reduced motion turns damping off", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadNavSettings(throwing), { ...NAV_DEFAULTS });
  assert.deepEqual(loadNavSettings(null), { ...NAV_DEFAULTS });
  assert.equal(saveNavSettings({ style: "maya" }, throwing), false);
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = { ...NAV_DEFAULTS, style: "blender", damping: false, smooth: 0.8, invertY: true, trackpad: "mouse", flySpeed: 12 };
  assert.equal(saveNavSettings(s, store), true);
  assert.deepEqual(loadNavSettings(store), s);
  mem.set("ss_nav_v1", JSON.stringify({ style: "nope", flySpeed: 9999 }));
  assert.equal(loadNavSettings(store).style, "soundstage");
  assert.equal(loadNavSettings(store).flySpeed, 64);
  assert.equal(loadNavSettings(null, true).damping, false);
});

test("hintText follows the style and says ⌥ on a Mac, Alt elsewhere", () => {
  assert.match(hintText("soundstage"), /Both buttons/);
  assert.notEqual(hintText("blender"), hintText("soundstage"));
  assert.match(hintText("maya", true), /⌥\+drag orbit/);
  assert.match(hintText("maya", false), /Alt\+drag orbit/);
});

// ---------------------------------------------------------------- the controller on a stub stage (no canvas, no DOM)
function stubStage(over = {}) {
  const st = {
    freeView: true, selected: null, state: { environment: {} }, actorMeshes: new Map(), changes: 0, applied: 0, driveStarted: 0,
    orbit: { position: [0, 2, 10], target: [0, 1, 0] },
    _activeOrbit() { return this.orbit; },
    _applyActive() { this.applied++; },
    _navDrag(mode, look, dx, dy) { this.lastNav = { mode, look, dx, dy }; },
    onChange() { this.changes++; },
    toJSON() { return {}; },
    drive: { on: false, canDrive: () => true },
    ...over,
  };
  installNavigation(st);
  return st;
}
const key = (k, extra = {}) => ({ key: k, code: `Key${k.toUpperCase()}`, preventDefault() {}, stopPropagation() {}, ...extra });

test("D with a drivable car selected is still Drive; with right held it flies right", () => {
  const st = stubStage({ selected: "car1" });
  assert.equal(st.nav.key(key("d")), false, "plain D falls through to Drive");
  st.nav._rmb.down = true;
  assert.equal(st.nav.key(key("d")), true, "right held: fly right");
  assert.ok(st.nav._held.has("d"));
  st.nav.dispose();
});

test("held W glides continuously and writes the shot key once when it stops (Camera view)", () => {
  const st = stubStage({ freeView: false });
  st.nav.settings.damping = false;
  assert.equal(st.nav.key(key("w")), true);
  const z0 = st.orbit.position[2];
  for (let i = 0; i < 5; i++) st.nav._tick();
  assert.ok(st.orbit.position[2] < z0, "moved forward");
  assert.equal(st.changes, 0, "no key write while moving");
  st.nav.keyup(key("w"));
  st.nav._tick(); st.nav._tick();
  assert.equal(st.changes, 1, "one write when it settles");
  st.nav.dispose();
});

test("chord on a pending grab becomes a pan and is never a click", () => {
  const st = stubStage({ tc: { dragging: false } });
  const d = st.nav.chord({ mode: "pending", id: "a", x0: 5, y0: 5 }, { buttons: 3, clientX: 9, clientY: 9 });
  assert.equal(d.mode, "pan");
  assert.equal(d.chorded, true);
  assert.equal(st.nav.notClick(d), true);
  assert.equal(st.nav.chord({ mode: "live" }, { buttons: 3 }).mode, "live");
  const st2 = stubStage({ tc: { dragging: true } });
  assert.equal(st2.nav.chord({ mode: "orbit" }, { buttons: 3 }).mode, "orbit", "the gizmo's drag wins");
});

test("Drive on: the wheel, keys and chords are left to Drive", () => {
  const st = stubStage({ drive: { on: true, canDrive: () => false } });
  assert.equal(st.nav.wheel({ deltaY: 3.3, deltaX: 2, deltaMode: 0 }), false);
  assert.equal(st.nav.key(key("w")), false);
  assert.equal(st.nav.chord({ mode: "orbit" }, { buttons: 3 }).mode, "orbit");
});

test("the wheel while flying changes fly speed; a trackpad scroll orbits; a mouse wheel still zooms", () => {
  const st = stubStage();
  st.nav.settings.damping = false;
  st.nav._rmb.down = true;
  const s0 = st.nav.settings.flySpeed;
  assert.equal(st.nav.wheel({ deltaY: -100, deltaX: 0, deltaMode: 0 }), true);
  assert.ok(st.nav.settings.flySpeed > s0);
  st.nav._rmb.down = false;
  assert.equal(st.nav.wheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }), false, "mouse: the stage zooms");
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), true);
  assert.equal(st.lastNav.mode, "orbit");
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, ctrlKey: true }), false, "pinch zooms");
});

test("Blender style: numpad keys snap and frame; Maya: Shift+A frames all", () => {
  const seen = [];
  const st = stubStage({ snapView: (a) => seen.push(a), frameSelected: () => seen.push("frame"), viewNav: { backToSet: () => seen.push("home") } });
  st.nav.settings.style = "blender";
  assert.equal(st.nav.key({ key: "1", code: "Numpad1", preventDefault() {}, stopPropagation() {} }), true);
  assert.equal(st.nav.key({ key: "7", code: "Numpad7", ctrlKey: true, preventDefault() {}, stopPropagation() {} }), true);
  assert.equal(st.nav.key({ key: ".", code: "NumpadDecimal", preventDefault() {}, stopPropagation() {} }), true);
  assert.equal(st.nav.key({ key: "Home", code: "Home", preventDefault() {}, stopPropagation() {} }), true);
  st.nav.settings.style = "maya";
  assert.equal(st.nav.key(key("A", { shiftKey: true })), true);
  assert.deepEqual(seen, ["+z", "-y", "frame", "home", "home"]);
});

test("double-click focus only selects in Camera view (never rewrites the shot)", () => {
  const st = stubStage({ freeView: false, _pickRay: () => { throw new Error("should not pick"); }, msgs: [], onInteract(m) { this.msgs.push(m); } });
  assert.equal(st.nav.focusAt({ clientX: 1, clientY: 1 }), false);
  assert.match(st.msgs[0], /Free view/);
  assert.equal(st.changes, 0);
});
