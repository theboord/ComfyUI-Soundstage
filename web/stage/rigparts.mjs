// Parts for horses and props (Milestone 26), driven by the channels in objparts.mjs.
//
// Horse (the rigged CC0 horse): head up / down and turn, neck arch, tail lift and swish, laid on top of whatever the
// gait clip (or the gait planner, web/stage/gait.mjs) posed this frame. Each offset is a rotation about the HORSE's
// own axes (its left = +X, up = +Y) at that bone, converted into the bone's local space, so it reads the same whatever
// way the GLB's bones are oriented. Gait override: Auto picks Idle / Walk / Gallop by speed (stage._driveHorse);
// a forced gait picks the clip and its rate here. When the gait planner is driving the horse (R.gait), the override
// is left to it (it reads a.parts.gait).
//
// Props: a pivot point (the object turns about it, Maya-style: T * P * R * P^-1), finish (roughness / metalness),
// glow (emissive), and rotation offsets on the named parts of an imported model ("sub:<name>:rx").
import * as THREE from "../vendor/three.module.min.mjs";
import { partAt } from "./objparts.mjs";

const DEG = Math.PI / 180;
const FINISH = { matte: [0.9, 0], satin: [0.5, 0.1], gloss: [0.15, 0.05], metallic: [0.3, 0.85], chrome: [0.04, 1] };

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _ax = new THREE.Vector3();

/** Rotate a bone by `rad` about a world axis through its own pivot. */
function turnBone(bone, axisWorld, rad) {
  if (!bone || !rad) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_pq);
  _ax.copy(axisWorld).applyQuaternion(_pq.clone().invert()).normalize();
  _q.setFromAxisAngle(_ax, rad);
  bone.quaternion.premultiply(_q);
  bone.updateMatrixWorld(true);
}

const horse = {
  bones(R) {
    if (R.partBones) return R.partBones;
    const by = {};
    R.holder.traverse((o) => { if (o.isBone) by[o.name] = o; });
    R.partBones = { neck: ["Neck1", "Neck2", "Neck3"].map((n) => by[n]).filter(Boolean), head: by.Head,
      tail: ["Tail1", "Tail2", "Tail3", "Tail4", "Tail5", "Tail6", "Tail7"].map((n) => by[n]).filter(Boolean) };
    return R.partBones;
  },
  apply(st, a, g) {
    const R = g.userData.horseRig;
    if (!R) return;
    const f = st.frame, fps = st.state.shot?.fps || 24, t = f / fps;
    const v = (ch) => partAt(a, ch, f) || 0;
    const gait = partAt(a, "gait", f) || "auto";
    if (gait !== "auto" && !R.gait && R.actions) {
      // Forced gait: the clip, and a cycle rate so the hooves cover the ground at that gait's natural speed.
      const clip = { idle: "Idle", walk: "Walk", trot: "Walk", canter: "Gallop", gallop: "Gallop" }[gait];
      const rate = { idle: 1, walk: 1, trot: 1.8, canter: 0.75, gallop: 1 }[gait];
      for (const [n, act] of Object.entries(R.actions)) {
        act.enabled = n === clip;
        act.setEffectiveWeight(n === clip ? 1 : 0);
        if (n === clip) act.time = ((t * rate) % (act.getClip().duration || 1));
      }
      R.mixer.update(0);
    }
    const hp = v("head_pitch"), hy = v("head_yaw"), nk = v("neck"), tl = v("tail_lift"), sw = v("tail_swish");
    if (!hp && !hy && !nk && !tl && !sw) return;
    g.updateMatrixWorld(true);
    const B = horse.bones(R);
    const gq = g.getWorldQuaternion(new THREE.Quaternion());
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(gq), up = new THREE.Vector3(0, 1, 0).applyQuaternion(gq);
    // Neck arch spread down the neck; head pitch mostly at the poll; the turn shared neck / head.
    for (const [i, b] of B.neck.entries()) {
      turnBone(b, side, -(nk / B.neck.length) * DEG - (hp * 0.35 / B.neck.length) * DEG);
      turnBone(b, up, (hy * 0.6 / B.neck.length) * DEG * (i + 1) / 2);
    }
    turnBone(B.head, side, -hp * 0.65 * DEG);
    turnBone(B.head, up, hy * 0.25 * DEG);
    if (B.tail.length) {
      turnBone(B.tail[0], side, -tl * DEG);
      if (sw) B.tail.slice(1, 6).forEach((b, i) => turnBone(b, up, sw * 22 * DEG * Math.sin(t * 2 * Math.PI * 1.1 - i * 0.6) / 3));
    }
  },
};

