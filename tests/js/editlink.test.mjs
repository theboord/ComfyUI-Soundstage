// Edit from the timeline (Directive 9, docs/cut.md): clips pinned to a take (normalize, layout, every exporter), the
// link a clip carries (web/cut/editlink.mjs), the Edit in… items, the hold, Replace in cut as one Undo, and new takes.
// node --test tests/js/editlink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as TL from "../../web/cut/timeline.mjs";
import { exportAll, reelNames, toEDL, toFCPXML, toOTIO, toRelinkList } from "../../web/cut/exporters.mjs";

const V = (name, t = null) => `/api/view?filename=${name}&subfolder=soundstage&type=output${t ? `&t=${t}` : ""}`;
const A1 = V("a_v1.mp4"), A2 = V("a_v2.mp4"), LOOK = V("a_look.png", 5);
const shots = (aRenders = { final: V("a_v2.mp4", 77), look: LOOK }) => [
  { id: "a", name: "Sc 3 · Wide", frames: 97, setup: "wide", scene_name: "SC3", renders: aRenders },
  { id: "b", name: "Sc 3 · Close", frames: 97, setup: "close", scene_name: "SC3", renders: { draft: V("b.mp4") } },
  { id: "c", name: "Sc 4 · Clay", frames: 97, setup: "master", scene_name: "SC4", renders: {} },
  { id: "f", name: "Sc 5 · Plate", frames: 97, setup: "plate", scene_name: "SC5", renders: { look: V("f.png") },
    source: { path: "/footage/A001C003.mov", reel: "A001", fps: 24, width: 3840, height: 2160, frames: 200 } },
];
const project = (cut, extra = {}) => TL.normalizeProject({ fps: 24, shots: shots(), cut, ...extra });

// ------------------------------------------------------------------------------------------------ the model

test("normalize keeps uid, take and versions; drops bad ones; an old entry normalizes as before", () => {
  const p = project([
    { shot_id: "a", in: 0, out: 40, uid: "c1", take: { url: A1, rung: "final", version: "1", at: "13:40", kind: "app", junk: 1, recipe: { seed: 7, deep: { x: 1 } } },
      versions: [{ url: V("a_v0.mp4"), rung: "draft", version: 0 }, { url: "", rung: "final" }, { rung: "nope", url: "x" }] },
    { shot_id: "a", in: 40, out: 50, uid: "c1", take: { url: "", rung: "final" } },          // duplicate uid; a final needs a url
    { shot_id: "c", in: 0, out: 10, uid: "bad uid!", take: { rung: "clay" } },               // clay needs no url
    { shot_id: "b", in: 0, out: 10, versions: Array.from({ length: 15 }, (_, i) => ({ url: V(`b${i}.mp4`), rung: "draft", version: i + 1 })) },
  ]);
  assert.deepEqual(p.cut[0], { shot_id: "a", in: 0, out: 40, uid: "c1",
    take: { url: A1, rung: "final", version: 1, at: "13:40", kind: "app", recipe: { seed: 7 } },
    versions: [{ url: V("a_v0.mp4"), rung: "draft", version: 0 }] });
  assert.deepEqual(p.cut[1], { shot_id: "a", in: 40, out: 50 });
  assert.deepEqual(p.cut[2], { shot_id: "c", in: 0, out: 10, take: { url: "", rung: "clay", version: 0 } });
  assert.equal(p.cut[3].versions.length, TL.MAX_VERSIONS);
  assert.equal(p.cut[3].versions[0].version, 4, "the oldest go first");
  // an entry without the new fields normalizes byte for byte as before
  const plain = [{ shot_id: "a", in: 0, out: 40, notes: "n", trans: { type: "dissolve", frames: 6 }, opacity: [[0, 1]] }];
  assert.equal(JSON.stringify(project(plain).cut), '[{"shot_id":"a","in":0,"out":40,"notes":"n","trans":{"type":"dissolve","frames":6},"opacity":[[0,1]]}]');
  assert.equal(JSON.stringify(project([{ shot_id: "a" }]).cut).includes("take"), false);
});

