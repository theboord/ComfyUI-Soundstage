// node --test tests/js/motiongate.test.mjs  (the motion gate on the stage-1 draft, before a Hollywood final)
// Pure parts from web/takecheck/model.mjs, plus attachTakeChecks driven through a tiny fake DOM: a Hollywood final on
// a draft the gate failed waits for an answer (Cancel / Render anyway / Re-roll the draft).
import test from "node:test";
import assert from "node:assert/strict";

import { motionChip, hollywoodHold, motionGateGraph, packReference, motionLine } from "../../web/takecheck/model.mjs";

const FAIL = {
  version: 1, verdict: "fail", summary: "Ana's right wrist is off its pose 1.2–1.8 s (+1 more).",
  people: [{ id: "a1", name: "Ana", verdict: "fail", pck: 0.71, shift_s: 0.125, uncertain: [], failures: [], advisory: [] }],
  failures: [
    { type: "wrong_pose", who: "Ana", names: ["right wrist"], joints: [4], t0: 1.21, t1: 1.79, scope: "one joint" },
    { type: "missing_motion", who: "Ana", names: ["right shoulder", "right elbow"], joints: [2, 3], t0: 3, t1: 3.5, scope: "whole body" },
  ],
  advisory: [],
};

test("motion chip: a failure names the person, the joint and the time; can't tell is never green", () => {
  const c = motionChip(FAIL);
  assert.equal(c.tone, "bad");
  assert.equal(c.text, "✗ Motion: Ana's right wrist 1.2–1.8 s +1");
  assert.equal(c.start, 1.21);
  assert.match(c.title, /Ana: fails, 71% of joints on their marks, late 0\.13 s overall/);
  assert.match(c.title, /✗ Ana's body doesn't move 3\.0–3\.5 s/);
  assert.match(c.title, /provisional/);
  const pass = motionChip({ verdict: "pass", people: [{ name: "Ana", verdict: "pass", pck: 0.934 }], failures: [], advisory: [] });
  assert.deepEqual([pass.tone, pass.text], ["ok", "✓ Motion 93%"]);
  const fingers = motionChip({ verdict: "pass", people: [{ name: "Ana", verdict: "pass", pck: 0.9 }], failures: [],
    advisory: [{ type: "finger", who: "Ana", names: ["right index fingertip"], t0: 2, t1: 2.4, scope: "one fingertip" }] });
  assert.deepEqual([fingers.tone, fingers.text], ["warn", "⚠ Fingers: Ana's right index 2.0–2.4 s"]);
  const unsure = motionChip({ verdict: "uncertain", people: [{ name: "Ana", verdict: "uncertain", uncertain: ["DWPose did not find this person in the draft"] }] });
  assert.equal(unsure.tone, "info");
  assert.equal(unsure.text, "Motion: can't tell");
  assert.match(unsure.title, /^Not a pass: DWPose did not find this person/);
  assert.equal(motionChip({ verdict: "unmeasured", why: "no clay people on this shot" }).tone, "info");
  assert.equal(motionChip({ pending: true }).text, "Motion: checking…");
  assert.equal(motionChip({ error: "DWPose isn't installed" }).text, "Motion: not checked");
  assert.equal(motionChip(null), null);
});

