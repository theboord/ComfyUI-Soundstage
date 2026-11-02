// node --test tests/js/   (✦ Camera › Reshoot: the safe range, the typed move, the job, the take note)
import test from "node:test";
import assert from "node:assert/strict";

import * as O from "../../web/oneclick/oneclick.mjs";
import * as R from "../../web/oneclick/reshoot.mjs";

const clip = O.makeTarget({ url: "/api/view?filename=final_00028_.mp4&subfolder=soundstage&type=output", shot: "s2" });
const still = O.makeTarget({ url: "/api/view?filename=look_00004_.png&subfolder=soundstage&type=output", shot: "s2" });

test("clampMove keeps the move where it stays real and says what it held back", () => {
  const { move, notes } = R.clampMove({ orbit_deg: 30, lens: 0.5, dolly: 0.1 });
  assert.deepEqual(move, { orbit_deg: 15, tilt_deg: 0, dolly: 0.1, lens: 0.7 });
  assert.equal(notes.length, 2);
  assert.deepEqual(R.clampMove({ orbit_deg: "x" }).move.orbit_deg, 0);
});

test("parseMove reads the typed move; dolly accepts percent", () => {
  assert.deepEqual(R.parseMove("orbit -12, tilt 4, dolly 15, lens 1.2"), { orbit_deg: -12, tilt_deg: 4, dolly: 0.15, lens: 1.2 });
  assert.deepEqual(R.parseMove("push 0.1"), { dolly: 0.1 });
  assert.equal(R.parseMove("make it nicer"), null);
  assert.deepEqual(R.moveOf({ move: "longer_lens" }), { lens: 1.35 });
  assert.deepEqual(R.moveOf({ move: "longer_lens", custom: "orbit 5" }), { orbit_deg: 5 });
  assert.deepEqual(R.moveOf({}), { orbit_deg: 10 });
});

test("every preset is inside the limits", () => {
  for (const [, , m] of R.MOVES) assert.equal(R.clampMove(m).notes.length, 0);
});

test("the card applies to clips, says why not on a still", () => {
  const s = O.getOneClick("reshoot");
  assert.equal(s.group, "Camera");
  assert.equal(O.availability(s, clip), true);
  assert.match(String(O.availability(s, still)), /clips/);
});

test("run: starts the job with the clamped move, follows its steps, lands the take with the note", async () => {
  const calls = [], steps = [];
  let polls = 0;
  const api = { async fetchApi(path, init = {}) {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (path === "/soundstage/reshoot") return { ok: true, status: 200, json: async () => ({ job: "j1" }) };
    polls++;
    return { ok: true, json: async () => (polls < 2 ? { state: "running", step: "Moving the camera", progress: 0.3 }
      : { state: "done", result: { file: { filename: "rs_00001_.mp4", subfolder: "soundstage_private/reshoot", type: "output" },
        words: "orbits 15 degrees to the right around the subject", holes: 0.061, move: { orbit_deg: 15 }, preview: "p [input]" } }) };
  } };
  const ctx = { api, opts: { custom: "orbit 40" }, quality: () => "Draft", seed: () => 3, progress: (t) => steps.push(t), say() {} };
  const s = O.getOneClick("reshoot");
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (f) => orig(f, 0);
  try {
    const r = await s.run(clip, ctx);
    assert.deepEqual(calls[0].body.move, { orbit_deg: 15, tilt_deg: 0, dolly: 0, lens: 1 });
    assert.equal(calls[0].body.source, clip.ref);
    assert.equal(r.file.filename, "rs_00001_.mp4");
    assert.match(r.note, /orbits 15 degrees .* 6% of the new view never seen/);
    assert.ok(steps.some((t) => /Moving the camera \(30%\)/.test(t)));
  } finally { globalThis.setTimeout = orig; }
});

test("a failed job throws its error", async () => {
  const api = { async fetchApi(path) {
    if (path === "/soundstage/reshoot") return { ok: true, json: async () => ({ job: "j" }) };
    return { ok: true, json: async () => ({ state: "error", error: "Depth Anything 3 is not on this server" }) };
  } };
  await assert.rejects(R.waitJob(api, "j", () => {}, { every: 0 }), /Depth Anything/);
});
