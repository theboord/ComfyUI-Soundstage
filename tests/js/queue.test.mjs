// node --test tests/js/queue.test.mjs
// The pod freeze of 2026-11-01: the App never fetches the full GET /queue or GET /history, a big stage goes by
// reference (web/ui/queue.mjs <-> soundstage/stagestore.py), and a reference loads back (widget restore, MP4 recipe).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { queueSummary, idsIn, storeStage, resolveStageValue, stageRefOf, stageInputsByRef, INLINE_MAX, _resetStored } from "../../web/ui/queue.mjs";
import { recipeFromTags, loadRecipeScene } from "../../web/takecheck/model.mjs";

const HASH = "a".repeat(64);
const res = (status, body, text) => ({ status, ok: status === 200, json: async () => body, text: async () => text ?? JSON.stringify(body) });

function serverApi() {
  const store = new Map();
  const calls = [];
  return {
    calls, store,
    async fetchApi(path, init = {}) {
      calls.push({ path, method: init.method || "GET", bytes: typeof init.body === "string" ? init.body.length : 0 });
      if (path === "/queue" || path.startsWith("/history?") || path === "/history") throw new Error(`full ${path} fetched`);
      if (path.startsWith("/soundstage/queue_summary")) {
        const ids = new URLSearchParams(path.split("?")[1] || "").get("ids");
        const items = [{ prompt_id: "r1", state: "running", position: 0 }, { prompt_id: "p1", state: "pending", position: 1 },
          { prompt_id: "p2", state: "pending", position: 2 }].filter((it) => !ids || ids.split(",").includes(it.prompt_id));
        return res(200, { running: 1, pending: 2, items });
      }
      if (path === "/soundstage/stage_store" && init.method === "POST") {
        const h = String(store.size + 1).padStart(64, "0");
        store.set(h, init.body);
        return res(200, { value: JSON.stringify({ stage_ref: h, bytes: init.body.length }), stage_ref: h, bytes: init.body.length });
      }
      const m = /^\/soundstage\/stage_store\/([0-9a-f]{64})$/.exec(path);
      if (m) return store.has(m[1]) ? res(200, JSON.parse(store.get(m[1])), store.get(m[1])) : res(404, { error: "no" });
      return res(404, { error: "no" });
    },
  };
}

const bigStage = () => JSON.stringify({ scene: { camera: { focal_mm: 35 }, shot: { frames: 121 }, active_shot: "s1",
  shots: [{ id: "s1", name: "Chase cam" }], actors: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, physics: { bake: "x".repeat(2000) } })) },
  passes: { clay: "a.jpg [temp]" } });

test("queue summary: counts and ids, filtered by prompt id; null when the server can't say", async () => {
  const api = serverApi();
  const s = await queueSummary(api);
  assert.equal(s.running + s.pending, 3);
  assert.deepEqual([...idsIn(s, "pending")], ["p1", "p2"]);
  const mine = await queueSummary(api, { ids: ["p2"] });
  assert.deepEqual(mine.items.map((i) => i.prompt_id), ["p2"]);
  assert.equal(await queueSummary({ fetchApi: async () => res(404, {}) }), null);
  assert.equal(await queueSummary({ fetchApi: async () => { throw new Error("tunnel"); } }), null);
  assert.equal(await queueSummary({ fetchApi: async () => res(200, { prompt_id: "blocked" }) }), null);   // the QA guard
});

test("a big stage is stored once and queued by reference; a small one stays inline", async () => {
  _resetStored();
  const api = serverApi();
  const text = bigStage();
  assert.ok(text.length > INLINE_MAX);
  const v = await storeStage(api, text);
  assert.ok(stageRefOf(v) && v.length < 200);
  assert.equal(await storeStage(api, text), v);
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1, "uploaded once per page");
  assert.equal(await storeStage(api, '{"scene":{}}'), null);
  // An older server (404), the QA guard's fake answer, a dropped tunnel: send it inline as before.
  _resetStored();
  assert.equal(await storeStage({ fetchApi: async () => res(404, {}) }, text), null);
  assert.equal(await storeStage({ fetchApi: async () => res(200, { prompt_id: "blocked" }) }, text), null);
  assert.equal(await storeStage({ fetchApi: async () => { throw new Error("tunnel"); } }, text), null);
});

