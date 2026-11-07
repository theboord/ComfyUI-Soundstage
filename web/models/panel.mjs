// Model downloader panel: get the App's model files from Hugging Face without a terminal (docs/models.md).
//
// Opened from the project menu ("Models…") and from a "Get these models…" button this module adds to the
// missing-model notice. Pure logic lives in plan.mjs. The server (soundstage/modeldl) does all the fetching; the
// browser only ever sends catalog ids, and the Hugging Face token goes up once and never comes back.

import {
  fmtBytes, stateFor, stateLabel, groupItems, defaultSelection, selectionTotals, footerLine, licencesFor, canConfirm,
  idsForMissing, stepsFor, progressLine, FAIL_TEXT, HF_TOKENS_URL, offlineStatus, offlineSteps, OFFLINE_TEXT,
} from "./plan.mjs";

const CATALOG_URL = new URL("./catalog.json", import.meta.url);

const CSS = `
#ss-models{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
#ss-models .box{width:min(720px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;
background:#1c1a22;color:#ece9f2;border:1px solid #3a3644;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);
font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
#ss-models header,#ss-models footer{padding:12px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#ss-models header{border-bottom:1px solid #3a3644}#ss-models footer{border-top:1px solid #3a3644}
#ss-models h2{margin:0;font-size:15px;flex:1}
#ss-models .body{overflow:auto;padding:10px 14px;flex:1;min-height:0}
#ss-models .hf{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
#ss-models input[type=password]{flex:1;min-width:160px;background:#121017;color:#ece9f2;border:1px solid #3a3644;border-radius:6px;padding:5px 8px}
#ss-models button{background:#2a2633;color:#ece9f2;border:1px solid #3a3644;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
#ss-models button.pri{background:#4b6cf0;border-color:#4b6cf0}#ss-models button:disabled{opacity:.45;cursor:default}
#ss-models .x{background:none;border:none;font-size:18px;padding:2px 6px}
#ss-models .grp{border:1px solid #2f2b38;border-radius:8px;margin:8px 0;padding:6px 8px}
#ss-models .grp>label{font-weight:600;display:flex;gap:6px;align-items:center}
#ss-models .grp small{color:#b9b3c7;font-weight:400}
#ss-models .row{display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center;padding:4px 0 4px 18px}
#ss-models .row>*{min-width:0;overflow-wrap:anywhere}
#ss-models .chips{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
#ss-models .chip{font-size:11px;border-radius:999px;padding:1px 7px;background:#2a2633;color:#b9b3c7;max-width:100%}
#ss-models .chip.installed,#ss-models .chip.other_build{background:#1f3a2a;color:#9fe0b5}
#ss-models .chip.partial{background:#3a331f;color:#f0d58a}#ss-models .chip.missing{background:#3a2323;color:#ffb4a8}
#ss-models .steps{grid-column:2/4;color:#ffd7a8;font-size:12px}#ss-models .steps a,#ss-models a{color:#9cc8ff}
#ss-models .prog{width:100%}#ss-models progress{width:100%}
#ss-models .geo{color:#ff8b7a}#ss-models .muted{color:#b9b3c7}#ss-models .fail{color:#ffb4a8}
#ss-models .offline{margin-bottom:10px;padding:8px 10px;border-radius:8px;background:#2a2633;color:#ffd7a8}
#ss-models .chip.unknown{background:#2a2633;color:#b9b3c7}
#ss-models .lic{margin:8px 0;display:flex;gap:8px;align-items:flex-start}
@media (max-width:520px){#ss-models .row{grid-template-columns:auto 1fr}#ss-models .chips{grid-column:2;justify-content:flex-start}}
`;

let API = null;
const call = async (path, body) => {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = API?.fetchApi ? await API.fetchApi(path, opts) : await fetch("api" + path, opts);
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
};

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener", textContent: text });

class ModelsPanel {
  constructor({ missing = [] } = {}) {
    this.missing = missing;
    this.sel = new Set();
    this.access = {};
    this.status = null;
    this.timer = null;
    this.note = "";
  }

