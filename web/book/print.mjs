// The Director's Book as a printed binder (Milestone 23): one HTML document typeset for paper (US Letter), which the
// browser prints to PDF (Export PDF opens the print dialog on it; the tests and the evidence use headless Chrome's
// printToPDF on the same HTML). Cover, the director's statement, contents, then per scene: the cover sheet (Coppola's
// five boxes, lighting, performance, the sound lane), the script page with margin notes in layers, and the plan (floor
// plan, numbered shot strip, camera plan, continuity and the lined-script strip). Revision history and About close it.
//
//   printHTML(book, script, pages, { frames: {shotId: url}, plans: {sceneId: svg}, date })

import { FIELDS, CAT, CATEGORIES, SOURCES, niceName, notesForScene, globalNotes, unsortedNotes, linedStrip, REV_COLOURS } from "./model.mjs";
import { moveArrowSVG } from "./floorplan.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const para = (t) => esc(t).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
const REV_HEX = { White: "#ffffff", Blue: "#cfe3ff", Pink: "#ffd6e2", Yellow: "#fff3b0", Green: "#d4f2d0", Goldenrod: "#f3d68b",
  Buff: "#f1e4c8", Salmon: "#ffcfb8", Cherry: "#f7b6bd", Tan: "#e3d2b6" };
const LEFT = new Set(["subtext", "performance"]);