test("a reference loads back for the widget, with its flags; inline values pass through", async () => {
  _resetStored();
  const api = serverApi();
  const text = bigStage();
  const v = await storeStage(api, text);
  assert.equal(await resolveStageValue(api, v), text);
  const flagged = JSON.stringify({ ...JSON.parse(v), look_start: false });
  assert.equal(JSON.parse(await resolveStageValue(api, flagged)).look_start, false);
  assert.equal(await resolveStageValue(api, text), text);
  await assert.rejects(resolveStageValue(api, JSON.stringify({ stage_ref: HASH })), /doesn't have stage/);
  assert.equal(stageRefOf(JSON.stringify({ stage_ref: HASH, scene: {} })), null);
  assert.equal(stageRefOf(text), null);
});

test("an MP4 recipe whose scene went by reference restores from this server's store", async () => {
  _resetStored();
  const api = serverApi();
  const sceneText = JSON.stringify(JSON.parse(bigStage()).scene);
  await storeStage(api, sceneText);
  const h = [...api.store.keys()][0];
  const rec = recipeFromTags({ soundstage: JSON.stringify({ v: 1, app: "Soundstage", scene_ref: h, shot: { id: "s1" }, rung: "final" }) });
  assert.equal(rec.scene, undefined);
  const full = await loadRecipeScene(api, rec);
  assert.equal(full.scene.camera.focal_mm, 35);
  assert.equal(full.shot.name, "Chase cam");
  // The prompt tag and the workflow tag by reference too.
  const ref = JSON.stringify({ stage_ref: h, bytes: 9, shot_id: "s1" });
  const fromPrompt = recipeFromTags({ prompt: JSON.stringify({ 9045: { class_type: "SoundstageStage", inputs: { stage: ref } } }) });
  assert.equal((await loadRecipeScene(api, fromPrompt)).scene.shot.frames, 121);
  const fromWf = recipeFromTags({ workflow: JSON.stringify({ nodes: [{ type: "SoundstageStage", widgets_values: [ref] }] }) });
  assert.equal((await loadRecipeScene(api, fromWf)).scene.active_shot, "s1");
  assert.equal(await loadRecipeScene(api, { scene_ref: HASH }), null);    // an MP4 from another machine
});

test("no App, tool or QA code fetches the full /queue or /history", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const bad = [];
  const pat = /(fetchApi\(|fetch\(|json\(api,\s*)\s*[`'"][^`'"]*?\/(queue|history)[`'"?]/;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === "vendor" || f === "node_modules") continue;
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(m?js)$/.test(f) || f === "api.js") continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (pat.test(line) && !/method: "POST"/.test(line)) bad.push(`${p.slice(root.length)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  walk(join(root, "web"));
  walk(join(root, "tools"));
  assert.deepEqual(bad, []);
});

test("the stage widget queues by reference and restores a reference; Export (API) keeps the stage inline", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  // The swap happens in the api.queuePrompt wrapper, before the prompt is posted.
  assert.match(src, /api\.queuePrompt = async \(\.\.\.args\) => \{[\s\S]{0,400}?await stageInputsByRef\(api, args\[1\]\?\.output\)[\s\S]{0,200}?const r = await orig\(\.\.\.args\)/);
  // serializeValue (what graphToPrompt and Export (API) read) never swaps the stage for a reference.
  const ser = src.slice(src.indexOf("widget.serializeValue = async"), src.indexOf("const onRemoved = node.onRemoved"));
  assert.ok(ser.length > 200);
  assert.doesNotMatch(ser.replace(/\/\/.*$/gm, ""), /storeStage|stageInputsByRef|byRef/);
  assert.match(ser, /return withFlag\(value\);/);
  assert.match(src, /if \(stageRefOf\(v\)\) \{\s*resolveStageValue\(api, v\)\.then\(restoreStage\)\.catch/);
});

test("queue time: big 3D Stage inputs in an API prompt become references, the rest is untouched", async () => {
  _resetStored();
  const api = serverApi();
  const big = bigStage();
  const output = {
    9045: { class_type: "SoundstageStage", inputs: { stage: big } },
    9046: { class_type: "SoundstageStage", inputs: { stage: '{"scene":{"camera":{}}}' } },   // small: inline
    9047: { class_type: "SaveImage", inputs: { images: ["9045", 0], filename_prefix: big } },  // not a stage node
  };
  assert.equal(await stageInputsByRef(api, output), 1);
  assert.ok(stageRefOf(output[9045].inputs.stage));
  assert.equal(output[9046].inputs.stage, '{"scene":{"camera":{}}}');
  assert.equal(output[9047].inputs.filename_prefix, big);
  assert.equal(await resolveStageValue(api, output[9045].inputs.stage), big);
  // Nothing to do, or the server can't store it: the prompt goes as it was (the server's on-prompt handler slims it).
  assert.equal(await stageInputsByRef(api, undefined), 0);
  _resetStored();
  const off = { 1: { class_type: "SoundstageStage", inputs: { stage: big } } };
  assert.equal(await stageInputsByRef({ fetchApi: async () => res(404, {}) }, off), 0);
  assert.equal(off[1].inputs.stage, big);
});