  async open() {
    if (!document.getElementById("ss-models-css")) document.head.append(el("style", { id: "ss-models-css", textContent: CSS }));
    document.getElementById("ss-models")?.remove();
    this.root = el("div", { id: "ss-models" });
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Models");
    this.box = el("div", { className: "box" });
    this.root.append(this.box);
    this.root.addEventListener("pointerdown", (e) => { if (e.target === this.root) this.close(); });
    this.onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); } };
    document.addEventListener("keydown", this.onKey, true);
    document.body.append(this.root);
    this.box.append(el("div", { className: "body", textContent: "Loading…" }));
    await this.refresh(true);
  }

  close() {
    clearTimeout(this.timer);
    document.removeEventListener("keydown", this.onKey, true);
    this.root?.remove();
  }

  async refresh(first = false) {
    try { this.status = await call("/soundstage/models/status"); } catch (e) {
      // No server (the try-it demo, or ComfyUI is down): show the catalog read-only rather than a dead end.
      try {
        const r = await fetch(CATALOG_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.status = offlineStatus(await r.json());
        this.sel = new Set();
        this.render();
      } catch {
        this.box.replaceChildren(el("div", { className: "body fail", textContent: `Couldn't load the model list: ${e.message}` }));
      }
      return;
    }
    if (first) {
      const fromNotice = idsForMissing(this.missing, this.status.items).ids;
      this.sel = new Set(fromNotice.length ? fromNotice : defaultSelection(this.status));
    }
    this.render();
    if (this.status.busy) this.poll();
  }

  render() {
    const s = this.status;
    const head = el("header", {}, el("h2", { textContent: "Models" }),
      el("button", { className: "x", textContent: "×", title: "Close", onclick: () => this.close() }));
    head.lastChild.setAttribute("aria-label", "Close");
    const body = el("div", { className: "body" }, this.hfBox(), ...groupItems(s).map((g) => this.groupCard(g)));
    if (this.note) body.prepend(el("div", { className: "muted", textContent: this.note }));
    if (s.offline) body.prepend(el("div", { className: "offline", textContent: OFFLINE_TEXT }));
    this.progEl = el("div", { className: "prog" });
    const t = selectionTotals(s.items, [...this.sel]);
    const freeV = Object.values(s.free_bytes || {}).filter((v) => v != null);
    const free = freeV.length ? `${fmtBytes(Math.max(...freeV))} free` : "";
    this.dlBtn = el("button", { className: "pri", textContent: s.offline ? "Download needs ComfyUI" : footerLine(t),
      disabled: s.offline || !t.count || s.busy, onclick: () => this.confirm() });
    const foot = el("footer", {}, this.progEl, this.dlBtn, el("span", { className: "muted", textContent: free }));
    this.box.replaceChildren(head, body, foot);
    this.renderProgress();
  }

  hfBox() {
    const s = this.status;
    const box = el("div", { className: "hf" });
    if (s.offline) {
      box.append(el("span", { className: "muted" }, "Models marked 🔒 need a Hugging Face sign-in and licence acceptance: ",
        link(HF_TOKENS_URL, "make a read token ↗")));
      return box;
    }
    if (s.signed_in) {
      const who = s.token_source === "saved"
        ? `Hugging Face: signed in${s.user ? ` as ${s.user}` : ""} (saved on this computer)`
        : s.token_source === "environment" ? "Hugging Face: using the HF_TOKEN set for ComfyUI" : "Hugging Face: using your huggingface-cli login";
      box.append(el("span", { textContent: who }));
      if (s.token_source === "saved") box.append(el("button", { textContent: "Remove token", onclick: () => this.removeToken() }));
      return box;
    }
    const inp = el("input", { placeholder: "Hugging Face token (hf_…)" });
    inp.type = "password";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.setAttribute("aria-label", "Hugging Face token");
    this.tokenInput = inp;
    const msg = el("span", { className: "fail" });
    const save = el("button", { textContent: "Save", onclick: async () => {
      save.disabled = true;
      try { await call("/soundstage/models/token", { token: inp.value }); inp.value = ""; this.access = {}; await this.refresh(); }
      catch (e) { msg.textContent = e.message; save.disabled = false; }
    } });
    box.append(el("span", { textContent: "Some models need a Hugging Face sign-in." }), inp, save,
      el("span", { className: "muted" }, link(HF_TOKENS_URL, "Make a token"), " (read access is enough)"), msg);
    return box;
  }

  async removeToken() {
    try { await call("/soundstage/models/token/remove", {}); } catch { /* shown by refresh */ }
    this.access = {};
    await this.refresh();
  }

  groupCard({ group, items }) {
    const files = this.status.installed_files;
    const fetchable = items.filter((it) => !["installed", "other_build"].includes(stateFor(it, files).state));
    const all = el("input", { type: "checkbox" });
    all.checked = fetchable.length > 0 && fetchable.every((it) => this.sel.has(it.id));
    all.disabled = !fetchable.length || !!this.status.offline;
    all.onchange = () => { for (const it of fetchable) all.checked ? this.sel.add(it.id) : this.sel.delete(it.id); this.render(); };
    const card = el("div", { className: "grp" },
      el("label", {}, all, group.title, el("small", { textContent: group.needed_for ? ` · for ${group.needed_for}` : "" })));
    for (const it of items) card.append(this.row(it));
    return card;
  }

  row(it) {
    const st = stateFor(it, this.status.installed_files);
    const cb = el("input", { type: "checkbox" });
    cb.checked = this.sel.has(it.id);
    cb.disabled = st.state === "installed" || !!this.status.offline;
    cb.onchange = () => { cb.checked ? this.sel.add(it.id) : this.sel.delete(it.id); this.render(); };
    cb.setAttribute("aria-label", it.title);
    const name = el("label", {}, (it.gated ? "🔒 " : "") + it.title + (it.optional ? " (optional)" : ""),
      el("span", { className: "muted", textContent: ` · ${fmtBytes(it.size)}` }));
    if (it.gated) name.title = "Gated on Hugging Face: sign in and accept the licence first";
    const lic = (it.licences || []).map((k) => this.status.licences[k]?.name || k).join(" + ");
    const chips = el("span", { className: "chips" }, el("span", { className: `chip ${st.state}`, textContent: stateLabel(st) }),
      el("span", { className: "chip", textContent: lic }));
    const row = el("div", { className: "row" }, cb, name, chips);
    const steps = this.status.offline ? offlineSteps(it) : stepsFor(it, this.access[it.id] || "ok", this.status.signed_in);
    if (steps.length) {
      const st2 = el("div", { className: "steps" });
      steps.forEach((s, n) => {
        if (n) st2.append(" → ");
        if (s.text === "Check again") st2.append(el("button", { textContent: "Check again", onclick: () => this.checkAccess([it.id], true) }));
        else st2.append(s.href ? link(s.href, s.text + " ↗") : s.text);
      });
      row.append(st2);
    }
    const fail = (this.prog?.failed || []).filter((f) => f.id === it.id).at(-1);
    if (fail && st.state !== "installed") row.append(el("div", { className: "steps fail", textContent: fail.message || FAIL_TEXT[fail.code] || fail.code }));
    return row;
  }

  async checkAccess(ids, recheck = false) {
    const r = await call("/soundstage/models/access", { ids, recheck });
    Object.assign(this.access, r.results);
    this.render();
    return r.results;
  }

  /** One confirm for the whole selection: every licence listed, each ticked, then access check, then queue. */
  confirm() {
    const s = this.status;
    const ids = [...this.sel].filter((i) => !["installed", "other_build"].includes(stateFor(s.items.find((x) => x.id === i) || {}, s.installed_files).state));
    const lines = licencesFor(s.items, ids, s.licences);
    const ticked = new Set();
    const go = el("button", { className: "pri", textContent: footerLine(selectionTotals(s.items, ids)), disabled: true });
    const list = lines.map((l) => {
      const cb = el("input", { type: "checkbox" });
      cb.onchange = () => { cb.checked ? ticked.add(l.key) : ticked.delete(l.key); go.disabled = !canConfirm(lines, [...ticked]); };
      return el("label", { className: "lic" }, cb, el("span", {},
        el("b", { textContent: l.name }), l.limit ? ` · ${l.limit}` : "", " · ", link(l.url, "read it ↗"),
        l.geo ? el("div", { className: "geo", textContent: l.geo }) : null,
        el("div", { className: "muted", textContent: "I've read it and it fits my use." })));
    });
    const back = el("button", { textContent: "Back", onclick: () => this.render() });
    go.onclick = async () => {
      go.disabled = true;
      const res = await this.checkAccess(ids).catch(() => ({}));
      const ok = ids.filter((i) => res[i] === "ok");
      if (ids.some((i) => res[i] === "sign_in")) this.tokenInput?.focus();
      if (ok.length) {
        try {
          const q = await call("/soundstage/models/download", { ids: ok, confirm: true, accepted_licences: [...ticked] });
          this.note = q.queued.length ? `Downloading ${q.queued.length} file${q.queued.length === 1 ? "" : "s"}.` : "Nothing new to download.";
        } catch (e) { this.note = `Couldn't start: ${e.message}`; }
        await this.refresh();
      }
    };
    this.box.replaceChildren(
      el("header", {}, el("h2", { textContent: "Licences for these models" })),
      el("div", { className: "body" }, el("p", { className: "muted",
        textContent: "Each model has its own licence. Read each one and tick it if it fits how you'll use the results." }), ...list),
      el("footer", {}, back, go));
  }

  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.root?.isConnected) return;
      try { this.prog = await call("/soundstage/models/progress"); } catch { this.prog = null; }
      const before = this.doneCount ?? 0;
      const doneNow = (this.prog?.done || []).length + (this.prog?.failed || []).length;
      this.doneCount = doneNow;
      const busy = !!(this.prog?.current || this.prog?.queue?.length);
      if (doneNow !== before || !busy) {
        if (!busy && (this.prog?.done || []).length) this.note = "Done. Reload the workflow so the loaders see the new files.";
        await this.refresh();
      } else this.renderProgress();
      if (busy) this.poll();
    }, 1000);
  }

  renderProgress() {
    if (!this.progEl) return;
    const cur = this.prog?.current;
    if (!cur) { this.progEl.replaceChildren(); return; }
    const it = this.status.items.find((x) => x.id === cur.id);
    const bar = el("progress", { max: cur.total || 1, value: cur.bytes || 0 });
    const cancel = el("button", { textContent: "Cancel", title: "Stop; the part downloaded so far is kept and resumes next time",
      onclick: () => call("/soundstage/models/cancel", { all: true }).catch(() => {}) });
    this.progEl.replaceChildren(el("div", { textContent: progressLine(cur, it?.title) }), bar, cancel);
  }
}

/** Open the panel. opts: { api, missing: [file names from the missing-model notice] }. */
export function openModels(opts = {}) {
  if (opts.api) API = opts.api;
  const p = new ModelsPanel(opts);
  p.open();
  return p;
}

/** Add "Get these models…" to the missing-model notice (web/ui/modelguard.mjs draws it; this only appends). */
export function addNoticeButton(plan, api, doc = globalThis.document) {
  if (api) API = api;
  const box = doc?.getElementById?.("ss-model-notice");
  const missing = (plan?.missing || []).map((m) => m.value);
  if (!box || !missing.length || box.querySelector(".ss-get-models")) return null;
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "ss-get-models";
  b.textContent = "Get these models…";
  b.style.cssText = "position:static;margin-top:8px;background:#4b6cf0;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:13px;cursor:pointer";
  b.onclick = () => openModels({ missing });
  box.append(b);
  return b;
}

globalThis.__ssOpenModels = openModels;
globalThis.__ssModelsNotice = addNoticeButton;