test("layout plays the pin: its file, the shot's Look for the thumbnail, clay for a clay pin", () => {
  const p = project([{ shot_id: "a", in: 0, out: 40, take: { url: A1, rung: "final", version: 1 } }, { shot_id: "a", in: 40, out: 80 },
    { shot_id: "a", in: 80, out: 90, take: { url: "", rung: "clay" } }, { shot_id: "f", in: 0, out: 10, take: { url: "", rung: "clay" } },
    { shot_id: "f", in: 10, out: 20, take: { url: V("f_ripple.mp4"), rung: "draft", kind: "ripple" } }]);
  const rows = TL.layout(p);
  assert.deepEqual(rows[0].shot.renders, { final: A1, look: LOOK });
  assert.equal(rows[1].shot.renders.final, V("a_v2.mp4", 77), "an unpinned clip plays the shot's latest");
  assert.equal(TL.bestRung(rows[2].shot), "clay");
  assert.deepEqual(rows[2].shot.renders, {});
  assert.ok(rows[3].shot.source, "a clay pin on footage keeps the camera original");
  assert.equal(rows[4].shot.source, undefined, "a generated take is not the camera original");
  // the pinned file that is still the shot's own render plays under the shot's URL (the one the viewer loaded)
  const same = project([{ shot_id: "a", in: 0, out: 40, take: { url: A2, rung: "final", version: 2 } }]);
  assert.equal(TL.layout(same)[0].shot.renders.final, V("a_v2.mp4", 77));
  assert.equal(TL.mediaKey(rows[0]), `a|${A1}`);
  assert.equal(TL.mediaKey(rows[1]), "a");
  assert.equal(TL.viewKey(V("x.mp4", 9)), "output:soundstage/x.mp4");
});

test("exports use each clip's own file: two reels, two assets, both files relinked, each OTIO clip its URL", () => {
  const drafts = { draft: V("a_v2.mp4", 77), look: LOOK };   // drafts, so RELINK lists them
  const p = TL.normalizeProject({ fps: 24, shots: shots(drafts), cut: [
    { shot_id: "a", in: 0, out: 40, take: { url: A1, rung: "draft", version: 1 } },
    { shot_id: "b", in: 0, out: 30, trans: { type: "dissolve", frames: 6 } },
    { shot_id: "a", in: 40, out: 80 }], fade_out: { type: "dip_black", frames: 12 } });
  const edl = toEDL(p);
  const reels = new Set(edl.split("\n").filter((l) => /^\d{3} /.test(l) && !/ BL /.test(l)).map((l) => l.split(/\s+/)[1]));
  assert.equal(reels.size, 3, edl);
  assert.match(edl, /SOURCE FILE: soundstage\/a_v1\.mp4/);
  assert.match(edl, /SOURCE FILE: soundstage\/a_v2\.mp4/);
  const fcp = toFCPXML(p);
  assert.equal((fcp.match(/<asset id="r\d+" name="Sc 3 · Wide"/g) || []).length, 2, fcp);
  assert.match(fcp, /src="soundstage\/a_v1\.mp4"/);
  assert.match(fcp, /src="soundstage\/a_v2\.mp4"/);
  const relink = toRelinkList(p);
  assert.match(relink, /soundstage\/a_v1\.mp4/);
  assert.match(relink, /soundstage\/a_v2\.mp4/);
  const urls = toOTIO(p).tracks.children[0].children.filter((c) => c.OTIO_SCHEMA === "Clip.2").map((c) => c.media_references.DEFAULT_MEDIA.target_url);
  assert.deepEqual(urls, ["soundstage/a_v1.mp4", "soundstage/b.mp4", "soundstage/a_v2.mp4"]);
  // with no pins: the reels are one per shot, and uids or versions alone change nothing in any export
  const plain = { fps: 24, shots: shots(drafts), cut: [{ shot_id: "a", in: 0, out: 40 }, { shot_id: "a", in: 40, out: 80 }] };
  assert.deepEqual([...reelNames(TL.normalizeProject(plain)).keys()], ["a", "b", "c", "f"]);
  const tagged = { ...plain, cut: [{ shot_id: "a", in: 0, out: 40, uid: "c1", versions: [{ url: A1, rung: "draft", version: 1 }] }, { shot_id: "a", in: 40, out: 80 }] };
  assert.deepEqual(exportAll(tagged), exportAll(plain));
});

