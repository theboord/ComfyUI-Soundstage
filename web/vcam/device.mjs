// Soundstage VCam device page: turns a phone / tablet / Quest / Vision Pro into a virtual camera.
// Served by soundstage/vcam.py at /soundstage/vcam (this file at /soundstage/vcam/device.mjs).
//
// Pose sources, best first:
//   WebXR immersive-ar (Android Chrome, Quest)  -> 6-DoF, page stays visible via dom-overlay
//   WebXR immersive-vr (Quest, Vision Pro)       -> 6-DoF, controller trigger = record
//   DeviceOrientation (iOS Safari, any phone)    -> 3-DoF rotation + on-screen thumbsticks for position
//   Desktop test mode (no sensors)               -> drag to look + thumbsticks, to try the pipeline
// Poses are in hand space (metres, Y up, camera looks -Z). Scale and placement on the set happen
// on the ComfyUI side (stabilize(samples, {scale, anchor})), so takes stay raw and re-usable.

import { stabilize, suggestRig, eulerOf, qmul } from "./stabilize.mjs";

const $ = (id) => document.getElementById(id);
const DEVICE = (() => {
  try {
    let id = localStorage.getItem("soundstage.vcam.device");
    if (!id) { id = "cam-" + Math.random().toString(36).slice(2, 7); localStorage.setItem("soundstage.vcam.device", id); }
    return id;
  } catch { return "cam-" + Math.random().toString(36).slice(2, 7); }
})();
const SEND_HZ = 30;
const STICK_SPEED = 1.0;  // m/s of virtual hand movement at full stick
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- state
const S = {
  mode: "none",              // "ar" | "vr" | "3dof" | "desktop" | "none"
  pos: [0, 0, 0],
  quat: [0, 0, 0, 1],
  origin: null,              // recenter: hand-space position that maps to 0
  yawOffset: 0,              // recenter: degrees removed from the heading
  recording: false,
  recStart: 0,
  samples: [],
  lastPoseAt: 0,
  rate: 0,
  stickMove: [0, 0],
  stickRise: [0, 0],
  mouseLook: { yaw: 0, pitch: 0 },
  xr: null,
  takeCount: 0,
};

const settings = () => ({
  strength: +$("strength").value / 100,
  keepHandheld: +$("keep").value / 100,
  scale: scaleOf(+$("scale").value),
  focal_mm: focalOf(+$("focal").value),
  horizonLock: $("horizon").checked,
});
const scaleOf = (v) => Math.round(20 ** (v / 100) * 10) / 10;              // 1x .. 20x
const focalOf = (v) => Math.round(18 * (135 / 18) ** (v / 100));          // 18 .. 135 mm

// ---------------------------------------------------------------- UI helpers
function notice(title, text, warn = false) {
  const n = $("notice");
  n.className = warn ? "warn" : "";
  n.innerHTML = `<b>${title}</b>${text ? `<p>${text}</p>` : ""}`;
  n.style.display = title ? "" : "none";
}
const log = (html) => { $("log").innerHTML = html; };
function setMode(m, label) {
  S.mode = m;
  $("mode").textContent = label;
  $("rec").disabled = m === "none";
  document.body.classList.toggle("sticks", m === "3dof" || m === "desktop");
}
function button(label, onClick, primary = false) {
  const b = document.createElement("button");
  b.className = "btn" + (primary ? " primary" : "");
  b.textContent = label;
  b.onclick = onClick;
  $("startbtns").appendChild(b);
  return b;
}

for (const [id, fmt] of [["strength", (v) => v], ["keep", (v) => v], ["scale", scaleOf], ["focal", focalOf]]) {
  const el = $(id), out = $(id + "Out");
  const upd = () => { out.textContent = fmt(+el.value); sendState("settings"); };
  el.addEventListener("input", upd);
  out.textContent = fmt(+el.value);
}
$("focal").value = 33; $("focalOut").textContent = focalOf(33);
$("horizon").addEventListener("change", () => sendState("settings"));

