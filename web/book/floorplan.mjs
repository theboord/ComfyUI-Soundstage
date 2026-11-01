// The Director's Book floor plan (Milestone 23): a top-down plan of a scene's stage as SVG, in the convention of
// directors' blocking diagrams (Stanislavski's ground plans, Hitchcock's set plans): actors as labelled circles with
// numbered marks (1 where they start, 2 where they end), dashed move arrows, vehicles as outlines, set pieces as
// boxes, and each camera as a lettered field-of-view cone (A, B, C: the shot strip's letters) with a dashed track
// when it moves. North (+z) is up, like the stage's top view. Pure: a string out, so it prints and tests the same.
//
//   floorPlanSVG(stageJSON, cameraPlanRows, { w: 640, h: 380, theme: "screen" | "print" })

import { actorAt, worldCameraKeys, niceName } from "./model.mjs";

const PERSON = new Set(["man", "woman", "child", "boy", "girl", "person", "human", "actor", "mannequin", "cowboy", "police", "soldier"]);
const VEHICLE = /car|truck|van|bus|police|taxi|motorcycle|bike|bicycle|jeep|tractor|boat|tank|wagon|coach/;
const ANIMAL = /horse|dog|cat|bird|cow|deer|camel|hawk|gull/;
const SENSOR_W = 36;