test("the strip's split and remove keep the pins (its _project() normalizes the saved cut)", async () => {
  const { ShotStrip } = await import("../../web/cut/strip.mjs");
  const saved = { cut: [{ shot_id: "a", in: 0, out: 40, uid: "c1", take: { url: A1, rung: "final", version: 1 }, versions: [{ url: V("a_v0.mp4"), rung: "final", version: 0 }] },
    { shot_id: "b", in: 0, out: 30 }] };
  const strip = Object.assign(Object.create(ShotStrip.prototype), {
    saved, _eids: [1, 2], _nextEid: 3, frame: 0, stage: { state: { shots: [{ id: "a", name: "Sc 3 · Wide" }, { id: "b", name: "Sc 3 · Close" }] } },
    _clock: () => ({ fps: 24, frames: 97 }), _getRenders: () => ({}), _sceneName: () => "SC3",
    _set(patch) { this.saved = { ...this.saved, ...patch }; }, _placePlayhead() {}, _status() {},
  });
  strip.splitAt(20);
  const n = TL.normalizeProject({ fps: 24, shots: shots(), cut: strip.saved.cut }).cut;
  assert.deepEqual(n.map((e) => [e.in, e.out, e.take?.url, e.versions?.length, e.uid]), [[0, 20, A1, 1, "c1"], [20, 40, A1, 1, undefined], [0, 30, undefined, undefined, undefined]]);
  strip.removeClip(2);
  assert.deepEqual(strip.saved.cut.map((e) => e.take?.url), [A1, A1]);
});

// ------------------------------------------------------------------------------------------------ the Cut side

const EL = await import("../../web/cut/editlink.mjs");

test("clipContext reads each clip type: final, draft, look, clay, a Ripple take, footage", () => {
  const p = TL.normalizeProject({ fps: 24, shots: [
    ...shots(), { id: "d", name: "Sc 6 · Two", frames: 97, renders: { draft: V("d.mp4", 3) } },
    { id: "l", name: "Sc 7 · Look", frames: 97, renders: { look: V("l.png", 4) } }],
  cut: [{ shot_id: "a", in: 0, out: 40, uid: "c1" }, { shot_id: "d", in: 5, out: 25 }, { shot_id: "l", in: 0, out: 20 },
    { shot_id: "c", in: 0, out: 20 }, { shot_id: "b", in: 10, out: 30, take: { url: V("b_rip.mp4"), rung: "draft", kind: "ripple", version: 2, label: "Ripple" } },
    { shot_id: "f", in: 0, out: 20 }] });
  const rec = TL.layout(p).map((r) => r.recIn);
  const ctx = (i) => EL.clipContext(p, i, { playhead: rec[i] + 3 });
  const got = [0, 1, 2, 3, 4, 5].map((i) => { const c = ctx(i); return [c.type, c.footage, c.take.url, c.clip.srcFrame, c.clip.uid]; });
  assert.deepEqual(got, [
    ["final", false, A2, 3, "c1"],
    ["draft", false, V("d.mp4"), 8, null],
    ["look", false, V("l.png"), 3, null],
    ["clay", false, "", 3, null],
    ["take", false, V("b_rip.mp4"), 13, null],
    ["look", true, V("f.png"), 3, null],
  ]);
  for (const i of [0, 1, 2]) assert.doesNotMatch(ctx(i).take.url, /[?&]t=/);
  // the playhead outside the clip: the right-click point, else the in point
  assert.equal(EL.clipContext(p, 1, { playhead: 0, recFrame: rec[1] + 10 }).clip.srcFrame, 15);
  assert.equal(EL.clipContext(p, 1, { playhead: 0, recFrame: 9999 }).clip.srcFrame, 5);
  assert.equal(ctx(0).recipeUrl, "/soundstage/takecheck/recipe?filename=a_v2.mp4&subfolder=soundstage&type=output");
  assert.equal(ctx(2).recipeUrl, "", "the recipe route reads MP4 tags only");
  assert.equal(EL.headLine(ctx(4)), "Sc 3 · Close · Ripple v2");
  assert.equal(EL.clipContext(p, 99), null);
});

