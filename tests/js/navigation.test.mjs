// Stage navigation (web/stage/navigation.mjs): the pure helpers, plus the controller on a stub stage (no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import {
  NAV_STYLES, NAV_ACTIONS, PRESETS, NAV_DEFAULTS, TAKEN_KEYS, loadNavSettings, saveNavSettings, resolveGesture, chordUpgrade,
  altTurns, orbitAbout, panRate, viewDepth, pickPivot, easeShare, consume, tauFromSmooth, classifyWheel, WHEEL_IDLE, flyDir, flyStep,
  flySpeedFromWheel, walkSpeed, focusView, hintText, rayBoxT, focusAlongRay, bindingConflicts, installNavigation, keyCombo, hintPlacement,
} from "../../web/stage/navigation.mjs";
import { allCombos } from "../../web/ui/shortcuts.mjs";

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
    // Against the App's real shortcut list (web/ui/shortcuts.mjs), so a new App key that a style also binds fails here.
    assert.deepEqual(bindingConflicts(s, [...TAKEN_KEYS, ...allCombos(false)]), [], `${s} vs SHORTCUTS`);
  }
  assert.deepEqual(bindingConflicts("blender", [...TAKEN_KEYS, "Home"]), ["Home"]);
});

test("bindingConflicts can fail: keys are compared as the combos they type, and only declared overrides pass", () => {
  assert.equal(keyCombo("Numpad1"), "1");
  assert.equal(keyCombo("Ctrl+Numpad7"), "Ctrl+7");
  assert.equal(keyCombo("NumpadDecimal"), ".");
  const real = allCombos(false);
  assert.ok(real.includes("Shift+L") && real.includes("."), "the real list has the combos this test leans on");
  assert.deepEqual(bindingConflicts({ keys: ["Shift+L", "Home"] }, real), ["Shift+L"], "a style binding the light bar's key is caught");
  assert.deepEqual(bindingConflicts({ keys: ["Numpad1", "Numpad1"] }, real), ["Numpad1"], "a duplicate is caught");
  // Blender's numpad "." types "." (Back to the set): allowed only because the style declares it.
  assert.deepEqual(bindingConflicts({ ...PRESETS.blender, overrides: [] }, real), ["NumpadDecimal"]);
  assert.deepEqual(bindingConflicts("blender", real), []);
});

test("pickPivot with no fallback: nothing under the cursor is no point (a double-click on the sky does nothing)", () => {
  assert.equal(pickPivot({}, [0, 1, 0], [0, 2, 40], { fallback: false }), null);
  assert.deepEqual(pickPivot({}, [0, 1, 0], [0, 2, 40]), [0, 1, 0], "an orbit still turns about the target");
  assert.deepEqual(pickPivot({ floor: [3, 0, 4] }, [0, 1, 0], [0, 2, 40], { fallback: false }), [3, 0, 4]);
});

