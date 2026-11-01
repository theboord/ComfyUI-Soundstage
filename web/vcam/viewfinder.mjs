// Soundstage phone viewfinder: the phone renders the stage itself, through the shot camera, and is that camera.
// Served at /soundstage/vcam/viewfinder (soundstage/vcam.py); this module loads from /extensions/<pack>/vcam/.
//
// The desktop App publishes its scene (POST /soundstage/vcam/scene) and playhead (/sync); the server pushes both down this
// page's WebSocket. The page builds the same Stage (web/stage/stage.mjs) from that scene, so the picture is the App's own
// Clay / Color view with its lighting, rendered locally: no video stream, no network in the picture's latency.
// Up the same socket go the live camera ({type:"vf"}, ~30 Hz) and events ({type:"vfstate"}); a recorded take is POSTed to
// /soundstage/vcam/take and the desktop turns it into camera keys on the current shot (web/vcam/desk.mjs).

import * as THREE from "../vendor/three.module.min.mjs";
import { Stage } from "../stage/stage.mjs";
import * as Mocap from "../stage/mocap.mjs";
import { createDof } from "./dof.mjs";
import {
  PRIMES, FULL_STOPS, FOCUS_MARKS, FOCUS_INF, clampFocal, clampFocus, clampStop, nearestPrime, pinchFocal, rockerFocal, approach,
  ringToFocus, focusToRing, sliderToStop, stopToSlider, snapStop, fmtStop, fmtFocus, dofLimits, cocScale, viewRect, innerAspect,
  timecode, gyroQuat, rollRad, VfRig, TakeRecorder, takeToKeys, vfMessage, vfState, sceneSig, patchCameras, parseServer, ASPECT_RATIO,
} from "./vfcore.mjs";
import { eulerOf, forwardOf } from "../movefit/stabilize.mjs";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("soundstage.vf." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("soundstage.vf." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const DEVICE = (() => {
  let id = store.get("device", null);
  if (!id) { id = "vf-" + Math.random().toString(36).slice(2, 7); store.set("device", id); }
  return id;
})();
const MASKS = [null, "2.39", "1.85", "16:9"];

// ---------------------------------------------------------------- state
const S = {
  focal: 35, focalT: 35, focus: 3, focusT: 3, stop: 2.8, stopT: 2.8,
  view: "clay", viewByUser: false,
  gyroOn: false, gyroQ: null, gyroAt: 0, phoneRoll: 0,
  level: store.get("level", true), stab: store.get("stab", false), grid: store.get("grid", true), mask: store.get("mask", null), dofOn: store.get("dof", true),
  stick: [0, 0], rise: 0, rocker: 0, rockerHeld: 0,
  dial: null, marks: { A: null, B: null }, pull: null, pullTime: 1, tapFocus: null,
  countdown: null, review: null, takes: 0,
  sync: { frame: 0, playing: false, at: 0, fps: 24 }, frame: 0, lastSentAt: 0, lastSent: "",
  sceneSig: "", sceneRev: 0, haveScene: false,
  connected: false, xr: null, xrPose: null,
  pr: Math.min(2, window.devicePixelRatio || 1), slowFrames: 0, fastFrames: 0,
};
const rig = new VfRig();
rig.level = S.level;
const rec = new TakeRecorder();

// ---------------------------------------------------------------- the stage (the App's own renderer)
const host = $("stage");
const stage = new Stage(host, () => {});
stage.render = () => {};                 // this page's loop draws every frame
stage.resize = () => {};
stage.canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none";
stage.canvas.tabIndex = -1;
const renderer = stage.renderer;
renderer.setPixelRatio(S.pr);
// A phone doesn't need a 2k sun shadow; 1k keeps the look at half the cost.
stage.sun.shadow.mapSize.set(1024, 1024);
stage.sun.shadow.map?.dispose(); stage.sun.shadow.map = null;
const dof = createDof(THREE, renderer);
const raycaster = new THREE.Raycaster();

const shot = () => stage.activeShot?.() || {};
const shotInfo = () => {
  const st = stage.state.shot || {};
  return { frames: Math.max(1, st.frames || 97), fps: st.fps || 24, aspect: stage.fw / stage.fh };   // the delivery frame the stage renders
};

function setLensFrom(cam) {
  S.focal = S.focalT = clampFocal(cam.focal_mm || 35);
  const d = Math.hypot(...cam.target.map((v, k) => v - cam.position[k]));
  S.focus = S.focusT = clampFocus(cam.focus_m || d || 3);
  S.stop = S.stopT = clampStop(cam.t_stop || S.stopT || 2.8);
}

function recenter(toast = true) {
  const cam = stage._shotCameraAt(Math.floor(S.frame));
  rig.recenter(cam);
  if (toast) say("Back on the shot camera");
}

function loadScene(scene, rev) {
  const sig = sceneSig(scene);
  if (sig === S.sceneSig && S.haveScene) {
    patchCameras(stage.state, scene);     // only the camera changed (e.g. a take was applied): no set rebuild
    stage._rigCache = null;
  } else {
    stage.load(scene);
    S.sceneSig = sig;
    for (const a of stage.state.actors || []) {
      if (a.mocap?.file && !a.mocap.data) Mocap.load(a.mocap.file).then(() => stage.setFrameSilent(Math.floor(S.frame))).catch(() => {});
    }
  }
  const first = !S.haveScene;
  S.haveScene = true;
  S.sceneRev = rev || S.sceneRev + 1;
  if (!S.viewByUser && scene) setView(stage.view || "clay", false);
  if (first) { stage.setFrameSilent(Math.floor(S.frame)); const cam = stage._shotCameraAt(Math.floor(S.frame)); setLensFrom(cam); rig.recenter(cam); }
  $("shotname").textContent = shot().name || "Shot";
  updateReadouts();
}

function setView(v, byUser = true) {
  S.view = v === "color" ? "color" : "clay";
  if (byUser) S.viewByUser = true;
  stage.setView(S.view);
  $("vClay").setAttribute("aria-pressed", String(S.view === "clay"));
  $("vColor").setAttribute("aria-pressed", String(S.view === "color"));
}

// ---------------------------------------------------------------- network
let ws = null, wsTries = 0;
function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/soundstage/vcam/ws?device=${encodeURIComponent(DEVICE)}`;
  try { ws = new WebSocket(url); } catch { return retry(); }
  setConn("wait", "connecting");
  ws.onopen = () => { wsTries = 0; S.connected = true; setConn(S.haveScene ? "ok" : "wait", S.haveScene ? "live" : "no App yet"); send(vfState("hello", { ua: navigator.userAgent.slice(0, 80), w: innerWidth, h: innerHeight })); };
  ws.onmessage = (e) => {
    const m = parseServer(e.data);
    if (!m) return;
    if (m.type === "scene") { loadScene(m.scene, m.rev); if (m.sync) onSync(m.sync); setConn("ok", "live"); }
    else if (m.type === "sync") onSync(m);
  };
  ws.onclose = () => { S.connected = false; setConn("bad", "offline"); retry(); };
  ws.onerror = () => {};
}
function retry() { setTimeout(connect, Math.min(8000, 500 * 2 ** wsTries++)); }
function send(msg) { if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; }
function setConn(kind, text) { $("conn").className = "pill glass " + (kind === "ok" ? "ok" : kind === "bad" ? "bad" : ""); $("connText").textContent = text; }

function onSync(m) {
  if (Number.isFinite(+m.frame)) S.sync = { frame: +m.frame, playing: !!m.playing, at: performance.now(), fps: m.fps || shotInfo().fps };
  if (m.view && !S.viewByUser && m.view !== S.view && (m.view === "clay" || m.view === "color")) setView(m.view, false);
  if (m.take && S.review && m.take.id === S.review.id) {
    S.review.desk = m.take;
    $("rvDesk").textContent = m.take.status === "applied" ? `✓ on the desktop · ${m.take.keys} keys on ${m.take.shot || "the shot"}` : m.take.status;
    $("rvDesk").className = m.take.status === "applied" ? "ok" : "";
  }
}

// ---------------------------------------------------------------- sensors
function onOrientation(e) {
  if (e.alpha === null && e.beta === null) return;
  const angle = (screen.orientation && Number.isFinite(screen.orientation.angle)) ? screen.orientation.angle : (window.orientation || 0);
  S.gyroQ = gyroQuat(e.alpha || 0, e.beta || 0, e.gamma || 0, angle);
  S.gyroAt = performance.now();
  S.phoneRoll = rollRad(S.gyroQ);
  if (!S.gyroOn && !S.gyroOff) setGyro(true);
}
function setGyro(on) {
  S.gyroOn = !!on;
  if (!on) S.gyroOff = true; else S.gyroOff = false;
  $("gyroBtn").setAttribute("aria-pressed", String(S.gyroOn));
  rig.recenter(stage._shotCameraAt(Math.floor(S.frame)));
}
async function enableMotion() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") { say("Motion not allowed: drag the picture to look around"); return; }
    }
  } catch { say("Motion sensors need the https address (see the desktop's QR panel)"); return; }
  window.addEventListener("deviceorientation", onOrientation);
}

// ---------------------------------------------------------------- WebXR AR (6-DoF walk, Android Chrome)
async function startXR() {
  if (S.xr) { S.xr.end(); return; }
  let session;
  try { session = await navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["local"], optionalFeatures: ["dom-overlay"], domOverlay: { root: document.body } }); }
  catch (e) { say("AR could not start: " + e.message); return; }
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2", { xrCompatible: true }) || c.getContext("webgl", { xrCompatible: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const ref = await session.requestReferenceSpace("local");
  S.xr = session; document.body.classList.add("xr");
  $("arBtn").setAttribute("aria-pressed", "true");
  rig.recenter(stage._shotCameraAt(Math.floor(S.frame)));
  const onFrame = (t, frame) => {
    if (!S.xr) return;
    session.requestAnimationFrame(onFrame);
    const v = frame.getViewerPose(ref);
    if (v) { const p = v.transform.position, o = v.transform.orientation; S.xrPose = { position: [p.x, p.y, p.z], quaternion: [o.x, o.y, o.z, o.w] }; }
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    tick(performance.now());
  };
  session.requestAnimationFrame(onFrame);
  session.addEventListener("end", () => { S.xr = null; S.xrPose = null; document.body.classList.remove("xr"); $("arBtn").setAttribute("aria-pressed", "false"); rig.recenter(stage._shotCameraAt(Math.floor(S.frame))); requestAnimationFrame(loop); });
  say("Walk AR: walk the room to move the camera");
}

// ---------------------------------------------------------------- gestures on the picture
const touchEl = $("touch");
const pts = new Map();
let gesture = null;
touchEl.addEventListener("pointerdown", (e) => {
  touchEl.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), f0: S.focalT };
  } else if (pts.size === 1) gesture = { kind: "tap" };
});
touchEl.addEventListener("pointermove", (e) => {
  const p = pts.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (gesture?.kind === "pinch" && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    S.focalT = pinchFocal(gesture.f0, gesture.d0, Math.hypot(a.x - b.x, a.y - b.y));
    return;
  }
  if (gesture?.kind === "tap" && Math.hypot(p.x - p.x0, p.y - p.y0) > 12) gesture = { kind: "look" };
  if (gesture?.kind === "look") {
    // The picture follows the finger, like dragging a panorama; a longer lens turns slower.
    const degPerPx = (2 * Math.atan(18 / S.focal) * 180 / Math.PI) / Math.max(320, innerWidth * 0.86);
    rig.look(dx * degPerPx, dy * degPerPx);
  }
});
const endPt = (e) => {
  const p = pts.get(e.pointerId);
  pts.delete(e.pointerId);
  if (!p) return;
  if (gesture?.kind === "tap" && pts.size === 0 && performance.now() - p.t0 < 350) focusAt(p.x0, p.y0);
  if (pts.size === 0) gesture = null;
  else if (gesture?.kind === "pinch") gesture = { kind: "none" };
};
touchEl.addEventListener("pointerup", endPt);
touchEl.addEventListener("pointercancel", endPt);

/** Tap to focus: the distance (along the lens axis) to whatever is under the finger. */
function focusAt(x, y) {
  const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, stage.camera);
  const shown = (o) => { for (; o; o = o.parent) if (o.visible === false) return false; return true; };
  const hits = raycaster.intersectObjects(stage.root.children, true)
    .filter((h) => h.object.isMesh && shown(h.object) && !h.object.userData?.lightId && h.object !== stage.selRing && !h.object.userData?.glass);
  const fwd = new THREE.Vector3(); stage.camera.getWorldDirection(fwd);
  let d = FOCUS_INF;
  if (hits.length) d = hits[0].point.clone().sub(stage.camera.position).dot(fwd);
  S.pull = null;
  S.focusT = clampFocus(d);
  S.tapFocus = { x, y, at: performance.now(), d: S.focusT, hit: !!hits.length };
}

// ---------------------------------------------------------------- controls
function hold(el, onDown, onUp) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("held"); onDown(e); });
  const up = () => { el.classList.remove("held"); onUp(); };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
}
hold($("zoomT"), () => { S.rocker = 1; S.rockerHeld = 0; }, () => { S.rocker = 0; });
hold($("zoomW"), () => { S.rocker = -1; S.rockerHeld = 0; }, () => { S.rocker = 0; });

const primeBtns = PRIMES.map((mm) => {
  const b = document.createElement("button");
  b.className = "prime"; b.dataset.mm = mm;
  b.innerHTML = `${mm}<small>mm</small>`;
  b.title = `${mm} mm prime`;
  b.addEventListener("click", () => { S.focalT = mm; });
  $("primes").append(b);
  return b;
});

function stick(el, onMove, axis2 = true) {
  const knob = el.querySelector("b");
  let id = null;
  const set = (e) => {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.height / 2 - 8;
    let x = axis2 ? (e.clientX - cx) / R : 0, y = (e.clientY - cy) / R;
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    knob.style.transform = `translate(${x * R * 0.75}px, ${y * R * (axis2 ? 0.75 : 0.85)}px)`;
    onMove(x, -y);
  };
  el.addEventListener("pointerdown", (e) => { id = e.pointerId; el.setPointerCapture(id); set(e); });
  el.addEventListener("pointermove", (e) => { if (e.pointerId === id) set(e); });
  const end = () => { id = null; knob.style.transform = ""; onMove(0, 0); };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
// Gentle near the middle, full speed at the edge (a cubic-ish curve), so small nudges are small.
const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.7);
stick($("stick"), (x, y) => { S.stick = [curve(x), curve(y)]; });
stick($("rise"), (_, y) => { S.rise = curve(y); }, false);

const toggle = (id, key, apply) => {
  const b = $(id);
  b.setAttribute("aria-pressed", String(!!S[key]));
  b.addEventListener("click", () => { S[key] = !S[key]; b.setAttribute("aria-pressed", String(S[key])); store.set(key === "dofOn" ? "dof" : key, S[key]); apply?.(S[key]); });
};
toggle("levelBtn", "level", (v) => { rig.level = v; say(v ? "Level: the horizon stays flat" : "Level off: roll with the phone (Dutch angles)"); });
toggle("stabBtn", "stab", (v) => say(v ? "Stabilize: takes are smoothed like a gimbal" : "Stabilize off: light smoothing only"));
toggle("dofBtn", "dofOn", (v) => say(v ? "Depth of field preview on" : "Depth of field preview off"));
toggle("guidesBtn", "grid");
$("gyroBtn").addEventListener("click", () => {
  if (!S.gyroQ) { enableMotion(); say(window.isSecureContext ? "Waiting for the motion sensors…" : "Motion sensors need the https address (see the desktop's QR panel)"); return; }
  setGyro(!S.gyroOn);
  say(S.gyroOn ? "Motion on: point the phone to aim" : "Motion off: drag the picture to aim");
});
$("recenter").addEventListener("click", () => recenter());
$("vClay").addEventListener("click", () => setView("clay"));
$("vColor").addEventListener("click", () => setView("color"));
$("maskBtn").addEventListener("click", () => {
  const i = (MASKS.indexOf(S.mask) + 1) % MASKS.length;
  S.mask = MASKS[i]; store.set("mask", S.mask);
  $("maskBtn").textContent = S.mask ? `Frame ${S.mask}` : "Frame";
  $("maskBtn").setAttribute("aria-pressed", String(!!S.mask));
});
if (S.mask) { $("maskBtn").textContent = `Frame ${S.mask}`; $("maskBtn").setAttribute("aria-pressed", "true"); }
$("arBtn").addEventListener("click", startXR);
(async () => { try { if (navigator.xr && window.isSecureContext && await navigator.xr.isSessionSupported("immersive-ar")) $("arBtn").hidden = false; } catch { /* no AR */ } })();

// ---- the dial (iris or focus ring): drag the ruler under the centre mark, like the iPhone's zoom dial
const ruler = $("ruler");
function openDial(which) {
  S.dial = S.dial === which ? null : which;
  $("dial").className = "glass" + (S.dial ? " open" : "") + (S.dial === "focus" ? " focus" : "");
  $("stopChip").setAttribute("aria-expanded", String(S.dial === "stop"));
  $("focusChip").setAttribute("aria-expanded", String(S.dial === "focus"));
  $("dialName").textContent = S.dial === "focus" ? "Focus" : "Iris";
  drawRuler();
}
$("stopChip").addEventListener("click", () => openDial("stop"));
$("focusChip").addEventListener("click", () => openDial("focus"));
const dialU = () => (S.dial === "focus" ? focusToRing(S.focusT) : stopToSlider(S.stopT));
const setDialU = (u) => {
  if (S.dial === "focus") { S.pull = null; S.focusT = ringToFocus(u); S.tapFocus = null; }
  else S.stopT = sliderToStop(u);
};
let rulerDrag = null;
ruler.addEventListener("pointerdown", (e) => { ruler.setPointerCapture(e.pointerId); rulerDrag = { x: e.clientX, u: dialU() }; });
ruler.addEventListener("pointermove", (e) => {
  if (!rulerDrag) return;
  const w = ruler.clientWidth * 1.4;   // the whole range is 1.4 ruler-widths of travel
  setDialU(Math.max(0, Math.min(1, rulerDrag.u - (e.clientX - rulerDrag.x) / w)));
  drawRuler();
});
ruler.addEventListener("pointerup", () => { rulerDrag = null; });
ruler.addEventListener("pointercancel", () => { rulerDrag = null; });
function drawRuler() {
  if (!S.dial) return;
  const dpr = window.devicePixelRatio || 1, w = ruler.clientWidth, h = ruler.clientHeight;
  if (ruler.width !== Math.round(w * dpr)) { ruler.width = Math.round(w * dpr); ruler.height = Math.round(h * dpr); }
  const g = ruler.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const span = w * 1.4, u0 = dialU(), X = (u) => w / 2 + (u - u0) * span;
  g.font = "600 11px -apple-system, sans-serif"; g.textAlign = "center"; g.fillStyle = "#cfc8d2"; g.strokeStyle = "rgba(255,255,255,.45)";
  if (S.dial === "focus") {
    for (let u = 0; u <= 1.0001; u += 0.025) { const x = X(u); if (x < -4 || x > w + 4) continue; g.beginPath(); g.moveTo(x, h - 8); g.lineTo(x, h - 14); g.stroke(); }
    for (const m of FOCUS_MARKS) { const x = X(focusToRing(m)); if (x < -20 || x > w + 20) continue; g.beginPath(); g.moveTo(x, h - 6); g.lineTo(x, h - 20); g.stroke(); g.fillText(fmtFocus(m), x, 15); }
    for (const k of ["A", "B"]) if (S.marks[k]) { const x = X(focusToRing(S.marks[k])); g.fillStyle = "#f2ff59"; g.fillText(k, x, 30); g.fillStyle = "#cfc8d2"; }
  } else {
    for (let s = 0; s <= 24; s++) { const u = s / 24, x = X(u); if (x < -4 || x > w + 4) continue; g.beginPath(); g.moveTo(x, h - 8); g.lineTo(x, h - (s % 3 ? 13 : 20)); g.stroke(); }
    for (const n of FULL_STOPS) { const x = X(stopToSlider(n)); if (x < -20 || x > w + 20) continue; g.fillText(String(n), x, 15); }
  }
  g.fillStyle = "#f2ff59"; g.beginPath(); g.moveTo(w / 2 - 6, h); g.lineTo(w / 2 + 6, h); g.lineTo(w / 2, h - 10); g.fill();
  g.fillRect(w / 2 - 1, 20, 2, h - 26);
}
for (const k of ["A", "B"]) {
  $("mark" + k).addEventListener("click", () => {
    S.marks[k] = S.focusT; $("mark" + k + "v").textContent = fmtFocus(S.focusT);
    $("mark" + k).setAttribute("aria-pressed", "true"); drawRuler();
  });
}
const PULLS = [0.5, 1, 2, 3];
$("pullTime").addEventListener("click", () => { S.pullTime = PULLS[(PULLS.indexOf(S.pullTime) + 1) % PULLS.length]; $("pullTime").textContent = `${S.pullTime.toFixed(1)} s`; });
/** Rack focus: pull from where focus is now to the other mark over the pull time (eased, in diopters, like a hand on a ring). */
function pullFocus() {
  const { A, B } = S.marks;
  if (!A || !B) { say("Set marks A and B first: focus, then tap A; focus again, then tap B"); return; }
  const to = Math.abs(1 / S.focusT - 1 / A) < Math.abs(1 / S.focusT - 1 / B) ? B : A;
  S.pull = { from: S.focusT, to, t0: performance.now(), dur: S.pullTime * 1000 };
  S.tapFocus = null;
}
$("pull").addEventListener("click", pullFocus);

// ---------------------------------------------------------------- record / review
$("rec").addEventListener("click", () => {
  if (S.countdown) { S.countdown = null; $("count").className = ""; return; }
  if (rec.on) return stopRecording();
  if (S.review) discardTake(false);
  startCountdown();
});
function startCountdown() {
  S.countdown = { t0: performance.now(), beats: 3 };
  S.frame = 0;
  stage.setFrameSilent(0);
  send(vfState("arm", { startFrame: 0, fps: shotInfo().fps }));
}
function startRecording() {
  const { fps, frames } = shotInfo();
  S.countdown = null; $("count").className = "";
  rec.start(performance.now() / 1000, 0, fps);
  rec.lastFrame = frames - 1;
  $("rec").classList.add("on"); $("tc").classList.add("rec"); document.body.classList.add("rec");
  send(vfState("record", { startFrame: 0, fps, lastFrame: frames - 1, shot: shot().id || "" }));
  closeDial();
}
function closeDial() { if (S.dial) openDial(S.dial); }
async function stopRecording() {
  const samples = rec.stop();
  $("rec").classList.remove("on"); $("tc").classList.remove("rec"); document.body.classList.remove("rec");
  send(vfState("stop", { seconds: rec.seconds }));
  if (samples.length < 3) { say("Too short: hold ● a little longer"); return; }
  S.takes++;
  const { fps, frames } = shotInfo();
  const take = { name: `take ${S.takes}`, device: DEVICE, mode: "viewfinder", samples,
    settings: { space: "set", startFrame: 0, fps, lastFrame: frames - 1, stabilize: S.stab, horizonLock: S.level } };
  const { keys, lensKeys, info } = takeToKeys(take);
  const prev = { keys: JSON.parse(JSON.stringify(shot().camera_keys || [])), rig: JSON.parse(JSON.stringify(shot().rig || null)),
    lens: JSON.parse(JSON.stringify(shot().lens_keys || null)) };
  S.review = { id: null, name: `Take ${S.takes}`, keys, lensKeys, info, prev, t0: performance.now(), frames: info.frames };
  applyKeys(keys, lensKeys);
  $("rvName").textContent = `Take ${S.takes}`;
  $("rvInfo").textContent = `${timecode(info.frames, fps)} · ${keys.length} camera + ${lensKeys.length} lens keys${S.stab ? " · stabilized" : ""}`;
  $("rvDesk").textContent = "sending to the desktop…"; $("rvDesk").className = "";
  $("review").className = "open"; document.body.classList.add("review");
  $("takeCount").textContent = `${S.takes} take${S.takes > 1 ? "s" : ""}`;
  try {
    const r = await fetch("/soundstage/vcam/take", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(take) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    if (S.review) { S.review.id = j.id; if (!S.review.desk) $("rvDesk").textContent = "saved · waiting for the desktop to apply it"; }
  } catch (e) { $("rvDesk").textContent = "not saved: " + e.message; }
}
function applyKeys(keys, lensKeys) {
  const sh = shot();
  sh.camera_keys = JSON.parse(JSON.stringify(keys));
  sh.lens_keys = JSON.parse(JSON.stringify(lensKeys || []));
  if (sh.rig && sh.rig.type && sh.rig.type !== "free") sh.rig = { ...sh.rig, type: "free" };
  stage.state.camera_keys = sh.camera_keys;
  stage._rigCache = null;
}
function endReview() { S.review = null; $("review").className = ""; document.body.classList.remove("review"); recenter(false); }
function keepTake() {
  if (!S.review) return;
  send(vfState("keep", { id: S.review.id || "", keys: S.review.keys.length }));
  say(`${S.review.name} kept on the shot`);
  endReview();
}
function discardTake(toast = true) {
  if (!S.review) return;
  const sh = shot();
  sh.camera_keys = S.review.prev.keys; if (S.review.prev.rig) sh.rig = S.review.prev.rig; else delete sh.rig;
  if (S.review.prev.lens) sh.lens_keys = S.review.prev.lens; else delete sh.lens_keys;
  stage.state.camera_keys = sh.camera_keys; stage._rigCache = null;
  send(vfState("discard", { id: S.review.id || "" }));
  if (toast) say(`${S.review.name} discarded`);
  endReview();
}
$("rvKeep").addEventListener("click", keepTake);
$("rvDiscard").addEventListener("click", () => discardTake());
$("rvAgain").addEventListener("click", () => { discardTake(false); startCountdown(); });

// ---------------------------------------------------------------- HUD
const hud = $("hud"), hg = hud.getContext("2d");
let toastTimer = 0;
function say(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2600); }

function drawHud(vr, cam) {
  const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (hud.width !== Math.round(W * dpr) || hud.height !== Math.round(H * dpr)) { hud.width = Math.round(W * dpr); hud.height = Math.round(H * dpr); }
  const g = hg;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const r = vr.rect;
  // surround outside the delivery frame
  g.fillStyle = "rgba(0,0,0,.58)";
  g.fillRect(0, 0, W, r.y); g.fillRect(0, r.y + r.h, W, H - r.y - r.h); g.fillRect(0, r.y, r.x, r.h); g.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h);
  let fr = r;
  if (S.mask && Math.abs(ASPECT_RATIO[S.mask] - r.w / r.h) > 0.01) {
    fr = innerAspect(r, ASPECT_RATIO[S.mask]);
    g.fillStyle = "rgba(0,0,0,.4)";
    g.fillRect(r.x, r.y, r.w, fr.y - r.y); g.fillRect(r.x, fr.y + fr.h, r.w, r.y + r.h - fr.y - fr.h);
    g.fillRect(r.x, fr.y, fr.x - r.x, fr.h); g.fillRect(fr.x + fr.w, fr.y, r.x + r.w - fr.x - fr.w, fr.h);
    g.strokeStyle = "rgba(242,255,89,.7)"; g.lineWidth = 1; g.strokeRect(fr.x + 0.5, fr.y + 0.5, fr.w - 1, fr.h - 1);
    g.fillStyle = "rgba(242,255,89,.85)"; g.font = "600 10px -apple-system, sans-serif"; g.fillText(S.mask, fr.x + 6, fr.y + fr.h - 6);
  }
  g.strokeStyle = rec.on ? "rgba(255,59,48,.95)" : "rgba(255,255,255,.38)"; g.lineWidth = rec.on ? 3 : 1;
  g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  if (S.grid) {
    g.strokeStyle = "rgba(255,255,255,.26)"; g.lineWidth = 1; g.beginPath();
    for (const k of [1, 2]) { g.moveTo(fr.x + (fr.w * k) / 3, fr.y); g.lineTo(fr.x + (fr.w * k) / 3, fr.y + fr.h); g.moveTo(fr.x, fr.y + (fr.h * k) / 3); g.lineTo(fr.x + fr.w, fr.y + (fr.h * k) / 3); }
    g.stroke();
  }
  // centre mark + level: the bar shows the phone's tilt; green when level within 1°
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const roll = S.gyroOn && S.gyroQ ? S.phoneRoll : (cam.roll || 0);
  const ok = Math.abs(roll) < Math.PI / 180;
  g.save(); g.translate(cx, cy);
  g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); g.moveTo(0, -6); g.lineTo(0, 6); g.stroke();
  g.rotate(-roll);
  g.strokeStyle = ok ? "rgba(63,208,122,.95)" : "rgba(255,200,64,.9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(-70, 0); g.lineTo(-22, 0); g.moveTo(22, 0); g.lineTo(70, 0); g.stroke();
  g.restore();
  if (!ok && S.gyroOn) { g.fillStyle = "rgba(255,200,64,.9)"; g.font = "600 11px -apple-system, sans-serif"; g.textAlign = "center"; g.fillText(`${(roll * 180 / Math.PI).toFixed(1)}°`, cx, cy + 18); g.textAlign = "left"; }
  // tap-to-focus square
  const tf = S.tapFocus;
  if (tf && performance.now() - tf.at < 1600) {
    const a = 1 - Math.max(0, (performance.now() - tf.at - 900) / 700), s = 70 - Math.min(1, (performance.now() - tf.at) / 180) * 14;
    g.globalAlpha = a; g.strokeStyle = "#f2ff59"; g.lineWidth = 1.5; g.strokeRect(tf.x - s / 2, tf.y - s / 2, s, s);
    g.fillStyle = "#f2ff59"; g.font = "600 12px -apple-system, sans-serif"; g.fillText(tf.hit ? fmtFocus(tf.d) : "∞", tf.x + s / 2 + 5, tf.y - s / 2 + 12);
    g.globalAlpha = 1;
  }
  // focus pull progress
  if (S.pull) {
    const u = Math.min(1, (performance.now() - S.pull.t0) / S.pull.dur);
    g.fillStyle = "rgba(242,255,89,.9)"; g.fillRect(r.x, r.y + r.h - 3, r.w * u, 3);
  }
}

function updateReadouts() {
  $("stopVal").textContent = fmtStop(S.stopT);
  $("focusVal").textContent = fmtFocus(S.focusT);
  const near = nearestPrime(S.focal);
  for (const b of primeBtns) b.setAttribute("aria-pressed", String(+b.dataset.mm === near && Math.abs(near / S.focal - 1) < 0.03));
  if (S.dial) {
    $("dialVal").textContent = S.dial === "focus" ? fmtFocus(S.focusT) : fmtStop(S.stopT);
    const d = dofLimits(S.focal, S.stop, S.focus);
    $("dialInfo").textContent = `${Math.round(S.focal)} mm · DoF ${fmtFocus(d.near)} – ${d.far === Infinity ? "∞" : fmtFocus(d.far)}`;
  }
}

// ---------------------------------------------------------------- the loop
let last = performance.now(), lastReadout = 0;
function loop(now) {
  if (S.xr) return;          // the XR session drives tick() while it runs
  requestAnimationFrame(loop);
  tick(now);
}
function tick(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  const { fps, frames } = shotInfo();
  // lens: zoom rocker accelerates the longer it's held; everything eases toward its target (smooth zoom / focus / iris)
  if (S.rocker) { S.rockerHeld += dt; S.focalT = rockerFocal(S.focalT, S.rocker, dt, 0.45 + Math.min(1.1, S.rockerHeld * 0.9)); }
  S.focal = approach(S.focal, S.focalT, dt, 0.09, true);
  if (S.pull) {
    const u = Math.min(1, (now - S.pull.t0) / S.pull.dur), e = u * u * (3 - 2 * u);
    S.focusT = 1 / (1 / S.pull.from + (1 / S.pull.to - 1 / S.pull.from) * e);
    S.focus = S.focusT;
    if (u >= 1) S.pull = null;
  } else S.focus = approach(S.focus, S.focusT, dt, 0.08, true);
  S.stop = approach(S.stop, S.stopT, dt, 0.08, true);

  // where in the shot: review playback > recording > countdown > following the desktop's playhead
  let frame = S.frame, cam;
  if (S.review) {
    const span = Math.max(1, S.review.frames);
    frame = Math.floor(((now - S.review.t0) / 1000) * fps) % (span + Math.round(fps * 0.6));   // a short hold at the end, then loop
    frame = Math.min(frame, span - 1);
    const c = stage._shotCameraAt(frame);
    cam = { position: c.position, target: c.target, roll: c.roll || 0, quaternion: null };
    S.focal = c.focal_mm; if (c.focus_m) S.focus = c.focus_m; if (c.t_stop) S.stop = c.t_stop;
  } else {
    if (rec.on) frame = rec.clock(now / 1000).frame;
    else if (S.countdown) {
      const beat = Math.floor((now - S.countdown.t0) / 600);
      if (beat >= S.countdown.beats) { startRecording(); frame = 0; }
      else { $("count").textContent = String(S.countdown.beats - beat); $("count").className = "on"; frame = 0; }
    } else if (S.sync.at) frame = S.sync.frame + (S.sync.playing ? ((now - S.sync.at) / 1000) * S.sync.fps : 0);
    const gyro = S.gyroOn && S.gyroQ && now - S.gyroAt < 1500 ? S.gyroQ : null;
    cam = rig.step(dt, { gyro, stick: S.stick, rise: S.rise, xr: S.xr ? S.xrPose : null });
  }
  frame = Math.max(0, Math.min(frames - 1, frame));
  if (Math.floor(frame) !== Math.floor(S.frame) || !S.drawnOnce) stage.setFrameSilent(Math.floor(frame));
  S.frame = frame;

  // camera: the shot camera is ours (stage previewCamera), drawn full screen with the frame inside it
  stage._preview = { position: cam.position, target: cam.target, focal_mm: S.focal, roll: cam.roll || 0 };
  stage._applyCamera();
  const W = innerWidth, H = innerHeight;
  const sh = shotInfo();
  const vr = viewRect(W, H, sh.aspect, S.focal);
  const camera = stage.camera;
  camera.aspect = vr.aspect; camera.fov = vr.vfov; camera.updateProjectionMatrix();
  const pr = S.pr;
  if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== W || size.y !== H) renderer.setSize(W, H, false);
  const K = cocScale(S.focal, S.stop, S.focus, vr.rect.w * pr);
  const blurry = S.dofOn && K > 1.5;            // something far from the focus plane would blur by more than ~1.5 px
  try {
    if (blurry) {
      dof.begin(Math.round(W * pr), Math.round(H * pr));
      stage._renderMode(S.view, true);
      dof.end({ camera, K, focus: S.focus, maxPx: 16 * pr });
    } else {
      renderer.setRenderTarget(null);
      stage._renderMode(S.view, true);
    }
  } catch (e) { renderer.setRenderTarget(null); console.warn("viewfinder render", e); }
  S.drawnOnce = true;

  if (rec.on) {
    const q = cam.quaternion;
    rec.add(now / 1000, { position: cam.position, quaternion: q, focal_mm: S.focal, focus_m: S.focus, t_stop: S.stop });
    if (frame >= rec.lastFrame) stopRecording();
  }
  drawHud(vr, cam);
  $("tcText").textContent = timecode(frame, fps);
  if (now - lastReadout > 120) { lastReadout = now; updateReadouts(); if (S.dial && !rulerDrag) drawRuler(); }

  // live camera up to the desktop, ~30 Hz (1 Hz when nothing moves)
  if (!S.review && now - S.lastSentAt > 33) {
    const msg = vfMessage({ ...cam, focal_mm: S.focal, focus_m: S.focus, t_stop: S.stop }, { frame, recording: rec.on, t: now / 1000, view: S.view });
    const sig = JSON.stringify([msg.cam, msg.frame, msg.recording]);
    if (sig !== S.lastSent || now - S.lastSentAt > 1000) { if (send(msg)) { S.lastSent = sig; S.lastSentAt = now; } }
  }
  // keep it fluid: lower the resolution when frames run long, raise it back when there is headroom
  const ms = dt * 1000;
  if (ms > 40) S.slowFrames++; else S.slowFrames = Math.max(0, S.slowFrames - 1);
  if (ms < 20) S.fastFrames++; else S.fastFrames = 0;
  if (S.slowFrames > 45 && S.pr > 0.75) { S.pr = Math.max(0.75, S.pr - 0.25); S.slowFrames = 0; }
  if (S.fastFrames > 240 && S.pr < Math.min(2, window.devicePixelRatio || 1)) { S.pr = Math.min(2, S.pr + 0.25); S.fastFrames = 0; }
}

// ---------------------------------------------------------------- start
function orient() { document.body.classList.toggle("portrait", innerHeight > innerWidth); }
addEventListener("resize", orient); orient();
$("rotate").classList.add("show");
$("rotateOk").addEventListener("click", () => $("rotate").classList.remove("show"));

const msg = $("splashMsg");
msg.textContent = window.isSecureContext ? "Ready." : "Ready (plain http: motion sensors are off, drag the picture to aim; use the https address for motion).";
if (!window.isSecureContext) msg.className = "warn";
$("go").disabled = false;
$("go").addEventListener("click", async () => {
  document.body.classList.add("started");
  try { await document.documentElement.requestFullscreen?.({ navigationUI: "hide" }); } catch { /* iOS: no fullscreen API for pages */ }
  try { await screen.orientation?.lock?.("landscape"); } catch { /* not allowed outside fullscreen / on iOS */ }
  await enableMotion();
  setTimeout(() => { if (!S.gyroQ) say("No motion sensors yet: drag the picture to aim, pinch to zoom"); }, 1500);
});
document.addEventListener("visibilitychange", () => { if (document.hidden && rec.on) stopRecording(); });
addEventListener("pagehide", () => send(vfState("bye")));

connect();
requestAnimationFrame(loop);
window.__vf = { S, stage, rig, rec, focusAt, pullFocus, keepTake, discardTake, setView, recenter, startCountdown, stopRecording };   // tests
