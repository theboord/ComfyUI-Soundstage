// node --test tests/js/pitch.test.mjs
// Pitch Mode (Milestone 22): the transcript chunker, the stale-sketch cancel (Pitch's own jobs only, never anyone
// else's queue items), lock-to-shots, and a whole pitch through PitchSession on a fake stage with the server's real
// beat answers (tests/agent_fixtures/pitch_beats.json, kept current by tests/test_pitch.py).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chunkTranscript, SketchJobs, lockToShots, PitchSession } from "../../web/agent/pitch.mjs";
import { applyOpsToScene } from "../../web/agent/agent.mjs";

const FX = JSON.parse(readFileSync(new URL("../agent_fixtures/pitch_beats.json", import.meta.url), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
const sortDeep = (o) => (Array.isArray(o) ? o.map(sortDeep) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])])) : o);

// ------------------------------------------------------------------------------------------- chunking

test("chunking: sentences, ellipses and 'then' make beats; the unfinished tail waits", () => {
  const live = "Night. A rainy alley in Chinatown. A detective in a trench coat walks toward camera… a car's headlights sweep across hi";
  const a = chunkTranscript(live);
  assert.deepEqual(a.beats, ["Night.", "A rainy alley in Chinatown.", "A detective in a trench coat walks toward camera"]);
  assert.equal(a.rest, "a car's headlights sweep across hi");
  const b = chunkTranscript(`${a.rest}m… he turns and runs… camera follows low and handheld`, { final: true });
  assert.deepEqual(b.beats, ["a car's headlights sweep across him", "he turns and runs", "camera follows low and handheld"]);
  assert.equal(b.rest, "");
  assert.deepEqual(chunkTranscript("she grabs the keys, then she bolts out the back door", { final: true }).beats,
    ["she grabs the keys", "she bolts out the back door"]);
  assert.deepEqual(chunkTranscript("Dr. Lee walks in. INT. bar", { final: true }).beats, ["Dr. Lee walks in.", "INT. bar"]);
  assert.deepEqual(chunkTranscript("a stop with no space yet.").beats, []);          // could still be "yet.5" mid-word
  assert.deepEqual(chunkTranscript("   ", { final: true }).beats, []);
  // A long run-on clause with no stop splits at its last comma once it passes maxWords.
  const run = chunkTranscript("the bus pulls in slowly and the doors hiss open and everybody pours out onto the platform, nobody looks up", { maxWords: 12 });
  assert.equal(run.beats.length, 1);
  assert.equal(run.rest.trim(), "nobody looks up");
});

// ------------------------------------------------------------------------------------------- GPU jobs

function queueApi({ pending = [], running = [] } = {}) {
  const calls = [];
  let n = 0;
  const listeners = {};
  const q = { queue_running: running.map((p, i) => [i, p, {}, {}, []]), queue_pending: pending.map((p, i) => [10 + i, p, {}, {}, []]) };
  return {
    calls, q, clientId: "pitch-test",
    addEventListener(k, f) { (listeners[k] ||= []).push(f); },
    removeEventListener(k, f) { listeners[k] = (listeners[k] || []).filter((x) => x !== f); },
    emit(k, detail) { for (const f of listeners[k] || []) f({ detail }); },
    async fetchApi(path, init = {}) {
      const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path, method: init.method || "GET", body });
      if (path === "/prompt") { const pid = `mine_${++n}`; q.queue_pending.push([100 + n, pid, {}, {}, []]); return { ok: true, status: 200, json: async () => ({ prompt_id: pid }) }; }
      if (path === "/queue" && init.method === "POST") {
        q.queue_pending = q.queue_pending.filter((it) => !(body.delete || []).includes(it[1]));
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (path === "/queue") return { ok: true, status: 200, json: async () => clone(q) };
      if (path.startsWith("/history/")) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({ error: "no" }) };
    },
  };
}

