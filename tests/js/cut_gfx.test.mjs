// V3 motion graphics on the Cut timeline (web/cut/gfx.mjs; the render is soundstage/cut/gfx.py):
// the spec's easing tables, the pinned ops both twins must produce, sounds on A2, the project model and the lane.
// node --test tests/js/cut_gfx.test.mjs            (node tests/js/cut_gfx.test.mjs --update rewrites the fixture)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import * as G from "../../web/cut/gfx.mjs";
import * as TL from "../../web/cut/timeline.mjs";
import { CutPanel, savedFields } from "../../web/cut/cut.mjs";
import { gfxCases, frames } from "./fixtures/gfx_cases.mjs";

const FIX = new URL("./fixtures/gfx_states.json", import.meta.url);
function compute() {
  const cases = gfxCases(), graphics = G.normalizeGraphics(cases), states = {}, cues = {};
  for (const g of graphics) { states[g.id] = frames(g.frames).map((f) => [f, G.stateAt(g, f)]); cues[g.id] = G.sfxCues(g); }
  return { cases, graphics, states, cues };
}
if (process.argv.includes("--update")) { writeFileSync(FIX, JSON.stringify(compute()) + "\n"); console.log("fixture rewritten"); }

const close = (a, b, tol = 0.0015) => { assert.equal(a.length, b.length); a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `${i}: ${x} vs ${b[i]}`)); };
const seq = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i));

test("easing: the design system's reference tables (§8)", () => {
  close(seq(12, (i) => G.EASE.glide(i / 12)), [0, .100, .406, .607, .732, .817, .878, .922, .953, .975, .990, .998, 1]);
  close(seq(18, (i) => G.EASE.glide(i / 18)), [0, .037, .200, .406, .552, .655, .732, .792, .840, .878, .909, .934, .953, .969, .981, .990, .996, .999, 1]);
  close(seq(10, (i) => G.EASE.swift(i / 10)), [0, .026, .134, .367, .614, .776, .876, .938, .975, .994, 1]);
  close(seq(8, (i) => G.EASE.exit(i / 8)), [0, .009, .035, .082, .154, .257, .406, .626, 1]);
  close(seq(12, (i) => G.EASE.enter(i / 12)), [0, .576, .743, .832, .887, .924, .950, .969, .982, .991, .996, .999, 1]);
  close(seq(16, (i) => G.ao(i)), [0, -.010, -.030, -.040, .233, .610, .793, .899, .965, 1.004, 1.024, 1.030, 1.027, 1.020, 1.010, 1.003, 1.000]);
  close(seq(9, (i) => G.springFast(i)), [0, .277, .668, .910, 1.009, 1.028, 1.020, 1.009, 1.002, 1.000]);
  close(seq(13, (i) => G.spring(i)), [0, .146, .416, .668, .848, .956, 1.009, 1.027, 1.027, 1.020, 1.013, 1.007, 1.003, 1.000]);
  close(seq(18, (i) => G.expo(1, 2, G.EASE.glide(i / 18))),
    [1.000, 1.026, 1.148, 1.325, 1.466, 1.574, 1.661, 1.731, 1.789, 1.838, 1.877, 1.910, 1.937, 1.958, 1.974, 1.986, 1.994, 1.999, 2.000]);
  close(seq(14, (i) => G.slamScale(i)), [1.100, 1.104, 1.111, 1.115, 1.062, 1.020, 1.001, 0.991, 0.986, 0.985, 0.986, 0.990, 0.995, 0.999, 1.000]);
});

test("ops and cues: the pinned fixture (the Python render must match it too)", () => {
  const fx = JSON.parse(readFileSync(FIX, "utf8"));
  assert.deepEqual(compute(), fx);
  assert.deepEqual(new Set(fx.graphics.map((g) => g.template)), new Set(Object.keys(G.TEMPLATES)));
});

