// Activity: every job on the shared GPU queue in one place (Mike 2026-11-03: "we should see all the tasks being done, how
// long they've been going, when they'll be completed, and what's coming up next").
//
// Three sources, none of them heavy:
//   - ComfyUI's websocket events (execution_start / progress / executed / execution_success / _error / _interrupted)
//     for the job that is running: its step, its elapsed time, its result and its error.
//   - GET /soundstage/queue_summary (web/ui/queue.mjs) for who is queued and in what order, every user's jobs, with a
//     short label and the client id. Never the full GET /queue or GET /history.
//   - The App's own job registry: any part of the App (or the Cut / VCam rebuilds) can name a job it queued with
//       window.dispatchEvent(new CustomEvent("soundstage:job", { detail: { prompt_id, name, kind, trigger, width, height } }))
//     or registry.note(prompt_id, {...}); a job nobody names keeps the server's label.
//
//   const reg = new ActivityRegistry({ clientId })     reg.onEvent(type, detail)  reg.applySummary(summary)
//   reg.view(now) -> { running:[], queued:[], finished:[], totals:{ running, queued, etaMs, etaPartial } }
//   pillText(totals)  -> "2 running · 3 queued · ~6 min"
//   renderPanel(view, { onCancel, viewUrl }) -> the panel's DOM
//   mountActivity({ api, row, before, theme }) -> the top-row pill and its panel, wired to the live App
import { openPopover, closePopover, isPopoverOpen } from "./popover.mjs";
import { icon } from "./icons.mjs";
import { queueSummary } from "./queue.mjs";

export const JOB_EVENT = "soundstage:job";
export const ETA_KEY = "ss_activity_eta";
const FINISHED_KEEP = 12;            // finished / failed jobs kept in the panel
const ETA_ALPHA = 0.3;               // rolling average weight of the newest run

// ---- Job kinds: a plain name, and the key the ETA book averages by. Matched on the App's name or the server label.
export const KINDS = [
  ["hollywood", /hollywood/i, "Hollywood render"],
  ["final", /\bfinal\b/i, "Final render"],
  ["draft", /\bdraft\b/i, "Draft render"],
  ["frame", /\bframe\b|④/i, "Frame"],
  ["layers", /\blayers?\b/i, "Layers"],
  ["performance", /performance|real read|perf read/i, "Real performance read"],
  ["voice", /voice|rvc|seed-?vc/i, "Voice conversion"],
  ["video3d", /video\s*(→|->|to)\s*3d|v2s|sam ?3d|track/i, "Video → 3D"],
  ["oneclick", /one-?click|loop|reshoot/i, "One-click job"],
  ["bake", /\bbake/i, "Bake"],
  ["cut", /\bcut\b|export|conform|assemble/i, "Cut render"],
  ["takecheck", /take ?check|realism|judge/i, "Take check"],
  ["interp", /interpolat|rife|film fps/i, "Frame interpolation"],
  ["model", /model call/i, "Model call"],
  ["stage", /\bstage\b/i, "Stage"],
];

export function kindOf(text) {
  const t = String(text || "");
  for (const [k, re] of KINDS) if (re.test(t)) return k;
  return "other";
}

export function kindName(kind) {
  return KINDS.find(([k]) => k === kind)?.[2] || "Render";
}

/** The ETA book's key: the kind plus a coarse resolution bucket (a 4K Final is not a 720p Final). */
export function etaKey(kind, width = 0, height = 0) {
  const px = (Number(width) || 0) * (Number(height) || 0);
  const res = !px ? "any" : px <= 640 * 360 ? "sd" : px <= 1280 * 720 ? "hd" : px <= 1920 * 1080 ? "fhd" : "uhd";
  return `${kind}@${res}`;
}

