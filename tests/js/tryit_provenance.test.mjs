// node --test tests/js/tryit_provenance.test.mjs
// The try-it demo's Live / Replayed badge (tools/tryit/shell/provenance.mjs): every replayed item the demo ships (a
// scene's recorded renders and ④ Frame candidates, every tour clip, the first screen's wipe, the recorded Video → 3D
// run) is labelled Replayed and names its file; the live stage and panels are labelled Live. Also checks that the
// shell draws the badges from these rules, so a new scene, clip or stop is labelled without touching the page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LIVE, REPLAYED, RENDER_STEPS, REPLAY_ACTIONS, LIVE_ACTIONS, VIEWS, LIVE_NOTE, provenanceNow, sceneReplays, shotReplays,
  sceneTakes, stopProvenance, clipProvenance, v2sNote } from "../../tools/tryit/shell/provenance.mjs";

const TRYIT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "tryit");
const read = (...p) => readFileSync(join(TRYIT, ...p), "utf8");
const scenes = readdirSync(join(TRYIT, "scenes")).filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(read("scenes", f))]);
const tour = JSON.parse(read("shell", "tour.json"));
// The shape the shell hands provenanceNow (demo.mjs: demo.scene = { renders: props.ss_renders, candidates }).
const asDemo = (s) => ({ renders: s.props?.ss_renders || {}, candidates: s.candidates || {}, cut: s.cut, advisor: s.advisor, compile: s.compile });
const NON_RENDER_STEPS = ["script", "cast", "set"];

test("there are scenes with recorded renders and scenes without", () => {
  assert.ok(scenes.length >= 20, `${scenes.length} scenes`);
  assert.ok(scenes.some(([, s]) => sceneReplays(s).length), "some scenes replay renders");
  assert.ok(scenes.some(([, s]) => !sceneReplays(s).length), "some scenes are stage only");
});

for (const [key, s] of scenes) {
  test(`scene ${key}: every recorded render is Replayed on the steps that show it, the stage is Live`, () => {
    const scene = asDemo(s);
    let staged = [];   // the stage's own shots (the widget value is a JSON string), rendered or not
    try { staged = (typeof s.scene === "string" ? JSON.parse(s.scene) : s.scene)?.shots || []; } catch { /* no stage */ }
    const shots = new Set([...Object.keys(scene.renders), ...Object.keys(scene.candidates), ...staged.map((x) => x.id)]);
    assert.ok(shots.size || key === "blank", `${key}: has shots to check`);
    for (const shot of shots) {
      const files = shotReplays(scene, shot);
      for (const step of Object.keys(RENDER_STEPS)) {
        const p = provenanceNow({ step, shot, scene });
        if (step === "deliver" && !files.length && scene.cut) {
          // ⑦ Deliver's Cut → one video returns the scene's recorded cut even for a shot with no render of its own.
          assert.equal(p.mode, REPLAYED, `${key}/${shot} on deliver: the joined cut is recorded`);
          assert.ok(p.note.includes(scene.cut), `${key}/${shot} on deliver: the note names the cut`);
        } else if (files.length) {
          assert.equal(p.mode, REPLAYED, `${key}/${shot} on ${step}`);
          assert.ok(files.some((f) => p.note.includes(f)), `${key}/${shot} on ${step}: the note names a recorded file: ${p.note}`);
        } else {
          assert.equal(p.mode, LIVE, `${key}/${shot} on ${step}: nothing recorded, nothing to call replayed`);
        }
      }
      for (const step of NON_RENDER_STEPS) assert.equal(provenanceNow({ step, shot, scene }).mode, LIVE, `${key}/${shot} on ${step}`);
      // The non-step tabs follow the screen, whatever step the bar was last on.
      for (const step of ["set", "frame"]) {
        assert.equal(provenanceNow({ step, view: "advisor", shot, scene }).mode, scene.advisor ? REPLAYED : LIVE, `${key}: Shot ideas from ${step}`);
        assert.equal(provenanceNow({ step, view: "look", shot, scene }).mode, scene.compile ? REPLAYED : LIVE, `${key}: Look from ${step}`);
        assert.equal(provenanceNow({ step, view: "dailies", shot, scene }).mode, sceneTakes(scene).length ? REPLAYED : LIVE, `${key}: Takes from ${step}`);
        assert.equal(provenanceNow({ step, view: "cut", shot, scene }).mode, sceneTakes(scene).length || scene.cut ? REPLAYED : LIVE, `${key}: Timeline from ${step}`);
      }
    }
    // Every file the scene ships is one a badge covers: a shot's renders and candidates on its steps, the cut on ⑦ Deliver and the Timeline.
    for (const { shot, file } of sceneReplays(s)) {
      if (shot) assert.ok(shotReplays(scene, shot).includes(file), `${key}: ${file}`);
      else {
        const any = [...shots][0] ?? "";
        assert.ok(provenanceNow({ step: "deliver", shot: any, scene }).note.includes(file), `${key}: the cut ${file} on ⑦ Deliver`);
        assert.ok(provenanceNow({ step: "set", view: "cut", shot: any, scene }).note.includes(file), `${key}: the cut ${file} on the Timeline`);
      }
    }
  });
}

