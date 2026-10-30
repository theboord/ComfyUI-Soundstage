// Pose in 3D: click a body part of the selected person and turn it with the rotate ring (chest, neck, head, shoulders,
// elbows, wrists, every finger knuckle, hips, knees), or drag the yellow dot on a hand or foot and the arm / leg follows
// (two-bone IK: the elbow / knee bends on its hinge, toward where it already points). Everything is written as pose
// keys at the playhead in the same plain-word degrees the Pose panel's sliders use, so sliders, gallery and 3D agree.
import * as THREE from "../vendor/three.module.min.mjs";
import { jointDegrees } from "./humans.mjs";
import { hingeFrame } from "./mocap.mjs";

const PEOPLE = new Set(["man", "woman", "child"]);
const IK = [   // effector handle -> chain (root, hinge, end), hinge sign (+1 elbow folds forward, -1 knee folds back)
  { id: "l_hand", root: "l_shoulder", mid: "l_elbow", end: "l_wrist", sign: 1 },
  { id: "r_hand", root: "r_shoulder", mid: "r_elbow", end: "r_wrist", sign: 1 },
  { id: "l_foot", root: "l_hip", mid: "l_knee", end: null, sign: -1 },
  { id: "r_foot", root: "r_hip", mid: "r_knee", end: null, sign: -1 },
];

