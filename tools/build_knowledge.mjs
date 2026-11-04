#!/usr/bin/env node
// ✦ Ask's knowledge pack (docs/assistant.md): an App catalog extracted from the source, plus the README and docs/**/*.md
// cut into chunks, so Ask's search_docs (web/agent/knowledge.mjs) can cite where a control or a technique lives.
// No model, no network: regexes over the files. Deterministic (sorted, no dates), so a test can say it is stale.
//
//   node tools/build_knowledge.mjs           # rewrite web/agent/knowledge/{catalog,docs}.json
//   node tools/build_knowledge.mjs --check   # exit 1 when the committed files are out of date
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "web/agent/knowledge");
const rel = (p) => relative(ROOT, p).split("\\").join("/");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function walk(dir, keep, out = []) {
  for (const n of readdirSync(join(ROOT, dir)).sort()) {
    const p = `${dir}/${n}`;
    if (["vendor", "demo_media", "node_modules"].includes(n)) continue;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, keep, out);
    else if (keep(n)) out.push(p);
  }
  return out;
}

// Where a file's controls show up in the App: step › panel. Most specific prefix first.
const WHERE = [
  ["web/script/", "① Script"], ["web/cast/", "② Cast & Locations"],
  ["web/stage/physpanel", "③ Set › an object's card › Physics"], ["web/stage/softpanel", "③ Set › an object's card › Soft body"],
  ["web/stage/sfxpanel", "③ Set › an SFX rig's card"], ["web/stage/partspanel", "③ Set › an object's card › Parts"],
  ["web/stage/posepanel", "③ Set › a person's card › Pose"], ["web/stage/", "③ Set"],
  ["web/presets/", "③ Set › Presets window (V)"], ["web/ui/presets", "③ Set › Presets window (V)"],
  ["web/book/", "Director's Book"], ["web/canvas/", "④ Frame › Canvas"], ["web/look/", "④ Frame › Look"],
  ["web/motion/ltxadvanced", "⑤ Motion › Advanced (LTX)"], ["web/motion/ripple", "⑤ Motion › Ripple"], ["web/motion/", "⑤ Motion"],
  ["web/pipeline/", "④ Frame / ⑤ Motion / ⑦ Deliver"], ["web/performance/", "⑤ Motion › Real performance"],
  ["web/ladder/", "⑥ Review"], ["web/dailies/", "⑥ Review › Dailies"], ["web/takecheck/", "⑥ Review › Take check"],
  ["web/cut/", "⑥ Review › Cut (editor)"], ["web/oneclick/", "One-click tools"], ["web/touchup/", "Touch-up"],
  ["web/vcam/", "Phone viewfinder (virtual camera)"], ["web/agent/", "✦ Ask / Director"], ["web/project/", "Projects pill (top row)"],
  ["web/ui/", "App-wide"], ["web/", "App-wide"],
];
const whereOf = (p) => (WHERE.find(([k]) => p.startsWith(k)) || [null, "App-wide"])[1];

const unq = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\$\{[^}]*\}/g, "…").replace(/\s+/g, " ").trim();
const STR = String.raw`"((?:[^"\\\n]|\\.){0,400})"`;
// label helpers seen in the source: btn("Label", icon, "help"), row("Label", input, "help"), button("Label"...)
const HELPERS = String.raw`\b(?:btn|row|button|num|select|seg|range|field|toggle|chk)\(\s*`;
const HELPER = new RegExp(String.raw`${HELPERS}${STR}((?:(?!${HELPERS})[^\n])*)`, "g");
const ATTR = new RegExp(String.raw`(?:\btitle|"aria-label"|\btip|\bhelp|placeholder):\s*${STR}`, "g");
const OPTION = new RegExp(String.raw`new Option\(\s*${STR}`, "g");

/** Every labelled control in the web source: [{label, help, where, file}]. */
export function extractControls() {
  // Ask's own data (playbook titles, tool docs) is not a control on screen: search finds it through the docs instead.
  const ASK_DATA = /^(copilot|copilotui|castops|playbook|knowledge)\.mjs$/;
  const files = walk("web", (n) => /\.(mjs|js)$/.test(n) && !/\.test\./.test(n) && !ASK_DATA.test(n));
  const out = [];
  const seen = new Set();
  const put = (c) => {
    if (!c.label || c.label.length < 2 || /^[a-z_]+$/.test(c.label) || /^[^A-Za-z]*$/.test(c.label)) return;
    const k = `${c.where}|${c.label}|${c.help}`;
    if (seen.has(k)) return;
    seen.add(k); out.push(c);
  };
  for (const f of files) {
    const lines = read(f).split("\n");
    const where = whereOf(f);
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*)/.test(ln)) return;
      for (const m of ln.matchAll(HELPER)) {
        const label = unq(m[1]);
        const rest = [...m[2].matchAll(new RegExp(STR, "g"))].map((x) => unq(x[1])).filter((x) => x.length > 20 && / /.test(x));
        put({ label, help: rest[0] || "", where, file: f });
      }
      for (const m of ln.matchAll(ATTR)) {
        const t = unq(m[1]);
        if (t.length < 3) continue;
        const short = t.length <= 48 && !/[.:]\s/.test(t);
        put({ label: short ? t : t.split(/[.:(]\s|,\s/)[0].slice(0, 60), help: short ? "" : t, where, file: f });
      }
      for (const m of ln.matchAll(OPTION)) put({ label: unq(m[1]), help: "a choice in a menu", where, file: f });
    });
  }
  return out;
}

