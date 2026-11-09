// C28: ④ Frame's model defaults from Jon's measured sweep (outbox claude_C28.md, "Recommended defaults per model").
//   Krea 2 + depth: euler_ancestral / beta (C31: dpmpp_2m speckled), CFG 1, 12 steps, never karras.
//   FLUX 3 Klein: Lock to the stage depth Light (Off hands the stage back), CFG 2, 12 steps, sampler auto.
//   FLUX.2 Klein 9B: 4-step distilled, kept at 4 steps CFG 1, no depth lock (C28 never ran it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pipeline, FRAME_DEFAULTS, OLD_KREA_DEFAULTS, QUALITY_STEPS, frameDefaultsFor, frameDefaultsKey, defaultDepthMode,
  samplingNote, DEPTH_LOCK } from "../../web/pipeline/pipeline.mjs";
import { DEFAULT_LOOK } from "../../web/look/look.mjs";

const KLEIN = "FLUX 3 Klein · local [<$5M]", K9B = "FLUX.2 Klein 9B · local [non-commercial]", TURBO = "Krea 2 Turbo · local [<$1M]";

test("the measured defaults per model", () => {
  assert.deepEqual(frameDefaultsFor("__krea_depth__"), { steps: 12, cfg: 1, sampler: "euler_ancestral", scheduler: "beta", label: "Krea 2 Turbo" });
  const k = frameDefaultsFor(KLEIN);
  assert.equal(k.steps, 12); assert.equal(k.cfg, 2); assert.equal(k.sampler, "auto"); assert.equal(k.depth, "light");
  const n = frameDefaultsFor(K9B);
  assert.equal(frameDefaultsKey(K9B), "klein9b");
  assert.equal(n.steps, 4); assert.equal(n.cfg, 1); assert.equal(n.depth, "off");
  assert.equal(frameDefaultsKey("Z-Image Turbo · local"), "other");
  for (const [key, rows] of Object.entries(QUALITY_STEPS)) {
    assert.ok(rows.some(([label, st]) => label === "Standard" && st === FRAME_DEFAULTS[key].steps), key);
  }
});

test("Light is the depth lock a FLUX 3 Klein frame starts with, when Krea 2 Turbo is there to paint it", () => {
  assert.equal(defaultDepthMode(KLEIN, true), "light");
  assert.equal(defaultDepthMode(KLEIN, false), "off");
  assert.equal(defaultDepthMode(K9B, true), "off");
  assert.equal(defaultDepthMode("__krea_depth__", true), "off");
});

function fake({ model = KLEIN, k = [8, 1, "euler_ancestral", "beta"], fsteps = 20, fcfg = 1, dlock = 0, props = {} } = {}) {
  const W = (name, value, extra = {}) => ({ name, value, ...extra });
  const n9056 = { id: 9056, properties: { ...props }, widgets: [W("steps", k[0]), W("cfg", k[1]), W("sampler_name", k[2]), W("scheduler", k[3])] };
  const n9081 = { id: 9081, properties: { ...props }, inputs: [{ name: "prompt", link: 7 }],
    widgets: [W("model", model, { options: { values: [KLEIN, K9B, TURBO] } }), W("steps", fsteps), W("cfg", fcfg), W("depth_lock", dlock),
      W("sampler", "auto"), W("scheduler", "auto"), W("shift", 0)] };
  const connected = [];
  const n9079 = { id: 9079, outputs: [{ name: "still_prompt" }, { name: "still_negative" }, { name: "motion_prompt" }, { name: "look_json" }, { name: "edit_prompt" }],
    connect: (o, node, slot) => { connected.push([o, node.id, slot]); links[7] = { origin_id: 9079, origin_slot: o }; } };
  const links = { 7: { origin_id: 9079, origin_slot: 0 } };
  const p = Object.create(Pipeline.prototype);
  const look = { state: {}, toJSON() { return { ...this.state }; }, changes: 0, onChange() { this.changes++; } };
  p.ctx = { app: { graph: { _nodes: [n9056, n9081, n9079], links } }, look };
  const btn = (key) => ({ dataset: { k: key }, disabled: false, pressed: "", setAttribute(_, v) { this.pressed = v; } });
  p.f = { model: { value: model }, depthSeg: { children: [btn("off"), btn("light"), btn("strict")] }, depthNote: {},
    steps: { value: "" }, cfg: { value: "" }, sampNote: {} };
  const w = (id, name) => [n9056, n9081].find((x) => x.id === id).widgets.find((x) => x.name === name);
  return { p, w, n9056, n9081, connected, links, look };
}

