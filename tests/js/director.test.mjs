// node --test tests/js/director.test.mjs
// The Director's browser side: the plans Python makes for Mike's commands (fixture from tests/test_director.py) run
// through the executors on a fake stage; every turn undoes back to the exact scene; GPU calls never run without the
// confirm; the camera / drive / WAV helpers; the backends hand the model's text to the planner.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Director, EXEC, pickOllama, cameraMoveKeys, drivePathKeys, encodeWav, downsample, wantsGo, YES_RE, NO_RE, explainFor } from "../../web/agent/director.mjs";

const FIX = JSON.parse(readFileSync(new URL("../agent_fixtures/director_plans.json", import.meta.url), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Just enough of web/stage/stage.mjs: the public calls the executors use, mutating .state like the real one. */
class FakeStage {
  constructor(scene) { this.state = clone(scene); this.frame = 0; this.selected = null; this.actorMeshes = new Map(this.state.actors.map((a) => [a.id, {}])); this.calls = []; }
  toJSON() { return clone(this.state); }
  load(s) { this.state = clone(s); this.actorMeshes = new Map(this.state.actors.map((a) => [a.id, {}])); }
  setFrame(f) { this.frame = f; }
  select(id) { this.selected = id; }
  onChange() {}
  onShots() {}
  activeShot() { return this.state.shots.find((s) => s.id === this.state.active_shot) || this.state.shots[0]; }
  setActiveShot(id) { if (this.state.shots.some((s) => s.id === id)) this.state.active_shot = id; }
  mount(r, h, pose, at, seat) { const a = this.state.actors.find((x) => x.id === r); if (!a) return false; a.mount_id = h; a.pose = "sit"; if (seat != null) a.seat = seat; return true; }
  unmount(r) { const a = this.state.actors.find((x) => x.id === r); delete a.mount_id; }
  setRig(type) { this.activeShot().rig = { type, amount: 1 }; }
  setCameraFollow(id, preset) { const sh = this.activeShot(); if (!id) delete sh.camera_follow; else { sh.camera_follow = id; sh.camera_keys = [{ frame: 0, position: [0, 1.22, 2.45], target: [0, 1.05, 0], focal_mm: 30 }]; this.calls.push(["follow", id, preset]); } }
  applyStunt(id, kind) { const a = this.state.actors.find((x) => x.id === id); if (!a) return null; a.stunt = kind; a.keys = [{ frame: 0, position: a.position }, { frame: 60, position: [a.position[0], 0, a.position[2] + 10], heading_deg: 180 }]; return { reverse_jturn: "Reverse J-turn", donut: "Donut", handbrake_180: "Handbrake 180" }[kind]; }
  setPhysics(ids, patch) { let n = 0; for (const a of this.state.actors) if (ids.includes(a.id)) { a.physics = { ...(a.physics || {}), ...patch }; n++; } return n; }
  simulatePhysics() { const dyn = this.state.actors.filter((a) => a.physics?.mode === "dynamic"); for (const a of dyn) { a.physics.baked = true; a.keys = [{ frame: 0, position: a.position }, { frame: 40, position: [a.position[0] + 2, 0, a.position[2]] }]; } return { ok: dyn.length > 0, message: `Simulated ${dyn.length} objects` }; }
}

const fakeApi = (handlers = {}) => {
  const seen = [];
  return { seen, clientId: "t", addEventListener() {}, removeEventListener() {},
    async fetchApi(path, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      seen.push({ path, body });
      const out = handlers[path]?.(body) ?? { error: "no handler" };
      return { status: out.error ? 500 : 200, ok: !out.error, json: async () => out };
    } };
};

function host(extra = {}) {
  const look = { description: "", grade: { warmth: 0, contrast: 0, saturation: 0, grain: 0, halation: 0, vignette: 0 } };
  const approvals = {};
  const cutState = { entries: [{ shot_id: "crane" }], flattened: 0 };
  const renders = { crane: { look: "a.png", draft: "a.mp4" }, tracking: { look: "b.png" }, chase: {} };
  const calls = { render: [], frames: [] };
  return {
    look: { get: () => clone(look), set: (p) => Object.assign(look, clone(p)) }, _look: look,
    approvals: { statusOf: (sid) => ({ take: renders[sid]?.draft ? { kind: "draft", url: renders[sid].draft } : null, status: approvals[sid] || "" }),
      setTakeStatus: (sid, take, status) => { approvals[sid] = status; } }, _approvals: approvals,
    cut: { entries: () => cutState.entries, add: (ids) => cutState.entries.push(...ids.map((shot_id) => ({ shot_id }))), flatten: async () => { cutState.flattened++; } }, _cut: cutState,
    renders: (sid) => renders[sid] || {}, chosen: (sid) => !!renders[sid]?.look,
    shotsInOrder: () => FIX.ctx.shots,
    pipeline: { selectShot: () => {}, f: { count: 2 }, async generateFrames() { calls.frames.push(1); }, async _render(step) { calls.render.push(step); } }, _calls: calls,
    snapshot: () => ({ look: clone(look), approvals: clone(approvals), cut: clone(cutState.entries) }),
    restore: (x) => { Object.assign(look, x.look); for (const k of Object.keys(approvals)) delete approvals[k]; Object.assign(approvals, x.approvals); cutState.entries = clone(x.cut); },
    ...extra,
  };
}

const mk = () => { const stage = new FakeStage(FIX.scene); const h = host(); return { stage, h, d: new Director({ api: fakeApi(), stage, host: h }) }; };
const P = (c) => FIX.plans[c];

// --------------------------------------------------------------------------------------------- Mike's commands

test("put Mara in the car at night, rain, camera on the hood, she's nervous", async () => {
  const { stage, h, d } = mk();
  const before = stage.toJSON();
  const r = await d.apply(P("Put Mara in the sports car at night, rain, camera on the hood, she's nervous"));
  assert.ok(r.ok, JSON.stringify(r.results));
  const s = stage.toJSON();
  assert.equal(s.environment.weather, "rain");
  assert.equal(s.lighting.preset, "night");
  assert.equal(s.actors.find((a) => a.id === "getaway").mount_id, "sports_car");
  assert.equal(s.actors.find((a) => a.id === "getaway").direction, "nervous");
  assert.deepEqual(stage.calls[0], ["follow", "sports_car", "windshield"]);
  assert.match(h._look.description, /Mara is nervous\./);
  assert.equal(r.results.length, 5);
  assert.ok(r.undoable && d.canUndo && r.explain);
  d.undo();
  assert.deepEqual(stage.toJSON(), before);
  assert.equal(h._look.description, "");
  d.redo();
  assert.equal(stage.toJSON().environment.weather, "rain");
});

test("make shot 2 a slow push-in at 50 mm", async () => {
  const { stage, d } = mk();
  const r = await d.apply(P("Make shot 2 a slow push-in at 50 mm"));
  assert.ok(r.ok);
  const s = stage.toJSON();
  assert.equal(s.active_shot, "tracking");
  const k = s.shots.find((x) => x.id === "tracking").camera_keys;
  assert.equal(k.length, 2);
  assert.ok(k.every((x) => x.focal_mm === 50));
  const d0 = Math.hypot(...k[0].target.map((v, i) => v - k[0].position[i])), d1 = Math.hypot(...k[1].target.map((v, i) => v - k[1].position[i]));
  assert.ok(d1 < d0, "the camera ends closer");
  assert.equal(k[1].frame, s.shot.frames - 1);
  assert.match(r.said[1], /slow move/);
});

test("crate stack + the car crashes through it: physics dynamic, path through the crates, baked", async () => {
  const { stage, d } = mk();
  const plan = P("Drop a crate stack by the wall and have the car crash through it");
  const r = await d.apply(plan);
  assert.ok(r.ok, JSON.stringify(r.results));
  const s = stage.toJSON();
  const crates = s.actors.filter((a) => a.kind === "crate");
  assert.equal(crates.length, 5);
  assert.ok(crates.every((a) => a.physics?.mode === "dynamic" && a.physics.baked));
  const car = s.actors.find((a) => a.id === "sports_car");
  const c = [crates.reduce((t, a) => t + a.position[0], 0) / 5, crates.reduce((t, a) => t + a.position[2], 0) / 5];
  const [k0, k1] = car.keys;
  // The crates' centre lies on the car's straight path.
  const cross = (k1.position[0] - k0.position[0]) * (c[1] - k0.position[2]) - (k1.position[2] - k0.position[2]) * (c[0] - k0.position[0]);
  assert.ok(Math.abs(cross) / Math.hypot(k1.position[0] - k0.position[0], k1.position[2] - k0.position[2]) < 0.05);
  d.undo();
  assert.equal(stage.toJSON().actors.filter((a) => a.kind === "crate").length, 0);
});

test("J-turn, warmer frame, approve, cut", async () => {
  const { stage, h, d } = mk();
  assert.ok((await d.apply(P("Use the J-turn stunt"))).ok);
  assert.equal(stage.toJSON().actors.find((a) => a.id === "sports_car").stunt, "reverse_jturn");
  const g = await d.apply(P("Make the first frame warmer"));
  assert.ok(g.ok && h._look.grade.warmth > 0);
  assert.match(g.said[0], /Warmer/);
  assert.ok((await d.apply(P("approve shot 1"))).ok);
  assert.equal(h._approvals.crane, "approved");
  const c = await d.apply(P("Cut it together with the best takes"));
  assert.ok(c.ok);
  assert.equal(h._cut.flattened, 1);
  assert.deepEqual(h._cut.entries.map((e) => e.shot_id), ["crane", "tracking", "chase"]);
  // Undo walks back one turn at a time: the cut, then the approval, then the grade, then the stunt.
  d.undo(); assert.equal(h._cut.entries.length, 1);
  d.undo(); assert.equal(h._approvals.crane, undefined);
  d.undo(); assert.equal(h._look.grade.warmth, 0);
  d.undo(); assert.equal(stage.toJSON().actors.find((a) => a.id === "sports_car").stunt, undefined);
  assert.equal(d.undo(), null);
});

test("renders never run without the confirm; with it, one per shot", async () => {
  const { h, d } = mk();
  const plan = P("Render a draft of shots 1 to 3");
  assert.equal(plan.confirm, true);
  const r = await d.apply(plan);
  assert.equal(h._calls.render.length, 0);
  assert.ok(r.results[0].skipped);
  assert.equal(d.canUndo, false, "nothing changed, nothing to undo");
  const r2 = await d.apply(plan, { confirmGpu: true });
  assert.deepEqual(h._calls.render, [3, 3, 3]);
  assert.equal(r2.queued, 3);
  assert.match(r2.said[0], /Queued 3 drafts/);
});

test("an executor failure is reported, not thrown", async () => {
  const { d } = mk();
  const r = await d.apply({ command: "x", calls: [{ tool: "stunt", kind: "app", gpu: false, plan: "I'll stunt", args: { target_id: "nope", target: "Ghost", stunt: "donut" } },
    { tool: "teleport", kind: "app", gpu: false, plan: "I'll teleport", args: {} }] });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => !x.ok));
});