const CSS = `
@page { size: Letter; margin: 0.6in 0.65in 0.7in; }
@page :first { margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #1d1a17; background: #fff; font: 10pt/1.48 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; }
h1, h2, h3, h4 { font-weight: 400; margin: 0; }
.lbl { font: 600 7.4pt/1.2 "Soundstage Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #8a8178; }
.sheet { page-break-after: always; break-after: page; position: relative; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
/* cover */
.cover { height: 11in; padding: 1.1in 0.95in 0.9in; display: flex; flex-direction: column; background: #f7f3ec; }
.cover .rule { height: 3px; background: #1d1a17; width: 64px; margin: 0 0 28px; }
.cover .kicker { margin-bottom: 18px; }
.cover h1 { font-size: 40pt; line-height: 1.04; letter-spacing: -.01em; }
.cover .by { margin-top: 14px; font-size: 12pt; color: #5d554d; font-style: italic; }
.cover .spine { margin-top: auto; border-top: 1px solid #cfc6ba; padding-top: 18px; }
.cover .spine p { font-size: 17pt; line-height: 1.3; margin: 8px 0 0; font-style: italic; }
.cover .foot { margin-top: 26px; display: flex; justify-content: space-between; align-items: flex-end; color: #6c655d; font-size: 8.5pt; }
.cover .rev { display: inline-flex; align-items: center; gap: 6px; }
.cover .rev i { display: inline-block; width: 14px; height: 14px; border: 1px solid #b9b1a6; border-radius: 3px; }
.mark { font: 700 9pt/1 "Soundstage Grotesk", Helvetica, sans-serif; letter-spacing: .2em; }
/* front matter */
.front h2 { font-size: 22pt; margin: 6px 0 18px; }
.front .statement { font-size: 12.5pt; line-height: 1.55; max-width: 6.2in; }
.front ul { padding-left: 1.1em; margin: 6px 0 0; }
.front li { margin: 3px 0; }
.toc { margin-top: 28px; }
.toc .row { display: grid; grid-template-columns: 0.55in 1fr auto; gap: 10px; padding: 7px 0; border-bottom: 1px dotted #cfc6ba; align-items: baseline; }
.toc .n { font: 600 10pt "Soundstage Grotesk", Helvetica, sans-serif; }
.toc .h { font-variant: small-caps; letter-spacing: .03em; }
.toc .s { color: #6c655d; font-size: 8.5pt; font-style: italic; }
/* scene head */
.shead { display: flex; align-items: baseline; gap: 14px; border-bottom: 1.5px solid #1d1a17; padding-bottom: 6px; margin-bottom: 4px; }
.shead .num { font: 700 20pt/1 "Soundstage Grotesk", Helvetica, sans-serif; }
.shead h2 { font-size: 13pt; letter-spacing: .04em; text-transform: uppercase; flex: 1; }
.shead .pg { font-size: 8pt; color: #8a8178; }
.spinebar { font-size: 8.5pt; color: #8a8178; font-style: italic; margin: 0 0 12px; }
.lined { display: flex; gap: 14px; font: 8pt "Soundstage Grotesk", Helvetica, sans-serif; color: #5d554d; margin: 0 0 12px; }
.lined b { color: #1d1a17; }
/* cover sheet */
.boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; font-size: 9pt; line-height: 1.4; }
.box { border: 1px solid #dcd4c9; border-radius: 6px; padding: 7px 10px 8px; break-inside: avoid; background: #fffdfa; }
.box.wide { grid-column: 1 / -1; }
.box.core { background: #f7f3ec; border-color: #cfc6ba; }
.box.core p { font-size: 11pt; font-style: italic; }
.box p { margin: 4px 0 0; }
.box ul { margin: 4px 0 0; padding-left: 1.1em; }
.box .inprompt { margin-top: 5px; font-size: 8pt; color: #6c655d; }
.src { float: right; font: 6.8pt "Soundstage Grotesk", Helvetica, sans-serif; color: #a39a90; letter-spacing: .06em; text-transform: uppercase; }
.perf { display: grid; grid-template-columns: 1.2in 1fr; gap: 3px 10px; margin-top: 4px; }
.perf b { font-variant: small-caps; letter-spacing: .04em; font-weight: 600; }
.lane { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 8.4pt; }
.lane td { padding: 3px 6px 3px 0; vertical-align: top; border-top: 1px solid #eee8df; }
.lane td:first-child { width: 48%; }
.lane .why { color: #5d554d; font-style: italic; }
/* script page with margins */
.scriptpage { display: grid; grid-template-columns: 1.55in 1fr 1.75in; column-gap: 12px; }
.scriptpage .colhead { padding-bottom: 6px; border-bottom: 1px solid #dcd4c9; margin-bottom: 8px; }
.scriptpage .row { display: contents; }
.scriptpage .txt { font: 9.6pt/1.42 "Courier Prime", "Courier New", Courier, monospace; padding: 4px 0 6px; white-space: pre-wrap; border-left: 1px solid #eee8df; border-right: 1px solid #eee8df; padding-left: 10px; padding-right: 10px; }
.scriptpage .txt.dialogue { padding-left: 0.9in; padding-right: 0.6in; }
.scriptpage .txt.parenthetical { padding-left: 1.25in; color: #5d554d; }
.scriptpage .txt.character { padding-left: 1.55in; text-transform: uppercase; padding-bottom: 0; }
.scriptpage .txt.transition { text-align: right; text-transform: uppercase; }
.scriptpage .txt.slug { font-weight: 700; text-transform: uppercase; }
.scriptpage .txt.has { background: linear-gradient(90deg, rgba(242,229,140,.0), rgba(242,229,140,.32)); }
.mn { font-size: 8pt; line-height: 1.32; padding: 4px 0; break-inside: avoid; }
.mn .n { border-left: 2.5px solid var(--c); padding: 1px 0 1px 6px; margin-bottom: 4px; }
.mn .n i { display: block; font: 600 6.6pt "Soundstage Grotesk", Helvetica, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--c); font-style: normal; }
.scenewide { margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.scenewide .n { font-size: 8.6pt; border-left: 2.5px solid var(--c); padding-left: 6px; max-width: 3.3in; }
.scenewide .n i { font: 600 6.6pt "Soundstage Grotesk", Helvetica, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--c); font-style: normal; margin-right: 5px; }
.legend { display: flex; gap: 10px; flex-wrap: wrap; margin: 2px 0 10px; font: 7pt "Soundstage Grotesk", Helvetica, sans-serif; color: #6c655d; }
.legend span::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--c); margin-right: 4px; vertical-align: -1px; }
/* plan page */
.plan svg { width: 100%; height: auto; border: 1px solid #dcd4c9; border-radius: 6px; }
.strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
.frame { break-inside: avoid; }
.frame .pic { position: relative; aspect-ratio: 16 / 9; background: #ece7df; border: 1px solid #cfc6ba; border-radius: 3px; overflow: hidden; }
.frame .pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.frame .pic svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.frame .no { font: 700 9pt "Soundstage Grotesk", Helvetica, sans-serif; margin-top: 3px; }
.frame .cap { font-size: 7.6pt; color: #5d554d; line-height: 1.3; }
.frame.dropped .pic::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top right, transparent calc(50% - 1px), #b0284a 50%, transparent calc(50% + 1px)); }
.frame.dropped .no, .frame.dropped .cap { text-decoration: line-through; color: #a39a90; }
table.cam { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 8.4pt; }
table.cam th { text-align: left; font: 600 6.8pt "Soundstage Grotesk", Helvetica, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #8a8178; border-bottom: 1px solid #1d1a17; padding: 3px 6px 3px 0; }
table.cam td { padding: 4px 6px 4px 0; border-bottom: 1px solid #eee8df; vertical-align: top; }
table.cam tr.dropped td { text-decoration: line-through; color: #a39a90; }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 12px; }
.about li { margin: 4px 0; }
.revs .r { display: grid; grid-template-columns: 22px 0.9in 1fr auto; gap: 10px; padding: 6px 0; border-bottom: 1px solid #eee8df; align-items: center; }
.revs .sw { width: 16px; height: 16px; border-radius: 3px; border: 1px solid #b9b1a6; }

`;

