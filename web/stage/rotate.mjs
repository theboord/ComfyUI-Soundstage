// Rotation you can find (the "there's no way to rotate anything" fix): a small floating tool bar beside the selected
// object (Move · Rotate · Scale, keys G / R / T, and Reset rotation), a yaw ring at its feet you grab and turn, and
// Alt + drag on the object to turn it. R's gizmo turns on all three axes (tilt and roll too); Shift snaps to 15°.
// Every turn is one undo step. The pure helpers below are unit-tested (tests/js/rotate.test.mjs).
import * as THREE from "../vendor/three.module.min.mjs";
import { icon } from "../ui/icons.mjs";
import { yawTilt } from "./manip.mjs";

export const SNAP_DEG = 15;
export const snapDeg = (deg, step = SNAP_DEG) => Math.round(deg / step) * step || 0;
/** Into (-180, 180]. */
export const wrapDeg = (deg) => { const d = ((((deg + 180) % 360) + 360) % 360) - 180; return d === -180 ? 180 : d; };
/** The heading of a floor point (px, pz) seen from (cx, cz): three.js yaw, so +Z = 0° and +X = 90°. */
export const angleAt = (px, pz, cx, cz) => Math.atan2(px - cx, pz - cz) * 180 / Math.PI;
/** Ring radius for a footprint of half-sizes hx, hz (m): just outside it. */
export const ringRadius = (hx, hz) => Math.max(0.4, Math.hypot(hx, hz) * 1.05 + 0.15);
/** Is the floor point on the ring band? tol in metres. */
export const onRing = (px, pz, cx, cz, R, tol) => Math.abs(Math.hypot(px - cx, pz - cz) - R) <= tol;
/** Yaw from a drag: start yaw + how far the pointer went round the ring (unwrapped), optionally snapped. */
export function ringYaw(yaw0, a0, a1, snap = false) {
  const y = yaw0 + wrapDeg(a1 - a0);
  return snap ? snapDeg(y) : y;
}
/** Alt + drag: horizontal pixels to degrees (half a degree a pixel). */
export const altYaw = (yaw0, dx, snap = false) => { const y = yaw0 + dx * 0.5; return snap ? snapDeg(y) : y; };

/**
 * Where the tool bar goes: centred above the object's on-screen box (x0..x1, y0..y1, px in the canvas), kept inside the
 * canvas (w x h) with a margin; below the object when there's no room above. bar = {w, h}.
 */
export function toolbarPos(box, canvas, bar, gap = 28, margin = 8) {   // gap clears the W·D·H tag
  const cx = (box.x0 + box.x1) / 2;
  let left = Math.round(cx - bar.w / 2);
  left = Math.max(margin, Math.min(canvas.w - bar.w - margin, left));
  let top = Math.round(box.y0 - gap - bar.h);
  if (top < margin) top = Math.round(Math.min(canvas.h - bar.h - margin, box.y1 + gap));
  return { left, top: Math.max(margin, top) };
}

export const TOOLS = [
  { mode: "translate", label: "Move", key: "G", icon: "move-3d" },
  { mode: "rotate", label: "Rotate", key: "R", icon: "rotate-ccw" },
  { mode: "scale", label: "Scale", key: "T", icon: "maximize-2" },
];

const CSS = `.ss-objbar{position:absolute;z-index:4;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(33,25,39,.88);
border:1px solid rgba(255,255,255,.14);box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:auto;user-select:none}
.ss-objbar button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:999px;
color:#efe9f5;font:600 11.5px/1 "Soundstage Grotesk",system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.ss-objbar button:hover{background:rgba(255,255,255,.1)}
.ss-objbar button[aria-pressed=true]{background:#f2ff59;color:#1d1622}
.ss-objbar button:focus-visible{outline:2px solid #f2ff59;outline-offset:1px}
.ss-objbar kbd{font:600 10px/1 ui-monospace,monospace;opacity:.6}
.ss-objbar .sep{width:1px;margin:4px 2px;background:rgba(255,255,255,.16)}`;

/** The on-canvas rotate tools for a Stage. Installed by the Stage after its own pointer handlers. */
export class RotateTools {
  constructor(stage) {
    this.s = stage;
    this.drag = null;
    this._buildRing();
    this._bindPointer();
    const snap = (e) => { if (e.key === "Shift") stage.tc?.setRotationSnap(e.type === "keydown" ? THREE.MathUtils.degToRad(SNAP_DEG) : null); };
    addEventListener("keydown", snap, true); addEventListener("keyup", snap, true);
    addEventListener("blur", () => stage.tc?.setRotationSnap(null));
  }

