// Soundstage Cut, Milestone 19: generate a sound in place from the Cut editor with the App's own audio nodes
// (Soundstage · Sound Effect / Music Cue / Dialogue Line; open-weights engines: LTX-2.5 audio, Chatterbox), queue it
// as one small prompt of our own, and hand back the clip JSON the node writes (docs/audio.md) with a /view URL.
// The node's prompt hygiene (guard_prompt) and placement rules apply as they do on the canvas.

const NODE = { sfx: "SoundstageSFX", music: "SoundstageMusic", dialogue: "SoundstageDialogue" };
const TRACK = { sfx: "FX1", music: "MX1", dialogue: "DX1" };

/** Required inputs of a node from its /object_info entry, at their defaults (the first, open-weights engine). */
export function defaultInputs(info) {
  const out = {};
  const walk = (section, prefix) => {
    for (const [name, spec] of Object.entries(section || {})) {
      const [type, opts = {}] = spec;
      const key = prefix + name;
      if (type === "COMFY_DYNAMICCOMBO_V3") {
        const o = (opts.options || [])[0];
        if (!o) continue;
        out[key] = o.key;
        walk(o.inputs?.required, key + ".");
      } else if (Array.isArray(type)) out[key] = opts.default ?? type[0];
      else if (type === "COMBO") out[key] = opts.default ?? (opts.options || [])[0];
      else if (opts.default !== undefined) out[key] = opts.default;
      else if (type === "INT" || type === "FLOAT") out[key] = opts.min ?? 0;
      else if (type === "STRING") out[key] = "";
      else if (type === "BOOLEAN") out[key] = false;
    }
  };
  walk(info?.input?.required, "");
  return out;
}

/** The inputs for one generation (pure: tests/js/cut_m19.test.mjs). */
export function generationInputs(kind, defaults, { text, seconds, start_frame = 0, fps = 24, shot_id = "cut", character = "", seed = null }) {
  const inp = { ...defaults, shot_id, start_frame: Math.max(0, Math.round(start_frame)), fps: Number(fps) || 24, track: TRACK[kind] };
  inp.seed = seed ?? Math.floor(Math.random() * 2 ** 31);
  if (kind === "sfx") Object.assign(inp, { prompt: text, duration_s: Math.min(30, Math.max(0.5, seconds || 2.5)) });
  else if (kind === "music") Object.assign(inp, { genre: text, mood: "cinematic", instruments: "", notes: "", tempo_bpm: 0, length_s: Math.max(1, seconds || 12) });
  else Object.assign(inp, { line: text, character: character || "NARRATOR" });
  return inp;
}

/** clip JSON from the node (path relative to output/) -> a clip the Cut plays. */
export function clipFromNode(clip, viewUrl) {
  const path = String(clip.path || "");
  const i = path.lastIndexOf("/");
  const url = viewUrl({ filename: path.slice(i + 1), subfolder: i > 0 ? path.slice(0, i) : "", type: "output" });
  const { track: _t, ...rest } = clip;
  return { ...rest, url };
}

/**
 * A generateAudio(request) for CutPanel: queues {NODE} on the ComfyUI server, waits for its clip JSON.
 * api: ComfyUI's api object (fetchApi, apiURL, addEventListener, clientId).
 */
export function makeAudioGenerator(api, { shotId = () => "cut", timeoutMs = 15 * 60 * 1000 } = {}) {
  const infos = {};
  const viewUrl = (f) => api.apiURL(`/view?${new URLSearchParams(f)}`);
  return async (req) => {
    const kind = NODE[req.kind] ? req.kind : "sfx";
    const cls = NODE[kind];
    if (!infos[cls]) {
      const r = await api.fetchApi(`/object_info/${cls}`);
      if (!r.ok) throw new Error(`${cls} is not installed on this server`);
      infos[cls] = (await r.json())[cls];
    }
    const inputs = generationInputs(kind, defaultInputs(infos[cls]), { ...req, shot_id: shotId() || "cut" });
    const res = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { 1: { class_type: cls, inputs }, 2: { class_type: "PreviewAny", inputs: { source: ["1", 1] } } }, client_id: api.clientId ?? api.initialClientId }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.prompt_id) throw new Error(j.error?.message || JSON.stringify(j.node_errors || j).slice(0, 200));
    const pid = j.prompt_id;
    return await new Promise((resolve, reject) => {
      let clip = null, done = false;
      const off = () => { done = true; for (const [t, h] of hs) api.removeEventListener(t, h); clearInterval(poll); clearTimeout(to); };
      const finish = () => { if (done) return; off(); clip ? resolve(clipFromNode(clip, viewUrl)) : reject(new Error("the node gave no clip")); };
      const hs = [
        ["executed", (e) => { if (e.detail?.prompt_id !== pid) return; const t = e.detail?.output?.text?.[0]; if (t) { try { const c = JSON.parse(t); if (c.path) clip = c; } catch { /* other text */ } } }],
        ["execution_success", (e) => { if (e.detail?.prompt_id === pid) setTimeout(finish, 50); }],
        ["execution_error", (e) => { if (e.detail?.prompt_id === pid) { off(); reject(new Error(e.detail.exception_message || "generation failed")); } }],
      ];
      for (const [t, h] of hs) api.addEventListener(t, h);
      // Fallback when the socket misses an event: the history has the node's ui text.
      const poll = setInterval(async () => {
        try {
          const h = (await (await api.fetchApi(`/history/${pid}`)).json())[pid];
          if (!h) return;
          for (const o of Object.values(h.outputs || {})) for (const t of o.text || []) { try { const c = JSON.parse(t); if (c.path) clip = c; } catch { /* */ } }
          if (h.status?.status_str === "error") { off(); reject(new Error("generation failed")); } else if (h.status?.completed) finish();
        } catch { /* keep waiting */ }
      }, 3000);
      const to = setTimeout(() => { off(); reject(new Error("timed out")); }, timeoutMs);
    });
  };
}

/** uploadAudio(file) for CutPanel: ComfyUI's upload endpoint (input/soundstage_audio_import/), back as a /view URL. */
export function makeAudioUploader(api) {
  return async (file) => {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    body.append("subfolder", "soundstage_audio_import");
    const r = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!r.ok) throw new Error(`upload answered ${r.status}`);
    const j = await r.json();
    return api.apiURL(`/view?${new URLSearchParams({ filename: j.name, subfolder: j.subfolder || "", type: j.type || "input" })}`);
  };
}
