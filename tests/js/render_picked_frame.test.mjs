// node --test tests/js/render_picked_frame.test.mjs
// ⑤ Motion's "Render final + sound" starts from the frame picked in ④ Frame, always (walkthrough, 2026-11-10).
// The bug: each video queue re-painted the still from its seed and showed it on rung 2; _onRung filed that copy
// (look_00005, look_00010) as a new ④ candidate with no seed, model or depth lock. Picking look_00010 (pixel-identical
// to look_00001) then made Render re-paint from whatever seed the last Generate left, with the depth lock off:
// look_00015, a clay copy, became the Final's first frame. Now the video is fed the picked FILE through the
// "Use touched-up still" switch, a video queue's rung-2 image is never a candidate, and no pick = a plain refusal.
import { test } from "node:test";
import assert from "node:assert/strict";

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.style = {}; this.dataset = {};
    this.hidden = false; this._text = ""; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  append(...k) { this.children.push(...k); }
  replaceChildren(...k) { this.children = k; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  set innerHTML(v) { this._text = ""; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.document ||= { createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), getElementById: () => null, head: { append() {} },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };

const { Pipeline, startFramePath, noFrameText } = await import("../../web/pipeline/pipeline.mjs");

const LOOK1 = { url: "/view?filename=look_00001_.png&subfolder=&type=output", file: { filename: "look_00001_.png", subfolder: "", type: "output" },
  seed: 4242, model: "FLUX 3 Klein", seedNode: 9081, ls: 3, lock: 0.9, dlock: 0.5, fprompt: { source: "auto", text: "a silver coupe" } };

/** A graph with the switch (9086), the canvas still (9085) and a sampler seed, recording what each queue saw. */
function fakePipe({ chosen = {}, touched = {}, shots = [{ id: "s1", name: "Shot 1" }] } = {}) {
  const nodes = new Map();
  const node = (id, type, title, widgets, extra = {}) => nodes.set(id, { id, type, comfyClass: type, title,
    widgets: Object.entries(widgets).map(([name, value]) => ({ name, value })), ...extra });
  node(9086, "ComfySwitchNode", "Use touched-up still", { switch: false });
  node(9085, "SoundstageCanvasImage", "Touch-up · canvas still", { image: "soundstage/my_canvas.png" });
  node(9081, "SoundstageEditImage", "frame", { seed: 1, depth_lock: 0.5, model: "FLUX 3 Klein", stage_denoise: 0.9 });
  const app = { graph: { _nodes: [...nodes.values()], getNodeById: (id) => nodes.get(id), setDirtyCanvas() {} } };
  let active = shots[0].id;
  const p = Object.create(Pipeline.prototype);
  const queued = [];
  p.ctx = { app, stage: { activeShot: () => shots.find((s) => s.id === active), setActiveShot: (id) => { active = id; } },
    shots: () => shots, getRenders: () => ({}), setBatch() {} };
  p.chosen = chosen; p.touched = touched; p.candidates = {}; p.pending = new Map(); p.inflight = new Map(); p._autoPick = {};
  p.m = { status: new El("div"), engine: { value: "LTX" }, draftBtn: {}, finalBtn: {}, allDraft: {}, allFinal: {} };
  p.views = { frame: { hidden: true }, motion: { hidden: true } };
  p._applyVideo = () => {}; p._lipSync = () => {}; p._applyShot = () => {}; p._tick = (el, t) => { el.textContent = t; };
  p._drawShotRows = () => {}; p.mark = () => {}; p._wireChosenFrame = () => {};
  const w = (id, name) => nodes.get(id).widgets.find((x) => x.name === name);
  p._queueVideo = async (step) => { queued.push({ step, shot: active, switch: w(9086, "switch").value, still: w(9085, "image").value }); };
  return { p, queued, w };
}

test("startFramePath names the picked file the way the canvas-still node reads it", () => {
  assert.equal(startFramePath(LOOK1), "look_00001_.png [output]");
  assert.equal(startFramePath({ file: { filename: "s1_42_x.png", subfolder: "soundstage_frames", type: "input" } }), "soundstage_frames/s1_42_x.png");
  assert.equal(startFramePath({ file: { filename: "t.png", subfolder: "", type: "temp" } }), "t.png [temp]");
  assert.equal(startFramePath({ edited: "soundstage/paint_7.png", file: LOOK1.file }), "soundstage/paint_7.png", "a Paint Studio frame is its own file");
  assert.equal(startFramePath({ url: "/view?filename=look_00010_.png&subfolder=&type=output" }), "look_00010_.png [output]", "a record with only its url");
  assert.equal(startFramePath(null), "");
  assert.equal(startFramePath({ seed: 5 }), "", "a seed alone is not a frame");
});

test("Render final queues with the switch ON and the still pointed at the picked frame, then puts both back", async () => {
  const { p, queued, w } = fakePipe({ chosen: { s1: { ...LOOK1 } } });
  assert.equal(await p._render(4), true);
  assert.deepEqual(queued, [{ step: 4, shot: "s1", switch: true, still: "look_00001_.png [output]" }]);
  assert.equal(w(9086, "switch").value, false, "the switch is back off after the queue");
  assert.equal(w(9085, "image").value, "soundstage/my_canvas.png", "the Canvas tab's still is back");
});

test("the walkthrough's look_00010 (a seedless copy) still renders from look_00010 itself, not from a re-paint", async () => {
  const copy = { url: "/view?filename=look_00010_.png&subfolder=&type=output", file: { filename: "look_00010_.png", subfolder: "", type: "output" } };
  const { p, queued } = fakePipe({ chosen: { s1: copy } });
  await p._render(4);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].switch, true);
  assert.equal(queued[0].still, "look_00010_.png [output]");
});

