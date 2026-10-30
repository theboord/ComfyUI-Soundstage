// Camera move visualisation for the stage (Higgsfield-3D-Jutsu style):
//   CameraViz - the shot camera's path (coloured by time), numbered key diamonds, blue start/end arrows,
//               the lens frustum at the playhead and an eye-height tick to the floor.
//   PipViewer - a small shot-camera monitor docked bottom-left while you fly around in Free view,
//               with play/pause, scrub and "expand" (switch to Shot cam).
//
// Both draw after the stage's main pass via a per-instance wrapper around stage._renderMode, and
// only when forCapture is false, so they never appear in clay/depth/ID/colour captures or sprite
// sheets. The CameraViz overlay is a scene of its own drawn on top of everything (like the gizmo).

import * as THREE from "../vendor/three.module.min.mjs";
import { TOKENS } from "../ui/theme.mjs";
import { icon } from "../ui/icons.mjs";

const MAX_SEGMENTS = 200;
const COLORS = {
  accent: new THREE.Color(TOKENS.accent),   // playhead frustum
  pathStart: new THREE.Color("#ddd3ff"),    // soft violet, light at the start of the move ...
  pathEnd: new THREE.Color("#8b6cff"),      // ... deeper at the end
  key: new THREE.Color("#efe9ff"),
  keyCam: new THREE.Color("#c9bcff"),       // camera models at the keys (the one at the playhead: accent)
  arrow: new THREE.Color("#5aa9ff"),        // Jutsu-style blue start / end handles
  tick: new THREE.Color("#c9c3d6"),
  bg: new THREE.Color(TOKENS.bg),
};
const SENSOR_W_MM = 36;
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- render hook (shared, per stage)
/**
 * Run `fn(mode, viewCam)` after every viewport render of this stage (never for captures).
 * Lower `order` runs first. Returns an unhook function.
 */
function onAfterRender(stage, order, fn) {
  if (!stage.__ssAfterRender) {
    const list = [];
    const orig = stage._renderMode;
    stage._renderMode = function (mode, forCapture = false) {
      const r = orig.call(this, mode, forCapture);
      if (!forCapture && mode !== "id") {
        const cam = this._viewportCamera?.() || this.camera;
        for (const h of list) {
          try { h.fn(mode, cam); } catch (e) { console.warn("Soundstage camviz:", e); }
        }
      }
      return r;
    };
    stage.__ssAfterRender = { list, orig };
  }
  const entry = { order, fn };
  const { list } = stage.__ssAfterRender;
  list.push(entry);
  list.sort((a, b) => a.order - b.order);
  return () => {
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) { stage._renderMode = stage.__ssAfterRender.orig; delete stage.__ssAfterRender; }
  };
}

const overlayMat = (props) => ({ depthTest: false, depthWrite: false, transparent: true, ...props });

function label(text, { color = "#f0efed", bg = "rgba(33,25,39,0.78)", h = 0.032 } = {}) {
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  g.font = "600 34px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = Math.max(48, w); c.height = 48;
  g.font = "600 34px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
  g.fillStyle = bg;
  const r = 20;
  g.beginPath(); g.roundRect(0, 0, c.width, c.height, r); g.fill();
  g.fillStyle = color; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial(overlayMat({ map: tex, sizeAttenuation: false })));
  s.scale.set((h * c.width) / c.height, h, 1);
  s.center.set(0.5, -0.35); // sit just above its anchor point
  s.renderOrder = 10;
  return s;
}

/** Linear interpolation through sampled points, as a Curve for TubeGeometry. */
class Polyline extends THREE.Curve {
  constructor(points) { super(); this.points = points; }
  getPoint(t, out = new THREE.Vector3()) {
    const n = this.points.length - 1, x = Math.min(n, Math.max(0, t * n)), i = Math.min(n - 1, Math.floor(x));
    return out.copy(this.points[i]).lerp(this.points[i + 1], x - i);
  }
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of [].concat(o.material || [])) { m.map?.dispose?.(); m.dispose?.(); }
  });
}

// ---------------------------------------------------------------- key cameras
// A small film camera at a camera key: body (each face its own shade: the overlay has no lights), lens, two reels
// on top and a short frustum in the shot's aspect with an "up" tick. Unit size, looking down -Z with +Y up, like a
// THREE camera; CameraViz scales it per render. Viewport-only: it lives in the CameraViz overlay scene.
const FACE_SHADE = [0.8, 0.62, 1, 0.45, 0.7, 0.9]; // BoxGeometry groups: +x -x +y -y +z (back) -z (front)
const KEYCAM_FRUSTUM = 1.25;                         // frustum depth in model units

/** Half width / half height of the key camera's frustum end, in model units (36 mm sensor). */
export function keyCamFrustum(focal_mm, aspect, depth = KEYCAM_FRUSTUM) {
  const x = ((SENSOR_W_MM / 2) / Math.max(1, focal_mm || 35)) * depth;
  return { x, y: x / Math.max(0.1, aspect || 16 / 9) };
}

/** Smallest world size (m) of a key camera for a camera move / scene this many metres across. */
export function keyCamBase(span) {
  return Math.min(1.5, Math.max(0.25, (Number.isFinite(span) ? span : 0) * 0.04));
}

/** Index of the key at the playhead, or else the nearest one in time (the earlier on a tie); -1 when none. */
export function nearestKey(keys, frame) {
  let best = -1, bd = Infinity;
  (keys || []).forEach((k, i) => { const d = Math.abs(k.frame - frame); if (d < bd) { bd = d; best = i; } });
  return best;
}

function keyCamModel(focal_mm, aspect) {
  const g = new THREE.Group();
  const solid = () => new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: true });
  const faces = FACE_SHADE.map(solid);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.56, 0.8), faces);
  body.position.z = 0.52;
  const lensMat = new THREE.MeshBasicMaterial({ color: 0x2a2233, depthTest: true, depthWrite: true });
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.32, 18).rotateX(Math.PI / 2), lensMat);
  lens.position.z = -0.04;
  const reelMats = [solid(), solid()];
  const reelGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.08, 22).rotateZ(Math.PI / 2);
  const reels = reelMats.map((m, i) => { const r = new THREE.Mesh(reelGeo, m); r.position.set(0, 0.5, 0.3 + i * 0.44); return r; });
  for (const o of [body, lens, ...reels]) o.renderOrder = 3;
  // Frustum from the lens front to a frame in the shot's aspect, with a faint fill and an up tick.
  const z0 = -0.2, z = z0 - KEYCAM_FRUSTUM, { x, y } = keyCamFrustum(focal_mm, aspect);
  const v = [[0, 0, z0, x, y, z], [0, 0, z0, -x, y, z], [0, 0, z0, -x, -y, z], [0, 0, z0, x, -y, z],
    [x, y, z, -x, y, z], [-x, y, z, -x, -y, z], [-x, -y, z, x, -y, z], [x, -y, z, x, y, z]].flat();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  const lineMat = new THREE.LineBasicMaterial(overlayMat({ color: 0xffffff, opacity: 0.8 }));
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  const fillMat = new THREE.MeshBasicMaterial(overlayMat({ color: 0xffffff, opacity: 0.07, side: THREE.DoubleSide }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(2 * x, 2 * y), fillMat);
  fill.position.z = z;
  fill.raycast = () => {}; // clicks go to the camera body, not the big frame in front of it
  const triGeo = new THREE.BufferGeometry();
  triGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-x * 0.3, y * 1.06, z, x * 0.3, y * 1.06, z, 0, y * 1.4, z]), 3));
  const triMat = new THREE.MeshBasicMaterial(overlayMat({ color: 0xffffff, side: THREE.DoubleSide, opacity: 0.9 }));
  const tri = new THREE.Mesh(triGeo, triMat);
  tri.raycast = () => {};
  for (const o of [lines, fill, tri]) o.renderOrder = 4;
  g.add(body, lens, ...reels, lines, fill, tri);
  g.userData.mats = { faces, reels: reelMats, lines: lineMat, fill: fillMat, tri: triMat };
  g.userData.hot = null;
  paintKeyCam(g, false);
  return g;
}