// --------------------------------------------------------------------------------------------- propose + backends

test("propose with the rules sends the scene and the strip-ordered shots, no model call", async () => {
  const stage = new FakeStage(FIX.scene);
  const api = fakeApi({ "/soundstage/director/plan": (b) => ({ calls: [], plan: [], command: b.command, got: b }) });
  const d = new Director({ api, stage, host: host() });
  const p = await d.propose("make it rain", { backend: "rules" });
  assert.deepEqual(api.seen.map((x) => x.path), ["/soundstage/director/plan"]);
  assert.deepEqual(p.got.ctx.shots.map((s) => s.id), ["crane", "tracking", "chase"]);
  assert.equal(p.got.llm_text, null);
  assert.ok(p.timing.propose_ms >= 0);
});

test("the Ollama backend's answer goes to the planner; a dead model falls back with a note", async () => {
  const stage = new FakeStage(FIX.scene);
  const api = fakeApi({ "/soundstage/director/prompt": () => ({ system: "S", prompt: "U", max_length: 100 }),
    "/soundstage/director/plan": (b) => ({ calls: [], plan: [], notes: [], llm: b.llm_text }) });
  const d = new Director({ api, stage, host: host() });
  d.ollama = { url: "http://127.0.0.1:11434", model: "qwen3:4b" };
  const f0 = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { json: async () => ({ message: { content: '{"calls":[{"tool":"play"}]}' } }) }; };
  try {
    const p = await d.propose("play it", { backend: "ollama" });
    assert.equal(p.llm, '{"calls":[{"tool":"play"}]}');
    assert.equal(sent.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(sent.body.format, "json");
    assert.equal(sent.body.messages[0].content, "S");
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    const p2 = await d.propose("play it", { backend: "ollama" });
    assert.equal(p2.llm, null);
    assert.match(p2.notes.join(" "), /model unavailable.*rules/);
  } finally { globalThis.fetch = f0; }
});