// ---------------------------------------------------------------- network
let ws = null, wsFails = 0, lastSent = 0, lastSig = "";
function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/soundstage/vcam/ws?device=${DEVICE}`;
  setNet("wait", "connecting");
  try { ws = new WebSocket(url); } catch { ws = null; wsFails++; return setTimeout(connect, 2000); }
  ws.onopen = () => { wsFails = 0; setNet("ok", "live"); sendState("hello"); };
  ws.onclose = () => { ws = null; wsFails++; setNet("bad", wsFails > 2 ? "offline (http)" : "reconnecting"); setTimeout(connect, Math.min(8000, 800 * wsFails)); };
  ws.onerror = () => {};
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "pong") $("net").textContent = `live ${Math.round(performance.now() - m.c)} ms`; } catch { /* ignore */ } };
}
function setNet(cls, text) { $("netdot").className = "dot " + cls; $("net").textContent = text; }
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else if (wsFails > 2) fetch(`/soundstage/vcam/pose?device=${DEVICE}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
}
function sendState(event) { send({ type: "state", event, mode: S.mode, recording: S.recording, settings: settings() }); }
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping", c: performance.now() })); }, 3000);

// ---------------------------------------------------------------- pose pipeline
/** Every pose source calls this with a hand-space pose (metres / unit quaternion). */
function onPose(position, quaternion) {
  const now = performance.now();
  if (!S.origin) S.origin = position.slice();
  const yq = [0, Math.sin((-S.yawOffset * DEG) / 2), 0, Math.cos((-S.yawOffset * DEG) / 2)];
  const rel = [position[0] - S.origin[0], position[1] - S.origin[1], position[2] - S.origin[2]];
  // Rotate the relative position by the recenter yaw too, so "forward" stays forward.
  const c = Math.cos(-S.yawOffset * DEG), s = Math.sin(-S.yawOffset * DEG);
  S.pos = [c * rel[0] + s * rel[2], rel[1], -s * rel[0] + c * rel[2]];
  S.quat = qmul(yq, quaternion);
  if (S.lastPoseAt) S.rate = S.rate * 0.9 + (1000 / Math.max(1, now - S.lastPoseAt)) * 0.1;
  S.lastPoseAt = now;
  const st = settings();
  if (S.recording) S.samples.push({ t: (now - S.recStart) / 1000, position: S.pos.slice(), quaternion: S.quat.slice(), focal_mm: st.focal_mm });
  // Stream at ~30 Hz while the camera moves (or records); idle cameras only send a 1 Hz keep-alive.
  const sig = S.pos.concat(S.quat, st.focal_mm).map((v) => v.toFixed(4)).join();
  const moved = sig !== lastSig;
  if (now - lastSent >= (moved || S.recording ? 1000 / SEND_HZ - 2 : 1000)) {
    lastSent = now; lastSig = sig;
    send({ type: "pose", mode: S.mode, t: now / 1000, position: S.pos, quaternion: S.quat, focal_mm: st.focal_mm, recording: S.recording, settings: st });
  }
}

function recenter() {
  const e = eulerOf(S.quat);
  S.yawOffset += e.yaw;
  S.origin = null;
  S.mouseLook.yaw = 0;
  sendState("recenter");
}

