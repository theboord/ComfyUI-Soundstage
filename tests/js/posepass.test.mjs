// node --test tests/js/   (⑤ Motion's Pose follow: the OpenPose drawing of the clay rig, and the Pose follow prompt)
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";

import { LIMBS, COLORS, HAND_EDGES, FACE_TEMPLATE, drawOpenPose, hsvRgb, poseTile, personKeypoints, project, toPixels } from "../../web/stage/posepass.mjs";
import { buildPosePrompt, firstFrameRef, nonPeople } from "../../web/motion/ripple.mjs";
import { buildHuman } from "../../web/stage/humans.mjs";

/** A canvas 2D context that records what is drawn. */
function fakeCtx() {
  const calls = [];
  const ctx = { calls, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1 };
  for (const m of ["fillRect", "beginPath", "ellipse", "arc", "fill", "moveTo", "lineTo", "stroke"]) ctx[m] = (...a) => calls.push([m, ...a, ctx.fillStyle]);
  return ctx;
}

test("OpenPose tables: 17 limbs over 18 points, 20 hand bones, 68 face points", () => {
  assert.equal(LIMBS.length, 17);
  assert.equal(COLORS.length, 18);
  assert.ok(LIMBS.flat().every((i) => i >= 0 && i < 18));
  assert.equal(HAND_EDGES.length, 20);
  assert.equal(FACE_TEMPLATE.length, 68);
  // jaw runs from the figure's right (-X) to its left (+X); the chin (8) is the lowest jaw point
  assert.ok(FACE_TEMPLATE[0][0] < 0 && FACE_TEMPLATE[16][0] > 0);
  assert.ok(FACE_TEMPLATE.slice(0, 17).every((p) => p[1] >= FACE_TEMPLATE[8][1] - 1e-9));
  assert.ok(FACE_TEMPLATE.every((p) => p[2] > 0));            // all on the front of the head
  assert.deepEqual(hsvRgb(0), [255, 0, 0]);
});

test("drawing: black frame, one ellipse per visible limb, dots, hands and face", () => {
  const body = Array.from({ length: 18 }, (_, i) => [100 + i * 3, 50 + i * 5]);
  body[10] = null;                                                    // a hidden ankle drops its limb and its dot
  const hand = Array.from({ length: 21 }, (_, i) => [200 + i, 100 + i]);
  const ctx = fakeCtx();
  drawOpenPose(ctx, [{ body, hands: [hand, null], face: FACE_TEMPLATE.map((_, i) => [300 + i, 40]) }], 640, 360);
  assert.equal(ctx.calls[0][0], "fillRect");
  assert.equal(ctx.calls.filter((c) => c[0] === "ellipse").length, LIMBS.length - 1);
  assert.equal(ctx.calls.filter((c) => c[0] === "stroke").length, 20);
  assert.equal(ctx.calls.filter((c) => c[0] === "arc").length, 17 + 21 + 68);
});

test("the clay rig gives a sane skeleton through a camera", () => {
  const mesh = (geo) => new THREE.Mesh(geo);
  const g = buildHuman("man", 1.8, {}, mesh);
  g.position.set(0, 0, 0);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  cam.position.set(0, 1.2, 5); cam.lookAt(0, 1, 0); cam.updateMatrixWorld(true);
  const kp = personKeypoints(g, cam.position);
  assert.ok(kp.facing > 0.9, "the figure faces +Z, toward this camera");
  assert.ok(kp.body[0].y > kp.body[1].y && kp.body[1].y > kp.body[8].y && kp.body[8].y > kp.body[9].y && kp.body[9].y > kp.body[10].y);
  assert.ok(kp.body[2].x < 0 && kp.body[5].x > 0, "the right shoulder is on the figure's right (-X)");
  assert.equal(kp.hands.filter(Boolean).length, 2);
  assert.equal(kp.hands[0].length, 21);
  const px = toPixels(kp, cam, 640, 360);
  assert.ok(px.body.every(Boolean) && px.face?.length === 68);
  assert.ok(px.body[2][0] < px.body[5][0], "facing the camera, the right shoulder is on the image left");
  // seen from behind: no face, no nose or eyes
  cam.position.set(0, 1.2, -5); cam.lookAt(0, 1, 0); cam.updateMatrixWorld(true);
  const back = toPixels(personKeypoints(g, cam.position), cam, 640, 360);
  assert.equal(back.face, null);
  assert.equal(back.body[0], null);
  assert.equal(project(new THREE.Vector3(0, 1, -10), cam, 640, 360), null, "behind the camera");
});

test("pose sheet tile size and the Pose follow prompt", () => {
  assert.deepEqual(poseTile(1920, 1038), [832, 450]);
  assert.deepEqual(poseTile(640, 360), [640, 360]);
  const p = buildPosePrompt({ firstFrame: "soundstage/look_1.png [output]", sheet: "soundstage/pose_a.png [temp]",
    grid: { cols: 19, frames: 97, tile: [832, 450] }, prompt: "a dancer", width: 1920, height: 1038, frames: 97, quality: "Final", seed: 4 });
  assert.equal(p[1].class_type, "SoundstagePoseFollow");
  assert.equal(JSON.parse(p[1].inputs.grid).frames, 97);
  assert.equal(p[1].inputs.source, "");
  assert.equal(p[1].inputs.quality, "Final");
  assert.equal(p[2].class_type, "SaveVideo");
  const clip = buildPosePrompt({ firstFrame: "f [input]", source: "dance.mp4 [input]", width: 960, height: 512 });
  assert.equal(clip[1].inputs.source, "dance.mp4 [input]");
  assert.equal(clip[1].inputs.pose_sheet, "");
  assert.throws(() => buildPosePrompt({ firstFrame: "", sheet: "s" }), /Frame/);
  assert.throws(() => buildPosePrompt({ firstFrame: "f", width: 1, height: 1 }), /pose/);
});

test("the start frame reference and what Pose can't steer", () => {
  assert.equal(firstFrameRef({ file: { filename: "ComfyUI_temp_a.png", subfolder: "", type: "temp" } }), "ComfyUI_temp_a.png [temp]");
  assert.equal(firstFrameRef({ edited: "soundstage/look_still_x.png" }), "soundstage/look_still_x.png [input]");
  assert.equal(firstFrameRef(null, { look: "/api/view?filename=look_3.png&subfolder=soundstage&type=output" }), "soundstage/look_3.png [output]");
  assert.equal(firstFrameRef(null, {}), "");
  assert.deepEqual(nonPeople({ actors: [{ kind: "horse" }, { kind: "horse" }, { kind: "man" }, { kind: "sports_car" }, { kind: "tree", set_piece: true }] }),
    ["horses", "sports cars"]);
  assert.deepEqual(nonPeople({ actors: [{ kind: "woman" }] }), []);
});
