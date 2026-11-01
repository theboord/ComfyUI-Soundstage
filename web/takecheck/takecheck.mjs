// Takes that check themselves, plus trust signals (Milestone 16). One call from web/soundstage.js wires it all:
//
//   const tc = attachTakeChecks({ app, api, stage, ladder, pipeline, look, restoreScene, say });
//
//   ⑥ Ladder    after every draft or final lands, the take is checked on the CPU (POST /soundstage/takecheck) and its
//               chips show under the Ladder's bar: "✓ clean", "⚠ freeze 2.1–2.6 s", "⚠ Sports car faces the wrong way",
//               plus "Follows blocking 87%" (hover: per actor and the camera). A click on a chip jumps the Ladder
//               there. Re-roll (new seed) asks before it spends GPU; Measure queues the SAM 3.1 actor pass.
//   Dailies     tc.decorate(el, take) puts the same verdict on take cards and rows (web/dailies/bin.mjs hook).
//   Step bar    a "Ready" / "Needs 2" chip on every step (what's missing, where it goes, MODELS.md).
//   Run         "$0 · about 2 min on your GPU" under ④ Generate and ⑤ Draft / Final, from measured render times.
//   Recipe      tc.maybeRestore(file): a Soundstage MP4 dropped on the stage restores its set and shot.
// The pure parts (chips, scores, estimates, readiness, the MP4 tag reader) are in model.mjs.
import { takeChips, blockingChip, fileOfUrl, annotated, estimateLabel, estimateSeconds, finalRung, readiness, readinessChip,
  readFileTags, recipeFromTags, recipeLine, MODELS_DOC_URL } from "./model.mjs";
import { loaderWidgets, allNodes } from "../ui/modelguard.mjs";
import { planModelFixes } from "../ui/modelmatch.mjs";

