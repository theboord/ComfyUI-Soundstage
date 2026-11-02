// Generative transitions (web/cut/gentransitions.mjs): placement on an edit, duration handles that snap to LTX
// lengths, freshness, the flatten the render uses (shared fixture with tests/test_gentransitions.py), the request the
// route reads, and Undo through the panel's own commit. node --test tests/js/gentransitions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as TL from "../../web/cut/timeline.mjs";
import * as GT from "../../web/cut/gentransitions.mjs";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/gentransitions_flatten.json", import.meta.url), "utf8"));
const caseOf = (n) => structuredClone(FIX.cases.find((c) => c.name === n).project);
const len = (cut) => cut.reduce((s, e) => s + e.out - e.in, 0);

const V = (f) => `/api/view?filename=${f}&subfolder=renders&type=output`;
const project = () => TL.normalizeProject({
  fps: 24, width: 1920, height: 1080,
  shots: [{ id: "a", frames: 120, renders: { draft: V("a.mp4") } }, { id: "b", frames: 100, renders: { look: V("b.png") } },
          { id: "c", frames: 90, renders: {} }],
  cut: [{ shot_id: "a", in: 0, out: 60 }, { shot_id: "b", in: 10, out: 80, trans: { type: "dissolve", frames: 12 } },
        { shot_id: "c", in: 0, out: 40 }],
});

test("eight styles, each with an LTX default length", () => {
  assert.deepEqual(GT.STYLES.map((s) => s.name), ["Smoke", "Water bend", "Whip pan", "Match cut", "Light leak", "Ink bleed", "Zoom through", "Morph"]);
  for (const s of GT.STYLES) assert.equal((s.frames - 1) % 8, 0, s.id);
});

test("lengths are 8k + 1 and snap to the nearest that fits", () => {
  assert.deepEqual(GT.lengths(45), [17, 25, 33, 41]);
  assert.equal(GT.snapLength(29), 25);
  assert.equal(GT.snapLength(30), 33);
  assert.equal(GT.snapLength(500), 97);
  assert.equal(GT.snapLength(30, 20), 17);
  assert.equal(GT.snapLength(30, 16), 0);
});

test("fitSides splits as evenly as it can, inside each clip's half", () => {
  assert.deepEqual(GT.fitSides(25, 29, 34), { pre: 12, post: 13 });
  assert.deepEqual(GT.fitSides(49, 10, 60), { pre: 10, post: 39 });    // A is short: B gives more
  assert.deepEqual(GT.fitSides(97, 10, 12), { pre: 8, post: 9 });      // shrinks to 17 to fit 22 frames
  assert.equal(GT.fitSides(17, 8, 8), null);
  assert.deepEqual(GT.fitSides(33, 29, 34, 20), { pre: 20, post: 13 }); // an edge drag keeps its side
});

test("place: on the edit, centred, replacing the dissolve there and any bridge already on it", () => {
  const p = project();
  const r = GT.place(p, 1, "smoke", { id: "g1" });
  assert.deepEqual({ from: r.gt.from, to: r.gt.to, occ: r.gt.occ, pre: r.gt.pre, post: r.gt.post }, { from: "a", to: "b", occ: 0, pre: 16, post: 17 });
  assert.equal(r.cut[1].trans, undefined);
  assert.equal(p.cut[1].trans.type, "dissolve");                      // pure: the input is untouched
  const p2 = { ...p, cut: r.cut, gen_transitions: r.gen_transitions };
  const r2 = GT.place(p2, 1, "whip_pan", { id: "g2" });
  assert.deepEqual(r2.gen_transitions.map((g) => [g.id, g.style, g.pre + g.post]), [["g2", "whip_pan", 17]]);
  assert.equal(GT.place(p, 0, "smoke"), null);                        // the head is not a cut
  assert.equal(GT.place(p, 1, "fire"), null);
  const tiny = TL.normalizeProject({ ...p, cut: [{ shot_id: "a", in: 0, out: 20 }, { shot_id: "b", in: 0, out: 12 }] });
  assert.equal(GT.place(tiny, 1, "smoke"), null);                     // 9 + 5 frames: 17 won't fit
});

test("span: the bridge's record frames and the two source frames it is conditioned on", () => {
  const p = caseOf("ready");
  assert.deepEqual(GT.span(p, p.gen_transitions[0]), { k: 1, at: 60, pre: 12, post: 13, frames: 25, a_src: 48, b_src: 22 });
  const e = GT.ends(p, p.gen_transitions[0]);
  assert.deepEqual([e.a.frame, e.a.ref, e.b.frame, e.b.ref], [48, "renders/a_draft.mp4 [output]", 22, "renders/b_final.mp4 [output]"]);
});

