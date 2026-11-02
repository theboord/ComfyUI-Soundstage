// node --test tests/js/grade.test.mjs
// The browser half of the colour pipeline: CDL normalising and writers, the NLE package's grade files, and the
// Coach's grade-continuity rule. Pixel maths and Python parity are in tests/test_grade.py.
import test from "node:test";
import assert from "node:assert/strict";

import * as G from "../../web/grade/grade.mjs";
import { gradeContinuity, advise } from "../../web/coach/rules.mjs";
import { exportAll } from "../../web/cut/exporters.mjs";

const stats = (o = {}) => ({ L_mean: 0.6, a_mean: 0.01, b_mean: 0.02, exposure_ev: -1, warmth_ev: 0.2, tint_ev: 0, ...o });
const GRADE = { slope: [1.1, 1, 0.9], offset: [0.01, 0, -0.02], power: [0.95, 1, 1.05], sat: 0.85 };

test("normalizeCdl clamps and fills; identity is identity", () => {
  assert.deepEqual(G.normalizeCdl({ slope: [9, "x"], sat: -3 }).slope, [4, 1, 1]);
  assert.equal(G.normalizeCdl({ sat: -3 }).sat, 0);
  assert.ok(G.isIdentity(null) && G.isIdentity(G.IDENTITY) && !G.isIdentity(GRADE));
  assert.deepEqual(G.normalizeCurve([0.2, 0.1, ...Array(15).fill(0.5)]).slice(0, 3), [0.2, 0.2, 0.5]);
  assert.equal(G.normalizeCurve([1, 2]), null);
});

test("EDL ASC lines and CDL XML", () => {
  assert.deepEqual(G.edlSop(GRADE), ["*ASC_SOP (1.1000 1.0000 0.9000)(0.0100 0.0000 -0.0200)(0.9500 1.0000 1.0500)", "*ASC_SAT 0.8500"]);
  const x = G.cdlXml("Sc_1_1G", GRADE, "a <b>");
  assert.match(x, /<ColorCorrection id="Sc_1_1G">/);
  assert.match(x, /<Description>a &lt;b&gt;<\/Description>/);
  assert.match(G.cccXml([{ id: "a", cdl: GRADE }, { id: "b", cdl: G.IDENTITY }]), /id="a">[\s\S]*id="b">/);
});

test("an identity .cube is the 33³ lattice, red fastest", () => {
  const lines = G.cubeText().trim().split("\n");
  assert.equal(lines.length, 5 + 33 ** 3);
  assert.equal(lines[2], "LUT_3D_SIZE 33");
  assert.equal(lines[5], "0.000000 0.000000 0.000000");
  assert.equal(lines[6], "0.031250 0.000000 0.000000");
  assert.equal(lines.at(-1), "1.000000 1.000000 1.000000");
});

test("gradeFiles: only graded clips, plus the show look; none without a grade", () => {
  const project = { name: "LL", shots: [{ id: "a", name: "Sc 1 · 1A", grade: GRADE }, { id: "b", name: "1B", grade: G.IDENTITY }, { id: "c", name: "1C" }],
    colour: { show: { cdl: { sat: 0.9 }, name: "Stolen" } } };
  const f = G.gradeFiles(project, "LL");
  assert.deepEqual(Object.keys(f), ["LL_grades.ccc", "LL_Sc_1_1A.cdl", "LL_Sc_1_1A.cube", "LL_show.cdl", "LL_show.cube", "GRADE.txt"]);
  assert.deepEqual(G.gradeFiles({ shots: [{ id: "c" }] }, "x"), {});
  const all = exportAll({ ...project, cut: [{ shot_id: "a" }, { shot_id: "c" }], shots: project.shots.map((s) => ({ ...s, frames: 24 })) });
  assert.ok(all["LL.edl"].includes("*ASC_SOP (1.1000 1.0000 0.9000)"));
  assert.ok(all["LL_grades.ccc"]);
});

test("checkCut says it in stops, and skips cuts between scenes", () => {
  const rows = [{ id: "h", name: "1H", scene: "SC1", stats: stats() }, { id: "g", name: "1G", scene: "SC1", stats: stats({ warmth_ev: 0.6 }) }];
  const f = G.checkCut(rows);
  assert.equal(f.length, 1);
  assert.equal(f[0].text, "1G is 0.4 stops warmer than 1H");
  assert.equal(G.checkCut([rows[0], { ...rows[1], scene: "SC2" }]).length, 0);
  assert.equal(G.checkCut([rows[0], { id: "d", name: "1D", scene: "SC1", stats: stats({ exposure_ev: -2 }) }])[0].text, "1D is 1.0 stop darker than 1H");
});

function ctx(shots) {
  return { scene: { actors: [], shots: [] }, cut: { shots, cut: shots.map((s) => ({ shot_id: s.id })) } };
}

test("Coach: grade continuity warns with a one-click match", () => {
  const items = gradeContinuity(ctx([
    { id: "h", name: "1H", scene_name: "SC1", renders: { final: "h.mp4" }, colour_stats: stats() },
    { id: "g", name: "1G", scene_name: "SC1", renders: { final: "g.mp4" }, colour_stats: stats({ warmth_ev: 0.6 }) }]));
  assert.equal(items.length, 1);
  assert.equal(items[0].level, "warn");
  assert.match(items[0].text, /^1G is 0\.4 stops warmer than 1H\./);
  assert.deepEqual(items[0].actions[0], { label: "Match 1G to it", kind: "match_grade", payload: { shot_id: "g", hero_id: "h" }, primary: true });
  assert.ok(advise("shots", ctx([{ id: "h", name: "1H", scene_name: "SC1", colour_stats: stats() },
    { id: "g", name: "1G", scene_name: "SC1", colour_stats: stats({ tint_ev: -0.5 }) }])).some((x) => x.rule === "grade_continuity"));
});

test("Coach: unmeasured shots get a Measure tip; matching shots stay quiet", () => {
  const t = gradeContinuity(ctx([{ id: "a", name: "A", renders: { final: "a.mp4" } }, { id: "b", name: "B", renders: { draft: "b.mp4" } }]));
  assert.equal(t.length, 1);
  assert.equal(t[0].actions[0].kind, "measure_grade");
  assert.deepEqual(t[0].actions[0].payload.ids, ["a", "b"]);
  assert.deepEqual(gradeContinuity(ctx([{ id: "a", name: "A", colour_stats: stats() }, { id: "b", name: "B", colour_stats: stats({ warmth_ev: 0.3 }) }])), []);
  assert.deepEqual(gradeContinuity(ctx([{ id: "a", name: "A" }])), []);
});