test("a shot with renders is Replayed on ④ ⑤ ⑥ even when they are only ④ Frame candidates", () => {
  const scene = { renders: {}, candidates: { a: [{ filename: "cand_1.jpg" }] } };
  assert.equal(provenanceNow({ step: "frame", shot: "a", scene }).mode, REPLAYED);
  assert.equal(provenanceNow({ step: "frame", shot: "b", scene }).mode, LIVE);
  assert.equal(provenanceNow({ step: "set", shot: "a", scene }).mode, LIVE);
  assert.equal(provenanceNow({}).mode, LIVE, "no stage yet: the page itself is live");
});

test("⑦ Deliver: a shot with a draft or a final is Replayed, and so is the joined cut", () => {
  const scene = { renders: { s1: { draft: { filename: "draft_1.mp4" }, final: { filename: "final_1.mp4" } }, s2: { draft: "draft_2.mp4" } },
    candidates: {}, cut: "cut_x.mp4" };
  for (const shot of ["s1", "s2"]) {
    const p = provenanceNow({ step: "deliver", shot, scene });
    assert.equal(p.mode, REPLAYED, shot);
    assert.match(p.note, /⑦ Deliver/);
    assert.match(p.note, /cut_x\.mp4/, "the note names the joined cut");
  }
  assert.match(provenanceNow({ step: "deliver", shot: "s1", scene }).note, /final_1\.mp4/, "the final Deliver plays comes first");
  assert.equal(provenanceNow({ step: "deliver", shot: "s3", scene }).mode, REPLAYED, "no render of its own, but Cut → one video returns the recorded cut");
  assert.equal(provenanceNow({ step: "deliver", shot: "s3", scene: { ...scene, cut: undefined } }).mode, LIVE, "nothing recorded at all");
  assert.equal(provenanceNow({ step: "set", shot: "s1", scene }).mode, LIVE, "the stage is live");
});

test("the non-step tabs follow the screen, not the last step: Shot ideas, Look, Takes, the Timeline, Paint Studio", () => {
  const scene = { renders: { a: { look: "look_a.png", draft: "draft_a.mp4" } }, candidates: { a: ["cand_a.jpg"] }, cut: "cut_a.mp4",
    advisor: { shots: [] }, compile: { still_prompt: "x" } };
  const bare = { renders: {}, candidates: {} };
  assert.deepEqual(Object.keys(VIEWS).sort(), ["advisor", "canvas", "cut", "dailies", "look"]);
  for (const step of ["set", "frame", "deliver", "script"]) {
    assert.equal(provenanceNow({ step, view: "advisor", shot: "a", scene }).mode, REPLAYED, `Shot ideas from ${step}`);
    assert.match(provenanceNow({ step, view: "advisor", shot: "a", scene }).note, /computed earlier on the server/);
    assert.equal(provenanceNow({ step, view: "look", shot: "a", scene }).mode, REPLAYED, `Look from ${step}`);
    assert.match(provenanceNow({ step, view: "look", shot: "a", scene }).note, /do not change when you edit the Look/);
    assert.equal(provenanceNow({ step, view: "dailies", shot: "a", scene }).mode, REPLAYED, `Takes from ${step}`);
    assert.match(provenanceNow({ step, view: "dailies", shot: "a", scene }).note, /draft_a\.mp4/);
    const cut = provenanceNow({ step, view: "cut", shot: "a", scene });
    assert.equal(cut.mode, REPLAYED, `Timeline from ${step}`);
    assert.match(cut.note, /draft_a\.mp4/); assert.match(cut.note, /cut_a\.mp4/); assert.match(cut.note, /Trimming and ordering them is live/);
    for (const view of ["advisor", "look", "dailies", "cut", "canvas"]) assert.equal(provenanceNow({ step, view, shot: "a", scene: bare }).mode, LIVE, `${view} with nothing recorded`);
  }
  // Paint Studio holds a recorded frame only when it was opened from ④ Frame (the step bar stays there).
  assert.equal(provenanceNow({ step: "frame", view: "canvas", shot: "a", scene }).mode, REPLAYED);
  assert.match(provenanceNow({ step: "frame", view: "canvas", shot: "a", scene }).note, /look_a\.png/);
  assert.equal(provenanceNow({ step: "set", view: "canvas", shot: "a", scene }).mode, LIVE);
  // A step view with no tab on top: the step decides, the same from any history.
  assert.equal(provenanceNow({ step: "set", view: "", shot: "a", scene }).mode, LIVE);
  assert.doesNotMatch(LIVE_NOTE, /every panel/, "the Live note no longer claims every panel");
});

test("after the recorded Video → 3D run has played back, the Live note says the set came from it", () => {
  const rec = { clip: "jturn_night_street.mp4", total_s: 3660, replaySeconds: 9, running: false, doneAt: 1, after: true };
  const p = provenanceNow({ step: "set", shot: "x", scene: {}, v2s: rec });
  assert.equal(p.mode, LIVE, "the stage is live again once the bar is closed");
  assert.match(p.note, /rebuilt by the recorded Video → 3D run of jturn_night_street\.mp4/);
  assert.equal(provenanceNow({ step: "set", shot: "x", scene: {}, v2s: { ...rec, after: false } }).mode, REPLAYED, "while it plays back or its bar is up");
});

