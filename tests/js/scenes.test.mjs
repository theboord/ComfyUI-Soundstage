// node --test tests/js/scenes.test.mjs
// Host bookkeeping for script scenes (web/script/scenes.mjs): scene-scoped shot ids, the per-scene snapshot list, the
// compact/trimmed form saved on the node, and retiring a replaced script's scenes. Runs a fake stage through a
// switch A -> B -> A to lock the snapshot behaviour soundstage.js relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NO_SCENE, keyOfShot, listShots, packScript, retireScenes, sceneNumberOf, scopeShots, stageSig, unpackScript }
  from "../../web/script/scenes.mjs";
import { parseScript } from "../../web/script/parse.mjs";
import { demoScript } from "../../web/script/demo_script.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const stageJSON = (ids, extra = {}) => ({ camera: {}, shots: ids.map((id) => ({ id, name: id, setup: "master" })), active_shot: ids[0], ...extra });

test("scopeShots: agent ids become scene-scoped, unique ids only get tagged", () => {
  const st = stageJSON(["shot_1", "shot_2", "shot_kx9"]);
  st.active_shot = "shot_2";
  const map = scopeShots(st, "sc_2");
  assert.deepEqual(map, { shot_1: "sc_2__shot_1", shot_2: "sc_2__shot_2" });
  assert.deepEqual(st.shots.map((s) => s.id), ["sc_2__shot_1", "sc_2__shot_2", "shot_kx9"]);
  assert.ok(st.shots.every((s) => s.scene_id === "sc_2"));
  assert.equal(st.active_shot, "sc_2__shot_2");
  // Idempotent.
  assert.deepEqual(scopeShots(st, "sc_2"), {});
  // all: every unscoped id is renamed (a fresh stage's default camera).
  const f = stageJSON(["shot_1"]);
  assert.deepEqual(scopeShots(f, "sc_3", { all: true }), { shot_1: "sc_3__shot_1" });
  // NO_SCENE never renames or tags.
  const n = stageJSON(["shot_1"]);
  assert.deepEqual(scopeShots(n, NO_SCENE), {});
  assert.equal(n.shots[0].scene_id, undefined);
});

test("scopeShots: a rebuilt scene never reuses an id that already has renders", () => {
  const taken = new Set(["sc_1__shot_1"]);
  const st = stageJSON(["shot_1", "shot_2"]);
  const map = scopeShots(st, "sc_1", { taken: (id) => taken.has(id) });
  assert.notEqual(map.shot_1, "sc_1__shot_1");
  assert.match(map.shot_1, /^sc_1__shot_1_[0-9a-z]+$/);
  assert.equal(map.shot_2, "sc_2__shot_2".replace("sc_2", "sc_1"));
  assert.equal(new Set(st.shots.map((s) => s.id)).size, 2);
});

test("listShots / keyOfShot: snapshots plus the live stage, scene from the shot or its snapshot key", () => {
  const snaps = { sc_1: stageJSON(["sc_1__shot_1", "sc_1__shot_2"]), [NO_SCENE]: stageJSON(["shot_1"]) };
  snaps.sc_1.shots[0].scene_id = "sc_1";
  const live = stageJSON(["sc_2__shot_1"]).shots;
  const all = listShots(snaps, "sc_2", live);
  assert.deepEqual(all.map((x) => [x.id, x.scene_id, x.live]), [
    ["sc_1__shot_1", "sc_1", false], ["sc_1__shot_2", "sc_1", false], ["shot_1", null, false], ["sc_2__shot_1", "sc_2", true]]);
  assert.equal(keyOfShot(snaps, "sc_2", live, "sc_1__shot_2"), "sc_1");
  assert.equal(keyOfShot(snaps, "sc_2", live, "sc_2__shot_1"), "sc_2");
  assert.equal(keyOfShot(snaps, "sc_2", live, "shot_1"), NO_SCENE);
  assert.equal(keyOfShot(snaps, "sc_2", live, "nope"), null);
  // An untouched fresh stage lists no live shots.
  assert.equal(listShots(snaps, "sc_2", []).filter((x) => x.live).length, 0);
});

