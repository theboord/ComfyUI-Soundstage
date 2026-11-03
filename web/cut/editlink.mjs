// Soundstage Cut: Edit from the timeline (Directive 9, docs/cut.md "Edit from the timeline").
// Every clip opens an "Edit in…" menu three ways: right-click, the ✎ that shows on hover, or the E key (Shift+F10 and the
// ContextMenu key too). Each item opens the step that made the clip with that clip loaded; "Replace in cut" brings the
// new take back as a new version of the clip, in one undoable edit.
//
// This file is the Cut side, with no App imports (cut.mjs and demo.html load it):
//   pure:  clipContext, clipType, playingTake, canonicalUrl, fileKey, versionFor, holdPins, applyPins, findClip,
//          menuItems, newTakes, mintUid, framesNeeded (tests/js/editlink.test.mjs)
//   DOM:   openEditMenu (the pop-over layer, ../ui/popover.mjs), attachPencil (the ✎ overlay), attachKeys,
//          attachCutLink (all three on a CutPanel: panel.editLink = attachCutLink(panel, {onEdit}))
// The App side (the trip, the jumps, the Back pill, the offer, take detection) is web/cut/editlink_app.mjs.

import * as TL from "./timeline.mjs";
import { isOverlap, transSpans } from "./fx.mjs";
import { openPopover } from "../ui/popover.mjs";

export const RUNG_LABEL = { final: "Final", draft: "Draft", look: "Look", clay: "Clay" };
/** Takes made outside the App graph (their own prompts): a clip pinned to one is of type "take". */
export const OUTSIDE_KINDS = ["ripple", "pose", "performance", "oneclick"];
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v|avi|gif)$/i;

// ------------------------------------------------------------------------------------------------ pure helpers

/** A URL without its cache-buster (t=…): the form a take is saved in. */
export function canonicalUrl(url) {
  const u = String(url || "");
  const q = u.indexOf("?");
  if (q < 0) return u;
  const parts = u.slice(q + 1).split("&").filter((x) => x && !/^t=/.test(x));
  return u.slice(0, q) + (parts.length ? `?${parts.join("&")}` : "");
}

/** The identity of a take's file: "type:subfolder/filename" (two URLs of one file give one key). */
export const fileKey = (url) => (url ? TL.viewKey(url) : "");

/** The file name a URL points at ("" for none). */
export function fileName(url) {
  const u = String(url || "");
  const q = u.indexOf("?");
  if (q >= 0) {
    const fn = new URLSearchParams(u.slice(q + 1).split("#")[0]).get("filename");
    if (fn) return fn;
  }
  return u.split("?")[0].split("#")[0].split("/").pop() || "";
}
export const isVideoUrl = (url) => VIDEO_RE.test(fileName(url));

/** Does a clip (its shot as it plays, TL.layout row.shot) show imported footage's camera original? (exporters mediaFor) */
export function playsSource(shot) {
  if (!shot?.source) return false;
  const r = TL.bestRung(shot);
  return shot.source.use === "original" || r === "clay" || r === "look";
}

/** The take a layout row plays now: its pin, else its shot's best render (canonical URL), else clay (url ""). */
export function playingTake(row) {
  const t = row?.event?.take;
  if (t) return { ...t, pinned: true };
  const rung = TL.bestRung(row?.shot);
  return { url: rung === "clay" ? "" : canonicalUrl(row.shot.renders[rung]), rung, version: 0, pinned: false };
}

/** "final" | "draft" | "look" | "clay" | "take" (pinned to a Ripple, Pose, Performance or ✦ result). Takes a layout
 *  row or a playing take. */
export function clipType(rowOrTake) {
  const t = rowOrTake?.event ? playingTake(rowOrTake) : rowOrTake;
  if (t?.pinned && OUTSIDE_KINDS.includes(t.kind)) return "take";
  return TL.RUNGS.includes(t?.rung) ? t.rung : "clay";
}

/** "v2 · Final · 14:02" (no version for an unpinned clip; the take's own label, e.g. "Ripple", when it has one). */
export function takeLabel(t) {
  if (!t) return "";
  return [t.version ? `v${t.version}` : "", t.label || RUNG_LABEL[t.rung] || t.rung, t.at || ""].filter(Boolean).join(" · ");
}

