// node --test tests/js/tier.test.mjs
// Lifelike-only L1, part 5: the device tier probe, the picker's pick, the people rows (plan 4.5), the lifelike cap per
// shot, and what the local Rocketbox kit measures against the GPU budgets. Real-kit tests SKIP without the files.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as T from "../../web/stage/tier.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import { realKits, bareStage, clayOf, NOT_INSTALLED } from "./footkit.mjs";

test("probe: phone TP, integrated / software GPU or small textures T0, a capable GPU T1, Hero never automatic", () => {
  assert.equal(T.probeTier({ phone: true, gpu: "Apple GPU" }).tier, "TP");
  assert.equal(T.probeTier({ gpu: "Intel(R) Iris(TM) Plus Graphics 655", maxTexture: 16384 }).tier, "T0");
  assert.equal(T.probeTier({ gpu: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" }).tier, "T0");
  assert.equal(T.probeTier({ gpu: "NVIDIA GeForce RTX 3060", maxTexture: 4096 }).tier, "T0");
  assert.equal(T.probeTier({ gpu: "AMD Radeon Pro 5500M", maxTexture: 16384, deviceMemoryGB: 4 }).tier, "T0");
  assert.equal(T.probeTier({ gpu: "Apple M2", maxTexture: 16384, deviceMemoryGB: 8 }).tier, "T1");
  assert.equal(T.probeTier({}).tier, "T1");
  for (const info of [{ gpu: "NVIDIA RTX 6000" }, {}]) assert.notEqual(T.probeTier(info).tier, "Hero");
  assert.equal(T.pickTier({ tier: "T0" }, "auto"), "T0");
  assert.equal(T.pickTier({ tier: "T0" }, "Hero"), "Hero");
  assert.equal(T.pickTier({ tier: "T0" }, "nonsense"), "T0");
  // the pick is per browser and survives a storage that throws (a private window)
  const store = new Map(); const ls = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  T.savePick("T0", ls); assert.equal(T.savedPick(ls), "T0");
  T.savePick("bogus", ls); assert.equal(T.savedPick(ls), "auto");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(T.savedPick(broken), "auto"); assert.doesNotThrow(() => T.savePick("T1", broken));
});

test("people rows: the plan 4.5 table (caps, textures, budgets), and the cap is the first N people in scene order", () => {
  assert.deepEqual(T.TIER_ORDER.map((t) => T.PEOPLE_TIERS[t].maxLifelike), [2, 6, 16, Infinity]);
  assert.deepEqual(T.TIER_ORDER.map((t) => T.PEOPLE_TIERS[t].texture), [256, 512, 1024, 1024]);
  assert.deepEqual(T.TIER_ORDER.map((t) => T.PEOPLE_TIERS[t].gpuBudget), [20e6, 40e6, 120e6, Infinity]);
  assert.equal(T.PEOPLE_TIERS.TP.avatarShadow, false);
  assert.deepEqual([...T.lifelikeSet(["a", "b", "c"], "TP")], ["a", "b"]);
  assert.equal(T.lifelikeSet(["a", "b", "c"], "T1").size, 3);
});

test("real Rocketbox: on the phone tier the third person is the marked stand-in on every frame; the first two lifelike", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const people = ["p1", "p2", "p3"].map((id, i) => ({ id, kind: i % 2 ? "woman" : "man", height_m: i % 2 ? 1.68 : 1.8, position: [i, 0, 0], keys: [{ frame: 0, position: [i, 0, 0] }] }));
  const st = bareStage(people, { frames: 25 });
  for (const a of people) A.attachKit(st, a, clayOf(st, a), K[a.kind]);
  await null;
  st.tier = "TP";
  for (const f of [0, 12, 24]) {
    st.frame = f; A.avatarsAt(st);
    assert.equal(st.actorMeshes.get("p1").userData.humanSkin.shown, true);
    assert.equal(st.actorMeshes.get("p2").userData.humanSkin.shown, true);
    const g3 = st.actorMeshes.get("p3");
    assert.equal(g3.userData.humanSkin.shown, false); assert.equal(g3.userData.standIn, true, "marked stand-in, never clay");
    // review round 2: the status said 'lifelike' for the capped person
    assert.equal(st.avatarStatus("p3").shownAs, "standin");
    assert.equal(st.avatarStatus("p3").owner, "standin");
    assert.equal(st.avatarStatus("p1").shownAs, "lifelike");
  }
  st.tier = "T1"; A.avatarsAt(st);
  assert.equal(st.actorMeshes.get("p3").userData.humanSkin.shown, true);
  assert.equal(st.actorMeshes.get("p3").userData.standIn, false);
  assert.equal(st.avatarStatus("p3").shownAs, "lifelike");
});

test("real Rocketbox: the local kit measured against the tier budgets (what the installer's decimation and downscale must reach)", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const dir = fileURLToPath(new URL("../../web/stage/people/rocketbox/tex/", import.meta.url));
  const size = (f) => { const b = readFileSync(dir + f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  // the specular maps are never loaded (avatarcore.tgaToPng serves them a 1 px stand-in): the installer can drop them
  const used = (id) => files.filter((f) => f.startsWith(id) && !/_specular/.test(f));
  const rows = [];
  for (const [kind, id] of [["man", "m002"], ["woman", "f001"]]) {
    const geo = K[kind].template.getObjectByName(K[kind].meshName).geometry;
    const vertices = geo.attributes.position.count, tris = (geo.index ? geo.index.count : vertices) / 3;
    const textures = used(id).map(size);
    assert.ok(textures.length === 5, `${kind}: 5 used maps (${used(id)})`);
    for (const tier of T.TIER_ORDER) {
      const one = T.avatarGpuBytes({ vertices, textures }, tier), cap = Math.min(T.PEOPLE_TIERS[tier].maxLifelike, 16);
      rows.push(`${kind} ${tier}: ${vertices} vertices, ${Math.round(tris)} triangles, ${(one / 1e6).toFixed(1)} MB for one kit (budget ${(T.PEOPLE_TIERS[tier].gpuBudget / 1e6).toFixed(0)} MB, cap ${cap})`);
      if (tier === "T1") assert.ok(one < T.PEOPLE_TIERS.T1.gpuBudget, `${kind}: one kit fits T1`);
    }
    // measured 2026-11-08: the "hipoly" mesh is already under the TP target (the plan's 15k / 30k decimation rows
    // assumed a heavier mesh): no decimation is needed; the textures are the budget
    assert.ok(tris < T.PEOPLE_TIERS.TP.meshTriangles, `${kind}: ${tris} triangles`);
  }
  console.log(rows.join("\n"));
});