function srcTag(f) {
  return f.source === "llm" ? `<span class="src">AI draft</span>` : f.source === "rules" ? `<span class="src">from the stage</span>` : "";
}

function fieldHTML(def, f, constraints) {
  const v = f.value;
  if (def.kind === "text") return v ? `<p>${para(v)}</p>` : `<p style="color:#b9b1a6">—</p>`;
  if (def.kind === "list") {
    const ul = v.length ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p style="color:#b9b1a6">—</p>`;
    return ul + (def.key === "pitfalls" && constraints?.length ? `<div class="inprompt">In the prompts: ${esc(constraints.join("; "))}</div>` : "");
  }
  if (def.kind === "perf") return `<div class="perf">${Object.entries(v).map(([k, t]) => `<b>${esc(niceName(k))}</b><span>${esc(t)}</span>`).join("")}</div>`;
  if (def.kind === "sound") return v.length ? `<table class="lane"><tr><td class="lbl">We hear</td><td class="lbl">Why</td></tr>${v.map((r) => `<tr><td>${esc(r.hear)}</td><td class="why">${esc(r.why || "")}</td></tr>`).join("")}</table>` : `<p style="color:#b9b1a6">—</p>`;
  return "";
}

const noteHTML = (n) => `<div class="n" style="--c:${CAT[n.category]?.print || CAT[n.category]?.color || "#999"}"><i>${esc(CAT[n.category]?.label || n.category)}${n.character ? ` · ${esc(niceName(n.character))}` : ""}</i>${esc(n.text)}</div>`;
const PRINT_COL = { subtext: "#7b4fc4", performance: "#b0284a", blocking: "#1f5f99", camera: "#6b6b00", lighting: "#b56b00", sound: "#1d7a4a", continuity: "#6c655d" };
for (const c of CATEGORIES) CAT[c.key].print = PRINT_COL[c.key];

function scriptPageHTML(book, script, sc) {
  const notes = notesForScene(book, script, sc.id);
  const wide = notes.filter((n) => !Number.isInteger(n.line));
  const legend = CATEGORIES.map((c) => `<span style="--c:${c.print}">${c.label}</span>`).join("");
  const rows = [`<div class="txt slug">${esc(sc.number)}  ${esc(sc.heading)}</div>`];
  const out = [`<div class="lbl colhead">Subtext · Performance</div><div class="lbl colhead">The scene, as written</div><div class="lbl colhead">Camera · Light · Sound · Blocking</div>`,
    `<div></div>${rows[0]}<div></div>`];
  (sc.elements || []).forEach((e, i) => {
    const on = notes.filter((n) => n.line === i);
    const L = on.filter((n) => LEFT.has(n.category)), R = on.filter((n) => !LEFT.has(n.category));
    out.push(`<div class="mn">${L.map(noteHTML).join("")}</div><div class="txt ${esc(e.type)}${on.length ? " has" : ""}">${esc(e.text)}</div><div class="mn">${R.map(noteHTML).join("")}</div>`);
  });
  return `<div class="legend">${legend}</div>`
    + (wide.length ? `<div class="lbl" style="margin-bottom:4px">On the whole scene</div><div class="scenewide">${wide.map((n) => noteHTML(n).replace('class="n"', 'class="n"')).join("")}</div>` : "")
    + `<div class="scriptpage">${out.join("")}</div>`;
}

export function printHTML(book, script, pages, { frames = {}, plans = {}, date = new Date() } = {}) {
  const title = book.title || script?.title || "Director's Book";
  const rev = book.revisions[book.revisions.length - 1];
  const revCol = rev?.colour || REV_COLOURS[0];
  const dstr = date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const foot = "";
  const S = [];
  // cover
  S.push(`<section class="sheet cover"><div class="lbl kicker">A director's book</div><div class="rule"></div><h1>${esc(title)}</h1>
    ${script?.author ? `<div class="by">Written by ${esc(script.author)}</div>` : ""}
    <div class="spine"><div class="lbl">The spine</div><p>${esc(book.spine || "—")}</p></div>
    <div class="foot" style="position:static"><span class="rev"><i style="background:${REV_HEX[revCol] || "#fff"}"></i>${esc(revCol)} revision${rev ? ` · ${esc(rev.label)}` : ""}</span><span>${esc(dstr)}</span><span class="mark">SOUNDSTAGE</span></div></section>`);
  // statement + rules + contents
  const rules = [...book.rules, ...globalNotes(book).map((n) => n.text)];
  S.push(`<section class="sheet front">${foot}<div class="lbl">The whole film</div><h2>Director's statement</h2>
    <div class="statement"><p>${para(book.statement || "—")}</p></div>
    ${rules.length ? `<div class="lbl" style="margin-top:22px">Rules for every scene</div><ul>${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${book.constraints?.length || book.style?.length ? `<div class="lbl" style="margin-top:18px">In every prompt</div><p>${esc([...book.style, ...book.constraints].join("; "))}</p>` : ""}
    <div class="toc"><div class="lbl">Contents</div>${pages.map((pg) => `<div class="row"><span class="n">${esc(pg.scene.number)}</span><span><span class="h">${esc(pg.scene.heading)}</span><br><span class="s">${esc(pg.fields.core?.value || pg.fields.synopsis?.value || "")}</span></span><span class="s">${pg.shots.filter((r) => !r.dropped).length} shots</span></div>`).join("")}
    <div class="row"><span class="n">·</span><span class="h">Revision history · About this book</span><span></span></div></div></section>`);
  // scenes
  for (const pg of pages) {
    const sc = pg.scene, F = pg.fields;
    const ls = linedStrip(pg);
    const head = `<div class="shead"><span class="num">${esc(sc.number)}</span><h2>${esc(sc.heading)}</h2><span class="pg">${esc(title)} · ${esc(revCol)} revision</span></div>
      ${book.spine ? `<div class="spinebar">Spine: ${esc(book.spine)}</div>` : ""}
      <div class="lined"><span>Story day <b>${esc(ls.story_day || "—")}</b></span><span>Time <b>${esc(ls.time || "—")}</b></span><span>Planned <b>${ls.planned}</b></span><span>Shot <b>${ls.shot}</b></span><span>Cut <b>${ls.cut}</b></span>${ls.dropped ? `<span>Dropped <b>${ls.dropped}</b></span>` : ""}</div>`;
    const box = (key, cls = "") => {
      const def = FIELDS.find((x) => x.key === key);
      return `<div class="box ${cls}"><div class="lbl">${esc(def.label)}${srcTag(F[key])}</div>${fieldHTML(def, F[key], F.constraints?.value)}</div>`;
    };
    S.push(`<section class="sheet">${foot}${head}<div class="boxes">
      ${box("synopsis", "wide")}${box("times")}${box("imagery")}${box("core", "wide core")}${box("subtext", "wide")}${box("references")}${box("pitfalls")}
      ${box("lighting", "wide")}${box("performance", "wide")}${box("sound", "wide")}</div></section>`);
    S.push(`<section class="sheet">${foot}${head}${scriptPageHTML(book, script, sc)}</section>`);
    const strip = pg.shots.map((r) => {
      const url = frames[r.id];
      return `<div class="frame${r.dropped ? " dropped" : ""}"><div class="pic">${url ? `<img src="${url}" alt="">` : ""}${r.dropped ? "" : moveArrowSVG(r.move, { color: "#f2ff59" })}</div>
        <div class="no">${esc(r.no)}</div><div class="cap">${esc(r.name)} · ${esc(r.lens)}${r.move && r.move !== "static" ? ` · ${esc(r.move)}` : ""}</div></div>`;
    }).join("");
    const table = pg.shots.length ? `<table class="cam"><tr><th>No.</th><th>Shot</th><th>Lens</th><th>Height</th><th>Move</th><th>Rig</th><th>Status</th></tr>${pg.shots.map((r) =>
      `<tr class="${r.dropped ? "dropped" : ""}"><td><b>${esc(r.no)}</b></td><td>${esc(r.name)}${r.note ? `<br><i style="color:#6c655d">${esc(r.note)}</i>` : ""}</td><td>${esc(r.lens)}</td><td>${esc(r.height)}</td><td>${esc(r.move)}</td><td>${esc(r.rig)}</td><td>${esc(r.dropped ? "dropped" : r.status)}</td></tr>`).join("")}</table>` : "";
    S.push(`<section class="sheet plan">${foot}${head}<div class="lbl" style="margin-bottom:6px">Floor plan · cameras lettered as in the shot strip</div>${plans[sc.id] || ""}
      ${pg.shots.length ? `<div class="lbl" style="margin-top:12px">Shot strip</div><div class="strip">${strip}</div>${table}` : ""}
      <div class="cols2"><div class="box"><div class="lbl">Continuity & props${srcTag(F.continuity)}</div>${fieldHTML(FIELDS.find((x) => x.key === "continuity"), F.continuity)}</div>
      <div class="box"><div class="lbl">Lined script</div><p>Story day ${esc(ls.story_day || "—")} · ${esc(ls.time || "—")}<br>${ls.planned} planned · ${ls.shot} shot · ${ls.cut} in the cut${ls.dropped ? ` · ${ls.dropped} dropped` : ""}</p></div></div></section>`);
  }
  // unsorted, revisions, about
  const uns = unsortedNotes(book);
  S.push(`<section class="sheet front">${foot}<div class="lbl">Back matter</div><h2>Revision history</h2>
    <div class="revs">${book.revisions.length ? book.revisions.map((r) => `<div class="r"><span class="sw" style="background:${REV_HEX[r.colour] || "#fff"}"></span><b>${esc(r.colour)}</b><span>${esc(r.label)}${r.changed?.length ? ` <span style="color:#8a8178">· ${r.changed.length} part${r.changed.length === 1 ? "" : "s"} changed</span>` : ""}</span><span style="color:#8a8178">${esc(new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></div>`).join("") : `<p>No revision locked yet.</p>`}</div>
    ${uns.length ? `<h2 style="margin-top:26px">Unsorted notes</h2><ul>${uns.map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>` : ""}
    <h2 style="margin-top:26px">About this book</h2><p>Laid out like the directors' binders it learns from:</p>
    <ul class="about">${SOURCES.map(([s, w]) => `<li><b>${esc(s)}</b>: ${esc(w)}.</li>`).join("")}</ul>
    <p style="color:#6c655d;font-size:8.5pt;margin-top:14px">Drafts marked “AI draft” were written by a local model from the script and checked against it; “from the stage” is read off the Soundstage set. Everything else is the director's.</p></section>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Director's Book</title><style>${CSS}</style></head><body>${S.join("\n")}</body></html>`;
}
