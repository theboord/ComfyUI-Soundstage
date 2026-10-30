// Soundstage Script import: Fountain, Final Draft (.fdx), plain text and PDF -> one Script model, scene by scene.
// Import only. Nothing here writes or rewrites script text: outlines and breakdowns are lifted from the page, and the
// director's `notes` on each scene are the only free text, owned by the user and never auto-filled.
//
//   import { importScriptFile, parseScript, sceneSummaryLine, buildPromptForScene, mergeNotes } from "./script/parse.mjs";
//   const script = await importScriptFile(file);          // File from <input type=file> or a drop
//   script.scenes.map(sceneSummaryLine);                   // "Sc 12A · INT. DINER - NIGHT · 1 3/8 pg"
//   agent.describe(buildPromptForScene(script.scenes[0])); // build the scene on the stage
//   const next = mergeNotes(script, await importScriptFile(revisedFile));  // a new draft keeps notes and shot links
//
// Pure functions except importScriptFile/loadPdfJs. pdf.js loads from cdnjs only when a PDF is imported.
import { breakdownScene, stageHint, introducedNames, mapIntroduced, actionText } from "./breakdown.mjs";

export const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
export const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const LINES_PER_PAGE = 55; // rule of thumb for a formatted page of Courier 12
const WHOLE_SCRIPT = "Whole script";

/** Keys parseScript writes on a scene. Anything else on a scene (shot links, colours, ...) belongs to the app. */
export const SCENE_KEYS = ["id", "number", "numbered", "heading", "int_ext", "location", "time", "index", "eighths", "elements",
  "characters", "synopsis", "outline", "breakdown", "stage_hint", "notes", "section"];
const SCRIPT_KEYS = ["version", "title", "author", "format", "source_name", "scenes", "characters", "page_count_est", "warnings", "orphans", "compact"];

// ---------------------------------------------------------------------------------------------- small text helpers

const HEADING_RE = /^(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|E\s*\/\s*I|INT|EXT|EST)(?:\.|\s|$)/i;
const TIME_PART_RE = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|NOON|MIDDAY|MIDNIGHT|SUNSET|SUNRISE|SUNDOWN|TWILIGHT|DAYBREAK|NIGHTFALL|CONTINUOUS|LATER|SAME|SAME TIME|SIMULTANEOUS|MAGIC HOUR|GOLDEN HOUR|PRE-?DAWN|FIRST LIGHT|FLASHBACK|PRESENT|DAYTIME|NIGHTTIME)\b/i;
const TIME_WORDS = "DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|NOON|MIDDAY|MIDNIGHT|SUNSET|SUNRISE|SUNDOWN|TWILIGHT|DAYBREAK|" +
  "NIGHTFALL|CONTINUOUS|LATER|SAME|SAME TIME|SIMULTANEOUS|MAGIC HOUR|GOLDEN HOUR|PRE-?DAWN|FIRST LIGHT|FLASHBACK|PRESENT|" +
  "PRESENT DAY|DAYTIME|NIGHTTIME|DREAM|FANTASY|MOMENTS? LATER|SECONDS LATER|MINUTES LATER|HOURS LATER";
// A heading part made only of time words ("NIGHT", "MOMENTS LATER", "DAY (1985)"), as opposed to one that contains one.
const TIME_ONLY_RE = new RegExp(`^(?:(?:THE|NEXT|EARLY|LATE|A|FEW)\\s+)*(?:${TIME_WORDS})(?:[\\s/]+(?:${TIME_WORDS}))*(?:\\s*\\([^)]*\\))?\\.?$`, "i");
// "SMASH CUT:", "JUMP CUT.", "MATCH DISSOLVE TO:" (TRANSITIONS and "...TO:" cover the rest).
const CUT_RE = /^[A-Z][A-Z ]*\b(?:CUT|DISSOLVE|WIPE)[:.]$/;
const TRANSITIONS = new Set(["FADE IN:", "FADE IN.", "FADE OUT.", "FADE OUT", "FADE TO BLACK.", "FADE TO BLACK", "CUT TO BLACK.",
  "CUT TO BLACK", "FADE TO WHITE.", "BLACKOUT.", "SMASH TO BLACK.", "INTERCUT WITH:", "INTERCUT:"]);
const SHOT_RE = /^(ANGLE ON|ANOTHER ANGLE|REVERSE ANGLE|CLOSE ON|CLOSE UP|CLOSE-UP|CLOSEUP|EXTREME CLOSE|ECU|INSERT|WIDE ON|WIDE SHOT|WIDE|POV|P\.O\.V\.|.+['’]S POV|BACK TO SCENE|BACK TO|OVERHEAD|AERIAL|TRACKING|MOVING|TWO SHOT|TWO-SHOT|OVER THE SHOULDER|ON THE)\b/;
const NON_CUE = /^(THE END|END|FADE IN|FADE OUT|CONTINUED|MORE|INTERCUT|BACK TO SCENE|LATER|SUPER|TITLE|BLACK|BLACKOUT|SILENCE|MONTAGE|END MONTAGE|FLASHBACK|END FLASHBACK|SERIES OF SHOTS|BEGIN|BEGIN MONTAGE|OMITTED|CUT TO|DISSOLVE TO)$/;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const squash = (s) => String(s ?? "").replace(/[ \t ]+/g, " ").trim();
const isUpper = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

/** Strip Fountain emphasis (*italic*, **bold**, ***both***, _underline_); \* stays a literal star. */
export function stripEmphasis(s) {
  let t = String(s ?? "").replace(/\\\*/g, "\u0002").replace(/\\_/g, "\u0003");
  for (let i = 0; i < 3; i++) {
    t = t.replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, "$2").replace(/(?<![A-Za-z0-9])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9])/g, "$1");
  }
  return t.replace(/\u0002/g, "*").replace(/\u0003/g, "_");
}

