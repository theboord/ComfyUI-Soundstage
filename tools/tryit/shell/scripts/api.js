// Stand-in for ComfyUI's scripts/api.js so the real Soundstage App runs as a static demo.
// Run / Generate replay the renders a GPU made earlier for the same scene and shot (listed in the workflow's own
// node properties); server routes answer from precomputed results (Look compile, Advisor) or say plainly that the
// feature needs the full install (ComfyUI + a GPU): never an error.

const bus = new EventTarget();
const BASE = new URL("../", import.meta.url);            // the demo root (index.html, r/)
const uploads = new Map();   // demo uploads: name -> blob: URL
let seq = 0;

export const demo = {
  scene: null,          // { key, compile, advisor, cut, renders: {shotId: {kind: fileRef}}, candidates: {shotId: [fileRef]} }
  getShot: () => null,  // set by the shell: the active shot id
  getStep: () => 1,     // set by the shell: the ladder step to climb to
  toast: () => {},      // set by the shell
  v2s: null,            // the recorded Video → 3D run once it starts: { clip, total_s, replaySeconds, running, doneAt } (the badge)
  onReplay: null,       // set by the shell: ({shot, step}) before a Run / Generate replays, so it can say an edited stage isn't re-rendered
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const asset = (name) => new URL(`r/${String(name).replace(/\.png$/i, ".jpg")}`, BASE).href;

// What each server-only feature is, for the "available in the full install" note.
const FULL = [
  [/^\/soundstage\/director/, "The Director's language model (local Qwen or Ollama)"],
  [/^\/soundstage\/cut\/render$/, "Rendering the Timeline (MP4, ProRes, 9:16)"],
  [/^\/soundstage\/(video2stage|mocap)/, "Video to 3D on your own clips (pose and camera from a clip)"],
  [/^\/soundstage\/(object_designer|object\b|assets3d)/, "Making a 3D object from a prompt or a photo"],
  [/^\/soundstage\/(import_world|world|interop)/, "Uploading a world to the server"],
  [/^\/soundstage\/vcam/, "The phone viewfinder (the vcam bridge to your phone)"],
  [/^\/soundstage\/source_spec/, "Reading a camera file's specs"],
  [/^\/soundstage\/(plan|agent)/, "The scene agent"],
  [/^\/soundstage\/layerpack/, "The Layer Pack (EXR, PSD, ProRes)"],
  [/^\/soundstage\/(voice|tts|lipsync|ltxvoice)/, "Voices and lip sync"],
  [/^\/prompt/, "Rendering on the GPU"],
];
const told = new Set();
// Take checks: the real results the server computed for the takes these scenes replay (soundstage/takecheck/check.py).
let checked = null, checkedNow = {};
const takeChecks = () => (checked ||= fetch(new URL("r/canned/takecheck.json", BASE)).then((r) => r.json()).then((j) => (checkedNow = j.results || {})).catch(() => ({})));
takeChecks();

// The Director can also ask an Ollama model on this computer directly. In the demo that answers with the same note
// (no request leaves the page).
const OLLAMA = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434\//i;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (u, init) => {
  if (OLLAMA.test(String(u?.url || u))) {
    const msg = fullInstall("/soundstage/director");
    return Promise.resolve(json({ error: msg }, 503));
  }
  return realFetch(u, init);
};
// Video → 3D: one real run of the pipeline on the pod, recorded (r/canned/v2s_run.json: its steps with their measured
// times, notes and result scene). Rebuild replays it in REPLAY_S seconds: the progress card walks the real steps with
// the real elapsed times, then the App loads the real result through its own code.
const REPLAY_S = 9;
let v2sRec = null;
const v2sRun = () => (v2sRec ||= fetch(new URL("r/canned/v2s_run.json", BASE)).then((r) => (r.ok ? r.json() : null)).catch(() => null));
const v2sJobs = new Map();
async function v2sRoute(p, path, init, method) {
  const rec = await v2sRun();
  if (!rec) return null;
  if (p === "/soundstage/video2stage/runs") return json({ runs: [{ secs: rec.secs, samples: rec.samples, total_s: rec.total_s }] });
  const id = /[?&]id=([^&]+)/.exec(String(path))?.[1] || (() => { try { return JSON.parse(init.body || "{}").id; } catch { return ""; } })();
  if (p === "/soundstage/video2stage/cancel") { v2sJobs.delete(id); demo.v2s = null; return json({ ok: true }); }
  if (p === "/soundstage/video2stage" && method === "POST") {
    // Only the recorded clip replays: a visitor's own clip gets the full-install note, never someone else's result.
    let video = "";
    try { video = JSON.parse(init.body || "{}").video || ""; } catch { /* not JSON */ }
    if (!video.endsWith(rec.clip)) return null;
    const job = `demo-v2s-${++seq}`;
    v2sJobs.set(job, performance.now());
    demo.v2s = { clip: rec.clip, total_s: rec.total_s, replaySeconds: REPLAY_S, running: true };
    demo.toast(`Replaying a real Video → 3D run: ${Math.round(rec.total_s / 60)} min wall time on the pod, most of it queue wait, shown here in ${REPLAY_S} s.`);
    return json({ job });
  }
  if (p === "/soundstage/video2stage/job") {
    const t0 = v2sJobs.get(id);
    if (t0 == null) return json({ error: "no such job" }, 404);
    const frac = (performance.now() - t0) / 1000 / REPLAY_S;
    if (frac >= 1) { v2sJobs.delete(id); if (demo.v2s) Object.assign(demo.v2s, { running: false, doneAt: performance.now() }); return json({ state: "done", notes: rec.result.notes || [], result: JSON.parse(JSON.stringify(rec.result)) }); }
    const t = frac * rec.total_s;
    let i = 0, acc = 0;
    while (i < rec.steps.length - 1 && acc + rec.steps[i].s <= t) acc += rec.steps[i++].s;
    return json({ state: "running", step: rec.steps[i].name, step_index: i, steps: rec.steps.map((x) => x.name),
      queue_position: 0, elapsed_s: t, eta_s: rec.total_s - t });
  }
  return null;
}
function fullInstall(p) {
  const hit = FULL.find(([re]) => re.test(p)), what = hit ? hit[1] : "This";
  const msg = `${what} is available in the full install (ComfyUI with a GPU). This demo replays renders made earlier.`;
  // Background lookups the App makes on its own (model lists, readiness) answer quietly: a note only for named features.
  if (hit && !told.has(what)) { told.add(what); demo.toast(msg); }
  return msg;
}

