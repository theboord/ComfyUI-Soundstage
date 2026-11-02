// node --test tests/js/   (✦ One-click: the registry contract, targets, takes, and the graphs each card queues)
import test from "node:test";
import assert from "node:assert/strict";

import * as O from "../../web/oneclick/oneclick.mjs";
import * as E from "../../web/oneclick/effects.mjs";
import * as L from "../../web/oneclick/light.mjs";
import * as A from "../../web/oneclick/angle.mjs";
import * as X from "../../web/oneclick/expand.mjs";
import { takesFor } from "../../web/dailies/model.mjs";

const still = O.makeTarget({ url: "/api/view?filename=look_00004_.png&subfolder=soundstage&type=output", shot: "shot_2", label: "Dana · frame",
  from: "frame", stage: true, width: 1920, height: 1080 });
const clip = O.makeTarget({ url: "/api/view?filename=final_00028_.mp4&subfolder=soundstage&type=output", shot: "shot_2", take_kind: "final", label: "Dana · Tk 3" });

const MODELS = O.modelsFromObjectInfo({
  SoundstageEditImage: { input: { required: { model: ["COMFY_DYNAMICCOMBO_V3", { options: [
    { key: "Krea 2 Turbo · local [<$1M]", inputs: { required: { denoise: ["FLOAT", { default: 0.85 }] } } },
    { key: "FLUX 3 Klein · local [<$5M]", inputs: {} }] }] } } },
  SoundstageFill: { input: { required: { model: ["X", { options: [{ key: "FLUX 3 Klein · local [<$5M]", inputs: {} }] }] } } },
  SoundstageMatte: { input: { required: { model: ["X", { options: [{ key: "SAM 3.1 (text-prompted) · local", inputs: { required: { threshold: ["FLOAT", { default: 0.5 }] } } },
    { key: "BiRefNet (core RemoveBackground) · local", inputs: {} }, { key: "LTX-2.5 Alpha-Gen (soft video matte) · local [<$10M]", inputs: {} }] }] } } },
  SoundstageCleanPlate: { input: { required: { model: ["X", { options: [{ key: "LTX-2.5 Clean-Plate IC-LoRA · local [<$10M]", inputs: {} }] }] } } },
  SoundstageGenerateVideo: { input: { required: { model: ["X", { options: [{ key: "LTX-2.5 22B distilled · local [<$10M]", inputs: { required: { mode: [["auto", "image/text → video"], {}] } } }] }] } } },
  SoundstageRipple: {}, VHS_VideoCombine: {},
});

/** A ctx that records what a card queues and answers each wait with a fake output file. */
function fakeCtx(target, opts = {}) {
  const queued = [];
  let n = 0;
  return {
    queued, opts, models: MODELS, stage: null, pipeline: null, api: { fetchApi: async () => ({ json: async () => ({}) }) },
    quality: () => "Draft", seed: () => 42, prefix: (s = "") => O.outPrefix(target, `x${s ? "_" + s : ""}`), progress() {}, say() {}, toast() {},
    async queue(p) { queued.push(p); return `pid${++n}`; },
    async wait(pid, outId) { const p = queued[+pid.slice(3) - 1]; assert.ok(p[outId], `waits on a node the prompt has (${outId})`); return { filename: `r${pid}.${/Video|Ripple/.test(JSON.stringify(p)) && outId !== "9" ? "mp4" : "png"}`, subfolder: "soundstage_private/oneclick", type: "output" }; },
    async upload() { return "soundstage_private/oneclick/pass.png [input]"; },
  };
}

test("the registry contract: validate, replace by id, groups in order, reasons instead of hiding", () => {
  assert.throws(() => O.registerOneClick({ id: "x", group: "Nope", label: "x", applies: ["still"], run() {} }), /group/);
  assert.throws(() => O.registerOneClick({ id: "x y", group: "Loop", label: "x", applies: ["still"], run() {} }), /id/);
  assert.throws(() => O.registerOneClick({ id: "x", group: "Loop", label: "x", applies: [], run() {} }), /applies/);
  const s = O.registerOneClick({ id: "t_loop", group: "Loop", label: "Loop it", applies: ["clip"], gpu: true, minutes: 3, available: () => "needs a clip with motion", run: async () => null });
  assert.equal(O.getOneClick("t_loop"), s);
  O.registerOneClick({ ...s, available: () => true });
  assert.equal(O.oneClicks().filter((x) => x.id === "t_loop").length, 1);
  const groups = O.oneClicksFor(still).map((g) => g.group);
  assert.deepEqual(groups, O.GROUPS.map((g) => g[0]).filter((g) => groups.includes(g)));
  const loop = O.oneClicksFor(still).find((g) => g.group === "Loop").items[0];
  assert.equal(loop.ok, false); assert.match(loop.why, /clips/);
  assert.equal(O.availability(O.getOneClick("t_loop"), clip), true);
  O.unregisterOneClick("t_loop");
});