// ---------------------------------------------------------------- record / stop
async function toggleRecord() {
  if (S.mode === "none") return;
  if (!S.recording) {
    S.samples = []; S.recStart = performance.now(); S.recording = true;
    $("rec").classList.add("on"); $("timer").classList.add("rec");
    if (navigator.vibrate) navigator.vibrate(30);
    sendState("record");
    return;
  }
  S.recording = false;
  $("rec").classList.remove("on"); $("timer").classList.remove("rec");
  if (navigator.vibrate) navigator.vibrate([20, 60, 20]);
  sendState("stop");
  const samples = S.samples;
  if (samples.length < 2) return log("Take too short.");
  S.takeCount++;
  const st = settings();
  let preview = "";
  try {
    const r = stabilize(samples, st);
    const rig = suggestRig(r.frames, st);
    preview = ` → ${r.keys.length} keys at strength ${Math.round(st.strength * 100)}` + (rig ? ` · looks like a <b>${rig.label}</b> (snap offered in Soundstage)` : "");
  } catch (e) { preview = ` (preview failed: ${e.message})`; }
  const body = { name: `take ${S.takeCount}`, device: DEVICE, mode: S.mode, settings: st, samples };
  log(`Saving take ${S.takeCount}…`);
  try {
    const res = await fetch("/soundstage/vcam/take", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.status);
    log(`Saved <b>${j.name}</b>: ${j.duration.toFixed(1)} s, ${j.samples} samples${preview}`);
  } catch (e) {
    log(`Could not save the take (${e.message}). It is still on this device: tap Record again to discard it.`);
  }
}
$("rec").addEventListener("click", toggleRecord);