test("menuItems matches the item table (docs/cut.md): on / off per clip type, with the reason", () => {
  const p = TL.normalizeProject({ fps: 24, shots: [...shots(), { id: "l", name: "L", frames: 97, renders: { look: V("l.png") } }],
    cut: [{ shot_id: "a", in: 0, out: 10 }, { shot_id: "l", in: 0, out: 10 }, { shot_id: "c", in: 0, out: 10 },
      { shot_id: "b", in: 0, out: 10, take: { url: V("b_rip.mp4"), rung: "draft", kind: "ripple" } }, { shot_id: "f", in: 0, out: 10 }] });
  const table = (i) => Object.fromEntries(EL.menuItems(EL.clipContext(p, i)).filter((x) => x.where && x.where !== "version")
    .map((x) => [x.where, x.disabled ? x.why : "on"]));
  const NOCLIP = { look: "a still has no motion to keep: use First frame or ✦", clay: "clay is drawn live, so there is no clip: render a Draft first, or Re-block",
    foot: "the camera original is not a ComfyUI file" };
  const on = { frame: "on", motion: "on", stage: "on", canvas: "on", review: "on" };
  assert.deepEqual(table(0), { ...on, ripple: "on", paint_v2v: "on", reshoot: "on", oneclick: "on" });
  assert.deepEqual(table(1), { ...on, ripple: NOCLIP.look, paint_v2v: NOCLIP.look, reshoot: "Reshoot needs a clip", oneclick: "on" });
  assert.deepEqual(table(2), { ...on, ripple: NOCLIP.clay, paint_v2v: NOCLIP.clay, reshoot: NOCLIP.clay, oneclick: "nothing rendered to work on" });
  assert.deepEqual(table(3), { ...on, ripple: "on", paint_v2v: "on", reshoot: "on", oneclick: "on", follow: "on" });
  assert.deepEqual(table(4), { ...on, ripple: NOCLIP.foot, paint_v2v: NOCLIP.foot, reshoot: NOCLIP.foot, oneclick: NOCLIP.foot });
  const label = (i, w) => EL.menuItems(EL.clipContext(p, i)).find((x) => x.where === w).label;
  assert.deepEqual([label(0, "motion"), label(1, "motion"), label(2, "motion")], ["Re-generate", "Animate this frame", "Render it"]);
  // a host without ✦ turns it off and says so; versions are not offered on footage
  assert.equal(EL.menuItems(EL.clipContext(p, 0), { oneclick: false }).find((x) => x.where === "oneclick").why, "not available here");
  assert.equal(EL.menuItems(EL.clipContext(p, 4)).some((x) => x.where === "version" || x.where === "follow"), false);
});