test("every card is listed for a still and for a clip; the ones that apply come first", () => {
  for (const t of [still, clip]) {
    const g = O.oneClicksFor(t);
    const all = g.flatMap((x) => x.items);
    assert.equal(all.length, O.oneClicks().length);
    for (const grp of g) { const firstNo = grp.items.findIndex((i) => !i.ok); if (firstNo >= 0) assert.ok(grp.items.slice(firstNo).every((i) => !i.ok)); }
  }
  assert.ok(O.oneClicks().length >= 50);
  const ok = (t, id) => O.availability(O.getOneClick(id), t);
  assert.equal(ok(clip, "nightfall"), true);
  assert.equal(ok(clip, "relight_rembrandt"), true);
  assert.match(ok(clip, "living_photo"), /stills/);
  assert.match(ok(clip, "expand_clip"), /needs one test/);
  assert.match(ok(O.makeTarget({ url: still.url, shot: "shot_2" }), "exact_orbit_left"), /stage/);
});

test("costs and the ask are honest: jobs and minutes per kind, $0 for local models", () => {
  const n = O.getOneClick("nightfall");
  assert.equal(O.costLabel(n, still), "$0 · about 1 min on your GPU");
  assert.equal(O.costLabel(n, clip), "$0 · about 4 min on your GPU · 2 jobs");
  assert.match(O.askText(n, clip), /2 jobs on your GPU/);
  assert.equal(O.costLabel({ gpu: false }), "$0 · no GPU");
});

test("targets: stills vs clips from view URLs, private output prefixes", () => {
  assert.equal(still.kind, "still"); assert.equal(still.ref, "soundstage/look_00004_.png [output]");
  assert.equal(clip.kind, "clip"); assert.equal(clip.thumb, "");
  assert.equal(O.makeTarget({}), null);
  assert.equal(O.outPrefix(still, "relight_split"), "soundstage_private/oneclick/shot_2_relight_split");
  assert.equal(O.outPrefix({ shot: "a/../b" }, "x"), "soundstage_private/oneclick/a_b_x");
});

test("a result lands as a take the Takes bin reads (still -> frame take, clip -> draft or final)", () => {
  const spec = O.getOneClick("nightfall");
  const t1 = O.makeOneClickTake({ file: { filename: "n.png", subfolder: "soundstage_private/oneclick", type: "output" }, url: "/view?filename=n.png", spec, target: still, now: 1000 });
  const t2 = O.makeOneClickTake({ file: { filename: "n.mp4", subfolder: "soundstage_private/oneclick", type: "output" }, url: "/view?filename=n.mp4", spec, target: clip, now: 2000 });
  assert.equal(t1.kind, "look"); assert.equal(t2.kind, "final"); assert.equal(t2.video, true);
  assert.equal(t1.oneclick.id, "nightfall"); assert.equal(t1.label, "✦ Nightfall");
  const chosen = O.addTake(O.addTake({}, t1), t2);
  const takes = takesFor({ id: "shot_2" }, { chosen: { ...chosen, url: "/view?filename=chosen.png" } });
  assert.deepEqual(takes.filter((t) => t.oneclick).map((t) => [t.kind, t.video]), [["look", false], ["final", true]]);
  assert.equal(O.pickTake(takes, 2)?.n, 2);
  assert.equal(O.pickTake(takes).kind, "look");   // the circled (the chosen frame) wins
});

test("still effects queue one Klein edit of the picture with our physical prompt, keeping the frame", async () => {
  const ctx = fakeCtx(still);
  const r = await O.getOneClick("flood").run(still, ctx);
  assert.equal(ctx.queued.length, 1);
  const p = ctx.queued[0];
  assert.equal(p[1].class_type, "SoundstageImageLoad"); assert.equal(p[1].inputs.source, still.ref);
  assert.equal(p[2].class_type, "SoundstageEditImage"); assert.equal(p[2].inputs.model, "FLUX 3 Klein · local [<$5M]");
  assert.match(p[2].inputs.prompt, /knee-deep/); assert.match(p[2].inputs.prompt, /shins are hidden/); assert.match(p[2].inputs.prompt, /camera position, the lens and the framing exactly the same/); assert.match(p[2].inputs.prompt, /Add nothing: no new people/);
  assert.deepEqual([p[2].inputs.width, p[2].inputs.height], [1920, 1088]);   // the still's own size, in 16s
  assert.equal(p[9].inputs.filename_prefix, "soundstage_private/oneclick/shot_2_x");
  assert.equal(r.kind, "still");
});