const CSS = `
.ss-tc-strip{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:0 0 8px;font-size:var(--ss-fs-sm,12px);color:var(--ss-muted,rgba(240,239,237,.68))}
.ss-tc-strip:empty{display:none}
.ss-tc-take{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center}
.ss-tc-take>.lab{font-size:var(--ss-fs-xs,11px);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-right:2px}
.ss-tc-chip{font:inherit;font-size:var(--ss-fs-xs,11px);line-height:1.2;border-radius:999px;padding:3px 9px;border:1px solid var(--ss-line-strong,rgba(255,255,255,.16));
  background:var(--ss-card,rgba(255,255,255,.04));color:var(--ss-text,#f0efed);white-space:nowrap;cursor:default}
button.ss-tc-chip{cursor:pointer}button.ss-tc-chip:hover{background:var(--ss-hover,#342c3b)}
.ss-tc-chip[data-tone=ok]{border-color:rgba(126,226,168,.45)!important;color:var(--ss-success,#7ee2a8)!important}
.ss-tc-chip[data-tone=warn]{border-color:rgba(255,196,92,.55)!important;color:#ffcf73!important}
.ss-tc-chip[data-tone=bad]{border-color:rgba(255,122,122,.65)!important;color:var(--ss-danger,#ff7a7a)!important;background:rgba(255,122,122,.1)!important}
.ss-tc-chip[data-tone=info]{color:var(--ss-muted,rgba(240,239,237,.68))!important}
.ss-tc-act{font:inherit;font-size:var(--ss-fs-xs,11px);border-radius:999px;padding:3px 10px;cursor:pointer;border:1px solid var(--ss-accent-line,rgba(242,255,89,.42));
  background:var(--ss-accent-soft,rgba(242,255,89,.1));color:var(--ss-accent,#f2ff59);font-weight:600}
.ss-tc-act:hover{background:rgba(242,255,89,.18)}.ss-tc-act:disabled{opacity:.45;cursor:default}
.ss-tc-mini{position:absolute;left:6px;bottom:6px;display:flex;gap:3px;z-index:2;pointer-events:auto;max-width:calc(100% - 12px);flex-wrap:wrap}
.ss-tc-mini .ss-tc-chip{padding:2px 7px;background:rgba(20,15,24,.82);backdrop-filter:blur(4px)}
.ss-tc-row{display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle}
.ss-tc-row .ss-tc-chip{padding:1px 6px}
.ss-pipe button[data-step]{position:relative}
.ss-tc-ready{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;padding:0;font-size:0;line-height:0;overflow:hidden;
  background:currentColor;box-shadow:0 0 0 2px var(--ss-bg,#211927);color:var(--ss-muted,rgba(240,239,237,.68));cursor:help}
.ss-tc-ready[data-tone=ok]{color:var(--ss-success,#7ee2a8)}
.ss-tc-ready[data-tone=bad]{color:var(--ss-danger,#ff7a7a);cursor:pointer;width:auto;height:auto;font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;background:rgba(255,122,122,.18);top:2px}
.ss-tc-ready[data-tone=info]{color:#ffcf73;cursor:pointer}
.ss-tc-pop{position:fixed;z-index:100002;max-width:min(420px,calc(100vw - 24px));background:var(--ss-raised,#2a2330);color:var(--ss-text,#f0efed);
  border:1px solid var(--ss-line-strong,rgba(255,255,255,.16));border-radius:var(--ss-r-lg,14px);padding:12px 14px;box-shadow:var(--ss-shadow-pop,0 18px 48px rgba(0,0,0,.5));
  font:var(--ss-fs-sm,12px)/1.45 var(--ss-font,system-ui);white-space:pre-line}
.ss-tc-pop b{display:block;font-size:var(--ss-fs-md,13px);margin-bottom:6px}.ss-tc-pop a{color:#9cc8ff}
.ss-tc-pop .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.ss-tc-pop .row button{font:inherit;border-radius:999px;padding:5px 12px;cursor:pointer;border:1px solid var(--ss-line-strong,rgba(255,255,255,.16));background:var(--ss-card,rgba(255,255,255,.04));color:inherit}
.ss-tc-pop .row button.go{background:var(--ss-accent,#f2ff59);color:var(--ss-accent-ink,#211927);border-color:transparent;font-weight:700}
.ss-tc-modal{position:fixed;inset:0;z-index:100003;background:rgba(10,8,12,.55);display:flex;align-items:center;justify-content:center}
.ss-tc-modal .ss-tc-pop{position:static;min-width:min(380px,calc(100vw - 24px))}
button[data-ss-est]::after{content:attr(data-ss-est);display:block;font-size:var(--ss-fs-xs,11px);font-weight:500;opacity:.8;letter-spacing:0;margin-top:1px;white-space:nowrap}
button[data-ss-est]{flex-direction:column;align-items:center;justify-content:center}
`;

const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};
const stop = (e) => e.stopPropagation();

function chipEl(c, onClick) {
  const b = el(onClick ? "button" : "span", "ss-tc-chip", c.text);
  if (onClick) { b.type = "button"; b.addEventListener("pointerdown", stop); b.addEventListener("click", (e) => { e.stopPropagation(); onClick(c); }); }
  b.dataset.tone = c.tone || "info";
  if (c.title) b.title = c.title;
  return b;
}

/** A small modal: title, text, buttons. Resolves with the index of the button pressed (-1 = closed). */
export function choose(title, text, buttons) {
  return new Promise((resolve) => {
    const box = el("div", "ss-tc-pop", el("b", "", title), el("div", "", text));
    const row = el("div", "row");
    const wrap = el("div", "ss-tc-modal", box);
    const done = (i) => { wrap.remove(); resolve(i); };
    buttons.forEach((t, i) => {
      const b = el("button", i === 0 ? "go" : "", t);
      b.type = "button";
      b.addEventListener("click", () => done(i));
      row.append(b);
    });
    box.append(row);
    wrap.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === wrap) done(-1); });
    wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") done(-1); });
    document.body.append(wrap);
    row.querySelector("button")?.focus();
  });
}