function paintKeyCam(g, hot) {
  if (g.userData.hot === hot) return;
  g.userData.hot = hot;
  const base = hot ? COLORS.accent : COLORS.keyCam;
  const { faces, reels, lines, fill, tri } = g.userData.mats;
  faces.forEach((m, i) => m.color.copy(base).multiplyScalar(FACE_SHADE[i]));
  for (const m of reels) m.color.copy(base).multiplyScalar(0.72);
  for (const m of [lines, fill, tri]) m.color.copy(base);
  lines.opacity = hot ? 1 : 0.75;
  fill.opacity = hot ? 0.16 : 0.06;
}

// ---------------------------------------------------------------- CameraViz
export class CameraViz {
  /**
   * @param stage  the Stage
   * @param opts.showInShot  also draw the path / keys when looking through the shot camera (default false)
   * @param opts.replaceHelper  hide the stage's plain CameraHelper while mounted (default true)
   * @param opts.keyCams  draw a little camera at every camera key in Free view (default true)
   * @param opts.onKeyClick  called with (frame, index) when a key camera is clicked in Free view
   *                         (default: jump the stage's playhead there)
   */
  constructor(stage, { showInShot = false, replaceHelper = true, keyCams = true, onKeyClick = null } = {}) {
    this.stage = stage;
    this.showInShot = showInShot;
    this.visible = true;
    this.keyCamsOn = !!keyCams;
    this.onKeyClick = onKeyClick;
    this.keyCams = [];
    this.scene = new THREE.Scene(); // overlay scene, drawn on top after the main pass
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.pathGroup = new THREE.Group();
    this.root.add(this.pathGroup);
    this._sig = "";
    this._frame = -1;
    this._buildPlayhead();
    if (replaceHelper && stage.camHelper) { this._helper = stage.camHelper; stage.camHelper.layers.set(31); }
    this._unhook = onAfterRender(stage, 10, (mode, cam) => this._draw(mode, cam));
    // Click a key camera (Free view) = jump the playhead to that key. Capture phase, so the stage's own
    // pointerdown (select / orbit) never sees that click.
    this._onDown = (e) => this._pickKeyCam(e);
    stage.canvas?.addEventListener?.("pointerdown", this._onDown, true);
  }

  /** Show / hide the camera models at the keys (the path, diamonds and playhead frustum stay). */
  setKeyCams(on) {
    this.keyCamsOn = !!on;
    this.stage.render();
  }

  /** Call after camera keys, the frame or the active shot change (it also self-syncs on every render). */
  update() {
    this._sync(true);
    this.stage.render();
  }

  setVisible(on) {
    this.visible = !!on;
    this.stage.render();
  }

  setShowInShot(on) {
    this.showInShot = !!on;
    this.stage.render();
  }

  dispose() {
    this._unhook?.();
    this.stage.canvas?.removeEventListener?.("pointerdown", this._onDown, true);
    if (this._helper) this._helper.layers.set(0);
    disposeTree(this.scene);
    this.stage.render();
  }