  _buildRing() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xf2ff59, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false });
    const ring = this.band = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 96), mat);
    ring.rotation.x = -Math.PI / 2;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), mat);
    knob.position.set(0, 0, 1);   // points the way the object faces
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 12), mat);
    arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 0, 1.12);
    this.ring = new THREE.Group();
    this.ring.add(ring, knob, arrow);
    this.ring.renderOrder = 999;
    this.ring.visible = false;
    this.ring.userData.mat = mat;
    this.s.gizmoScene.add(this.ring);
  }

  _ui() {
    if (this.bar || !this.s.canvas?.parentElement) return this.bar;
    if (!document.getElementById("ss-objbar-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-objbar-css", textContent: CSS }));
    const bar = this.bar = Object.assign(document.createElement("div"), { className: "ss-objbar" });
    bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Selected object");
    this.btns = {};
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.type = "button"; b.title = `${t.label} (${t.key})`; b.dataset.mode = t.mode;
      b.setAttribute("aria-label", `${t.label} (${t.key})`);
      b.append(icon(t.icon, 13));
      b.append(t.label);
      b.addEventListener("click", () => { this.s.setGizmoMode(t.mode); this.s.canvas.focus({ preventScroll: true }); });
      this.btns[t.mode] = b; bar.append(b);
    }
    bar.append(Object.assign(document.createElement("i"), { className: "sep" }));
    const reset = this.resetBtn = document.createElement("button");
    reset.type = "button"; reset.title = "Reset rotation: stand it upright, facing 0°"; reset.setAttribute("aria-label", "Reset rotation");
    reset.append(icon("undo-2", 13), "Reset");
    reset.addEventListener("click", () => { this.s.resetRotation(); this.s.canvas.focus({ preventScroll: true }); });
    bar.append(reset);
    for (const ev of ["pointerdown", "wheel"]) bar.addEventListener(ev, (e) => e.stopPropagation());
    bar.style.display = "none";
    this.s.canvas.parentElement.append(bar);
    return bar;
  }

  _target() {
    const s = this.s;
    if (!s.selected || !s._gizmoOn || s.poser?.active || s.tc?.object !== s.actorMeshes.get(s.selected)) return null;
    const a = s.state.actors.find((x) => x.id === s.selected);
    const g = s.actorMeshes.get(s.selected);
    return a && g ? { a, g } : null;
  }

  /** Each viewport render: place the ring and the tool bar. */
  sync(cam) {
    const s = this.s, t = this._target(), bar = this._ui();
    const showRing = !!t && s.tcHelper.visible && s.gizmoMode !== "rotate";
    this.ring.visible = showRing || !!this.drag;
    if (!t) { this._box = null; if (bar) bar.style.display = "none"; return; }
    const box = new THREE.Box3().setFromObject(t.g);
    if (box.isEmpty()) { this.ring.visible = false; if (bar) bar.style.display = "none"; return; }
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const R = this.drag?.R || ringRadius(sz.x / 2, sz.z / 2);
    this.ring.position.set(t.g.position.x, Math.max(0, box.min.y) + 0.02, t.g.position.z);
    this.ring.scale.setScalar(R);
    // A thin line at any size: ~3 cm wide (the band is rebuilt when the radius changes much; the knob keeps its size).
    if (Math.abs((this._bandR || 0) - R) > 0.05 * R) {
      this._bandR = R;
      this.band.geometry.dispose();
      this.band.geometry = new THREE.RingGeometry(1 - Math.min(0.04, 0.03 / R), 1, 96);
      for (const m of this.ring.children) if (m !== this.band) m.scale.setScalar(Math.min(1, 1.2 / R));
    }
    this.ring.rotation.set(0, t.g.rotation.y, 0);
    this.ring.userData.mat.opacity = this.drag ? 1 : this._hot ? 1 : 0.7;
    this.ringR = R;
    if (!bar) return;
    // The object's on-screen box.
    const r = s.canvas.getBoundingClientRect(), pr = s.canvas.parentElement.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
      if (v.z > 1) behind = true;
      const x = ((v.x + 1) / 2) * r.width, y = ((1 - v.y) / 2) * r.height;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    this._box = behind ? null : { x0, y0, x1, y1 };
    const off = behind || x1 < 0 || y1 < 0 || x0 > r.width || y0 > r.height;
    const hide = off || s._dragging || s.tc.dragging || !!this.drag || r.width < 260;
    bar.style.display = hide ? "none" : "flex";
    if (hide) return;
    for (const [m, b] of Object.entries(this.btns)) b.setAttribute("aria-pressed", String(m === s.gizmoMode));
    this.resetBtn.style.display = (t.a.rotation_deg || 0) !== 0 || t.a.tilt ? "flex" : "none";
    const p = toolbarPos({ x0, y0, x1, y1 }, { w: r.width, h: r.height }, { w: bar.offsetWidth || 220, h: bar.offsetHeight || 32 });
    bar.style.left = `${r.left - pr.left + p.left}px`;
    bar.style.top = `${r.top - pr.top + p.top}px`;
  }

  _floorHit(e) {
    const ray = this.s._pickRay(e).ray;
    const y = this.ring.position.y;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = (y - ray.origin.y) / ray.direction.y;
    return t > 0 ? ray.at(t, new THREE.Vector3()) : null;
  }

  _ringTol(e) {   // ~10 px of slack, in metres at the ring's distance
    const s = this.s, cam = s._viewportCamera();
    const d = cam.position.distanceTo(this.ring.position);
    const h = s.canvas.getBoundingClientRect().height || 600;
    const mpp = cam.isPerspectiveCamera ? (2 * d * Math.tan((cam.fov * Math.PI / 180) / 2)) / h : (cam.top - cam.bottom) / cam.zoom / h;
    return Math.max(0.04, mpp * 10);
  }

  _onRing(e) {
    if (!this.ring.visible || this.s.gizmoMode === "rotate") return null;
    const p = this._floorHit(e);
    if (!p) return null;
    const c = this.ring.position;
    return onRing(p.x, p.z, c.x, c.z, this.ringR, this._ringTol(e)) ? p : null;
  }

  _yaw(a) { return this.s._turnHeadingKey && this.s._actorKeys && this._hasHeading(a) ? this.s._headingAt(a, this.s.frame) * 180 / Math.PI : (a.rotation_deg || 0); }
  _hasHeading(a) { try { return !!this.s._actorKeys(a)?.some((k) => Number.isFinite(k.heading_deg)); } catch { return false; } }

  _bindPointer() {
    const s = this.s, cv = s.canvas;
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.drag) return;
      let t = this._target();
      const p = t && this._onRing(e);
      let kind = p ? "ring" : null;
      if (!kind && e.altKey) {
        // Alt + drag on an object turns it (the shortcut sheet's "Alt + Drag"), from the press, not only mid-hold.
        const ray = s._pickRay(e);
        // A person is thin (a press between the legs misses the mesh): the selected object's on-screen box counts, as
        // does a press within ~12 px of anything's outline (how a click picks).
        const cr = cv.getBoundingClientRect(), bx = this._box, ex = e.clientX - cr.left, ey = e.clientY - cr.top;
        const hit = ray.intersectObjects([...s.actorMeshes.values()], true)[0]?.object?.userData?.actorId ||
          (bx && t && ex >= bx.x0 && ex <= bx.x1 && ey >= bx.y0 && ey <= bx.y1 ? s.selected : null) || s._nearOnScreen?.(e, 12) || null;
        if (hit && !s._isSetPiece(hit)) {
          if (hit !== s.selected) s.select(hit);
          t = this._target();
          if (t) kind = "alt";
        }
      }
      if (!kind) return;
      e.stopImmediatePropagation(); e.preventDefault();
      s.live?.finish();
      const c = this.ring.position;
      this.drag = { kind, id: t.a.id, x0: e.clientX, yaw0: this._yaw(t.a), a0: p ? angleAt(p.x, p.z, c.x, c.z) : 0, R: this.ringR, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      cv.style.cursor = "grabbing";
      s.render();
    }, { capture: true });
    cv.addEventListener("pointermove", (e) => {
      if (!this.drag) {
        const hot = !!(e.buttons === 0 && this._target() && this._onRing(e));
        if (hot !== !!this._hot) { this._hot = hot; cv.style.cursor = hot ? "grab" : ""; s.render(); }
        return;
      }
      e.stopImmediatePropagation();
      const d = this.drag, a = s.state.actors.find((x) => x.id === d.id);
      if (!a) return;
      let yaw;
      if (d.kind === "ring") {
        const p = this._floorHit(e);
        if (!p) return;
        const c = this.ring.position;
        const a1 = angleAt(p.x, p.z, c.x, c.z);
        d.acc = (d.acc || 0) + wrapDeg(a1 - (d.last ?? d.a0)); d.last = a1;   // unwrapped, so a full turn and more works
        yaw = d.yaw0 + d.acc;
        if (e.shiftKey) yaw = snapDeg(yaw);
      } else yaw = altYaw(d.yaw0, e.clientX - d.x0, e.shiftKey);
      d.moved = true;
      this._apply(a, yaw);
    }, { capture: true });
    const end = (e) => {
      if (!this.drag) return;
      e.stopImmediatePropagation();
      const d = this.drag; this.drag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      cv.style.cursor = "";
      if (d.moved) s.onChange(s.toJSON());   // one undo step per turn
      s.render();
    };
    cv.addEventListener("pointerup", end, { capture: true });
    cv.addEventListener("pointercancel", end, { capture: true });
  }

  _apply(a, yaw) {
    const s = this.s;
    if (!s._turnHeadingKey(a, yaw)) a.rotation_deg = Math.round(wrapDeg(yaw));
    s.setFrame(s.frame);
    s.onSelect?.(s.selectedInfo());
  }
}

/** The gizmo's 3-axis turn, back into the actor: heading (Turn) + the tilt left over. */
export function gizmoTurnToActor(stage, a, g) {
  const { yawDeg, tilt } = yawTilt([g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w]);
  if (!stage._turnHeadingKey(a, yawDeg)) a.rotation_deg = yawDeg;
  if (tilt) a.tilt = tilt; else delete a.tilt;
}
