// Approvals: review every take (a frame, a draft, a final) as Approved ✓, Needs changes ↺ (with a note on what to
// change) or Rejected ✕; unreviewed by default. One store for the whole App, kept in the workflow
// (node.properties.ss_approvals, see model.mjs), so the same frame shows the same status in ④ Frame, ⑤ Motion, the
// shot rows and the Dailies bin, and it survives a reload.
//
//   import { initApprovals, statusOf, approvalBadge, approvalDot, onApprovalsChange, mountPipelineApprovals } from "./dailies/approval.mjs";
//   initApprovals({ props: () => node.properties, save: () => markDirty(), getRenders: (sid) => renders, onRedo });
//   statusOf(shotId)            -> {status: "approved"|"changes"|"rejected"|"", label, sym, note, take}   (the shot's current take)
//   approvalBadge(el, take, {shotId})   a small round button on a thumbnail: click opens the review pop-over
//   approvalDot(el, shotId)     a read-only status dot for a shot (scene strips, shot pickers); updates itself
//   onApprovalsChange(fn)       fn({shotId}) after any change; returns an unsubscribe function
//   mountPipelineApprovals(pipeline)   badges on ④ Frame's variations, ⑤ Motion's latest result and the shot rows
//
// Host (initApprovals): props() -> the object holding ss_approvals and ss_scene_desc (node.properties; without a host
// an in-memory object), save() after a change, getRenders(shotId) -> anything takesFor accepts,
// onRedo(shotId, take, step, note) for "Redo" on a take that needs changes (step "frame" or "motion").
import { takesFor, takeKey, getTakeStatus, withTakeStatus, shotStatus, normStatus, STATUS_META, KIND_LABEL } from "./model.mjs";

const mem = {};
let HOST = { props: () => mem, save: () => {}, getRenders: () => null, onRedo: null, getShot: null };
const listeners = new Set();

/** Wire the store to the App (call once). Later calls replace the host. */
export function initApprovals(host = {}) {
  HOST = { ...HOST, ...host };
  injectCss();
  emit({});
}

const props = () => { try { return HOST.props() || mem; } catch { return mem; } };
/** The raw store {shotId: {takeKey: {s, note, t, kind}}}. */
export const approvalStore = () => props().ss_approvals || {};

function emit(detail) {
  for (const fn of [...listeners]) { try { fn(detail); } catch { /* a listener failed */ } }
  if (typeof document !== "undefined") refreshBadges();
}

/** Subscribe to approval changes; returns an unsubscribe function. */
export function onApprovalsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** One take's review: {status, note, t}. take = a take record ({url}) or a URL. */
export const takeStatus = (shotId, take) => getTakeStatus(approvalStore(), shotId, take);

/** Set one take's status (and optionally its note). status "" = unreviewed. */
export function setTakeStatus(shotId, take, status, note = undefined) {
  const p = props();
  const kind = typeof take === "object" ? take?.kind : undefined;
  p.ss_approvals = withTakeStatus(p.ss_approvals, shotId, take, status, note, kind ? { kind } : {});
  try { HOST.save?.(); } catch { /* host away */ }
  emit({ shotId, key: takeKey(take) });
}

/** A shot's takes from the host (the same list the Dailies bin shows). */
export function takesOf(shotId) {
  try { return takesFor({ id: shotId }, HOST.getRenders(shotId)); } catch { return []; }
}

/**
 * The status of a shot (for scene strips and shot pickers): its current take's review, the take being the latest
 * final, else draft, else the chosen frame. {status, label, sym, note, take}; status "" = unreviewed or nothing yet.
 */
export function statusOf(shotId, takes = null) {
  const r = shotStatus(takes || takesOf(shotId), (t) => takeStatus(shotId, t));
  const meta = STATUS_META[r.status] || STATUS_META[""];
  return { ...r, label: r.take ? meta.label : "Nothing to review yet", sym: meta.sym };
}

// ------------------------------------------------------------------------------------------------------ scene names

/** The edited scene description, or null (use the automatic one). */
export const sceneDescription = (sceneId) => props().ss_scene_desc?.[sceneId] ?? null;

/** Save an edited scene description ("" or null goes back to the automatic one). */
export function setSceneDescription(sceneId, text) {
  const p = props();
  const all = { ...(p.ss_scene_desc || {}) };
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (t) all[sceneId] = t; else delete all[sceneId];
  p.ss_scene_desc = all;
  try { HOST.save?.(); } catch { /* host away */ }
  emit({ sceneId });
}