export const THEMES = {
  screen: { bg: "#1b1520", grid: "rgba(255,255,255,0.05)", grid5: "rgba(255,255,255,0.09)", ink: "#f0efed", muted: "rgba(240,239,237,0.62)",
    prop: "rgba(255,255,255,0.07)", propLine: "rgba(255,255,255,0.22)", actor: "#ff9db0", vehicle: "#7ec8ff", animal: "#ffc46b",
    cam: "#f2ff59", camFill: "rgba(242,255,89,0.13)", camInk: "#211927", dropped: "rgba(240,239,237,0.35)" },
  print: { bg: "#ffffff", grid: "#eeebe6", grid5: "#e0dbd3", ink: "#1d1a17", muted: "#6c655d", prop: "#f2efea", propLine: "#b9b1a6",
    actor: "#b0284a", vehicle: "#1f5f99", animal: "#a0620b", cam: "#1d1a17", camFill: "rgba(29,26,23,0.07)", camInk: "#ffffff", dropped: "#b9b1a6" },
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const f1 = (v) => Math.round(v * 10) / 10;
const kindOf = (a) => {
  const k = String(a.kind || "").toLowerCase();
  if (PERSON.has(k)) return "person";
  if (ANIMAL.test(k)) return "animal";
  if (VEHICLE.test(k)) return "vehicle";
  return "object";
};

/** Every point the plan must show (actors along their paths, cameras along their moves, set pieces). */
function extent(stage, rows) {
  const pts = [];
  const last = Math.max(1, (stage?.shot?.frames || 97) - 1);
  for (const a of stage?.actors || []) {
    if (a.mount_id || a.carry_id) continue;
    for (const k of a.keys || [{ position: a.position }, ...(a.position_end ? [{ position: a.position_end }] : [])]) if (k?.position) pts.push(k.position);
    if (!a.keys?.length && a.position) pts.push(actorAt(a, last, last).position);
  }
  const live = new Set(rows.filter((r) => !r.gone).map((r) => r.id));
  for (const sh of stage?.shots || []) {
    if (!live.has(sh.id)) continue;
    const wk = worldCameraKeys(stage, sh);
    if (wk[0]) pts.push(wk[0].position);
    if (wk.length > 1) pts.push(wk[wk.length - 1].position);
  }
  return pts;
}

export function floorPlanSVG(stage, rows = [], { w = 640, h = 380, theme = "screen", title = "" } = {}) {
  const T = THEMES[theme] || THEMES.screen;
  const pts = extent(stage, rows);
  let minx = -6, maxx = 6, minz = -6, maxz = 6;
  if (pts.length) {
    minx = Math.min(...pts.map((p) => p[0])); maxx = Math.max(...pts.map((p) => p[0]));
    minz = Math.min(...pts.map((p) => p[2])); maxz = Math.max(...pts.map((p) => p[2]));
  }
  const pad = 3;
  minx -= pad; maxx += pad; minz -= pad; maxz += pad;
  if (maxx - minx < 10) { const c = (minx + maxx) / 2; minx = c - 5; maxx = c + 5; }
  if (maxz - minz < 8) { const c = (minz + maxz) / 2; minz = c - 4; maxz = c + 4; }
  const top = 6, bottom = 22;
  const s = Math.min((w - 16) / (maxx - minx), (h - top - bottom) / (maxz - minz));
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
  const X = (x) => f1(w / 2 + (x - cx) * s), Y = (z) => f1(top + (h - top - bottom) / 2 - (z - cz) * s);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title || "Floor plan")}" class="ss-bk-plan" font-family="inherit">`);
  out.push(`<defs><marker id="ar-${theme}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>`);
  out.push(`<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="${T.bg}"/>`);
  // grid: 1 m, every 5 m stronger
  const g = [];
  for (let x = Math.ceil(minx); x <= maxx; x++) g.push(`<line x1="${X(x)}" y1="${top}" x2="${X(x)}" y2="${h - bottom}" stroke="${x % 5 ? T.grid : T.grid5}" stroke-width="1"/>`);
  for (let z = Math.ceil(minz); z <= maxz; z++) g.push(`<line x1="8" y1="${Y(z)}" x2="${w - 8}" y2="${Y(z)}" stroke="${z % 5 ? T.grid : T.grid5}" stroke-width="1"/>`);
  if (s > 4) out.push(`<g>${g.join("")}</g>`);
  // set pieces: the stage only builds them on the plaza set
  const props = (stage?.environment?.set || "plaza") === "plaza" ? stage?.props || [] : [];
  out.push(`<clipPath id="clip-${theme}"><rect x="0" y="0" width="${w}" height="${h - bottom + 4}" rx="10"/></clipPath><g clip-path="url(#clip-${theme})">`);
  for (const p of props) {
    const sz = p.size || [1, 1, 1];
    const pw = Math.max(4, sz[0] * s), pd = Math.max(4, sz[2] * s);
    out.push(`<rect x="${f1(X(p.position[0]) - pw / 2)}" y="${f1(Y(p.position[2]) - pd / 2)}" width="${f1(pw)}" height="${f1(pd)}" rx="2" fill="${T.prop}" stroke="${T.propLine}" stroke-width="1"/>`);
    if (pw > 40) out.push(`<text x="${X(p.position[0])}" y="${f1(Y(p.position[2]) + 4)}" font-size="10" fill="${T.muted}" text-anchor="middle">${esc(niceName(p.name || p.kind))}</text>`);
  }
  out.push("</g>");
  // labels never sit on each other: each tries right, below, above, left of its mark until one is free
  const placed = [];
  const label = (x, y, text, size, weight, fill) => {
    const tw = text.length * size * 0.56, th = size + 2;
    const tries = [[12, 14], [12, -6], [-12 - tw, 14], [-12 - tw, -6], [-tw / 2, 26], [-tw / 2, -16], [12, 28], [12, -20]];
    let best = tries[0];
    for (const [dx, dy] of tries) {
      const r = { x: x + dx, y: y + dy - size, w: tw, h: th };
      if (r.x < 4 || r.x + r.w > w - 4 || r.y < 2 || r.y + r.h > h - 18) continue;
      if (!placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y)) { best = [dx, dy]; break; }
    }
    placed.push({ x: x + best[0], y: y + best[1] - size, w: tw, h: th });
    return `<text x="${f1(x + best[0])}" y="${f1(y + best[1])}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(text)}</text>`;
  };
  // cameras (under the actors): cone, track, letter
  const live = rows.filter((r) => !r.gone);
  const shots = new Map((stage?.shots || []).map((x) => [x.id, x]));
  for (const r of live) {
    const sh = shots.get(r.id);
    if (!sh) continue;
    const wk = worldCameraKeys(stage, sh);
    const k = wk[0];
    if (!k?.position) continue;
    const col = r.dropped ? T.dropped : T.cam;
    const px = X(k.position[0]), py = Y(k.position[2]);
    const tg = k.target || [k.position[0], 0, k.position[2] + 1];
    const ang = Math.atan2(-(tg[2] - k.position[2]), tg[0] - k.position[0]);   // screen angle (y down)
    const hf = Math.atan(SENSOR_W / 2 / Math.max(8, k.focal_mm || 35));
    const L = Math.max(34, Math.min(90, 4.5 * s));
    const a1 = ang - hf, a2 = ang + hf;
    out.push(`<path d="M${px},${py} L${f1(px + L * Math.cos(a1))},${f1(py + L * Math.sin(a1))} A${L},${L} 0 0 1 ${f1(px + L * Math.cos(a2))},${f1(py + L * Math.sin(a2))} Z" fill="${r.dropped ? "none" : T.camFill}" stroke="${col}" stroke-width="1.2" ${r.dropped ? 'stroke-dasharray="2 3"' : ""}/>`);
    if (wk.length > 1) {
      const pl = wk.map((q) => `${X(q.position[0])},${Y(q.position[2])}`).join(" ");
      out.push(`<polyline points="${pl}" fill="none" stroke="${col}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#ar-${theme})"/>`);
    }
    out.push(`<circle cx="${px}" cy="${py}" r="9" fill="${col}"/><text x="${px}" y="${f1(py + 3.6)}" font-size="10.5" font-weight="700" fill="${T.camInk}" text-anchor="middle">${esc(r.letter)}</text>`);
  }
  // actors: path, marks, body
  const last = Math.max(1, (stage?.shot?.frames || 97) - 1);
  const actors = stage?.actors || [];
  const labels = [];
  for (const a of actors) {
    if (a.mount_id || a.carry_id) continue;
    const kind = kindOf(a);
    const col = kind === "person" ? T.actor : kind === "vehicle" ? T.vehicle : kind === "animal" ? T.animal : T.muted;
    const keys = a.keys?.length ? [...a.keys].sort((p, q) => p.frame - q.frame) : [{ frame: 0, position: a.position || [0, 0, 0] }, ...(a.position_end ? [{ frame: last, position: a.position_end }] : [])];
    const moved = keys.length > 1 && Math.hypot(keys[keys.length - 1].position[0] - keys[0].position[0], keys[keys.length - 1].position[2] - keys[0].position[2]) > 0.3;
    if (moved) {
      out.push(`<polyline points="${keys.map((k) => `${X(k.position[0])},${Y(k.position[2])}`).join(" ")}" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="6 4" marker-end="url(#ar-${theme})" opacity="0.9"/>`);
    }
    const riders = actors.filter((r) => r.mount_id === a.id).map((r) => niceName(r.name || r.kind));
    const lbl = riders.length ? `${riders.join(", ")} (${niceName(a.name || a.kind)})` : niceName(a.name || a.kind);
    const st = actorAt(a, 0, last);
    const p0 = st.position;
    const x0 = X(p0[0]), y0 = Y(p0[2]);
    if (kind === "vehicle") {
      const L = Math.max(14, 4.5 * s), W = Math.max(7, 1.9 * s);
      const deg = f1((st.heading * 180) / Math.PI);
      out.push(`<rect x="${f1(x0 - W / 2)}" y="${f1(y0 - L / 2)}" width="${f1(W)}" height="${f1(L)}" rx="${f1(W / 3)}" fill="none" stroke="${col}" stroke-width="1.8" transform="rotate(${deg} ${x0} ${y0})"/>`);
    } else if (kind === "animal") {
      const L = Math.max(10, 2.3 * s), W = Math.max(6, 0.8 * s);
      out.push(`<ellipse cx="${x0}" cy="${y0}" rx="${f1(W / 2)}" ry="${f1(L / 2)}" fill="none" stroke="${col}" stroke-width="1.6" transform="rotate(${f1((st.heading * 180) / Math.PI)} ${x0} ${y0})"/>`);
    } else {
      out.push(`<circle cx="${x0}" cy="${y0}" r="${f1(Math.max(6, 0.35 * s))}" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="1.8"/>`);
    }
    // marks: 1 where they start, 2 where they end
    const mark = (p, n) => `<g><circle cx="${f1(X(p[0]) + 9)}" cy="${f1(Y(p[2]) - 9)}" r="6" fill="${T.bg}" stroke="${col}" stroke-width="1"/><text x="${f1(X(p[0]) + 9)}" y="${f1(Y(p[2]) - 6.4)}" font-size="8" font-weight="700" fill="${col}" text-anchor="middle">${n}</text></g>`;
    if (moved) { out.push(mark(keys[0].position, 1)); out.push(mark(keys[keys.length - 1].position, 2)); }
    labels.push([x0, y0, lbl]);
  }
  for (const [x, y, t] of labels) out.push(label(x, y, t, 10.5, 600, T.ink));
  // north arrow + scale bar
  const bar = [1, 2, 5, 10, 20].find((m) => m * s >= 40) || 20;
  out.push(`<g font-size="9.5" fill="${T.muted}"><line x1="12" y1="${h - 9}" x2="${f1(12 + bar * s)}" y2="${h - 9}" stroke="${T.muted}" stroke-width="1.5"/>`
    + `<text x="${f1(16 + bar * s)}" y="${h - 6}">${bar} m</text>`
    + `<text x="${w - 14}" y="${h - 6}" text-anchor="end">N ↑ · top view</text></g>`);
  out.push("</svg>");
  return out.join("");
}

