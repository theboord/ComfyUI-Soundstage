// Shared fixtures for the foot grounding tests (footplant.test.mjs, footground.test.mjs): the real Rocketbox kits on
// a bare Stage, and PHYSICAL measures of the feet that do not trust the plan's own labels: every shoe vertex against
// the true ground under it on every frame (penetration, hovering, sliding while touching), the pelvis drop and the
// planted foot's distance to its target. Not a test file itself (no .test. in the name).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";

const RB = fileURLToPath(new URL("../../web/stage/people/rocketbox/", import.meta.url));
export const installed = existsSync(`${RB}Male_Adult_01.fbx`) && existsSync(`${RB}Female_Adult_01.fbx`) && existsSync(`${RB}anim/f_walk_neutral_01.max.fbx`);
export const NOT_INSTALLED = !installed && "Rocketbox files not installed (web/stage/people/rocketbox/)";

let _kits = null;
export async function realKits() {
  if (_kits) return _kits;
  globalThis.document ||= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
  const { FBXLoader } = await import("../../web/vendor/addons/FBXLoader.mjs");
  const parse = (f, manager) => { const b = readFileSync(RB + f); return new FBXLoader(manager).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), RB); };
  _kits = {};
  for (const [kind, spec] of Object.entries(C.ROCKETBOX)) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => C.tgaToPng(u, `${RB}tex/`));
    const clips = Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]]));
    _kits[kind] = A.buildKit(parse(`${spec.model}.fbx`, manager), clips);
    _kits[kind].spec = spec;
  }
  return _kits;
}

/** A bare Stage (no renderer) with these actors; options: setFx (floorAt), set boxes (colliders), frames. */
export function bareStage(actors, { frames = 121, setFx = null, boxes = null } = {}) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames, fps: 24 }, actors, shots: [{ id: "s" }], active_shot: "s" };
  st.actorMeshes = new Map();
  st.frame = 0;
  st.setFrame = () => A.avatarsAt(st);
  st.onChange = () => {}; st.toJSON = () => st.state;
  if (setFx) st.setFx = setFx;
  st.root = new THREE.Group();
  const cols = boxes || [];
  st._setCollidersCached = () => cols;   // stable, like the real cache
  return st;
}
export const clayOf = (st, a) => {
  const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
  g.position.set(...(a.keys?.[0]?.position || [0, 0, 0]));
  g.userData.actorId = a.id;
  st.actorMeshes.set(a.id, g);
  st.root.add(g);
  return g;
};

export async function setup(kind, actor, opts) {
  const K = await realKits();
  const st = bareStage([actor], opts);
  const g = clayOf(st, actor);
  st._loadKit = () => K[kind];
  A.attachKit(st, actor, g, K[kind]);
  await null;
  return st;
}

export const heightOf = (kind) => (kind === "man" ? 1.8 : 1.68);
export const walker = (kind, extra = {}, from = [-3, 0, 0], to = [3, 0, 0], frames = 120) => ({ id: `p_${kind}`, kind, height_m: heightOf(kind),
  position: from, keys: [{ frame: 0, position: from }, { frame: frames, position: to }], ...extra });

/** Every vertex the foot or the toe carries most, per side. */
export function shoeVerts(mesh) {
  const bones = mesh.skeleton.bones.map((b) => b.name), si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const out = { l: [], r: [] };
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    let best = -1, bw = 0;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    const n = bones[best] || "";
    if (/_L_(Foot|Toe0)$/.test(n)) out.l.push(i); else if (/_R_(Foot|Toe0)$/.test(n)) out.r.push(i);
  }
  return out;
}

/** The ground under (x, z) of a list of set boxes (axis aligned, quat identity) and a floor function. */
export const boxGround = (boxes, floor = () => 0) => (x, z) => {
  let y = Math.max(0, floor(x, z));
  for (const b of boxes) if (Math.abs(x - b.pos[0]) <= b.half[0] && Math.abs(z - b.pos[2]) <= b.half[2]) y = Math.max(y, b.pos[1] + b.half[1]);
  return y;
};

/**
 * Play a shot frame by frame (in `order`) and measure the shoes physically against ground(x, z), the true surface.
 * Per frame and foot: h (the lowest shoe vertex over the ground under it), pen (the same, the deepest), the plan's
 * state (or -1), the foot bone's world matrix, the distance of a planted foot bone to the plan's target (miss), and the
 * shoe vertices' world positions (for the slide measure). Per frame: the pelvis drop, shown, skipped.
 */