test("Hollywood hold: only Hollywood, only this shot's draft, only a failed or still-checking gate", () => {
  const base = { preset: "Hollywood", motion: FAIL, draftShot: "s1", shot: "s1" };
  const h = hollywoodHold(base);
  assert.equal(h.hold, true);
  assert.equal(h.state, "fail");
  assert.match(h.text, /• Ana's right wrist off its pose 1\.2–1\.8 s/);
  assert.equal(hollywoodHold({ ...base, preset: "Final" }).hold, false);
  assert.equal(hollywoodHold({ ...base, h3: true }).hold, false);
  assert.equal(hollywoodHold({ ...base, shot: "s2" }).state, "other");
  assert.equal(hollywoodHold({ ...base, motion: null }).state, "none");
  assert.equal(hollywoodHold({ ...base, motion: { verdict: "pass" } }).hold, false);
  assert.equal(hollywoodHold({ ...base, motion: { verdict: "uncertain" } }).hold, false);
  assert.equal(hollywoodHold({ ...base, motion: { verdict: "pass", advisory: [{}] } }).hold, false, "fingers alone never hold");
  const wait = hollywoodHold({ ...base, motion: { pending: true } });
  assert.deepEqual([wait.hold, wait.state], [true, "pending"]);
  assert.match(hollywoodHold({ ...base, draftQuality: "Draft" }).text, /rendered with Draft, not Hollywood/);
});

test("the gate's job: the draft through DWPose (body + hands, no face) into the Motion Gate node", () => {
  const g = motionGateGraph({ filename: "draft_00007_.mp4", subfolder: "soundstage", type: "output" });
  assert.equal(g.ss_mg_clip.inputs.source, "soundstage/draft_00007_.mp4 [output]");
  assert.equal(g.ss_mg_clip.inputs.fps, 0, "keeps the draft's own rate");
  assert.equal(g.ss_mg_pose.class_type, "DWPreprocessor");
  assert.deepEqual([g.ss_mg_pose.inputs.detect_body, g.ss_mg_pose.inputs.detect_hand, g.ss_mg_pose.inputs.detect_face], ["enable", "enable", "disable"]);
  assert.equal(g.ss_mg_pose.inputs.pose_estimator, "dw-ll_ucoco_384_bs5.torchscript.pt", "the DWPose model Real performance already uses");
  assert.deepEqual(g.ss_mg_gate.inputs.pose_keypoint, ["ss_mg_pose", 1]);
  assert.equal(g.ss_mg_gate.class_type, "SoundstageMotionGate");
});

test("reference packing: pixels -> 0-1, people never on screen dropped, hands kept per side", () => {
  const body = new Array(18).fill(null);
  body[2] = [192, 108]; body[5] = [288, 108];
  const right = new Array(21).fill([96, 54]);
  const ref = packReference([
    { id: "a1", name: "Ana", body: [body, null], hands: [[right, null], null] },
    { id: "b2", name: "Ben", body: [null, null], hands: [null, null] },
  ], { W: 960, H: 540, frames: 2, fps: 24, shot: "s1" });
  assert.equal(ref.people.length, 1);
  assert.deepEqual(ref.people[0].body[0][2], [0.2, 0.2]);
  assert.equal(ref.people[0].body[1], null);
  assert.deepEqual(ref.people[0].hands[0][0][0], [0.1, 0.1]);
  assert.equal(ref.people[0].hands[0][1], null);
  assert.equal(ref.aspect, 960 / 540);
  assert.equal(ref.shot, "s1");
});

test("motion lines read as sentences", () => {
  assert.equal(motionLine(FAIL.failures[0]), "Ana's right wrist off its pose 1.2–1.8 s");
});

// ------------------------------------------------------------------ attachTakeChecks through a tiny fake DOM

class Txt { constructor(d) { this.data = String(d); this.parent = null; } get textContent() { return this.data; } remove() { this.parent?._drop(this); } }
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.parent = null; this.style = {}; this.className = ""; }
  _drop(n) { this.children = this.children.filter((c) => c !== n); n.parent = null; }
  append(...ks) { for (const k of ks) { const n = typeof k === "string" ? new Txt(k) : k; n.parent?._drop(n); n.parent = this; this.children.push(n); } }
  after(n) { const p = this.parent; if (!p) return; n.parent?._drop(n); n.parent = p; p.children.splice(p.children.indexOf(this) + 1, 0, n); }
  remove() { this.parent?._drop(this); }
  replaceChildren(...ks) { for (const c of this.children) c.parent = null; this.children = []; this.append(...ks); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ stopPropagation() {}, target: this, type: "click" }); }
  focus() {}
  setAttribute(k, v) { this[k] = v; }
  querySelector(sel) { return this.all().find((e) => (sel.startsWith(".") ? e.className.split(" ").includes(sel.slice(1)) : e.tagName === sel.toUpperCase())) || null; }
  all() { return this.children.filter((c) => c instanceof El).flatMap((c) => [c, ...c.all()]); }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(String(v)); }
  get isConnected() { let p = this; while (p.parent) p = p.parent; return p === globalThis.document.body || p === globalThis.document.head; }
}

