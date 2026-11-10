import { test } from "node:test";
import assert from "node:assert/strict";
import { Pipeline, LOOK_START, DEPTH_LOCK, turboDepthMode, TURBO_NO_LIGHT, KREA_TURBO_CAST_NOTE, KREA_DEPTH_CAST_NOTE, depthLockFor, depthModeOf, isKreaTurbo, frameLockFor, frameDenoiseFor } from "../../web/pipeline/pipeline.mjs";
import { depthTip } from "../../web/pipeline/framecheck.mjs";

// ④ Frame "Lock to the stage depth" (soundstage/look/frame_lock.py VERSION 3): a frame records the depth pass it was
// painted with, so picking it again (or animating it) reproduces exactly that frame.
test("a depth-locked frame comes back with its depth pass", () => {
  assert.equal(LOOK_START, 3);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START, dlock: DEPTH_LOCK }), 0.5);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START, dlock: 0 }), 0);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START }), 0);
});

test("frames from before the depth lock, Paint Studio frames and no frame never get it", () => {
  assert.equal(depthLockFor({ seed: 559688375, ls: 2, lock: 0.9 }), 0);       // Nov 1 frame lock, no depth pass
  assert.equal(depthLockFor({ seed: 559688375, dlock: 0.5 }), 0);              // pre-lock frame
  assert.equal(depthLockFor({ edited: "touchup/x.png", seed: 3, ls: 3, dlock: 0.5 }), 0);
  assert.equal(depthLockFor(undefined), 0);
  // the Nov 1 lock itself is unchanged for them
  assert.equal(frameLockFor({ seed: 1, ls: 2 }), true);
  assert.equal(frameDenoiseFor({ seed: 1, ls: 2, lock: 0.9 }), 0.9);
  assert.equal(frameDenoiseFor({ seed: 1, ls: 3, lock: 0.85, dlock: 0.5 }), 0.85);
});

test("a pick says which lock painted it: Light on Klein, Strict on Krea 2 Turbo", () => {
  const klein = "FLUX 3 Klein · local [<$5M]", turbo = "Krea 2 Turbo · local [<$1M]";
  assert.equal(isKreaTurbo(turbo), true);
  assert.equal(isKreaTurbo(klein), false);
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0.5, model: klein }), "light");
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0.5, model: turbo }), "strict");
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0, model: klein }), "off");
  assert.equal(depthModeOf({ seed: 1, ls: 2, dlock: 0.5, model: turbo }), "off");   // before the lock existed
  assert.equal(depthModeOf(undefined), "off");
});

test("a Klein frame off its marks without the lock suggests Strict; ghosts and locked frames get no tip", () => {
  const off = { verdict: "flag", actors: [{ status: "off" }], extra: [] };
  assert.match(depthTip(off, 0), /Lock to the stage depth.*Strict/);
  assert.match(depthTip({ verdict: "loose", actors: [{ status: "loose" }] }, 0), /Strict/);
  assert.equal(depthTip({ verdict: "flag", actors: [{ status: "on" }], extra: [{ kind: "car" }] }, 0), "");   // a ghost: re-roll only
  assert.equal(depthTip(off, 0.5), "");
  assert.equal(depthTip({ verdict: "ok" }, 0), "");
  assert.equal(depthTip(null, 0), "");
});

// A fake frame node (9081) with the widgets _syncDepthLock touches.
function fakePipeline(pickerModel, depthLock, mode) {
  const klein = "FLUX 3 Klein · local [<$5M]", turbo = "Krea 2 Turbo · local [<$1M]";
  const widgets = [{ name: "depth_lock", value: depthLock }, { name: "model", value: pickerModel, options: { values: [klein, turbo, "Z-Image Turbo · local"] } }];
  const btn = (k) => ({ dataset: { k }, disabled: false, setAttribute() {} });
  const p = Object.create(Pipeline.prototype);
  p.ctx = { app: { graph: { _nodes: [{ id: 9081, widgets, properties: {} }] } } };
  p.f = { model: { value: pickerModel }, depthSeg: { children: [btn("off"), btn("light"), btn("strict")] }, depthNote: {} };
  p._dmode = mode;
  return { p, widgets, klein, turbo };
}

test("switching from a locked Klein frame to another image model clears the lock on the frame node", () => {
  const { p, widgets, klein, turbo } = fakePipeline("FLUX 3 Klein · local [<$5M]", 0, "light");
  p._syncDepthLock();
  assert.equal(widgets[0].value, DEPTH_LOCK);
  assert.equal(p._depthLockNow(), DEPTH_LOCK);
  const other = "Z-Image Turbo · local";
  p.f.model.value = other;
  widgets[1].value = other;
  p._syncDepthLock();
  assert.equal(widgets[0].value, 0, other);              // no Klein lock left behind on a model without one
  assert.equal(p._depthLockNow(), 0, other);             // and its frames are not recorded as depth-locked
  p.f.model.value = klein;
  p._syncDepthLock();
  assert.equal(widgets[0].value, DEPTH_LOCK);            // back on Klein, the chosen mode comes back
});

