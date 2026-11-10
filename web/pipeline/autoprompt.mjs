// ④ Frame: where the frame prompt comes from. Auto: a local vision LLM looks at frame 1 of the stage and the cast
// pictures and writes it (soundstage/look/autoprompt.py: the LLM writes the setting and each person's looks; the form
// per frame model, the head count and every placement stay the stage's). Compiled: the rules in look/compile.py.
// Manual: the user's own text, sent untouched. Stored per shot in the Look JSON's `frame_prompts`, which the Look node
// applies (apply_override) to the output the frame model reads: edit_prompt for FLUX Klein, still_prompt otherwise.
// Auto comes in up to four variants (Naturalistic, Moody cinematic, Documentary, High contrast), each the compiled
// prompt's stage facts plus the vision model's light, mood and texture words: cards to pick from, and "Try all" paints
// a frame from each so you pick by the picture.

export const PROMPT_SOURCES = [["auto", "Auto"], ["compiled", "Compiled"], ["manual", "Manual"]];
export const SOURCE_TITLES = {
  auto: "Auto: a vision model on this machine looks at your stage's frame 1 and the cast pictures and writes the prompt " +
    "(the stage still decides who is where and how many). Falls back to Compiled when it is missing, slow or its words fail the checks.",
  compiled: "Compiled: the prompt built by rules from your stage and the Look tab.",
  manual: "Manual: your own text, sent to the image model exactly as typed.",
};
export const AUTO_MISSING = "Auto needs a local vision model (Ollama qwen3-vl, or Qwen3-VL in models/text_encoders): using Compiled.";

/** Which Look output the ④ Frame model reads: "edit" (FLUX Klein's instruction) or "still" (Krea 2, Strict, others). */
export const frameTarget = (modelKey, { krea = false, strict = false } = {}) =>
  (!krea && !strict && /\bKlein\b/.test(String(modelKey || "")) ? "edit" : "still");

export function entryOf(state, sid) {
  const e = state?.frame_prompts?.[sid];
  return e && typeof e === "object" ? e : null;
}

/** The frame_prompts map with one shot's entry replaced (null removes it). */
export function withEntry(state, sid, entry) {
  const map = { ...(state?.frame_prompts && typeof state.frame_prompts === "object" ? state.frame_prompts : {}) };
  if (entry) map[sid] = entry; else delete map[sid];
  return map;
}

/** A shot's source: what it was set to, else Auto when a vision model is installed, else Compiled. */
export function sourceOf(state, sid, autoAvailable) {
  const s = entryOf(state, sid)?.source;
  if (s === "manual" || s === "compiled") return s;
  if (s === "auto") return autoAvailable ? "auto" : "compiled";
  return autoAvailable ? "auto" : "compiled";
}

/** The line under the prompt box for an Auto result. */
export function noteText(res) {
  if (!res) return "";
  if (res.error) return `Auto prompt failed (${res.error}): using Compiled.`;
  const secs = res.ms != null ? `${Math.max(1, Math.round(res.ms / 1000))} s` : "";
  const who = [res.model, res.cached ? "cached" : secs].filter(Boolean).join(", ");
  if (res.source !== "auto") {
    const why = (res.notes || []).slice(-1)[0] || "the vision model gave nothing usable";
    return `${why}${res.problems?.length ? ` (${res.problems.join("; ")})` : ""}`;
  }
  const bits = [`Auto${who ? ` (${who})` : ""}.`];
  if (res.seen) bits.push(`I see: ${res.seen.replace(/\.$/, "")}.`);
  if (res.changed) bits.push(`I changed: ${res.changed.replace(/\.$/, "")}.`);
  if (res.notes?.length) bits.push(`Checks: ${res.notes.length} clause${res.notes.length > 1 ? "s" : ""} dropped.`);
  return bits.join(" ");
}

