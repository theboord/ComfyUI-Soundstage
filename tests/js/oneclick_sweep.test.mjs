// node --test tests/js/   (✦ One-click swept: every card's queued graphs hold together, a reshoot whose server stopped
// answering still times out, and the Real performance voice choice never borrows another character's voice)
import test from "node:test";
import assert from "node:assert/strict";

import * as O from "../../web/oneclick/oneclick.mjs";
import "../../web/oneclick/effects.mjs";
import "../../web/oneclick/light.mjs";
import "../../web/oneclick/angle.mjs";
import * as X from "../../web/oneclick/expand.mjs";
import * as R from "../../web/oneclick/reshoot.mjs";
import { LOOP_IDS } from "../../web/oneclick/loop.mjs";
import { matchVoice, voiceChoices, buildCaptureGraph, VOICE_NODE } from "../../web/performance/performance.mjs";

const MODELS = O.modelsFromObjectInfo({
  SoundstageEditImage: { input: { required: { model: ["COMFY_DYNAMICCOMBO_V3", { options: [
    { key: "Krea 2 Turbo · local [<$1M]", inputs: { required: { denoise: ["FLOAT", { default: 0.85 }] } } },
    { key: "FLUX 3 Klein · local [<$5M]", inputs: {} }] }] } } },
  SoundstageFill: { input: { required: { model: ["X", { options: [{ key: "FLUX 3 Klein · local [<$5M]", inputs: {} }] }] } } },
  SoundstageMatte: { input: { required: { model: ["X", { options: [{ key: "BiRefNet (core RemoveBackground) · local", inputs: {} },
    { key: "LTX-2.5 Alpha-Gen (soft video matte) · local [<$10M]", inputs: {} }] }] } } },
  SoundstageCleanPlate: { input: { required: { model: ["X", { options: [{ key: "LTX-2.5 Clean-Plate IC-LoRA · local [<$10M]", inputs: {} }] }] } } },
  SoundstageGenerateVideo: { input: { required: { model: ["X", { options: [{ key: "LTX-2.5 22B distilled · local [<$10M]", inputs: {} }] }] } } },
  SoundstageRipple: {}, VHS_VideoCombine: {},
});

/** Links that don't resolve: [node, input, link] for every [id, slot] whose id isn't in the prompt or slot isn't an int >= 0. */
function dangling(p) {
  const bad = [];
  for (const [id, n] of Object.entries(p)) {
    assert.equal(typeof n?.class_type, "string", `node ${id} has a class_type`);
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number") {
        if (!(v[0] in p) || !Number.isInteger(v[1]) || v[1] < 0) bad.push([id, k, v]);
      }
    }
  }
  return bad;
}

function ctxFor(target, seed) {
  const queued = [];
  return {
    queued, opts: {}, models: MODELS, stage: null, pipeline: null, api: { fetchApi: async () => ({ ok: true, json: async () => ({}) }) },
    quality: () => "Final", seed: () => seed, prefix: (s = "") => O.outPrefix(target, `sw${s ? "_" + s : ""}`), progress() {}, say() {}, toast() {},
    async queue(p) { queued.push(p); return `pid${queued.length}`; },
    async wait(pid, outId) {
      const p = queued[+pid.slice(3) - 1];
      assert.ok(p[outId], `waits on node ${outId}, which the prompt has`);
      return { filename: `r${pid}.${/Video|Ripple/.test(JSON.stringify(p)) && outId !== "9" ? "mp4" : "png"}`, subfolder: "soundstage_private/oneclick", type: "output" };
    },
    async upload() { return "soundstage_private/oneclick/pass.png [input]"; },
  };
}

const TARGETS = {
  wide: O.makeTarget({ url: "/api/view?filename=look_00004_.png&subfolder=soundstage&type=output", shot: "s", width: 4096, height: 1716 }),
  tall: O.makeTarget({ url: "/api/view?filename=look_00005_.png&subfolder=soundstage&type=output", shot: "s", width: 720, height: 1280 }),
  tiny: O.makeTarget({ url: "/api/view?filename=look_00006_.png&subfolder=soundstage&type=output", shot: "s", width: 40, height: 30 }),
  clip: O.makeTarget({ url: "/api/view?filename=final_00028_.mp4&subfolder=soundstage&type=output", shot: "s", take_kind: "final" }),
};

test("every card that applies queues graphs whose links all resolve, waits on a node it queued, seeds clamped to >= 0", async () => {
  let ran = 0;
  // Loop and Reshoot build their graphs on the server (tests/test_oneclick_sweep.py sweeps those)
  const server = new Set([...LOOP_IDS, ...R.RESHOOT_IDS]);
  for (const spec of O.oneClicks().filter((s) => !server.has(s.id))) {
    for (const [name, target] of Object.entries(TARGETS)) {
      if (O.availability(spec, target) !== true) continue;
      for (const seed of [0, -5, Number.NaN, 2 ** 31 - 1]) {
        const ctx = ctxFor({ ...target }, seed);
        try { await spec.run({ ...target }, ctx); } catch (e) {
          // the exact (stage) angles need the open shot: anything else that throws is a bug in the card
          assert.match(e.message, /stage|Frame candidate/, `${spec.id} on ${name}: ${e.message}`);
          continue;
        }
        ran++;
        assert.ok(ctx.queued.length >= 1, `${spec.id} queued something`);
        for (const p of ctx.queued) {
          assert.deepEqual(dangling(p), [], `${spec.id} on ${name}`);
          for (const n of Object.values(p)) {
            if ("seed" in n.inputs && /^Soundstage(EditImage|Fill)$/.test(n.class_type)) {
              assert.ok(Number.isInteger(n.inputs.seed) && n.inputs.seed >= 0, `${spec.id}: ${n.class_type}.seed ${n.inputs.seed}`);
            }
          }
        }
      }
    }
  }
  assert.ok(ran > 40, `swept ${ran} runs`);
});