test("API models stay off unless the server allows partner models", async () => {
  const stage = new FakeStage(FIX.scene);
  const api = fakeApi({ "/soundstage/director/info": () => ({ partner: false, available: true, tools: [] }),
    "/soundstage/director/prompt": () => ({ system: "S", prompt: "U" }), "/soundstage/director/plan": (b) => ({ calls: [], notes: [], llm: b.llm_text }) });
  const d = new Director({ api, stage, host: host() });
  d.apiModel = { url: "https://example.invalid/v1", model: "m", key: "k" };
  const p = await d.propose("play", { backend: "api" });
  assert.equal(p.llm, null);
  assert.match(p.notes.join(" "), /open-weights build/);
});

// --------------------------------------------------------------------------------------------- helpers

test("camera move keys", () => {
  const k0 = { frame: 0, position: [0, 1.6, 10], target: [0, 1.2, 0], focal_mm: 35 };
  const push = cameraMoveKeys(k0, "push_in", "slow", 96);
  assert.equal(push.keys.length, 2);
  assert.ok(push.keys[1].position[2] < 10 && push.keys[1].position[2] > 7);
  assert.deepEqual(push.keys[1].target, k0.target);
  const fast = cameraMoveKeys(k0, "push_in", "fast", 96);
  assert.ok(fast.metres > push.metres);
  const orbit = cameraMoveKeys(k0, "orbit_left", "medium", 96).keys[1];
  const r = (p) => Math.hypot(p[0] - k0.target[0], p[2] - k0.target[2]);
  assert.ok(Math.abs(r(orbit.position) - r(k0.position)) < 1e-2);
  assert.equal(cameraMoveKeys(k0, "static").keys.length, 1);
  assert.ok(cameraMoveKeys(k0, "crane_up").keys[1].position[1] > 1.6);
  assert.equal(cameraMoveKeys(k0, "teleport"), null);
  // Never pushes through the subject.
  const close = cameraMoveKeys({ ...k0, position: [0, 1.2, 0.8] }, "push_in", "fast").keys[1];
  assert.ok(Math.hypot(close.position[2] - 0) >= 0.59);
});

