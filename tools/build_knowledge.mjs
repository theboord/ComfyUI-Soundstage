// Builds ✦ Ask's offline knowledge pack, web/agent/knowledge_index.mjs, from the repo itself (no hand-written
// descriptions for anything the code already labels):
//   docs      README.md and docs/**/*.md, chunked by heading
//   controls  every labelled control in web/** (title / aria-label / btn() / row() / say() text), where = the step
//   presets   web/presets/presets.json, the SFX rigs, web/motion/ltx_presets.json (render presets, Adherence levels),
//             the Recast engines (soundstage/nodes_footage.py)
//   keys      the "?" cheat sheet (web/ui/shortcuts.mjs SHORTCUTS)
//   routes    every /soundstage/... server route, with its docstring's first line
// The 7-step workflow map is web/agent/knowledge.mjs SOUNDSTAGE_MAP (also indexed).
//
//   node tools/build_knowledge.mjs          rebuild
//   node tools/build_knowledge.mjs --check  exit 1 if the shipped pack is stale (tests/js/knowledge.test.mjs)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web/agent/knowledge_index.mjs");
const rel = (p) => relative(ROOT, p).split("\\").join("/");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const squash = (s, n = 700) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function walk(dir, ok, skip = /vendor|node_modules|__pycache__|\/share\b|media/) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (skip.test(rel(p))) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, ok, skip)); else if (ok(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- docs
function docChunks() {
  const files = [join(ROOT, "README.md"), ...walk(join(ROOT, "docs"), (p) => p.endsWith(".md"))];
  const out = [];
  for (const f of files) {
    const src = rel(f);
    let title = src, heads = [], buf = [];
    const flush = () => {
      const text = buf.join("\n").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<[^>]+>/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      buf = [];
      const t = squash(text, 100000);
      if (t.length < 40) return;
      for (let i = 0; i < t.length; i += 650) out.push({ kind: "doc", where: `${src} › ${heads.join(" › ") || title}`, text: t.slice(i, i + 700) });
    };
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^(#{1,4})\s+(.+)/);
      if (m) { flush(); const lv = m[1].length; heads = [...heads.slice(0, lv - 1), m[2].replace(/[*`]/g, "").trim()].filter(Boolean); if (lv === 1) title = heads[0]; continue; }
      buf.push(line);
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------- controls
const AREA = [[/^web\/pipeline\//, "App steps (④ Frame / ⑤ Motion / ⑥ Review)"], [/^web\/motion\/ltxadvanced/, "⑤ Motion → Advanced (LTX)"], [/^web\/motion\/ripple/, "⑤ Motion → Ripple edit"],
  [/^web\/script\//, "① Script"], [/^web\/cast\//, "② Cast & Locations"], [/^web\/stage\/phys/, "③ Set → Physics"], [/^web\/stage\/sfx/, "③ Set → SFX"],
  [/^web\/stage\/pose/, "③ Set → Pose"], [/^web\/stage\//, "③ Set"], [/^web\/vcam\//, "③ Set → Virtual camera (phone)"], [/^web\/cut\//, "Cut (timeline)"],
  [/^web\/book\//, "Director's Book"], [/^web\/ladder\//, "⑥ Review"], [/^web\/dailies\//, "⑥ Review → Dailies"], [/^web\/performance\//, "Performance"],
  [/^web\/passes\//, "⑦ Deliver → Passes"], [/^web\/agent\//, "✦ Ask / Director"], [/^web\/presets\/|^web\/ui\/presets/, "Presets window"], [/^web\/look\//, "Look"],
  [/^web\/coach\//, "Coach"], [/^web\/project\//, "Project pill"], [/^web\/canvas\//, "Paint Studio"], [/^web\/oneclick\//, "One-click tools"], [/^web\/ui\//, "App chrome"],
  [/^web\/soundstage\.js/, "Soundstage App"]];
const areaOf = (p) => (AREA.find(([re]) => re.test(p)) || [null, p.replace(/^web\//, "").replace(/\.m?js$/, "")])[1];
const STR = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\x60([^\x60$]*)\x60)`;
const lit = (m, i = 1) => (m ? (m[i] ?? m[i + 1] ?? m[i + 2] ?? "").replace(/\\n/g, " ").replace(/\\(.)/g, "$1") : "");
const OK = (s) => s && s.length >= 2 && s.length <= 400 && /[A-Za-z]/.test(s) && !/^[a-z0-9_.\-/:#]+$/.test(s) && !/^(?:ss-|\.|#|https?:)/.test(s);

function controls() {
  const files = walk(join(ROOT, "web"), (p) => /\.m?js$/.test(p) && !/knowledge_index|tryit\/|demo\//.test(rel(p)));
  const seen = new Map();
  const put = (where, control, help) => {
    control = squash(control, 80); help = squash(help, 300);
    if (!OK(control) && !OK(help)) return;
    if (!OK(control)) control = help.split(/[:.(]/)[0].slice(0, 60);
    const k = `${where}|${control.toLowerCase()}`;
    const e = seen.get(k);
    if (e) { if (!e.help && help && help !== control) e.help = help; return; }
    seen.set(k, { kind: "control", where, control, help: help === control ? "" : help });
  };
  const rx = {
    title: new RegExp(String.raw`\btitle:\s*${STR}`), aria: new RegExp(String.raw`"aria-label":\s*${STR}`),
    call: new RegExp(String.raw`\b(?:btn|row|toggle|chip|seg|button|mkBtn|label|field|opt|option|check|slider)\(\s*${STR}(?:\s*,\s*[^,()]*?)?(?:\s*,\s*${STR})?`, "g"),
    say: new RegExp(String.raw`\b(?:say|_msg|onStatus\??\.?)\(\s*${STR}`, "g"),
    labelKey: new RegExp(String.raw`\blabel:\s*${STR}[^}]*?\b(?:tip|title|help):\s*${STR}`, "g"),
    last: new RegExp(String.raw`,\s*${STR}\s*\)+[,;]?\s*$`),
    after: new RegExp(String.raw`\}\s*,\s*(?:icon\([^)]*\)\s*,\s*)?${STR}`),
  };
  for (const f of files) {
    const where = areaOf(rel(f));
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      for (const m of line.matchAll(rx.call)) put(where, lit(m, 1), lit(m, 4));
      for (const m of line.matchAll(rx.labelKey)) put(where, lit(m, 1), lit(m, 4));
      for (const m of line.matchAll(rx.say)) { const t = lit(m, 1); const c = t.split(/:\s/)[0]; if (c !== t && c.length <= 40) put(where, c, t); }
      const t = rx.title.exec(line), a = rx.aria.exec(line);
      if (t || a) put(where, lit(a) || lit(rx.after.exec(line)) || lit(rx.last.exec(line)) || lit(t).split(/[:.(]/)[0], lit(t));
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- presets, settings, keys, routes
async function presets() {
  const out = [];
  const p = JSON.parse(read("web/presets/presets.json"));
  const tab = Object.fromEntries(p.tabs.map((t) => [t.id, t.label]));
  for (const x of p.presets) out.push({ kind: "preset", where: `Presets window → ${tab[x.tab] || x.tab}`, control: x.label, help: x.summary || "", words: (x.words || []).join(", "), id: x.id });
  const ltx = JSON.parse(read("web/motion/ltx_presets.json"));
  for (const [k, v] of Object.entries(ltx.presets || {})) out.push({ kind: "setting", where: "⑤ Motion → Quality preset", control: v.label || k, help: v.tip || "" });
  for (const [k, v] of Object.entries(ltx.adherence?.levels || {})) out.push({ kind: "setting", where: "⑤ Motion → Adherence", control: v.label || k, help: `${v.tip || ""} ${ltx.adherence.about || ""}` });
  const sfx = read("web/presets/sfxpresets.mjs");
  for (const m of sfx.matchAll(/kind === "(\w+)"\)\s*\{\s*\n\s*\/\/\s*(.+)/g)) out.push({ kind: "preset", where: "③ Set → SFX rigs", control: m[1].replace(/_/g, " "), help: m[2] });
  const foot = read("soundstage/nodes_footage.py");
  for (const m of foot.matchAll(/^ENGINE_\w+\s*=\s*"([^"]+)"/gm)) out.push({ kind: "setting", where: "Recast (swap the subject) → Engine", control: m[1], help: "" });
  const { SHORTCUTS } = await import(pathToFileURL(join(ROOT, "web/ui/shortcuts.mjs")).href);
  for (const g of SHORTCUTS) for (const it of g.items) out.push({ kind: "key", where: `Shortcuts (?) → ${g.group}`, control: it.what, help: "", shortcut: [it.keys, ...(it.alts || [])].map((k) => k.join("+")).join(" or ") });
  return out;
}

function routes() {
  const out = [], seen = new Set();
  for (const f of walk(join(ROOT, "soundstage"), (p) => p.endsWith(".py"))) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      const m = l.match(/@\w+\.(get|post|put|delete)\(\s*["'](\/soundstage\/[^"']+)["']/);
      if (!m || seen.has(m[2])) return;
      seen.add(m[2]);
      let doc = "";
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) { const d = lines[j].match(/^\s*(?:"""|''')(.+?)(?:"""|'''|$)/); if (d) { doc = d[1]; break; } }
      if (!doc) for (let j = i - 1; j >= Math.max(0, i - 3); j--) { const c = lines[j].match(/^\s*#\s*(.+)/); if (c) { doc = c[1]; break; } }
      const fn = (lines.slice(i + 1, i + 3).join(" ").match(/def (\w+)/) || [])[1] || "";
      out.push({ kind: "route", where: `server ${m[1].toUpperCase()} ${m[2]}`, control: m[2], help: doc || fn.replace(/_/g, " "), file: rel(f) });
    });
  }
  return out;
}

async function buildChunks() {
  const { SOUNDSTAGE_MAP_STEPS } = await import(pathToFileURL(join(ROOT, "web/agent/knowledge.mjs")).href);
  const steps = SOUNDSTAGE_MAP_STEPS.map((s) => ({ kind: "step", where: s.step, control: s.step, help: `${s.for} In: ${s.in}. Out: ${s.out}. Next: ${s.next}` }));
  return [...steps, ...(await presets()), ...controls(), ...routes(), ...docChunks()];
}

const SKILL_DIR = "skills/soundstage-agent/references";

/** The Claude agent skill's reference files (skills/soundstage-agent/): the same lessons and controls the in-App Ask knows. */
function skillRefs(chunks) {
  const head = (what) => `<!-- GENERATED by tools/build_knowledge.mjs from ${what}. Do not edit: run \`node tools/build_knowledge.mjs\`. -->\n\n`;
  const lessons = head("docs/assistant/SKILLS.md") + read("docs/assistant/SKILLS.md").replace(/\]\(\.\.\/\.\.\/assistant\/MISSES\.md\)/g, "](../../../assistant/MISSES.md)");
  const by = new Map();
  for (const c of chunks.filter((x) => x.kind === "control" && (x.help || String(x.control || "").length <= 48))) {   // a bare long line is a suggestion chip, not a control
    const k = String(c.where || "").split("›")[0].trim() || "Other";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  let controls = head("the App's source (labels, tooltips) in web/**") + "# Soundstage controls, by where they live\n\nEach line: **control**: what it does.\n";
  for (const [k, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    controls += `\n## ${k}\n`;
    const seen = new Set();
    for (const c of list) {
      const line = `- **${squash(c.control, 80)}**${c.help ? `: ${squash(c.help, 180)}` : ""}`;
      if (!seen.has(line)) { seen.add(line); controls += line + "\n"; }
    }
  }
  return { [`${SKILL_DIR}/lessons.md`]: lessons, [`${SKILL_DIR}/controls.md`]: controls };
}

export async function build() {
  const chunks = await buildChunks();
  return `// GENERATED by tools/build_knowledge.mjs from the repo (docs, UI labels, presets, shortcuts, routes). Do not edit:\n` +
    `// run \`node tools/build_knowledge.mjs\`; tests/js/knowledge.test.mjs fails when this is stale.\n` +
    `export default ${JSON.stringify(chunks)};\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const chunks = await buildChunks();
  const next = await build();
  const refs = skillRefs(chunks);
  if (process.argv.includes("--check")) {
    const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (cur !== next) { console.error("web/agent/knowledge_index.mjs is stale: run node tools/build_knowledge.mjs"); process.exit(1); }
    for (const [p, body] of Object.entries(refs)) {
      if (!existsSync(join(ROOT, p)) || read(p) !== body) { console.error(`${p} is stale: run node tools/build_knowledge.mjs`); process.exit(1); }
    }
    console.log("knowledge pack and agent-skill references are fresh");
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${rel(OUT)} (${(next.length / 1024).toFixed(0)} KB)`);
    for (const [p, body] of Object.entries(refs)) { writeFileSync(join(ROOT, p), body); console.log(`wrote ${p} (${(body.length / 1024).toFixed(0)} KB)`); }
  }
}