// Maya S4, 2026-11-09: Krea 2 Turbo picked on the frame node kept depth_lock 0, so it painted her already seated in
// profile while the stage had her standing beside the chair. Krea 2 Turbo on the frame node locks Strict by default.
function fakeTurbo(mode) {
  const { p, widgets, turbo } = fakePipeline("Krea 2 Turbo · local [<$1M]", 0, mode);
  const btns = p.f.depthSeg.children;
  for (const b of btns) { b.pressed = null; b.title = ""; b.setAttribute = (k, v) => { if (k === "aria-pressed") b.pressed = v; }; }
  return { p, widgets, turbo, btns };
}

test("Krea 2 Turbo on the frame node locks to the stage depth (Strict) when nobody picked a mode", () => {
  for (const carried of [null, "light", "strict"]) {   // a Light carried over from FLUX 3 Klein is Strict on Turbo
    const { p, widgets, turbo, btns } = fakeTurbo(carried);
    p._syncDepthLock();
    assert.equal(widgets[0].value, DEPTH_LOCK, String(carried));
    assert.equal(widgets[1].value, turbo);               // the user's model stays
    assert.equal(p._depthLockNow(), DEPTH_LOCK);         // and the frame is recorded as depth-locked
    assert.equal(depthModeOf({ seed: 1, ls: LOOK_START, dlock: p._depthLockNow(), model: turbo }), "strict");
    const [off, light, strict] = btns;
    assert.equal(strict.pressed, "true"); assert.equal(off.pressed, "false");
    assert.equal(light.disabled, true); assert.equal(light.title, TURBO_NO_LIGHT);
    assert.equal(off.disabled, false); assert.equal(strict.disabled, false);
    assert.match(p.f.depthNote.textContent, /Krea 2 Turbo paints on the depth pass/);
  }
});

test("Krea 2 Turbo keeps the user's explicit Off", () => {
  const { p, widgets, btns } = fakeTurbo("off");
  p._syncDepthLock();
  assert.equal(widgets[0].value, 0);
  assert.equal(btns[0].pressed, "true");
  assert.match(p.f.depthNote.textContent, /without the stage depth/);
  assert.equal(turboDepthMode("off"), "off");
  assert.equal(turboDepthMode(null), "strict");
  assert.equal(turboDepthMode("light"), "strict");
});

test("opening ④ Frame with Krea 2 Turbo on the frame node: Strict under FLUX 3 Klein, or Turbo itself when Off was picked", () => {
  const mk = (saved, dmode = null) => {
    const opts = [{ value: "FLUX 3 Klein · local [<$5M]" }, { value: "__krea_depth__" }];
    const p = Object.create(Pipeline.prototype);
    p.ctx = { app: { graph: { _nodes: [{ id: 9081, widgets: [], properties: saved ? { ssDepthMode: saved } : {} }] } } };
    p.f = { model: { value: "", options: opts, append(o) { opts.push(o); } } };
    p._dmode = dmode;
    return { p, opts };
  };
  const turbo = "Krea 2 Turbo + Identity Edit · local [<$1M]", klein = "FLUX 3 Klein · local [<$5M]";
  for (const [saved, dmode] of [[null, null], ["light", null], [null, "light"], ["strict", null]]) {
    const { p } = mk(saved, dmode);
    p._showTurbo(turbo, klein);
    assert.equal(p.f.model.value, klein); assert.equal(p._dmode, "strict");
  }
  globalThis.Option ||= class { constructor(label, value) { this.label = label; this.value = value; } };
  const { p, opts } = mk("off");
  p._showTurbo(turbo, klein);
  assert.equal(p.f.model.value, turbo);
  assert.equal(opts.at(-1).label, "Krea 2 Turbo (local)");   // no "+ Identity Edit" on ④ Frame's labels
  const { p: p2 } = mk(null);
  p2._showTurbo(turbo, undefined);                           // no FLUX 3 Klein installed
  assert.equal(p2.f.model.value, turbo);
});

test("the cast notes point the Krea 2 look at Strict + the cast pass", () => {
  assert.match(KREA_DEPTH_CAST_NOTE, /Strict.*cast pass runs/);
  assert.match(KREA_TURBO_CAST_NOTE, /cast pass/);
  assert.doesNotMatch(KREA_TURBO_CAST_NOTE, /Identity Edit/);
});

// Maya S3: a hands-only insert's compiled motion negative joins the video's negative (5509) for the queue only.
test("⑤ Motion adds the hands-only motion negative for one queue and gives your negative back", async () => {
  const { joinNegative } = await import("../../web/pipeline/pipeline.mjs");
  assert.equal(joinNegative("", "face, head"), "face, head");
  assert.equal(joinNegative("blurry, Face", "face, head, legs"), "blurry, Face, head, legs");
  assert.equal(joinNegative("blurry,", ""), "blurry");
  const neg = { name: "value", value: "blurry" };
  const p = Object.create(Pipeline.prototype);
  p.ctx = { app: { graph: { _nodes: [{ id: 5509, widgets: [neg] }] } } };
  let seen = null;
  p._queueVideoAs = async () => { seen = neg.value; return "queued"; };
  p._compiledLook = async () => ({ motion_negative: "face, head, standing figure, legs" });
  assert.equal(await p._queueVideo(3), "queued");
  assert.equal(seen, "blurry, face, head, standing figure, legs");
  assert.equal(neg.value, "blurry");
  p._compiledLook = async () => ({ motion_negative: "" });
  await p._queueVideo(3);
  assert.equal(seen, "blurry");
  p._compiledLook = async () => null;   // no server: the queue goes on with your negative
  await p._queueVideo(3);
  assert.equal(seen, "blurry");
});
