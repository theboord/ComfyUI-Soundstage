// Source fidelity in the browser (docs/source_fidelity.md): the source line, camera RAW detection, and the Cut
// exports pointing at the camera original. The byte-for-byte Python twin is tests/test_source_fidelity.py.
import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_ACCEPT, cameraRaw, sourceLine } from "../../web/ui/sourcespec.mjs";
import { normalizeProject } from "../../web/cut/timeline.mjs";
import { mediaFor, relinkNote, toEDL, toOTIO } from "../../web/cut/exporters.mjs";

const PLATE = { path: "/in/A001C003_plate.mov", reel: "A001C003", tc_start: "01:02:03:04", fps: 23.976, width: 3840, height: 2160,
  frames: 240, colour: "Rec.709", codec_label: "ProRes 4444", bit_depth: 10 };

test("source line and camera RAW", () => {
  assert.equal(sourceLine(PLATE), "Source: 3840×2160 · 23.976 · ProRes 4444 · Rec.709 · 10-bit · TC 01:02:03:04");
  assert.equal(sourceLine({ ...PLATE, line: "Source: from the server" }), "Source: from the server");
  assert.match(sourceLine({ ...PLATE, proxy: true }), /Working from a proxy; your export relinks to the camera original\.$/);
  assert.equal(cameraRaw("A001_C002_0101XY.R3D"), "RED R3D");
  assert.equal(cameraRaw("clip.mov"), null);
  assert.ok(VIDEO_ACCEPT.includes(".r3d") && VIDEO_ACCEPT.includes(".braw"));
});

test("a cut with imported footage delivers at its spec and links the camera original", () => {
  const project = { name: "t", fps: 24, width: 1280, height: 704,
    shots: [{ id: "a", name: "Plate", frames: 48, renders: {}, source: PLATE },
            { id: "b", name: "Gen", frames: 24, renders: { final: "b.mp4" }, source: PLATE }],
    cut: [{ shot_id: "a", in: 0, out: 24 }, { shot_id: "b", in: 0, out: 24 }] };
  const p = normalizeProject(project);
  assert.deepEqual([p.width, p.height, p.fps], [3840, 2160, 23.976]);
  assert.equal(normalizeProject({ ...project, match_source: false }).width, 1280);
  const m = mediaFor(p.shots[0]);
  assert.equal(m.rung, "source");
  assert.equal(m.path, "/in/A001C003_plate.mov");
  assert.equal(relinkNote(m), "SOURCE plate stand-in: relink to the Final render");
  assert.equal(relinkNote(mediaFor({ ...p.shots[0], source: { ...p.shots[0].source, use: "original" } })), "");
  const ev = toEDL(project).split("\n").find((l) => l.startsWith("001"));
  assert.match(ev, /^001 {2}A001C003 V +C +01:02:03:04 01:02:04:04 01:00:00:00 01:00:01:00$/);
  const clip = toOTIO(project).tracks.children[0].children[1];
  assert.equal(clip.metadata.soundstage.source.reel, "A001C003");   // a generated shot names its plate
  assert.equal(mediaFor(p.shots[1]).rung, "final");
});