// ------------------------------------------------------------------------------------------------------ DOM

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};

const CSS = `
.ss-appr { all:unset; box-sizing:border-box; position:relative; display:inline-grid; place-items:center; width:var(--ab, 22px); height:var(--ab, 22px);
  border-radius:50%; cursor:pointer; font:700 calc(var(--ab, 22px) * .58)/1 ui-sans-serif, system-ui, sans-serif; color:#fff; flex:none;
  background:rgba(18,14,21,.78); border:1.6px dashed rgba(255,255,255,.55); box-shadow:0 1px 4px rgba(0,0,0,.45); transition:transform .1s; }
.ss-appr:hover { transform:scale(1.1); border-color:#fff; }
.ss-appr:focus-visible { outline:2px solid var(--ss-accent, #f2ff59); outline-offset:2px; }
.ss-appr[data-s=approved] { background:#1f9d55; border:1.6px solid #7ee2a8; }
.ss-appr[data-s=changes] { background:#d97706; border:1.6px solid #fcd34d; }
.ss-appr[data-s=rejected] { background:#c0392b; border:1.6px solid #f5a39b; }
.ss-appr[data-note]::after { content:""; position:absolute; right:-2px; top:-2px; width:7px; height:7px; border-radius:50%; background:#fff; box-shadow:0 0 0 1.5px #d97706; }
.ss-appr-pos { position:absolute; top:6px; right:6px; z-index:3; }
.ss-appr-dot { display:inline-grid; place-items:center; width:16px; height:16px; border-radius:50%; flex:none; font:700 10px/1 ui-sans-serif, system-ui, sans-serif;
  color:#fff; background:rgba(18,14,21,.7); border:1.4px dashed rgba(255,255,255,.5); }
.ss-appr-dot[data-s=approved] { background:#1f9d55; border:1.4px solid #7ee2a8; }
.ss-appr-dot[data-s=changes] { background:#d97706; border:1.4px solid #fcd34d; }
.ss-appr-dot[data-s=rejected] { background:#c0392b; border:1.4px solid #f5a39b; }
.ss-appr-dot[data-s=none] { display:none; }
.ss-appr-dotpos { position:absolute; top:8px; right:8px; z-index:2; pointer-events:none; }
.ss-appr-row { display:flex; align-items:center; gap:8px; margin:6px 0; font-size:12.5px; color:var(--ss-muted, #a9a3ad); }
.ss-appr-row b { color:var(--ss-text, #f0efed); font-weight:600; }
.ss-appr-row .nt { color:#fcd34d; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.ss-appr-pop { position:fixed; z-index:10050; width:268px; padding:10px; border-radius:14px; background:#2a2330; color:#f0efed;
  border:1px solid rgba(255,255,255,.16); box-shadow:0 22px 60px rgba(0,0,0,.6); font:13px/1.4 ui-sans-serif, system-ui, sans-serif;
  display:flex; flex-direction:column; gap:8px; }
.ss-appr-pop * { box-sizing:border-box; }
.ss-appr-pop .hd { display:flex; align-items:center; gap:8px; font-weight:600; }
.ss-appr-pop .hd small { color:rgba(240,239,237,.56); font-weight:500; margin-left:auto; }
.ss-appr-pop .ch { display:grid; grid-template-columns:repeat(3, 1fr); gap:5px; }
.ss-appr-pop button { font:inherit; cursor:pointer; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#342c3b; color:#f0efed;
  padding:7px 6px; display:flex; flex-direction:column; align-items:center; gap:2px; font-size:11.5px; font-weight:600; }
.ss-appr-pop button .s { font-size:16px; line-height:1; }
.ss-appr-pop button:hover { border-color:rgba(255,255,255,.3); }
.ss-appr-pop button:focus-visible { outline:2px solid var(--ss-accent, #f2ff59); outline-offset:1px; }
.ss-appr-pop button[data-k=approved][aria-pressed=true] { background:#1f9d55; border-color:#7ee2a8; }
.ss-appr-pop button[data-k=changes][aria-pressed=true] { background:#d97706; border-color:#fcd34d; }
.ss-appr-pop button[data-k=rejected][aria-pressed=true] { background:#c0392b; border-color:#f5a39b; }
.ss-appr-pop textarea { width:100%; min-height:58px; resize:vertical; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(0,0,0,.25);
  color:inherit; font:inherit; padding:7px 9px; }
.ss-appr-pop textarea:focus { outline:none; border-color:var(--ss-accent, #f2ff59); }
.ss-appr-pop .ft { display:flex; gap:6px; align-items:center; }
.ss-appr-pop .ft button { flex-direction:row; padding:6px 11px; border-radius:999px; }
.ss-appr-pop .ft .redo { background:#f2ff59; color:#211927; border-color:#f2ff59; }
.ss-appr-pop .ft .clr { background:transparent; color:rgba(240,239,237,.6); border-color:transparent; margin-left:auto; }
.ss-appr-redo { display:flex; align-items:flex-start; gap:10px; padding:9px 12px; border-radius:12px; background:rgba(217,119,6,.14);
  border:1px solid rgba(252,211,77,.45); color:#fde7b0; font-size:13px; }
.ss-appr-redo b { color:#fcd34d; }
.ss-appr-redo .tx { flex:1; min-width:0; }
.ss-appr-redo button { font:inherit; font-size:12px; cursor:pointer; border-radius:999px; border:1px solid rgba(255,255,255,.18); background:#342c3b; color:#f0efed; padding:3px 10px; }
`;
function injectCss() {
  if (typeof document === "undefined" || document.getElementById("ss-appr-css")) return;
  document.head.append(h("style", { id: "ss-appr-css" }, CSS));
}