test("switch A -> B -> A on a fake stage restores A exactly (the host's swap)", () => {
  // The host's swap, reduced to its data moves: stash live under liveKey, load the target's snapshot.
  const stage = { state: stageJSON(["sc_a__shot_1", "sc_a__shot_k1"], { environment: { set: "beach" } }),
    toJSON() { return clone(this.state); }, load(s) { this.state = clone(s); } };
  const snaps = { sc_b: stageJSON(["sc_b__shot_1"], { environment: { set: "street_night" } }) };
  let liveKey = "sc_a";
  const sw = (to) => { snaps[liveKey] = stage.toJSON(); const s = snaps[to]; delete snaps[to]; stage.load(s); liveKey = to; };
  const a0 = stage.toJSON();
  sw("sc_b");
  assert.equal(stage.state.environment.set, "street_night");
  assert.deepEqual(Object.keys(snaps), ["sc_a"]);
  stage.state.shots.push({ id: "shot_new", name: "Single" });
  scopeShots(stage.state, liveKey);
  sw("sc_a");
  assert.deepEqual(stage.toJSON(), a0);
  assert.deepEqual(snaps.sc_b.shots.map((s) => [s.id, s.scene_id]), [["sc_b__shot_1", "sc_b"], ["shot_new", "sc_b"]]);
  assert.equal(stageSig(a0), stageSig({ ...a0, active_shot: "sc_a__shot_k1" }));
});

test("packScript: small scripts keep their text, big ones keep headings + notes only; unpack restores", () => {
  const demo = demoScript();
  demo.scenes[1].notes = "Hold on the neon.";
  const small = packScript(demo);
  assert.equal(small.trimmed, false);
  const back = unpackScript(small.script);
  assert.equal(back.scenes.length, demo.scenes.length);
  assert.equal(back.scenes[1].notes, "Hold on the neon.");
  assert.ok(back.scenes[1].breakdown, "breakdown re-derived");
  assert.deepEqual(back.scenes[1].elements, demo.scenes[1].elements);

  // A long screenplay: over the limit, elements leave the node copy.
  const body = readFileSync(new URL("./fixtures/script/boardwalk.fountain", import.meta.url), "utf8");
  const big = parseScript(Array.from({ length: 40 }, () => body).join("\n\n"), { fileName: "big.fountain" });
  big.scenes[3].notes = "Wide lens, low.";
  const p = packScript(big, 100000);
  assert.equal(p.trimmed, true);
  assert.ok(p.bytes < 100000 * 1.2, `trimmed form is small (${p.bytes})`);
  assert.ok(p.script.scenes.every((s) => !("elements" in s)));
  // With the full copy (userdata), notes from the node win and the text comes back.
  const full = packScript(big, Infinity).script;
  full.scenes[3].notes = "older note";
  const u = unpackScript(p.script, full);
  assert.equal(u.scenes[3].notes, "Wide lens, low.");
  assert.ok(u.scenes[3].elements.length > 0);
  assert.equal(u.trimmed, undefined);
  // Without it: headings and notes, empty pages.
  const bare = unpackScript(p.script, null);
  assert.equal(bare.scenes[3].notes, "Wide lens, low.");
  assert.deepEqual(bare.scenes[3].elements, []);
});

test("retireScenes: a replaced script's scenes keep their stages under a retired key", () => {
  const snaps = { sc_1: stageJSON(["sc_1__shot_1"]), [NO_SCENE]: stageJSON(["shot_1"]) };
  snaps.sc_1.shots[0].scene_id = "sc_1";
  const cuts = { sc_1: { cut: [{ shot_id: "sc_1__shot_1", in: 0, out: 24 }] } };
  const live = stageJSON(["sc_2__shot_1"]);
  live.shots[0].scene_id = "sc_2";
  const k = retireScenes({ snaps, cuts, liveKey: "sc_2", liveState: live, tag: "old1" });
  assert.equal(k, "old1:sc_2");
  assert.deepEqual(Object.keys(snaps).sort(), [NO_SCENE, "old1:sc_1"].sort());
  assert.equal(snaps["old1:sc_1"].shots[0].scene_id, "old1:sc_1");
  assert.equal(live.shots[0].scene_id, "old1:sc_2");
  assert.ok(cuts["old1:sc_1"]);
  // A new script's sc_1 does not see the old shots.
  assert.equal(listShots(snaps, k, live.shots).filter((x) => x.scene_id === "sc_1").length, 0);
});

test("sceneNumberOf", () => {
  const s = demoScript();
  assert.equal(sceneNumberOf(s, s.scenes[2].id), String(s.scenes[2].number));
  assert.equal(sceneNumberOf(s, "nope"), null);
  assert.equal(sceneNumberOf(null, "sc_1"), null);
});