/** A CutPanel with the REAL _snapshot, _commit, undo and redo (no DOM: _afterEdit and _syncMedia are stubbed). */
async function panelOf(proj) {
  const { CutPanel } = await import("../../web/cut/cut.mjs");
  return Object.assign(Object.create(CutPanel.prototype), { project: proj, history: [], future: [], sel: 0, frame: 0, _afterEdit() {}, _syncMedia() {} });
}
const holdCut = () => project([
  { shot_id: "a", in: 0, out: 40, notes: "keep", opacity: [[0, 1], [20, 0.5]] },
  { shot_id: "b", in: 0, out: 30, trans: { type: "dissolve", frames: 6 } },
  { shot_id: "a", in: 40, out: 80, trans: { type: "dip_black", frames: 4 } },
  { shot_id: "c", in: 0, out: 10 }, { shot_id: "f", in: 0, out: 10 }, { shot_id: "c", in: 10, out: 20 }], { fade_out: { type: "dip_black", frames: 12 } });

test("the hold pins every clip of the setup (clay too, not footage originals), mints one uid, in one edit", async () => {
  const p = await panelOf(holdCut());
  const uid = EL.holdClip(p, p.clipContext(0));
  assert.equal(p.history.length, 1);
  assert.match(uid, /^[A-Za-z0-9_-]{1,40}$/);
  assert.deepEqual(p.project.cut.map((e) => [e.shot_id, e.take?.url ?? null, e.take?.version ?? null, e.uid ?? null]),
    [["a", A2, 1, uid], ["b", null, null, null], ["a", A2, 1, null], ["c", null, null, null], ["f", null, null, null], ["c", null, null, null]]);
  const q = await panelOf(holdCut());
  EL.holdClip(q, q.clipContext(3));
  assert.deepEqual(q.project.cut.map((e) => e.take?.rung ?? null), [null, null, null, "clay", null, "clay"]);
  const f = await panelOf(holdCut());
  EL.holdClip(f, f.clipContext(4));
  assert.equal(f.project.cut[4].take, undefined, "footage that plays its camera original is not held");
  assert.match(f.project.cut[4].uid, /^c/);
  // holding again changes nothing: no second history entry
  EL.holdClip(p, p.clipContext(0));
  assert.equal(p.history.length, 1);
});

test("Replace in cut is ONE undo: same in/out and transitions, old take in versions, survives save and reload", async () => {
  const { savedFields } = await import("../../web/cut/cut.mjs");
  const p = await panelOf(holdCut());
  EL.holdClip(p, p.clipContext(0));
  const before = JSON.parse(JSON.stringify(p.project));
  assert.equal(p.replaceClipTake(0, { url: V("a_v3.mp4", 99), rung: "final", kind: "app", at: "14:20" }), true);
  assert.equal(p.history.length, 2);
  const e = p.project.cut[0];
  assert.deepEqual([e.in, e.out, e.notes, e.opacity, e.uid], [0, 40, "keep", [[0, 1], [20, 0.5]], before.cut[0].uid]);
  assert.deepEqual(e.take, { url: V("a_v3.mp4"), rung: "final", version: 2, at: "14:20", kind: "app" });
  assert.deepEqual(e.versions, [before.cut[0].take]);
  assert.deepEqual(p.project.cut[1].trans, before.cut[1].trans);
  assert.deepEqual(p.project.cut[2], before.cut[2], "the sibling stays held on the old take");
  assert.deepEqual(p.project.fade_out, before.fade_out);
  assert.equal(TL.layout(p.project)[0].shot.renders.final, V("a_v3.mp4"));
  // save + reload (the host stores savedFields, the Cut normalizes what it reads back)
  const reloaded = TL.normalizeProject({ fps: 24, shots: shots(), ...JSON.parse(JSON.stringify(savedFields(p.project))) });
  assert.deepEqual(reloaded.cut[0].versions, [before.cut[0].take]);
  assert.deepEqual(reloaded.cut, p.project.cut);
  p.undo();
  assert.deepEqual(p.project.cut, before.cut, "one undo brings the old take back");
  p.redo();
  assert.equal(p.project.cut[0].take.url, V("a_v3.mp4"));
  // Follow the latest render: the pin goes, the old take joins the versions; then a replace of a version swaps back
  assert.equal(p.replaceClipTake(0, null), true);
  assert.equal(p.project.cut[0].take, undefined);
  assert.deepEqual(p.project.cut[0].versions.map((v) => v.version), [1, 2]);
  assert.equal(p.replaceClipTake(0, p.project.cut[0].versions[0]), true);
  assert.deepEqual([p.project.cut[0].take.version, p.project.cut[0].versions.map((v) => v.version)], [1, [2]]);
  assert.equal(p.replaceClipTake(99, { url: A1, rung: "final" }), false);
  assert.equal(p.replaceClipTake(0, { url: "", rung: "final" }), false, "a final needs a file");
});