  /** Key camera under a pointer event (Free view only): {frame, i} or null. */
  _keyCamAt(e) {
    const st = this.stage;
    if (!this.visible || !this.keyCamsOn || !st.freeView || !this.keyCams.length) return null;
    const cv = st.canvas, r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cam = st._viewportCamera?.() || st.camera;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1), cam);
    let o = ray.intersectObjects(this.keyCams, true).find((h) => h.object.isMesh)?.object || null;
    while (o && o.userData.keyFrame === undefined) o = o.parent;
    if (o) return { frame: o.userData.keyFrame, i: o.userData.keyIndex };
    // Far away the model is a few pixels: a click within 14 px of its centre still counts.
    let best = null, bd = 14;
    const v = new THREE.Vector3();
    for (const g of this.keyCams) {
      v.copy(g.position).project(cam);
      if (v.z > 1 || v.z < -1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * r.width - px, ((1 - v.y) / 2) * r.height - py);
      if (d < bd) { bd = d; best = { frame: g.userData.keyFrame, i: g.userData.keyIndex }; }
    }
    return best;
  }

  _pickKeyCam(e) {
    if (e.button !== 0 || e.altKey || e.shiftKey) return;
    const hit = this._keyCamAt(e);
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (this.onKeyClick) this.onKeyClick(hit.frame, hit.i);
    else this.stage.setFrame(hit.frame);
  }

  // ---- building
  _signature() {
    const st = this.stage;
    return [st.activeShot?.()?.id, st._lastFrame(), st.fw, st.fh, JSON.stringify(st._camKeys())].join("|");
  }

  _sync(force = false) {
    const sig = this._signature();
    if (force || sig !== this._sig) { this._sig = sig; this._rebuildPath(); this._frame = -1; }
    if (this._frame !== this.stage.frame) { this._frame = this.stage.frame; this._recolor(); }
  }

  _rebuildPath() {
    for (const c of [...this.pathGroup.children]) { this.pathGroup.remove(c); disposeTree(c); }
    const st = this.stage, last = st._lastFrame(), keys = st._camKeys();
    const step = Math.max(1, Math.ceil(last / MAX_SEGMENTS));
    const frames = [];
    for (let f = 0; f < last; f += step) frames.push(f);
    frames.push(last);
    this._frames = frames;
    const pts = frames.map((f) => new THREE.Vector3(...st._cameraAt(f).position));
    this._pts = pts;
    const moving = pts.some((p) => p.distanceToSquared(pts[0]) > 1e-6);

    // Thin 1px line (always readable from far away) + a slim tube for body up close.
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    lineGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3));
    this.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial(overlayMat({ vertexColors: true, opacity: 0.95 })));
    this.line.renderOrder = 2;
    this.pathGroup.add(this.line);
    this.tube = null;
    if (moving && pts.length > 1) {
      this._radial = 6;
      const tubeGeo = new THREE.TubeGeometry(new Polyline(pts), pts.length - 1, 0.026, this._radial, false);
      tubeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(tubeGeo.attributes.position.count * 3), 3));
      this.tube = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial(overlayMat({ vertexColors: true, opacity: 0.85 })));
      this.tube.renderOrder = 1;
      this.pathGroup.add(this.tube);
    }

    // Key diamonds with their numbers, and a little camera at every key (where it stands, where it looks).
    this.keyMarks = [];
    this.keyTags = [];
    this.keyCams = [];
    const diamondGeo = new THREE.OctahedronGeometry(1, 0);
    const aspect = st.fw / Math.max(1, st.fh), look = new THREE.Matrix4();
    let lo = null, hi = null;
    keys.forEach((k, i) => {
      const c = st._cameraAt(k.frame);
      const m = new THREE.Mesh(diamondGeo, new THREE.MeshBasicMaterial(overlayMat({ color: COLORS.key, opacity: 0.95 })));
      m.position.set(...c.position);
      m.scale.set(0.7, 1, 0.7);
      m.renderOrder = 5;
      m.userData.base = 1;
      const tag = label(String(i + 1));
      tag.position.copy(m.position);
      const kc = keyCamModel(c.focal_mm, aspect);
      kc.position.copy(m.position);
      const tgt = new THREE.Vector3(...c.target);
      if (tgt.distanceToSquared(kc.position) > 1e-8) kc.quaternion.setFromRotationMatrix(look.lookAt(kc.position, tgt, UP));
      kc.userData.keyFrame = k.frame;
      kc.userData.keyIndex = i;
      this.pathGroup.add(m, kc, tag);
      this.keyMarks.push(m);
      this.keyTags.push(tag);
      this.keyCams.push(kc);
      lo = lo ? lo.min(kc.position) : kc.position.clone();
      hi = hi ? hi.max(kc.position) : kc.position.clone();
    });
    // Smallest size of a key camera: grows with how far the keys are spread (a car chase vs. a close-up).
    for (const p of pts) { lo = lo ? lo.min(p) : p.clone(); hi = hi ? hi.max(p) : p.clone(); }
    this._keyCamBase = keyCamBase(lo && hi ? hi.clone().sub(lo).length() : 0);

    // Blue start / end arrows along the direction of travel.
    this.arrows = [];
    if (moving) {
      const dirAt = (a, b) => b.clone().sub(a).normalize();
      let i1 = 1; while (i1 < pts.length - 1 && pts[i1].distanceToSquared(pts[0]) < 1e-6) i1++;
      let i0 = pts.length - 2; while (i0 > 0 && pts[i0].distanceToSquared(pts.at(-1)) < 1e-6) i0--;
      this.arrows.push(this._arrow(pts[0], dirAt(pts[0], pts[i1]), false));
      this.arrows.push(this._arrow(pts.at(-1), dirAt(pts[i0], pts.at(-1)), true));
      this.pathGroup.add(...this.arrows);
    }
  }

  /** Arrow group: a unit-size shaft + head along +Y, rotated to `dir`; tipAtPoint puts the tip on `p`. */
  _arrow(p, dir, tipAtPoint) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial(overlayMat({ color: COLORS.arrow, opacity: 0.95 }));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.2, 10), mat);
    shaft.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 14), mat);
    head.position.y = 1.55;
    for (const m of [shaft, head]) { m.renderOrder = 6; if (tipAtPoint) m.position.y -= 1.9; }
    g.add(shaft, head);
    g.position.copy(p);
    g.quaternion.setFromUnitVectors(UP, dir);
    g.userData.base = 1;
    return g;
  }

  _buildPlayhead() {
    // Frustum in camera space (looking -Z), unit length; scaled per render so it stays readable.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    this.frustum = new THREE.LineSegments(geo, new THREE.LineBasicMaterial(overlayMat({ color: COLORS.accent })));
    this.frustum.renderOrder = 8;
    const triGeo = new THREE.BufferGeometry();
    triGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    this.upTri = new THREE.Mesh(triGeo, new THREE.MeshBasicMaterial(overlayMat({ color: COLORS.accent, side: THREE.DoubleSide, opacity: 0.9 })));
    this.upTri.renderOrder = 8;
    this.cam = new THREE.Group();
    this.cam.add(this.frustum, this.upTri);
    // Eye-height tick: a line to the floor, a floor ring and a height label.
    const tickGeo = new THREE.BufferGeometry();
    tickGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    this.tick = new THREE.LineSegments(tickGeo, new THREE.LineDashedMaterial(overlayMat({ color: COLORS.tick, dashSize: 0.08, gapSize: 0.06, opacity: 0.8 })));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial(overlayMat({ color: COLORS.tick, side: THREE.DoubleSide, opacity: 0.6 })));
    this.root.add(this.cam, this.tick, this.ring);
    this._heightLabel = null;
    this._heightText = "";
  }

  _recolor() {
    if (!this._frames) return;
    const f = this.stage.frame, last = Math.max(1, this.stage._lastFrame());
    const c = new THREE.Color();
    const colorAt = (fr) => {
      c.copy(COLORS.pathStart).lerp(COLORS.pathEnd, fr / last);
      if (fr > f) c.lerp(COLORS.bg, 0.55); // the part still to come is dimmer
      return c;
    };
    const lc = this.line.geometry.attributes.color;
    this._frames.forEach((fr, i) => { colorAt(fr); lc.setXYZ(i, c.r, c.g, c.b); });
    lc.needsUpdate = true;
    if (this.tube) {
      const tc = this.tube.geometry.attributes.color, ring = this._radial + 1;
      for (let i = 0; i < this._frames.length; i++) {
        colorAt(this._frames[i]);
        for (let j = 0; j < ring; j++) tc.setXYZ(i * ring + j, c.r, c.g, c.b);
      }
      tc.needsUpdate = true;
    }
  }

  // ---- per render
  _draw(mode, viewCam) {
    const st = this.stage;
    const show = this.visible && (st.freeView || this.showInShot);
    if (!show) return;
    this._sync();
    const free = !!st.freeView;
    // Playhead camera = what the shot camera really is now (includes a live VCam preview).
    const sc = st.camera;
    sc.updateMatrixWorld();
    const pos = sc.position;
    const dist = (p) => Math.max(0.5, viewCam.position.distanceTo(p));

    this.cam.visible = this.tick.visible = this.ring.visible = free;
    if (free) {
      const aspect = st.fw / st.fh;
      const halfH = Math.tan(THREE.MathUtils.degToRad(sc.fov) / 2), halfW = halfH * aspect;
      const L = THREE.MathUtils.clamp(dist(pos) * 0.09, 0.35, 4);
      const x = halfW * L, y = halfH * L, z = -L;
      const P = this.frustum.geometry.attributes.position;
      const v = [[0, 0, 0, x, y, z], [0, 0, 0, -x, y, z], [0, 0, 0, -x, -y, z], [0, 0, 0, x, -y, z],
        [x, y, z, -x, y, z], [-x, y, z, -x, -y, z], [-x, -y, z, x, -y, z], [x, -y, z, x, y, z]];
      v.forEach((s, i) => { P.setXYZ(i * 2, s[0], s[1], s[2]); P.setXYZ(i * 2 + 1, s[3], s[4], s[5]); });
      P.needsUpdate = true;
      this.frustum.geometry.computeBoundingSphere();
      const T = this.upTri.geometry.attributes.position;
      T.setXYZ(0, -x * 0.35, y * 1.08, z); T.setXYZ(1, x * 0.35, y * 1.08, z); T.setXYZ(2, 0, y * 1.45, z);
      T.needsUpdate = true;
      this.upTri.geometry.computeBoundingSphere();
      this.cam.position.copy(pos);
      this.cam.quaternion.copy(sc.quaternion);

      const tp = this.tick.geometry.attributes.position;
      tp.setXYZ(0, pos.x, pos.y, pos.z); tp.setXYZ(1, pos.x, 0, pos.z); tp.needsUpdate = true;
      this.tick.computeLineDistances();
      this.tick.geometry.computeBoundingSphere();
      const rs = dist(pos) * 0.012;
      this.ring.position.set(pos.x, 0.002, pos.z);
      this.ring.scale.setScalar(rs * 1.6);
      const focal = (SENSOR_W_MM / 2) / halfW;
      const text = `${pos.y.toFixed(2)} m · ${Math.round(focal)} mm`;
      if (text !== this._heightText) {
        if (this._heightLabel) { this.root.remove(this._heightLabel); disposeTree(this._heightLabel); }
        this._heightLabel = label(text, { color: TOKENS.accentInk, bg: TOKENS.accent, h: 0.028 });
        this._heightText = text;
        this.root.add(this._heightLabel);
      }
      this._heightLabel.position.set(pos.x, pos.y * 0.5, pos.z);
      this._heightLabel.visible = true;
    } else if (this._heightLabel) this._heightLabel.visible = false;

    // Constant on-screen size for diamonds and arrows.
    for (const m of this.keyMarks || []) m.scale.set(0.7, 1, 0.7).multiplyScalar(dist(m.position) * 0.011);
    for (const a of this.arrows || []) a.scale.setScalar(dist(a.position) * 0.034);

    // Key cameras (Free view only: the shot camera must never see itself). They replace the diamonds; the
    // number sits above each one; the key at (or nearest) the playhead is in the accent colour.
    const cams = free && this.keyCamsOn;
    const hot = cams ? nearestKey(this.keyCams.map((g) => ({ frame: g.userData.keyFrame })), st.frame) : -1;
    const base = this._keyCamBase || 0.3;
    this.keyCams.forEach((g, i) => {
      g.visible = cams;
      const s = cams ? THREE.MathUtils.clamp(dist(g.position) * 0.06, base, base * 8) : 0;
      if (cams) { g.scale.setScalar(s); paintKeyCam(g, i === hot); }
      if (this.keyMarks[i]) this.keyMarks[i].visible = !cams;
      if (this.keyTags?.[i]) this.keyTags[i].position.copy(g.position).y += cams ? s * 0.78 : 0;
    });

    const r = st.renderer, auto = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, viewCam);
    r.autoClear = auto;
  }
}

