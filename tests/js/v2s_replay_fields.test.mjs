// The fields the street-dance fixes add to a Video -> 3D result (tests/video2stage_fixtures/v2s_replay_fields.json,
// made by tests/test_v2s_dancer.py replay_fields() from fixtures, not a GPU run), fed to the App's own functions:
// the measured sky paints the stage, the wardrobe words pre-fill the Look text, the girth widens the clay, and the
// wardrobe reference joins ④ Cast in this shot. The browser check overlays the same file on the try-it replay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { skyBackground, SKY_COLORS, skyFor } from "../../web/stage/lighting.mjs";
import { buildHuman } from "../../web/stage/humans.mjs";
import { castPool, defaultShotCast } from "../../web/cast/shotcast.mjs";

const F = JSON.parse(readFileSync(new URL("../video2stage_fixtures/v2s_replay_fields.json", import.meta.url), "utf8"));

test("the measured sky colour is what the stage paints, while its preset is set", () => {
  const L = F.lighting;
  assert.equal(L.preset, "overcast");
  const phase = skyFor(0, L.overcast).phase;
  assert.equal(phase, "overcast");
  assert.equal(skyBackground(phase, L), parseInt(L.sky_color.hex.slice(1), 16));
  assert.notEqual(skyBackground(phase, L), SKY_COLORS.overcast);          // not the preset's fixed grey
  assert.equal(skyBackground("daylight", { ...L, preset: "midday" }), SKY_COLORS.daylight);   // preset changed: dropped
  assert.equal(skyBackground("overcast", { ...L, sky_color: { hex: "javascript:1", preset: "overcast" } }), SKY_COLORS.overcast);
  assert.equal(skyBackground("night", null), SKY_COLORS.night);
  const [r, g, b] = F.video2stage.weather.stage_rgb;
  assert.equal((r << 16) | (g << 8) | b, skyBackground(phase, L));   // the Python mirror agrees with the stage
});

test("the wardrobe words pre-fill the Look text, never a dress", async () => {
  const { suggestFromVideo } = await import("../../web/pipeline/pipeline.mjs");
  const a = F.actors.driver;
  const p = suggestFromVideo({ video2stage: F.video2stage, actors: [{ id: "driver", ...a, mocap: {} }] });
  assert.equal(p, F.video2stage.look_hint);
  assert.match(p, /plaid shirt/);
  assert.match(p, /jeans/);
  assert.match(p, /overcast/i);
  assert.doesNotMatch(p, /dress/);
});

test("the measured girth widens the clay (hips) against the default build", () => {
  const mesh = (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color }));
  const width = (ap) => {
    const g = buildHuman("woman", 1.66, ap, mesh);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    return box.max.x - box.min.x;
  };
  const ap = F.actors.driver.appearance;
  assert.ok(ap.girth > 1 && ap.girth < 1.2);
  const wide = width(ap), base = width({ ...ap, girth: undefined, build: "average" });
  assert.ok(wide > base * 1.01, `${wide} vs ${base}`);
  assert.ok(width({ ...ap, girth: 7 }) === width({ ...ap, girth: undefined }));   // out of range: ignored, build word used
});

test("the wardrobe reference is an item in Cast in this shot", () => {
  const actors = [{ id: "driver", name: "Driver", ...F.actors.driver }];
  const pool = castPool([], actors, {}, (f) => `/view?filename=${f}`);
  const w = pool.find((it) => it.key === "wardrobe:driver");
  assert.ok(w && w.kind === "wardrobe" && /face blurred/.test(w.name) && w.ref === F.actors.driver.wardrobe_ref);
  assert.ok(defaultShotCast(pool, { actors }).includes("wardrobe:driver"));
});