const BADGES = new Set();     // live badge / dot elements (pruned when detached)

function paintBadge(b) {
  const { shotId, take } = b._appr;
  const st = takeStatus(shotId, take);
  const meta = STATUS_META[st.status];
  b.dataset.s = st.status || "none";
  b.textContent = meta.sym;
  if (st.note) b.dataset.note = ""; else delete b.dataset.note;
  const what = b._appr.label || (take?.kind ? KIND_LABEL[take.kind] || "Take" : "Take");
  const tip = `${what}: ${meta.label}${st.note ? ` — “${st.note}”` : ""}. Click to review`;
  b.title = tip;
  b.setAttribute("aria-label", tip);
}

function paintDot(d) {
  const st = statusOf(d._appr.shotId);
  d.dataset.s = st.take ? (st.status || "") : "none";
  d.textContent = STATUS_META[st.status]?.sym || "";
  d.title = `${st.label}${st.note ? `: “${st.note}”` : ""}`;
  d.setAttribute("aria-label", d.title);
}

/** Repaint every badge and dot on the page (after a status change or a re-render of the host). */
export function refreshBadges() {
  for (const b of [...BADGES]) {
    if (!b.isConnected) { if (b._appr.seen) BADGES.delete(b); continue; }
    b._appr.seen = true;
    if (b._appr.dot) paintDot(b); else paintBadge(b);
  }
}

/**
 * A review badge for one take, appended to `el` (pass {place: true} to pin it to the element's top-right corner).
 * take: a take record ({url, kind, n?}) or a URL. opts: {shotId (required), size (px), label ("Tk 3 · Final"), place}.
 * Click opens the review pop-over; Alt+click cycles the status without it. Returns the button.
 */
export function approvalBadge(el, take, opts = {}) {
  injectCss();
  const t = typeof take === "string" ? { url: take } : take;
  const b = h("button", { type: "button", class: `ss-appr${opts.place ? " ss-appr-pos" : ""}`, style: opts.size ? `--ab:${opts.size}px` : null });
  b._appr = { shotId: opts.shotId, take: t, label: opts.label || null };
  for (const ev of ["pointerdown", "mousedown", "dblclick"]) b.addEventListener(ev, (e) => e.stopPropagation());
  b.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
  b.addEventListener("click", (e) => {
    e.stopPropagation(); e.preventDefault();
    if (e.altKey) { const cur = takeStatus(opts.shotId, t).status; setTakeStatus(opts.shotId, t, ["", "approved", "changes", "rejected"][(["", "approved", "changes", "rejected"].indexOf(cur) + 1) % 4]); return; }
    openReview(b, opts.shotId, t, b._appr.label);
  });
  paintBadge(b);
  BADGES.add(b);
  el?.append(b);
  return b;
}

/** A read-only status dot for a shot (its current take), appended to `el`; {place: true} pins it top-right. */
export function approvalDot(el, shotId, opts = {}) {
  injectCss();
  const d = h("span", { class: `ss-appr-dot${opts.place ? " ss-appr-dotpos" : ""}`, role: "img" });
  d._appr = { shotId, dot: true };
  paintDot(d);
  BADGES.add(d);
  el?.append(d);
  return d;
}