test("the Video → 3D replay is Replayed and names the clip and the real run time", () => {
  const rec = { clip: "jturn_night_street.mp4", total_s: 3660, replaySeconds: 9, running: true };
  const p = provenanceNow({ step: "set", shot: "jturn", scene: {}, v2s: rec });
  assert.equal(p.mode, REPLAYED);
  assert.match(p.note, /jturn_night_street\.mp4/);
  assert.match(p.note, /61 min/);
  assert.match(p.note, /wall time/, "the 61 min is wall time (most of it queue wait), not GPU time");
  assert.doesNotMatch(p.note, /on the pod's GPU/);
  assert.match(p.note, /9 s/);
  assert.match(v2sNote({}), /the demo clip/);
});

test("every tour clip, and the first screen's wipe, is Replayed with its own note", () => {
  const clips = tour.steps.flatMap((s) => s.clips || []);
  assert.ok(clips.length >= 10, `${clips.length} clips`);
  for (const c of clips) {
    const p = clipProvenance(c);
    assert.equal(p.mode, REPLAYED, c.file);
    assert.ok(p.note.includes(c.file), `${c.file}: the note names the file`);
    if (c.note) assert.ok(p.note.includes(c.note), `${c.file}: the note carries the clip's own note`);
  }
  const demo = read("shell", "demo.mjs");
  const hero = /const HERO_FILE = "([^"]+)"/.exec(demo)?.[1];
  assert.ok(hero && clips.some((c) => c.file === hero), `the first screen plays ${hero}, a tour clip with a note`);
});

test("every tour stop is labelled, and every demo action is classified as live or replayed", () => {
  const demo = read("shell", "demo.mjs");
  const block = demo.slice(demo.indexOf("const ACTIONS = {"), demo.indexOf("/** Play from the current frame"));
  const actions = [...block.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
  assert.ok(actions.length > 20, `${actions.length} actions in demo.mjs`);
  const known = new Set([...Object.keys(REPLAY_ACTIONS), ...LIVE_ACTIONS]);
  for (const a of actions) assert.ok(known.has(a), `demo.mjs action "${a}" is not classified in provenance.mjs (REPLAY_ACTIONS or LIVE_ACTIONS)`);
  for (const a of LIVE_ACTIONS) assert.ok(!(a in REPLAY_ACTIONS), `${a} is in both lists`);
  for (const s of tour.steps) {
    const p = stopProvenance(s);
    assert.equal(p.mode, s.do in REPLAY_ACTIONS ? REPLAYED : LIVE, `stop ${s.id} (${s.do})`);
    assert.ok(p.note.length > 20, `stop ${s.id}: has a note`);
  }
  assert.equal(stopProvenance(tour.steps.find((s) => s.id === "v2s")).mode, REPLAYED, "the Video → 3D stop replays the recorded run");
  assert.equal(stopProvenance(tour.steps.find((s) => s.id === "drive")).mode, LIVE, "Drive mode runs in the browser");
});

test("the shell draws the badges from these rules (bar, tour stops, Watch clips, clip dialog, first screen)", () => {
  const html = read("shell", "index.html"), demo = read("shell", "demo.mjs"), api = read("shell", "scripts", "api.js");
  assert.match(html, /id="prov"[^>]*class="prov live"/, "the bar badge");
  assert.match(html, /id="clipProv"/, "the clip dialog badge");
  assert.match(html, /id="heroProv"[^>]*>[^<]*Replayed/, "the first screen badge");
  assert.match(html, /\.prov\.replayed/, "badge styles");
  assert.match(html, /\.bar \.prov \.long \{ display: none; \}|\.bar \.prov \.long\b/, "the bar badge shortens at phone width");
  assert.match(demo, /from "\.\/provenance\.mjs"/);
  for (const use of ["provenanceNow(", "stopProvenance(s)", "clipProvenance(c)", "setProv($(\"clipProv\")", "setProv($(\"heroProv\")", "setInterval(drawProv"])
    assert.ok(demo.includes(use), `demo.mjs uses ${use}`);
  assert.match(api, /demo\.v2s = \{ clip: rec\.clip/, "api.js reports the Video → 3D replay");
  assert.match(api, /min wall time on the pod, most of it queue wait/, "the Video → 3D toast says wall time, not GPU time");
  assert.doesNotMatch(api, /on the pod's GPU/);
  assert.match(api, /Replayed: this scene's cut as joined earlier/, "the joined cut says Replayed");
  for (const cls of ["ss-advmode", "ss-dailiesmode", "ss-cutmode", "ss-canvasmode", ".ss-lookview"])
    assert.ok(demo.includes(cls), `demo.mjs reads ${cls} to know which tab is up`);
  assert.match(demo, /provenanceNow\(\{ step, view, shot/, "the bar badge passes the visible tab");
  assert.doesNotMatch(html, /class="pill"/, "the old fixed pill is gone");
});