let pop = null;
function showPop(anchor, title, lines, link) {
  pop?.remove();
  const box = el("div", "ss-tc-pop", el("b", "", title), el("div", "", lines.join("\n")));
  if (link) {
    const a = el("a", "", link.text);
    a.href = link.href; a.target = "_blank"; a.rel = "noopener";
    box.append(el("div", "", "Where to get them: ", a));
  }
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(12, Math.min(window.innerWidth - box.offsetWidth - 12, r.left))}px`;
  box.style.top = `${Math.min(window.innerHeight - box.offsetHeight - 12, r.bottom + 6)}px`;
  pop = box;
  const close = (e) => { if (!box.contains(e.target)) { box.remove(); if (pop === box) pop = null; document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  box.addEventListener("pointerdown", stop);
}

export function attachTakeChecks(ctx) {
  const { api, app, ladder, pipeline } = ctx;
  if (!document.getElementById("ss-tc-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-tc-css", textContent: CSS }));
  const say = (m) => { try { ctx.say?.(m); } catch { /* no status line */ } };
  const results = new Map();      // "sub/file" -> {res, p}
  const watchers = new Map();     // "sub/file" -> Set of render functions (Dailies cards, the Ladder strip)
  const measuring = new Map();    // prompt id -> file
  let timing = null;
  const keyOf = (f) => `${f.subfolder || ""}/${f.filename}`;

  const notify = (k) => { for (const fn of [...(watchers.get(k) || [])]) { try { if (fn() === false) watchers.get(k).delete(fn); } catch { /* gone */ } } };

  /** The checks of one take (cached here and on the server). */
  function check(file, { force = false } = {}) {
    if (!file?.filename) return Promise.resolve(null);
    const k = keyOf(file);
    const have = results.get(k);
    if (have && !force && (have.p || have.res)) return have.p || Promise.resolve(have.res);
    const p = api.fetchApi("/soundstage/takecheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, force }) })
      .then((r) => r.json()).catch((e) => ({ error: e.message }))
      .then((res) => { results.set(k, { res }); notify(k); return res; });
    results.set(k, { res: have?.res || null, p });
    notify(k);
    return p;
  }
  const watch = (file, fn) => { const k = keyOf(file); if (!watchers.has(k)) watchers.set(k, new Set()); watchers.get(k).add(fn); };

  // ------------------------------------------------------------------ Ladder strip
  const strip = el("div", "ss-tc-strip");
  strip.addEventListener("pointerdown", stop);
  try { ladder.bar.after(strip); } catch { /* ladder not built */ }
  const RUNGS = [[3, "Draft"], [4, "Final"]];
  const fps = () => ctx.stage?.state?.shot?.fps || 24;

  function renderStrip() {
    const parts = [];
    for (const [rung, name] of RUNGS) {
      const src = ladder.sources?.[rung];
      if (!src || src.kind !== "video") continue;
      const file = fileOfUrl(src.url);
      if (!file) continue;
      const res = results.get(keyOf(file))?.res;
      const g = el("span", "ss-tc-take", el("span", "lab", name));
      for (const c of takeChips(res)) {
        g.append(chipEl(c, c.start != null ? () => { try { ladder.setFrame(Math.round(c.start * fps())); } catch { /* */ } } : null));
      }
      const bc = blockingChip(res?.blocking);
      if (bc) g.append(chipEl(bc, () => showPop(g, `Follows your blocking · ${name}`, bc.title.split("\n"))));
      if (bc?.action === "measure") g.append(actBtn("Measure", "Measure the actors: SAM 3.1 tracks them in the take (about 20 s of GPU, queued)", (b) => measure(file, b)));
      if (res && !res.error && res.verdict !== "clean") g.append(actBtn("Re-roll", "Render this shot again with a new seed (asks first: it uses your GPU)", () => reroll(rung)));
      parts.push(g);
    }
    strip.replaceChildren(...parts);
  }
  function actBtn(text, title, fn) {
    const b = el("button", "ss-tc-act", text);
    b.type = "button"; b.title = title;
    b.addEventListener("pointerdown", stop);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
    return b;
  }
  function onLadderSource(rung, kind, url) {
    if (kind !== "video" || !(rung === 3 || rung === 4)) return;
    const file = fileOfUrl(url);
    if (!file || file.type !== "output") { renderStrip(); return; }
    watch(file, () => { renderStrip(); return true; });
    check(file);
    renderStrip();
  }
  if (ladder && !ladder._ssTakeChecks) {
    ladder._ssTakeChecks = true;
    const set = ladder.setSource.bind(ladder), clear = ladder.clearSource.bind(ladder);
    ladder.setSource = (rung, kind, url) => { const r = set(rung, kind, url); try { onLadderSource(rung, kind, url); } catch { /* never block the Ladder */ } return r; };
    ladder.clearSource = (rung) => { const r = clear(rung); try { renderStrip(); } catch { /* */ } return r; };
    for (const [rung] of RUNGS) { const s = ladder.sources?.[rung]; if (s?.kind === "video") onLadderSource(rung, "video", s.url); }
  }

  // ------------------------------------------------------------------ Re-roll and Measure
  const frames = () => ctx.stage?.state?.shot?.frames || ctx.stage?.toJSON?.().shot?.frames || 121;
  async function reroll(rung) {
    const kind = rung === 4 ? "final" : "draft";
    const r = rung === 4 ? finalRung(pipeline?.m?.quality) : "draft";
    const est = estimateLabel(estimateSeconds(timing, r, frames()));
    const shot = ctx.stage?.activeShot?.()?.name || "this shot";
    const pick = await choose(`Re-roll the ${kind}?`, `${shot}: the same set, shot and settings with a new seed. It queues one ${kind} on your GPU (${est}).`, [`Re-roll ${kind}`, "Cancel"]);
    if (pick !== 0) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    for (const id of [9091, 9083, 5516, 9034]) {
      for (const w of pipeline?.node?.(id)?.widgets || []) {
        if (/seed/i.test(w.name) && typeof w.value === "number") { w.value = seed; try { w.callback?.(seed); } catch { /* */ } }
      }
    }
    say(`Re-rolling the ${kind} of ${shot} with seed ${seed} (${est}).`);
    try { await pipeline._render(rung); } catch (e) { say(`Couldn't queue the re-roll: ${e.message}`); }
  }

  async function measure(file, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Measuring…"; }
    try {
      const body = { client_id: api.clientId, prompt: { ss_blocking: { class_type: "SoundstageBlockingScore", inputs: { video: annotated(file), samples: 32 } } } };
      const r = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.prompt_id) throw new Error(j?.error?.message || (j?.node_errors ? "the Blocking Score node isn't available" : "could not queue"));
      measuring.set(j.prompt_id, file);
      say("Measuring the actors with SAM 3.1 (queued, about 20 s of GPU)…");
    } catch (e) {
      say(`Couldn't measure the blocking: ${e.message}`);
      if (btn) { btn.disabled = false; btn.textContent = "Measure"; }
    }
  }
  const settled = (ev) => {
    const pid = ev.detail?.prompt_id;
    if (measuring.has(pid)) {
      const f = measuring.get(pid);
      measuring.delete(pid);
      results.delete(keyOf(f));
      check(f).then((res) => { const b = res?.blocking; say(b?.score != null ? `Blocking measured: ${Math.round(b.score * 100)}% (${b.basis}).` : "Blocking: can't tell from this take."); });
    }
  };
  for (const t of ["execution_success", "execution_error"]) api?.addEventListener?.(t, settled);

  // ------------------------------------------------------------------ Dailies
  /** Put a take's verdict on a Dailies card thumb ("card") or a takes row ("row"). */
  function decorate(host, take, _shot, where = "card") {
    if (!host || !take?.video || !["draft", "final"].includes(take.kind)) return;
    const file = fileOfUrl(take.url);
    if (!file || file.type !== "output") return;
    const box = el("span", where === "card" ? "ss-tc-mini" : "ss-tc-row");
    box.addEventListener("pointerdown", stop);
    host.append(box);
    const draw = () => {
      if (!box.isConnected && box._drawn) return false;
      box._drawn = true;
      const res = results.get(keyOf(file))?.res;
      const chips = takeChips(res);
      const first = chips.find((c) => c.tone === "bad") || chips[0];
      const kids = first ? [chipEl({ ...first, title: chips.map((c) => c.title || c.text).join("\n") })] : [];
      const bc = blockingChip(res?.blocking);
      if (bc && where === "card") kids.push(chipEl({ ...bc, text: bc.text.replace("Follows blocking ", "Blocking ") }));
      box.replaceChildren(...kids);
      return true;
    };
    watch(file, draw);
    draw();
    check(file);
  }

  // ------------------------------------------------------------------ Run estimates
  function setEst(btn, seconds, what) {
    if (!btn) return;
    const label = estimateLabel(seconds);
    if (!label) { delete btn.dataset.ssEst; return; }
    btn.dataset.ssEst = label;
    btn.setAttribute("aria-description", `${what}: ${label}. Local open models cost no credits.`);
  }
  function applyEstimates() {
    const f = pipeline?.f, m = pipeline?.m;
    const n = frames();
    let shots = 1;
    try { shots = Math.max(1, pipeline.shots().length); } catch { /* */ }
    const h3 = /MiniMax H3/.test(m?.engine?.value || "");
    const fin = h3 ? 1500 : estimateSeconds(timing, finalRung(m?.quality), n);
    setEst(f?.goBtn, estimateSeconds(timing, "frame", 1, f?.count || 4), "Generate frames");
    setEst(f?.allBtn, estimateSeconds(timing, "frame", 1, (f?.count || 4) * shots), "Frames for every shot");
    setEst(m?.draftBtn, estimateSeconds(timing, "draft", n), "Draft");
    setEst(m?.finalBtn, fin, "Final");
    setEst(m?.allDraft, estimateSeconds(timing, "draft", n) * shots, "Draft every shot");
    setEst(m?.allFinal, fin * shots, "Final for every shot");
  }
  async function refreshEstimates() {
    try { timing = await (await api.fetchApi("/soundstage/takecheck/timing")).json(); } catch { /* defaults */ }
    applyEstimates();
  }
  for (const seg of [pipeline?.m?.qSeg, pipeline?.f?.countSeg]) seg?.addEventListener("click", () => setTimeout(applyEstimates, 0));
  pipeline?.m?.engine?.addEventListener("change", () => setTimeout(applyEstimates, 0));
  api?.addEventListener?.("execution_success", () => setTimeout(refreshEstimates, 1500));

  // ------------------------------------------------------------------ Ready to run
  let ready = null;
  async function refreshReadiness() {
    if (!pipeline?.btns) return null;
    try {
      const nodes = allNodes(app.graph);
      const stillSw = nodes.find(({ n }) => String(n.title || "").startsWith("Still model · use picker"))?.n;
      const krea = stillSw ? !stillSw.widgets?.find((w) => w.name === "switch")?.value : false;
      const vsw = !!pipeline.w?.(9084, "switch")?.value;
      const q = new URLSearchParams({ still: pipeline.w?.(9081, "model")?.value || "", video: vsw ? (pipeline.w?.(9083, "model")?.value || "") : "",
        l2r: vsw ? "0" : "1", krea: krea ? "1" : "0" });
      const server = await (await api.fetchApi(`/soundstage/takecheck/readiness?${q}`)).json();
      const plan = planModelFixes(loaderWidgets(app.graph));
      const LG = globalThis.LiteGraph;
      const reg = LG?.registered_node_types;
      const missingNodes = reg ? [...new Set(nodes.map(({ n }) => n.type).filter((t) => t && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(t) && !reg[t]))] : [];
      ready = readiness(server.steps, plan.missing, missingNodes);
    } catch (e) {
      ready = null;
      return null;
    }
    for (const [k, b] of Object.entries(pipeline.btns)) {
      const c = readinessChip(ready[k]);
      b.querySelector(".ss-tc-ready")?.remove();
      if (!c) continue;
      const s = el("span", "ss-tc-ready", c.text);
      s.dataset.tone = c.tone;
      s.title = c.title;
      s.setAttribute("role", "status");
      if (c.tone !== "ok") {
        s.addEventListener("pointerdown", stop);
        s.addEventListener("click", (e) => {
          e.stopPropagation();
          const st = ready[k];
          showPop(s, c.tone === "bad" ? `Step ${b.dataset.step}: needs ${st.needs.length}` : "Ready (optional extras missing)",
            st.needs.map((x) => `• ${x.what}${x.folder ? `  →  models/${x.folder}/` : ""}${x.detail ? `\n   ${x.detail}` : ""}${x.required ? "" : " (optional)"}`),
            { text: "MODELS.md", href: MODELS_DOC_URL });
        });
      }
      s.setAttribute("aria-label", c.title);
      b.append(s);
    }
    return ready;
  }
  if (pipeline && !pipeline._ssTcGo) {
    pipeline._ssTcGo = true;
    const go = pipeline.go.bind(pipeline);
    pipeline.go = (k) => { const r = go(k); setTimeout(() => { applyEstimates(); if (k === "frame" || k === "motion") refreshReadiness(); }, 0); return r; };
  }
  setTimeout(() => { refreshEstimates(); refreshReadiness(); }, 1500);

  // ------------------------------------------------------------------ the recipe in the MP4
  function restore(rec, from = "the take") {
    ctx.restoreScene?.(rec.scene);
    if (rec.look) { try { ctx.look?.load?.(JSON.stringify(rec.look)); } catch { /* look panel not built */ } }
    const setSeed = (ids, v) => {
      if (v == null) return;
      for (const id of ids) for (const w of pipeline?.node?.(id)?.widgets || []) if (/seed/i.test(w.name) && typeof w.value === "number") { w.value = v; try { w.callback?.(v); } catch { /* */ } }
    };
    setSeed([9091], rec.seeds?.video);
    setSeed([5516, 9034], rec.seeds?.ltx ?? rec.seeds?.video);
    if (rec.quality) {
      if (rec.quality.motion_freedom != null) pipeline?.set?.(9096, "motion_freedom", rec.quality.motion_freedom);
      if (rec.quality.quality) pipeline?.set?.(9096, "quality", rec.quality.quality);
    }
    try { pipeline?._drawShotRows?.(); } catch { /* */ }
    say(`Restored from ${from}: ${recipeLine(rec)}${rec.look ? ", with its look" : ""}.`);
  }
  async function maybeRestore(file) {
    if (!file || !(/\.(mp4|m4v|mov)$/i.test(file.name || "") || /mp4|quicktime/.test(file.type || ""))) return false;
    let rec = null;
    try { rec = recipeFromTags(await readFileTags(file)); } catch { rec = null; }
    if (!rec) return false;
    const pick = await choose("This video is a Soundstage take", `${file.name}\n${recipeLine(rec)}\n\nIts recipe is inside the MP4: the set, the shot${rec.look ? ", the look" : ""} and the seed.`,
      ["Restore its set and shot", "Bring it in as a video"]);
    if (pick !== 0) return pick === -1;     // closed: do nothing; "as a video": the normal import goes on
    restore(rec, file.name);
    return true;
  }
  async function restoreTake(file) {
    const r = await api.fetchApi(`/soundstage/takecheck/recipe?${new URLSearchParams(file)}`);
    if (!r.ok) { say("This take carries no Soundstage recipe."); return false; }
    restore(await r.json(), file.filename);
    return true;
  }

  return { check, decorate, maybeRestore, restoreTake, refreshReadiness, refreshEstimates, renderStrip, results, get timing() { return timing; }, get ready() { return ready; } };
}
