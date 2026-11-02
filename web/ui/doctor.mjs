// Tools ▾ › Check my setup: the Soundstage doctor's report (soundstage/doctor.py, GET /soundstage/doctor) in a
// dialog. doctorView() is pure (tests/js/doctor.test.mjs); openDoctor() draws it.

export const DOCTOR_ROUTE = "/soundstage/doctor";

const MARK = { ok: "✓", ready: "✓", fits: "✓", other_build: "✓", missing: "✗", "not ready": "✗", incomplete: "✗",
  partial: "✗", no: "✗", unknown: "?", untested: "~" };
const TONE = { ok: "ok", ready: "ok", fits: "ok", other_build: "ok", untested: "warn", unknown: "warn" };
export const markOf = (s) => MARK[s] || "?";
export const toneOf = (s) => TONE[s] || "bad";

/** The report as sections of plain lines: {headline, ready, steps, optional, features, packs, deps, foot}. */
export function doctorView(r) {
  const gpu = r.gpu || {};
  const vram = gpu.vram_gb ? `, ${gpu.vram_gb} GB` : "";
  const req = (r.steps || []).filter((s) => s.required);
  const opt = (r.steps || []).filter((s) => !s.required);
  const headline = req.length
    ? `Not ready yet: ${req.length} thing${req.length === 1 ? "" : "s"} to do, then restart ComfyUI and check again.`
    : "Ready: the required node packs, Python packages and the default models (Frame and Motion) are here.";
  const features = (r.features || []).map((f) => ({
    mark: markOf(f.status), tone: toneOf(f.status), name: f.name + (f.default ? "" : " (optional)"),
    status: f.status, vram: f.vram_words, vramTone: toneOf(f.vram),
    files: (f.files || []).filter((x) => x.status !== "ok").map((x) => {
      const name = x.is_dir ? x.source : x.want;
      if (x.status === "other_build") return { tone: "ok", text: `using ${x.found} (another build of ${x.want}; fine)` };
      if (x.status === "unknown") return { tone: "warn", text: `${name}: could not see models/${x.folder}/` };
      const why = x.status === "incomplete" ? " (incomplete download)" : "";
      return { tone: "bad", text: `${name}${why} → models/${x.folder}/${x.size ? ` · ${x.size}` : ""}`, url: x.url };
    }),
  }));
  const packs = (r.packs || []).map((p) => ({
    mark: markOf(p.status), tone: toneOf(p.status), url: p.url,
    text: `${p.name} [${p.required ? "required" : "optional"}]: ${p.status}`
      + (p.status === "partial" && p.missing?.length ? ` (missing ${p.missing.join(", ")})` : ""),
  }));
  const depsUnknown = (r.deps || []).some((d) => d.status === "unknown");
  const deps = depsUnknown ? [] : (r.deps || []).map((d) => ({
    mark: markOf(d.status), tone: d.status === "ok" ? "ok" : d.required ? "bad" : "warn",
    text: `${d.pip}${d.required ? "" : " (optional)"}: ${d.status} · ${d.why}`,
  }));
  return {
    headline, ready: !req.length,
    where: `Looked ${r.mode || "?"} · ComfyUI ${r.comfyui_version || "version unknown"} (tested on ${r.tested_comfyui || "?"}) · `
      + `GPU: ${gpu.name || "unknown"}${vram}`,
    steps: req.map((s) => ({ text: s.text, url: s.url || "" })),
    optional: opt.map((s) => ({ text: s.text, url: s.url || "" })),
    features, packs, deps,
    depsNote: depsUnknown ? "Python packages: not checked from here." : `Python packages (${r.python || "ComfyUI's Python"})`,
    foot: { text: "Where to get every model, with licenses: MODELS.md", url: r.models_doc || "" },
  };
}

const CSS = `#ss-doctor{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;
background:rgba(10,8,14,.55);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
#ss-doctor .box{position:relative;background:#1c1a22;color:#ece9f2;border:1px solid #3a3644;border-radius:12px;
width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;padding:16px 18px;
box-shadow:0 10px 30px rgba(0,0,0,.45)}
#ss-doctor h2{font-size:15px;margin:0 28px 4px 0}#ss-doctor h3{font-size:12px;letter-spacing:.03em;color:#b9b3c7;
margin:14px 0 4px;font-weight:600;text-transform:uppercase}
#ss-doctor .where{color:#b9b3c7;font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}
#ss-doctor .head{font-weight:600;margin:6px 0}#ss-doctor .head.ok{color:#9be3a8}#ss-doctor .head.bad{color:#ffb4a8}
#ss-doctor ol,#ss-doctor ul{margin:0;padding:0 0 0 20px}#ss-doctor li{margin:3px 0;overflow-wrap:anywhere}
#ss-doctor .ok{color:#9be3a8}#ss-doctor .warn{color:#f3d58a}#ss-doctor .bad{color:#ffb4a8}
#ss-doctor .sub{color:#cfc9da;font-size:12px}#ss-doctor a{color:#9cc8ff}
#ss-doctor .x{position:absolute;top:8px;right:10px;background:none;border:none;color:#b9b3c7;font-size:18px;cursor:pointer}
#ss-doctor .row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
#ss-doctor .row button{background:#2c2836;color:#ece9f2;border:1px solid #4a4556;border-radius:8px;padding:5px 10px;cursor:pointer}`;

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function link(doc, url, text = "link") {
  const a = el(doc, "a", null, text);
  a.href = url; a.target = "_blank"; a.rel = "noopener";
  return a;
}