// ------------------------------------------------------------------------------------------------------ pop-over

let POP = null;
function closeReview() {
  if (!POP) return;
  POP.el.remove();
  document.removeEventListener("pointerdown", POP.away, true);
  document.removeEventListener("keydown", POP.key, true);
  const back = POP.anchor;
  POP = null;
  if (back?.isConnected) back.focus?.({ preventScroll: true });
}

/** The review pop-over for one take, next to `anchor`. */
export function openReview(anchor, shotId, take, label = null) {
  injectCss();
  if (POP?.anchor === anchor) { closeReview(); return; }
  closeReview();
  const st = takeStatus(shotId, take);
  const step = take?.kind === "draft" || take?.kind === "final" || (take?.video ?? false) ? "motion" : "frame";
  const name = label || `${take?.n ? `Tk ${take.n} · ` : ""}${KIND_LABEL[take?.kind] || (step === "motion" ? "Video" : "Frame")}`;
  const note = h("textarea", { placeholder: "What should change? (e.g. warmer light, she looks left, slower push-in)", "aria-label": "Note" }, st.note);
  const choice = (k, sym, text) => h("button", { type: "button", "data-k": k, "aria-pressed": String(st.status === k), title: STATUS_META[k].label,
    on: { click: () => {
      const cur = takeStatus(shotId, take).status;
      const next = cur === k ? "" : k;
      setTakeStatus(shotId, take, next, note.value);
      for (const x of pop.querySelectorAll(".ch button")) x.setAttribute("aria-pressed", String(x.dataset.k === next));
      redo.hidden = next !== "changes";
      if (next === "changes") note.focus(); else if (next) closeReview();
    } } }, h("span", { class: "s" }, sym), text);
  const redo = h("button", { type: "button", class: "redo", hidden: st.status === "changes" ? null : "",
    title: step === "frame" ? "Back to ④ Frame for this shot, with the note" : "Back to ⑤ Motion for this shot, with the note",
    on: { click: () => { setTakeStatus(shotId, take, "changes", note.value); closeReview(); HOST.onRedo?.(shotId, take, step, note.value); } } },
    `↺ Redo in ${step === "frame" ? "④ Frame" : "⑤ Motion"}`);
  const pop = h("div", { class: "ss-appr-pop", role: "dialog", "aria-label": `Review ${name}` },
    h("div", { class: "hd" }, "Review", h("small", {}, name)),
    h("div", { class: "ch" }, choice("approved", "✓", "Approve"), choice("changes", "↺", "Needs changes"), choice("rejected", "✕", "Reject")),
    note,
    h("div", { class: "ft" }, HOST.onRedo ? redo : null,
      h("button", { type: "button", class: "clr", title: "Back to unreviewed (clears the note)",
        on: { click: () => { setTakeStatus(shotId, take, "", ""); closeReview(); } } }, "Clear")));
  note.addEventListener("change", () => setTakeStatus(shotId, take, takeStatus(shotId, take).status || (note.value.trim() ? "changes" : ""), note.value));
  note.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { note.blur(); closeReview(); } });
  for (const ev of ["pointerdown", "wheel", "keydown"]) pop.addEventListener(ev, (e) => { if (!(ev === "keydown" && e.key === "Escape")) e.stopPropagation(); });
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - pw - 8, r.right - pw + 12));
  const top = r.bottom + 6 + ph < innerHeight ? r.bottom + 6 : Math.max(8, r.top - ph - 6);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { if (note.value !== takeStatus(shotId, take).note) note.dispatchEvent(new Event("change")); closeReview(); } };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); if (note.value !== takeStatus(shotId, take).note) note.dispatchEvent(new Event("change")); closeReview(); } };
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", key, true);
  POP = { el: pop, anchor, away, key };
  (pop.querySelector('.ch button[aria-pressed="true"]') || pop.querySelector(".ch button")).focus({ preventScroll: true });
  return pop;
}

// ------------------------------------------------------------------------------------------------------ pipeline

/**
 * Badges on the guided pipeline without touching its code: ④ Frame's variation grid (one badge per frame), ⑤ Motion's
 * latest result (a review row under the video) and a status dot on every shot-row card. Watches the pipeline's DOM, so
 * redraws keep their badges. Returns a disconnect function.
 */