test("clip effects: frame 1 edited, then Ripple carries it with the clip's sound (two jobs)", async () => {
  const ctx = fakeCtx(clip);
  const r = await O.getOneClick("relight_low_key_noir").run(clip, ctx);
  assert.equal(ctx.queued.length, 2);
  assert.equal(ctx.queued[0][1].inputs.source, clip.ref);           // SoundstageImageLoad gives a clip's frame 1
  const rp = ctx.queued[1][1];
  assert.equal(rp.class_type, "SoundstageRipple");
  assert.equal(rp.inputs.source, clip.ref); assert.match(rp.inputs.edited_frame, /^soundstage_private\/oneclick\/rpid1\.png \[output\]$/);
  assert.equal(rp.inputs.keep_audio, true); assert.equal(rp.inputs.color_match, "off");
  assert.equal(r.kind, "clip"); assert.ok(r.extra.frame1);
});

test("empty the scene and cutout on clips use the LTX IC-LoRAs; cutout keeps alpha in ProRes 4444", async () => {
  let ctx = fakeCtx(clip);
  await O.getOneClick("empty").run(clip, ctx);
  let p = ctx.queued[0];
  assert.equal(p[2].class_type, "SoundstageCleanPlate"); assert.match(p[2].inputs.model, /Clean-Plate/); assert.deepEqual(p[2].inputs.fps, ["1", 2]);
  assert.equal(p[51].class_type, "SaveVideo"); assert.equal(p[50].inputs.audio, undefined);
  ctx = fakeCtx(clip);
  await O.getOneClick("cutout").run(clip, ctx);
  p = ctx.queued[0];
  assert.match(p[2].inputs.model, /Alpha-Gen/);
  assert.equal(p[60].inputs.format, "video/ProRes"); assert.equal(p[60].inputs.profile, "4444"); assert.deepEqual(p[60].inputs.images, ["2", 0]);
  assert.equal(p[4].inputs.blend_mode, "multiply");
  ctx = fakeCtx(still, { subject: "the dog" });
  await O.getOneClick("cutout").run(still, ctx);
  assert.match(ctx.queued[0][2].inputs.model, /^SAM 3/); assert.equal(ctx.queued[0][2].inputs.prompt, "the dog"); assert.equal(ctx.queued[0][2].inputs["model.threshold"], 0.5);
  ctx = fakeCtx(still);
  await O.getOneClick("cutout").run(still, ctx);
  assert.match(ctx.queued[0][2].inputs.model, /^BiRefNet/);
});

test("living photo and the practical effects are LTX-2.5 image to video, LTX-sized, 8n+1 frames", async () => {
  const ctx = fakeCtx(still);
  await O.getOneClick("living_photo").run(still, ctx);
  const v = ctx.queued[0][2].inputs;
  assert.equal(ctx.queued[0][2].class_type, "SoundstageGenerateVideo");
  assert.deepEqual(v.first_frame, ["1", 0]); assert.equal(v.width % 64, 0); assert.equal(v.height % 64, 0); assert.equal((v.frames - 1) % 8, 0);
  assert.match(v.prompt, /camera locked off/);
  for (const id of ["fx_pop", "fx_cake", "fx_gulp"]) { assert.equal(O.getOneClick(id).badge, "experimental"); assert.match(O.getOneClick(id).hint, /practical FX/); }
  assert.deepEqual(O.ltxSize(1920, 1080, 1280), { width: 1280, height: 704 });
});

test("the depth-locked relight runs (Klein then Krea 2 on the stage depth) and keeps the Klein pass", async () => {
  const st = { activeShot: () => ({ id: "shot_2" }), renderFrameTo: () => ({ width: 4, height: 2 }), previewCamera() {} };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb(new Blob(["x"], { type: "image/png" })) }) };
  globalThis.File = globalThis.File || class extends Blob { constructor(b, n, o) { super(b, o); this.name = n; } };
  try {
    const ctx = fakeCtx(still, { lock: true });
    ctx.stage = st;
    ctx.api = { fetchApi: async () => ({ json: async () => ({ pid1: { outputs: { 8: { images: [{ filename: "k.png" }] } } } }) }) };
    const r = await O.getOneClick("relight_neon_mixed").run(still, ctx);
    assert.equal(ctx.queued.length, 1); assert.equal(ctx.queued[0][4].inputs["model.denoise"], 0.45);
    assert.equal(r.extra.depth_locked, true); assert.equal(r.extra.klein.filename, "k.png");
  } finally { delete globalThis.document; }
});