test("drive path passes through the target at the hit frame", () => {
  const res = drivePathKeys([0, 0, -30], [5, 0, 0], { speed: "fast", frames: 121, fps: 24 });
  const [a, b] = res.keys;
  const u = res.hitFrame / 120;
  const at = [a.position[0] + (b.position[0] - a.position[0]) * u, a.position[2] + (b.position[2] - a.position[2]) * u];
  assert.ok(Math.hypot(at[0] - 5, at[1]) < 0.3, JSON.stringify(at));
  assert.equal(res.kmh, 65);
  // From standstill on top of the target it still drives (along its heading).
  const still = drivePathKeys([5, 0, 0], [5, 0, 0], { heading: 0 });
  assert.ok(still.keys[1].position[2] > still.keys[0].position[2]);
});

test("WAV encoding for Whisper", () => {
  const x = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
  const y = downsample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  const wav = encodeWav(y, 16000);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(34, true), 16);
});

test("go / yes / no words", () => {
  assert.ok(wantsGo("render a draft of shot 2, go"));
  assert.ok(wantsGo("go ahead and render it"));
  assert.ok(!wantsGo("go to scene 2 and render a draft"));
  assert.ok(!wantsGo("render a draft"));
  for (const y of ["yes", "Apply", "go ahead", "do it!", "ok"]) assert.ok(YES_RE.test(y), y);
  for (const n of ["no", "cancel", "never mind"]) assert.ok(NO_RE.test(n), n);
  assert.ok(!YES_RE.test("yes, and make it rain"));
});

