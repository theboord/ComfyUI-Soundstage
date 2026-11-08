// Foot grounding, measured PHYSICALLY (tests/js/footkit.mjs physical()): every shoe vertex against the true ground
// under it on every frame the body is on its feet, not only the frames the plan calls planted. The station platform's
// edge, kerbs, stairs, uneven ground, the station ramp, slow walks, runs, fast spins, walking backwards.
// node --test tests/js/footground.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as K from "./footkit.mjs";
import { buildTrainStation, stationFloor, STATION } from "../../web/stage/sets/train.mjs";

const { NOT_INSTALLED, cm } = K;

// ---------------------------------------------------------------- the real station set: standing at the platform edge
test("real Rocketbox on the station set: standing at the platform edge, facing the track or away, soles on the platform, no pelvis drop, no reach miss", { skip: NOT_INSTALLED }, async () => {
  // the edge is at x = STATION.edgeA (1.62); the man and the woman stand 4-10 cm in from it, toes (or heels) over it
  for (const kind of ["man", "woman"]) for (const heading of [-90, 90]) for (const x of [1.66, 1.72]) {
    const a = { id: "edge", kind, height_m: K.heightOf(kind), position: [x, 0, 0], rotation_deg: heading, keys: [{ frame: 0, position: [x, 0, 0] }] };
    const st = await K.setup(kind, a, { frames: 49, setFx: buildTrainStation().fx });
    assert.equal(st._heightAt(a, 10), STATION.platformTop, "the body stands on the platform");
    const out = K.measure(st, a, { ground: stationFloor });
    const s = K.physical(out);
    const tag = `${kind} heading ${heading} x ${x}: ${K.fmt(s)}`;
    const cap = 0.12 * K.heightOf(kind) / 1.8;
    assert.ok(s.pen > -0.01, `${tag}: a sole ${cm(-s.pen)} cm into the platform`);
    assert.ok(s.drop < Math.min(0.03, cap - 0.005), `${tag}: the hips dropped ${cm(s.drop)} cm (cap ${cm(cap)})`);
    assert.ok(s.miss < 0.005, `${tag}: a planted foot missed its target by ${cm(s.miss)} cm (out of the leg's reach)`);
    assert.ok(Math.max(s.planted.l, s.planted.r) >= 40, `${tag}: planted`);
  }
});