function stepList(doc, tag, steps) {
  const ol = el(doc, tag);
  for (const s of steps) {
    const li = el(doc, "li", null, s.text);
    if (s.url) li.append(" ", link(doc, s.url, "open"));
    ol.append(li);
  }
  return ol;
}

/** Draw the report (or a message) into the dialog body. */
export function renderDoctor(body, r, doc = globalThis.document) {
  body.replaceChildren();
  const v = doctorView(r);
  body.append(el(doc, "div", "where", v.where), el(doc, "div", `head ${v.ready ? "ok" : "bad"}`, v.headline));
  if (v.steps.length) body.append(stepList(doc, "ol", v.steps));
  body.append(el(doc, "h3", null, "What works on this setup"));
  const fl = el(doc, "ul");
  for (const f of v.features) {
    const li = el(doc, "li");
    li.append(el(doc, "span", f.tone, `${f.mark} ${f.name}: ${f.status}`), " · ", el(doc, "span", f.vramTone, f.vram));
    if (f.files.length) {
      const ul = el(doc, "ul", "sub");
      for (const x of f.files) {
        const fi = el(doc, "li", x.tone, x.text);
        if (x.url) fi.append(" ", link(doc, x.url, "get it"));
        ul.append(fi);
      }
      li.append(ul);
    }
    fl.append(li);
  }
  body.append(fl, el(doc, "h3", null, "Node packs"));
  const pl = el(doc, "ul");
  for (const p of v.packs) {
    const li = el(doc, "li", p.tone, `${p.mark} ${p.text}`);
    if (p.url) li.append(" ", link(doc, p.url, "repo"));
    pl.append(li);
  }
  body.append(pl, el(doc, "h3", null, v.depsNote));
  if (v.deps.length) {
    const dl = el(doc, "ul");
    for (const d of v.deps) dl.append(el(doc, "li", d.tone, `${d.mark} ${d.text}`));
    body.append(dl);
  }
  if (v.optional.length) body.append(el(doc, "h3", null, "Optional extras"), stepList(doc, "ul", v.optional));
  const foot = el(doc, "div", "sub");
  foot.style.marginTop = "12px";
  foot.append(v.foot.text.replace(": MODELS.md", ": "), v.foot.url ? link(doc, v.foot.url, "MODELS.md") : "MODELS.md");
  body.append(foot);
  return v;
}

/**
 * Open the dialog and run the check. fetchApi is ComfyUI's api.fetchApi (or fetch). Resolves with the report, or
 * null when the server has no doctor route yet (ComfyUI started before this version of Soundstage was installed).
 */
export async function openDoctor({ fetchApi, doc = globalThis.document } = {}) {
  if (!doc) return null;
  doc.getElementById("ss-doctor")?.remove();
  if (!doc.getElementById("ss-doctor-css")) {
    const css = el(doc, "style");
    css.id = "ss-doctor-css";
    css.textContent = CSS;
    doc.head.append(css);
  }
  const wrap = el(doc, "div");
  wrap.id = "ss-doctor";
  const box = el(doc, "div", "box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Check my setup");
  const x = el(doc, "button", "x", "×");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  const body = el(doc, "div", null, "Checking node packs, model files, VRAM and Python packages…");
  const row = el(doc, "div", "row");
  const again = el(doc, "button", null, "Check again");
  const copy = el(doc, "button", null, "Copy report");
  again.type = copy.type = "button";
  row.append(again, copy);
  box.append(x, el(doc, "h2", null, "Check my setup"), body, row);
  wrap.append(box);
  const close = () => { wrap.remove(); doc.removeEventListener?.("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation?.(); close(); } };
  x.addEventListener("click", close);
  wrap.addEventListener("pointerdown", (e) => { e.stopPropagation?.(); if (e.target === wrap) close(); });
  doc.addEventListener?.("keydown", onKey, true);
  doc.body.append(wrap);

  let last = null;
  const run = async () => {
    body.replaceChildren(el(doc, "div", null, "Checking node packs, model files, VRAM and Python packages…"));
    try {
      const res = await fetchApi(DOCTOR_ROUTE);
      if (!res.ok) {
        let said = "";
        try { said = (await res.json())?.error || ""; } catch { /* not JSON */ }
        body.replaceChildren(el(doc, "div", "bad", res.status === 404
          ? "This ComfyUI has no setup check yet: restart ComfyUI so it loads this version of Soundstage, then try again."
          : said || `The check failed (HTTP ${res.status}). The ComfyUI console says why.`));
        return null;
      }
      last = await res.json();
      renderDoctor(body, last, doc);
      return last;
    } catch (e) {
      body.replaceChildren(el(doc, "div", "bad", `Could not reach ComfyUI: ${e?.message || e}`));
      return null;
    }
  };
  again.addEventListener("click", () => { run(); });
  copy.addEventListener("click", async () => {
    if (!last?.text) return;
    try { await globalThis.navigator?.clipboard?.writeText(last.text); copy.textContent = "Copied"; }
    catch { copy.textContent = "Copy failed"; }
  });
  return run();
}
