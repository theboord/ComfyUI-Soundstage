// Soundstage ADVISOR panel: describe the scene, pick a genre / movement / technique, get a shot list where
// every shot says WHY it works (with knowledge-base refs), then write the shots into the stage as camera
// setups (coverage).
//
//   const advisor = new AdvisorPanel(container, { api, stage, onStatus: (msg) => {...} });
//   advisor.refresh();   // when the tab is shown (re-reads the stage's actors / aspect on the next Suggest)
//   advisor.dispose();
//
// Server: POST /soundstage/advisor and GET /soundstage/advisor/vocab (soundstage/cine/routes.py), the same
// rules engine the SoundstageAdvisor node runs. The stage's live toJSON() goes with every request, so the
// cameras are framed on the actual actor positions and the shot's delivery aspect. Self-contained: no
// ComfyUI imports, injects its own CSS; pass `api` (ComfyUI's api, for fetchApi + base path) or nothing.

const CSS = `
.ss-advisor { display:flex; flex-direction:column; gap:8px; padding:6px; background:#16191e; border-radius:6px;
  font:12px/1.35 -apple-system, "Segoe UI", sans-serif; color:#cfd5de; box-sizing:border-box; width:100%; min-width:0; }
.ss-advisor * { box-sizing:border-box; }
.ss-advisor h4 { margin:2px 0 0; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#7d8694; }
.ss-advisor textarea, .ss-advisor input[type=text], .ss-advisor input[type=number], .ss-advisor select {
  background:#0f1216; color:#e6e9ee; border:1px solid #39404b; border-radius:4px; padding:4px 6px; font:inherit; width:100%; min-width:0; }
.ss-advisor textarea { resize:vertical; min-height:58px; }
.ss-advisor :focus-visible { outline:2px solid #e39a40; outline-offset:1px; }
.ss-advisor :disabled { opacity:.45; cursor:default; }
.ss-adv-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:6px 8px; }
.ss-advisor label.ss-f { display:flex; flex-direction:column; gap:3px; min-width:0; }
.ss-advisor label.ss-f > span { color:#9aa3b0; font-size:11px; }
.ss-adv-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.ss-advisor .ss-btn { background:#262b33; color:#cfd5de; border:1px solid #39404b; border-radius:4px; padding:4px 10px;
  cursor:pointer; font:inherit; white-space:nowrap; }
.ss-advisor .ss-btn:hover:not(:disabled) { border-color:#e39a40; }
.ss-advisor .ss-btn.ss-primary { background:#e39a40; color:#16191e; border-color:#e39a40; font-weight:600; }
.ss-advisor .ss-btn.ss-small { padding:1px 7px; font-size:11px; }
.ss-adv-status { color:#7d8694; font-size:11px; min-height:14px; }
.ss-adv-status.ss-err { color:#e07070; }
.ss-adv-head { display:flex; flex-direction:column; gap:3px; padding:6px; background:#1c2026; border-radius:4px; }
.ss-adv-head b { color:#e6e9ee; }
.ss-adv-verdict { display:inline-block; border-radius:999px; padding:0 8px; font-size:11px; font-weight:600; }
.ss-adv-verdict.pass { background:#173a24; color:#7fd49a; } .ss-adv-verdict.warn { background:#3a2810; color:#e39a40; }
.ss-adv-verdict.fail { background:#3d1717; color:#e07070; }
.ss-adv-warn { color:#d9b27a; font-size:11px; }
.ss-adv-list { display:flex; flex-direction:column; gap:6px; }
.ss-adv-shot { display:grid; grid-template-columns:18px 1fr; gap:2px 6px; padding:6px; border:1px solid #2c323b;
  border-radius:4px; background:#1a1e24; min-width:0; }
.ss-adv-shot[data-on=false] { opacity:.5; }
.ss-adv-shot input[type=checkbox] { margin:2px 0 0; accent-color:#e39a40; }
.ss-adv-shot .ss-adv-body { display:flex; flex-direction:column; gap:3px; min-width:0; }
.ss-adv-title { display:flex; gap:6px; align-items:baseline; min-width:0; }
.ss-adv-title b { color:#e6e9ee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1; }
.ss-adv-sum { color:#9aa3b0; font-size:11px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.ss-adv-purpose { color:#cfd5de; font-style:italic; overflow-wrap:anywhere; }
.ss-adv-why { color:#cfd5de; overflow-wrap:anywhere; }
.ss-adv-why.ss-clamp { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; }
.ss-adv-refs { display:flex; flex-wrap:wrap; gap:3px; }
.ss-adv-refs span { background:#2a2116; color:#cfa36b; border-radius:999px; padding:0 7px; font-size:10.5px; }
.ss-adv-thumb { width:100%; height:auto; border-radius:3px; background:#0b0d10; display:block; }
.ss-adv-alt { color:#7d8694; font-size:11px; overflow-wrap:anywhere; }
.ss-adv-foot { display:flex; gap:6px; align-items:center; flex-wrap:wrap; position:sticky; bottom:0; background:#16191e; padding-top:4px; }
.ss-adv-foot label { display:flex; gap:4px; align-items:center; color:#9aa3b0; font-size:11px; }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("soundstage-advisor-css")) return;
  const s = document.createElement("style");
  s.id = "soundstage-advisor-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};

const STOP_EVENTS = ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "click", "dblclick",
  "contextmenu", "keydown", "keyup", "keypress", "wheel", "input", "change"];
const PICKERS = [["genre", "Genre"], ["movement", "Movement"], ["technique", "Technique"], ["intent", "Intent"],
  ["coverage", "Coverage"]];

/** Stage setups the Advisor wrote carry this marker so a re-run can replace them. */
export const ADVISOR_TAG = "advisor";

/**
 * Write advisor shots into the stage as coverage setups. Pure stage-API logic (also used by tests).
 * @returns {string[]} ids of the stage shots created
 */
export function addShotsToStage(stage, shots, { replace = false, request = null } = {}) {
  if (replace) {
    const old = (stage.toJSON().shots || []).filter((s) => s[ADVISOR_TAG]).map((s) => s.id);
    for (const id of old) {
      if ((stage.toJSON().shots || []).length < 2) break;
      stage.setActiveShot(id);
      stage.removeShot();
    }
  }
  const made = [];
  for (const s of shots) {
    stage.addShot(s.setup || "single");
    const sh = stage.activeShot();
    sh.name = s.name;
    sh[ADVISOR_TAG] = {
      shot: s.id, size: s.size, framing: s.framing, lens_mm: s.lens_mm, movement: s.movement, seconds: s.seconds,
      why: s.why, kb_refs: s.kb_refs, prompts: s.prompts, scene: request?.scene || "",
    };
    stage.setCameraKeys(s.camera_keys);
    made.push(sh.id);
  }
  if (made.length) stage.setActiveShot(made[0]);
  return made;
}

export class AdvisorPanel {
  /**
   * @param {HTMLElement} container
   * @param {{api?: {fetchApi: Function}, stage?: object, onStatus?: (msg: string) => void, getScene?: () => object}} opts
   */
  constructor(container, { api = null, stage = null, onStatus = null, getScene = null, onShotsAdded = null } = {}) {
    injectCss();
    this.stage = stage;
    this.onStatus = onStatus || (() => {});
    this.onShotsAdded = onShotsAdded; // (setupIds, advisorShots) after "Add as setups", in the Advisor's order
    this.getScene = getScene || (() => (this.stage ? this.stage.toJSON() : null));
    this.fetchApi = api?.fetchApi ? (p, i) => api.fetchApi(p, i) : (p, i) => fetch(p, i);
    this.result = null;
    this.root = el("div", { class: "ss-advisor" });
    for (const t of STOP_EVENTS) this.root.addEventListener(t, (e) => e.stopPropagation());
    container.appendChild(this.root);
    this._build();
    this._loadVocab();
  }

  // ---------- public ----------
  refresh() { if (!this.vocab) this._loadVocab(); }

  dispose() {
    this.root.remove();
  }

  request() {
    const body = { scene: this.sceneBox.value.trim(), beat: this.beatBox.value.trim(),
      max_shots: +this.maxShots.value || 0 };
    for (const [k] of PICKERS) body[k] = this.pick[k].value;
    const sc = this.getScene();
    if (sc) body.stage_scene = sc;
    return body;
  }

  async suggest() {
    const body = this.request();
    if (!body.scene) { this._status("Describe the scene first.", true); this.sceneBox.focus(); return null; }
    this._busy(true);
    this._status("Planning coverage…");
    try {
      const r = await this.fetchApi("/soundstage/advisor", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      this.result = data;
      this._lastRequest = body;
      this._renderResult();
      this._status(`${data.shots.length} shots from "${data.recipe.name}" in ${Math.round(data.ms)} ms.`);
      return data;
    } catch (err) {
      this._status(`Advisor failed: ${err.message}`, true);
      return null;
    } finally {
      this._busy(false);
    }
  }

  addAsSetups() {
    if (!this.stage || !this.result) return [];
    const chosen = this.result.shots.filter((s) => this._checked.has(s.id));
    if (!chosen.length) { this._status("Tick at least one shot.", true); return []; }
    const made = addShotsToStage(this.stage, chosen, { replace: this.replaceBox.checked, request: this._lastRequest });
    this._status(`Added ${made.length} setup${made.length === 1 ? "" : "s"} to the stage coverage.`);
    if (made.length) this.onShotsAdded?.(made, chosen);
    return made;
  }

  // ---------- internals ----------
  _status(msg, err = false) {
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle("ss-err", !!err);
    this.onStatus(msg);
  }

  _busy(on) {
    this.suggestBtn.disabled = on;
    this.addBtn.disabled = on || !this.result;
  }

  async _loadVocab() {
    try {
      const r = await this.fetchApi("/soundstage/advisor/vocab");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.vocab = await r.json();
      for (const [k] of PICKERS) {
        const sel = this.pick[k];
        const keep = sel.value;
        sel.replaceChildren(el("option", { value: "auto", text: "Auto (from the scene)" }),
          el("option", { value: "none", text: "None" }),
          ...(this.vocab[k] || []).map((o) => el("option", { value: o.id, title: o.summary, text: o.label })));
        sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "auto";
      }
    } catch (err) {
      this._status(`Could not load the knowledge base (${err.message}); pickers stay on Auto.`, true);
    }
  }

  _build() {
    this.sceneBox = el("textarea", { rows: 3, "aria-label": "Scene",
      placeholder: "What happens, where, when. e.g. Two gunfighters face off in a dusty street at noon." });
    this.beatBox = el("input", { type: "text", "aria-label": "Beat", placeholder: "Beat / intent (optional): tension rising to the draw" });
    this.sceneBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.suggest(); }
    });
    this.pick = {};
    const grid = el("div", { class: "ss-adv-grid" });
    for (const [k, label] of PICKERS) {
      this.pick[k] = el("select", { "aria-label": label }, el("option", { value: "auto", text: "Auto (from the scene)" }),
        el("option", { value: "none", text: "None" }));
      grid.append(el("label", { class: "ss-f" }, el("span", { text: label }), this.pick[k]));
    }
    this.maxShots = el("input", { type: "number", min: 0, max: 20, value: 0, "aria-label": "Max shots",
      title: "0 = the recipe's natural length" });
    grid.append(el("label", { class: "ss-f" }, el("span", { text: "Max shots (0 = all)" }), this.maxShots));
    this.suggestBtn = el("button", { type: "button", class: "ss-btn ss-primary", text: "Suggest shots",
      title: "Plan the coverage (Cmd/Ctrl+Enter)", onclick: () => this.suggest() });
    this.statusEl = el("div", { class: "ss-adv-status", role: "status", "aria-live": "polite" });
    this.headEl = el("div");
    this.listEl = el("div", { class: "ss-adv-list" });
    this.replaceBox = el("input", { type: "checkbox", checked: true });
    this.addBtn = el("button", { type: "button", class: "ss-btn ss-primary", text: "Add as setups", disabled: true,
      title: "Write the ticked shots into the stage as camera setups", onclick: () => this.addAsSetups() });
    this.footEl = el("div", { class: "ss-adv-foot" }, this.addBtn,
      el("label", { title: "Remove setups an earlier Advisor run added before adding these" }, this.replaceBox,
        "replace earlier advisor setups"));
    this.footEl.hidden = true;
    this.root.append(
      el("h4", { text: "Director's Advisor" }),
      this.sceneBox, this.beatBox, grid,
      el("div", { class: "ss-adv-row" }, this.suggestBtn), this.statusEl,
      this.headEl, this.listEl, this.footEl,
    );
  }

  _renderResult() {
    const d = this.result;
    this._checked = new Set(d.shots.map((s) => s.id));
    const picks = Object.entries(d.picks).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.replace(/\s+\[.*\]$/, "")}`);
    const verdict = d.coverage.verdict;
    this.headEl.replaceChildren(el("div", { class: "ss-adv-head" },
      el("div", {}, el("b", { text: d.recipe.name }), " ",
        el("span", { class: `ss-adv-verdict ${verdict}`, title: "Coverage Doctor: 180° / 30° / geography / LTX timing",
          text: verdict === "pass" ? "coverage OK" : verdict === "warn" ? "coverage: notes" : "coverage: problem" })),
      el("div", { class: "ss-adv-sum", text: picks.join(" · ") }),
      el("div", { class: "ss-adv-why", text: d.recipe.why }),
      ...d.coverage.warnings.map((w) => el("div", { class: "ss-adv-warn", text: `! ${w}` })),
    ));
    this.listEl.replaceChildren(...d.shots.map((s) => this._shotCard(s)));
    this.footEl.hidden = !this.stage;
    this.addBtn.disabled = !this.stage;
  }

  _shotCard(s) {
    const box = el("input", { type: "checkbox", checked: true, "aria-label": `Include ${s.name}` });
    const card = el("div", { class: "ss-adv-shot", "data-on": "true" });
    box.addEventListener("change", () => {
      if (box.checked) this._checked.add(s.id); else this._checked.delete(s.id);
      card.dataset.on = String(box.checked);
    });
    const why = el("div", { class: "ss-adv-why ss-clamp", title: "Click to expand", text: s.why });
    why.addEventListener("click", () => why.classList.toggle("ss-clamp"));
    card.append(box, el("div", { class: "ss-adv-body" },
      el("div", { class: "ss-adv-title" }, el("b", { text: s.name, title: s.name })),
      this._thumb(s),
      el("div", { class: "ss-adv-sum", text: s.summary }),
      el("div", { class: "ss-adv-purpose", text: s.purpose }),
      why,
      el("div", { class: "ss-adv-refs" }, ...s.kb_refs.map((r) => el("span", { text: r }))),
      ...(s.alternatives || []).slice(0, 1).map((a) => el("div", { class: "ss-adv-alt", text: `Alt: ${a}` })),
    ));
    return card;
  }

  /** Clay frame through this shot's first camera key, rendered by the stage even while its viewport is hidden. */
  _thumb(s) {
    if (!this.stage?.renderFrameTo || !this.stage?.previewCamera) return null;
    const k = s.camera_keys[0];
    try {
      this.stage.previewCamera({ position: k.position, target: k.target, focal_mm: k.focal_mm });
      const src = this.stage.renderFrameTo("clay", 0);
      const c = el("canvas", { class: "ss-adv-thumb", "aria-label": `Clay preview of ${s.name}` });
      c.width = 320;
      c.height = Math.max(1, Math.round(320 * src.height / src.width));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c;
    } catch {
      return null;
    } finally {
      try { this.stage.previewCamera(null); } catch {}
    }
  }
}

export default AdvisorPanel;
