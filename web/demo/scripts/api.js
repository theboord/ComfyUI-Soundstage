// Stand-in for ComfyUI's scripts/api.js so the real Soundstage App runs as a static demo.
// Run / Generate replay the renders a GPU made earlier for the same scene and shot (listed in the workflow's own
// node properties); server routes answer from precomputed results (Look compile, Advisor) or say what needs a GPU.

const bus = new EventTarget();
const BASE = new URL("../", import.meta.url);            // the demo root (index.html, r/)
const uploads = new Map();   // demo uploads: name -> blob: URL
let seq = 0;

export const demo = {
  scene: null,          // { key, compile, advisor, cut, renders: {shotId: {kind: fileRef}} }
  getShot: () => null,  // set by the shell: the active shot id
  getStep: () => 1,     // set by the shell: the ladder step to climb to
  toast: () => {},      // set by the shell
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const asset = (name) => new URL(`r/${String(name).replace(/\.png$/i, ".jpg")}`, BASE).href;

export const api = {
  clientId: "demo",
  api_base: "",
  addEventListener: (t, f) => bus.addEventListener(t, f),
  removeEventListener: (t, f) => bus.removeEventListener(t, f),
  dispatchCustomEvent(t, detail) { bus.dispatchEvent(new CustomEvent(t, { detail })); },

  /** /view?filename=X -> the shipped copy of X; anything else stays as it is. */
  apiURL(path) {
    const m = /^\/view\?filename=([^&]+)/.exec(path);
    if (!m) return path;
    const name = decodeURIComponent(m[1]);
    return uploads.get(name) || asset(name);
  },
  fileURL(path) { return path; },

  async fetchApi(path, init = {}) {
    const p = String(path).split("?")[0];
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
    if (p === "/soundstage/cut/render_video") {
      if (!s.cut) return json({ error: "This scene's cut wasn't rendered on the GPU yet." }, 422);
      demo.toast("Demo: the cut as joined on the server.");
      return json({ filename: s.cut, subfolder: "", type: "output", seconds: s.cutSeconds || 0, missing: [] });
    }
    if (p === "/queue") return json({ queue_running: [], queue_pending: [] });
    if (p.startsWith("/object_info")) return json({});
    if (p === "/upload/image") {
      // Kept in this browser tab only: the image shows in the App like a real upload (nothing leaves the page).
      const file = init.body?.get?.("image");
      const name = `${++seq}_${(file?.name || "image.png").replace(/[^\w.-]/g, "_")}`;
      if (file) uploads.set(name, URL.createObjectURL(file));
      const sub = init.body?.get?.("subfolder") || "";
      return json({ name, subfolder: sub, type: "input" });
    }
    return json({ error: "This needs the ComfyUI server (the demo runs without one)." }, 404);
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
  async getUserData() { return new Response("{}"); },
};

// Rung output nodes of the Soundstage App graph (same ids and titles as the real workflow).
const RUNGS = [
  { step: 1, node: 9099, kind: "previz", video: true },
  { step: 2, node: 9058, kind: "look", video: false },
  { step: 3, node: 9063, kind: "draft", video: true },
  { step: 4, node: 9090, kind: "final_sound", video: true, alt: ["final", "final_audio"] },
];

function replay(id, shot, step) {
  const r = (demo.scene?.renders || {})[shot] || {};
  api.dispatchCustomEvent("execution_start", { prompt_id: id });
  let t = 250, any = false, missing = [];
  for (const rung of RUNGS) {
    if (rung.step > step) break;
    const f = r[rung.kind] || (rung.alt || []).map((k) => r[k]).find(Boolean);
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
    if (step >= 5) demo.toast("Demo: Layer Pack export writes EXR/PSD/ProRes on the GPU server, so it isn't replayed here.");
    else if (!any || missing.length) demo.toast("This shot's render for that step wasn't made on the GPU yet.");
    api.dispatchCustomEvent("executing", { prompt_id: id, node: null });
    api.dispatchCustomEvent("execution_success", { prompt_id: id });
  }, t + 100);
}