test("stale cancel: deletes only Pitch's own queued sketches, never other users' items, never interrupts", async () => {
  const api = queueApi({ pending: ["someone_else_1", "someone_else_2"], running: ["someone_else_running"] });
  const jobs = new SketchJobs(api);
  const a = await jobs.queue({ s: { class_type: "SaveImage", inputs: {} } }, { kind: "sketch", beat: 1 });
  const b = await jobs.queue({ s: { class_type: "SaveImage", inputs: {} } }, { kind: "sketch", beat: 1 });
  const m = await jobs.queue({ s: { class_type: "SaveVideo", inputs: {} } }, { kind: "motion", beat: 1 });
  const r = await jobs.cancelStale(b.pid, { kind: "sketch" });
  assert.deepEqual(r.deleted, [a.pid]);
  const del = api.calls.filter((c) => c.path === "/queue" && c.method === "POST");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].body, { delete: [a.pid] });
  assert.ok(!api.calls.some((c) => c.path === "/interrupt"), "never interrupts the GPU");
  const left = api.q.queue_pending.map((x) => x[1]);
  for (const other of ["someone_else_1", "someone_else_2", b.pid, m.pid]) assert.ok(left.includes(other), `${other} stays queued`);
  assert.equal(jobs.mine.get(a.pid).state, "cancelled");
  // Its waiter rejects as cancelled (the filmstrip shows "skipped"), the kept one is untouched.
  const w = jobs.wait(a.pid);
  await assert.rejects(w, /cancelled/);
  // A job of ours that already runs is left to finish (marked stale), not interrupted.
  api.q.queue_pending = api.q.queue_pending.filter((x) => x[1] !== b.pid);
  api.q.queue_running.push([0, b.pid, {}, {}, []]);
  jobs.mine.get(b.pid).state = "running";
  const c = await jobs.queue({ s: { class_type: "SaveImage", inputs: {} } }, { kind: "sketch", beat: 1 });
  const r2 = await jobs.cancelStale(c.pid, { kind: "sketch" });
  assert.deepEqual(r2, { deleted: [], running: [b.pid] });
  assert.equal(jobs.mine.get(b.pid).stale, true);
  // Someone else's prompt id passed as "keep" or matched never gets deleted: only ids in jobs.mine are candidates.
  const r3 = await jobs.cancelStale(null, { match: () => true });
  assert.ok(!r3.deleted.some((p) => p.startsWith("someone_else")));
  assert.ok(api.q.queue_pending.some((x) => x[1] === "someone_else_1"));
  // The outputs arrive by event, matched by prompt id and the Save node.
  const d = await jobs.queue({ s9: { class_type: "SaveImage", inputs: {} } }, { kind: "sketch", beat: 2 });
  const p = jobs.wait(d.pid);
  api.emit("executed", { prompt_id: "someone_else_1", node: "s9", output: { images: [{ filename: "not_mine.png" }] } });
  api.emit("executed", { prompt_id: d.pid, node: "s9", output: { images: [{ filename: "beat.png", subfolder: "soundstage_pitch", type: "output" }] } });
  assert.equal((await p).s9.images[0].filename, "beat.png");
  jobs.destroy();
});

// ------------------------------------------------------------------------------------------- lock it

test("lock to shots: one shot per beat with that beat's camera and rig, transcript as notes, existing shots kept", () => {
  const scene = FX.final;
  const beats = FX.beats.map((r, i) => {
    const after = clone(scene);
    const sh = after.shots.find((x) => x.id === after.active_shot);
    sh.camera_keys = [{ frame: 0, position: [i, 1.6, 10], target: [i, 1.4, 0], focal_mm: 30 + i }];
    if (i === 5) sh.rig = { type: "handheld", amount: 1 };
    return { text: FX.pitch[i], caption: r.caption, after };
  });
  const before = clone(scene);
  const { scene: s, shots } = lockToShots(scene, beats);
  assert.deepEqual(scene, before, "pure");
  assert.equal(shots.length, 6);
  assert.equal(s.shots.length, before.shots.length + 6);
  assert.deepEqual(s.shots.slice(0, before.shots.length).map((x) => x.id), before.shots.map((x) => x.id));
  const p3 = s.shots.find((x) => x.id === "pitch_3");
  assert.equal(p3.camera_keys[0].focal_mm, 32);
  assert.equal(p3.notes, FX.pitch[2]);
  assert.equal(p3.pitch.beat, 3);
  assert.match(p3.name, /^Beat 3: A detective in a trench coat wal…$/);
  assert.deepEqual(s.shots.find((x) => x.id === "pitch_6").rig, { type: "handheld", amount: 1 });
  assert.equal(s.active_shot, "pitch_1");
  assert.deepEqual(s.camera_keys, s.shots.find((x) => x.id === "pitch_1").camera_keys);
  // Locking twice never reuses an id.
  const again = lockToShots(s, beats.slice(0, 2));
  assert.deepEqual(again.shots.map((x) => x.id), ["pitch_1b", "pitch_2b"]);
  assert.deepEqual(lockToShots(scene, []).shots, []);
});

// ------------------------------------------------------------------------------------------- the whole pitch

