// ④ Frame: the first-frame check. Every candidate the App paints is checked against the stage (the Soundstage ·
// First Frame Check node: SAM 3.1 against the ID pass of frame 1, soundstage/takecheck/framecheck.py): object count,
// silhouette IoU per actor and extra (ghost) objects. Each candidate gets a badge; a flagged one (an extra car, an
// actor missing or off its mark) is re-rolled automatically with a new seed, at most REROLLS times per Generate,
// and never becomes a shot's automatic pick while a clean frame exists.

export const REROLLS = 2;

/** The badge for a check result: {text, tone: good | warn | bad | wait | none, title}. Mirrors framecheck.badge(). */
export function badgeOf(res) {
  if (!res) return null;
  if (res.pending) return { text: "Checking…", tone: "wait", title: "Comparing this frame with your clay (SAM 3.1)" };
  if (res.error) return { text: "Check failed", tone: "none", title: String(res.error) };
  const pct = res.score == null ? "" : ` ${Math.round(100 * res.score)}%`;
  const why = res.why || "";
  const counts = Object.entries(res.counts || {}).map(([k, c]) => `${k}: clay ${c.stage}, frame ${c.frame}`).join(" · ");
  const actors = (res.actors || []).map((a) => `${a.name} ${Math.round(100 * a.iou)}%`).join(", ");
  const title = [why, counts, actors && `Silhouette match: ${actors}`].filter(Boolean).join("\n");
  if (res.verdict === "ok") return { text: `✓ Matches clay${pct}`, tone: "good", title };
  if (res.verdict === "loose") return { text: `≈ Loose${pct}`, tone: "warn", title };
  if (res.verdict === "flag") return { text: `⚠ ${why.split(";")[0] || "off the blocking"}`, tone: "bad", title };
  return { text: "–", tone: "none", title: why };
}

export const flagged = (res) => res?.verdict === "flag";
/** Rank for picking the best automatic frame: clean first, then by silhouette score. */
export const rank = (res) => (!res || res.pending || res.error ? 1 : res.verdict === "ok" ? 3 : res.verdict === "loose" ? 2 : 0) + (res?.score || 0) * 0.5;

const annotated = (f) => `${f.subfolder ? `${f.subfolder}/` : ""}${f.filename} [${f.type || "output"}]`;

/** Queues the check node for a frame file and calls back with the parsed result. */
export class FrameCheck {
  constructor(api) {
    this.api = api;
    this.waiting = new Map();   // prompt id -> callback
    api?.addEventListener?.("executed", (ev) => {
      const d = ev.detail || {}, cb = this.waiting.get(d.prompt_id);
      if (!cb) return;
      const text = d.output?.text?.[0];
      if (!text) return;
      this.waiting.delete(d.prompt_id);
      try { cb(JSON.parse(text)); } catch (e) { cb({ error: e.message }); }
    });
    api?.addEventListener?.("execution_error", (ev) => {
      const d = ev.detail || {}, cb = this.waiting.get(d.prompt_id);
      if (!cb) return;
      this.waiting.delete(d.prompt_id);
      cb({ error: d.exception_message || "the check failed" });
    });
  }

  async check(file, cb) {
    if (!file?.filename || !this.api?.fetchApi) return false;
    try {
      const body = { client_id: this.api.clientId, prompt: { ss_framecheck: { class_type: "SoundstageFrameCheck", inputs: { image: annotated(file) } } } };
      const r = await this.api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.prompt_id) { cb({ error: j?.error?.message || "the First Frame Check node isn't installed" }); return false; }
      this.waiting.set(j.prompt_id, cb);
      return true;
    } catch (e) { cb({ error: e.message }); return false; }
  }
}

export const FRAMECHECK_CSS = `
.ss-pipeview .cand .fc { position:absolute; left:6px; top:6px; font-size:11px; font-weight:700; border-radius:999px; padding:2px 8px; background:rgba(15,13,17,.78); color:#fff; max-width:calc(100% - 12px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-pipeview .cand .fc[data-tone=good] { color:#30d158; }
.ss-pipeview .cand .fc[data-tone=warn] { color:#ffd60a; }
.ss-pipeview .cand .fc[data-tone=bad] { background:#ff453a; color:#fff; }
.ss-pipeview .cand .fc[data-tone=wait] { color:#a9a3ad; font-weight:500; }
`;