/** The recipe route for a take's MP4 (soundstage/takecheck/routes.py); "" for stills and clay (the route reads MP4 tags). */
export function recipeUrlOf(url) {
  if (!url || !isVideoUrl(url)) return "";
  const u = String(url), q = u.indexOf("?");
  const p = new URLSearchParams(q >= 0 ? u.slice(q + 1) : "");
  if (!p.get("filename")) return "";
  return `/soundstage/takecheck/recipe?${new URLSearchParams({ filename: p.get("filename"), subfolder: p.get("subfolder") || "", type: p.get("type") || "output" })}`;
}

/** Version number of a file among a shot's clips: the one it already has, else the highest + 1 (clay: 0). */
export function versionFor(cut, shotId, url) {
  const key = fileKey(url);
  let max = 0;
  for (const e of cut || []) {
    if (String(e.shot_id) !== String(shotId)) continue;
    for (const t of [e.take, ...(e.versions || [])]) {
      if (!t?.url) continue;
      if (key && fileKey(t.url) === key && t.version) return t.version;
      max = Math.max(max, t.version || 0);
    }
  }
  return key ? max + 1 : 0;
}

/** A new clip uid, unique in this cut. */
export function mintUid(cut, rnd = Math.random) {
  const have = new Set((cut || []).map((e) => e.uid).filter(Boolean));
  for (let i = 0; i < 1000; i++) {
    const u = "c" + Math.floor(rnd() * 36 ** 6).toString(36).padStart(6, "0");
    if (!have.has(u)) return u;
  }
  return `c${Date.now().toString(36)}`;
}

/** A take as a pin. A take from the bins (web/dailies/model.mjs takesFor: `kind` is its rung, the tool that made it a
 *  flag) becomes {url, rung, kind: tool, label}; anything with a rung (a pin) is returned as it is. */
export function asPin(t) {
  if (!t || typeof t !== "object" || t.rung || !TL.RUNGS.includes(t.kind)) return t;
  const via = t.ripple ? "ripple" : t.pose ? "pose" : t.performance ? "performance" : t.oneclick ? "oneclick" : "";
  return { url: t.url, rung: t.kind, ...(via ? { kind: via } : {}), ...(t.label ? { label: t.label } : {}) };
}

const sameTake = (a, b) => (a?.url || b?.url ? !!(a?.url && b?.url) && fileKey(a.url) === fileKey(b.url) : a?.rung === b?.rung);

function withVersion(list, t, cap) {
  const out = (list || []).filter((v) => !sameTake(v, t));
  out.push(t);
  return out.slice(-cap);
}

/**
 * Pins as ONE new cut (null when nothing changes, or an index is wrong). pins: [{index, take, uid?}], take:
 *   an object  pin the clip to it (its old take, when another file, joins its versions); a take with no version gets the
 *              file's number in its shot (versionFor);
 *   null       follow the latest render again (the old take joins the versions);
 *   undefined  leave the take as it is (only the uid).
 * Everything else on the entry stays: in, out, trans, opacity, notes. Versions keep the newest `cap` (TL.MAX_VERSIONS).
 */
export function applyPins(cut, pins, { cap = TL.MAX_VERSIONS } = {}) {
  const out = (cut || []).map((e) => ({ ...e }));
  let changed = false;
  for (const p of pins || []) {
    const e = out[p?.index];
    if (!e) return null;
    // a uid names one clip: never a second one (normalize would keep the earlier copy and the clip would lose it)
    if (p.uid && !e.uid && !out.some((x) => x !== e && x.uid === p.uid)) { e.uid = p.uid; changed = true; }
    if (p.take === undefined) continue;
    const old = e.take || null;
    if (p.take === null) {
      if (!old) continue;
      e.versions = withVersion(e.versions, old, cap);
      delete e.take;
      changed = true;
      continue;
    }
    const pin = asPin(p.take);
    const t = TL.normalizeTake({ ...pin, url: canonicalUrl(pin.url), version: pin.version ?? versionFor(out, e.shot_id, pin.url) });
    if (!t) return null;
    if (old && sameTake(old, t)) continue;
    const vs = (old ? withVersion(e.versions, old, cap) : [...(e.versions || [])]).filter((v) => !sameTake(v, t));
    if (vs.length) e.versions = vs; else delete e.versions;
    e.take = t;
    changed = true;
  }
  return changed ? out : null;
}