function harness({ preset = "Hollywood", motion = FAIL, shot = "s1" } = {}) {
  globalThis.document = { head: new El("head"), body: new El("body"), createElement: (t) => new El(t),
    getElementById: (id) => globalThis.document.head.all().find((e) => e.id === id) || null };
  const calls = [];
  const draftUrl = "/view?filename=draft_00007_.mp4&subfolder=soundstage&type=output";
  const ladder = { bar: new El("div"), sources: { 3: { kind: "video", url: draftUrl } }, setSource() {}, clearSource() {}, setFrame() {} };
  document.body.append(ladder.bar);
  const pipeline = { ltx: { settings: () => ({ preset }) }, m: { engine: { value: "LTX-2.5", addEventListener() {} } }, node: () => null, go() {},
    _render: async (step, all = false) => { calls.push([step, all]); } };
  const api = {
    clientId: "c", listeners: {},
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    async fetchApi(url) {
      const body = url === "/soundstage/takecheck" ? { verdict: "clean", chips: [{ tone: "ok", text: "✓ clean" }], checks: {}, recipe: { shot: { id: "s1" } }, motion }
        : url === "/soundstage/takecheck/timing" ? {} : { steps: {} };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  const stage = { actorMeshes: new Map(), activeShot: () => ({ id: shot, name: "Shot 1" }), state: { shot: { frames: 121, fps: 24 } } };
  return { ladder, pipeline, api, stage, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const modalButtons = () => document.body.all().filter((e) => e.className === "ss-tc-modal").flatMap((m) => m.all().filter((e) => e.tagName === "BUTTON"));
async function answer(label) {
  for (let i = 0; i < 20 && !modalButtons().length; i++) await tick();
  const b = modalButtons().find((x) => x.textContent === label);
  assert.ok(b, `a "${label}" button (have: ${modalButtons().map((x) => x.textContent).join(", ")})`);
  b.click();
  await tick();
}

test("a Hollywood final on a draft the gate failed waits: Cancel, Render anyway, Re-roll the draft", async () => {
  const { attachTakeChecks } = await import("../../web/takecheck/takecheck.mjs");
  const h = harness();
  const tc = attachTakeChecks({ app: { graph: null }, api: h.api, ladder: h.ladder, pipeline: h.pipeline, stage: h.stage, say: () => {} });
  await tick(); await tick();
  const strip = h.ladder.bar.parent.children[1];
  assert.match(strip.textContent, /✗ Motion: Ana's right wrist 1\.2–1\.8 s \+1/, "the draft's chip is on the Ladder");
  assert.match(strip.textContent, /Re-roll/, "a failed gate offers a re-roll");

  let p = h.pipeline._render(4);
  await answer("Cancel");
  await p;
  assert.deepEqual(h.calls, [], "cancel: nothing queued");

  p = h.pipeline._render(4);
  await answer("Render Hollywood anyway");
  await p;
  assert.deepEqual(h.calls, [[4, false]]);

  p = h.pipeline._render(4);
  await answer("Re-roll the draft");
  await p;
  await tick();
  assert.deepEqual(h.calls, [[4, false], [3, false]], "the cheap draft is re-rolled, not the Hollywood pass");
  assert.equal(typeof tc.gateMotion, "function");
});

test("no hold for a passing draft, another preset, or every-shot batches", async () => {
  const { attachTakeChecks } = await import("../../web/takecheck/takecheck.mjs");
  for (const [opts, step, all] of [[{ motion: { verdict: "pass", people: [], failures: [], advisory: [] } }, 4, false], [{ preset: "Final" }, 4, false], [{}, 4, true], [{}, 3, false]]) {
    const h = harness(opts);
    attachTakeChecks({ app: { graph: null }, api: h.api, ladder: h.ladder, pipeline: h.pipeline, stage: h.stage, say: () => {} });
    await tick(); await tick();
    await h.pipeline._render(step, all);
    assert.deepEqual(h.calls, [[step, all]], JSON.stringify(opts));
    assert.equal(modalButtons().length, 0);
  }
});

test("the reference is captured from the clay rig on every frame of the shot, through the shot camera", async () => {
  const THREE = await import("../../web/vendor/three.module.min.mjs");
  const { buildHuman } = await import("../../web/stage/humans.mjs");
  const { captureMotionReference, riggedActors } = await import("../../web/takecheck/motionref.mjs");
  const mesh = (geo, mat) => new THREE.Mesh(geo, mat);
  const g = buildHuman("man", 1.8, {}, mesh);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.2, 6); camera.lookAt(0, 1, 0);
  let frame = 0;
  const stage = {
    fw: 960, fh: 540, camera, frame: 0, state: { shot: { frames: 10, fps: 24 } }, actorMeshes: new Map([["a1", g]]),
    toJSON: () => ({ actors: [{ id: "a1", name: "Ana", kind: "man" }] }), activeShot: () => ({ id: "s1" }),
    setFrameSilent(f) { frame = f; g.position.x = f * 0.1; g.updateMatrixWorld(true); }, setFrame(f) { this.setFrameSilent(f); },
  };
  assert.deepEqual(riggedActors(stage), ["a1"]);
  const ref = await captureMotionReference(stage);
  assert.equal(ref.frames, 10);
  assert.equal(ref.people.length, 1);
  assert.equal(ref.people[0].name, "Ana");
  const neck = ref.people[0].body.map((b) => b[1][0]);
  assert.ok(neck.every((x, i) => i === 0 || x > neck[i - 1]), "she walks right across the frame");
  assert.ok(ref.people[0].hands[0][0]?.length === 21, "a right hand of 21 points");
  assert.equal(frame, 0, "the playhead is put back");
  assert.equal(await captureMotionReference({ ...stage, actorMeshes: new Map() }), null);
});
