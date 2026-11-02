// node --test tests/js/   (✦ Loop: the Seamless loop, Seam meter and Fix a loop seam cards, against a fake server)
import test from "node:test";
import assert from "node:assert/strict";

import * as O from "../../web/oneclick/oneclick.mjs";
import * as L from "../../web/oneclick/loop.mjs";

const still = O.makeTarget({ url: "/api/view?filename=look_00004_.png&subfolder=soundstage&type=output", shot: "s1", label: "Lake" });
const clip = O.makeTarget({ url: "/api/view?filename=draft_00012_.mp4&subfolder=soundstage&type=output", shot: "s1" });

const VIS = { verdict: "visible", seam: 8.3, badge: "Visible seam · 8.3x (jump at frame 86)" };
const OK = { verdict: "seamless", seam: 1.2, badge: "Seamless · 1.2x" };
// /soundstage/loop/fix seal on a clip whose last frame is not a copy of frame 0: nothing dropped, the same file back
const SEAL_NONE = (b) => ({ ref: b.ref, before: VIS, after: VIS });

/** A fake App server: records every call; `answers` maps "POST path how" -> body. */
function fakeServer(answers) {
  const calls = [];
  const api = {
    async fetchApi(path, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      const key = `${path}${body?.how ? " " + body.how : ""}`;
      const a = answers[key];
      if (a === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (typeof a === "function" ? a(body) : a) };
    },
  };
  return { api, calls };
}

function ctxFor(api, opts = {}) {
  const queued = [];
  return { api, opts, queued, quality: () => "Draft", seed: () => 42, progress() {}, say() {}, toast() {},
    async queue(p, label) { queued.push({ p, label }); return `pid${queued.length}`; },
    async wait(pid, out) { assert.equal(out, "save"); return { filename: `${pid}.mp4`, subfolder: "soundstage_private/loop", type: "output" }; } };
}

test("refs and files round-trip", () => {
  const f = L.fileOfRef("soundstage_private/loop/a_00001_.mp4 [output]");
  assert.deepEqual(f, { filename: "a_00001_.mp4", subfolder: "soundstage_private/loop", type: "output" });
  assert.equal(L.refOfFile(f), "soundstage_private/loop/a_00001_.mp4 [output]");
  assert.deepEqual(L.fileOfRef("x.png"), { filename: "x.png", subfolder: "", type: "output" });
});

test("loopBody: the target, a clamped length, the motion words", () => {
  const b = L.loopBody(still, { seconds: "30", motion: "  waves roll in " }, { seed: 9.7, quality: "Final" });
  assert.deepEqual(b, { source: still.ref, seconds: 8, prompt: "waves roll in", seed: 9, quality: "Final", sound: true });
  assert.equal(L.loopBody(still, {}).seconds, 4);
  assert.throws(() => L.loopBody(null), /pick/);
});

test("better: seamless wins, then the lower seam", () => {
  assert.equal(L.better(VIS, OK), true);
  assert.equal(L.better(OK, VIS), false);
  assert.equal(L.better({ ...VIS, seam: 5 }, { ...VIS, seam: 3 }), true);
  assert.equal(L.better(null, VIS), true);
});

test("the cards are registered in the Loop group; the meter needs no GPU", () => {
  for (const id of L.LOOP_IDS) assert.equal(O.getOneClick(id).group, "Loop");
  assert.equal(O.getOneClick("loop_meter").gpu, false);
  assert.equal(O.availability(O.getOneClick("loop"), still), true);
  assert.equal(O.availability(O.getOneClick("loop"), clip), true);
  assert.match(String(O.availability(O.getOneClick("loop_meter"), still)), /clips/);
});

test("Seamless loop: render, seal, trim fixes it: no bridge queued", async () => {
  const { api, calls } = fakeServer({
    "/soundstage/loop/prompt": { prompt: { save: { class_type: "SaveVideo" } } },
    "/soundstage/loop/seam": VIS,
    "/soundstage/loop/fix seal": SEAL_NONE,
    "/soundstage/loop/fix trim": { ref: "soundstage_private/loop/pid1_trim2-80.mp4 [output]", before: VIS, after: OK },
  });
  const ctx = ctxFor(api, { motion: "paddles dip", seconds: "4" });
  const r = await O.getOneClick("loop").run(still, ctx);
  assert.equal(ctx.queued.length, 1);
  assert.equal(calls[0].body.source, still.ref);
  assert.equal(r.file.filename, "pid1_trim2-80.mp4");
  assert.equal(r.extra.seamless, true);
  assert.match(r.note, /^Seamless · 1.2x · tried trim/);
  assert.ok(!calls.some((c) => c.body?.how === "bridge"));
});