class FakeStage {
  constructor(scene) { this.state = clone(scene); this.frame = 0; this.rig = null; this.captures = 0; }
  toJSON() { return clone(this.state); }
  load(s) { this.state = clone(s); }
  setFrame(f) { this.frame = f; }
  select() {}
  onChange() {}
  onShots() {}
  setRig(t) { this.rig = t; const sh = this.state.shots.find((x) => x.id === this.state.active_shot); sh.rig = { type: t, amount: 1 }; }
  setActiveShot(id) { if (this.state.shots.some((s) => s.id === id)) this.state.active_shot = id; }
  async capture() { this.captures++; return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); }
}

function pitchApi() {
  const base = queueApi();
  const seen = [];
  let beat = 0;
  const f0 = base.fetchApi.bind(base);
  base.seen = seen;
  base.fetchApi = async (path, init = {}) => {
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    seen.push({ path, body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, blob: async () => new Blob([]) });
    if (path === "/soundstage/director/pitch") { const r = clone(FX.beats[beat++]); r.memory_in = body.memory; return ok(r); }
    if (path === "/soundstage/director/pitch_graph") return ok({ graph: { pt10: { class_type: body.kind === "motion" ? "SaveVideo" : "SaveImage", inputs: { image: body.image } } } });
    if (path === "/upload/image") return ok({ name: `cap_${seen.length}.png`, subfolder: "soundstage_pitch", type: "input" });
    if (path.startsWith("/view")) return ok({});
    return f0(path, init);
  };
  return base;
}

test("a whole pitch: beats stage the set in order, memory carries over, sketches land, undo beat / undo pitch / lock", async () => {
  const api = pitchApi();
  const stage = new FakeStage(FX.scene);
  const undoStack = [], redoStack = [];
  const director = { undoStack, redoStack, info: async () => ({ available: false }) };
  const used = [];
  const host = { pipeline: { useEditedFrame: (x) => used.push({ ...x, shot: stage.state.active_shot }) } };
  const events = [];
  const p = new PitchSession({ api, stage, director, host, opts: { model: "rules", warm: false }, onUpdate: (_, why) => events.push(why) });
  // A GPU that answers each sketch as soon as it is queued (its "executed" event), before the next beat's sketch.
  const q0 = p.jobs.queue.bind(p.jobs);
  p.jobs.queue = async (...args) => {
    const r = await q0(...args);
    const j = p.jobs.mine.get(r.pid);
    setTimeout(() => api.emit("executed", { prompt_id: r.pid, node: "pt10", output: { images: [{ filename: `${r.pid}.png`, subfolder: "soundstage_pitch", type: "output" }] } }), 0);
    j.state = "running";
    return r;
  };
  p.start();
  p.hear("Night. A rainy alley in Chinatown. A detective in a trench coat walks toward camera… a car's headlights sweep across");
  assert.equal(p.rest, "a car's headlights sweep across");               // still being said: not a beat yet
  p.hear("him… he turns and runs… camera follows low and handheld", { final: true });
  await p.idle();
  assert.equal(p.beats.length, 6);
  assert.deepEqual(p.beats.map((b) => b.text), ["Night.", "A rainy alley in Chinatown.", "A detective in a trench coat walks toward camera",
    "a car's headlights sweep across him", "he turns and runs", "camera follows low and handheld"]);
  // The stage is exactly the server's staged scene after the six beats (ops applied in the browser).
  const noRig = (shots) => shots.map(({ rig, ...x }) => x);
  for (const k of ["actors", "environment", "lighting"]) assert.deepEqual(sortDeep(stage.state[k]), sortDeep(FX.final[k]), k);
  assert.deepEqual(sortDeep(noRig(stage.state.shots)), sortDeep(FX.final.shots));
  assert.equal(stage.rig, "handheld");                                   // the rig goes through stage.setRig
  // Incremental: each beat was planned with the memory the previous beat returned.
  const plans = api.seen.filter((x) => x.path === "/soundstage/director/pitch");
  assert.equal(plans[0].body.memory, null);
  for (let i = 1; i < plans.length; i++) assert.deepEqual(plans[i].body.memory, FX.beats[i - 1].memory);
  assert.deepEqual(plans[5].body.ids, FX.beats[4].ids);
  // Every beat got its own sketch, from its own capture.
  assert.ok(p.beats.every((b) => b.sketch.status === "done" && /\.png$/.test(b.sketch.file.filename)));
  assert.equal(stage.captures, 6);
  assert.ok(p.beats.every((b) => b.timing.plan_ms >= 0 && b.timing.total_ms >= 0));
  // One Director undo step for the whole pitch, from the scene before the first beat.
  assert.equal(undoStack.length, 1);
  assert.deepEqual(undoStack[0].before.scene, FX.scene);
  // Per-step undo: the last beat goes, the stage is back to beat 5.
  const b6 = p.undoBeat();
  assert.equal(b6.n, 6);
  assert.deepEqual(stage.state, p.beats[4].after);
  assert.equal(undoStack.length, 1);
  assert.deepEqual(undoStack[0].after.scene, p.beats[4].after);
  // Lock it: five shots, the sketches as first frames through the pipeline's "use as first frame".
  p.beats.push(b6); stage.load(b6.after);
  const r = await p.lock();
  assert.equal(r.shots.length, 6);
  assert.equal(r.frames, 6);
  assert.deepEqual(used.map((u) => u.shot), ["pitch_1", "pitch_2", "pitch_3", "pitch_4", "pitch_5", "pitch_6"]);
  assert.ok(used.every((u) => u.name.startsWith("soundstage_pitch/")));
  assert.equal(stage.state.active_shot, "pitch_1");
  assert.equal(undoStack.length, 2);
  assert.equal(undoStack[1].label, "lock the pitch into shots");
  assert.ok(events.includes("locked"));
  // Nothing of anyone else's was deleted along the way.
  for (const c of api.calls.filter((x) => x.path === "/queue" && x.method === "POST")) for (const pid of c.body.delete) assert.ok(p.jobs.mine.has(pid));
  p.destroy();
});