export function measure(st, a, { order = null, ground = () => 0 } = {}) {
  const g = st.actorMeshes.get(a.id), skin = g.userData.humanSkin;
  const verts = shoeVerts(skin.mesh), v = new THREE.Vector3(), fb = new THREE.Vector3();
  const n = st._lastFrame() + 1, rows = new Array(n);
  for (const f of order || [...Array(n).keys()]) {
    st.frame = f; A.avatarsAt(st);
    skin.holder.updateMatrixWorld(true);
    const plan = skin.feet?.plan;
    const row = { f, shown: skin.shown, drop: skin.footOut?.drop || 0, skip: !!plan?.skip?.[f] };
    for (const lr of ["l", "r"]) {
      const vs = verts[lr], P = new Float64Array(3 * vs.length), H = new Float64Array(vs.length);
      let lo = Infinity;
      for (let k = 0; k < vs.length; k++) {
        skin.mesh.getVertexPosition(vs[k], v).applyMatrix4(skin.mesh.matrixWorld);
        P[3 * k] = v.x; P[3 * k + 1] = v.y; P[3 * k + 2] = v.z;
        H[k] = v.y - ground(v.x, v.z);
        lo = Math.min(lo, H[k]);
      }
      const bone = skin.bones[lr === "l" ? "Bip01_L_Foot" : "Bip01_R_Foot"];
      const state = plan?.state?.[lr]?.[f] ?? -1;
      let miss = 0;
      if (state === 1) { bone.getWorldPosition(fb); miss = fb.distanceTo(new THREE.Vector3().fromArray(plan.pos[lr], 3 * f)); }
      row[lr] = { h: lo, state, miss, P, H, m: bone.matrixWorld.clone() };
    }
    rows[f] = row;
  }
  return { rows, skin, verts, n };
}

/**
 * Physical summary of a measured shot, over the frames the body is on its feet (shown, not skipped):
 *   pen     the deepest any shoe vertex goes under the ground (m, negative = under)
 *   slide   the most a shoe vertex TOUCHING the ground (within `touch`) on two frames in a row moves sideways (m/frame)
 *   hover   the highest the lowest shoe vertex sits over the ground on a frame the foot is low and slow (m)
 *   float   frames where neither foot touches the ground (within `touch`)
 *   drop    the most the pelvis comes down (m); miss: the most a planted foot bone misses its target (m)
 *   planted per foot, frames the plan labels planted
 */
export function physical(out, { touch = 0.005, low = 0.03, slow = 0.25, fps = 24, from = 0, to = Infinity } = {}) {
  const { rows } = out;
  const s = { pen: Infinity, slide: 0, slideAt: "", hover: 0, hoverAt: "", float: 0, floatAt: [], drop: 0, miss: 0, planted: { l: 0, r: 0 } };
  const live = (r) => r && r.shown && !r.skip && r.f >= from && r.f <= to;
  for (let f = 0; f < rows.length; f++) {
    const r = rows[f];
    if (!live(r)) continue;
    s.drop = Math.max(s.drop, r.drop);
    let touching = false;
    for (const lr of ["l", "r"]) {
      const c = r[lr];
      s.pen = Math.min(s.pen, c.h);
      s.miss = Math.max(s.miss, c.miss);
      if (c.state === 1) s.planted[lr]++;
      if (c.h < touch) touching = true;
      const p = rows[f - 1];
      if (!live(p)) continue;
      const q = p[lr];
      let lowestSpeed = Infinity;
      for (let k = 0; k < c.H.length; k++) {
        const d = Math.hypot(c.P[3 * k] - q.P[3 * k], c.P[3 * k + 2] - q.P[3 * k + 2]);
        if (c.H[k] < touch && q.H[k] < touch && d > s.slide) { s.slide = d; s.slideAt = `${lr} f${f}`; }
        if (c.H[k] < c.h + 0.003) lowestSpeed = Math.min(lowestSpeed, d * fps);
      }
      if (c.h < low && lowestSpeed < slow && c.h > s.hover) { s.hover = c.h; s.hoverAt = `${lr} f${f}`; }
    }
    if (!touching) { s.float++; s.floatAt.push(f); }
  }
  return s;
}

export const cm = (m) => (100 * m).toFixed(2);
export const fmt = (s) => `pen ${cm(s.pen)} cm, slide ${cm(s.slide)} cm/frame (${s.slideAt}), hover ${cm(s.hover)} cm (${s.hoverAt}), float ${s.float} frames, drop ${cm(s.drop)} cm, miss ${cm(s.miss)} cm, planted l ${s.planted.l} r ${s.planted.r}`;