/** A frame-edge arrow for a camera move on a storyboard frame (Hitchcock / Scorsese boards). '' for a static shot. */
export function moveArrowSVG(move, { w = 160, h = 90, color = "#f2ff59" } = {}) {
  const all = String(move || "");
  const m = /rides with/.test(all) && all.split(", ").length === 1 ? all : all.split(", ")[0];   // the main move only: one clear arrow
  if (!m || m === "static") return "";
  const parts = [];
  const A = (x1, y1, x2, y2) => parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.4" stroke-linecap="round" marker-end="url(#mv)"/>`);
  if (/push in|zoom in/.test(m)) { A(w * 0.18, h * 0.2, w * 0.34, h * 0.36); A(w * 0.82, h * 0.2, w * 0.66, h * 0.36); A(w * 0.18, h * 0.8, w * 0.34, h * 0.64); A(w * 0.82, h * 0.8, w * 0.66, h * 0.64); }
  if (/pull out|zoom out/.test(m)) { A(w * 0.34, h * 0.36, w * 0.18, h * 0.2); A(w * 0.66, h * 0.36, w * 0.82, h * 0.2); A(w * 0.34, h * 0.64, w * 0.18, h * 0.8); A(w * 0.66, h * 0.64, w * 0.82, h * 0.8); }
  if (/track left|pan left/.test(m)) A(w * 0.62, h * 0.9, w * 0.38, h * 0.9);
  if (/track right|pan right/.test(m)) A(w * 0.38, h * 0.9, w * 0.62, h * 0.9);
  if (/crane up/.test(m)) A(w * 0.94, h * 0.62, w * 0.94, h * 0.38);
  if (/crane down/.test(m)) A(w * 0.94, h * 0.38, w * 0.94, h * 0.62);
  if (/rides with/.test(m) && !parts.length) A(w * 0.4, h * 0.9, w * 0.6, h * 0.9);
  if (!parts.length) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="ss-bk-arrow" aria-hidden="true"><defs><marker id="mv" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>${parts.join("")}</svg>`;
}