const J = (p) => JSON.parse(read(p));
/** Presets, rigs, looks, quality and engine settings, shortcuts, the 7 steps. */
export function extractCatalog() {
  const pj = J("web/presets/presets.json");
  const tabs = Object.fromEntries(pj.tabs.map((t) => [t.id, t.label]));
  const presets = pj.presets.map((p) => ({ id: p.id, tab: p.tab, kind: tabs[p.tab] || p.tab, label: p.label, words: p.words || [], summary: p.summary || "",
    where: `③ Set › Presets window (V) › ${tabs[p.tab] || p.tab}` }));
  const sfx = read("web/presets/sfxpresets.mjs").match(/SFX_PRESET_KINDS = \[([^\]]*)\]/)[1].match(/"[^"]+"/g).map((x) => x.slice(1, -1));
  const rigs = [...read("web/stage/sfx.mjs").matchAll(/^\s{2}([a-z_]+):\s*\{\s*label:\s*"([^"]+)"/gm)].map((m) => ({ id: m[1], label: m[2] }));
  const looks = (() => { try { const s = J("web/look/style_presets.json"); return (s.styles || s.presets || s).map?.((x) => ({ id: x.id, label: x.label || x.name || x.id })) || []; } catch { return []; } })();
  const lights = (() => { try { const s = J("web/look/lighting_setups.json"); return (s.setups || s.presets || s).map?.((x) => ({ id: x.id, label: x.label || x.name || x.id })) || []; } catch { return []; } })();
  const ltx = J("web/motion/ltx_presets.json");
  const adv = read("web/motion/ltxadvanced.mjs");
  const adherence = [...adv.matchAll(/^\s{4}(Loose|Balanced|Exact):\s*\{\s*\n\s*label:\s*"[^"]+",\s*tip:\s*"([^"]+)",\s*\n\s*([^\n]+)/gm)]
    .map((m) => ({ level: m[1], tip: m[2], knobs: m[3].trim().replace(/,$/, "") }));
  const quality = {
    ltx_presets: Object.entries(ltx.presets || {}).map(([name, p]) => ({ name, tip: p.tip || "", resolution: p.resolution, steps: [p.steps_1, p.steps_2], s2_start: p.s2_start })),
    adherence, adherence_default: (adv.match(/default:\s*"(\w+)"/) || [])[1] || "Exact",
    engines: [...read("web/pipeline/pipeline.mjs").matchAll(new RegExp(String.raw`new Option\(\s*${STR}`, "g"))].map((m) => unq(m[1])),
  };
  const sc = read("web/ui/shortcuts.mjs");
  const block = sc.slice(sc.indexOf("export const SHORTCUTS"));
  const shortcuts = [];
  let group = "";
  for (const ln of block.split("\n")) {
    const g = ln.match(/group:\s*"([^"]+)"/);
    if (g) group = g[1];
    for (const m of ln.matchAll(/\{\s*keys:\s*\[([^\]]*)\](?:,\s*alts:\s*(\[\[[^\]]*\](?:,\s*\[[^\]]*\])*\]))?,\s*what:\s*"([^"]+)"/g))
      shortcuts.push({ group, keys: m[1].match(/"[^"]+"/g).map((x) => x.slice(1, -1)).join("+"), what: m[3] });
    if (/^\];/.test(ln)) break;
  }
  const steps = [...read("web/agent/ask.mjs").matchAll(/\{ k: "(\w+)", n: "(.)", label: "([^"]+)" \}/g)].map((m) => ({ key: m[1], n: m[2], label: m[3] }));
  return { presets, sfx_presets: sfx, sfx_rigs: rigs, looks, lighting_setups: lights, quality, shortcuts, steps };
}

/** README.md and docs/**\/*.md cut at headings into chunks of at most ~1400 characters: [{doc, heading, text}]. */
export function extractDocs() {
  const files = ["README.md", ...walk("docs", (n) => n.endsWith(".md"))];
  const out = [];
  for (const f of files) {
    const src = read(f).replace(/```[\s\S]*?```/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/<[^>]+>/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
    let head = f, buf = [];
    const flush = () => {
      const text = buf.join(" ").replace(/[*_`|>#]+/g, " ").replace(/\s+/g, " ").trim();
      buf = [];
      for (let i = 0; i < text.length; i += 1300) {
        const part = text.slice(i, i + 1400).trim();
        if (part.length > 40) out.push({ doc: f, heading: head, text: part });
      }
    };
    for (const ln of src.split("\n")) {
      const m = ln.match(/^#{1,4}\s+(.*)/);
      if (m) { flush(); head = m[1].replace(/[*_`]/g, "").trim(); } else buf.push(ln);
    }
    flush();
  }
  return out;
}

export function build() {
  const catalog = { about: "Generated by tools/build_knowledge.mjs: do not edit by hand.", ...extractCatalog(), controls: extractControls() };
  return { "catalog.json": JSON.stringify(catalog), "docs.json": JSON.stringify({ about: catalog.about, chunks: extractDocs() }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = build();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(files).filter(([n, s]) => { try { return readFileSync(join(OUT, n), "utf8") !== s; } catch { return true; } }).map(([n]) => n);
    if (stale.length) { console.error(`stale: ${stale.join(", ")}: run node tools/build_knowledge.mjs`); process.exit(1); }
    console.log("knowledge pack is up to date");
  } else {
    mkdirSync(OUT, { recursive: true });
    for (const [n, s] of Object.entries(files)) { writeFileSync(join(OUT, n), s); console.log(`${rel(join(OUT, n))}: ${(s.length / 1024).toFixed(0)} KB`); }
  }
}
