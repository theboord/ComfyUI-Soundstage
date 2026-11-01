// Desktop half of the phone viewfinder (Milestone 20). web/soundstage.js calls attachViewfinder() once per stage.
//
//  - "Phone viewfinder" button: a QR code for the phone (the LAN bridge's https address when tools/vcam_bridge.py runs,
//    else this page's own address), the connection state and a "Follow the phone" switch.
//  - While a viewfinder is connected: publishes the scene (POST /soundstage/vcam/scene) on every change and the playhead /
//    view (POST /soundstage/vcam/sync), so the phone renders the same set and action.
//  - Shows the phone's live camera on the shot camera (stage.previewCamera) and, while it records, follows its frame so the
//    set plays in step.
//  - A finished take arrives as a "take" event: its camera keys (position, aim, focal length, focus, T-stop, roll) go onto
//    the current shot, the rig is set to Free (the take is the move), it plays back, and the phone is told. Keep leaves it;
//    Discard (on the phone) puts the previous keys back.

import { qrSvg } from "./qr.mjs";
import { takeToKeys, viewfinderUrl, isLoopback, VF_EVENT, fmtStop, fmtFocus } from "./vfcore.mjs";

const CSS = `
.ss-vf-pop { position:fixed; z-index:100000; width:300px; background:#17141b; color:#ece8ee; border:1px solid rgba(255,255,255,.14);
  border-radius:14px; padding:14px; box-shadow:0 18px 60px rgba(0,0,0,.55); font:13px/1.4 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif; }
.ss-vf-pop h4 { margin:0 0 4px; font-size:14px; display:flex; align-items:center; gap:8px; }
.ss-vf-pop h4 button { margin-left:auto; background:none; border:0; color:#a9a3ad; font-size:18px; cursor:pointer; line-height:1; }
.ss-vf-pop .qr { display:grid; place-items:center; background:#fff; border-radius:10px; padding:6px; margin:8px 0; }
.ss-vf-pop .url { font:11px ui-monospace, Menlo, monospace; word-break:break-all; color:#cfc8d2; background:rgba(255,255,255,.05); border-radius:8px; padding:6px 8px; user-select:all; }
.ss-vf-pop .warn { color:#ffb340; font-size:12px; margin-top:6px; }
.ss-vf-pop .st { margin-top:8px; display:flex; align-items:center; gap:7px; font-size:12.5px; }
.ss-vf-pop .st i { width:8px; height:8px; border-radius:50%; background:#6d6672; flex:none; }
.ss-vf-pop .st.live i { background:#3fd07a; } .ss-vf-pop .st.rec i { background:#ff3b30; }
.ss-vf-pop label { display:flex; gap:7px; align-items:center; margin-top:8px; font-size:12.5px; cursor:pointer; }
.ss-vf-pop ol { margin:8px 0 0; padding-left:18px; color:#a9a3ad; font-size:12px; }
.ss-vf-btn[aria-pressed="true"] { border-color:#f2ff59 !important; color:#f2ff59 !important; }
`;

const clone = (x) => JSON.parse(JSON.stringify(x ?? null));