test("a faster talker than the GPU: older queued sketches are skipped, the newest beats render, nobody else's jobs move", async () => {
  const api = pitchApi();
  api.q.queue_pending.push([1, "other_users_render", {}, {}, []]);
  const stage = new FakeStage(FX.scene);
  const p = new PitchSession({ api, stage, director: { undoStack: [], redoStack: [], info: async () => ({ available: false }) }, opts: { model: "rules", warm: false } });
  p.start();
  p.hear(FX.pitch.join(" "), { final: true });
  // Let the six beats stage while the GPU answers nothing.
  for (let i = 0; i < 200 && p.beats.length < 6; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.beats.length, 6);
  const st = p.beats.map((b) => b.sketch.status);
  assert.ok(st.filter((s) => s === "skipped").length >= 3, st.join(","));
  assert.equal(st[5], "rendering");
  assert.ok(api.q.queue_pending.some((x) => x[1] === "other_users_render"));
  // Answer the survivors and a skipped beat can be sketched again on demand.
  for (const [pid, j] of p.jobs.mine) if (j.state === "queued") api.emit("executed", { prompt_id: pid, node: "pt10", output: { images: [{ filename: `${pid}.png`, type: "output" }] } });
  await p.idle();
  const skipped = p.beats.find((b) => b.sketch.status === "skipped");
  const again = p.resketch(skipped);
  await new Promise((r) => setTimeout(r, 20));
  for (const [pid, j] of p.jobs.mine) if (j.state === "queued") api.emit("executed", { prompt_id: pid, node: "pt10", output: { images: [{ filename: `${pid}.png`, type: "output" }] } });
  await again;
  assert.equal(skipped.sketch.status, "done");
  assert.deepEqual(stage.state, p.beats[5].after, "re-sketching an old beat puts the stage back");
  p.destroy();
});

test("a sketch someone else removed from the queue is reported quickly, never waited out", async () => {
  const api = queueApi();
  const jobs = new SketchJobs(api);
  const a = await jobs.queue({ s: { class_type: "SaveImage", inputs: {} } }, { kind: "sketch", beat: 1 });
  api.q.queue_pending = [];                      // another client cleared the queue
  const t0 = Date.now();
  await assert.rejects(jobs.wait(a.pid, { pollMs: 20 }), /removed from the queue/);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(!api.calls.some((c) => c.method === "POST" && c.path === "/queue"), "Pitch deleted nothing itself");
  jobs.destroy();
});

test("starting a pitch loads Klein with one tiny 1-step job, then nothing more until a beat", async () => {
  const api = pitchApi();
  const stage = new FakeStage(FX.scene);
  const p = new PitchSession({ api, stage, director: { undoStack: [], redoStack: [], info: async () => ({ available: false }) }, opts: { model: "rules" } });
  p.start();
  for (let i = 0; i < 50 && !p.jobs.mine.size; i++) await new Promise((r) => setTimeout(r, 5));
  const g = api.seen.filter((x) => x.path === "/soundstage/director/pitch_graph");
  assert.equal(g.length, 1);
  assert.equal(g[0].body.steps, 1);
  assert.equal(g[0].body.megapixels, 0.1);
  assert.deepEqual([...p.jobs.mine.values()].map((j) => j.meta.kind), ["warm"]);
  p.destroy();
});