test("templates follow the layouts: PiP corner, dual even, callout zoom, split, end card", () => {
  const [pip, dual, call, split, end] = G.normalizeGraphics([{ template: "pip" }, { template: "dual", start_frame: 1 }, { template: "callout", start_frame: 2 },
    { template: "split", start_frame: 3 }, { template: "endcard", start_frame: 4 }]);
  const w = (g, f) => G.stateAt(g, f).filter((o) => o.op === "window");
  assert.deepEqual(w(pip, 40).map((o) => [o.x, o.y, o.w, o.h, o.r]), [[1264, 669, 560, 315, 20]]);      // L2 at rest
  assert.ok(w(pip, 0)[0].y > 669 + 40 && w(pip, 0)[0].alpha === 0);                                    // enters from +48, faded
  assert.deepEqual(w(dual, 40).map((o) => [o.x, o.y, o.w, o.h]), [[96, 300, 852, 480], [972, 300, 852, 480]]);
  assert.ok(w(dual, 4)[1].alpha === 0 && w(dual, 4)[0].alpha > 0);                                   // B 4 f after A
  const z = (f) => G.stateAt(call, f).find((o) => o.op === "zoom");
  assert.equal(z(0).z, 1);
  assert.ok(Math.abs(z(18).z - 2) < 1e-9 && z(18).cx > 960);                                          // landed on the control
  assert.ok(!G.stateAt(call, 9).some((o) => o.op === "ring") && G.stateAt(call, 10).some((o) => o.op === "ring"));   // ring at sync f10
  const div = (f) => G.stateAt(split, f).find((o) => o.op === "split").x;
  assert.deepEqual([div(0), div(14), div(40)], [0, 960, 960]);
  assert.equal(div(71), 1920 * 1 - Math.round((1 - G.EASE.swift(23 / 24)) * 960 * 1000) / 1000);
  const logo = G.stateAt(end, 30).find((o) => o.op === "logo");
  assert.deepEqual([logo.cx, logo.y, logo.w, logo.alpha], [960, 400, 640, 1]);
  assert.ok(G.stateAt(end, 119).every((o) => o.alpha !== 0));                                          // the logo never fades out
});

test("sounds: one per event on A2, rebuilt (not stacked) when a graphic moves", () => {
  const lib = Object.fromEntries(["SFX-01_tick_1", "SFX-03_thump", "SFX-02_swap", "SFX-04_whoosh_r", "SFX-04_whoosh_c", "SFX-05_whoosh_out_c", "SFX-05_whoosh_out_r"]
    .map((k) => [k, { url: `/view?filename=${k}.wav`, seconds: 0.5 }]));
  const p = TL.normalizeProject({ shots: [{ id: "s", frames: 200 }], cut: [{ shot_id: "s" }], audio: [{ id: "music", track: 3, url: "m.wav", frames: 100 }],
    graphics: [{ id: "k", template: "kinetic", start_frame: 24, text: "A B" }, { id: "p", template: "pip", start_frame: 100, frames: 48 }] });
  const clips = G.gfxClips(p, lib);
  assert.deepEqual(clips.map((c) => [c.start_frame, c.meta.sfx, c.track]), [[31, "SFX-03", 2], [34, "SFX-02", 2], [100, "SFX-04", 2], [138, "SFX-05", 2]]);
  assert.equal(clips[2].url, lib["SFX-04_whoosh_r"].url);                     // a bottom-right window pans right
  assert.equal(clips[0].gain_db, -9);                                          // SFX-03 peaks at -10 dBFS from a -1 dBFS file
  const a1 = G.withGfxClips(p, clips);
  const moved = { ...p, audio: a1, graphics: G.normalizeGraphics(p.graphics.map((g) => (g.id === "k" ? { ...g, start_frame: 48 } : g))) };
  const a2 = G.withGfxClips(moved, G.gfxClips(moved, lib));
  assert.equal(a2.length, 1 + 4);
  assert.equal(a2.find((c) => c.meta?.sfx === "SFX-03").start_frame, 55);
  assert.ok(a2.some((c) => c.id === "music"));
  assert.equal(G.fileKey({ sfx: "SFX-01", variant: "3", pan: "l" }, { "SFX-01_tick_3": {} }), "SFX-01_tick_3");
  assert.deepEqual(G.sfxCues({ ...p.graphics[1], sfx: false }), []);
});