// ---- Measured history: a small rolling average of how long each kind took, per browser (localStorage, try/catch).
export class EtaBook {
  constructor({ storage = safeStorage(), key = ETA_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.avg = {};
    try { const j = JSON.parse(storage?.getItem(key) || "{}"); if (j && typeof j === "object") this.avg = j; } catch { this.avg = {}; }
  }
  /** Average ms for a key, falling back to the kind at any resolution; null when never measured. */
  get(key) {
    const hit = this.avg[key] || this.avg[`${String(key).split("@")[0]}@any`];
    return hit && Number.isFinite(hit.ms) ? hit.ms : null;
  }
  record(key, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const add = (k) => {
      const prev = this.avg[k];
      this.avg[k] = prev ? { ms: Math.round(prev.ms * (1 - ETA_ALPHA) + ms * ETA_ALPHA), n: (prev.n || 1) + 1 } : { ms: Math.round(ms), n: 1 };
    };
    add(key);
    const any = `${String(key).split("@")[0]}@any`;
    if (any !== key) add(any);
    const keys = Object.keys(this.avg);
    if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete this.avg[k];
    try { this.storage?.setItem(this.key, JSON.stringify(this.avg)); } catch { /* storage blocked: this page only */ }
  }
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// ---- Errors in plain words.
const ERRORS = [
  [/out of memory|CUDA error: out of memory|OOM/i, "Ran out of GPU memory. Try a smaller size, fewer frames, or wait for the queue to clear."],
  [/no such file|not found|FileNotFoundError/i, "A file it needed wasn't on the server (a model or an input)."],
  [/interrupt|cancel/i, "Cancelled."],
  [/connection|timed? ?out|ECONNRESET/i, "Lost the connection to the server while it ran."],
  [/value not in list|required input|prompt_outputs_failed_validation|invalid prompt/i, "The job's settings didn't pass ComfyUI's check (a missing model or input)."],
];

export function plainError(detail) {
  const msg = String(detail?.exception_message || detail?.message || detail || "").trim();
  for (const [re, words] of ERRORS) if (re.test(msg)) return words;
  const where = detail?.node_type ? ` (in ${detail.node_type})` : "";
  const first = msg.split("\n")[0].slice(0, 160);
  return first ? `Failed${where}: ${first}` : `Failed${where}.`;
}

// ---- The registry.
export class ActivityRegistry {
  constructor({ clientId = null, eta = new EtaBook(), now = () => Date.now() } = {}) {
    this.clientId = clientId;
    this.eta = eta;
    this.now = now;
    this.jobs = new Map();
    this.notes = new Map();     // names the App gave its jobs, kept even before the job shows in the queue
    this.counts = { running: 0, pending: 0 };
    this.listeners = new Set();
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  changed() { for (const f of this.listeners) { try { f(); } catch { /* a listener never breaks the registry */ } } }

  job(pid) {
    let j = this.jobs.get(pid);
    if (!j) {
      j = { id: pid, state: "queued", position: null, label: "", own: null, queuedAt: this.now(), startedAt: null,
        endedAt: null, step: null, steps: null, error: null, outputs: [], preview: null };
      this.jobs.set(pid, j);
      const n = this.notes.get(pid);
      if (n) Object.assign(j, n, { own: true });
    }
    return j;
  }

  /** The App's own registry: a name for a job this page queued. */
  note(pid, info = {}) {
    if (!pid) return;
    const n = { ...(this.notes.get(pid) || {}), ...pick(info, ["name", "kind", "trigger", "width", "height", "shot"]) };
    this.notes.set(pid, n);
    if (this.notes.size > 200) this.notes.delete(this.notes.keys().next().value);
    const j = this.jobs.get(pid);
    if (j) Object.assign(j, n, { own: true });
    else Object.assign(this.job(pid), { own: true });
    this.changed();
  }

  /** ComfyUI websocket events (detail = event.detail). */
  onEvent(type, d = {}) {
    const pid = d?.prompt_id;
    if (type === "status") { const r = d?.status?.exec_info?.queue_remaining; if (Number.isFinite(r) && r === 0) this.settleAll(); this.changed(); return; }
    if (!pid) return;
    const j = this.job(pid);
    const t = this.now();
    switch (type) {
      case "execution_start":
        j.state = "running"; j.position = 0; j.startedAt = j.startedAt || t; break;
      case "executing":
        if (d.node == null && j.state === "running") this.finish(j, "done", t);
        else if (d.node != null) { j.state = "running"; j.startedAt = j.startedAt || t; j.node = d.display_node || d.node; }
        break;
      case "progress":
        j.state = "running"; j.startedAt = j.startedAt || t;
        if (Number.isFinite(d.value) && Number.isFinite(d.max) && d.max > 0) { j.step = d.value; j.steps = d.max; }
        break;
      case "progress_state":
        j.state = "running"; j.startedAt = j.startedAt || t; break;
      case "executed":
        for (const kind of ["images", "gifs", "videos", "audio"]) {
          for (const f of d.output?.[kind] || []) if (f?.filename) j.outputs.push({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output", kind });
        }
        if (j.outputs.length > 8) j.outputs.splice(0, j.outputs.length - 8);
        break;
      case "execution_success":
        this.finish(j, "done", t); break;
      case "execution_error":
        j.error = plainError(d); this.finish(j, "failed", t); break;
      case "execution_interrupted":
        j.error = "Cancelled."; this.finish(j, "cancelled", t); break;
      default: return;
    }
    this.changed();
  }

  finish(j, state, t) {
    if (j.endedAt) { if (state !== "done") j.state = state; return; }
    j.state = state;
    j.endedAt = t;
    j.position = null;
    if (state === "done" && j.startedAt) {
      const kind = j.kind || kindOf(j.name || j.label);
      this.eta.record(etaKey(kind, j.width, j.height), t - j.startedAt);
    }
  }

  /** Nothing left on the server: whatever we still think is running or queued has finished out of our sight. */
  settleAll() {
    const t = this.now();
    for (const j of this.jobs.values()) {
      if (j.state === "running" || j.state === "queued") {
        if (j.own) this.finish(j, "done", t);
        else this.jobs.delete(j.id);
      }
    }
  }

  /** GET /soundstage/queue_summary: positions, labels and owners for every job on the queue. */
  applySummary(s) {
    if (!s || !Array.isArray(s.items)) return;
    this.counts = { running: s.running | 0, pending: s.pending | 0 };
    const seen = new Set();
    for (const it of s.items) {
      if (!it?.prompt_id) continue;
      seen.add(it.prompt_id);
      const j = this.job(it.prompt_id);
      if (j.endedAt) continue;   // a late summary never revives a finished job
      j.label = it.label || j.label;
      j.position = it.position;
      if (it.client_id != null) j.own = j.own || (!!this.clientId && it.client_id === this.clientId);
      if (it.state === "running") { j.state = "running"; j.startedAt = j.startedAt || this.now(); }
      else j.state = "queued";
    }
    // Truncated summaries (limit) can't tell us a job left; only prune when the summary listed everything.
    const complete = s.items.length >= (s.running | 0) + (s.pending | 0);
    if (complete) {
      const t = this.now();
      for (const j of [...this.jobs.values()]) {
        if (seen.has(j.id) || j.endedAt) continue;
        if (j.state !== "running" && j.state !== "queued") continue;
        if (j.own) { if (j.state === "running" || j.startedAt) this.finish(j, "done", t); }
        else this.jobs.delete(j.id);
      }
    }
    this.changed();
  }

  /** Remaining ms for a job: step rate while sampling, else the measured average for its kind, else null. */
  remaining(j, now = this.now()) {
    const kind = j.kind || kindOf(j.name || j.label);
    const avg = this.eta.get(etaKey(kind, j.width, j.height));
    if (j.state === "queued") return avg;
    const el = j.startedAt ? now - j.startedAt : 0;
    if (avg != null) return Math.max(avg - el, j.steps ? 1000 : 0);
    if (j.steps && j.step > 0) {
      // one sampler's rate: a lower bound for a multi-stage job, so it says "at least"
      return Math.round(el / (j.step / j.steps) - el);
    }
    return null;
  }

  view(now = this.now()) {
    const all = [...this.jobs.values()].map((j) => this.row(j, now));
    const running = all.filter((r) => r.state === "running");
    const queued = all.filter((r) => r.state === "queued").sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    const finished = all.filter((r) => r.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, FINISHED_KEEP);
    // Estimated start for each queued job: what runs now plus everything ahead of it.
    let ahead = 0, partial = false;
    for (const r of running) { if (r.remainingMs == null) partial = true; else ahead += r.remainingMs; }
    for (const r of queued) {
      r.startsInMs = partial && ahead === 0 ? null : ahead;
      r.startsPartial = partial;
      if (r.remainingMs == null) partial = true; else ahead += r.remainingMs;
    }
    // Other users' jobs past the summary's list still count in the totals.
    const runningN = Math.max(running.length, this.counts.running);
    const queuedN = Math.max(queued.length, this.counts.pending);
    if (queuedN > queued.length) partial = true;
    // Forget the oldest finished jobs.
    const done = [...this.jobs.values()].filter((j) => j.endedAt).sort((a, b) => b.endedAt - a.endedAt);
    for (const j of done.slice(FINISHED_KEEP)) this.jobs.delete(j.id);
    return { running, queued, finished, totals: { running: runningN, queued: queuedN, etaMs: ahead || null, etaPartial: partial } };
  }

  row(j, now) {
    const kind = j.kind || kindOf(j.name || j.label);
    const base = j.name || j.label || kindName(kind);
    const step = j.state === "running" && j.steps ? ` · step ${j.step}/${j.steps}` : "";
    const elapsedMs = j.startedAt ? (j.endedAt || now) - j.startedAt : null;
    const remainingMs = j.endedAt ? null : this.remaining(j, now);
    const pct = j.state === "running" && elapsedMs != null && remainingMs != null && elapsedMs + remainingMs > 0
      ? Math.max(0, Math.min(99, Math.round((100 * elapsedMs) / (elapsedMs + remainingMs))))
      : j.state === "running" && j.steps ? Math.round((100 * j.step) / j.steps) : null;
    return { id: j.id, kind, name: base + step, state: j.state, own: !!j.own, position: j.position, trigger: j.trigger || "",
      elapsedMs, remainingMs, pct, endedAt: j.endedAt, error: j.error, outputs: j.outputs.slice(), preview: j.preview,
      waitedMs: j.state === "queued" ? now - j.queuedAt : null };
  }
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] != null && o[k] !== "") out[k] = o[k];
  return out;
}

// ---- Words.
export function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function clock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function pillText(t) {
  if (!t || (!t.running && !t.queued)) return "Idle";
  const parts = [];
  if (t.running) parts.push(`${t.running} running`);
  if (t.queued) parts.push(`${t.queued} queued`);
  if (t.etaMs) parts.push(`${t.etaPartial ? "≥" : "~"}${dur(t.etaMs)}`);
  return parts.join(" · ");
}

export function viewUrl(f) {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" });
  return `/view?${q}`;
}

// ---- The panel. Built with document.createElement only (labels come from other users' prompts, so text only).
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderPanel(v, { onCancel = null, urlOf = viewUrl } = {}) {
  const root = h("div", "ss-act");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Activity");
  root.append(h("div", "ss-act-head", `Activity · ${pillText(v.totals)}`));
  const section = (title, rows, fill) => {
    const s = h("section", "ss-act-sec");
    s.append(h("h4", null, title));
    if (!rows.length) s.append(h("div", "ss-act-empty", "Nothing here."));
    for (const r of rows) {
      const li = h("div", `ss-act-row ss-act-${r.state}`);
      li.dataset.id = r.id;
      const top = h("div", "ss-act-top");
      top.append(h("span", "ss-act-name", r.name));
      if (!r.own) top.append(h("span", "ss-act-other", "another user"));
      li.append(top);
      fill(li, r);
      if (r.own && onCancel && (r.state === "running" || r.state === "queued")) {
        const b = h("button", "ss-btn ss-act-cancel", "Cancel");
        b.type = "button";
        b.title = r.state === "running" ? "Stop this job now" : "Take this job off the queue";
        b.addEventListener("click", (e) => { e.stopPropagation(); onCancel(r); });
        li.append(b);
      }
      s.append(li);
    }
    root.append(s);
  };
  section("Running now", v.running, (li, r) => {
    if (r.preview) { const img = h("img", "ss-act-thumb"); img.src = r.preview; img.alt = ""; li.prepend(img); }
    const bar = h("div", "ss-act-bar");
    const fillEl = h("div", "ss-act-fill");
    fillEl.style.width = `${r.pct ?? 0}%`;
    bar.append(fillEl);
    bar.setAttribute("role", "progressbar");
    if (r.pct != null) bar.setAttribute("aria-valuenow", String(r.pct));
    li.append(bar);
    const bits = [r.pct != null ? `${r.pct}%` : "working", `${clock(r.elapsedMs)} so far`];
    bits.push(r.remainingMs != null ? `about ${dur(r.remainingMs)} left` : "time left not known yet");
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
  });
  section("Queued next", v.queued, (li, r) => {
    const bits = [r.position ? `#${r.position} in line` : "in line"];
    if (r.trigger) bits.push(`from ${r.trigger}`);
    if (r.startsInMs != null) bits.push(`starts in ${r.startsPartial ? "at least " : "about "}${dur(r.startsInMs)}`);
    else bits.push("start time not known yet");
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
  });
  section("Finished recently", v.finished, (li, r) => {
    const word = r.state === "done" ? "Done" : r.state === "cancelled" ? "Cancelled" : "Failed";
    const bits = [word];
    if (r.elapsedMs != null) bits.push(`took ${dur(r.elapsedMs)}`);
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
    if (r.state === "failed" && r.error) li.append(h("div", "ss-act-err", r.error));
    for (const f of r.outputs.slice(-3)) {
      const a = h("a", "ss-act-link", f.filename);
      a.href = urlOf(f);
      a.target = "_blank";
      a.rel = "noopener";
      li.append(a);
    }
  });
  return root;
}

export const ACTIVITY_CSS = `
.ss-actbtn { display:inline-flex; align-items:center; gap:6px; margin-left:6px; white-space:nowrap; flex:none; }
.ss-actbtn[data-busy=true] { color:var(--ss-accent, #e39a40) !important; }
.ss-actbtn .ss-act-dot { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.5; }
.ss-actbtn[data-busy=true] .ss-act-dot { opacity:1; animation:ss-act-pulse 1.4s ease-in-out infinite; }
.ss-stage.ss-cl[data-tw=s] .ss-actbtn .ss-act-lbl { max-width:9em; overflow:hidden; text-overflow:ellipsis; }
@keyframes ss-act-pulse { 50% { opacity:.3; } }
@media (prefers-reduced-motion: reduce) { .ss-actbtn .ss-act-dot { animation:none !important; } }
.ss-act { width:min(420px, calc(100vw - 32px)); max-height:min(70vh, 640px); overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px;
  background:var(--ss-panel, #1d2128); color:var(--ss-text, #cfd5de); border:1px solid var(--ss-line, #39404b); border-radius:8px; font-size:12px; }
.ss-act-head { font-weight:700; }
.ss-act-sec h4 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ss-dim, #7d8694); }
.ss-act-empty { color:var(--ss-dim, #7d8694); }
.ss-act-row { display:flex; flex-direction:column; gap:3px; padding:6px 0; border-top:1px solid var(--ss-line, #2b3039); }
.ss-act-top { display:flex; gap:6px; align-items:baseline; }
.ss-act-name { font-weight:600; flex:1; min-width:0; overflow-wrap:anywhere; }
.ss-act-other { font-size:10px; color:var(--ss-dim, #7d8694); }
.ss-act-thumb { width:96px; max-height:64px; object-fit:cover; border-radius:4px; }
.ss-act-bar { height:5px; background:var(--ss-line, #2b3039); border-radius:3px; overflow:hidden; }
.ss-act-fill { height:100%; background:var(--ss-accent, #e39a40); }
.ss-act-meta { color:var(--ss-dim, #9aa3b0); }
.ss-act-err { color:#ef8a7a; }
.ss-act-link { color:var(--ss-accent, #e39a40); overflow-wrap:anywhere; }
.ss-act-cancel { align-self:flex-start; padding:2px 8px !important; font-weight:500 !important; }
`;

// ---- Cancel: own jobs only (the server can't tell users apart; the App only offers it on jobs this page queued).
export async function cancelJob(api, row) {
  if (!row?.own) return false;
  try {
    if (row.state === "running") {
      await api.fetchApi("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: row.id }) });
    } else {
      await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [row.id] }) });
    }
    return true;
  } catch { return false; }
}