test("expand: every aspect pads to that aspect (within a pixel) and never crops, for any picture", () => {
  for (const [key, aspect] of X.ASPECTS) {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [4096, 1716], [1000, 1000], [37, 23], [1, 4000]]) {
      const pad = X.padFor(w, h, aspect);
      if (pad.none) { assert.ok(Math.abs(w / h - aspect) / aspect < 0.01); continue; }
      for (const v of Object.values(pad)) assert.ok(Number.isInteger(v) && v >= 0, `${key} ${w}x${h}: ${JSON.stringify(pad)}`);
      const nw = w + pad.left + pad.right, nh = h + pad.top + pad.bottom;
      assert.ok(Math.abs(nw - nh * aspect) <= Math.max(1, aspect), `${key} ${w}x${h} -> ${nw}x${nh}`);
      assert.ok(pad.left + pad.right === 0 || pad.top + pad.bottom === 0, "grows one way only");
    }
    assert.equal(X.padFor(0, 100, aspect), null);
  }
});

test("a reshoot whose server stopped answering times out instead of polling forever", async () => {
  let polls = 0;
  const down = { fetchApi: async () => { polls++; throw new Error("ECONNREFUSED"); } };
  await assert.rejects(R.waitJob(down, "j1", () => {}, { every: 1, timeoutMs: 25 }), /timed out/);
  assert.ok(polls >= 1);
  const html = { fetchApi: async () => ({ json: async () => { throw new SyntaxError("Unexpected token <"); } }) };
  await assert.rejects(R.waitJob(html, "j1", () => {}, { every: 1, timeoutMs: 25 }), /timed out/);
  // a job that answers is still followed to the end
  let n = 0;
  const ok = { fetchApi: async () => ({ json: async () => (++n < 3 ? { state: "running", step: "Depth", progress: 0.2 } : { state: "done", result: { words: "w" } }) }) };
  assert.deepEqual(await R.waitJob(ok, "j2", () => {}, { every: 1, timeoutMs: 5000 }), { words: "w" });
});

const SAVED = [{ name: "EZRA_HALE", character: "EZRA HALE" }, { name: "MARA_VOSS", character: "MARA VOSS" }, { name: "Old_Ben", character: "Ben Kenobi" }];

test("a full name that matches no saved voice never borrows another character's (the server refuses it too)", () => {
  assert.equal(matchVoice("Ezra Reed", SAVED), "", "Ezra Reed is not Ezra Hale");
  assert.equal(matchVoice("Mara Smith", SAVED), "");
  assert.equal(matchVoice("Ben Solo", SAVED), "");
  assert.equal(matchVoice("Ezra", SAVED), "EZRA_HALE", "a one-word cue still finds the one Ezra");
  assert.equal(matchVoice("Ben", SAVED), "Old_Ben", "by the character it was saved for");
  assert.equal(matchVoice("Ezra Reed", SAVED, ["EZRA HALE"]), "EZRA_HALE", "an alias the script gives settles it");
  // the Voice menu: Ezra Reed's own cast voice isn't saved yet: it stays his (flagged), never healed to Ezra Hale's
  const c = voiceChoices({ who: "Ezra Reed", castVoice: "EZRA_COLE", saved: SAVED });
  assert.equal(c.value, "EZRA_COLE");
  assert.match(c.options[1].label, /^Convert to Ezra Reed \(EZRA_COLE\) · not saved yet$/);
  assert.deepEqual(voiceChoices({ who: "Ezra Reed", saved: SAVED }).options.map((o) => o.value), ["", "EZRA_HALE", "MARA_VOSS", "Old_Ben"],
    "no default conversion: every saved voice is offered as itself, none as Ezra Reed's");
});

test("the capture graph routes the clip's sound through the voice step only, its seed a whole number >= 0", () => {
  const base = { source: "p/a.mov [input]", performer: "Mike", consent: true };
  for (const seed of [-4, Number.NaN, "7", 2.9, 1e21]) {
    const g = buildCaptureGraph({ ...base, voice: "EZRA_HALE", voiceSeed: seed });
    assert.deepEqual(dangling(g), []);
    const s = g[VOICE_NODE].inputs.seed;
    assert.ok(Number.isInteger(s) && s >= 0, `seed ${seed} -> ${s}`);
  }
  assert.equal(buildCaptureGraph({ ...base, voice: "   " })[VOICE_NODE], undefined, "blank voice: keep mine");
});