export function attachViewfinder({ api, stage, host, seek = null, play = null, say = () => {} }) {
  if (!document.getElementById("ss-vf-css")) {
    const s = document.createElement("style"); s.id = "ss-vf-css"; s.textContent = CSS; document.head.append(s);
  }
  const btn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn ss-vf-btn", textContent: "Phone viewfinder",
    title: "Scan a QR code with your phone: it shows this stage and becomes the shot camera (zoom, lenses, focus, iris, record)" });
  btn.setAttribute("aria-pressed", "false");
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  host?.append(btn);

  const devices = new Map();       // device -> {last, cam, frame, recording}
  let follow = true, pop = null, pending = null, lastPub = 0, lastSync = "", recording = false;
  let applied = null;              // {id, prev:{keys, rig}} for Discard
  const active = () => [...devices.values()].some((d) => performance.now() - d.last < 20000);

  // ---- publish the scene + playhead to the phones
  const syncNow = () => {
    const st = stage.toJSON?.() || stage.state || {};
    return { frame: stage.frame || 0, view: stage.view, fps: st.shot?.fps || 24, frames: st.shot?.frames || 97, shot: stage.activeShot?.()?.name || "" };
  };
  async function publish() {
    pending = null;
    lastPub = performance.now();
    try {
      await api.fetchApi("/soundstage/vcam/scene", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: stage.toJSON(), sync: syncNow() }) });
    } catch { /* routes missing (older server) */ }
  }
  const schedule = () => { if (!active()) return; if (pending) clearTimeout(pending); pending = setTimeout(publish, 250); };
  const prevChange = stage.onChange;
  stage.onChange = (st) => { prevChange.call(stage, st); schedule(); };
  async function postSync(extra = {}) {
    try { await api.fetchApi("/soundstage/vcam/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...syncNow(), ...extra }) }); } catch { /* */ }
  }
  let lastFrame = -1, lastMove = 0;
  const poll = setInterval(() => {
    if (!active() || recording) return;
    const f = stage.frame || 0, now = performance.now();
    if (f !== lastFrame) { lastMove = now; lastFrame = f; }
    const s = syncNow();
    s.playing = now - lastMove < 250 && f > 0;
    const sig = JSON.stringify([s.frame, s.view, s.playing]);
    if (sig !== lastSync) { lastSync = sig; postSync({ playing: s.playing }); }
    for (const [id, d] of devices) if (now - d.last > 4000 && d.live) { d.live = false; if (follow) stage.previewCamera(null); render(); }
  }, 120);

  // ---- events from the phones
  const onEvent = async (e) => {
    const m = e.detail;
    if (!m || m.mode !== "viewfinder" && m.type !== "take") return;
    const d = devices.get(m.device) || { last: 0 };
    d.last = performance.now();
    devices.set(m.device, d);
    if (m.type === "vf") {
      d.cam = m.cam; d.frame = m.frame; d.recording = m.recording;
      if (!d.live) { d.live = true; render(); }
      if (follow) stage.previewCamera({ position: m.cam.position, target: m.cam.target, focal_mm: m.cam.focal_mm, roll: m.cam.roll || 0 });
      if (m.recording && seek) seek(Math.max(0, Math.floor(m.frame)));
      tickStatus();
      if (performance.now() - lastPub > 30000 && !pending) schedule();      // a phone that joined late gets the scene
      return;
    }
    if (m.type === "vfstate") {
      if (m.event === "hello") { publish(); say("A phone viewfinder connected: it is the shot camera now."); }
      else if (m.event === "arm") { recording = true; seek?.(0); say("Phone: rolling…"); }
      else if (m.event === "record") { recording = true; say("Phone: recording the camera…"); }
      else if (m.event === "stop") { recording = false; }
      else if (m.event === "keep") { if (applied) say(`Kept the phone take on ${stage.activeShot?.()?.name || "the shot"}.`); applied = null; schedule(); }
      else if (m.event === "discard") {
        recording = false;
        if (applied && (!m.data?.id || m.data.id === applied.id)) {
          if (applied.prev.rig) stage.setRig(applied.prev.rig.type, applied.prev.rig.amount);
          else stage.setRig("free");
          if (stage.setLensKeys) stage.setLensKeys(applied.prev.lens); else delete stage.activeShot().lens_keys;
          stage.setCameraKeys(applied.prev.keys);
          say("Discarded the phone take: the shot has its previous camera back.");
        }
        applied = null;
      } else if (m.event === "bye") { devices.delete(m.device); if (follow) stage.previewCamera(null); }
      render();
      return;
    }
    if (m.type === "take" && m.mode === "viewfinder") await useTake(m);
  };
  api.addEventListener(VF_EVENT, onEvent);

  async function useTake(m) {
    let take;
    try { const r = await api.fetchApi(`/soundstage/vcam/take?id=${encodeURIComponent(m.id)}`); take = await r.json(); } catch { return; }
    if (!take?.samples?.length) return;
    const { keys, lensKeys, info } = takeToKeys(take);
    if (keys.length < 2) return;
    const sh = stage.activeShot();
    applied = { id: m.id, prev: { keys: clone(sh.camera_keys), rig: clone(sh.rig), lens: clone(sh.lens_keys) } };
    stage.previewCamera(null);
    if (sh.rig?.type && sh.rig.type !== "free") stage.setRig("free");
    if (stage.setLensKeys) stage.setLensKeys(lensKeys); else sh.lens_keys = lensKeys;
    stage.setCameraKeys(keys);
    recording = false;
    say(`Phone ${take.name || "take"}: ${keys.length} camera keys + ${lensKeys.length} lens keys (focus, iris) on ${sh.name || "the shot"}, ${info.seconds} s. Playing it back.`);
    postSync({ take: { id: m.id, status: "applied", keys: keys.length, lensKeys: lensKeys.length, shot: sh.name || "" } });
    seek?.(info.startFrame || 0);
    play?.();
    render();
  }

  // ---- the QR popover
  async function pairUrl() {
    let pair = null;
    try { pair = await (await api.fetchApi("/soundstage/vcam/pair")).json(); } catch { /* */ }
    return viewfinderUrl(location.origin + (api.api_base || ""), pair);
  }
  async function open() {
    if (pop) { close(); return; }
    pop = document.createElement("div");
    pop.className = "ss-vf-pop";
    pop.addEventListener("pointerdown", (e) => e.stopPropagation());
    const url = await pairUrl();
    const loop = isLoopback(url);
    pop.innerHTML = `<h4>Phone viewfinder<button aria-label="Close">×</button></h4>
      <div style="color:#a9a3ad;font-size:12px">Scan with the phone's camera. It shows this stage through the shot camera; move it to aim, pinch or ± to zoom, tap to focus, ● to record a take onto this shot.</div>
      <div class="qr">${qrSvg(url, { px: 236 })}</div>
      <div class="url">${url.replace(/[<>&]/g, "")}</div>
      ${loop ? `<div class="warn">This address is this computer only. For a phone on the same Wi-Fi, run <b>python3 tools/vcam_bridge.py</b> on this Mac (docs/vcam.md): the QR then points at it.</div>` : ""}
      <div class="st"><i></i><span class="stt">No phone yet</span></div>
      <label><input type="checkbox" ${follow ? "checked" : ""}> Show the phone's camera on this stage</label>
      <ol><li>Same Wi-Fi as this computer, phone sideways.</li><li>Tap <b>Start</b>, allow motion.</li><li>● records from the top of the shot; Keep or Discard on the phone.</li></ol>`;
    pop.querySelector("h4 button").addEventListener("click", close);
    pop.querySelector("input").addEventListener("change", (e) => { follow = e.target.checked; if (!follow) stage.previewCamera(null); });
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(innerWidth - 316, r.left))}px`;
    pop.style.top = r.top > 480 ? `${Math.max(8, r.top - pop.offsetHeight - 8)}px` : `${r.bottom + 8}px`;
    btn.setAttribute("aria-pressed", "true");
    render();
  }
  function close() { pop?.remove(); pop = null; btn.setAttribute("aria-pressed", String(active())); }
  btn.addEventListener("click", open);

  let statusAt = 0;
  function tickStatus() { const n = performance.now(); if (n - statusAt > 250) { statusAt = n; render(); } }
  function render() {
    const live = [...devices.entries()].filter(([, d]) => d.live);
    btn.textContent = live.length ? (live.some(([, d]) => d.recording) ? "● Phone recording" : "Phone viewfinder ✓") : "Phone viewfinder";
    btn.setAttribute("aria-pressed", String(!!pop || live.length > 0));
    if (!pop) return;
    const st = pop.querySelector(".st"), t = pop.querySelector(".stt");
    if (!live.length) { st.className = "st"; t.textContent = devices.size ? "Phone connected, waiting for its camera" : "No phone yet"; return; }
    const [id, d] = live[0];
    st.className = "st " + (d.recording ? "rec" : "live");
    const c = d.cam || {};
    t.textContent = `${d.recording ? "Recording" : "Live"} · ${id} · ${Math.round(c.focal_mm || 0)} mm · ${fmtStop(c.t_stop || 2.8)} · focus ${fmtFocus(c.focus_m || 3)}`;
  }

  return {
    button: btn, open, close, publish, devices,
    get follow() { return follow; }, set follow(v) { follow = !!v; },
    dispose() { clearInterval(poll); api.removeEventListener(VF_EVENT, onEvent); stage.onChange = prevChange; close(); btn.remove(); },
  };
}