const WS_EVENTS = ["status", "execution_start", "executing", "progress", "executed", "execution_success", "execution_error", "execution_interrupted"];

/** The live wiring: a pill before `before` in `row` (outside the ⋯ fold order), its panel, events and a light poll. */
export function mountActivity({ api, row, before = null, theme = null, registry = null, win = globalThis.window }) {
  if (!document.getElementById("ss-activity-css")) {
    const st = h("style");
    st.id = "ss-activity-css";
    st.textContent = ACTIVITY_CSS;
    document.head.append(st);
  }
  const reg = registry || new ActivityRegistry({ clientId: api.clientId || api.initialClientId || null });
  const btn = h("button", "ss-btn ss-actbtn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.dataset.ssIcon = "activity";
  const dot = h("span", "ss-act-dot");
  const lbl = h("span", "ss-act-lbl", "Idle");
  btn.append(dot, lbl);
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  row.insertBefore(btn, before && before.parentNode === row ? before : null);

  let panel = null;
  const draw = () => {
    if (!reg.clientId && api.clientId) reg.clientId = api.clientId;
    const v = reg.view();
    const txt = pillText(v.totals);
    lbl.textContent = txt;
    btn.title = `Activity: ${txt}. Every job on the GPU queue, with time left and Cancel for yours`;
    btn.setAttribute("aria-label", btn.title);
    btn.dataset.busy = String(!!(v.totals.running || v.totals.queued));
    if (panel && isPopoverOpen(panel)) panel.replaceChildren(...renderPanel(v, { onCancel }).childNodes);
  };
  const onCancel = async (r) => { await cancelJob(api, r); poll(); };
  btn.addEventListener("click", () => {
    if (panel && isPopoverOpen(panel)) { closePopover(panel); return; }
    panel = renderPanel(reg.view(), { onCancel });
    panel.classList.add("ss-toppop");
    for (const t of ["pointerdown", "wheel"]) panel.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    openPopover(panel, { anchor: btn, owner: btn, theme: theme || row, align: "end", gap: 6, name: "activity", remove: true });
    poll();
  });

  const handlers = WS_EVENTS.map((t) => [t, (ev) => reg.onEvent(t, ev?.detail || {})]);
  for (const [t, f] of handlers) api.addEventListener?.(t, f);
  // The live preview ComfyUI sends while sampling (no prompt id: it belongs to the job running now).
  let lastPreview = null;
  const onPreview = (ev) => {
    const blob = ev?.detail;
    if (!blob || typeof URL?.createObjectURL !== "function") return;
    const run = [...reg.jobs.values()].find((j) => j.state === "running");
    if (!run) return;
    if (lastPreview) URL.revokeObjectURL(lastPreview);
    lastPreview = run.preview = URL.createObjectURL(blob);
  };
  api.addEventListener?.("b_preview", onPreview);
  const onJob = (ev) => { const d = ev?.detail || {}; reg.note(d.prompt_id, d); };
  win?.addEventListener?.(JOB_EVENT, onJob);
  const offChange = reg.onChange(draw);

  // The summary: every 4 s while anything is running or queued (or the panel is open), every 20 s when idle.
  let timer = 0, stopped = false, inflight = false;
  async function poll() {
    if (stopped || inflight) return;
    inflight = true;
    try { const s = await queueSummary(api, { limit: 200 }); if (s) reg.applySummary(s); } finally { inflight = false; }
  }
  const tick = () => {
    if (stopped) return;
    const v = reg.view();
    const busy = v.totals.running || v.totals.queued || (panel && isPopoverOpen(panel));
    if (!document.hidden) poll();
    draw();
    timer = setTimeout(tick, busy ? 4000 : 20000);
  };
  tick();
  // The elapsed clocks tick once a second while the panel is open.
  const sec = setInterval(() => { if (panel && isPopoverOpen(panel)) draw(); }, 1000);
  return {
    button: btn, registry: reg, draw, poll,
    dispose() {
      stopped = true; clearTimeout(timer); clearInterval(sec); offChange();
      for (const [t, f] of handlers) api.removeEventListener?.(t, f);
      api.removeEventListener?.("b_preview", onPreview);
      win?.removeEventListener?.(JOB_EVENT, onJob);
      if (lastPreview) URL.revokeObjectURL(lastPreview);
      btn.remove();
    },
  };
}