test("the draft starts from the picked frame too", async () => {
  const { p, queued } = fakePipe({ chosen: { s1: { ...LOOK1 } } });
  await p._render(3);
  assert.deepEqual(queued.map((q) => [q.step, q.switch, q.still]), [[3, true, "look_00001_.png [output]"]]);
});

test("no frame picked: Render says so plainly and queues nothing (no frame is painted behind your back)", async () => {
  const { p, queued } = fakePipe();
  assert.equal(await p._render(4), false);
  assert.equal(queued.length, 0);
  assert.equal(p.m.status.textContent, noFrameText("Shot 1"));
  assert.match(p.m.status.textContent, /No frame picked for Shot 1: pick one in ④ Frame .* Nothing was rendered\./);
});

test("Final for every shot renders the shots with a pick and names the ones skipped", async () => {
  const shots = [{ id: "s1", name: "Shot 1" }, { id: "s2", name: "Shot 2" }];
  const { p, queued } = fakePipe({ shots, chosen: { s2: { ...LOOK1 } } });
  p.forEachShot = async (fn, list) => { for (const [i, s] of list.entries()) { p.ctx.stage.setActiveShot(s.id); await fn(s, i); } };
  assert.equal(await p._render(4, true), true);
  assert.deepEqual(queued.map((q) => [q.shot, q.switch, q.still]), [["s2", true, "look_00001_.png [output]"]]);
  assert.match(p.m.status.textContent, /1 final queued.*Skipped: No frame picked for Shot 1/);
});

test("Final for every shot with no picks at all queues nothing and says why", async () => {
  const shots = [{ id: "s1", name: "Shot 1" }, { id: "s2", name: "Shot 2" }];
  const { p, queued } = fakePipe({ shots });
  p.forEachShot = async () => { throw new Error("must not run"); };
  assert.equal(await p._render(4, true), false);
  assert.equal(queued.length, 0);
  assert.equal(p.m.status.textContent, noFrameText("Shot 1, Shot 2"));
});

test("the Canvas tab's own touched-up still (no Paint Studio record) is used as it is", async () => {
  const { p, queued } = fakePipe({ touched: { s1: true } });
  p.set(9086, "switch", true);
  await p._render(4);
  assert.deepEqual(queued.map((q) => [q.switch, q.still]), [[true, "soundstage/my_canvas.png"]]);
});

test("a workflow without the switch refuses plainly instead of re-painting", async () => {
  const { p, queued } = fakePipe({ chosen: { s1: { ...LOOK1 } } });
  p.ctx.app.graph._nodes = p.ctx.app.graph._nodes.filter((n) => n.id !== 9085);
  assert.equal(await p._render(4), false);
  assert.equal(queued.length, 0);
  assert.match(p.m.status.textContent, /Couldn't queue: .*can't start from the picked frame/);
});

test("a video queue's rung-2 image is not filed as a new ④ candidate (it was the seedless look_00010 tile)", () => {
  const { p } = fakePipe({ chosen: { s1: { ...LOOK1 } } });
  p.inflight.set("vid", { sid: "s1", step: 4, t: 0 });
  p._onRung({ rung: 2, url: "/view?filename=look_00010_.png", file: { filename: "look_00010_.png", type: "output" }, promptId: "vid", shotId: "s1" });
  assert.deepEqual(p.candidates.s1 || [], []);
  assert.equal(p.chosen.s1.file.filename, "look_00001_.png", "the pick is untouched");
  // ④ Frame's own job still lands as a candidate, with its seed
  p.pending.set("frm", { seed: 77, model: "FLUX 3 Klein", seedNode: 9081, ls: 3, dlock: 0.5 });
  p.inflight.set("frm", { sid: "s1", step: 2, t: 0 });
  p.f = { autoReroll: { checked: false } };
  p._onRung({ rung: 2, url: "/view?filename=look_00011_.png", file: { filename: "look_00011_.png", type: "output" }, promptId: "frm", shotId: "s1" });
  assert.equal(p.candidates.s1.length, 1);
  assert.equal(p.candidates.s1[0].seed, 77);
});
