// ComfyUI-side helpers for the Soundstage virtual camera (import from web/soundstage.js).
//
//   import { listenVcam, LiveVcam, fetchTake, takeToCamera, anchorFromCamera } from "./vcam/live.mjs";
//
//   const live = new LiveVcam();                       // live preview while the operator moves
//   listenVcam(api, {
//     onPose: (p) => stage.previewCamera?.(live.update(p, anchorFromCamera(stage._cameraAt(stage.frame)))),
//     onState: (s) => { if (s.event === "record") live.zero(); },
//     onTake: async (t) => {
//       const take = await fetchTake(api, t.id);
//       const { keys, frames, rig } = takeToCamera(take, { anchor: anchorFromCamera(stage._cameraAt(0)) });
//       stage.state.camera_keys = keys;               // Catmull-Rom through these ≈ the stabilized move
//     },
//   });

import { stabilize, suggestRig, qmul, qrotate, forwardOf, eulerOf } from "../movefit/stabilize.mjs";

export const VCAM_EVENT = "soundstage.vcam";

/** Subscribe to device messages relayed by soundstage/vcam.py. Returns an unsubscribe function. */
export function listenVcam(api, { onPose, onState, onTake } = {}) {
  const handler = (e) => {
    const m = e.detail;
    if (!m) return;
    if (m.type === "pose") onPose?.(m);
    else if (m.type === "state") onState?.(m);
    else if (m.type === "take") onTake?.(m);
  };
  api.addEventListener(VCAM_EVENT, handler);
  return () => api.removeEventListener(VCAM_EVENT, handler);
}

export async function listTakes(api) {
  const r = await api.fetchApi("/soundstage/vcam/takes");
  return r.ok ? r.json() : [];
}

export async function fetchTake(api, id) {
  const r = await api.fetchApi(`/soundstage/vcam/take?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`take ${id}: ${r.status}`);
  return r.json();
}

/** {position, yaw} for stabilize()'s `anchor` from a stage camera {position, target}. */
export function anchorFromCamera(cam) {
  const d = [cam.target[0] - cam.position[0], cam.target[2] - cam.position[2]];
  return { position: [...cam.position], yaw: (Math.atan2(-d[0], -d[1]) * 180) / Math.PI };
}

/**
 * Stabilize a stored take into stage camera data.
 * Settings recorded on the device (strength, horizonLock, keepHandheld, scale) are the defaults;
 * `overrides` wins (e.g. a Strength slider in the stage UI re-stabilizes the same take).
 * rig = an optional suggestion ("dolly-in", "pan left"...) with a snapped alternative. Never applied here.
 */
export function takeToCamera(take, { anchor = null, startFrame = 0, fps = 24, focusDistance = 5, overrides = {}, suggest = true } = {}) {
  const opts = { ...(take.settings || {}), ...overrides, anchor, startFrame, fps, focusDistance };
  const result = stabilize(take.samples || [], opts);
  const rig = suggest ? suggestRig(result.frames, opts) : null;
  return { ...result, rig };
}

/**
 * Live preview: maps streamed device poses onto the set. The device zeroes its own position
 * and heading on Recenter; zero() additionally re-zeroes here (call it when recording starts so
 * the preview and the stabilized take both start at the anchor).
 */
export class LiveVcam {
  constructor({ focusDistance = 5 } = {}) {
    this.focusDistance = focusDistance;
    this.origin = null;
    this.originYaw = 0;
    this.last = null;
  }

  zero() { this.origin = null; }

  /** payload = a "pose" message; anchor = {position, yaw}. Returns {position, target, focal_mm, quaternion}. */
  update(payload, anchor = { position: [0, 1.6, 0], yaw: 0 }) {
    this.last = payload;
    const scale = payload.settings?.scale ?? 1;
    if (!this.origin) { this.origin = [...payload.position]; this.originYaw = eulerOf(payload.quaternion).yaw; }
    const yaw = (((anchor.yaw ?? 0) - this.originYaw) * Math.PI) / 180;
    const yq = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    const rel = payload.position.map((v, k) => (v - this.origin[k]) * scale);
    const off = qrotate(yq, rel);
    const position = anchor.position.map((v, k) => v + off[k]);
    let quaternion = qmul(yq, payload.quaternion);
    const fwd = forwardOf(quaternion);
    return {
      position,
      target: position.map((v, k) => v + fwd[k] * this.focusDistance),
      focal_mm: payload.focal_mm ?? payload.settings?.focal_mm ?? 35,
      quaternion,
    };
  }
}
