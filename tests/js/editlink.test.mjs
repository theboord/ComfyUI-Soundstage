// Edit from the timeline (Directive 9, docs/cut.md): clips pinned to a take (normalize, layout, every exporter), the
// link a clip carries (web/cut/editlink.mjs), the Edit in… items, the hold, Replace in cut as one Undo, and new takes.
// node --test tests/js/editlink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

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