test("project model: normalised, saved, rippled with sync lock; the V3 lane only shows once there is a graphic", () => {
  const p = TL.normalizeProject({ graphics: [{ template: "lower", start_frame: 50.4, text: "Hi" }, { template: "title" }] });
  assert.deepEqual(p.graphics.map((g) => [g.id, g.start_frame]), [["g2", 0], ["g1", 50]]);
  assert.deepEqual(savedFields(p).graphics, p.graphics);
  assert.deepEqual(TL.rippleItems(p.graphics, 10, 24).map((g) => g.start_frame), [0, 74]);
  assert.equal(TL.normalizeProject({}).graphics, undefined);
  const base = CutPanel.trackLayout(Infinity, 4), lane = CutPanel.trackLayout(Infinity, 4, false, true);
  assert.equal(lane.total - base.total, 20);
  assert.equal(G.hitGraphic({ graphics: p.graphics }, 60, 300, 940)?.id, "g1");      // the lower third's line
  assert.equal(G.hitGraphic({ graphics: p.graphics }, 60, 1800, 100), null);
});

test("the viewer's click mapping is paint()'s letterbox inverted (a 9:16 project too)", async () => {
  // _viewDown mapped clicks with py = v * 1080 while paint() letterboxes (s = W / 1920, oy = (H - 1080 s) / 2), so in a
  // 9:16 project a click in the middle of a PiP window missed it and the dashed selection box was drawn off the graphic.
  const G = await import("../../web/cut/gfx.mjs");
  for (const [W, H] of [[960, 540], [540, 960], [1080, 1080]]) {
    const { s, oy } = G.designBox(W, H);
    const [x, y] = G.viewToDesign(1400 * s, 826 * s + oy, W, H);
    assert.ok(Math.abs(x - 1400) < 1e-9 && Math.abs(y - 826) < 1e-9, `${W}x${H}`);
  }
  const [, y169] = G.viewToDesign(0, 270, 960, 540);
  assert.equal(y169, 540, "16:9 is the plain scale it always was");
});

test("a sync-locked ripple keeps a graphic's A2 sounds on the graphic", async () => {
  // _rippleV2 moves each graphic by its start_frame while _ripple moved its cue clips one by one by their own frame: a
  // graphic straddling the edit kept its picture where it was and lost some of its sounds to later frames.
  const TL = await import("../../web/cut/timeline.mjs");
  const { CutPanel } = await import("../../web/cut/cut.mjs");
  const lib = new Proxy({}, { get: (_, k) => ({ url: `/${String(k)}.wav`, seconds: 0.5 }), has: () => true });
  const project = TL.normalizeProject({ fps: 24, cut: [], graphics: G.normalizeGraphics([{ id: "k", template: "kinetic", start_frame: 0, text: "Recast. Rebuild. Rewrite." }]) });
  project.audio = G.withGfxClips(project, G.gfxClips(project, lib, 24));
  const p = Object.assign(Object.create(CutPanel.prototype), { project, history: [], future: [], sel: 0, syncLock: true, _gfxLib: lib,
    _snapshot: () => ({}), _afterEdit() {} });
  p._commit(project.cut, 0, { audio: p._ripple(15, 24), ...p._rippleV2(15, 24) });
  const want = G.gfxClips(p.project, lib, 24).map((a) => [a.meta.cue, a.start_frame]);
  const got = p.project.audio.filter((a) => a.meta?.gfx).map((a) => [a.meta.cue, a.start_frame]);
  assert.deepEqual(got, want);
});