export function mountPipelineApprovals(pipeline) {
  injectCss();
  const obs = [];
  const sid = () => pipeline.ctx?.stage?.activeShot?.()?.id;
  const watch = (el, fn, o = { childList: true }) => { if (!el) return; const mo = new MutationObserver(fn); mo.observe(el, o); obs.push(mo); fn(); };
  // ④ Frame: one badge per variation (the candidate list carries the url; the grid follows its order).
  const frameGrid = pipeline.f?.grid;
  watch(frameGrid, () => {
    const id = sid();
    for (const c of frameGrid.querySelectorAll(":scope > .cand")) {
      const url = c.querySelector("img")?.getAttribute("src");
      if (!url || c.querySelector(":scope > .ss-appr")) continue;
      approvalBadge(c, { url, kind: "look" }, { shotId: id, place: true, size: 26, label: "This frame" });
    }
  });
  // ⑤ Motion: a review row under the latest result, for whatever the video shows now.
  const m = pipeline.m;
  if (m?.video) {
    const row = h("div", { class: "ss-appr-row" });
    m.video.after(row);
    const draw = () => {
      const id = sid(), url = m.video.getAttribute("src");
      const r = pipeline.ctx?.getRenders?.(id) || {};
      if (!url || !id || url === r.previz) { row.replaceChildren(); row.hidden = true; return; }
      const kind = url === r.draft ? "draft" : "final";
      const st = takeStatus(id, url);
      row.hidden = false;
      row.replaceChildren(...[approvalBadge(null, { url, kind, video: true }, { shotId: id, size: 24, label: kind === "draft" ? "This draft" : "This final" }),
        h("b", {}, kind === "draft" ? "Draft" : "Final"), h("span", {}, STATUS_META[st.status].label),
        st.note ? h("span", { class: "nt", title: st.note }, `· ${st.note}`) : null].filter(Boolean));   // replaceChildren(null) writes "null"
    };
    watch(m.video, draw, { attributes: true, attributeFilter: ["src"] });
    onApprovalsChange(() => { if (row.isConnected) draw(); });
  }
  // Shot rows on every step: a status dot per card (cards follow ctx.rowShots() / shots() order).
  for (const { row } of pipeline.shotRows || []) {
    watch(row, () => {
      let shots = [];
      try { shots = pipeline.ctx.rowShots?.() || pipeline.shots(); } catch { /* not ready */ }
      [...row.querySelectorAll(":scope > button.shot")].forEach((b, i) => {
        const s = shots[i];
        if (!s || b.querySelector(".ss-appr-dot")) return;
        if (getComputedStyle(b).position === "static") b.style.position = "relative";
        approvalDot(b, s.id, { place: true });
      });
    });
  }
  return () => obs.forEach((o) => o.disconnect());
}

/**
 * The "Redo" hand-off on a pipeline step: a banner with the note above the step's status line, and (④ Frame) the note
 * added to the frame prompt, with Undo. Call after the pipeline has opened the shot and the step.
 */
export function showRedoNote(pipeline, step, take, note) {
  injectCss();
  const v = step === "frame" ? pipeline.f : pipeline.m;
  const anchor = v?.status;
  if (!anchor?.parentNode) return null;
  document.querySelectorAll(".ss-appr-redo").forEach((x) => x.remove());
  const text = String(note || "").trim();
  const kids = [h("div", { class: "tx" }, h("b", {}, "↺ Needs changes"), text ? `: ${/[.!?]$/.test(text) ? text : `${text}.`}` : ": no note.",
    step === "frame" ? " Generate new frames, pick one and review it again." : " Render it again, then review the new take.")];
  if (step === "frame" && text && pipeline.f?.desc) {
    const desc = pipeline.f.desc, before = desc.value;
    if (!before.includes(text)) {
      desc.value = `${before.trim()}${before.trim() ? " " : ""}${/[.!?]$/.test(text) ? text : `${text}.`}`;
      try { pipeline._setDescription?.(desc.value); } catch { /* look away */ }
      const undo = h("button", { type: "button", title: "Take the note back out of the prompt",
        on: { click: () => { desc.value = before; try { pipeline._setDescription?.(before); } catch { /* look away */ } undo.remove(); } } }, "Undo prompt edit");
      kids[0].append(" The note is added to the prompt.");
      kids.push(undo);
    }
  }
  const close = h("button", { type: "button", title: "Hide", on: { click: () => banner.remove() } }, "✕");
  const banner = h("div", { class: "ss-appr-redo", role: "note" }, ...kids, close);
  anchor.parentNode.insertBefore(banner, anchor);
  banner.scrollIntoView?.({ block: "nearest" });
  return banner;
}