test("the anchor follows its edit through a reorder, and the n-th occurrence is the n-th", () => {
  const p = caseOf("two_bridges_second_occurrence");
  assert.equal(GT.locate(p, p.gen_transitions[1]), 3);
  assert.deepEqual(GT.anchorOf(p, 3), { from: "a", to: "b", occ: 1 });
  const moved = { ...p, cut: [{ shot_id: "a", in: 80, out: 100 }, ...p.cut] };   // a clip spliced in at the head
  assert.equal(GT.locate(moved, p.gen_transitions[1]), 4);
  assert.deepEqual(GT.flatten(moved).cut.filter((e) => e.shot_id.startsWith("gt_")).length, 2);   // both still play
  // Known limit: a splice that makes a NEW earlier b -> a edit moves the anchor onto it; its frames differ, so the
  // bridge goes stale instead of playing on the wrong cut.
  const twin = { ...p, cut: [{ shot_id: "b", in: 0, out: 40 }, ...p.cut] };
  assert.equal(GT.status(twin, p.gen_transitions[0])[0], "stale");
});

test("flatten and status match the shared fixture (the Python render does the same)", () => {
  for (const c of FIX.cases) {
    const p = structuredClone(c.project);
    assert.deepEqual((p.gen_transitions || []).map((g) => GT.status(p, g)[0]), c.status, c.name);
    const flat = GT.flatten(p);
    assert.deepEqual(flat.cut, c.cut, c.name);
    assert.equal(len(flat.cut), len(p.cut), `${c.name}: same length`);
  }
});

test("a flattened cut normalizes with the bridge as a clip of its own", () => {
  const flat = TL.normalizeProject(GT.flatten(caseOf("ready")));
  assert.deepEqual(flat.cut.map((e) => e.shot_id), ["a", "gt_g1", "b"]);
  assert.equal(flat.shots.find((s) => s.id === "gt_g1").renders.final, caseOf("ready").gen_transitions[0].url);
  assert.equal(TL.totalFrames(flat), 130);
});

test("dragEdge: the ends move by LTX steps and stay inside the clips", () => {
  const p = caseOf("ready");
  const g = p.gen_transitions[0];                     // pre 12, post 13 around record 60
  const head = GT.dragEdge(p, g, "head", 40);         // wants pre 20: 33 frames
  assert.deepEqual([head.pre, head.post], [20, 13]);
  const tail = GT.dragEdge(p, g, "tail", 200);        // as far as B allows
  assert.equal(tail.pre, 12);
  assert.ok(tail.post <= GT.maxSides(p, 1)[1] && (tail.pre + tail.post - 1) % 8 === 0);
  const shrink = GT.dragEdge(p, g, "tail", 61);
  assert.equal(shrink.pre + shrink.post, 17);
  assert.equal(GT.status({ ...p, gen_transitions: [head] }, head)[0], "stale");     // a rendered bridge resized is stale
});

test("refOfView, the route body and the saved video in /history", () => {
  assert.equal(GT.refOfView("/api/view?filename=x.mp4&subfolder=a%2Fb&type=temp"), "a/b/x.mp4 [temp]");
  assert.equal(GT.refOfView("/view?filename=y.png"), "y.png [output]");
  assert.equal(GT.refOfView("blob:abc"), "");
  assert.equal(GT.refOfView(""), "");
  const p = caseOf("ready");
  const g = { ...p.gen_transitions[0], seed: 9, quality: "Final", prompt: "red smoke" };
  assert.deepEqual(GT.requestBody(p, g, GT.ends(p, g)), { style: "smoke", frames: 25, fps: 24, quality: "Final", seed: 9, prompt: "red smoke",
    sound: true, a: { ref: "renders/a_draft.mp4 [output]", frame: 48 }, b: { ref: "renders/b_final.mp4 [output]", frame: 22 } });
  assert.deepEqual(GT.fileFromHistory({ outputs: { save: { images: [{ filename: "v.mp4", subfolder: "s", type: "output" }], animated: [true] } } }),
    { filename: "v.mp4", subfolder: "s", type: "output" });
  assert.equal(GT.fileFromHistory({ outputs: {} }), null);
});

test("nearestEdit picks the cut closest to the playhead", () => {
  const p = project();                // edits at 60 and 130
  assert.equal(GT.nearestEdit(p, 10), 1);
  assert.equal(GT.nearestEdit(p, 100), 2);
  assert.equal(GT.nearestEdit({ cut: [{ shot_id: "a", in: 0, out: 10 }] }, 3), -1);
});