/**
 * The hold before a trip (docs/cut.md): the clicked clip and every other unpinned clip of its shot, each pinned to the
 * file it plays now, so no render that lands while you are away changes the cut. Clay clips are not held (clay has no
 * file to lose, and a clay pin that outlives its trip would hide the shot's renders), nor are clips that show imported
 * footage's camera original. The clicked clip also gets `uid` (on its own pin only). Pins for applyPins, the clicked
 * clip first when it has one.
 */
export function holdPins(project, index, { uid = null } = {}) {
  const rows = TL.layout(project);
  const row = rows[index];
  if (!row) return [];
  const sid = String(row.event.shot_id);
  const pins = [];
  for (const r of [row, ...rows.filter((x) => x.index !== index)]) {
    if (String(r.event.shot_id) !== sid) continue;
    const mine = r.index === index;
    const hold = !r.event.take && !playsSource(r.shot) && TL.bestRung(r.shot) !== "clay";
    const give = mine && uid && !r.event.uid;
    if (!hold && !give) continue;
    const t = hold ? playingTake(r) : null;
    pins.push({ index: r.index, take: hold ? { url: t.url, rung: t.rung } : undefined, ...(give ? { uid } : {}) });
  }
  return pins;
}

/**
 * The frames clip `index` reads from its file: its out point, plus the handle a dissolve or wipe out of it plays past
 * that (fx.mjs transSpans: the outgoing clip runs `post` frames past its out). {out, post, type, need}, null for no clip.
 * Replace's length check holds a take against `need`.
 */
export function framesNeeded(project, index) {
  const e = project?.cut?.[index];
  if (!e) return null;
  const sp = transSpans(project)[index + 1];
  const post = sp && isOverlap(sp.type) ? sp.post : 0;
  return { out: e.out, post, type: post ? sp.type : "", need: e.out + post };
}

/** A clip's index in a cut: by uid, else the same shot and in/out at `index`, else anywhere; -1 when it is gone. */
export function findClip(cut, { uid = null, index = -1, shot_id = null, in: inF = null, out: outF = null } = {}) {
  const list = cut || [];
  if (uid) { const i = list.findIndex((e) => e.uid === uid); if (i >= 0) return i; }
  const same = (e) => !!e && String(e.shot_id) === String(shot_id) && (inF == null || e.in === inF) && (outF == null || e.out === outF);
  if (same(list[index])) return index;
  const i = list.findIndex(same);
  if (i >= 0) return i;
  return list[index] && String(list[index].shot_id) === String(shot_id) ? index : -1;
}

/**
 * Everything the Cut knows about clip `index` (no server, no App), the link the menu and the host work from:
 * { clip: {index, uid, shot_id, in, out, recIn, recOut, recFrame, srcFrame}, shot: {id, name, setup, scene_name},
 *   type, footage, take: {url, rung, kind, key, version, pinned, at, label}, versions, latest: {url, rung}, pinned,
 *   recipeUrl }. srcFrame: the source frame under the playhead when it is inside the clip, else under recFrame (the
 * right-click), else the clip's in point. (Cut frames are stage frames: the App builds every shot at the stage length.)
 */