/** Cue -> speaking name: drops (V.O.) (O.S.) (O.C.) (CONT'D) and any other extension, the ^ dual marker, @, colons. */
export function normalizeCharacter(cue) {
  return String(cue ?? "")
    .replace(/^\s*@/, "").replace(/\^\s*$/, "")
    .replace(/\([^)]*\)?/g, " ")
    .replace(/\b(?:CONT['’]?D|CONTINUED|CONT\.)\s*$/i, "")
    .replace(/(?:^|\s)(?:V\.O\.|O\.S\.|O\.C\.)\s*$/i, "")
    .replace(/[:\s]+$/, "").replace(/\s+/g, " ").trim().toUpperCase();
}

/** "INT. DINER - NIGHT" -> {int_ext: "INT", location: "DINER", time: "NIGHT"}. */
export function parseHeading(raw) {
  const h = squash(raw);
  const m = h.match(/^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|E\s*\/\s*I|INT|EXT|EST)\.?\s*/i);
  let int_ext = "", rest = h;
  if (m) {
    const k = m[1].toUpperCase().replace(/[\s.]/g, "");
    int_ext = k === "INT" ? "INT" : k === "EXT" || k === "EST" ? "EXT" : "INT/EXT";
    rest = h.slice(m[0].length);
  }
  const parts = rest.split(/\s+[-–—]+\s+|\s*[–—]+\s*/).map((p) => p.trim()).filter(Boolean);
  // "ROOFTOP-NIGHT": a hyphen with no spaces splits only when the right side is a time ("X-RAY ROOM" stays whole).
  const tail = parts.length ? parts[parts.length - 1].match(/^(.*[^\s-])-([^-]+)$/) : null;
  if (tail && TIME_ONLY_RE.test(tail[2].trim())) parts.splice(parts.length - 1, 1, tail[1].trim(), tail[2].trim());
  let time = "", location = rest.trim();
  if (parts.length > 1 && TIME_PART_RE.test(parts[parts.length - 1])) {
    // "DAY - FLASHBACK", "NIGHT - CONTINUOUS": every trailing time part is the time, not just the last one. Further parts
    // must be nothing but time words, so "DINER - MORNING SHOW - DAY" keeps its location; one part always stays.
    const times = [parts.pop()];
    while (parts.length > 1 && TIME_ONLY_RE.test(parts[parts.length - 1])) times.unshift(parts.pop());
    time = times.map((t) => t.replace(/\.+$/, "")).join(" - ").toUpperCase();
    location = parts.join(" - ");
  }
  return { int_ext, location: location.replace(/[.\s]+$/, ""), time };
}

/** 11 -> "1 3/8"; eighths are never reduced (4/8, not 1/2), as on a stripboard. */
export function formatEighths(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const whole = Math.floor(v / 8), rem = v % 8;
  if (!whole) return rem ? `${rem}/8` : "0";
  return rem ? `${whole} ${rem}/8` : `${whole}`;
}

/** "1 3/8" -> 11, "4/8" -> 4, "2" -> 16; anything else -> 0. */
export function parseEighths(s) {
  const m = squash(s).match(/^(?:(\d+)(?:\s+|$))?(?:(\d)\/8)?$/);
  if (!m || (!m[1] && !m[2])) return 0;
  return (Number(m[1]) || 0) * 8 + (Number(m[2]) || 0);
}

/** "Sc 12A · INT. DINER - NIGHT · 1 3/8 pg" */
export function sceneSummaryLine(scene) {
  const s = scene || {};
  return `Sc ${s.number || "?"} · ${s.heading || WHOLE_SCRIPT} · ${formatEighths(s.eighths || 0)} pg`;
}

function trimTo(s, n) {
  const t = squash(String(s).replace(/\n+/g, " "));
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

// ---------------------------------------------------------------------------------------------- format detection

function fountainScore(text) {
  const t = String(text || "");
  let s = 0;
  if (/^\s*(title|credit|author|authors|draft date|contact)\s*:/i.test(t)) s += 2;
  if (/^[ \t]*(?:INT|EXT|EST|I\/E)[^\n]*#[\w.-]+#[ \t]*$/im.test(t)) s += 2;
  if (/\[\[[\s\S]*?\]\]/.test(t)) s += 1;
  if (/\/\*[\s\S]*?\*\//.test(t)) s += 1;
  if (/^\.[A-Z][^.\n]/m.test(t)) s += 1;
  if (/^>[^\n]*$/m.test(t)) s += 1;
  if (/^=[^=\n]/m.test(t)) s += 1;
  if (/^~/m.test(t)) s += 1;
  if (/^[ \t]*[A-Z][A-Z .'-]+[ \t]*\^[ \t]*$/m.test(t)) s += 1;
  if (/^#{1,6} \S/m.test(t)) s += 1;
  if (/^={3,}[ \t]*$/m.test(t)) s += 1;
  if (/\*\*[^*\n]+\*\*/.test(t)) s += 1;
  // Page furniture means a PDF copy/paste, not Fountain.
  if (/^\s*\(MORE\)\s*$/m.test(t)) s -= 2;
  if (/\bCONTINUED:/.test(t)) s -= 2;
  if (/^\s*\d{1,3}\.\s*$/m.test(t)) s -= 1;
  if (/^\s*\d+[A-Z]?\s+(?:INT|EXT)\.[^\n]*\s\d+[A-Z]?\s*$/m.test(t)) s -= 2;
  return s;
}

/** 'fountain' | 'fdx' | 'text' | 'pdf', from the extension first, then a sniff of the text. */
export function detectFormat(fileName = "", text = "") {
  const ext = ((String(fileName || "").match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
  const head = String(text || "").slice(0, 4000);
  if (ext === "pdf" || head.startsWith("%PDF")) return "pdf";
  if (ext === "fdx" || /<FinalDraft[\s>]/i.test(head)) return "fdx";
  if (ext === "fountain" || ext === "spmd") return "fountain";
  return fountainScore(text) >= 2 ? "fountain" : "text";
}

// ---------------------------------------------------------------------------------------------- Fountain

const TITLE_KEY_RE = /^\s*(title|credit|author|authors|source|draft date|date|contact|copyright|notes|revision|series|episode)\s*:/i;
const NOTE_MARK = /\u0001(\d+)\u0001/g;
// "Written by" / "by" / "by Jane Doe" on a title page; "By the window, ..." is action, not a credit.
const BY_RE = /^(?:(?:written|screenplay|teleplay|story)\s+)?by\b:?(?:\s+[A-Z][\w.'’-]*(?:\s+(?:[A-Z][\w.'’-]*|&|and)){0,4})?\s*$/i;
const BY_PREFIX = /^(?:(?:written|screenplay|teleplay|story)\s+)?by\b:?\s*/i;

function parseFountain(src) {
  const meta = { title: "", author: "" };
  let text = String(src).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const notes = [];
  text = text.replace(/\[\[([\s\S]*?)\]\]/g, (_, n) => { notes.push(squash(n.replace(/\n/g, " "))); return `\u0001${notes.length - 1}\u0001`; });
  const lines = text.split("\n");

  let k = 0;
  while (k < lines.length && !lines[k].trim()) k++;
  if (TITLE_KEY_RE.test(lines[k] || "")) {
    const tp = {};
    let key = null;
    for (; k < lines.length && lines[k].trim(); k++) {
      const l = lines[k].replace(NOTE_MARK, "");
      const m = l.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
      if (m && !/^\s/.test(l)) { key = m[1].toLowerCase(); tp[key] = m[2].trim() ? [m[2].trim()] : []; }
      else if (key) tp[key].push(l.trim());
    }
    meta.title = squash(stripEmphasis((tp.title || []).join(" ")));
    meta.author = squash(stripEmphasis((tp.author || tp.authors || []).join(", ")));
  }

  const tokens = [];
  const blank = (i) => i < 0 || i >= lines.length || !lines[i].trim();
  let inDialogue = false, speaker = "", para = null;
  let pending = []; // inline notes inside an open action/lyric paragraph follow that paragraph
  const flush = () => { if (para) tokens.push(para); para = null; tokens.push(...pending); pending = []; };
  const el = (type, txt, extra) => { flush(); tokens.push({ t: "el", type, text: squash(stripEmphasis(txt)), ...extra }); };
  const emitNotes = (ids) => ids.forEach((id) => notes[id] && (para ? pending : tokens).push({ t: "el", type: "note", text: notes[id] }));

  for (let i = k; i < lines.length; i++) {
    const raw = lines[i];
    const ids = [];
    let t = raw.replace(NOTE_MARK, (_, n) => { ids.push(Number(n)); return ""; }).trim();
    if (!raw.trim()) { inDialogue = false; flush(); continue; }
    if (!t) { emitNotes(ids); continue; }  // a note on its own line; dialogue state is untouched
    const prevBlank = blank(i - 1), nextBlank = blank(i + 1);

    if (/^={3,}$/.test(t)) { flush(); inDialogue = false; continue; }  // page break
    if (inDialogue) {
      const last = tokens[tokens.length - 1];
      if (/^\(.*\)$/.test(t)) tokens.push({ t: "el", type: "parenthetical", text: squash(stripEmphasis(t)), character: speaker });
      else if (last && last.type === "dialogue") last.text = squash(`${last.text} ${stripEmphasis(t)}`);
      else tokens.push({ t: "el", type: "dialogue", text: squash(stripEmphasis(t)), character: speaker });
      emitNotes(ids);
      continue;
    }
    if (/^#+/.test(t) && !/^#[^#\s]+#$/.test(t)) {
      flush();
      tokens.push({ t: "section", depth: t.match(/^#+/)[0].length, text: squash(stripEmphasis(t.replace(/^#+/, ""))) });
      continue;
    }
    if (/^=(?!=)/.test(t)) { flush(); tokens.push({ t: "synopsis", text: squash(stripEmphasis(t.slice(1))) }); continue; }
    const forced = /^\.(?!\.)(?=\S)/.test(t);
    if (forced || (HEADING_RE.test(t) && prevBlank && (nextBlank || headingShaped(t)))) {
      flush();
      let h = forced ? t.slice(1) : t, number = null;
      h = h.replace(/\s*#([^#\s]+)#\s*$/, (_, n) => { number = n; return ""; });
      tokens.push({ t: "heading", text: squash(stripEmphasis(h)), number, forced });
      emitNotes(ids);
      continue;
    }
    if (/^>.*<$/.test(t)) { el("centered", t.slice(1, -1)); emitNotes(ids); continue; }
    if (/^>/.test(t)) { el("transition", t.slice(1)); emitNotes(ids); continue; }
    if (/^~/.test(t)) {
      const line = squash(stripEmphasis(t.slice(1)));
      if (para && para.type === "lyric") para.text += `\n${line}`;
      else { flush(); para = { t: "el", type: "lyric", text: line }; }
      emitNotes(ids);
      continue;
    }
    if (/^@/.test(t) || (!/^!/.test(t) && prevBlank && !nextBlank && isCueLine(t))) {
      const cue = t.replace(/^@/, "");
      const dual = /\^\s*$/.test(cue);
      speaker = normalizeCharacter(cue);
      el("character", cue.replace(/\s*\^\s*$/, ""), { character: speaker, ...(dual ? { dual: true } : {}) });
      inDialogue = true;
      emitNotes(ids);
      continue;
    }
    if (!/^!/.test(t) && isUpper(t) && prevBlank && nextBlank && (/\bTO:$/.test(t) || CUT_RE.test(t) || TRANSITIONS.has(t))) {
      el("transition", t); emitNotes(ids); continue;
    }
    if (!/^!/.test(t) && isUpper(t) && prevBlank && SHOT_RE.test(t)) { el("shot", t); emitNotes(ids); continue; }
    const line = squash(stripEmphasis(t.replace(/^!/, "")));
    if (para && para.type === "action") para.text += `\n${line}`;
    else { flush(); para = { t: "el", type: "action", text: line }; }
    emitNotes(ids);
  }
  flush();
  return { tokens, meta };
}

// The Fountain spec wants a blank line before and after a heading; without the one after, the line must also look like
// one (upper case, or "PLACE - TIME"), so "Est. 1892 by the founders." on a plaque stays action.
function headingShaped(t) {
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.8) return true;
  return /\s[-–—]+\s/.test(t) && TIME_PART_RE.test(t.split(/\s[-–—]+\s/).pop());
}

// A character cue: an upper-case name (extensions in parentheses may be lower case), short, not a known non-name.
function isCueLine(t) {
  const name = t.replace(/\^\s*$/, "").replace(/\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 38 || !isUpper(name) || /^[\d\W]+$/.test(name)) return false;
  if (/[:!?,;]$/.test(name) || (/\.$/.test(name) && !/\b(MR|MRS|MS|DR|ST|JR|SR)\.$/.test(name))) return false;
  if (name.split(" ").length > 5 || NON_CUE.test(name) || HEADING_RE.test(name) || SHOT_RE.test(name)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------- Final Draft (.fdx)

const FDX_TYPES = {
  "scene heading": "heading", action: "action", character: "character", dialogue: "dialogue", parenthetical: "parenthetical",
  transition: "transition", shot: "shot", general: "action", lyrics: "lyric", "new act": "section", "act break": "section",
  "end of act": "skip", "cast list": "skip", outline: "skip", "outline 1": "skip", "outline 2": "skip", "outline 3": "skip",
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ""; }
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k];
  });
}

const attr = (attrs, name) => {
  const m = String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : "";
};

// Tag-by-tag scan (no DOMParser, so it runs in node too). Paragraphs nest inside <DualDialogue>; Text runs concatenate.
function fdxParagraphs(xml) {
  const out = [];
  const stack = [];
  let inText = null, last = 0, dual = 0, dualCues = 0;
  const re = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (inText && stack.length) {
      let s = decodeEntities(xml.slice(last, m.index));
      if (/allcaps/i.test(inText)) s = s.toUpperCase();
      stack[stack.length - 1].text += s;
    }
    last = re.lastIndex;
    const [, close, tag, attrs, self] = m;
    const T = tag.toLowerCase();
    if (T === "paragraph") {
      if (close) { const p = stack.pop(); if (p) out.push(p); }
      else {
        const p = { type: attr(attrs, "Type"), number: attr(attrs, "Number"), text: "", length: "", dual: false };
        if (dual && /^character$/i.test(p.type)) p.dual = ++dualCues > 1;
        if (self) out.push(p); else stack.push(p);
      }
    } else if (T === "text") {
      inText = !close && !self ? attr(attrs, "Style") || " " : null;
    } else if (T === "sceneproperties" && stack.length) {
      stack[stack.length - 1].length = attr(attrs, "Length");
    } else if (T === "dualdialogue") {
      if (close) dual = Math.max(0, dual - 1);
      else if (!self) { dual++; dualCues = 0; }
    }
  }
  return out;
}

function parseFdx(src) {
  const xml = String(src);
  const meta = { title: "", author: "" };
  const tp = xml.match(/<TitlePage\b[^>]*>([\s\S]*?)<\/TitlePage>/i);
  if (tp) {
    const lines = fdxParagraphs(tp[1]).map((p) => squash(p.text)).filter(Boolean);
    const by = lines.findIndex((l) => BY_RE.test(l));
    if (by >= 0) {
      meta.title = lines.slice(Math.max(0, by - 3), by).join(" ");
      const inline = lines[by].replace(BY_PREFIX, "");
      meta.author = inline || lines[by + 1] || "";
    } else meta.title = lines[0] || "";
  }
  // Only the script body: headers/footers, the title page, SmartType lists and notes all carry <Paragraph><Text> too.
  const body = xml.replace(/<TitlePage\b[\s\S]*?<\/TitlePage>/gi, " ")
    .replace(/<HeaderAndFooter\b[\s\S]*?<\/HeaderAndFooter>/gi, " ")
    .replace(/<SmartType\b[\s\S]*?<\/SmartType>/gi, " ")
    .replace(/<ScriptNotes?\b[\s\S]*?<\/ScriptNotes?>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const tokens = [];
  let speaker = "";
  for (const p of fdxParagraphs(body)) {
    const text = squash(p.text);
    if (!text) continue;
    const type = FDX_TYPES[String(p.type || "").toLowerCase()] || "action";
    if (type === "skip") continue;
    if (type === "heading") { tokens.push({ t: "heading", text, number: p.number || null, eighths: parseEighths(p.length) }); continue; }
    if (type === "section") { tokens.push({ t: "section", depth: 1, text }); continue; }
    if (type === "character") {
      speaker = normalizeCharacter(text);
      tokens.push({ t: "el", type, text: text.replace(/\s*\^\s*$/, ""), character: speaker, ...(p.dual ? { dual: true } : {}) });
      continue;
    }
    if (type === "dialogue" || type === "parenthetical") { tokens.push({ t: "el", type, text, character: speaker }); continue; }
    tokens.push({ t: "el", type, text });
  }
  return { tokens, meta };
}

// ---------------------------------------------------------------------------------------------- plain text & PDF lines

// Page furniture from a PDF: page numbers, CONTINUED headers/footers, revision headers.
const PAGE_NUM_RE = /^\s*(?:page\s+)?\d{1,4}[A-Z]?\.?\s*(?:of\s+\d+)?\s*$/i;
const BARE_NUM_RE = /^\d{1,4}[A-Z]?\.?$/;
const CONTINUED_RE = /^\s*(?:[A-Z]?\d{1,4}[A-Z]{0,3}\s+)?\(?\s*CONT(?:INUED|['’]?D)\s*[:)]?\s*(?:\(\s*\d+\s*\))?\s*(?:[A-Z]?\d{1,4}[A-Z]{0,3})?\s*$/i;
const REVISION_RE = /^\s*(?:(?:White|Blue|Pink|Yellow|Green|Goldenrod|Buff|Salmon|Cherry|Tan|Gray|Grey|Ivory)\s+)?(?:Rev\.?|Revised|Revision|Draft)\b[^\n]{0,40}\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[^\n]{0,30}$/i;
const MORE_RE = /^\s*\(\s*MORE\s*\)\s*$/i;
const SCENE_NO = "(?:\\d{1,4}[A-Z]{0,3}|[A-Z]{1,2}\\d{1,4}[A-Z]{0,2})";
const SLUG_RE = new RegExp(`^(?:(${SCENE_NO})[.)]?\\s+)?((?:INT|EXT|EST|I\\s*\\/\\s*E|E\\s*\\/\\s*I)(?:\\.|\\s|\\/).*?)(?:(\\s{2,}|\\s)(${SCENE_NO}))?\\s*$`);

/**
 * A slugline from a PDF/text line, scene numbers on either side removed: "12   INT. GARAGE - DAY   12". Sluglines are
 * upper case; a lower/mixed-case one ("int. house - day") counts only with `alone` (a blank line before and after),
 * a dotted INT./EXT./I/E. prefix and a " - TIME" ending, so a sentence that starts "Int." stays action.
 */
export function matchSlug(line, { alone = false } = {}) {
  const t = String(line ?? "").replace(/\t/g, "    ").trim();
  const m = t.match(SLUG_RE)
    || (alone ? t.replace(/^((?:\d{1,4}[A-Z]{0,3}[.)]?\s+)?)(int|ext|i\s*\/\s*e)(?=[.\s/])/i, (_, n, k) => n + k.toUpperCase()).match(SLUG_RE) : null);
  if (!m || !HEADING_RE.test(m[2])) return null;
  let heading = m[2].trim(), number = m[1] || null;
  const tail = m[4] || null;
  if (tail) {
    // A lone trailing number is a scene number only with a wide gap or a matching leading number ("DAY 2" stays a time).
    if ((number && tail === number) || (!number && m[3].length >= 2)) number = number || tail;
    else heading = `${heading} ${tail}`;
  }
  const letters = heading.replace(/[^A-Za-z]/g, "");
  if (!letters) return null;
  if (letters.replace(/[^A-Z]/g, "").length / letters.length < 0.8) {
    const parts = heading.split(/\s+[-–—]+\s+/);
    const ok = alone && heading.length <= 70 && parts.length > 1 && TIME_PART_RE.test(parts[parts.length - 1])
      && /^(?:INT|EXT|I\s*\/\s*E|INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT)\.\s/i.test(heading);
    if (!ok) return null;
    heading = heading.toUpperCase();
  }
  return { heading: squash(heading), number };
}

function cueOf(t) {
  return isCueLine(t) ? normalizeCharacter(t) : "";
}

// Left margin of the action column, from the x positions themselves (PDF page sizes and margins vary).
function actionMargin(rows) {
  const xs = rows.filter((r) => r.x != null && r.text.trim() && !/^\d/.test(r.text.trim())).map((r) => Math.round(r.x / 6) * 6);
  if (!xs.length) return null;
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  const need = Math.max(2, Math.ceil(xs.length * 0.03));
  const bins = [...counts.entries()].filter(([, c]) => c >= need).map(([x]) => x).sort((a, b) => a - b);
  return bins.length ? bins[0] : Math.min(...xs);
}

// Copy/paste text keeps leading spaces when it comes from a text export: turn them into Courier x positions.
function textIndentX(rows) {
  const ind = rows.filter((r) => r.text.trim()).map((r) => r.text.match(/^ */)[0].length);
  if (ind.length < 4) return false;
  const min = Math.min(...ind);
  const deep = ind.filter((n) => n - min >= 8).length;
  if (deep < ind.length * 0.1 || Math.max(...ind) - min < 15) return false;
  for (const r of rows) if (r.text.trim()) r.x = 108 + (r.text.match(/^ */)[0].length - min) * 7.2;
  return true;
}

/** Lines {text, x?, page?} (PDF reconstruction or plain text split by line) -> tokens + meta. */
function parseScreenplayLines(input) {
  const rows = (Array.isArray(input) ? input : []).map((l) => {
    const o = l && typeof l === "object" ? l : { text: l };
    const x = Number(o.x);
    return { text: String(o.text ?? "").replace(/\t/g, "    ").replace(/\s+$/, ""), x: Number.isFinite(x) ? x : null, page: Number(o.page) || 0 };
  });
  const hasX = rows.some((r) => r.x != null) || textIndentX(rows);

  // Pass 1: page furniture out. (MORE) is remembered; artifacts become blank lines (a page break is a paragraph break).
  // A bare number ("12.", "400.", "1985") may be a page number or a line of dialogue: "num" is decided in the main pass.
  for (const r of rows) {
    const t = r.text.trim();
    r.kind = !t ? "blank" : MORE_RE.test(t) ? "more" : BARE_NUM_RE.test(t) ? "num"
      : PAGE_NUM_RE.test(t) || CONTINUED_RE.test(t) || REVISION_RE.test(t) ? "blank" : "text";
    if (r.kind === "blank") r.text = "";
  }
  const isText = (r) => r && (r.kind === "text" || r.kind === "num");
  const isBlank = (i) => i < 0 || i >= rows.length || rows[i].kind === "blank";
  const nextText = (i) => { for (let j = i + 1; j < rows.length; j++) { if (isText(rows[j])) return j; if (rows[j].kind === "blank") return -1; } return -1; };
  const prevGap = (i) => { for (let j = i - 1; j >= 0; j--) { if (isText(rows[j])) return false; if (rows[j].kind === "blank") return true; } return true; };
  const slugAt = (i) => matchSlug(rows[i].text, { alone: prevGap(i) && nextText(i) < 0 });

  // Title page: "Written by" near the top before any slugline.
  const meta = { title: "", author: "" };
  let start = 0;
  const firstSlug = rows.findIndex((r, i) => r.kind === "text" && slugAt(i));
  const top = rows.slice(0, firstSlug < 0 ? Math.min(rows.length, 40) : firstSlug);
  const byIdx = top.findIndex((r) => r.kind === "text" && BY_RE.test(squash(r.text)));
  if (byIdx >= 0) {
    const before = top.slice(0, byIdx).filter((r) => r.kind === "text").map((r) => squash(r.text));
    meta.title = before.slice(-3).join(" ");
    const inline = squash(rows[byIdx].text).replace(BY_PREFIX, "");
    const after = rows.slice(byIdx + 1).find((r) => r.kind === "text");
    meta.author = inline || (after ? squash(after.text) : "");
    const fadeIn = rows.findIndex((r, i) => i > byIdx && r.kind === "text" && TRANSITIONS.has(squash(r.text).toUpperCase()));
    start = fadeIn >= 0 && (firstSlug < 0 || fadeIn < firstSlug) ? fadeIn : firstSlug >= 0 ? firstSlug : byIdx + 2;
    for (let i = 0; i < start; i++) rows[i].kind = "blank";
  }

  // The action margin comes from the script body only: a title-page contact block at x=72 would shift every band.
  const margin = hasX ? actionMargin(rows.slice(start).filter((r) => r.kind === "text")) ?? 108 : null;
  const band = (r) => {
    if (!hasX || r.x == null) return "";
    const dx = r.x - margin;
    return dx < 40 ? "left" : dx < 100 ? "dialogue" : dx < 270 ? "cue" : "right";
  };
  // First/last line of its page (PDF lines know their page).
  const pageEdge = (i) => {
    const p = rows[i].page;
    if (!p) return false;
    const same = (j) => j >= 0 && j < rows.length && rows[j].page === p;
    let a = i - 1, z = i + 1;
    while (same(a) && !isText(rows[a])) a--;
    while (same(z) && !isText(rows[z])) z++;
    return !same(a) || !same(z);
  };

  const tokens = [];
  let state = "", speaker = "", carry = null, para = null, lastDialogue = null;
  const flush = () => { if (para) tokens.push(para); para = null; };
  const push = (type, text, extra) => { flush(); const e = { t: "el", type, text: squash(text), ...extra }; tokens.push(e); return e; };

  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === "num") {
      // Inside a speech ("400.", "1985") it is dialogue, unless its x puts it in the margin or it is a page's first or
      // last line; anywhere else a lone number is a page number.
      const bn = band(r);
      const speech = state === "dialogue" && !carry && (!hasX || r.x == null ? !pageEdge(i) : bn === "dialogue" || bn === "cue");
      r.kind = speech ? "text" : "blank";
      if (!speech) r.text = "";
    }
    if (r.kind === "more") { if (state === "dialogue") carry = { speaker, el: lastDialogue }; continue; }
    if (r.kind === "blank") { state = ""; flush(); continue; }
    const t = squash(r.text);
    const b = band(r);

    // A page break inside a speech: the same speaker's (CONT'D) cue resumes it.
    if (carry) {
      const c = cueOf(t);
      const keep = carry;
      carry = null;
      if (c && c === keep.speaker && (!hasX || b === "cue")) { state = "dialogue"; speaker = c; lastDialogue = keep.el; continue; }
    }

    const slug = b === "dialogue" ? null : slugAt(i);
    if (slug) { flush(); state = ""; tokens.push({ t: "heading", text: slug.heading, number: slug.number }); continue; }

    if (state === "dialogue") {
      const c = hasX && b === "cue" && !/^\(/.test(t) ? cueOf(t) : "";
      if (hasX && (b === "left" || b === "right")) state = "";  // the speech ended without a blank line
      else if (!c) {
        if (/^\(/.test(t) && (b === "" || b === "cue" || b === "dialogue")) {
          const last = tokens[tokens.length - 1];
          if (last && last.type === "parenthetical" && !/\)$/.test(last.text)) last.text = squash(`${last.text} ${t}`);
          else push("parenthetical", t, { character: speaker });
          lastDialogue = null;
        } else {
          const last = tokens[tokens.length - 1];
          if (last && last.type === "parenthetical" && !/\)$/.test(last.text)) last.text = squash(`${last.text} ${t}`);
          else if (lastDialogue && last === lastDialogue) lastDialogue.text = squash(`${lastDialogue.text} ${t}`);
          else lastDialogue = push("dialogue", t, { character: speaker });
        }
        continue;
      }
    }

    const up = t.toUpperCase();
    const nb = nextText(i) >= 0;
    if (isUpper(t) && (/\bTO:$/.test(t) || CUT_RE.test(t) || TRANSITIONS.has(up)) && (hasX ? b !== "dialogue" : !nb)) { push("transition", t); state = ""; continue; }
    if (/^THE END\.?$/.test(t)) { push("centered", t); state = ""; continue; }
    if (isUpper(t) && SHOT_RE.test(t) && b !== "cue" && b !== "dialogue") { push("shot", t); state = ""; continue; }

    const c = cueOf(t);
    if (c && nb && (hasX ? b === "cue" || (b === "" && isBlank(i - 1)) : isBlank(i - 1))) {
      speaker = c;
      push("character", t.replace(/\s*\^\s*$/, ""), { character: c, ...(/\^\s*$/.test(t) ? { dual: true } : {}) });
      state = "dialogue";
      lastDialogue = null;
      continue;
    }
    // Wrapped action lines are layout, not line breaks: one paragraph per block.
    if (para && para.type === "action") para.text = squash(`${para.text} ${t}`);
    else { flush(); para = { t: "el", type: "action", text: t }; }
    state = "";
  }
  flush();
  const pages = rows.reduce((m, r) => Math.max(m, r.page || 0), 0);
  return { tokens, meta, pages };
}

// ---------------------------------------------------------------------------------------------- PDF (pdf.js)

let pdfjsPromise = null;

/** window.pdfjsLib, loading pdf.js 3.11.174 from cdnjs on first use. */
export function loadPdfJs() {
  const g = globalThis;
  if (g.pdfjsLib) return Promise.resolve(withWorker(g.pdfjsLib, false));
  if (pdfjsPromise) return pdfjsPromise;
  if (typeof document === "undefined") return Promise.reject(new Error("PDF import needs the browser (pdf.js loads from cdnjs)."));
  pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL;
    s.async = true;
    s.onload = () => (g.pdfjsLib ? resolve(withWorker(g.pdfjsLib, true)) : reject(new Error("pdf.js loaded but window.pdfjsLib is missing.")));
    s.onerror = () => { pdfjsPromise = null; s.remove(); reject(new Error("Could not load pdf.js from cdnjs. Check the connection, or import .fdx / .fountain.")); };
    document.head.append(s);
  });
  return pdfjsPromise;
}

function withWorker(lib, force) {
  try {
    if (lib.GlobalWorkerOptions && (force || !lib.GlobalWorkerOptions.workerSrc)) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  } catch { /* a frozen options object is fine: pdf.js then runs without a worker */ }
  return lib;
}

/**
 * pdf.js text items of one page -> lines {text, x, y, page}. Items on the same baseline (transform[5], ±2pt) join left to
 * right; x (transform[4]) is kept because screenplay indentation is the element type. A scene number in the left margin
 * does not count as the line's x. A gap taller than the page's line step (the smallest one) becomes a blank line.
 */
export function textItemsToLines(items, page = 1) {
  const its = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.str === "string" && it.str.trim() && Array.isArray(it.transform))
    .map((it) => {
      const size = Math.abs(Number(it.transform[3])) || Math.abs(Number(it.transform[0])) || 12;
      return { s: it.str, x: Number(it.transform[4]) || 0, y: Number(it.transform[5]) || 0, w: Number(it.width) || it.str.length * size * 0.6, size };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of its) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= 2) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  const lines = rows.map((row) => {
    const items = row.items.sort((a, b) => a.x - b.x);
    let text = "", end = null, charW = 7.2;
    for (const it of items) {
      if (end != null) {
        const gap = it.x - end;
        if (gap > charW * 0.5 && !/\s$/.test(text) && !/^\s/.test(it.s)) text += " ".repeat(clamp(Math.round(gap / charW), 1, 60));
      }
      text += it.s;
      charW = it.w / Math.max(1, it.s.length) || charW;
      end = it.x + it.w;
    }
    const lead = items.length > 1 && /^\d{1,4}[A-Z]{0,3}\.?$/.test(items[0].s.trim()) ? items[1] : items[0];
    return { text: text.replace(/\s+$/, ""), x: Math.round(lead.x * 10) / 10, y: row.y, page };
  });
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 4);
  const step = gaps.length ? Math.min(...gaps) : 12;
  const out = [];
  lines.forEach((l, i) => {
    if (i && lines[i - 1].y - l.y > step * 1.6) out.push({ text: "", page });
    out.push(l);
  });
  return out;
}

/** A PDF (ArrayBuffer / Uint8Array) -> lines for parseScript({lines}). */
export async function pdfToLines(data, lib = null) {
  const pdfjs = lib || (await loadPdfJs());
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    if (lines.length) lines.push({ text: "", page: p });
    lines.push(...textItemsToLines(content.items, p));
  }
  try { doc.destroy?.(); } catch { /* already gone */ }
  return lines;
}

function decodeText(bytes) {
  const b = bytes;
  try {
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    try { return new TextDecoder("windows-1252").decode(b); } catch { return new TextDecoder().decode(b); }
  }
}

/** A File/Blob (with .name) -> Script. Text formats parse locally; a PDF goes through pdf.js (loaded on demand). */
export async function importScriptFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("importScriptFile needs a File or Blob.");
  const name = String(file.name || "script");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = /\.pdf$/i.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (isPdf) {
    const lines = await pdfToLines(bytes);
    const script = parseScript({ lines }, { format: "pdf", name });
    if (!lines.some((l) => l.text.trim())) {
      script.warnings.push("This PDF has no text layer (a scan?). Export the PDF again from the writing app, or import .fdx / .fountain.");
    }
    return script;
  }
  const text = decodeText(bytes);
  return parseScript(text, { format: detectFormat(name, text), name });
}

// ---------------------------------------------------------------------------------------------- assembly

const WRAP = { action: 61, shot: 61, centered: 61, transition: 61, lyric: 61, dialogue: 35, parenthetical: 25, character: 38 };
const TIGHT = new Set(["character", "parenthetical", "dialogue"]);

function sceneLines(scene, whole) {
  let n = whole ? 0 : 2; // blank + heading
  let prev = "heading";
  for (const el of scene.elements) {
    if (el.type === "note") continue; // notes do not print
    if (!((el.type === "dialogue" || el.type === "parenthetical") && TIGHT.has(prev))) n += 1;
    for (const seg of String(el.text).split("\n")) n += Math.max(1, Math.ceil(seg.length / (WRAP[el.type] || 61)));
    prev = el.type;
  }
  return n;
}

function outlineFor(scene) {
  let src = squash((scene.elements || []).filter((e) => e.type === "action").map((e) => e.text).join(" ").replace(/\n+/g, " "));
  if (!src) {
    const d = (scene.elements || []).find((e) => e.type === "dialogue");
    if (d) src = `${d.character || "?"}: "${squash(d.text)}"`;
  }
  if (!src) return "";
  const sentences = src.match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g) || [src];
  let out = "", n = 0;
  for (const s of sentences) {
    const next = squash(`${out} ${s}`);
    if (out && (n >= 2 || next.length > 180)) break;
    out = next;
    n++;
  }
  return trimTo(out, 180);
}

function nextLetterNumber(prev, used) {
  const m = String(prev).match(/^(.*?\d)([A-Z]*)$/i);
  let base = m ? m[1] : String(prev), suffix = m ? m[2].toUpperCase() : "";
  for (let guard = 0; guard < 200; guard++) {
    if (!suffix) suffix = "A";
    else {
      const last = suffix[suffix.length - 1];
      suffix = last === "Z" ? `${suffix}A` : suffix.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
    }
    const cand = `${base}${suffix}`;
    if (!used.has(cand.toUpperCase())) return cand;
  }
  return `${base}${suffix}`;
}

/**
 * Everything the parser derives from a scene's elements: speaking characters, outline, breakdown and stage hint (set on
 * each scene, in place), plus the script's character index (returned). Shared by assemble() and hydrateScript().
 */
function deriveScenes(scenes) {
  // Who is in the script: every cue, plus action introductions ("SHERIFF ADA COLE (60s)") folded into the cue name.
  const known = new Set();
  for (const s of scenes) for (const e of s.elements || []) if (e.type === "character" && e.character) known.add(e.character);
  const speakers = new Set(known);
  for (const s of scenes) for (const n of introducedNames(actionText(s, { shots: false }))) known.add(mapIntroduced(n, speakers));

  let prevTime = null;
  for (const scene of scenes) {
    scene.elements = scene.elements || [];
    const characters = [];
    for (const e of scene.elements) if (e.type === "character" && e.character && !characters.includes(e.character)) characters.push(e.character);
    scene.characters = characters;
    scene.outline = outlineFor(scene);
    scene.breakdown = breakdownScene(scene, { known });
    scene.stage_hint = stageHint(scene, { prevTime });
    prevTime = scene.stage_hint.time_of_day || prevTime;
  }

  const chars = new Map();
  scenes.forEach((s, si) => {
    for (const e of s.elements) {
      if (e.type !== "character" || !e.character) continue;
      const c = chars.get(e.character) || { name: e.character, scenes: [], lines: 0, _first: si };
      c.lines++;
      if (!c.scenes.includes(s.id)) c.scenes.push(s.id);
      chars.set(e.character, c);
    }
    for (const n of s.breakdown.cast) {
      if (!known.has(n)) continue;
      const c = chars.get(n) || { name: n, scenes: [], lines: 0, _first: si };
      if (!c.scenes.includes(s.id)) c.scenes.push(s.id);
      chars.set(n, c);
    }
  });
  return [...chars.values()]
    .sort((a, b) => b.lines - a.lines || a._first - b._first || a.name.localeCompare(b.name))
    .map(({ name: n, scenes: sc, lines }) => ({ name: n, scenes: sc, lines }));
}

function assemble({ tokens, meta, pages = 0 }, { format, name }) {
  const scenes = [];
  const pre = [];
  const sections = [];
  let cur = null;
  for (const tk of tokens) {
    if (tk.t === "section") {
      const d = clamp(tk.depth || 1, 1, 6);
      sections.length = d - 1;
      sections[d - 1] = tk.text;
      continue;
    }
    if (tk.t === "heading") {
      const h = parseHeading(tk.text);
      cur = {
        _num: tk.number ? String(tk.number).toUpperCase() : null, _eighths: tk.eighths || 0,
        heading: squash(tk.text), int_ext: h.int_ext, location: h.location, time: h.time,
        elements: [], synopsis: "", section: sections.filter(Boolean).join(" / "),
      };
      scenes.push(cur);
      continue;
    }
    if (tk.t === "synopsis") { if (cur) cur.synopsis = squash(`${cur.synopsis} ${tk.text}`); continue; }
    if (tk.t !== "el" || !String(tk.text || "").trim()) continue;
    const e = { type: tk.type, text: tk.type === "action" || tk.type === "lyric" ? String(tk.text).trim() : squash(tk.text) };
    if (e.type === "action" && /^THE END\.?$/i.test(e.text)) e.type = "centered";
    if (tk.character) e.character = tk.character;
    if (tk.dual) e.dual = true;
    (cur ? cur.elements : pre).push(e);
  }
  const whole = !scenes.length;
  if (whole) scenes.push({ _num: null, _eighths: 0, heading: WHOLE_SCRIPT, int_ext: "", location: "", time: "", elements: [], synopsis: "", section: "" });
  scenes[0].elements.unshift(...pre);

  // Numbers: from the script when it has them. An unnumbered scene in a numbered script becomes an "A scene" after the
  // previous one (2A -> 2B), never colliding with a real number; a script with no numbers counts 1, 2, 3.
  const used = new Set(scenes.filter((s) => s._num).map((s) => s._num));
  const anyNumbered = used.size > 0;
  const ids = new Set();
  let prevNum = null;
  scenes.forEach((s, i) => {
    if (s._num) s.number = s._num;
    else if (!anyNumbered) s.number = String(i + 1);
    else {
      const firstReal = scenes.find((x) => x._num)?._num || "1";
      s.number = prevNum ? nextLetterNumber(prevNum, used) : nextLetterNumber(`${firstReal}`.replace(/[A-Z]+$/i, ""), used).replace(/^(.*?)([A-Z]+)$/i, "$2$1");
      used.add(s.number.toUpperCase());
    }
    prevNum = s.number;
    let id = `sc_${s.number.replace(/[^A-Za-z0-9]+/g, "_")}`;
    for (let k = 2; ids.has(id); k++) id = `sc_${s.number.replace(/[^A-Za-z0-9]+/g, "_")}_${k}`;
    ids.add(id);
    s.id = id;
    s.index = i;
  });

  let totalLines = 0;
  const out = scenes.map((s) => {
    const lines = sceneLines(s, whole);
    totalLines += lines;
    return {
      id: s.id, number: s.number, numbered: !!s._num, heading: s.heading, int_ext: s.int_ext, location: s.location, time: s.time,
      index: s.index, eighths: s._eighths || Math.max(1, Math.round((lines * 8) / LINES_PER_PAGE)),
      elements: s.elements, characters: [], synopsis: s.synopsis, outline: "", section: s.section, notes: "",
    };
  });
  const characters = deriveScenes(out);

  return {
    version: 1,
    title: squash(meta.title) || squash(String(name || "").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "")) || "Untitled script",
    author: squash(meta.author),
    format,
    source_name: String(name || ""),
    scenes: out,
    characters,
    // A PDF knows its pages; Final Draft knows each scene's length; otherwise count formatted lines.
    page_count_est: pages > 0 ? pages : scenes.every((s) => s._eighths)
      ? Math.max(1, Math.round(out.reduce((n, s) => n + s.eighths, 0) / 8))
      : Math.max(1, Math.round(totalLines / LINES_PER_PAGE)),
    warnings: [],
  };
}