/** The variants kept in a shot's entry: key, label, the added words and the full prompt (no notes). */
export const slimVariants = (vs) => (Array.isArray(vs) ? vs : []).filter((v) => v?.key && v.prompt)
  .map(({ key, label, words, prompt, builtin }) => ({ key, label: label || key, words: words || "", prompt, ...(builtin ? { builtin: true } : {}) }));

/** Try all: which variant each queued frame uses. One frame each, or the Variations count split across them. */
export function tryAllPlan(variants, count) {
  const vs = Array.isArray(variants) ? variants.filter((v) => v?.prompt) : [];
  if (vs.length < 2) return null;
  const per = Math.max(1, Math.round((count || 1) / vs.length));
  return vs.flatMap((v) => Array.from({ length: per }, () => v));
}

/** A canvas as a JPEG data URL, longest side `side` (what the vision model sees). */
export function canvasDataUrl(canvas, side = 768, doc = globalThis.document) {
  if (!canvas?.width || !doc) return "";
  const k = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const c = doc.createElement("canvas");
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88);
}

/**
 * The prompt-source block in ④ Frame: [Auto | Compiled | Manual], the prompt that goes to the model (editable: typing
 * switches to Manual), ↻ Rewrite, and a note. io: { h, fetchApi, look (LookPanel), scene(), shotId(), frame(),
 * refFiles(), target(), steps() }.
 */
export class FramePrompt {
  constructor(io) {
    this.io = io;
    this.available = false;
    this.status = null;
    this.last = {};             // shot id -> the last auto result
    this.busy = null;           // shot id being written
    const h = io.h;
    this.seg = h("span", { class: "seg row", role: "group", "aria-label": "Prompt source" }, ...PROMPT_SOURCES.map(([k, label]) =>
      h("button", { type: "button", "data-k": k, title: SOURCE_TITLES[k], "aria-pressed": "false",
        on: { click: () => this.setSource(k) } }, label)));
    this.box = h("textarea", { class: "ss-fprompt", style: "min-height:96px", "aria-label": "The prompt sent to the image model",
      on: { input: () => this._typed() } });
    this.rewrite = h("button", { type: "button", class: "ghost", title: "Write the Auto prompt again from the stage as it is now",
      on: { click: () => this.write(true) } }, "↻ Rewrite");
    this.note = h("small", { class: "status ss-fprompt-note" });
    this.tryAll = false;
    this.tryAllBtn = h("button", { type: "button", class: "ghost", "aria-pressed": "false",
      title: "Try all: Generate paints a frame from each Auto variant (the Variations count split across them), each labelled with its variant, so you can pick by the picture",
      on: { click: () => this.setTryAll(!this.tryAll) } }, "Try all");
    this.cards = h("div", { class: "ss-fvariants", role: "group", "aria-label": "Auto prompt variants" });
    this.el = h("div", { class: "f ss-fprompt-block" },
      h("span", { class: "row" }, "Frame prompt", this.seg, h("span", { style: "flex:1" }), this.tryAllBtn, this.rewrite),
      this.cards, this.box, this.note);
    this.cards.hidden = this.tryAllBtn.hidden = true;   // drawn by show() once a shot is active
  }

  sid() { return this.io.shotId(); }
  state() { return this.io.look?.state || {}; }
  source(sid = this.sid()) { return sourceOf(this.state(), sid, this.available); }

  async refreshStatus() {
    try {
      const r = await this.io.fetchApi("/soundstage/look/autoprompt/status");
      this.status = await r.json();
      this.available = !!this.status?.available;
    } catch { this.available = false; }
    this._drawSeg();
    return this.available;
  }

  _save(sid, entry) {
    const look = this.io.look;
    if (!look?.state) return;
    look.state.frame_prompts = withEntry(look.state, sid, entry);
    try { look.onChange?.(look.toJSON()); } catch { /* look not ready */ }
  }