export const api = {
  clientId: "demo",
  api_base: "",
  addEventListener: (t, f) => bus.addEventListener(t, f),
  removeEventListener: (t, f) => bus.removeEventListener(t, f),
  dispatchCustomEvent(t, detail) { bus.dispatchEvent(new CustomEvent(t, { detail })); },
  dispatchEvent(ev) { return bus.dispatchEvent(ev); },

  /** /view?filename=X -> the shipped copy of X; anything else stays as it is. */
  apiURL(path) {
    const m = /^\/view\?filename=([^&]+)/.exec(path);
    if (!m) return path;
    const name = decodeURIComponent(m[1]);
    // A checked take keeps its name in the query (the static host ignores it), so the Ladder and Dailies find its checks.
    if (checkedNow[name]) return `${asset(name)}?filename=${encodeURIComponent(name)}&subfolder=&type=output`;
    return uploads.get(name) || asset(name);
  },
  fileURL(path) { return path; },

  async fetchApi(path, init = {}) {
    const p = String(path).split("?")[0];
    const method = String(init.method || "GET").toUpperCase();
    const s = demo.scene || {};
    if (p === "/soundstage/look/compile") return s.compile ? json(s.compile) : json({ error: "not precomputed" }, 422);
    if (p === "/soundstage/look/parse") return json({});
    if (p === "/soundstage/advisor/vocab") return json(s.vocab || {});
    if (p === "/soundstage/advisor") {
      if (!s.advisor) return json({ error: "The Advisor runs on the ComfyUI server; this scene has no saved answer." }, 422);
      demo.toast("Demo: the Advisor's real answer for this scene, computed earlier on the server.");
      return json(s.advisor);
    }
    if (p === "/soundstage/agent/info") return json({ available: false });
    // The open App reports its scene for MCP clients in the background: nothing to say in the demo.
    if (p === "/soundstage/director/state" || p === "/soundstage/director/result") return json({ ok: false });
    if (p === "/soundstage/takecheck" && method === "POST") {
      let file = null;
      try { file = JSON.parse(init.body || "{}").file; } catch { /* no body */ }
      const res = (await takeChecks())[file?.filename];
      return json(res || { error: "This take wasn't checked on the server. Take checks run on the CPU in the full install." });
    }
    if (p === "/soundstage/takecheck/timing") return json({});      // the App's built-in estimates
    if (p === "/soundstage/takecheck/readiness") return new Response("", { status: 503 });   // no Ready chips: the demo has no models
    if (p === "/soundstage/takecheck/recipe") return json({ error: "no recipe in the demo" }, 404);
    if (p === "/soundstage/cut/render_video") {
      if (!s.cut) return json({ error: "This scene's cut wasn't rendered on the GPU yet." }, 422);
      demo.toast(`Replayed: this scene's cut as joined earlier on the server (${s.cut}), not a new join of your trims.`);
      return json({ filename: s.cut, subfolder: "", type: "output", seconds: s.cutSeconds || 0, missing: [] });
    }
    if (p === "/queue") return json(method === "GET" ? { queue_running: [], queue_pending: [] } : {});
    if (p.startsWith("/soundstage/queue_summary")) return json({ running: 0, pending: 0, items: [] });
    if (p === "/interrupt" || p === "/free") return json({});
    if (p.startsWith("/history")) return json({});
    if (p.startsWith("/object_info")) return json({});
    if (p === "/upload/image") {
      // Kept in this browser tab only: the image shows in the App like a real upload (nothing leaves the page).
      const file = init.body?.get?.("image");
      const name = `${++seq}_${(file?.name || "image.png").replace(/[^\w.-]/g, "_")}`;
      if (file) uploads.set(name, URL.createObjectURL(file));
      const sub = init.body?.get?.("subfolder") || "";
      return json({ name, subfolder: sub, type: "input" });
    }
    if (p.startsWith("/view")) {
      const m = /[?&]filename=([^&]+)/.exec(String(path));
      const name = m ? decodeURIComponent(m[1]) : "";
      if (uploads.has(name)) return fetch(uploads.get(name));
      const r = await fetch(asset(name)).catch(() => null);
      return r && r.ok ? r : json({ error: "not in the demo" }, 404);
    }
    if (p.startsWith("/soundstage/video2stage")) { const r = await v2sRoute(p, path, init, method); if (r) return r; }
    const msg = fullInstall(p);
    // /prompt callers read error.message; the others read error.
    return p === "/prompt" ? json({ error: { type: "demo", message: msg }, node_errors: {} }, 503) : json({ error: msg, message: msg, available: false }, 503);
  },

  /** Queue = replay the earlier GPU render for the active shot, rung by rung. */
  async queuePrompt() {
    const id = `demo-${++seq}`;
    const shot = demo.getShot();
    const step = Math.max(1, Math.min(5, demo.getStep()));
    setTimeout(() => replay(id, shot, step), 30);
    return { prompt_id: id, number: seq, node_errors: {} };
  },
  async interrupt() {},
  async getUserData() { return new Response("{}", { status: 404 }); },
  async storeUserData() { return new Response("{}"); },
};

