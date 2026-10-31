// node --test tests/js/   (⑤ Motion's Follow modes: Ripple edit helpers, and Ripple takes in the Takes bin)
import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLLOW_MODES, RIPPLE_STRENGTH, PRIVATE_DIR, refFromViewUrl, refOf, viewQuery, rippleSources, buildRipplePrompt, makeTake,
  addTake, strengthLabel,
} from "../../web/motion/ripple.mjs";
import { takesFor } from "../../web/dailies/model.mjs";

test("follow modes: layout is first (the default), pose and ripple offered", () => {
  assert.deepEqual(FOLLOW_MODES.map((m) => m[0]), ["layout", "pose", "ripple"]);
  assert.equal(RIPPLE_STRENGTH, 1.35);
});

test("view URLs and file references round-trip", () => {
  assert.equal(refFromViewUrl("/api/view?filename=draft_00012_.mp4&subfolder=soundstage&type=output&t=1"), "soundstage/draft_00012_.mp4 [output]");
  assert.equal(refFromViewUrl("http://h/view?filename=a.png&type=input"), "a.png [input]");
  assert.equal(refFromViewUrl("blob:abc"), "");
  assert.equal(refOf({ filename: "r.mp4", subfolder: "soundstage_private", type: "output" }), "soundstage_private/r.mp4 [output]");
  assert.equal(refOf("clip.mov"), "clip.mov [input]");
  assert.equal(refOf("x/clip.mov [temp]"), "x/clip.mov [temp]");
  const q = new URLSearchParams(viewQuery("soundstage_private/a b.png [input]"));
  assert.deepEqual([q.get("filename"), q.get("subfolder"), q.get("type")], ["a b.png", "soundstage_private", "input"]);
  assert.equal(new URLSearchParams(viewQuery("plain.mp4")).get("type"), "input");
});

test("ripple sources: imported clip, final, draft, rebuilt-from clip, earlier ripple takes", () => {
  const v = (f, sub = "soundstage") => `/api/view?filename=${f}&subfolder=${sub}&type=output`;
  const list = rippleSources({
    renders: { draft: v("draft_1.mp4"), final_sound: v("final_2.mp4") },
    scene: { reference: { video: "pexels_run.mp4" } },
    chosen: { ripple: { clip: { ref: "soundstage_private/me.mov [input]", url: "/u", name: "me.mov" } },
      takes: [{ id: "ripple_a", ripple: true, file: { filename: "ripple_00001_.mp4", subfolder: PRIVATE_DIR, type: "output" }, url: "/r1" },
        { id: "pose_b", pose: true, file: { filename: "p.mp4" }, url: "/p" }] },
  });
  assert.deepEqual(list.map((s) => s.key), ["import", "final", "draft", "reference", "take_ripple_a"]);
  assert.equal(list[1].ref, "soundstage/final_2.mp4 [output]");
  assert.equal(list[3].ref, "pexels_run.mp4 [input]");
  assert.equal(list[4].ref, "soundstage_private/ripple_00001_.mp4 [output]");
  assert.deepEqual(rippleSources({}), []);
});

test("the ripple prompt: SoundstageRipple into SaveVideo, in the private folder", () => {
  const p = buildRipplePrompt({ source: "s.mp4 [input]", edited: "e.png [input]", strength: 1.6, quality: "Final", seed: 12.7 });
  assert.equal(p[1].class_type, "SoundstageRipple");
  assert.deepEqual([p[1].inputs.edit_strength, p[1].inputs.quality, p[1].inputs.seed, p[1].inputs.keep_audio], [1.6, "Final", 12, true]);
  assert.equal(p[2].class_type, "SaveVideo");
  assert.deepEqual(p[2].inputs.video, ["1", 0]);
  assert.ok(p[2].inputs.filename_prefix.startsWith(`${PRIVATE_DIR}/`));
  assert.equal(buildRipplePrompt({ source: "s", edited: "e", quality: "whatever" })[1].inputs.quality, "Draft");
  assert.throws(() => buildRipplePrompt({ source: "", edited: "e" }), /clip/);
  assert.throws(() => buildRipplePrompt({ source: "s", edited: "" }), /frame 1/);
});

test("a ripple take lands in the Takes bin, labelled, after the shot's own renders", () => {
  const file = { filename: "ripple_00003_.mp4", subfolder: PRIVATE_DIR, type: "output" };
  const t = makeTake({ file, url: "/api/view?filename=ripple_00003_.mp4&subfolder=soundstage_private&type=output", quality: "Draft",
    strength: 1.35, source: "s [input]", edited: "e [input]", now: 1000 });
  assert.deepEqual([t.kind, t.label, t.ripple, t.created], ["draft", "Ripple", true, 1000]);
  assert.equal(makeTake({ file, url: "/x.mp4", quality: "Final", follow: "pose" }).label, "Pose");
  const chosen = addTake({ url: "/api/view?filename=look.png&type=output" }, t);
  const takes = takesFor({ id: "s1" }, { draft: "/api/view?filename=d.mp4&type=output", chosen });
  const last = takes[takes.length - 1];
  assert.equal(last.label, "Ripple");
  assert.equal(last.kind, "draft");
  assert.equal(last.video, true);
  assert.ok(takes.some((x) => x.id === "draft"));
  assert.equal(addTake(null, t).takes.length, 1);
});

test("strength label", () => {
  assert.match(strengthLabel(1.35), /recommended/);
  assert.match(strengthLabel(1.8), /harder/);
  assert.match(strengthLabel(1), /gentler/);
});