test("Seamless loop: trim no better -> one bridge render, joined, before and after kept", async () => {
  const { api, calls } = fakeServer({
    "/soundstage/loop/prompt": { prompt: { save: {} } },
    "/soundstage/loop/seam": VIS,
    "/soundstage/loop/fix seal": SEAL_NONE,
    "/soundstage/loop/fix trim": { ref: "t", before: VIS, after: { ...VIS, seam: 9 } },
    "/soundstage/loop/fix bridge": { prompt: { save: {} }, clip_end: 85 },
    "/soundstage/loop/fix join": (b) => ({ ref: "soundstage_private/loop/j.mp4 [output]", before: VIS, after: { ...OK, seam: 1.5 }, _b: b }),
  });
  const ctx = ctxFor(api);
  const r = await O.getOneClick("loop").run(still, ctx);
  assert.equal(ctx.queued.length, 2);
  assert.equal(ctx.queued[1].label, "Loop bridge");
  const join = calls.find((c) => c.body?.how === "join");
  assert.equal(join.body.bridge_ref, "soundstage_private/loop/pid2.mp4 [output]");
  assert.equal(join.body.clip_end, 85);
  assert.equal(r.file.filename, "j.mp4");
  assert.deepEqual(r.extra.tried.map((t) => [t.how, t.kept]), [["seal", false], ["trim", false], ["bridge", true]]);
  assert.match(r.note, /tried trim \(no better\), bridge/);
});

test("Seamless loop with the fixer off never queues a second job", async () => {
  const { api } = fakeServer({ "/soundstage/loop/prompt": { prompt: {} }, "/soundstage/loop/seam": VIS,
    "/soundstage/loop/fix seal": SEAL_NONE, "/soundstage/loop/fix trim": { ref: "t", before: VIS, after: VIS } });
  const ctx = ctxFor(api, { fix: false });
  const r = await O.getOneClick("loop").run(still, ctx);
  assert.equal(ctx.queued.length, 1);
  assert.equal(r.extra.seamless, false);
  assert.match(r.extra.next, /reseed/);
});

test("an old server says it needs a restart", async () => {
  const { api } = fakeServer({});
  await assert.rejects(O.getOneClick("loop").run(still, ctxFor(api)), /restart/);
});

test("Seam meter reports the numbers and makes no take", async () => {
  const { api } = fakeServer({ "/soundstage/loop/seam": { ...VIS, metrics: { pixel: { ratio: 5 }, edges: { ratio: 8.3 }, motion: { ratio: 4 }, jerk: { ratio: 4.4 } } } });
  let said = "";
  const r = await O.getOneClick("loop_meter").run(clip, { ...ctxFor(api), say: (m) => (said = m) });
  assert.equal(r, null);
  assert.match(said, /Visible seam · 8.3x .* edges 8.3x/);
});

test("Fix a loop seam: no fix better -> no new take", async () => {
  const { api } = fakeServer({ "/soundstage/loop/seam": VIS, "/soundstage/loop/fix seal": SEAL_NONE,
    "/soundstage/loop/fix trim": { ref: "t", before: VIS, after: VIS }, "/soundstage/loop/fix bridge": { prompt: {}, clip_end: 10 },
    "/soundstage/loop/fix join": { ref: "j", before: VIS, after: { ...VIS, seam: 12 } } });
  assert.equal(await O.getOneClick("loop_fix").run(clip, ctxFor(api)), null);
});

test("a render that lands on its picture reads seamless and is still sealed: the take is the file without the repeat", async () => {
  const SEALED = "soundstage_private/loop/pid1_sealed.mp4 [output]";
  const { api, calls } = fakeServer({
    "/soundstage/loop/prompt": { prompt: { save: {} } },
    "/soundstage/loop/seam": { ...OK, dup_last: true },
    // re-encoding nudges the number up a hair: the sealed file is kept anyway (the meter already left the repeat out)
    "/soundstage/loop/fix seal": { ref: SEALED, before: { ...OK, dup_last: true }, after: { ...OK, seam: 1.3, badge: "Seamless · 1.3x" } },
  });
  const r = await O.getOneClick("loop").run(still, ctxFor(api));
  assert.equal(r.file.filename, "pid1_sealed.mp4");
  assert.equal(r.extra.seamless, true);
  assert.deepEqual(r.extra.tried.map((t) => [t.how, t.kept]), [["seal", true]]);
  assert.ok(!calls.some((c) => c.body?.how === "trim" || c.body?.how === "bridge"));
});

test("a visible seam with a repeated last frame: trim works on the sealed file", async () => {
  const SEALED = "soundstage_private/loop/pid1_sealed.mp4 [output]";
  const { api, calls } = fakeServer({
    "/soundstage/loop/prompt": { prompt: { save: {} } },
    "/soundstage/loop/seam": { ...VIS, dup_last: true },
    "/soundstage/loop/fix seal": { ref: SEALED, before: VIS, after: VIS },
    "/soundstage/loop/fix trim": { ref: "soundstage_private/loop/pid1_sealed_trim1-80.mp4 [output]", before: VIS, after: OK },
  });
  const r = await O.getOneClick("loop").run(still, ctxFor(api, { fix: false }));
  assert.equal(calls.find((c) => c.body?.how === "trim").body.ref, SEALED);
  assert.equal(r.file.filename, "pid1_sealed_trim1-80.mp4");
});