// ---------------------------------------------------------------- WebXR (6-DoF)
async function startXR(sessionMode) {
  const overlay = $("overlay");
  const opts = { requiredFeatures: ["local"], optionalFeatures: ["local-floor"] };
  if (sessionMode === "immersive-ar") { opts.optionalFeatures.push("dom-overlay"); opts.domOverlay = { root: overlay }; }
  let session;
  try { session = await navigator.xr.requestSession(sessionMode, opts); }
  catch (e) { return notice("Could not start " + sessionMode, e.message, true); }
  const canvas = $("xrcanvas");
  const gl = canvas.getContext("webgl2", { xrCompatible: true, alpha: true }) || canvas.getContext("webgl", { xrCompatible: true, alpha: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  let ref;
  try { ref = await session.requestReferenceSpace("local-floor"); } catch { ref = await session.requestReferenceSpace("local"); }
  const grid = sessionMode === "immersive-vr" ? makeGrid(gl) : null;
  S.xr = session; S.origin = null; S.yawOffset = 0;
  document.body.classList.add("xr");
  setMode(sessionMode === "immersive-ar" ? "ar" : "vr", sessionMode === "immersive-ar" ? "6-DoF AR" : "6-DoF VR");
  notice("", "");
  overlay.addEventListener("beforexrselect", (e) => e.preventDefault()); // taps on the UI are not XR selects
  session.addEventListener("select", () => { if (sessionMode === "immersive-vr") toggleRecord(); });
  session.addEventListener("squeeze", recenter);
  session.addEventListener("end", () => {
    S.xr = null; document.body.classList.remove("xr");
    if (S.recording) toggleRecord();
    setMode("none", "XR ended"); buildStartButtons();
  });
  const onFrame = (t, frame) => {
    session.requestAnimationFrame(onFrame);
    let pose = null;
    if ($("useController").checked) {
      for (const src of session.inputSources) {
        if (src.handedness === "right" && src.targetRaySpace && src.targetRayMode === "tracked-pointer") { pose = frame.getPose(src.targetRaySpace, ref); break; }
      }
    }
    const viewer = frame.getViewerPose(ref);
    if (!pose && viewer) pose = viewer;
    if (pose) {
      const p = pose.transform.position, o = pose.transform.orientation;
      onPose([p.x, p.y, p.z], [o.x, o.y, o.z, o.w]);
    }
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    if (grid) gl.clearColor(0.05, 0.06, 0.07, 1); else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (grid && viewer) for (const view of viewer.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      grid(view.projectionMatrix, view.transform.inverse.matrix);
    }
  };
  session.requestAnimationFrame(onFrame);
  $("startbtns").innerHTML = "";
  button("Recenter", recenter);
  button("Exit XR", () => session.end());
}

/** Minimal floor grid for immersive-vr so the operator isn't floating in black. */
function makeGrid(gl) {
  const vs = `attribute vec3 p; uniform mat4 P, V; void main(){ gl_Position = P * V * vec4(p, 1.0); }`;
  const fs = `precision mediump float; void main(){ gl_FragColor = vec4(0.94, 0.63, 0.2, 0.6); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
  const v = [];
  for (let i = -10; i <= 10; i++) v.push(i, 0, -10, i, 0, 10, -10, 0, i, 10, 0, i);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"), uP = gl.getUniformLocation(prog, "P"), uV = gl.getUniformLocation(prog, "V");
  return (P, V) => {
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(uP, false, P); gl.uniformMatrix4fv(uV, false, V);
    gl.drawArrays(gl.LINES, 0, v.length / 3);
  };
}

// ---------------------------------------------------------------- DeviceOrientation (3-DoF) + thumbsticks
function quatFromDeviceOrientation(alpha, beta, gamma, screenAngle) {
  // Same maths as three.js DeviceOrientationControls: Euler(beta, alpha, -gamma, 'YXZ'),
  // then look out of the back of the device, then undo the screen rotation.
  const x = beta * DEG, y = alpha * DEG, z = -gamma * DEG;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  q = qmul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const h = (-screenAngle * DEG) / 2;
  return qmul(q, [0, 0, Math.sin(h), Math.cos(h)]);
}

let orient = null;
function onOrientation(e) {
  if (e.alpha == null && e.beta == null) return;
  orient = e;
  sensorSeen = true;
}

function startOrientation() {
  window.addEventListener("deviceorientation", onOrientation, true);
  setMode("3dof", "3-DoF + sticks");
  notice("3-DoF mode", "Rotation comes from the phone's gyro; move with the left stick, rise / sink with the right. Recenter to make the current heading straight ahead.");
  $("startbtns").innerHTML = "";
  button("Recenter", recenter);
  S.yawOffset = 0; S.origin = null;
  setTimeout(recenter, 400);
  loop();
}

function startDesktop() {
  setMode("desktop", "desktop test");
  notice("Desktop test mode", "Drag on the viewfinder to look around, use the sticks to move. Takes record and save exactly like a phone's.");
  $("startbtns").innerHTML = "";
  button("Recenter", recenter);
  loop();
}

let lastLoop = 0;
function loop(t = performance.now()) {
  if (S.mode !== "3dof" && S.mode !== "desktop") return;
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (t - (lastLoop || t)) / 1000);
  lastLoop = t;
  let q;
  if (S.mode === "3dof") {
    if (!orient) return;
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    q = quatFromDeviceOrientation(orient.alpha || 0, orient.beta || 0, orient.gamma || 0, angle);
  } else {
    const { yaw, pitch } = S.mouseLook;
    q = qmul([0, Math.sin((yaw * DEG) / 2), 0, Math.cos((yaw * DEG) / 2)], [Math.sin((pitch * DEG) / 2), 0, 0, Math.cos((pitch * DEG) / 2)]);
  }
  // Sticks move in the camera's heading plane (hand space, before recenter). Accumulate on a
  // virtual hand position so stick moves are recorded exactly like real 6-DoF moves.
  const yawRad = eulerOf(q).yaw * DEG;
  const fwd = [-Math.sin(yawRad), 0, -Math.cos(yawRad)], right = [-fwd[2], 0, fwd[0]];
  const [mx, my] = S.stickMove, rise = S.stickRise[1];
  virt[0] += (right[0] * mx + fwd[0] * -my) * STICK_SPEED * dt;
  virt[2] += (right[2] * mx + fwd[2] * -my) * STICK_SPEED * dt;
  virt[1] += -rise * STICK_SPEED * 0.6 * dt;
  onPose(virt.slice(), q);
}
const virt = [0, 1.6, 0];

function makeStick(id, target) {
  const el = $(id), knob = el.querySelector("b");
  let active = null;
  const set = (x, y) => { target[0] = x; target[1] = y; knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`; };
  const move = (e) => {
    if (e.pointerId !== active) return;
    const r = el.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2 - 20), y = (e.clientY - r.top - r.height / 2) / (r.height / 2 - 20);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    // Small dead zone, then a soft curve so slow creeps are easy.
    const k = (v) => Math.sign(v) * Math.max(0, (Math.abs(v) - 0.08) / 0.92) ** 1.6;
    set(k(x), k(y));
  };
  el.addEventListener("pointerdown", (e) => { active = e.pointerId; el.setPointerCapture(e.pointerId); move(e); });
  el.addEventListener("pointermove", move);
  const end = (e) => { if (e.pointerId === active) { active = null; set(0, 0); } };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
makeStick("stickMove", S.stickMove);
makeStick("stickRise", S.stickRise);

// Desktop: drag on the viewfinder to look.
{
  const vf = $("viewfinder");
  let drag = null;
  vf.addEventListener("pointerdown", (e) => { if (S.mode === "desktop") { drag = [e.clientX, e.clientY]; vf.setPointerCapture(e.pointerId); } });
  vf.addEventListener("pointermove", (e) => {
    if (!drag) return;
    S.mouseLook.yaw -= (e.clientX - drag[0]) * 0.25;
    S.mouseLook.pitch = Math.max(-85, Math.min(85, S.mouseLook.pitch - (e.clientY - drag[1]) * 0.25));
    drag = [e.clientX, e.clientY];
  });
  vf.addEventListener("pointerup", () => { drag = null; });
}
window.addEventListener("keydown", (e) => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); toggleRecord(); } });