test("an App workflow on the old Krea 2 defaults takes C28's once; a user's own values stay", () => {
  const a = fake();
  a.p._frameDefaultsOnce();
  assert.equal(a.w(9056, "steps").value, 12);
  assert.equal(a.w(9056, "sampler_name").value, "euler_ancestral");
  assert.equal(a.w(9056, "scheduler").value, "beta");
  assert.equal(a.w(9056, "cfg").value, 1);
  assert.equal(a.w(9081, "steps").value, 12);
  assert.equal(a.w(9081, "cfg").value, 2);
  assert.equal(a.n9056.properties.ssFrameDefaults, "c28");
  // once only: the user going back to 8 steps afterwards is kept
  a.w(9056, "steps").value = 8; a.w(9056, "sampler_name").value = "euler_ancestral";
  a.p._frameDefaultsOnce();
  assert.equal(a.w(9056, "steps").value, 8);
  const b = fake({ k: [14, 1, "res_multistep", "simple"], fsteps: 28, fcfg: 1 });
  b.p._frameDefaultsOnce();
  assert.deepEqual([b.w(9056, "steps").value, b.w(9056, "sampler_name").value, b.w(9081, "steps").value], [14, "res_multistep", 28]);
  assert.deepEqual(OLD_KREA_DEFAULTS, { steps: 8, cfg: 1, sampler: "euler_ancestral", scheduler: "beta" });
});

test("FLUX.2 Klein 9B on the frame node gets its own 4 steps, CFG 1", () => {
  const a = fake({ model: K9B, fsteps: 0, fcfg: 0 });
  a.p._frameDefaultsOnce();
  assert.equal(a.w(9081, "steps").value, 4);
  assert.equal(a.w(9081, "cfg").value, 1);
});

test("Krea 2 + depth never sends karras; auto is euler_ancestral / beta", () => {
  const a = fake();
  a.p.f.model.value = "__krea_depth__";
  a.p._syncSampling = () => {};
  a.p.f.steps.value = "12"; a.p.f.cfg.value = "1";
  a.p.f.sampler = { value: "auto" }; a.p.f.sched = { value: "karras" }; a.p.f.shift = { value: "0" };
  a.p._samplingNote = () => {};
  a.p._applySampling();
  assert.equal(a.w(9056, "scheduler").value, "beta");
  assert.equal(a.w(9056, "sampler_name").value, "euler_ancestral");
  a.p.f.sched.value = "simple";
  a.p._applySampling();
  assert.equal(a.w(9056, "scheduler").value, "simple");
});

test("an unpicked depth mode on FLUX 3 Klein is Light, and Klein reads the Look's edit_prompt", () => {
  const a = fake();
  a.p._dmode = null;
  a.p._syncDepthLock();
  assert.equal(a.w(9081, "depth_lock").value, DEPTH_LOCK);
  assert.deepEqual(a.connected, [[4, 9081, 0]], "the frame node's prompt now comes from edit_prompt");
  // Strict (Krea 2 Turbo on the frame node) goes back to still_prompt
  a.p._dmode = "strict";
  a.p._syncDepthLock();
  assert.deepEqual(a.connected.at(-1), [0, 9081, 0]);
  // a user's explicit Off stays Off
  a.p._dmode = "off";
  a.p._syncDepthLock();
  assert.equal(a.w(9081, "depth_lock").value, 0);
});

test("a prompt typed on the frame node (no link) is never rewired", () => {
  const a = fake();
  a.n9081.inputs[0].link = null;
  a.p._dmode = null;
  a.p._syncDepthLock();
  assert.deepEqual(a.connected, []);
});

test("the Look gets ④ Frame's step count, so the compiler can keep vignetting at 12+ only", () => {
  assert.equal(DEFAULT_LOOK.frame_steps, 0);
  const a = fake();
  a.p._lookFrameSteps(8);
  assert.equal(a.look.state.frame_steps, 8);
  assert.equal(a.look.changes, 1);
  a.p._lookFrameSteps(8);
  assert.equal(a.look.changes, 1, "unchanged: no write");
});