test("relights: all 18 setups in words (direction, hardness, kelvin), light only", () => {
  assert.equal(L.SETUPS.length, 18);
  const r = L.relightPrompt(L.SETUPS.find((s) => s.id === "rembrandt"));
  assert.match(r, /Rembrandt lighting/); assert.match(r, /from about 50° to one side, high/); assert.match(r, /to the other side/);
  assert.match(r, /Change only the light/);
  assert.doesNotMatch(L.relightPrompt(L.SETUPS.find((s) => s.id === "interrogation")), /light lighting/);
  assert.equal(L.kelvinWords(1900), "flame-orange 1900 K");
  const p = L.depthLockedRelightPrompt({ source: still.ref, prompt: "x", klein: { model: "FLUX 3 Klein · local" }, krea: { model: "Krea 2 Turbo · local", "model.denoise": 0.85 },
    depth: "d.png [input]", seed: 1, prefix: "p" });
  assert.deepEqual(p[4].inputs.control_image, ["3", 0]); assert.equal(p[4].inputs["model.denoise"], 0.45); assert.deepEqual(p[4].inputs.image, ["2", 0]);
});

test("new angles: the stage camera moves the way the card says; exact angles lock Klein to the moved depth", () => {
  const cam = { position: [0, 1.6, 5], target: [0, 1.4, 0], focal_mm: 35 };
  const left = A.moveCamera(cam, { orbit: 20 });
  // the camera looks down -Z, so its right is +X: an orbit to its left moves it to -X, same distance from the target
  assert.ok(left.position[0] < -1);
  const d = (c) => Math.hypot(c.position[0] - c.target[0], c.position[2] - c.target[2]);
  assert.ok(Math.abs(d(left) - d(cam)) < 1e-3);
  assert.ok(A.moveCamera(cam, { orbit: -20 }).position[0] > 1);
  assert.equal(A.moveCamera(cam, { low: true }).position[1], 0.4);
  assert.ok(A.moveCamera(cam, { high: true }).position[1] > 4);
  assert.ok(A.moveCamera(cam, { push: 0.35 }).position[2] < 3.4);
  assert.ok(A.moveCamera(cam, { push: -0.5 }).position[2] > 7);
  const p = A.exactAnglePrompt({ color: "c [input]", depth: "d [input]", prompt: A.EXACT_LOOK, model: { model: "FLUX 3 Klein · local" }, seed: 3, prefix: "p", width: 1920, height: 1088 });
  assert.equal(p[4].inputs.stage_denoise, 0.9); assert.deepEqual(p[4].inputs.control_image, ["2", 0]);
  assert.equal(p[4].inputs.ref_1, undefined);   // with the original as a reference Klein copied its camera (2026-11-02)
  assert.equal(O.getOneClick("angle_orbit_left").badge, "approximate"); assert.equal(O.getOneClick("exact_orbit_left").badge, "experimental");   // geometry exact, look clay-like (2026-11-02 test)
});

test("expand: pads never crop, the card says when it's already that aspect, Fill extends only the new area", async () => {
  assert.deepEqual(X.padFor(1920, 1080, 2.39), { left: 330, right: 331, top: 0, bottom: 0 });
  assert.deepEqual(X.padFor(1920, 1080, 9 / 16).left, 0);
  assert.equal(X.padFor(1920, 1080, 16 / 9).none, true);
  assert.match(O.availability(O.getOneClick("expand_16_9"), still), /already 16:9/);
  const ctx = fakeCtx(still);
  await O.getOneClick("expand_2_39_1").run(still, ctx);
  const p = ctx.queued[0];
  assert.equal(p[2].class_type, "SoundstagePadForFill"); assert.equal(p[2].inputs.aspect, "2.39:1");
  assert.equal(p[3].inputs.mode, "extend"); assert.deepEqual(p[3].inputs.mask, ["2", 1]); assert.equal(p[3].inputs.color_match, true);
});

test("the MCP catalog is plain data", () => {
  const rows = O.catalogFor(still);
  assert.ok(rows.length >= 50);
  const cut = rows.find((r) => r.id === "cutout");
  assert.deepEqual(cut.fields.map((f) => f.id), ["subject"]);
  assert.equal(JSON.parse(JSON.stringify(rows)).length, rows.length);
  assert.ok(E.EFFECT_IDS.includes("nightfall") && X.EXPAND_IDS.includes("expand_clip") && A.ANGLE_IDS.length === 12 && L.LIGHT_IDS.length === 18);
});

test("card names never collide across groups (Light's Loop setup reads 'Loop lighting', not the Seamless loop)", async () => {
  await import("../../web/oneclick/loop.mjs");
  const names = new Map();
  for (const s of O.oneClicks()) {
    const k = s.label.toLowerCase();
    assert.ok(!names.has(k), `two cards are called "${s.label}" (${names.get(k)} and ${s.id})`);
    names.set(k, s.id);
  }
  assert.equal(O.getOneClick("relight_loop").label, "Loop lighting");
});