test("talk-through: an explanation and next steps", async () => {
  const { d } = mk();
  const plan = P("Make shot 2 a slow push-in at 50 mm");
  const r = await d.apply(plan);
  assert.match(r.explain, /push-in/);
  assert.ok(r.next.length >= 1 && r.next.length <= 3 && r.next.every((n) => n.label && n.command));
  assert.ok(r.next.some((n) => /draft of shot 2/.test(n.command)), JSON.stringify(r.next));
  assert.equal(explainFor([], []), "");
  assert.ok(Object.keys(EXEC).length >= 30);
});

test("a render running on the queue: the local model is skipped (Ollama, else the rules) instead of waiting", async () => {
  const stage = new FakeStage(FIX.scene);
  const api = fakeApi({ "/queue": () => ({ queue_running: [[1, "render"]], queue_pending: [] }),
    "/soundstage/director/info": () => ({ available: true, tools: [] }),
    "/soundstage/director/prompt": () => ({ system: "S", prompt: "U" }),
    "/soundstage/director/plan": (b) => ({ calls: [], notes: [], llm: b.llm_text }) });
  const d = new Director({ api, stage, host: host() });
  d.backend = "auto";
  const f0 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no ollama"); };
  try {
    const p = await d.propose("make it rain");
    assert.equal(p.used_backend, "rules");
    assert.match(p.notes.join(" "), /GPU is busy/);
    assert.ok(!api.seen.some((x) => x.path === "/prompt"), "nothing queued on the GPU");
    globalThis.fetch = async (url) => (/tags/.test(url) ? { json: async () => ({ models: [{ name: "qwen3:4b", details: {} }] }) }
      : { json: async () => ({ message: { content: '{"calls":[]}' } }) });
    assert.equal((await d.propose("make it rain")).used_backend, "rules", "an Ollama model nobody picked doesn't stand in");
    d.ollama.model = "qwen3:4b";
    const p2 = await d.propose("make it rain");
    assert.equal(p2.used_backend, "ollama");
    assert.equal(p2.llm, '{"calls":[]}');
  } finally { globalThis.fetch = f0; }
});

test("Ollama model choice: a text model, the largest", () => {
  assert.equal(pickOllama([{ name: "qwen3-vl:4b", size: "4.4B" }, { name: "nomic-embed-text", size: "137M" }, { name: "qwen3:4b", size: "4.0B" }, { name: "qwen2.5vl:7b", size: "8.3B" }]).name, "qwen3:4b");
  assert.equal(pickOllama([{ name: "llama3.1:8b", size: "8.0B" }, { name: "qwen3:4b", size: "4.0B" }]).name, "llama3.1:8b");
  assert.equal(pickOllama([]), null);
});