function textLines(text) {
  return String(text).replace(/^﻿/, "").split(/\r\n?|\n/).map((t) => ({ text: t }));
}

/**
 * Text (or {lines:[{text, x?, page?}]} from a PDF) -> Script. Never throws: an unknown format reads as plain text, and a
 * script with no sluglines is one scene, "Whole script".
 */
export function parseScript(input, opts = {}) {
  const name = String(opts?.name || "");
  let text = "";
  try {
    if (Array.isArray(input) || (input && typeof input === "object" && "lines" in input)) {
      const lines = Array.isArray(input) ? input : Array.isArray(input.lines) ? input.lines : [];
      return assemble(parseScreenplayLines(lines), { format: opts?.format || "pdf", name });
    }
    text = typeof input === "string" ? input : input == null ? "" : String(input);
    let format = opts?.format || detectFormat(name, text);
    if (format === "pdf") {
      const s = assemble({ tokens: [], meta: {} }, { format: "pdf", name });
      s.warnings.push("A PDF has to be read with importScriptFile (pdf.js); parseScript only takes its lines.");
      return s;
    }
    if (format === "fdx") {
      const r = parseFdx(text);
      if (r.tokens.length) return assemble(r, { format: "fdx", name });
      text = decodeEntities(text.replace(/<[^>]*>/g, "\n"));  // not really FDX: read the words as plain text
      format = "text";
    }
    if (format === "fountain") return assemble(parseFountain(text), { format: "fountain", name });
    return assemble(parseScreenplayLines(textLines(text)), { format: "text", name });
  } catch (err) {
    try {
      const s = assemble(parseScreenplayLines(textLines(text)), { format: "text", name });
      s.warnings.push(`Read as plain text (${err?.message || err}).`);
      return s;
    } catch {
      return {
        version: 1, title: name || "Untitled script", author: "", format: "text", source_name: name, characters: [], page_count_est: 1,
        warnings: ["Could not read this script."],
        scenes: [{
          id: "sc_1", number: "1", numbered: false, heading: WHOLE_SCRIPT, int_ext: "", location: "", time: "", index: 0, eighths: 1,
          elements: text.trim() ? [{ type: "action", text: text.trim() }] : [], characters: [], synopsis: "", outline: "", section: "",
          breakdown: Object.fromEntries(["cast", "extras", "props", "vehicles", "animals", "wardrobe", "sfx", "sound", "music", "set_dressing", "stunts"].map((k) => [k, []])),
          stage_hint: { set: null, time_of_day: null, weather: null, objects: [] }, notes: "",
        }],
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------- compact form

const DERIVED_SCENE_KEYS = ["characters", "outline", "breakdown", "stage_hint"];

/**
 * A Script without what the parser can re-derive (breakdown, stage_hint, outline, scene and script characters): about
 * half the size. For storage: keep it in ComfyUI userdata, not node.properties, which ride along in the workflow JSON
 * that ComfyUI embeds in every saved PNG/MP4 (the screenplay would travel with each render). hydrateScript() undoes it.
 */
export function compactScript(script) {
  if (!script || !Array.isArray(script.scenes)) return script;
  const { characters, ...rest } = script;
  return {
    ...rest, compact: 1,
    scenes: script.scenes.map((sc) => {
      const o = { ...sc };
      for (const k of DERIVED_SCENE_KEYS) delete o[k];
      return o;
    }),
  };
}

/** compactScript() output (or a full Script) -> the full Script, re-deriving outline, breakdown, hints and characters. */
export function hydrateScript(compact) {
  if (!compact || !Array.isArray(compact.scenes)) return compact;
  const { compact: _c, ...rest } = compact;
  const scenes = compact.scenes.map((sc) => ({ ...sc, elements: (sc.elements || []).map((e) => ({ ...e })) }));
  const characters = deriveScenes(scenes);
  return { ...rest, scenes, characters };
}

// ---------------------------------------------------------------------------------------------- stage prompt

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const COUNT_WORDS = ["", "one", "two", "three", "four", "five"];
// stage_hint.time_of_day -> a lighting preset id (TIME_PRESETS in web/stage/lighting.mjs / soundstage/agent/catalog.py).
const TIME_PRESET = { day: "midday", night: "night", dawn: "dawn", dusk: "magic_hour" };

/**
 * What the stage should start from for this scene, as ids the host can apply directly after the agent builds it:
 * stage.setEnvironment({set, weather}) and stage.applyTimePreset(time_preset). The rules agent picks its set from the
 * first keyword anywhere in the prompt, so the host enforces these instead of trusting that guess.
 */
export function stageSetupForScene(scene) {
  const h = (scene && scene.stage_hint) || {};
  return { set: h.set || null, weather: h.weather || "none", time_preset: TIME_PRESET[h.time_of_day] || null };
}

/**
 * A plain description for the Scene agent's "Build scene" (web/agent/agent.mjs describe()). Words from the page only.
 * Place and time come first and the raw "INT."/"EXT." prefix is left out (it reads as the 'int.' interior keyword);
 * the cast is counted ("two people (Ada, Vance)") so the rules backend makes one figure per speaking part; the action
 * is short and has quoted text (song titles, signs) removed, so it does not outvote the heading.
 */
export function buildPromptForScene(scene) {
  const s = scene || {};
  const h = s.stage_hint || {};
  const out = [];
  const ie = { INT: "interior", EXT: "exterior", "INT/EXT": "interior and exterior" }[s.int_ext] || "";
  const place = s.location || (s.heading && s.heading !== WHOLE_SCRIPT ? s.heading : "");
  const where = [place ? String(place).toLowerCase() : "", ie ? `(${ie})` : ""].filter(Boolean).join(" ");
  if (where) out.push(`Location: ${where}.`);
  const time = h.time_of_day || (s.time ? String(s.time).toLowerCase() : "");
  if (time) out.push(`Time: ${time}${s.time && h.time_of_day && !String(s.time).toLowerCase().includes(h.time_of_day) ? ` (${String(s.time).toLowerCase()})` : ""}.`);
  if (h.weather) out.push(`Weather: ${h.weather}.`);
  const cast = (s.breakdown?.cast?.length ? s.breakdown.cast : s.characters) || [];
  if (cast.length) {
    const n = Math.min(cast.length, 5);
    out.push(`Cast: ${COUNT_WORDS[n]} ${n === 1 ? "person" : "people"} (${cast.map(titleCase).join(", ")}).`);
  }
  if (s.breakdown?.extras?.length) out.push(`Extras: ${s.breakdown.extras.join(", ")}.`);
  const action = squash((s.elements || []).filter((e) => e.type === "action" || e.type === "shot").map((e) => e.text).join(" ")
    .replace(/\n+/g, " ").replace(/"[^"]*"|“[^”]*”/g, " "));
  if (action) out.push(trimTo(action, 300));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------- revised drafts

const tokensOf = (s) => new Set(String(s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean));
// Two empty sets are no evidence either way (0), not a perfect match.
function jaccard(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n || 1);
}

// What similarity() compares, computed once per scene (a pair loop over a long script must not re-tokenise).
function features(s, i, n) {
  const words = actionText(s, { shots: false }) || (s.elements || []).filter((e) => e.type === "dialogue").map((e) => e.text).join(" ");
  return {
    loc: tokensOf(s.location || s.heading), heading: String(s.heading), ie: s.int_ext, time: String(s.time),
    words: tokensOf(words.split(/\s+/).slice(0, 40).join(" ")),  // a talking scene is still recognisable by its dialogue
    pos: i / Math.max(1, n - 1),
  };
}

function similarity(a, b) {
  const loc = a.loc.size || b.loc.size ? jaccard(a.loc, b.loc) : a.heading === b.heading ? 1 : 0;
  const head = 0.7 * loc + 0.15 * (a.ie === b.ie ? 1 : 0) + 0.15 * (a.time === b.time ? 1 : 0);
  return 0.65 * head + 0.35 * jaccard(a.words, b.words) - 0.15 * Math.abs(a.pos - b.pos);
}

const overlaps = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const PAIR_KEEP = 6; // candidates kept per new scene; plenty for a greedy match, and keeps the pair list linear

/**
 * A revised draft keeps what the director added: `notes`, and every scene key the parser does not own (shot links such as
 * `shots`, colours, flags) move from the old scene to its match in the new draft. Scenes match by script scene number when
 * both drafts number them and the scenes still look alike (a renumbered draft does not move notes onto another scene),
 * else by heading/action similarity. Notes that find no scene are kept in `orphans`.
 * A matched scene keeps its old `id`, so anything the host linked by scene id (shot.scene_id) still points at it; a new
 * scene never takes an id the old draft used, nor an orphan's id. `characters[].scenes` follow the same ids.
 */
export function mergeNotes(oldScript, newScript) {
  const next = { ...(newScript || {}), scenes: ((newScript && newScript.scenes) || []).map((s) => ({ ...s })) };
  next.warnings = [...((newScript && newScript.warnings) || [])];
  for (const [k, v] of Object.entries(oldScript || {})) if (!SCRIPT_KEYS.includes(k) && !(k in next)) next[k] = v;
  const olds = (oldScript && oldScript.scenes) || [];
  const oldOrphans = (oldScript && oldScript.orphans) || [];
  const userKeys = (s) => Object.keys(s).filter((k) => !SCENE_KEYS.includes(k));
  const carries = (s) => !!(String(s.notes || "").trim() || userKeys(s).length);
  const fo = olds.map((o, j) => features(o, j, olds.length));
  const fn = next.scenes.map((s, i) => features(s, i, next.scenes.length));

  const match = new Map(); // new index -> old index
  const usedOld = new Set();
  const oldByNum = new Map();
  olds.forEach((o, j) => {
    if (!o.numbered) return;
    const k = String(o.number).toUpperCase();
    oldByNum.set(k, [...(oldByNum.get(k) || []), j]);
  });
  next.scenes.forEach((s, i) => {
    if (!s.numbered) return;
    // Same number, and still the same scene: similar enough, or the location still shares a word. With repeated numbers
    // the best-scoring one wins, not the first.
    let best = -1, bestSc = -Infinity;
    for (const j of oldByNum.get(String(s.number).toUpperCase()) || []) {
      if (usedOld.has(j)) continue;
      const sc = similarity(fo[j], fn[i]);
      if ((sc >= 0.35 || overlaps(fo[j].loc, fn[i].loc)) && sc > bestSc) { best = j; bestSc = sc; }
    }
    if (best >= 0) { match.set(i, best); usedOld.add(best); }
  });
  const pairs = [];
  next.scenes.forEach((s, i) => {
    if (match.has(i)) return;
    const mine = [];
    olds.forEach((o, j) => {
      if (usedOld.has(j)) return;
      const sc = similarity(fo[j], fn[i]);
      if (sc >= 0.5) mine.push([sc, i, j]);
    });
    mine.sort((a, b) => b[0] - a[0] || Math.abs(a[1] - a[2]) - Math.abs(b[1] - b[2]));
    pairs.push(...mine.slice(0, PAIR_KEEP));
  });
  pairs.sort((a, b) => b[0] - a[0] || Math.abs(a[1] - a[2]) - Math.abs(b[1] - b[2]));
  for (const [, i, j] of pairs) {
    if (match.has(i) || usedOld.has(j)) continue;
    match.set(i, j);
    usedOld.add(j);
  }

  for (const [i, j] of match) {
    const o = olds[j], s = next.scenes[i];
    if (String(o.notes || "").trim()) s.notes = o.notes;
    for (const k of userKeys(o)) s[k] = o[k];
  }

  // Ids: matched scenes keep the old id; the rest avoid every old id and every orphan's id (an orphan's shots must not
  // land on a new scene, even several drafts later).
  const taken = new Set([...olds.map((o) => o.id), ...oldOrphans.map((o) => o.id)]);
  const rename = new Map(); // parsed id -> final id
  const finals = new Set();
  next.scenes.forEach((s, i) => {
    let id;
    if (match.has(i)) id = olds[match.get(i)].id;
    else {
      id = s.id;
      for (let k = 2; taken.has(id) || finals.has(id); k++) id = `${s.id}_${k}`;
    }
    rename.set(s.id, id);
    finals.add(id);
  });
  for (const s of next.scenes) s.id = rename.get(s.id) ?? s.id;
  next.characters = ((newScript && newScript.characters) || []).map((c) => ({ ...c, scenes: (c.scenes || []).map((id) => rename.get(id) ?? id) }));

  next.orphans = [
    ...oldOrphans,
    ...olds.filter((o, j) => !usedOld.has(j) && carries(o)).map((o) => {
      const keep = { id: o.id, number: o.number, heading: o.heading, notes: o.notes || "" };
      for (const k of userKeys(o)) keep[k] = o[k];
      return keep;
    }),
  ];
  return next;
}