export class PoseGizmo {
  constructor(stage) {
    this.stage = stage;
    this.active = false;
    this.joint = null;        // the joint id the rotate ring is on
    this.ik = null;           // an IK drag in progress
    this.group = new THREE.Group();
    this.group.visible = false;
    stage.gizmoScene.add(this.group);
    this.dots = new Map();    // id -> mesh
    const jointMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });
    const ikMat = new THREE.MeshBasicMaterial({ color: 0xf2ff59, depthTest: false, transparent: true, opacity: 0.95 });
    this._jointGeo = new THREE.SphereGeometry(0.022, 12, 8);
    this._ikGeo = new THREE.SphereGeometry(0.045, 16, 10);
    this._jointMat = jointMat; this._ikMat = ikMat;
  }

  person() {
    const id = this.stage.selected;
    const a = id && this.stage.state.actors.find((x) => x.id === id);
    const g = a && this.stage.actorMeshes.get(id);
    return a && g && PEOPLE.has(a.kind) && g.userData.joints ? { a, g, J: g.userData.joints } : null;
  }

  setActive(on) {
    this.active = !!on && !!this.person();
    if (!this.active) { this.joint = null; this.ik = null; }
    this.group.visible = this.active;
    this.stage._attachGizmo();
    this.update();
    this.stage.render();
    return this.active;
  }

  /** The object the transform gizmo should hold (a joint), or undefined when pose mode is not driving it. */
  target() {
    if (!this.active || !this.joint) return undefined;
    return this.person()?.J[this.joint];
  }

  /** Keep the dots on the joints (after every setFrame). */
  update() {
    const p = this.active && this.person();
    if (!p) { this.group.visible = false; return; }
    this.group.visible = true;
    p.g.updateMatrixWorld(true);
    const want = new Set();
    const s = (p.a.height_m || 1.8) / 1.8;
    for (const [id, j] of Object.entries(p.J)) {
      if (/_(1|2|3)$/.test(id) && !/_1$/.test(id)) continue;     // one dot per finger (its knuckle); click the finger itself for the rest
      want.add(id);
      let m = this.dots.get(id);
      if (!m) { m = new THREE.Mesh(this._jointGeo, this._jointMat.clone()); m.userData.poseJoint = id; m.renderOrder = 998; this.group.add(m); this.dots.set(id, m); }
      j.getWorldPosition(m.position);
      m.scale.setScalar(/_(thumb|index|middle|ring|pinky)_/.test(id) ? 0.45 * s : s);
      m.material.color.set(id === this.joint ? 0xf2ff59 : 0xffffff);
    }
    for (const c of IK) {
      want.add(c.id);
      let m = this.dots.get(c.id);
      if (!m) { m = new THREE.Mesh(this._ikGeo, this._ikMat); m.userData.poseIk = c.id; m.renderOrder = 999; this.group.add(m); this.dots.set(c.id, m); }
      m.position.copy(this._endPoint(p, c));
      m.scale.setScalar(s);
    }
    for (const [id, m] of this.dots) if (!want.has(id)) { this.group.remove(m); this.dots.delete(id); }
  }

  _endPoint(p, c) {
    if (c.end) return p.J[c.end].getWorldPosition(new THREE.Vector3());
    const hip = p.J[c.root], knee = p.J[c.mid];
    return knee.localToWorld(new THREE.Vector3(0, -hip.position.y - knee.position.y + 0.06 * ((p.a.height_m || 1.8) / 1.8), 0));
  }

  /** Pointer down in pose mode: a dot or a body part of the selected person. Returns true when it took the click. */
  pointerDown(e, ray) {
    const p = this.active && this.person();
    if (!p) return false;
    const dot = ray.intersectObjects([...this.dots.values()], false)[0]?.object;
    if (dot?.userData.poseIk) return this._startIk(p, dot.userData.poseIk, ray);
    if (dot?.userData.poseJoint) { this.pickJoint(dot.userData.poseJoint); return true; }
    const hit = ray.intersectObject(p.g, true)[0]?.object;
    if (!hit) return false;
    // The body part's own pivot: walk up from the mesh to the nearest joint group.
    const byObj = new Map(Object.entries(p.J).map(([id, j]) => [j, id]));
    for (let o = hit; o && o !== p.g; o = o.parent) if (byObj.has(o)) { this.pickJoint(byObj.get(o)); return true; }
    return false;
  }

  pickJoint(id) {
    this.joint = id;
    this.stage._attachGizmo();
    this.update();
    this.stage.onPoseJoint?.(id);
    this.stage.render();
  }

  /** The rotate ring moved the joint: store it as degrees at the playhead (the sliders follow). */
  fromGizmo() {
    const p = this.person(), j = this.target();
    if (!p || !j) return;
    this.stage._poseKeyHere(p.a).joints[this.joint] = jointDegrees(j).map((v) => Math.round(v * 10) / 10);
    this.stage.setFrame(this.stage.frame);
  }

  _startIk(p, id, ray) {
    const c = IK.find((x) => x.id === id);
    const end = this._endPoint(p, c);
    const n = this.stage._viewportCamera().getWorldDirection(new THREE.Vector3()).negate();
    this.ik = { c, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, end) };
    this.joint = null;
    this.stage._attachGizmo();
    return true;
  }

  pointerMove(ray) {
    const p = this.person();
    if (!this.ik || !p) return;
    const t = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this.ik.plane, t)) return;
    this._solve(p, this.ik.c, t);
  }

  pointerUp() {
    if (this.ik) { this.ik = null; this.stage.onChange(this.stage.toJSON()); }
  }

  /** Two-bone IK: place the hinge so the end reaches the target (or as close as the limb allows). */
  _solve(p, c, target) {
    const root = p.J[c.root], mid = p.J[c.mid];
    p.g.updateMatrixWorld(true);
    const R = root.getWorldPosition(new THREE.Vector3()), M = mid.getWorldPosition(new THREE.Vector3()), E = this._endPoint(p, c);
    const L1 = R.distanceTo(M), L2 = M.distanceTo(E);
    const toT = target.clone().sub(R);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    const dir = toT.normalize();
    // Bend plane: keep the hinge on the side it already bends toward (else the natural side: elbows back, knees forward).
    const body = p.g.getWorldQuaternion(new THREE.Quaternion());
    const natural = new THREE.Vector3(0, 0, c.sign > 0 ? -1 : 1).applyQuaternion(body);
    let pole = M.clone().sub(R).addScaledVector(dir, -M.clone().sub(R).dot(dir));
    // A straight limb has no bend side of its own, and a knee / elbow never folds the wrong way: unless the current
    // bend clearly agrees with anatomy (knees forward, elbows back), use the natural side.
    if (pole.length() < 0.15 * L1 || pole.dot(natural) < 0.25 * pole.length()) pole = natural.clone();
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-8) pole = new THREE.Vector3(1, 0, 0).applyQuaternion(body).cross(dir);
    pole.normalize();
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const A = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    const Mn = R.clone().addScaledVector(dir, Math.cos(A) * L1).addScaledVector(pole, Math.sin(A) * L1);
    const Tn = R.clone().addScaledVector(dir, d);
    // Upper bone frame from the new hinge position (bone +Y points back up the limb, Z toward the fold).
    const parentQ = root.parent.getWorldQuaternion(new THREE.Quaternion());
    const fb = new THREE.Vector3(0, 0, 1).applyQuaternion(body);
    const frame = hingeFrame(R.clone().sub(Mn), Tn.clone().sub(Mn), c.sign, fb);
    root.quaternion.copy(parentQ.invert().multiply(frame.q));
    const bend = Mn.clone().sub(R).angleTo(Tn.clone().sub(Mn));
    mid.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), c.sign > 0 ? -bend : bend);
    const key = this.stage._poseKeyHere(p.a).joints;
    key[c.root] = jointDegrees(root).map((v) => Math.round(v * 10) / 10);
    key[c.mid] = jointDegrees(mid).map((v) => Math.round(v * 10) / 10);
    this.stage.setFrame(this.stage.frame);
  }

  dispose() { this.stage.gizmoScene.remove(this.group); }
}
