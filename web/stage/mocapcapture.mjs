// Capture a performance for the stage: from a video file, or acted out live on the webcam. The clip goes to ComfyUI's
// input folder and through SAM 3D Body (body, hands and fingers in 3D) into Soundstage · Mocap to Stage, which writes
// the take the clay figure plays (web/stage/mocap.mjs).
import { runGraph } from "../assets3d/maker.mjs";

export const MOCAP_MODEL = "sam_3d_body_dinov3_bf16.safetensors";

/** The ComfyUI graph: Load Video -> frames -> SAM 3D Body -> smooth -> take. */
export function mocapGraph(file, name, duration = 0) {
  return {
    1: { class_type: "LoadVideo", inputs: { file } },
    2: { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
    3: { class_type: "SAM3DBody_Loader", inputs: { model_file: MOCAP_MODEL } },
    4: { class_type: "SAM3DBody_Predict", inputs: { sam3d_body_model: ["3", 0], image: ["2", 0], run_hand_refinement: true, fov: 0.0, batch_size: 32 } },
    5: { class_type: "SAM3DBody_Smooth", inputs: { mhr_pose_data: ["4", 0], strength: 0.5, method: "gaussian", window: 5, rotation_threshold_degrees: 30.0 } },
    6: { class_type: "SoundstageMocap", inputs: { mhr_pose_data: ["5", 0], fps: ["2", 2], track: 0, name, duration } },
  };
}

const safeName = (s) => (String(s || "take").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "take");

/** Upload a clip to ComfyUI's input folder (LoadVideo lists only the top level). Returns the stored name. */
async function upload(api, blob, fileName) {
  const body = new FormData();
  body.append("image", blob, fileName);
  body.append("type", "input");
  body.append("overwrite", "true");
  const r = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/**
 * Turn a clip into a take. Returns {file, name, data, frames, fps}. duration (s) is passed for webcam recordings.
 */
export async function captureTake(api, blob, { name, duration = 0, onStatus = () => {} } = {}) {
  const base = safeName(name || blob.name || "take");
  const ext = (blob.name?.match(/\.[A-Za-z0-9]+$/)?.[0] || (blob.type.includes("mp4") ? ".mp4" : ".webm")).toLowerCase();
  onStatus("Uploading the clip…");
  const stored = await upload(api, blob, `mocap_${base}_${Date.now().toString(36)}${ext}`);
  onStatus("Reading the performance on the GPU (body, hands, fingers)…");
  const res = await runGraph(mocapGraph(stored, base, duration), { api, front: true, timeoutMs: 900000,
    onStatus: (m) => onStatus(`Motion capture: ${m}`) });
  const raw = res.outputs?.["6"]?.text?.[0];
  if (!raw) throw new Error("the capture finished without a take");
  const info = JSON.parse(raw);
  const i = info.file.lastIndexOf("/");
  const r = await api.fetchApi(`/view?filename=${encodeURIComponent(info.file.slice(i + 1))}&subfolder=${encodeURIComponent(info.file.slice(0, i))}&type=output`);
  const data = await r.json();
  return { file: info.file, name: base, data, frames: info.frames, fps: info.fps, seconds: res.seconds };
}

// ------------------------------------------------------------------ act it out (webcam)
const CSS = `
.ss-mocap-rec { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;
  background:rgba(8,8,10,.78); backdrop-filter:blur(6px); font:13px/1.4 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; color:#f4f4f5; }
.ss-mocap-rec .card { width:min(760px, 94vw); background:#18181b; border:1px solid rgba(255,255,255,.1); border-radius:18px;
  padding:18px; display:flex; flex-direction:column; gap:12px; box-shadow:0 30px 80px rgba(0,0,0,.5); }
.ss-mocap-rec h3 { margin:0; font-size:18px; font-weight:650; }
.ss-mocap-rec .sub { opacity:.7; }
.ss-mocap-rec .view { position:relative; border-radius:12px; overflow:hidden; background:#000; aspect-ratio:16/9; }
.ss-mocap-rec video { width:100%; height:100%; object-fit:contain; display:block; }
.ss-mocap-rec .mirror { transform:scaleX(-1); }
.ss-mocap-rec .count { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:120px;
  font-weight:700; color:#f2ff59; text-shadow:0 4px 30px rgba(0,0,0,.6); pointer-events:none; }
.ss-mocap-rec .rec { position:absolute; top:12px; left:12px; padding:4px 10px; border-radius:999px; background:rgba(0,0,0,.6);
  font-variant-numeric:tabular-nums; }
.ss-mocap-rec .rec::before { content:""; display:inline-block; width:9px; height:9px; border-radius:50%; background:#ff453a; margin-right:6px; }
.ss-mocap-rec .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ss-mocap-rec .grow { flex:1; }
.ss-mocap-rec button { font:inherit; border-radius:999px; padding:8px 16px; cursor:pointer; border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06); color:inherit; }
.ss-mocap-rec button.primary { background:#f2ff59; color:#111; border-color:#f2ff59; font-weight:650; }
.ss-mocap-rec select { font:inherit; background:#27272a; color:inherit; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 8px; }`;

/**
 * Record a take on the webcam: preview, 3-2-1 countdown, record up to `seconds`, then Use / Retake.
 * Resolves {blob, duration} or null when cancelled.
 */
export function recordTake({ seconds = 6 } = {}) {
  if (!document.getElementById("ss-mocap-rec-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-mocap-rec-css", textContent: CSS }));
  return new Promise((resolve) => {
    const wrap = Object.assign(document.createElement("div"), { className: "ss-mocap-rec" });
    wrap.innerHTML = `<div class="card" role="dialog" aria-label="Act it out">
      <h3>Act it out</h3>
      <div class="sub">Stand back so the camera sees you head to toe. Press Record, wait for the countdown, then perform: open a door, run and jump, wave. The clay actor copies it.</div>
      <div class="view"><video class="live mirror" autoplay muted playsinline></video><div class="count" hidden></div><div class="rec" hidden>0.0 s</div></div>
      <div class="row"><label>Length <select class="len">${[3, 4, 6, 8, 10, 15].map((s) => `<option value="${s}"${s === seconds ? " selected" : ""}>${s} s</option>`).join("")}</select></label>
        <span class="grow"></span><button class="cancel" type="button">Cancel</button><button class="retake" type="button" hidden>Retake</button>
        <button class="stop" type="button" hidden>Cut</button><button class="go primary" type="button">● Record</button><button class="use primary" type="button" hidden>Use this take</button></div></div>`;
    document.body.append(wrap);
    wrap.addEventListener("pointerdown", (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") done(null); });
    const $ = (s) => wrap.querySelector(s);
    const video = $(".live"), count = $(".count"), recEl = $(".rec");
    let stream = null, rec = null, chunks = [], blob = null, dur = 0, timer = null, t0 = 0;
    const done = (v) => { clearInterval(timer); try { rec?.state === "recording" && rec.stop(); } catch { /* stopped */ } stream?.getTracks().forEach((t) => t.stop()); wrap.remove(); resolve(v); };
    const show = (sel, on) => { $(sel).hidden = !on; };
    navigator.mediaDevices?.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => { stream = s; video.srcObject = s; })
      .catch((e) => { $(".sub").textContent = `The camera is not available here (${e.message}). Use “Capture from video” with a clip from your phone instead.`; show(".go", false); });
    $(".cancel").onclick = () => done(null);
    $(".use").onclick = () => done({ blob, duration: dur });
    const stop = () => { if (rec?.state === "recording") rec.stop(); };
    $(".stop").onclick = stop;
    const start = async () => {
      if (!stream) return;
      blob = null; chunks = [];
      video.srcObject = stream; video.classList.add("mirror"); video.controls = false; video.loop = false;
      show(".go", false); show(".use", false); show(".retake", false); show(".cancel", false);
      count.hidden = false;
      for (const n of ["3", "2", "1", "Action!"]) { count.textContent = n; count.style.fontSize = n.length > 2 ? "72px" : "120px"; await new Promise((r) => setTimeout(r, 750)); }
      count.hidden = true;
      const len = +$(".len").value;
      const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
      rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined);
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      rec.onstop = () => {
        clearInterval(timer);
        dur = (performance.now() - t0) / 1000;
        const mp4 = (rec.mimeType || "").includes("mp4");
        blob = new File(chunks, `act_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${mp4 ? ".mp4" : ".webm"}`, { type: rec.mimeType || "video/webm" });
        recEl.hidden = true; show(".stop", false);
        video.srcObject = null; video.classList.remove("mirror"); video.src = URL.createObjectURL(blob); video.controls = true; video.loop = true; video.play().catch(() => {});
        show(".use", true); show(".retake", true); show(".cancel", true);
      };
      rec.start(250);
      t0 = performance.now();
      recEl.hidden = false; show(".stop", true);
      timer = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        recEl.textContent = `${t.toFixed(1)} s / ${len} s`;
        if (t >= len) stop();
      }, 100);
    };
    $(".go").onclick = start;
    $(".retake").onclick = start;
  });
}