// ---------------------------------------------------------------- viewfinder + readout
function draw() {
  requestAnimationFrame(draw);
  const cv = $("vfcanvas"), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const st = settings();
  if (S.mode !== "none") {
    const e = eulerOf(S.quat);
    const focal = st.focal_mm, pxPerDeg = (w / 2) / ((Math.atan(18 / focal) * 180) / Math.PI); // 36 mm gate
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate((st.horizonLock ? 0 : e.roll) * DEG);
    g.translate(0, e.pitch * pxPerDeg);
    g.fillStyle = "#1a2230"; g.fillRect(-w * 2, -h * 4, w * 4, h * 4);
    g.fillStyle = "#211a12"; g.fillRect(-w * 2, 0, w * 4, h * 4);
    g.strokeStyle = "#f0a032"; g.lineWidth = 2; g.beginPath(); g.moveTo(-w * 2, 0); g.lineTo(w * 2, 0); g.stroke();
    g.fillStyle = "#8b929c"; g.font = "11px ui-monospace, monospace"; g.textAlign = "center";
    for (let d = -90; d <= 90; d += 10) {
      if (!d) continue;
      const y = -d * pxPerDeg;
      g.strokeStyle = "#3a404a"; g.lineWidth = 1; g.beginPath(); g.moveTo(-30, y); g.lineTo(30, y); g.stroke();
      g.fillText(String(d), 46, y + 4);
    }
    // Heading ticks along the horizon.
    for (let a = -180; a <= 180; a += 15) {
      let dx = ((a - e.yaw + 540) % 360) - 180;
      g.strokeStyle = a % 45 ? "#3a404a" : "#8b929c";
      g.beginPath(); g.moveTo(dx * pxPerDeg, -6); g.lineTo(dx * pxPerDeg, 6); g.stroke();
    }
    g.restore();
  }
  // Frame guides: 2.39 and centre cross.
  g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 1;
  const gh = w / 2.39; g.strokeRect(0.5, (h - gh) / 2, w - 1, gh);
  g.beginPath(); g.moveTo(w / 2 - 10, h / 2); g.lineTo(w / 2 + 10, h / 2); g.moveTo(w / 2, h / 2 - 10); g.lineTo(w / 2, h / 2 + 10); g.stroke();
  if (S.mode === "none") { g.fillStyle = "#8b929c"; g.font = "14px -apple-system, sans-serif"; g.textAlign = "center"; g.fillText("no pose yet", w / 2, h / 2 + 30); }

  const sec = S.recording ? (performance.now() - S.recStart) / 1000 : 0;
  $("timer").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}` + (S.recording ? ` · ${S.samples.length}` : "") + (S.rate ? ` · ${Math.round(S.rate)} Hz` : "");
  if (S.mode !== "none") {
    const e = eulerOf(S.quat), sc = st.scale;
    $("px").textContent = (S.pos[0] * sc).toFixed(2); $("py").textContent = (S.pos[1] * sc).toFixed(2); $("pz").textContent = (S.pos[2] * sc).toFixed(2);
    $("ryaw").textContent = e.yaw.toFixed(1); $("rpitch").textContent = e.pitch.toFixed(1); $("rroll").textContent = e.roll.toFixed(1);
  }
}

// ---------------------------------------------------------------- startup: find the best sensor
let sensorSeen = false;
function buildStartButtons() {
  $("startbtns").innerHTML = "";
  if (caps.ar) button("Start AR camera (6-DoF)", () => startXR("immersive-ar"), true);
  if (caps.vr) button("Start VR camera (6-DoF)", () => startXR("immersive-vr"), !caps.ar);
  if (caps.orientationNeedsPermission) {
    button("Enable motion (3-DoF)", async () => {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") return notice("Motion access denied", "Allow Motion & Orientation Access for this site in Settings → Safari, then reload.", true);
        startOrientation();
      } catch (e) { notice("Motion access failed", e.message, true); }
    }, !caps.ar && !caps.vr);
  } else if (caps.orientation) {
    button("Use phone gyro (3-DoF)", startOrientation, !caps.ar && !caps.vr);
  }
  button("Desktop test mode", startDesktop);
}
const caps = { ar: false, vr: false, orientation: false, orientationNeedsPermission: false };

async function detect() {
  if (!window.isSecureContext) {
    notice("Motion sensors need https",
      "Browsers only expose WebXR and motion sensors on https:// pages (or localhost). Open this page through the https address from docs/vcam.md. Desktop test mode still works.", true);
  }
  if (navigator.xr && window.isSecureContext) {
    try { caps.ar = await navigator.xr.isSessionSupported("immersive-ar"); } catch { /* unsupported */ }
    try { caps.vr = await navigator.xr.isSessionSupported("immersive-vr"); } catch { /* unsupported */ }
  }
  if (typeof DeviceOrientationEvent !== "undefined" && window.isSecureContext) {
    // iOS / iPadOS gate the gyro behind a permission prompt; desktop Safari has the same API but no gyro.
    if (typeof DeviceOrientationEvent.requestPermission === "function") caps.orientationNeedsPermission = navigator.maxTouchPoints > 0;
    else {
      // Desktop browsers define the event but never fire real readings: wait for one.
      window.addEventListener("deviceorientation", onOrientation, true);
      await new Promise((r) => setTimeout(r, 1200));
      window.removeEventListener("deviceorientation", onOrientation, true);
      caps.orientation = sensorSeen;
    }
  }
  buildStartButtons();
  if (!window.isSecureContext) return;
  if (caps.ar || caps.vr) notice("6-DoF tracking available", caps.ar ? "Start AR: the camera follows the phone/headset through the room. Tap Record, walk the move, tap Stop." : "Start VR, then pull the trigger to record / stop. Squeeze = recenter.");
  else if (caps.orientation || caps.orientationNeedsPermission) notice("3-DoF motion available", "This device can aim the camera with its gyro; move with on-screen sticks. For full walk-around tracking use Android Chrome (AR) or a Quest / Vision Pro.");
  else notice("No motion sensors found", "This browser has no WebXR or motion sensors (a desktop?). Open this page on a phone, tablet or headset — or use Desktop test mode to try recording with the mouse and sticks.", true);
}

connect();
draw();
detect();