test("hintPlacement: clear of the shot-camera picture and the Top view inset, else above them", () => {
  const view = { left: 0, top: 0, width: 1200, height: 700 };
  const free = hintPlacement(view, []);
  assert.deepEqual(free, { right: 1192, top: 666, maxWidth: 1184 });
  const pip = { left: 10, top: 520, width: 300, height: 170 }, top = { left: 790, top: 400, width: 400, height: 290 };
  const between = hintPlacement(view, [pip, top]);
  assert.equal(between.top, 666, "stays on the bottom edge");
  assert.ok(between.right <= top.left - 8, "right edge left of the Top view inset");
  assert.ok(between.right - between.maxWidth >= pip.left + pip.width + 8, "left edge right of the picture");
  // A narrow viewport: no room between them, so it sits just above the taller one.
  const narrow = hintPlacement({ left: 0, top: 0, width: 760, height: 700 }, [pip, { left: 450, top: 400, width: 300, height: 290 }]);
  assert.ok(narrow.top + 26 <= 400 - 8 + 1e-9, `above the inset (top ${narrow.top})`);
  assert.ok(narrow.maxWidth >= 240);
  // Hidden or zero-size panels are not obstacles.
  assert.deepEqual(hintPlacement(view, [null, { left: 790, top: 400, width: 0, height: 0 }]), free);
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

test("viewDepth: a pan uses the depth along the view, so a point near the frame edge keeps up with the cursor", () => {
  close(viewDepth([0, 0, 0], [0, 0, -1], [0, 0, -10]), 10);
  close(viewDepth([0, 0, 0], [0, 0, -1], [6, 0, -8]), 8);   // 10 m away but only 8 m deep
  close(viewDepth([0, 0, 0], [0, 0, -1], [0, 0, 5]), 0.05); // behind the camera: the floor value, never negative
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

test("classifyWheel tells a mouse wheel, a trackpad and a pinch apart (only once it is sure)", () => {
  assert.equal(classifyWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, {}, 0), "mouse");
  const mem = {};
  const tp = { deltaY: 3.2, deltaX: 1.1, deltaMode: 0, wheelDeltaY: -9 };
  assert.equal(classifyWheel(tp, mem, 0), "mouse", "one trackpad-like event is not enough");
  assert.equal(classifyWheel(tp, mem, 16), "mouse");
  assert.equal(classifyWheel(tp, mem, 32), "trackpad", "three in a row: a trackpad");
  assert.equal(classifyWheel({ deltaY: 40, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, mem, 48), "trackpad", "a fast flick that reads as a notch doesn't flip it back");
  assert.equal(classifyWheel(tp, mem, 900), "trackpad", "the device is remembered across gestures");
  assert.equal(classifyWheel({ deltaY: 3, deltaX: 0, deltaMode: 1 }, mem, 950), "mouse", "line mode is only ever a wheel: sure at once");
  assert.equal(classifyWheel({ deltaY: 2.4, ctrlKey: true, deltaMode: 0 }, {}, 0), "pinch", "fractional Ctrl + wheel: a pinch");
  assert.equal(classifyWheel({ deltaY: 100, ctrlKey: true, deltaMode: 0, wheelDeltaY: -120 }, {}, 0), "mouse", "a mouse's Ctrl + wheel is the wheel");
  const m2 = {};
  for (let i = 0; i < 3; i++) classifyWheel({ deltaY: 2, deltaX: 0, deltaMode: 0, wheelDeltaY: -6 }, m2, i * 16);
  assert.equal(classifyWheel({ deltaY: 2, ctrlKey: true, deltaMode: 0, wheelDeltaY: -6 }, m2, 64), "pinch", "Ctrl + wheel from a known trackpad");
  assert.equal(classifyWheel({ deltaY: 3, deltaX: 0, deltaMode: 1 }, {}, 0), "mouse");
  assert.equal(classifyWheel({ deltaY: 3.2, deltaX: 1, deltaMode: 0 }, {}, 0, "mouse"), "mouse");
  assert.equal(classifyWheel({ deltaY: 100, deltaX: 0, deltaMode: 0 }, {}, 0, "trackpad"), "trackpad");
  assert.equal(classifyWheel({ deltaY: 100, ctrlKey: true, deltaMode: 0, wheelDeltaY: -120 }, {}, 0, "trackpad"), "pinch", "Scrolling: Trackpad");
});

test("Shift + wheel (Windows sends it as deltaX) and a tilt wheel stay a mouse", () => {
  const mem = {};
  for (let i = 0; i < 10; i++) assert.equal(classifyWheel({ deltaY: 0, deltaX: i % 2 ? 100 : -100, deltaMode: 0, wheelDeltaY: 0, wheelDeltaX: i % 2 ? -120 : 120, shiftKey: true }, mem, i * 30), "mouse");
  const tilt = {};
  for (let i = 0; i < 10; i++) assert.equal(classifyWheel({ deltaY: 0, deltaX: 40, deltaMode: 0 }, tilt, i * 30), "mouse", "integer sideways deltas say nothing");
});

test("a macOS smooth (accelerated) mouse wheel stays a mouse, even with an odd event in the stream", () => {
  const mem = {};
  const seq = [4.000244140625, 8.000488, 12.000732421875, 30.4, 61.2, 4.000244140625, 2.000122];
  seq.forEach((d, i) => assert.equal(classifyWheel({ deltaY: d, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 * Math.max(1, Math.round(d / 30)) }, mem, i * 20), "mouse", `event ${i}`));
  // One odd event (a non-notch legacy delta) in the middle of a mouse stream: still a mouse.
  assert.equal(classifyWheel({ deltaY: 4.5, deltaX: 0, deltaMode: 0, wheelDeltaY: -13 }, mem, 200), "mouse");
  assert.equal(classifyWheel({ deltaY: 4.000244140625, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, mem, 220), "mouse");
  assert.equal(classifyWheel({ deltaY: 4.5, deltaX: 0, deltaMode: 0, wheelDeltaY: -13 }, mem, 240), "mouse");
});

test("trackpad, then a mouse: a clear notch switches back at once after a pause, within two notches mid-stream", () => {
  const tp = { deltaY: 3.2, deltaX: 1.1, deltaMode: 0, wheelDeltaY: -9 };
  const notch = { deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 };
  const macNotch = { deltaY: 4.000244140625, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 };
  const asTrackpad = () => { const m = {}; for (let i = 0; i < 6; i++) classifyWheel(tp, m, i * 16); assert.equal(m.kind, "trackpad"); return m; };
  // A pause, then the mouse: the first notch already zooms (it used to take 6 notches, the first 5 orbiting).
  for (const n of [notch, macNotch]) {
    const m = asTrackpad();
    assert.equal(classifyWheel(n, m, 80 + WHEEL_IDLE + 1), "mouse", `first notch after a pause (deltaY ${n.deltaY})`);
    assert.equal(classifyWheel(n, m, 80 + WHEEL_IDLE + 60), "mouse");
  }
  // Straight from the trackpad to the wheel (no pause): the second notch in a row switches.
  const m = asTrackpad();
  assert.equal(classifyWheel(notch, m, 96), "trackpad", "one notch mid-stream could be a fast flick");
  assert.equal(classifyWheel(notch, m, 112), "mouse", "two in a row: the mouse");
  // Line mode is a wheel at once, pause or not.
  const m3 = asTrackpad();
  assert.equal(classifyWheel({ deltaY: 3, deltaX: 0, deltaMode: 1 }, m3, 96), "mouse");
});

test("an idle gap decays the wheel evidence: a new gesture starts neutral (the kind is kept, one odd event never flips it)", () => {
  const tp = { deltaY: 3.2, deltaX: 1.1, deltaMode: 0, wheelDeltaY: -9 };
  const m = {};
  classifyWheel(tp, m, 0); classifyWheel(tp, m, 16);
  assert.equal(m.score, 2);
  classifyWheel(tp, m, 16 + WHEEL_IDLE + 1);
  assert.equal(m.score, 1, "two events from the last gesture don't count toward this one");
  assert.equal(m.kind, "mouse");
  // A known trackpad keeps its kind over a pause; its next gesture keeps orbiting.
  const t = {};
  for (let i = 0; i < 4; i++) classifyWheel(tp, t, i * 16);
  assert.equal(classifyWheel(tp, t, 3000), "trackpad", "the device is remembered");
  assert.equal(t.score, 1, "but the evidence starts again");
  // A known mouse: after a pause one fractional event is not enough, three in a row are.
  const mm = {};
  classifyWheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }, mm, 0);
  assert.equal(classifyWheel(tp, mm, 5000), "mouse");
  assert.equal(classifyWheel(tp, mm, 5016), "mouse");
  assert.equal(classifyWheel(tp, mm, 5032), "trackpad");
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
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), false, "one trackpad-like event: not sure yet");
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), false);
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), false, "a known mouse needs more than the bare three");
  // A notch that began a gesture is a sure mouse (-3), so with no pause in between the trackpad takes 6 events.
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), false);
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), false);
  assert.equal(st.nav.wheel({ deltaY: 2.5, deltaX: 4, deltaMode: 0, wheelDeltaY: -7 }), true, "sustained: a trackpad, it orbits");
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