const prop = {
  apply(st, a, g) {
    const f = st.frame;
    // Named parts of an imported model, found once.
    if (!g.userData.subpartsScanned) {
      g.userData.subpartsScanned = true;
      if (a.kind === "glb" || a.kind === "custom") {
        const parts = {};
        g.traverse((o) => {
          if (o === g || !o.name || Object.keys(parts).length >= 24 || /^(Scene|RootNode|Root|AuxScene)$/i.test(o.name)) return;
          if (!(o.isMesh || o.children.length)) return;
          if (!parts[o.name]) parts[o.name] = { o, q0: o.quaternion.clone() };
        });
        if (Object.keys(parts).length > 1) g.userData.subparts = parts;
      }
    }
    for (const [name, sp] of Object.entries(g.userData.subparts || {})) {
      const rx = partAt(a, `sub:${name}:rx`, f) || 0, ry = partAt(a, `sub:${name}:ry`, f) || 0, rz = partAt(a, `sub:${name}:rz`, f) || 0;
      sp.o.quaternion.copy(sp.q0);
      if (rx || ry || rz) sp.o.quaternion.multiply(_q.setFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG, "YXZ")));
    }
    // Finish and glow on this object's own material copies.
    const fin = partAt(a, "finish", f) || "factory", glow = partAt(a, "glow", f) || 0;
    const key = `${fin}|${glow}`;
    if (key !== g.userData.partsMatKey && (fin !== "factory" || glow || g.userData.partsMats)) {
      g.userData.partsMatKey = key;
      if (!g.userData.partsMats) {
        const map = new Map();
        g.traverse((o) => {
          if (!o.isMesh || o.userData.glass || !o.material?.isMeshStandardMaterial) return;
          if (!map.has(o.material)) { const c = o.material.clone(); c.userData.base = { r: c.roughness, m: c.metalness, e: c.emissive.clone(), ei: c.emissiveIntensity, col: c.color.clone() }; map.set(o.material, c); }
          o.material = map.get(o.material);
        });
        g.userData.partsMats = [...map.values()];
      }
      for (const m of g.userData.partsMats) {
        const b = m.userData.base, fn = FINISH[fin];
        m.roughness = fn ? fn[0] : b.r; m.metalness = fn ? fn[1] : b.m;
        if (glow > 0) { m.emissive.copy(b.col); m.emissiveIntensity = glow; m.allowOverride = glow < 0.5; }
        else { m.emissive.copy(b.e); m.emissiveIntensity = b.ei; m.allowOverride = true; }
      }
    }
    // Pivot: turn about a point other than the origin (the world position of the origin moves, as in Maya).
    const px = partAt(a, "pivot_x", f) || 0, py = partAt(a, "pivot_y", f) || 0, pz = partAt(a, "pivot_z", f) || 0;
    if (px || py || pz) {
      const p = new THREE.Vector3(px, py, pz).multiply(g.scale);
      const shift = p.clone().sub(p.clone().applyQuaternion(g.quaternion));
      g.position.add(shift);
      g.userData.pivotShift = shift;
    } else delete g.userData.pivotShift;
  },
};

export { horse, prop };