// ---------------------------------------------------------------- PipViewer
const PIP_CSS = `
.ss-pip { position:absolute; z-index:4; border:1px solid ${TOKENS.lineStrong}; border-radius:10px; overflow:hidden;
  box-shadow:0 6px 24px rgba(0,0,0,.45); pointer-events:none; }
.ss-pip[hidden] { display:none !important; }
.ss-pip .ss-pip-tag { position:absolute; top:6px; left:8px; font:600 10px/1 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif;
  letter-spacing:.08em; text-transform:uppercase; color:${TOKENS.accentInk}; background:${TOKENS.accent}; padding:3px 6px; border-radius:999px; }
.ss-pip .ss-pip-bar { position:absolute; left:0; right:0; bottom:0; display:flex; align-items:center; gap:6px; padding:14px 6px 5px;
  background:linear-gradient(transparent, rgba(20,15,24,.85)); pointer-events:auto; }
.ss-pip .ss-pip-bar button { all:unset; cursor:pointer; width:22px !important; height:22px !important; padding:0 !important;
  display:grid !important; place-items:center; border-radius:999px !important; border:0 !important; color:${TOKENS.text} !important;
  background:rgba(255,255,255,.12) !important; font:12px/1 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif !important; flex:none; }
.ss-pip .ss-pip-bar button:hover { background:rgba(255,255,255,.24) !important; }
.ss-pip .ss-pip-bar button:focus-visible { outline:2px solid ${TOKENS.accent}; outline-offset:1px; }
.ss-pip .ss-pip-bar input { flex:1; min-width:30px; accent-color:${TOKENS.accent}; height:14px; margin:0; }
.ss-pip .ss-pip-bar output { font:500 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color:${TOKENS.muted}; min-width:34px; text-align:right; }
`;

export class PipViewer {
  /**
   * @param container the element holding the stage canvas (position: relative), e.g. .ss-stageview
   * @param stage     the Stage
   * @param opts.onFrame  called with the frame whenever the PiP plays or scrubs (sync your timeline UI)
   * @param opts.widthFrac  PiP width as a fraction of the viewport (default 0.3)
   */
  constructor(container, stage, { onFrame = null, widthFrac = 0.3 } = {}) {
    this.stage = stage;
    this.container = container;
    this.onFrame = onFrame;
    this.widthFrac = widthFrac;
    this.enabled = true;
    this.playing = null;
    if (!document.getElementById("ss-pip-css")) {
      const s = Object.assign(document.createElement("style"), { id: "ss-pip-css", textContent: PIP_CSS });
      document.head.appendChild(s);
    }
    const el = (this.el = document.createElement("div"));
    el.className = "ss-pip";
    el.hidden = true;
    this.tag = Object.assign(document.createElement("div"), { className: "ss-pip-tag", textContent: "Shot cam" });
    const bar = document.createElement("div");
    bar.className = "ss-pip-bar";
    const btn = (ic, title, fn) => {
      const b = Object.assign(document.createElement("button"), { type: "button", title });
      b.append(icon(ic, 13));
      b.setAttribute("aria-label", title);
      b.addEventListener("click", fn);
      return b;
    };
    this.playBtn = btn("play", "Play the shot", () => this.togglePlay());
    this.scrub = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 96, step: 1, value: 0 });
    this.scrub.setAttribute("aria-label", "Scrub the shot");
    this.scrub.addEventListener("input", () => { this.pause(); this._go(+this.scrub.value); });
    this.tc = document.createElement("output");
    const expand = btn("maximize-2", "Look through the shot camera", () => { this.pause(); stage.setFreeView(false); });
    bar.append(this.playBtn, this.scrub, this.tc, expand);
    el.append(this.tag, bar);
    // Keep pointer / wheel / keys on the PiP away from the stage navigation underneath.
    for (const ev of ["pointerdown", "wheel", "keydown", "dblclick"]) bar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    container.appendChild(el);
    this._unhook = onAfterRender(stage, 100, () => this._draw());
  }

  setVisible(on) {
    this.enabled = !!on;
    if (!this.enabled) this.pause();
    this.stage.render();
  }

  togglePlay() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (this.playing) return;
    const st = this.stage, fps = st.state.shot?.fps || 24, last = st._lastFrame();
    let start = st.frame >= last ? 0 : st.frame;
    let t0 = performance.now();
    this.playBtn.replaceChildren(icon("pause", 13));
    this.playBtn.title = "Pause";
    const tick = (now) => {
      let f = start + Math.floor(((now - t0) / 1000) * fps);
      if (f > last) { start = 0; t0 = now; f = 0; } // loop, like a monitor on set
      if (f !== st.frame) this._go(f);
      this.playing = requestAnimationFrame(tick);
    };
    this.playing = requestAnimationFrame(tick);
  }

  pause() {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = null;
    this.playBtn.replaceChildren(icon("play", 13));
    this.playBtn.title = "Play the shot";
  }

  dispose() {
    this.pause();
    this._unhook?.();
    this.el.remove();
    this.stage.render();
  }

  _go(f) {
    this.stage.setFrame(f);
    this.onFrame?.(this.stage.frame);
  }

  /** Where the canvas content sits inside the container (object-fit: contain aware). */
  _layout() {
    const st = this.stage, canvas = st.canvas;
    const size = st.renderer.getSize(new THREE.Vector2());
    const cr = canvas.getBoundingClientRect(), pr = this.container.getBoundingClientRect();
    if (!cr.width || !size.x) return null;
    const s = Math.min(cr.width / size.x, cr.height / size.y);
    return { bw: size.x, bh: size.y, s, left: cr.left - pr.left + (cr.width - size.x * s) / 2, top: cr.top - pr.top + (cr.height - size.y * s) / 2 };
  }

  _draw() {
    const st = this.stage;
    const show = this.enabled && !!st.freeView;
    if (!show) { if (!this.el.hidden) { this.el.hidden = true; this.pause(); } return; }
    const L = this._layout();
    if (!L) return;
    const r = st.renderer;
    const pw = Math.round(L.bw * this.widthFrac), ph = Math.round((pw * st.fh) / st.fw), m = Math.round(L.bw * 0.015);
    // Render the shot camera into the bottom-left corner of the same canvas (no second GL context).
    const hidden = [];
    const hide = (o) => { if (o?.visible) { hidden.push(o); o.visible = false; } };
    hide(st.camHelper);
    for (const h of st.lightHandles?.values() || []) hide(h);
    st.camera.updateMatrixWorld();
    r.setScissorTest(true);
    r.setScissor(m, m, pw, ph);
    r.setViewport(m, m, pw, ph);
    const auto = r.autoClear;
    r.autoClear = true;
    r.render(st.scene, st.camera);
    r.autoClear = auto;
    r.setScissorTest(false);
    r.setViewport(0, 0, L.bw, L.bh);
    for (const o of hidden) o.visible = true;

    // Frame the DOM chrome over that corner.
    Object.assign(this.el.style, {
      left: `${L.left + m * L.s}px`, top: `${L.top + (L.bh - m - ph) * L.s}px`,
      width: `${pw * L.s}px`, height: `${ph * L.s}px`,
    });
    this.el.hidden = false;
    const last = st._lastFrame(), fps = st.state.shot?.fps || 24;
    this.scrub.max = String(last);
    if (document.activeElement !== this.scrub) this.scrub.value = String(st.frame);
    this.tc.textContent = `${String(Math.floor(st.frame / fps)).padStart(2, "0")}:${String(st.frame % fps).padStart(2, "0")}`;
    const name = st.activeShot?.()?.name;
    this.tag.textContent = name ? `Shot cam · ${name}` : "Shot cam";
  }
}