test("versions are capped at 12, numbered per shot, and findClip finds a clip after edits", () => {
  let cut = project([{ shot_id: "a", in: 0, out: 10, uid: "c1" }, { shot_id: "a", in: 10, out: 20 }]).cut;
  for (let k = 1; k <= 15; k++) cut = EL.applyPins(cut, [{ index: 0, take: { url: V(`a_${k}.mp4`), rung: "draft" } }]);
  assert.equal(cut[0].take.version, 15);
  assert.equal(cut[0].versions.length, TL.MAX_VERSIONS);
  assert.deepEqual(cut[0].versions.map((v) => v.version), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(EL.versionFor(cut, "a", V("a_9.mp4", 1)), 9, "a file keeps its number");
  assert.equal(EL.versionFor(cut, "a", V("new.mp4")), 16);
  assert.equal(EL.versionFor(cut, "b", V("new.mp4")), 1);
  assert.equal(EL.applyPins(cut, [{ index: 0, take: { url: V("a_15.mp4", 5), rung: "draft" } }]), null, "the same file again changes nothing");
  const moved = [{ shot_id: "b", in: 0, out: 5 }, ...cut];
  assert.equal(EL.findClip(moved, { uid: "c1", index: 0, shot_id: "a", in: 0, out: 10 }), 1);
  assert.equal(EL.findClip(moved, { index: 1, shot_id: "a", in: 10, out: 20 }), 2);
  assert.equal(EL.findClip(moved, { index: 0, shot_id: "zz", in: 0, out: 1 }), -1);
  assert.notEqual(EL.mintUid([{ uid: "c000001" }], () => 1 / 36 ** 6), "c000001");
});

test("newTakes sees only takes that landed: an App final, a Ripple take, a new still for Look clips; not a new cache-buster", () => {
  const before = new Set([A1, V("a_look.png"), V("old_rip.mp4")].map(EL.fileKey));
  const takes = [
    { url: V("a_v1.mp4", 555) },                                     // the same file, a new cache-buster: not new
    { url: V("a_v2.mp4", 556), created: 2 },                         // an App final
    { url: V("rip.mp4"), created: 3, kind: "draft", ripple: true },  // a Ripple take
    { url: V("new_look.png"), created: 1 },                          // a new chosen still
    { url: V("old_rip.mp4"), created: 9 },
  ];
  assert.deepEqual(EL.newTakes(before, takes, "final").map((t) => t.url), [V("rip.mp4"), V("a_v2.mp4", 556)]);
  assert.deepEqual(EL.newTakes(before, takes, "look").map((t) => t.url), [V("rip.mp4"), V("a_v2.mp4", 556), V("new_look.png")]);
  assert.equal(EL.newTakes(before, takes, "clay").length, 3);
  assert.deepEqual(EL.newTakes(before, [], "final"), []);
});

test("the Cut's menu goes through the pop-over layer, keeps the class the sweep opens, and pulls in nothing from the App", () => {
  const src = (f) => readFileSync(new URL(`../../web/cut/${f}`, import.meta.url), "utf8");
  assert.match(src("editlink.mjs"), /from "\.\.\/ui\/popover\.mjs"/);
  assert.match(src("editlink.mjs"), /ss-cut-ctx ss-editmenu/);
  assert.doesNotMatch(src("editlink.mjs"), /from "\.\.\/(pipeline|motion|oneclick|dailies|takecheck|performance)\//);
  assert.match(src("cut.mjs"), /openPopover\(/);
});

// ------------------------------------------------------------------------------------------------ the App side

const APP = await import("../../web/cut/editlink_app.mjs");

test("flattenCut's per-clip file honours the pin (Cut → one video joins the pinned file; a clay pin is a slate)", () => {
  const BEST = ["final_sound", "final_audio", "final", "draft", "previz", "look"];
  const r = { final: { filename: "a_v2.mp4", subfolder: "soundstage", type: "output" }, look: { filename: "a.png", subfolder: "", type: "output" } };
  assert.deepEqual(APP.flattenClip({ shot_id: "a", in: 0, out: 10 }, r, BEST), { file: r.final, kind: "final" });
  assert.deepEqual(APP.flattenClip({ shot_id: "a", take: { url: A1, rung: "final", version: 1 } }, r, BEST),
    { file: { filename: "a_v1.mp4", subfolder: "soundstage", type: "output" }, kind: "final" });
  assert.deepEqual(APP.flattenClip({ shot_id: "a", take: { url: "", rung: "clay" } }, r, BEST), { file: null, kind: "clay" });
  assert.deepEqual(APP.flattenClip({ shot_id: "a" }, {}, BEST), { file: null, kind: null });
});

test("the link resolver: step, frame, recipe and a plain sentence for each missing link, per clip type", () => {
  const rip = { id: "ripple_1", kind: "draft", url: V("b_rip.mp4", 3), file: { filename: "b_rip.mp4" }, created: 5, label: "Ripple", ripple: true,
    strength: 1.2, source: "soundstage/b.mp4 [output]", edited: "soundstage_private/b_f1.png [input]", prompt: "red jacket" };
  const oc = { id: "oneclick_x", kind: "look", url: V("b_oc.png"), oneclick: { id: "night", label: "Night", from: "soundstage/b.png [output]" } };
  const p = TL.normalizeProject({ fps: 24, shots: [...shots(), { id: "l", name: "L", frames: 97, renders: { look: V("l.png") } }],
    cut: [{ shot_id: "a", in: 0, out: 10 }, { shot_id: "l", in: 0, out: 10 }, { shot_id: "c", in: 0, out: 10 },
      { shot_id: "b", in: 0, out: 10, take: { url: V("b_rip.mp4"), rung: "draft", kind: "ripple" } },
      { shot_id: "b", in: 0, out: 10, take: { url: V("b_gone.mp4"), rung: "draft", kind: "ripple" } },
      { shot_id: "b", in: 0, out: 10, take: { url: V("b_oc.png"), rung: "look", kind: "oneclick" } }, { shot_id: "f", in: 0, out: 10 }] });
  const chosen = { url: V("a_frame.png"), seed: 42, model: "FLUX 3 Klein", takes: [rip, oc] };
  const R = (i, ch = chosen) => APP.resolveLink(EL.clipContext(p, i), { chosen: ch, renders: {}, candidates: [] });
  const fin = R(0);
  assert.deepEqual([fin.step, fin.recipe.state, fin.frame.url, fin.frame.exact], [{ app: "motion", rung: 4, via: "app" }, "unread", V("a_frame.png"), false]);
  assert.deepEqual(fin.missing, []);
  const look = R(1, { url: V("l.png"), seed: 9, model: "Krea" });
  assert.deepEqual([look.step.app, look.frame.url, look.frame.exact, look.recipe.seed], ["frame", V("l.png"), true, 9]);
  assert.deepEqual(look.missing, [APP.MISSING.look]);
  const clay = R(2, null);
  assert.deepEqual([clay.step.app, clay.frame], ["set", null]);
  assert.deepEqual(clay.missing, [APP.MISSING.frame, APP.MISSING.clay]);
  const r = R(3);
  assert.deepEqual([r.type, r.step, r.record?.id, r.frame.ref, r.recipe.strength], ["take", { app: "motion", rung: 3, via: "ripple" }, "ripple_1", rip.edited, 1.2]);
  assert.deepEqual(r.missing, [APP.MISSING.outside]);
  assert.deepEqual(R(4).missing, [APP.MISSING.record], "the take's record fell off the 40 kept");
  const o = R(5);
  assert.deepEqual([o.step.via, o.frame.ref, o.recipe.card], ["oneclick", "soundstage/b.png [output]", "night"]);
  assert.deepEqual(o.missing, [APP.MISSING.oneclick]);
  assert.deepEqual(R(6).missing, [APP.MISSING.footage]);
});

test("settingsFromPrompt reads the Quality node's advanced JSON (seed, Adherence), the engine and the still from ComfyUI's prompt tag", () => {
  const prompt = {
    "9096": { class_type: "SoundstageQuality", inputs: { motion_freedom: 0, quality: "Final", advanced: '{"preset":"Final","seed":1234,"adherence":"Balanced","steps_1":14}' } },
    "9084": { class_type: "ComfySwitchNode", inputs: { switch: true }, _meta: { title: "Video model · use picker (off = Soundstage LTX-2.5 L2R)" } },
    "9083": { class_type: "SoundstageGenerateVideo", inputs: { model: "MiniMax H3 · local", seed: 1 } },
    "9082": { class_type: "ComfySwitchNode", inputs: { switch: true } },
    "9081": { class_type: "SoundstageEditImage", inputs: { model: "FLUX 3 Klein · local", seed: 77 } },
    "9086": { class_type: "ComfySwitchNode", inputs: { switch: false } },
    "5516:1": { class_type: "RandomNoise", inputs: { noise_seed: ["9096", 11] } },
  };
  assert.deepEqual(APP.settingsFromPrompt(prompt), { settings: { preset: "Final", seed: 1234, adherence: "Balanced", steps_1: 14 },
    engine: "MiniMax H3 · local", still: { model: "FLUX 3 Klein · local", seed: 77, touchup: false } });
  const krea = { "9096": { class_type: "SoundstageQuality", inputs: { quality: "Draft", advanced: "not json" } }, "9084": { inputs: { switch: false } },
    "9082": { inputs: { switch: false } }, "9056": { class_type: "KSampler", inputs: { seed: 5 } } };
  assert.deepEqual(APP.settingsFromPrompt(krea), { settings: { preset: "Draft" }, engine: "l2r", still: { model: "__krea_depth__", seed: 5, touchup: false } });
  assert.equal(APP.settingsFromPrompt(null), null);
  assert.deepEqual(APP.settingsFromPrompt({ "1": { class_type: "SaveVideo", inputs: {} } }), { settings: null, engine: null, still: null });
});

test("takesOfShot lists what the Takes bin lists, so a trip's before / landed keys agree with it", () => {
  const app = { renders: { final: V("a_v2.mp4", 3), final_sound: V("a_v2.mp4", 3), look: V("a.png") },
    chosen: { url: V("a.png"), takes: [{ url: V("rip.mp4"), kind: "final", ripple: true, created: 7, label: "Ripple" }, { url: V("oc.png"), kind: "look", oneclick: { id: "x" } }] },
    candidates: [{ url: V("cand.png"), seed: 3 }] };
  const list = APP.takesOfShot(app);
  assert.deepEqual(list.map((t) => [t.rung, t.kind, t.video]).slice(-3), [["look", "frame", false], ["final", "ripple", true], ["look", "oneclick", false]]);
  assert.deepEqual([...APP.beforeKeys(app)].sort(), ["output:soundstage/a.png", "output:soundstage/a_v2.mp4", "output:soundstage/cand.png", "output:soundstage/oc.png", "output:soundstage/rip.mp4"]);
});