test("Alt + right drag (Maya / Unreal dolly) is not fly mode: the wheel zooms and D is still Drive", () => {
  const st = stubStage({ selected: "car1" });
  st.nav.settings.style = "maya";
  st.nav._rmb.down = true; st.nav._rmb.noFly = true;   // what an Alt + right press sets (navigation_stage tests dispatch it)
  assert.equal(st.nav.wheel({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120 }), false, "the wheel zooms, not fly speed");
  assert.equal(st.nav.key(key("d")), false, "D is Drive, not fly right");
  st.nav.dispose();
});

test("macOS: hold W, press ⌘, let go of W (no keyup arrives): the held key is dropped and the camera stops", () => {
  const st = stubStage({ freeView: false });
  st.nav.settings.damping = false;
  assert.equal(st.nav.key(key("w")), true);
  st.nav._tick();
  assert.ok(st.nav._held.has("w"));
  // ⌘ goes down (Chrome on a Mac then sends no keyup for W, released while ⌘ is held).
  st.nav.key({ key: "Meta", code: "MetaLeft", metaKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(st.nav._held.size, 0, "W no longer held");
  st.nav._tick(); st.nav._tick();
  const z = st.orbit.position[2];
  st.nav._tick();
  assert.equal(st.orbit.position[2], z, "the camera has stopped");
  assert.equal(st.changes, 1, "the shot key written once when it stopped");
  // A keyup with ⌘ still down clears too.
  st.nav.key(key("s"));
  st.nav.keyup({ key: "z", metaKey: true });
  assert.equal(st.nav._held.size, 0);
  st.nav.dispose();
});

test("double-click focus only selects in Camera view (never rewrites the shot)", () => {
  const st = stubStage({ freeView: false, _pickRay: () => { throw new Error("should not pick"); }, msgs: [], onInteract(m) { this.msgs.push(m); } });
  assert.equal(st.nav.focusAt({ clientX: 1, clientY: 1 }), false);
  assert.match(st.msgs[0], /Free view/);
  assert.equal(st.changes, 0);
});

test("rayBoxT: where a ray enters an oriented set box; a miss or an origin inside is null", () => {
  const q90 = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];   // 90° about Y
  assert.ok(Math.abs(rayBoxT([0, 1, 10], [0, 0, -1], [2, 2, 0.1], [0, 1, 5]) - 4.9) < 1e-9);
  assert.equal(rayBoxT([0, 1, 10], [0, 0, 1], [2, 2, 0.1], [0, 1, 5]), null, "behind the ray");
  assert.equal(rayBoxT([5, 1, 10], [0, 0, -1], [2, 2, 0.1], [0, 1, 5]), null, "beside it");
  assert.equal(rayBoxT([0, 1, 5], [0, 0, -1], [2, 2, 0.5], [0, 1, 5]), null, "inside");
  // The same thin wall turned 90°: now 0.1 thick along x, 2 m along z.
  assert.ok(Math.abs(rayBoxT([0, 1, 10], [0, 0, -1], [2, 2, 0.1], [0, 1, 5], q90) - 3) < 1e-9);
  assert.equal(rayBoxT([0.5, 1, 10], [0, 0, -1], [2, 2, 0.1], [0, 1, 5], q90), null);
});

test("focusAlongRay: toward the point, never past it, 2..12 m short of it", () => {
  assert.deepEqual(focusAlongRay([0, 0, 0], [0, 0, -30]).pos.map((v) => +v.toFixed(6) || 0), [0, 0, -18]);
  assert.deepEqual(focusAlongRay([0, 0, 0], [0, 0, -5]).pos.map((v) => +v.toFixed(6) || 0), [0, 0, 0], "already 2..12 m away: the distance is kept");
  assert.deepEqual(focusAlongRay([0, 0, 0], [0, 0, -1]).pos.map((v) => +v.toFixed(6) || 0), [0, 0, 0], "nearer than 2 m: stay put");
  assert.deepEqual(focusAlongRay([0, 0, 0], [0, 0, -1]).tgt, [0, 0, -1]);
});