export function clipContext(project, index, { recFrame = null, playhead = null } = {}) {
  const row = TL.layout(project)[index];
  if (!row) return null;
  const e = row.event;
  const inside = (f) => f != null && Number.isFinite(+f) && f >= row.recIn && f < row.recOut;
  const at = inside(playhead) ? playhead : inside(recFrame) ? recFrame : row.recIn;
  const srcFrame = TL.clamp(Math.floor(row.in + (at - row.recIn)), row.in, row.out - 1);
  const t = playingTake(row);
  const base = TL.shotMap(project).get(String(e.shot_id)) || row.shot;
  const lr = TL.bestRung(base);
  return {
    clip: { index, uid: e.uid || null, shot_id: row.shot.id, in: row.in, out: row.out, recIn: row.recIn, recOut: row.recOut,
      recFrame: Math.floor(at), srcFrame },
    shot: { id: row.shot.id, name: row.shot.name, setup: row.shot.setup || "", scene_name: row.shot.scene_name || "" },
    type: clipType(t),
    footage: playsSource(row.shot),
    take: { url: t.url, rung: t.rung, kind: t.kind || "", key: fileKey(t.url), version: t.version || 0, pinned: t.pinned,
      at: t.at || "", label: t.label || "" },
    versions: (e.versions || []).map((v) => ({ ...v })),
    latest: { rung: lr, url: lr === "clay" ? "" : canonicalUrl(base.renders[lr]) },
    pinned: !!e.take,
    recipeUrl: recipeUrlOf(t.url),
  };
}

/** What the host hook gets (cut_interface_v1.md contract 6): onEditShot(shotId, where, ctx). ctx.link is the whole link. */
export const hookCtx = (link, from = "cut") => ({
  index: link.clip.index, uid: link.clip.uid, take: { rung: link.take.rung, url: link.take.url }, frame: link.clip.srcFrame,
  recFrame: link.clip.recFrame, recipeUrl: link.recipeUrl, from, link,
});

/** The menu's first line: "Sc 3 · Wide · Final v2 · 14:02" (an unpinned clip: "… · Final · latest render"). */
export function headLine(link) {
  const t = link.take;
  const what = link.footage ? "camera original" : `${t.label || RUNG_LABEL[t.rung] || t.rung}${t.version ? ` v${t.version}` : ""}`;
  return [link.shot.name, what, t.pinned ? t.at : "latest render"].filter(Boolean).join(" · ");
}

/**
 * The Edit in… items for a clip, as data (docs/cut.md table): {head} | {header} | {where, label, sub?, disabled, why?,
 * take?, current?}. where: frame, motion, stage, ripple, paint_v2v, reshoot, oneclick, canvas, review (jumps: the host
 * opens them) and version, follow (the Cut does them itself). A disabled item says why on its second line. caps: {where:
 * false} turns an item off in a host that cannot do it.
 */
export function menuItems(link, caps = {}) {
  const t = link.footage ? "footage" : link.type;
  const still = t === "look", clay = t === "clay", foot = t === "footage";
  const noClip = still ? "a still has no motion to keep: use First frame or ✦"
    : clay ? "clay is drawn live, so there is no clip: render a Draft first, or Re-block"
      : foot ? "the camera original is not a ComfyUI file" : "";
  const items = [{ head: headLine(link) }, { header: "Edit in" },
    { where: "frame", label: "First frame", sub: "④ Frame" },
    { where: "motion", label: still ? "Animate this frame" : clay ? "Render it" : "Re-generate", sub: "⑤ Motion" },
    { where: "stage", label: "Re-block", sub: `③ Set, frame ${link.clip.srcFrame}` },
    { header: "Edit the video" },
    { where: "ripple", label: "Ripple", sub: "keep the motion, change the look", why: noClip },
    { where: "paint_v2v", label: "Paint video-to-video", sub: "paint frame 1, Ripple carries it", why: noClip },
    { where: "reshoot", label: "Recast camera", sub: "✦ Reshoot (Recast's engine)", why: still ? "Reshoot needs a clip" : noClip },
    { where: "oneclick", label: "✦ One-click cards…", sub: still ? "still cards" : "clip cards",
      why: clay ? "nothing rendered to work on" : foot ? "the camera original is not a ComfyUI file" : "" },
    { header: "This clip" }];
  const cur = link.take;
  const others = link.versions.filter((v) => !(cur.pinned && sameTake(v, cur)));
  const latestNew = cur.pinned && link.latest.url && !sameTake(link.latest, cur) && !others.some((v) => sameTake(v, link.latest));
  if (!foot && (cur.pinned || others.length)) {
    for (const v of [...others].sort((a, b) => (a.version || 0) - (b.version || 0))) items.push({ where: "version", label: takeLabel(v), take: v });
    if (cur.pinned) items.push({ where: "version", label: takeLabel(cur), take: cur, current: true, why: "playing now" });
    if (latestNew) items.push({ where: "version", label: `Latest render · ${RUNG_LABEL[link.latest.rung]}`, take: { url: link.latest.url, rung: link.latest.rung } });
    if (cur.pinned) items.push({ where: "follow", label: "Follow the latest render", sub: "new renders show up in this clip again" });
  }
  items.push({ where: "canvas", label: "Touch up its frame in Paint Studio" }, { where: "review", label: "Compare in ⑥ Review" });
  for (const it of items) {
    if (!it.where) continue;
    if (!it.why && caps[it.where] === false) it.why = "not available here";
    it.disabled = !!it.why;
    if (!it.why) delete it.why;
  }
  return items;
}