  _drawSeg() {
    const src = this.source();
    for (const b of this.seg.children) {
      b.setAttribute("aria-pressed", String(b.dataset.k === src));
      b.disabled = b.dataset.k === "auto" && !this.available;
      b.title = b.disabled ? AUTO_MISSING : SOURCE_TITLES[b.dataset.k];
    }
    this.rewrite.hidden = src !== "auto";
    this._drawCards();
  }

  /** The Auto variants of a shot: the last answer's, else the ones kept in its entry. */
  variantsOf(sid = this.sid()) {
    const last = this.last[sid];
    if (last?.source === "auto" && last.variants?.length) return slimVariants(last.variants);
    return slimVariants(entryOf(this.state(), sid)?.variants);
  }

  /** The picked variant's key (the entry's, else the one whose text it holds). */
  pickedOf(sid = this.sid()) {
    const e = entryOf(this.state(), sid);
    if (!e || e.source !== "auto") return "";
    const vs = this.variantsOf(sid);
    return vs.find((v) => v.key === e.variant)?.key || vs.find((v) => v.prompt === e.text)?.key || "";
  }

  _drawCards() {
    const h = this.io.h, sid = this.sid();
    const vs = this.source(sid) === "auto" ? this.variantsOf(sid) : [];
    const picked = this.pickedOf(sid);
    this.cards.hidden = vs.length < 1;
    this.tryAllBtn.hidden = vs.length < 2;
    this.tryAllBtn.setAttribute("aria-pressed", String(this.tryAll && vs.length >= 2));
    this.cards.replaceChildren(...vs.map((v) => h("div", { class: "ss-fvar", "data-k": v.key, "aria-pressed": String(v.key === picked) },
      h("button", { type: "button", class: "ss-fvar-pick", "aria-pressed": String(v.key === picked),
        title: `Use the ${v.label} prompt for this shot`, on: { click: () => this.pick(v.key) } },
        h("b", {}, v.label), h("small", {}, v.words || "")),
      h("details", {}, h("summary", {}, "Full prompt"), h("p", {}, v.prompt)))));
  }

  /** Make one Auto variant this shot's prompt. */
  pick(key, sid = this.sid()) {
    const v = this.variantsOf(sid).find((x) => x.key === key);
    if (!v) return null;
    const e = entryOf(this.state(), sid) || {}, last = this.last[sid];
    this._save(sid, { source: "auto", text: v.prompt, target: e.target || last?.target || this.io.target(), sig: e.sig || last?.sig,
      variant: v.key, variants: this.variantsOf(sid) });
    if (sid === this.sid()) {
      this.box.value = v.prompt;
      this.note.textContent = `Auto, ${v.label}${v.words ? `: ${v.words}` : ""}${v.builtin ? " (built-in words: the vision model's did not pass the checks)" : ""}. Edit it to make it Manual.`;
      this._drawSeg();
    }
    return v;
  }

  setTryAll(on) {
    this.tryAll = !!on;
    this._drawCards();
  }

  /** The variants Generate paints, one per queued frame, when Try all is on (else null). */
  tryAllPlan(count, sid = this.sid()) {
    if (!this.tryAll || this.source(sid) !== "auto") return null;
    return tryAllPlan(this.variantsOf(sid), count);
  }

  /** Run fn (one queue) with variant v as the shot's prompt, then put the picked one back. */
  async withVariant(v, fn, sid = this.sid()) {
    const prev = entryOf(this.state(), sid);
    this._save(sid, { ...(prev || { source: "auto" }), source: "auto", text: v.prompt, variant: v.key,
      target: prev?.target || this.io.target() });
    try { return await fn(); } finally { this._save(sid, prev); }
  }

