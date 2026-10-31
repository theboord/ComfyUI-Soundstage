// Soundstage selection feedback (Milestone 9), viewport only (never in captures or the LTX passes):
//   hover   a thin white outline on what the cursor would grab;
//   select  a crisp accent outline on the selected object, shown through anything in front of it;
//   ghost   a faint copy left where a dragged object started;
//   guides  snap lines (edge / centre alignment, the Shift axis lock).
// Outlines are a stencil silhouette: the object's meshes mark the stencil, then a hull pushed out by a few pixels in
// screen space is drawn where the stencil isn't marked. Proxies share the real meshes' geometry (and skeletons), so
// they cost no extra memory and follow every pose.
import * as THREE from "../vendor/three.module.min.mjs";

const HULL_VS = `
#include <common>
#include <skinning_pars_vertex>
uniform float uPx; uniform vec2 uRes;
void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  vec2 n2 = (projectionMatrix * vec4(normalMatrix * objectNormal, 0.0)).xy;
  float l = length(n2);
  if (l > 1e-5) clip.xy += n2 / l * uPx * 2.0 / uRes * clip.w;
  gl_Position = clip;
}`;
const MASK_VS = `
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}`;
const FLAT_FS = `uniform vec3 uColor; uniform float uOpacity; void main() { gl_FragColor = vec4(uColor, uOpacity); }`;

function hullMat(color, opacity, px, ref) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uPx: { value: px }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: HULL_VS, fragmentShader: FLAT_FS, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: ref, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
  });
}
function maskMat(ref) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0) }, uOpacity: { value: 0 } },
    vertexShader: MASK_VS, fragmentShader: FLAT_FS, colorWrite: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: ref, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp, stencilFail: THREE.ReplaceStencilOp,
  });
}

/** Proxies of every visible mesh of a group, sharing geometry (and skeletons), drawn with `mat`. */
function proxiesOf(group, mat, frozen = false) {
  const out = new THREE.Group();
  out.matrixAutoUpdate = false;
  out.matrixWorldAutoUpdate = false;
  const pairs = [];
  group.updateMatrixWorld(true);
  group.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || o.userData.noOutline) return;
    if (o.material?.transparent && o.material.opacity < 0.2) return;   // glass, beams
    let p;
    if (o.isSkinnedMesh && o.skeleton) {
      p = new THREE.SkinnedMesh(o.geometry, mat);
      p.bind(o.skeleton, o.bindMatrix);
      p.bindMode = o.bindMode;
    } else p = new THREE.Mesh(o.geometry, mat);
    p.matrixAutoUpdate = false;
    p.matrixWorldAutoUpdate = false;
    p.frustumCulled = false;
    p.matrixWorld.copy(o.matrixWorld);
    out.add(p);
    pairs.push([o, p]);
  });
  return { group: out, pairs, frozen, src: group };
}

export class Highlighter {
  constructor(stage) {
    this.s = stage;
    this.scene = new THREE.Scene();
    this.res = new THREE.Vector2(1, 1);
    this.mats = {
      selHull: hullMat(0xf2ff59, 0.95, 2.6, 1), selMask: maskMat(1),
      hovHull: hullMat(0xffffff, 0.55, 1.6, 2), hovMask: maskMat(2),
      ghost: new THREE.MeshBasicMaterial({ color: 0xf2ff59, transparent: true, opacity: 0.16, depthWrite: false }),
    };
    this.sel = null; this.hov = null; this.ghost = null;
    this.guides = new THREE.Group();
    this.scene.add(this.guides);
    this.enabled = true;
  }

  _sync(slot, id, key) {
    const g = id ? this.s.actorMeshes.get(id) : null;
    const cur = this[slot];
    if (cur && cur.src === g && cur.id === id && cur.n === this._count(g)) return cur;
    if (cur) this.scene.remove(cur.mask.group, cur.hull.group);
    if (!g) { this[slot] = null; return null; }
    const mask = proxiesOf(g, this.mats[`${key}Mask`]), hull = proxiesOf(g, this.mats[`${key}Hull`]);
    mask.group.renderOrder = slot === "sel" ? 10 : 20;
    hull.group.renderOrder = slot === "sel" ? 11 : 21;
    for (const p of mask.group.children) p.renderOrder = mask.group.renderOrder;
    for (const p of hull.group.children) p.renderOrder = hull.group.renderOrder;
    this.scene.add(mask.group, hull.group);
    return (this[slot] = { id, src: g, mask, hull, n: this._count(g) });
  }
  _count(g) { let n = 0; g?.traverseVisible((o) => { if (o.isMesh) n++; }); return n; }

  /** Leave a faint copy where `id` is now (null removes it). */
  setGhost(id) {
    if (this.ghost) { this.scene.remove(this.ghost.group); this.ghost = null; }
    const g = id && this.s.actorMeshes.get(id);
    if (g) { this.ghost = proxiesOf(g, this.mats.ghost, true); this.scene.add(this.ghost.group); }
  }

  /** Snap guides: [{axis: "x"|"z", at, span: [a, b] | null, y, lock}] (see manip.edgeSnap). */
  setGuides(list) {
    const key = JSON.stringify(list || []);
    if (key === this._gkey) return;
    this._gkey = key;
    for (const c of [...this.guides.children]) { c.geometry.dispose(); this.guides.remove(c); }
    for (const gd of list || []) {
      const span = gd.span || [-60, 60];
      const along = gd.lock ? (gd.lock === "x" ? [gd.through[0] - 60, gd.through[0] + 60] : [gd.through[2] - 60, gd.through[2] + 60]) : span;
      const pts = gd.lock
        ? (gd.lock === "x" ? [new THREE.Vector3(along[0], gd.y, gd.at), new THREE.Vector3(along[1], gd.y, gd.at)] : [new THREE.Vector3(gd.at, gd.y, along[0]), new THREE.Vector3(gd.at, gd.y, along[1])])
        : (gd.axis === "x" ? [new THREE.Vector3(gd.at, gd.y, span[0]), new THREE.Vector3(gd.at, gd.y, span[1])] : [new THREE.Vector3(span[0], gd.y, gd.at), new THREE.Vector3(span[1], gd.y, gd.at)]);
      const color = gd.lock ? (gd.lock === "x" ? 0xff5a5a : 0x5aa8ff) : 0xf2ff59;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: gd.lock ? 0.7 : 0.85, depthTest: false }));
      line.renderOrder = 30;
      this.guides.add(line);
    }
  }

  /** Draw on top of the finished viewport frame (call after the main render, before the gizmo). */
  render(renderer, cam, { hoverId = null, selectedId = null } = {}) {
    if (!this.enabled) return;
    const sel = this._sync("sel", selectedId, "sel");
    const hov = this._sync("hov", hoverId && hoverId !== selectedId ? hoverId : null, "hov");
    if (!sel && !hov && !this.ghost && !this.guides.children.length) return;
    renderer.getDrawingBufferSize(this.res);
    for (const m of [this.mats.selHull, this.mats.hovHull]) m.uniforms.uRes.value.copy(this.res);
    for (const slot of [sel, hov]) if (slot) for (const pr of [slot.mask, slot.hull]) for (const [o, p] of pr.pairs) {
      p.matrixWorld.copy(o.matrixWorld);
      p.visible = o.visible;
      if (p.isSkinnedMesh) { p.bindMatrix.copy(o.bindMatrix); p.bindMatrixInverse.copy(o.bindMatrixInverse); }
    }
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearStencil();
    renderer.render(this.scene, cam);
    renderer.autoClear = auto;
  }
}
