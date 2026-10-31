// Rows of seats as set dressing, merged into one mesh per colour (a cabin's 40 seat blocks in three draw calls).
// A seat block can be taken out (its vertices collapsed) when a seat-row object of the same kind stands on its slot:
// that object is the one the cast mounts with the stage's own seat logic (SEATS in library.mjs), so seated people,
// the clay and the passes all agree, and the set never doubles a row.
import * as THREE from "../../vendor/three.module.min.mjs";
import { Batch, keyedAt, mat } from "./common.mjs";

export class SeatBank {
  /** block(batch) adds one seat block at the origin (facing +Z) to a Batch; slots = [{x, z, ry}]. */
  constructor(kind, block, slots) {
    this.kind = kind;
    this.slots = slots;
    const proto = new Batch();
    block(proto);
    const parts = [...proto.parts.values()];
    this.meshes = [];
    this.ranges = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (const { color, opts, list } of parts) {
      const one = new Batch();
      for (const g of list) one.addMatrix(g, color, m.identity(), opts);
      const unit = one.build(new THREE.Group(), { shadows: true })[0].geometry;   // one block, one colour
      const n = unit.attributes.position.count;
      const pos = new Float32Array(n * 3 * slots.length), nor = new Float32Array(n * 3 * slots.length);
      const tmp = unit.clone();
      slots.forEach((s, i) => {
        tmp.copy(unit);
        tmp.applyMatrix4(m.compose(new THREE.Vector3(s.x, s.y || 0, s.z), q.setFromAxisAngle(up, s.ry || 0), new THREE.Vector3(1, 1, 1)));
        pos.set(tmp.attributes.position.array, i * n * 3);
        nor.set(tmp.attributes.normal.array, i * n * 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat(color, opts || undefined));
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.seatBank = kind;
      this.meshes.push({ mesh, base: pos.slice(), n });
      list.forEach((g) => g.dispose());
    }
    this.hidden = new Set();
  }
  addTo(group) { for (const { mesh } of this.meshes) group.add(mesh); return this; }
  /** Take out the blocks with an object of this kind standing within 0.35 m of their slot. */
  sync(actors, frame = 0) {
    const want = new Set();
    for (const a of actors || []) {
      if (a.kind !== this.kind) continue;
      const p = keyedAt(a, frame);
      this.slots.forEach((s, i) => { if (Math.hypot(p[0] - s.x, p[2] - s.z) < 0.35) want.add(i); });
    }
    if (want.size === this.hidden.size && [...want].every((i) => this.hidden.has(i))) return;
    this.hidden = want;
    for (const { mesh, base, n } of this.meshes) {
      const arr = mesh.geometry.attributes.position.array;
      arr.set(base);
      for (const i of want) arr.fill(0, i * n * 3, (i + 1) * n * 3);
      mesh.geometry.attributes.position.needsUpdate = true;
    }
  }
}