// Rung output nodes of the Soundstage App graph (same ids and titles as the real workflow).
const RUNGS = [
  { step: 1, node: 9099, kind: "previz", video: true },
  { step: 2, node: 9058, kind: "look", video: false },
  { step: 3, node: 9063, kind: "draft", video: true },
  { step: 4, node: 9090, kind: "final_sound", video: true, alt: ["final", "final_audio"] },
];
const lookTurn = new Map();   // shot -> how many frames it has replayed (cycles through its real variations)

function replay(id, shot, step) {
  const r = (demo.scene?.renders || {})[shot] || {};
  try { demo.onReplay?.({ shot, step }); } catch { /* the shell's note never blocks a replay */ }
  api.dispatchCustomEvent("execution_start", { prompt_id: id });
  let t = 250, any = false, missing = [];
  for (const rung of RUNGS) {
    if (rung.step !== step && !(rung.step < step && step <= 2)) continue;   // a Frame run shows the frame; Motion runs show the clip
    let f = r[rung.kind] || (rung.alt || []).map((k) => r[k]).find(Boolean);
    if (rung.kind === "look") {
      const alts = demo.scene?.candidates?.[shot] || [];
      if (alts.length) { const n = lookTurn.get(shot) || 0; lookTurn.set(shot, n + 1); f = alts[n % alts.length]; }
    }
    if (!f) { if (rung.step === step) missing.push(rung.kind); continue; }
    any = true;
    setTimeout(() => {
      api.dispatchCustomEvent("executing", { prompt_id: id, node: String(rung.node) });
      api.dispatchCustomEvent("executed", { prompt_id: id, node: String(rung.node),
        output: { images: [{ filename: f.filename, subfolder: f.subfolder || "", type: "output" }], ...(rung.video ? { animated: [true] } : {}) } });
    }, t);
    t += rung.video ? 450 : 300;
  }
  setTimeout(() => {
    if (step >= 5) demo.toast("The Layer Pack (EXR, PSD, ProRes) is written on the GPU server: available in the full install.");
    else if (!any || missing.length) demo.toast("This shot wasn't rendered on the GPU for that step yet. Scenes with renders: Dry Creek, the cars, the chase, the stunt, the western, and the underwater, fire, airplane and train sets.");
    api.dispatchCustomEvent("executing", { prompt_id: id, node: null });
    api.dispatchCustomEvent("execution_success", { prompt_id: id });
  }, t + 100);
}
