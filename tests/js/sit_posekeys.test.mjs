// node --test tests/js/sit_posekeys.test.mjs
// Pose keys on a person in a timed sit (sit_spans) layer on the seated base (Maya S4, 2026-11-09): "Lean in" and
// "Thinking" keys on a seated woman had no effect, because a fully seated body was posed from the seated idle alone and
// the rig solved back from it. Now the upper-body joints a key names apply; the legs stay seated.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as SS from "../../web/stage/people/sitstand.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as O from "../../web/stage/people/onemotion.mjs";
import * as K from "./footkit.mjs";
import { applyJoints } from "../../web/stage/humans.mjs";

const fps = 24;

test("layerJoints seated: the upper-body joints a key names layer, the legs never do", () => {
  const joints = O.poseKeyJoints({ pose_keys: [{ frame: 0, joints: { spine: [20, 0, 0], neck: [10, 0, 0], l_elbow: [12, 0], l_hip: [30, 0, 0], r_knee: [40] } }] });
  assert.deepEqual([...O.layerJoints({ poseJoints: joints })].sort(), ["l_elbow", "l_hip", "neck", "r_knee", "spine"], "standing: all of them");
  assert.deepEqual([...O.layerJoints({ poseJoints: joints, seated: true, gazeKeyed: true })].sort(), ["head", "l_elbow", "neck", "spine"], "seated: no legs");
});

async function seated(kind, poseKeys) {
  const h = K.heightOf(kind);
  const person = { id: "p", name: "Jane Doe", kind, height_m: h, position: [-3, 0, 0.3], keys: [{ frame: 0, position: [-3, 0, 0.3] }] };
  const chair = { id: "c1", name: "chair", kind: "chair", height_m: 0.9, rotation_deg: -90, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = K.bareStage([person, chair], { frames: 241 });
  const g = K.clayOf(st, person);
  const cg = K.clayOf(st, chair); cg.rotation.y = -Math.PI / 2; cg.updateMatrixWorld(true);
  const kits = await K.realKits(); st._loadKit = () => kits[kind]; A.attachKit(st, person, g, kits[kind]); await null;
  st.frame = 0;
  const r = st.setPose("p", "sit", { on: "c1", at: "auto" });
  assert.equal(r.ok, true, r.error);
  if (poseKeys) person.pose_keys = poseKeys;
  return { st, person, g, w: SS.window(person.sit_spans[0], fps) };
}

const W = (b) => b.getWorldPosition(new THREE.Vector3());
for (const kind of ["woman", "man"]) {
  test(`real Rocketbox ${kind}: a Lean in key on the seated body leans the trunk in; legs and hips stay seated`, { skip: K.NOT_INSTALLED }, async () => {
    const base = await seated(kind, null);
    const f = base.w.seated + 20;
    const pose = (s) => {
      // stage.setFrame's Pose Studio pass (this bare stage has none): the keys on the clay joints, then the body
      s.st.frame = f;
      { const p = s.st._actorPosAt(s.person, f); s.g.position.set(p[0], s.st._heightAt(s.person, f), p[2]); s.g.rotation.set(0, s.st._headingAt(s.person, f), 0); s.g.updateMatrixWorld(true); }
      if (s.person.pose_keys) applyJoints(s.g, s.st.poseAt(s.person, f));
      A.avatarsAt(s.st);
      const B = s.g.userData.humanSkin.bones;
      return { head: W(B.Bip01_Head), neck: W(B.Bip01_Neck), lThigh: W(B.Bip01_L_Thigh), lCalf: W(B.Bip01_L_Calf), lFoot: W(B.Bip01_L_Foot), rFoot: W(B.Bip01_R_Foot),
               owner: s.g.userData.humanSkin.owner };
    };
    const p0 = pose(base);
    assert.equal(p0.owner, "seat");
    const keyed = await seated(kind, [{ frame: f - 10, joints: { spine: [20, 0, 0], neck: [10, 0, 0], l_hip: [80, 0, 0], l_knee: [0] } }]);
    const p1 = pose(keyed);
    assert.equal(p1.owner, "seat");
    // the chair faces -X: leaning in moves the head toward -X (forward, over the knees)
    assert.ok(p1.head.x < p0.head.x - 0.04, `${kind}: the head leans forward ${(100 * (p0.head.x - p1.head.x)).toFixed(1)} cm`);
    for (const k of ["lThigh", "lCalf", "lFoot", "rFoot"]) {
      assert.ok(p1[k].distanceTo(p0[k]) < 0.005, `${kind}: ${k} stays seated (moved ${(100 * p1[k].distanceTo(p0[k])).toFixed(2)} cm; the leg keys are ignored seated)`);
    }
  });
}