  /** Show the active shot's prompt in the box (the Auto text, the typed text, or the compiled one). */
  async show() {
    const sid = this.sid(), src = this.source(sid), e = entryOf(this.state(), sid);
    this._drawSeg();
    if (src === "manual") { this.box.value = e?.text || ""; this.note.textContent = "Manual: sent exactly as typed."; return; }
    if (src === "auto" && e?.text) { this.box.value = e.text; this.note.textContent = this.last[sid] ? noteText(this.last[sid]) : "Auto: written from your stage. ↻ Rewrite after changing the shot."; return; }
    this.box.value = await this.compiled();
    this.note.textContent = src === "auto" ? "Auto writes the prompt when you Generate (or press ↻ Rewrite)." :
      this.available ? "Compiled from your stage and the Look tab." : AUTO_MISSING;
  }

  async compiled() {
    try {
      const look = { ...this.state() }; delete look.frame_prompts;
      const r = await this.io.fetchApi("/soundstage/look/compile", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ look, scene: this.io.scene() }) });
      const j = await r.json();
      return (this.io.target() === "edit" ? j.edit_prompt : j.still_prompt) || "";
    } catch { return ""; }
  }

  setSource(k) {
    const sid = this.sid(), e = entryOf(this.state(), sid);
    if (k === "manual") this._save(sid, { source: "manual", text: this.box.value, target: this.io.target() });
    else if (k === "compiled") this._save(sid, { source: "compiled" });
    else this._save(sid, e?.source === "auto" ? e : { source: "auto" });
    this.show();
    if (k === "auto" && !entryOf(this.state(), sid)?.text) this.write(false);
  }

  /** Typing in the box makes it this shot's Manual prompt, kept exactly as typed. */
  _typed() {
    const sid = this.sid();
    this._save(sid, { source: "manual", text: this.box.value, target: this.io.target() });
    this._drawSeg();
    this.note.textContent = "Manual: sent exactly as typed. Auto or Compiled replaces it.";
  }

  /** Ask the vision model for this shot's prompt. Falls back to Compiled (the entry keeps source auto, no text). */
  async write(force = false) {
    const sid = this.sid();
    if (this.busy === sid) return this.last[sid];
    this.busy = sid;
    this.note.textContent = "Writing the prompt from your stage and cast pictures…";
    let res;
    try {
      const r = await this.io.fetchApi("/soundstage/look/autoprompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ look: this.state(), scene: this.io.scene(), target: this.io.target(), image: this.io.frame(),
          ref_files: this.io.refFiles() || "", steps: this.io.steps?.() || 0, force }) });
      res = await r.json();
    } catch (e) { res = { error: e.message }; }
    this.busy = null;
    this.last[sid] = res;
    if (this.source(sid) !== "auto") return res;   // the user switched away while it was writing
    const ok = res && !res.error && res.source === "auto" && res.prompt;
    // the variant picked before (a card, or Try all's last pick) stays picked when the stage did not change
    const was = entryOf(this.state(), sid)?.variant;
    const vs = ok ? slimVariants(res.variants) : [];
    const v = vs.find((x) => x.key === was) || vs[0];
    const text = v?.prompt || (ok ? res.prompt : "");
    this._save(sid, ok ? { source: "auto", text, target: res.target, sig: res.sig, ...(v ? { variant: v.key, variants: vs } : {}) }
      : { source: "auto" });
    if (sid === this.sid()) {
      this.box.value = ok ? text : (res?.compiled || await this.compiled());
      this.note.textContent = noteText(res) + (v && vs.length > 1 ? ` ${vs.length} variants: ${v.label} picked.` : "");
      this._drawCards();
    }
    return res;
  }

  /** Before ④ Frame queues a shot: an Auto shot gets its prompt written (the server's cache answers at once when
   *  nothing changed); a Manual one follows the frame model's target. */
  async ensure() {
    const sid = this.sid(), src = this.source(sid), e = entryOf(this.state(), sid);
    if (src === "auto") return this.write(false);
    // Auto picked earlier, but no vision model now: its old text is not sent, the compiled prompt is
    if (e?.source === "auto" && e.text && !this.available) this._save(sid, { source: "auto" });
    if (src === "manual" && e && e.target !== this.io.target()) this._save(sid, { ...e, target: this.io.target() });
    return null;
  }
}