/** Takes that landed while away: not in `before` (file keys), newest first. Video clips take videos; Look and clay clips
 *  take stills too. takes: [{url, created?, video?, …}]. A new cache-buster on an old file is not new. */
export function newTakes(before, takes, type) {
  const seen = new Set(before || []);
  const stills = type === "look" || type === "clay";
  const out = [];
  (takes || []).forEach((t, i) => {
    const k = fileKey(t?.url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (!(t.video ?? isVideoUrl(t.url)) && !stills) return;
    out.push([t, i]);
  });
  return out.sort((a, b) => (b[0].created ?? 0) - (a[0].created ?? 0) || b[1] - a[1]).map((x) => x[0]);
}

// ------------------------------------------------------------------------------------------------ DOM (never at import)

const CSS = `
.ss-editmenu{min-width:260px;max-width:340px;padding:6px;border-radius:12px;background:#221b28;border:1px solid rgba(255,255,255,.14);
  box-shadow:0 12px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:1px;color:#f0efed;
  font:13px/1.3 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif}
.ss-editmenu .ss-em-head{font-size:12px;font-weight:600;padding:4px 8px 2px;color:#f0efed}
.ss-editmenu .ss-em-h{font-size:10px;color:#a9a3ad;padding:7px 8px 2px;text-transform:uppercase;letter-spacing:.06em}
.ss-editmenu button{display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;background:transparent;border:0;
  color:inherit;padding:5px 8px;border-radius:8px;cursor:pointer;font:inherit}
.ss-editmenu button:hover:not(:disabled),.ss-editmenu button:focus-visible{background:rgba(242,255,89,.1);outline:none}
.ss-editmenu button:disabled{cursor:default;color:#9a93a0}
.ss-editmenu .ss-em-s{font-size:11px;color:#a9a3ad}
.ss-editmenu button:disabled .ss-em-s{font-style:italic}
.ss-cut-tl.ss-el-host{position:relative}
.ss-editpencil{position:absolute;z-index:2;width:24px;height:20px;padding:0;margin:0;border-radius:6px;border:1px solid rgba(255,255,255,.4);
  background:rgba(13,17,23,.85);color:#f2ff59;font:13px/18px ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-align:center}
.ss-editpencil[hidden]{display:none}
.ss-editpencil:hover{background:#e39a40;color:#16191e}
`;

function injectCss(doc = document) {
  if (doc.getElementById("ss-editlink-css")) return;
  const st = doc.createElement("style");
  st.id = "ss-editlink-css";
  st.textContent = CSS;
  doc.head.append(st);
}

const span = (doc, cls, text) => Object.assign(doc.createElement("span"), { className: cls, textContent: text });

/** Open the Edit in… menu (items from menuItems) at anchor: a mouse event or a {left, top, right, bottom} rect. pick(item)
 *  runs the chosen item. The menu keeps the class ss-cut-ctx (the headless sweep opens it). Returns the pop-over handle. */
export function openEditMenu(items, anchor, { theme = null, pick = () => {}, onClose = null, doc = document } = {}) {
  injectCss(doc);
  const m = doc.createElement("div");
  m.className = "ss-cut-ctx ss-editmenu";
  m.setAttribute("role", "menu");
  m.setAttribute("aria-label", "Edit in");
  let handle = null;
  for (const it of items) {
    if (it.head) { m.append(span(doc, "ss-em-head", it.head)); continue; }
    if (it.header) { const hd = span(doc, "ss-em-h", it.header); hd.setAttribute("role", "presentation"); m.append(hd); continue; }
    const b = doc.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.dataset.where = it.where;
    if (it.current) b.dataset.current = "true";
    b.append(span(doc, "ss-em-l", it.label));
    const sub = it.disabled ? it.why : it.sub;
    if (sub) b.append(span(doc, "ss-em-s", sub));
    b.disabled = !!it.disabled;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); handle?.close("item"); pick(it); });
    m.append(b);
  }
  handle = openPopover(m, { anchor, theme, themeClasses: false, name: "cut-ctx", focus: "first", remove: true, onClose });
  return handle;
}