// ---------------------------------------------------------------- TopView
// Overhead orthographic plan (north up) for blocking the shot camera, like Higgsfield's top view.
//   drag a key diamond      -> move that camera key in X/Z (height kept); Shift = carry its target along
//   Alt + drag a key        -> change the key's height (vertical mouse movement)
//   drag a target dot       -> re-aim that key
//   click the path          -> insert a key at that point and time
//   drag the path / playhead-> scrub
//   right-click a key       -> delete it (never the last one)
//   drag empty space = pan, wheel = zoom, double-click empty = fit
// Each gesture is ONE undo step: keys are edited live (stage.setFrame re-renders) and
// stage.onChange is called once on release, so stage._record pushes a single snapshot.

const TOP_CSS = `
.ss-top { position:absolute; z-index:4; right:10px; bottom:10px; width:34%; min-width:240px; max-width:520px; aspect-ratio:4/3;
  background:rgba(33,25,39,.94); border:1px solid ${TOKENS.lineStrong}; border-radius:12px; overflow:hidden;
  box-shadow:0 8px 28px rgba(0,0,0,.5); display:flex; flex-direction:column; user-select:none; -webkit-user-select:none; }
.ss-top[hidden] { display:none !important; }
.ss-top-head { display:flex; align-items:center; gap:6px; padding:5px 6px 5px 10px; border-bottom:1px solid ${TOKENS.line};
  font:600 10px/1 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; letter-spacing:.08em; text-transform:uppercase; color:${TOKENS.muted}; }
.ss-top-head span { flex:1; }
.ss-top-head button { all:unset; cursor:pointer; padding:3px 8px !important; border-radius:999px !important; border:0 !important;
  background:rgba(255,255,255,.08) !important; color:${TOKENS.text} !important; font:500 11px/1.2 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif !important; }
.ss-top-head button:hover { background:rgba(255,255,255,.18) !important; }
.ss-top-head button:focus-visible { outline:2px solid ${TOKENS.accent}; outline-offset:1px; }
.ss-top canvas { flex:1; width:100%; min-height:0; display:block; touch-action:none; }
.ss-top-hint { position:absolute; left:8px; bottom:6px; right:8px; pointer-events:none;
  font:500 10px/1.3 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif; color:${TOKENS.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

const HINT_IDLE = "Drag ◆ camera keys or ■ cast keys · Alt-drag = height · drag ● to aim · click path = new key · right-click = delete";

export class TopView {
  /**
   * @param container the element holding the stage canvas (position: relative), e.g. .ss-stageview
   * @param stage     the Stage
   * @param opts.onFrame   called with the frame when the top view scrubs (sync your timeline UI)
   * @param opts.onKeysChanged  called after a gesture changed the camera keys (e.g. redraw the key strip)
   * @param opts.visible   start shown (default false)
   */
  constructor(container, stage, { onFrame = null, onKeysChanged = null, visible = false } = {}) {
    this.stage = stage;
    this.onFrame = onFrame;
    this.onKeysChanged = onKeysChanged;
    if (!document.getElementById("ss-top-css")) {
      document.head.appendChild(Object.assign(document.createElement("style"), { id: "ss-top-css", textContent: TOP_CSS }));
    }
    const el = (this.el = document.createElement("div"));
    el.className = "ss-top";
    el.hidden = !visible;
    el.ssTopView = this; // for tests and tools
    const head = document.createElement("div");
    head.className = "ss-top-head";
    const title = Object.assign(document.createElement("span"), { textContent: "Top view · N ↑" });
    const fit = Object.assign(document.createElement("button"), { type: "button", textContent: "Fit", title: "Fit the camera move and the cast" });
    fit.addEventListener("click", () => { this._fit(); this.draw(); });
    const close = Object.assign(document.createElement("button"), { type: "button", title: "Hide the top view" });
    close.append(icon("x", 13));
    close.setAttribute("aria-label", "Hide the top view");
    close.addEventListener("click", () => this.setVisible(false));
    head.append(title, fit, close);
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "Top view of the set: drag camera keys to block the move");
    this.hintEl = Object.assign(document.createElement("div"), { className: "ss-top-hint", textContent: HINT_IDLE });
    el.append(head, this.canvas, this.hintEl);
    container.appendChild(el);

    this.view = null;        // {cx, cz, scale (px per metre)}
    this.hover = null;       // hit under the pointer
    this.drag = null;
    this._sig = "";
    this._bind();
    this._unhook = onAfterRender(stage, 50, () => { if (!this.el.hidden && !this._drawing) this.draw(); });
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(this.canvas);
    if (visible) this.draw();
  }

  setVisible(on) {
    this.el.hidden = !on;
    if (on) { if (!this.view) this._fit(); this.draw(); }
  }

  toggle() { this.setVisible(this.el.hidden); }

  dispose() {
    this._unhook?.();
    this._ro?.disconnect();
    this.el.remove();
  }

  // ---- data
  _keys() { return this.stage._camKeys(); }

  /** The shot's ride-along host (its camera keys are in that vehicle's own space), or null. */
  _host() { return this.stage._followActor?.() || null; }

  /** A camera key's position and target in the world (a ride-along key moves with its vehicle). */
  _kw(k) {
    const h = this._host();
    if (!h) return { position: k.position, target: k.target };
    const toW = this.stage._actorFrame(h, k.frame);
    return { position: toW(k.position), target: toW(k.target) };
  }

  /** A world point in a camera key's own space. */
  _kl(k, w) {
    const h = this._host();
    return h ? this.stage._actorFrameInverse(h, k.frame)(w) : w;
  }

  /** Cast that can be moved from here: not riders (they sit on their mount) and not set pieces. */
  _movable(a) { return !a.mount_id && !this.stage._isSetPiece?.(a.id); }

  _north() {
    // Stage convention: world azimuth a points along (sin a, cos a) in X/Z; true north sits at lighting.north_deg.
    const n = THREE.MathUtils.degToRad(this.stage.state.lighting?.north_deg || 0);
    const up = [Math.sin(n), Math.cos(n)];
    return { up, right: [-up[1], up[0]] }; // a proper (unmirrored) view from above
  }

  _refresh() {
    const st = this.stage, last = st._lastFrame();
    const sig = [st.activeShot?.()?.id, last, JSON.stringify(st._camKeys()), st.state.actors.length,
      JSON.stringify(st.state.actors.map((a) => a.keys || a.position)), st.root.children.length, st.interiorGroup?.uuid].join("|");
    if (sig === this._sig) return;
    this._sig = sig;
    this.track = [];
    for (let f = 0; f <= last; f++) this.track.push(st._cameraAt(f).position);
    const step = Math.max(1, Math.ceil(last / 120));
    this.actors = st.state.actors.map((a) => {
      const path = [];
      if ((a.keys?.length || 0) > 1 || a.position_end) for (let f = 0; f <= last; f += step) path.push(st._actorPosAt(a, f));
      return { a, path };
    });
    // Set footprint: X/Z boxes of the set's pieces (not the floor, not the cast) and the interior's walls.
    const actorObjs = new Set(st.actorMeshes.values());
    const box = new THREE.Box3();
    this.setBoxes = [];
    for (const c of st.root.children) {
      if (c === st.ground || actorObjs.has(c) || c === st.interiorGroup || !c.visible) continue;
      box.setFromObject(c);
      if (box.isEmpty()) continue;
      const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
      if (sx > 60 || sz > 60) continue; // ground-sized backdrops would hide everything
      this.setBoxes.push([box.min.x, box.min.z, box.max.x, box.max.z]);
    }
    this.walls = [];
    for (const c of st.interiorGroup?.children || []) {
      box.setFromObject(c);
      if (!box.isEmpty()) this.walls.push([box.min.x, box.min.z, box.max.x, box.max.z]);
    }
  }

  // ---- view transform
  _size() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  _fit() {
    this._refresh();
    const { up, right } = this._north();
    // Frame the camera move, its aims (clamped to 8 m out) and the cast where they are now.
    const aim = (k0) => {
      const k = this._kw(k0);
      const d = [k.target[0] - k.position[0], k.target[2] - k.position[2]], l = Math.hypot(d[0], d[1]), s = l > 8 ? 8 / l : 1;
      return [k.position[0] + d[0] * s, 0, k.position[2] + d[1] * s];
    };
    const pts = [...this.track, ...this._keys().map(aim), ...this.actors.map(({ a }) => this.stage._actorPosAt(a, this.stage.frame))];
    let u0 = Infinity, u1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const p of pts) {
      const u = p[0] * up[0] + p[2] * up[1], r = p[0] * right[0] + p[2] * right[1];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
    }
    if (!Number.isFinite(u0)) { u0 = r0 = -5; u1 = r1 = 5; }
    const { w, h } = this._size();
    const span = Math.max(4, (r1 - r0) * 1.25, ((u1 - u0) * 1.25 * w) / Math.max(1, h - 20));
    const cu = (u0 + u1) / 2, cr = (r0 + r1) / 2;
    this.view = { cx: cr * right[0] + cu * up[0], cz: cr * right[1] + cu * up[1], scale: Math.max(4, w / span) };
  }

  _toScreen(x, z) {
    if (!this.view) this._fit();
    const { up, right } = this._north(), v = this.view, { w, h } = this._size();
    const dx = x - v.cx, dz = z - v.cz;
    return [w / 2 + (dx * right[0] + dz * right[1]) * v.scale, (h - 14) / 2 - (dx * up[0] + dz * up[1]) * v.scale];
  }

  _toWorld(sx, sy) {
    if (!this.view) this._fit();
    const { up, right } = this._north(), v = this.view, { w, h } = this._size();
    const a = (sx - w / 2) / v.scale, b = ((h - 14) / 2 - sy) / v.scale;
    return [v.cx + a * right[0] + b * up[0], v.cz + a * right[1] + b * up[1]];
  }

  // ---- hit testing
  _hit(sx, sy) {
    const st = this.stage, keys = this._keys().map((k) => this._kw(k));
    const near = (p, r) => { const [x, y] = this._toScreen(p[0], p[2]); return Math.hypot(x - sx, y - sy) <= r; };
    for (let i = keys.length - 1; i >= 0; i--) if (near(keys[i].target, 7)) return { kind: "target", i };
    for (let i = keys.length - 1; i >= 0; i--) if (near(keys[i].position, 9)) return { kind: "key", i };
    if (near(st.camera.position.toArray(), 9)) return { kind: "playhead" };
    // The cast: a key on a moving one's dashed path, then anyone where they stand now.
    const cast = (this.actors || []).filter(({ a }) => this._movable(a));
    for (const { a } of cast) {
      const ak = st._actorKeys(a);
      if (ak.length > 1) for (let j = ak.length - 1; j >= 0; j--) if (near(ak[j].position, 6)) return { kind: "akey", a, j };
    }
    for (const { a } of cast) if (near(st._actorPosAt(a, st.frame), 7)) return { kind: "actor", a };
    const f = this._nearestFrame(sx, sy, 7);
    if (f !== null) return { kind: "path", frame: f };
    return null;
  }

  /** Nearest frame on the camera track within `maxPx` of the point (or anywhere when maxPx = Infinity). */
  _nearestFrame(sx, sy, maxPx) {
    let best = null, bd = maxPx;
    this.track.forEach((p, f) => {
      const [x, y] = this._toScreen(p[0], p[2]);
      const d = Math.hypot(x - sx, y - sy);
      if (d <= bd) { bd = d; best = f; }
    });
    return best;
  }

  // ---- editing
  _commit() {
    const st = this.stage;
    st.setFrame(st.frame);
    st.onChange(st.toJSON());
    this.onKeysChanged?.(this._keys());
  }

  _scrub(f) {
    this.stage.setFrame(f);
    this.onFrame?.(this.stage.frame);
  }

  _insertKey(f) {
    const st = this.stage, keys = this._keys();
    if (keys.some((k) => k.frame === f)) { this._scrub(f); return; }
    const c = st._cameraAt(f);
    const r3 = (v) => +v.toFixed(3);
    keys.push({ frame: f, position: c.position.map(r3), target: c.target.map(r3), focal_mm: Math.round(c.focal_mm * 10) / 10 });
    keys.sort((a, b) => a.frame - b.frame);
    st.setFrame(f);
    this.onFrame?.(f);
    this._commit();
  }

  _deleteKey(i) {
    const st = this.stage, shot = st.activeShot(), keys = this._keys();
    if (keys.length < 2) { this._hint("The shot needs at least one camera key"); return; }
    shot.camera_keys = keys.filter((_, j) => j !== i);
    this._commit();
  }

  _deleteActorKey(a, j) {
    const keys = this.stage._actorKeys(a);
    if (keys.length < 2) return;
    keys.splice(j, 1);
    this._commit();
  }

  _hint(text) { this.hintEl.textContent = text || HINT_IDLE; }

  _bind() {
    const cv = this.canvas;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const stop = (e) => e.stopPropagation();
    for (const ev of ["pointerdown", "pointermove", "pointerup", "dblclick", "click", "keydown", "contextmenu"]) this.el.addEventListener(ev, stop);

    cv.addEventListener("pointerdown", (e) => {
      if (!this.view) this._fit();
      const [sx, sy] = pos(e);
      const hit = this._hit(sx, sy);
      if (e.button === 2) {
        if (hit?.kind === "key") this._deleteKey(hit.i);
        else if (hit?.kind === "akey") this._deleteActorKey(hit.a, hit.j);
        return;
      }
      if (e.button !== 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      const keys = this._keys();
      this.drag = { hit, sx, sy, moved: false, alt: e.altKey, shift: e.shiftKey, view: { ...this.view } };
      if (hit?.kind === "key") {
        const k = keys[hit.i], w = this._kw(k);
        this.drag.start = { position: [...w.position], target: [...w.target] };   // world
        this.drag.startL = { position: [...k.position], target: [...k.target] };  // the key's own space
        this._scrub(k.frame); // show what that key sees
      } else if (hit?.kind === "target") {
        this.drag.start = { target: [...this._kw(keys[hit.i]).target] };
      } else if (hit?.kind === "akey") {
        const k = this.stage._actorKeys(hit.a)[hit.j];
        this.drag.start = { position: [...k.position] };
        this.stage.select?.(hit.a.id);
        this._scrub(k.frame); // see the cast where that key puts them
      } else if (hit?.kind === "actor") {
        this.drag.start = { position: [...this.stage._actorPosAt(hit.a, this.stage.frame)] };
        this.stage.select?.(hit.a.id);
      }
      this.draw();
    });

    cv.addEventListener("pointermove", (e) => {
      const [sx, sy] = pos(e);
      const d = this.drag;
      if (!d) {
        this.hover = this.view ? this._hit(sx, sy) : null;
        cv.style.cursor = !this.hover ? "grab" : this.hover.kind === "path" ? "copy" : this.hover.kind === "playhead" ? "ew-resize" : "grab";
        const who = this.hover?.a ? this.hover.a.name || this.hover.a.kind || this.hover.a.id : "";
        this._hint(!this.hover ? null : {
          key: `Key ${this.hover.i + 1} · drag to move · Alt-drag = height · Shift = carry the aim · right-click = delete`,
          target: `Aim of key ${this.hover.i + 1} · drag to re-aim`,
          playhead: "Playhead · drag along the path to scrub",
          path: `Frame ${this.hover.frame} · click = new key here · drag = scrub`,
          akey: `${who} · key ${this.hover.j + 1} (frame ${this.stage._actorKeys(this.hover.a)[this.hover.j]?.frame}) · drag to move · right-click = delete`,
          actor: `${who} · drag to move (keys it at the playhead)`,
        }[this.hover.kind]);
        this.draw();
        return;
      }
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
      d.moved = true;
      cv.style.cursor = "grabbing";
      const keys = this._keys(), h = d.hit;
      const [wx, wz] = this._toWorld(sx, sy), [w0x, w0z] = this._toWorld(d.sx, d.sy);
      const r3 = (v) => +v.toFixed(3);
      const r3v = (p) => p.map(r3);
      if (h?.kind === "key") {
        const k = keys[h.i];
        if (d.alt) {
          const y = Math.max(0.05, d.startL.position[1] + (d.sy - sy) * 0.01); // 1 cm per pixel
          k.position = [d.startL.position[0], r3(y), d.startL.position[2]];
          this._hint(`Key ${h.i + 1} height ${y.toFixed(2)} m`);
        } else {
          const dx = wx - w0x, dz = wz - w0z;
          const p = [d.start.position[0] + dx, d.start.position[1], d.start.position[2] + dz];
          k.position = r3v(this._kl(k, p));
          if (d.shift) k.target = r3v(this._kl(k, [d.start.target[0] + dx, d.start.target[1], d.start.target[2] + dz]));
          else k.target = [...d.startL.target];
          this._hint(`Key ${h.i + 1} → x ${p[0].toFixed(2)}  z ${p[2].toFixed(2)} m`);
        }
        this.stage.setFrame(this.stage.frame); // live 3D update; committed once on release
      } else if (h?.kind === "target") {
        const k = keys[h.i];
        k.target = r3v(this._kl(k, [d.start.target[0] + wx - w0x, d.start.target[1], d.start.target[2] + wz - w0z]));
        this.stage.setFrame(this.stage.frame);
      } else if (h?.kind === "akey" || h?.kind === "actor") {
        // A cast key moves in X/Z (its height stays); dragging someone between keys keys them at the playhead.
        const k = h.kind === "akey" ? this.stage._actorKeys(h.a)[h.j] : (d.key ||= this.stage._editActorKey(h.a));
        if (k) {
          k.position = [r3(d.start.position[0] + wx - w0x), k.position[1], r3(d.start.position[2] + wz - w0z)];
          this._hint(`${h.a.name || h.a.kind || h.a.id} → x ${k.position[0].toFixed(2)}  z ${k.position[2].toFixed(2)} m · frame ${k.frame}`);
          this.stage.setFrame(this.stage.frame);
        }
      } else if (h?.kind === "path" || h?.kind === "playhead") {
        const f = this._nearestFrame(sx, sy, Infinity);
        if (f !== null && f !== this.stage.frame) this._scrub(f);
      } else {
        // Pan.
        const { up, right } = this._north(), s = d.view.scale;
        const a = (sx - d.sx) / s, b = (sy - d.sy) / s;
        this.view = { ...d.view, cx: d.view.cx - a * right[0] + b * up[0], cz: d.view.cz - a * right[1] + b * up[1] };
      }
      this.draw();
    });

    const end = (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      cv.style.cursor = "grab";
      const h = d.hit;
      if (d.moved && ["key", "target", "akey", "actor"].includes(h?.kind)) this._commit();
      else if (!d.moved && h?.kind === "path") this._insertKey(h.frame);
      this._hint(null);
      this.draw();
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", () => { if (!this.drag && this.hover) { this.hover = null; this._hint(null); this.draw(); } });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("dblclick", (e) => { const [sx, sy] = pos(e); if (!this._hit(sx, sy)) { this._fit(); this.draw(); } });
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.view) this._fit();
      const [sx, sy] = pos(e);
      const before = this._toWorld(sx, sy);
      this.view.scale = THREE.MathUtils.clamp(this.view.scale * Math.exp(-e.deltaY * 0.0015), 2, 600);
      const after = this._toWorld(sx, sy);
      this.view.cx += before[0] - after[0];
      this.view.cz += before[1] - after[1];
      this.draw();
    }, { passive: false });
  }

  // ---- drawing
  draw() {
    if (this.el.hidden) return;
    this._drawing = true;
    try { this._draw(); } finally { this._drawing = false; }
  }

  _draw() {
    const st = this.stage, cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const { w, h } = this._size();
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    this._refresh();
    if (!this.view) this._fit();
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const S = (p) => this._toScreen(p[0], p[2]);
    const v = this.view;

    // Grid: 1 m (5 m stronger), aligned to the world axes.
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => this._toWorld(x, y));
    const xs = corners.map((c) => c[0]), zs = corners.map((c) => c[1]);
    const step = v.scale < 8 ? 5 : 1;
    g.lineWidth = 1;
    for (const [axis, lo, hi] of [[0, Math.min(...xs), Math.max(...xs)], [1, Math.min(...zs), Math.max(...zs)]]) {
      for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) {
        g.strokeStyle = m === 0 ? "rgba(255,255,255,.16)" : m % 5 === 0 ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.035)";
        const a = axis === 0 ? S([m, 0, Math.min(...zs)]) : S([Math.min(...xs), 0, m]);
        const b = axis === 0 ? S([m, 0, Math.max(...zs)]) : S([Math.max(...xs), 0, m]);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    }
    const rect = (bx, fill, stroke) => {
      const p = [[bx[0], 0, bx[1]], [bx[2], 0, bx[1]], [bx[2], 0, bx[3]], [bx[0], 0, bx[3]]].map(S);
      g.beginPath(); p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.stroke();
    };
    for (const b of this.setBoxes) rect(b, "rgba(255,255,255,.035)", "rgba(255,255,255,.12)");
    for (const b of this.walls) rect(b, "rgba(240,239,237,.22)", "rgba(240,239,237,.4)");

    // Cast: paths, then dots with names.
    g.font = "500 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    // Close actors (two horses side by side) would overprint: try right, left, above, below, then stack.
    const placed = [];
    const label = (text, x, y) => {
      const w = g.measureText(text).width, h = 11;
      const spots = [[x + 7, y], [x - 7 - w, y], [x - w / 2, y - 10], [x - w / 2, y + 10]];
      for (let k = 1; k < 4; k++) spots.push([x + 7, y + k * h], [x + 7, y - k * h]);
      const hit = ([lx, ly]) => placed.some((r) => lx < r[0] + r[2] && lx + w > r[0] && ly - h / 2 < r[1] + h / 2 && ly + h / 2 > r[1] - h / 2);
      const [lx, ly] = spots.find((s) => !hit(s)) || spots[0];
      placed.push([lx, ly, w]);
      g.fillText(text, lx, ly);
    };
    for (const k of this._keys()) { const [kx, ky] = S(this._kw(k).position); placed.push([kx - 9, ky, 18]); } // key diamonds draw on top
    const hovA = this.hover, drgA = this.drag?.hit;
    for (const { a, path } of this.actors) {
      if (path.length > 1) {
        g.strokeStyle = "rgba(240,239,237,.28)"; g.setLineDash([3, 3]); g.beginPath();
        path.forEach((p, i) => { const [x, y] = S(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
      }
      // Its keys as small squares on the path (drag to move one, right-click to delete).
      const ak = st._actorKeys(a);
      if (ak.length > 1 && this._movable(a)) {
        ak.forEach((k, j) => {
          const hot = [hovA, drgA].some((x) => x?.kind === "akey" && x.a === a && x.j === j);
          const [kx, ky] = S(k.position), r = hot ? 5 : 3.5;
          g.fillStyle = hot ? TOKENS.accent : "#539bf5";
          g.fillRect(kx - r, ky - r, 2 * r, 2 * r);
          g.strokeStyle = TOKENS.bg; g.lineWidth = 1; g.strokeRect(kx - r, ky - r, 2 * r, 2 * r);
        });
      }
      const [x, y] = S(st._actorPosAt(a, st.frame));
      const sel = a.id === st.selected || [hovA, drgA].some((h) => h?.kind === "actor" && h.a === a);
      g.fillStyle = sel ? TOKENS.accent : TOKENS.text;
      g.beginPath(); g.arc(x, y, sel ? 5 : 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = TOKENS.muted; g.textAlign = "left"; g.textBaseline = "middle";
      label(a.name || a.kind || a.id, x, y);
    }

    // Camera track, coloured by time, dimmer after the playhead.
    const last = Math.max(1, st._lastFrame()), c = new THREE.Color();
    g.lineWidth = 2.5; g.lineCap = "round";
    for (let f = 1; f < this.track.length; f++) {
      c.copy(COLORS.pathStart).lerp(COLORS.pathEnd, f / last);
      if (f > st.frame) c.lerp(COLORS.bg, 0.55);
      const [x0, y0] = S(this.track[f - 1]), [x1, y1] = S(this.track[f]);
      g.strokeStyle = `#${c.getHexString()}`; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    const hov = this.hover, drg = this.drag?.hit;
    if (hov?.kind === "path" && !this.drag) {
      const [x, y] = S(this.track[hov.frame]);
      g.strokeStyle = TOKENS.accent; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
      g.fillStyle = TOKENS.accent; g.font = "600 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "bottom";
      g.fillText(`+ f${hov.frame}`, x, y - 8);
    }

    // Keys: lens wedge, aim line + target dot, diamond with its number.
    const keys = this._keys();
    const wedge = (p, t, focal, color, len) => {
      const [x, y] = S(p), [tx, ty] = S(t);
      const ang = Math.atan2(ty - y, tx - x), half = Math.atan(SENSOR_W_MM / 2 / Math.max(1, focal));
      g.beginPath(); g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang - half) * len, y + Math.sin(ang - half) * len);
      g.lineTo(x + Math.cos(ang + half) * len, y + Math.sin(ang + half) * len);
      g.closePath(); g.fillStyle = color; g.fill();
    };
    keys.forEach((k0, i) => {
      const k = { ...k0, ...this._kw(k0) }; // world position / target (a ride-along key moves with its vehicle)
      const isHot = (hov?.i === i && (hov.kind === "key" || hov.kind === "target")) || (drg?.i === i && (drg.kind === "key" || drg.kind === "target"));
      const [x, y] = S(k.position), [tx, ty] = S(k.target);
      wedge(k.position, k.target, k.focal_mm || 35, isHot ? "rgba(242,255,89,.22)" : "rgba(221,211,255,.14)", 34);
      g.strokeStyle = isHot ? "rgba(242,255,89,.6)" : "rgba(221,211,255,.3)"; g.lineWidth = 1; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
      const tHot = (hov?.kind === "target" && hov.i === i) || (drg?.kind === "target" && drg.i === i);
      g.fillStyle = tHot ? TOKENS.accent : "#b9a7ff";
      g.beginPath(); g.arc(tx, ty, tHot ? 5.5 : 4, 0, Math.PI * 2); g.fill();
      g.strokeStyle = TOKENS.bg; g.lineWidth = 1.5; g.stroke();
      const kHot = (hov?.kind === "key" && hov.i === i) || (drg?.kind === "key" && drg.i === i);
      const r = kHot ? 9 : 7;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
      g.fillStyle = kHot ? TOKENS.accent : "#efe9ff"; g.fill();
      g.strokeStyle = TOKENS.bg; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = TOKENS.accentInk; g.font = "700 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(i + 1), x, y + 0.5);
      if (kHot && this.drag?.alt) {
        g.fillStyle = TOKENS.accent; g.font = "600 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textBaseline = "bottom";
        g.fillText(`${k.position[1].toFixed(2)} m`, x, y - r - 3);
      }
    });

    // Playhead camera (the live shot camera, so a VCam preview shows here too).
    const cam = st.camera, cp = cam.position.toArray();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const aspect = st.fw / st.fh, halfW = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * aspect;
    const focal = SENSOR_W_MM / 2 / halfW;
    const pHot = hov?.kind === "playhead" || drg?.kind === "playhead";
    wedge(cp, [cp[0] + fwd.x, 0, cp[2] + fwd.z], focal, pHot ? "rgba(242,255,89,.5)" : "rgba(242,255,89,.32)", 46);
    const [px, py] = S(cp);
    g.fillStyle = TOKENS.accent; g.beginPath(); g.arc(px, py, pHot ? 6 : 4.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = TOKENS.bg; g.lineWidth = 1.5; g.stroke();

    // North arrow and a scale bar.
    g.fillStyle = TOKENS.muted; g.font = "700 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.beginPath(); g.moveTo(w - 16, 10); g.lineTo(w - 11, 22); g.lineTo(w - 21, 22); g.closePath(); g.fill();
    g.fillText("N", w - 16, 30);
    const nice = [0.5, 1, 2, 5, 10, 20, 50].find((m) => m * v.scale >= 50) || 50;
    const bx = w - 14 - nice * v.scale, by = h - 24;
    g.strokeStyle = TOKENS.muted; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(bx, by - 3); g.lineTo(bx, by); g.lineTo(bx + nice * v.scale, by); g.lineTo(bx + nice * v.scale, by - 3); g.stroke();
    g.textBaseline = "bottom"; g.fillText(`${nice} m`, bx + (nice * v.scale) / 2, by - 3);
  }
}