// A panel with CutPanel's commit / undo semantics (web/cut/cut.mjs _commit, _snapshot, undo), no DOM.
function fakePanel(p) {
  const P = {
    project: p, frame: 58, sel: -1, history: [], future: [], msgs: [], speed: 0, rate: 24,
    _snapshot() { return { cut: this.project.cut, gen_transitions: this.project.gen_transitions }; },
    _commit(cut, sel, extra = {}) {
      this.history.push(this._snapshot());
      this.project = { ...this.project, cut };
      if ("gen_transitions" in extra) this.project.gen_transitions = extra.gen_transitions;
      this.project = TL.normalizeProject(this.project);
    },
    undo() { this.future.push(this._snapshot()); this.project = { ...this.project, ...this.history.pop() }; },
    say(m) { this.msgs.push(m); },
    requestDraw() {},
    _renderPreviewFrame: () => ({ fake: "canvas" }),
  };
  return P;
}

test("GenTransitions: add, render in place, and Undo, each one step", async () => {
  const P = fakePanel(project());
  const calls = [];
  const gt = new GT.GenTransitions(P, { generate: async (req) => { calls.push(req); return { url: V("bridge.mp4"), path: "renders/bridge.mp4" }; } });
  const id = gt.add("ink_bleed");
  assert.equal(P.history.length, 1);
  assert.equal(P.project.cut[1].trans, undefined);
  assert.equal(GT.status(P.project, gt.byId(id))[0], "planned");
  assert.equal(gt.at(55), null);                                   // planned bridges never play
  assert.equal(await gt.render(id), true);
  assert.equal(P.history.length, 2);
  const req = calls[0];
  assert.equal(req.body.style, "ink_bleed");
  assert.equal(req.body.frames, 41);
  assert.deepEqual(req.body.a, { ref: "renders/a.mp4 [output]", frame: 60 - 20 });
  assert.deepEqual(req.body.b, { ref: "renders/b.png [output]", frame: 10 + 21 - 1 });
  assert.deepEqual(Object.keys(req.captures), []);                // both clips have renders: nothing captured
  const g = gt.byId(id);
  assert.equal(GT.status(P.project, g)[0], "ready");
  assert.deepEqual(gt.at(60 - 20), { g, i: 0 });
  assert.deepEqual(gt.at(60 + 20), { g, i: 40 });
  assert.equal(gt.at(60 + 21), null);
  P.undo();                                                        // the render comes out, the plan stays
  assert.equal(GT.status(P.project, gt.byId(id))[0], "planned");
  P.undo();                                                        // and the dissolve comes back
  assert.equal(gt.list.length, 0);
  assert.equal(P.project.cut[1].trans.type, "dissolve");
});

test("GenTransitions: a clip with no render (live clay) is captured; a failed render changes nothing", async () => {
  const P = fakePanel(project());
  P.frame = 128;                                                   // the edit into c (clay)
  let seen = null;
  const gt = new GT.GenTransitions(P, { generate: async (req) => { seen = req; throw new Error("GPU busy"); } });
  const id = gt.add("whip_pan");
  assert.equal(gt.byId(id).to, "c");
  const before = P.history.length;
  assert.equal(await gt.render(id), false);
  assert.equal(seen.body.b.ref, "");
  assert.deepEqual(seen.captures.b, { fake: "canvas" });
  assert.equal(P.history.length, before);
  assert.match(P.msgs.at(-1), /GPU busy/);
  assert.equal(gt.busy.size, 0);
});

test("GenTransitions: setLength and remove are undoable edits", () => {
  const P = fakePanel(project());
  const gt = new GT.GenTransitions(P, {});
  const id = gt.add("smoke");
  gt.setLength(id, 49);
  assert.equal(gt.byId(id).pre + gt.byId(id).post, 49);
  gt.remove(id);
  assert.equal(gt.list.length, 0);
  P.undo();
  assert.equal(gt.byId(id).pre + gt.byId(id).post, 49);
  assert.equal(P.history.length, 2);
});

test("the Cut panel saves, restores and undoes gen_transitions (hooks in web/cut/cut.mjs)", () => {
  const src = readFileSync(new URL("../../web/cut/cut.mjs", import.meta.url), "utf8");
  const hooks = src.split("\n").filter((l) => l.includes("[gen-transitions hook]"));
  assert.equal(hooks.length, 10, hooks.join("\n"));
  for (const k of ["savedFields", "_snapshot", "_commit", "refresh"]) assert.ok(src.includes("gen_transitions"), k);
  assert.equal(src.match(/"graphics", "gen_transitions"\]/g).length, 3);   // saved, refreshed, committed
  assert.match(src, /graphics: p\.graphics, gen_transitions: p\.gen_transitions \}/);   // in the undo snapshot
});