/** A clip's rectangle on screen (the menu's anchor for the ✎ and the keys). */
export function clipRect(panel, index) {
  const r = panel.tl.getBoundingClientRect();
  const row = TL.layout(panel.project)[index];
  if (!row) return { left: r.left, top: r.top, right: r.left, bottom: r.top };
  const head = panel._x(0) + panel.scrollX;   // the track-header column
  const x0 = TL.clamp(panel._x(row.recIn), head, panel.tl.clientWidth), x1 = TL.clamp(panel._x(row.recOut), x0, panel.tl.clientWidth);
  const top = r.top + panel._ty + 3;
  return { left: r.left + x0, top, right: r.left + x1, bottom: top + panel._L.th - 6 };
}

/**
 * The ✎ on the hovered clip: a 24×20 button inside the timeline box (.ss-cut-tl, so it scrolls with the canvas) in the
 * clip's lower band, right side: x = _x(recOut) - 34, y = _ty + th - 25 (never above _ty + 20). That keeps it off the
 * rung badge (top right), the transition handles (the top 19 px) and the 6 px trim edge. Only on clips at least 48 px
 * wide; hidden on pointerdown, wheel,
 * scroll and drag, and when the pointer leaves the canvas (unless onto the ✎). Not in the tab order: E is the keyboard
 * way. Returns hover(index, x, y) for CutPanel._tlMove (index -1: nothing under the pointer).
 */
export function attachPencil(panel, onOpen) {
  const host = panel._tlw || panel.tl?.parentElement;
  const tl = panel.tl;
  if (!host || !tl) return () => {};
  const doc = tl.ownerDocument;
  injectCss(doc);
  host.classList.add("ss-el-host");
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "ss-editpencil";
  b.textContent = "✎";
  b.tabIndex = -1;
  b.hidden = true;
  b.title = "Edit in… (E)";
  b.setAttribute("aria-label", "Edit in…");
  host.append(b);
  let idx = -1;
  const hide = () => { b.hidden = true; idx = -1; };
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); const i = idx; if (i >= 0) onOpen(i, b); });
  b.addEventListener("pointerleave", (e) => { if (e.relatedTarget !== tl) hide(); });
  tl.addEventListener("pointerdown", hide);
  tl.addEventListener("wheel", hide, { passive: true });
  host.addEventListener("scroll", hide, { passive: true });
  tl.addEventListener("pointerleave", (e) => { if (e.relatedTarget !== b) hide(); });
  const hover = (i) => {
    const row = i >= 0 && !panel._drag ? TL.layout(panel.project)[i] : null;
    if (!row) { hide(); return; }
    const head = panel._x(0) + panel.scrollX, W = tl.clientWidth;
    const x0 = Math.max(panel._x(row.recIn), head), x1 = Math.min(panel._x(row.recOut), W);
    if (x1 - x0 < 48) { hide(); return; }
    idx = i;
    b.style.left = `${Math.round(tl.offsetLeft + x1 - 34)}px`;
    b.style.top = `${Math.round(tl.offsetTop + panel._ty + Math.max(20, (panel._L?.th || 56) - 25))}px`;
    b.hidden = false;
  };
  hover.button = b;
  hover.hide = hide;
  return hover;
}

/** E (and Shift+F10, the ContextMenu key) on the Cut opens the menu for the selected clip, else the clip under the
 *  playhead. A listener next to CutPanel._onKey on the same root: cut.mjs has no `e` case. */