test("switching Klein models moves default steps / CFG along, and leaves a user's own", () => {
  const a = fake({ fsteps: 12, fcfg: 2 });
  a.p._defKey = "klein";
  a.p.f.follow = { value: "0.9" }; a.p.f.followOut = {}; a.p._sliderFor = false;
  a.p._fillLoras = () => {}; a.p._drawShotCast = () => {};
  a.p.f.model.value = K9B;
  a.p._applyStillModel();
  assert.equal(a.w(9081, "steps").value, 4);
  assert.equal(a.w(9081, "cfg").value, 1);
  a.w(9081, "steps").value = 6;
  a.p.f.model.value = KLEIN;
  a.p._applyStillModel();
  assert.equal(a.w(9081, "steps").value, 6);
});

test("picking FLUX.2 Klein 9B right after ④ Frame opens (no pick seen yet) takes its 4 steps / CFG 1 (Maya, 2026-11-09)", () => {
  const prep = (a) => { a.p.f.follow = { value: "0.9" }; a.p.f.followOut = {}; a.p._sliderFor = false; a.p._fillLoras = () => {}; a.p._drawShotCast = () => {}; };
  const a = fake({ fsteps: 12, fcfg: 2 });   // the frame node on FLUX 3 Klein's defaults; no _defKey (show() never set one)
  prep(a);
  a.p.f.model.value = K9B;
  a.p._applyStillModel();
  assert.deepEqual([a.w(9081, "steps").value, a.w(9081, "cfg").value], [4, 1]);
  // back to FLUX 3 Klein: its own 12 / 2
  a.p.f.model.value = KLEIN;
  a.p._applyStillModel();
  assert.deepEqual([a.w(9081, "steps").value, a.w(9081, "cfg").value], [12, 2]);
  // Strict lock left Krea 2 Turbo on the frame node: that is FLUX 3 Klein's frame, so its defaults move too
  const b = fake({ model: TURBO, fsteps: 12, fcfg: 2 });
  prep(b);
  b.p.f.model = { value: K9B, options: [{ value: KLEIN }, { value: K9B }] };
  b.p._applyStillModel();
  assert.deepEqual([b.w(9081, "steps").value, b.w(9081, "cfg").value], [4, 1]);
  // a value the user changed stays (14 steps on FLUX 3 Klein)
  const c = fake({ fsteps: 14, fcfg: 2 });
  prep(c);
  c.p.f.model.value = K9B;
  c.p._applyStillModel();
  assert.deepEqual([c.w(9081, "steps").value, c.w(9081, "cfg").value], [14, 2]);
  // from Krea 2 + depth (its own KSampler) to FLUX.2 Klein 9B: the frame node still had FLUX 3 Klein on its defaults
  const d = fake({ model: KLEIN, fsteps: 12, fcfg: 2 });
  prep(d);
  d.p.f.model.value = "__krea_depth__"; d.p._applyStillModel();
  d.p.f.model.value = K9B; d.p._applyStillModel();
  assert.deepEqual([d.w(9081, "steps").value, d.w(9081, "cfg").value], [4, 1]);
});

test("the notes say why: Krea burns above CFG 1, Klein's negative needs CFG above 1", () => {
  assert.match(samplingNote("__krea_depth__", 12, 1), /1\.5 and up burns/);
  assert.match(samplingNote(KLEIN, 12, 2), /negative prompt acts only above CFG 1/);
  assert.match(samplingNote(K9B, 4, 1), /4-step distilled/);
});

test("the shipped App workflows carry the C28 defaults and the edit_prompt link", () => {
  for (const name of ["Soundstage_App", "Soundstage_App_Full", "Soundstage_Car_Chase", "Soundstage_In_The_Car", "Soundstage_Three_In_A_Car", "Soundstage_Western"]) {
    const wf = JSON.parse(readFileSync(new URL(`../../example_workflows/${name}.json`, import.meta.url), "utf8"));
    const node = (id) => wf.nodes.find((n) => n.id === id);
    assert.deepEqual(node(9056).widgets_values.slice(2, 6), [12, 1, "euler_ancestral", "beta"], name);
    assert.equal(node(9079).outputs[4].name, "edit_prompt", name);
    const link = wf.links.find((l) => l[3] === 9081 && l[4] === node(9081).inputs.findIndex((i) => i.name === "prompt"));
    assert.deepEqual([link[1], link[2]], [9079, 4], name);
  }
});