export function attachKeys(panel, onOpen) {
  const root = panel.root;
  if (!root) return;
  let quiet = 0;
  const target = () => {
    if (panel.sel >= 0 && panel.sel < panel.project.cut.length) return panel.sel;
    return TL.eventAt(panel.project, Math.floor(panel.frame))?.index ?? -1;
  };
  root.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;   // another handler took the key (cut_interface_v1.md A7)
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "") || e.target?.isContentEditable) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!(plain && (/^e$/i.test(e.key) || (e.shiftKey && e.key === "F10") || e.key === "ContextMenu"))) return;
    const i = target();
    if (i < 0) return;
    e.preventDefault();
    quiet = Date.now() + 600;   // the ContextMenu key also fires a contextmenu event
    onOpen(i);
  });
  root.addEventListener("contextmenu", (e) => { if (Date.now() < quiet) e.preventDefault(); });
}

/** Pin `link`'s clip and its shot's other clips to what they play now (one undoable edit). Returns the clip's uid. */
export function holdClip(panel, link) {
  const uid = link.clip.uid || mintUid(panel.project.cut);
  const pins = holdPins(panel.project, link.clip.index, { uid });
  // the uid rides on the clicked clip's own pin (holdPins): `first` is a sibling when the clicked clip needs no pin
  if (pins.length) { const [first, ...also] = pins; panel.replaceClipTake(first.index, first.take, { also, uid: first.uid ?? null }); }
  return uid;
}

/**
 * Edit in… on a CutPanel: the menu (right-click through CutPanel._clipMenu), the ✎ (CutPanel._tlMove's hover hook) and
 * the keys. Returns {menu(link, anchor, {from}), hover(i, x, y), open(index, anchor?), close(), pick(item, link)}; set it as
 * panel.editLink. A jump holds the clip's shot first, then calls onEdit(where, ctx) (default: the panel's host hook
 * onEditShot(shotId, where, ctx), cut_interface_v1.md contract 6). Versions and Follow are done here, with no jump.
 * extend(items, link) may add host items (the App's other takes of the shot).
 */
export function attachCutLink(panel, { onEdit = null, caps = {}, extend = null, from = "cut" } = {}) {
  const edit = onEdit || ((where, ctx) => panel._onEditShot?.(ctx.link.shot.id, where, ctx));
  const link = { panel, handle: null };
  link.pick = (it, l, how = from) => {
    if (it.disabled) return;
    if (typeof it.run === "function") return it.run(l);   // a host's own item (panel.clipMenuExtras): no hold, no jump
    if (it.where === "version" || it.where === "follow") {
      const i = findClip(panel.project.cut, { ...l.clip });
      if (i >= 0) panel.replaceClipTake(i, it.where === "follow" ? null : { ...it.take });
      return;
    }
    const uid = holdClip(panel, l);
    const i = findClip(panel.project.cut, { ...l.clip, uid });
    const fresh = i >= 0 ? panel.clipContext(i, l.clip.recFrame) : l;
    return edit(it.where, hookCtx(fresh, how));
  };
  link.menu = (l, anchor, { from: how = from } = {}) => {
    if (!l) return null;
    link.close();
    let items = menuItems(l, caps);
    if (extend) items = extend(items, l) || items;
    // the Cut's own extension point (cut_interface_v1.md A7): [{header} | {label, sub?, disabled?, why?, run(link)}]
    const more = typeof panel.clipMenuExtras === "function" ? panel.clipMenuExtras(l) : panel.clipMenuExtras;
    if (Array.isArray(more) && more.length) items = [...items, ...more.map((x) => (x?.header || x?.head ? x : { where: "extra", ...x, disabled: !!(x?.disabled || x?.why) }))];
    link.handle = openEditMenu(items, anchor, { theme: panel.tl, doc: panel.tl?.ownerDocument || document,
      pick: (it) => link.pick(it, l, how), onClose: () => { link.handle = null; } });
    return link.handle;
  };
  link.open = (index, anchor = null) => link.menu(panel.clipContext(index), anchor?.getBoundingClientRect ? anchor : anchor || clipRect(panel, index));
  link.close = () => link.handle?.close("api");
  link.hover = attachPencil(panel, (i, btn) => link.open(i, btn));
  attachKeys(panel, (i) => link.open(i));
  return link;
}
