// ✦ Ask's location and prop tools (the same pattern as characters, web/agent/charbuild.mjs): gather what the script says
// (cited "sc N · l M"), profile it (the model, or the script's own words), write the ② Cast card (Undo puts the card
// back), regenerate ONE card's picture after a yes. panel: web/cast/cast.mjs CastPanel (items, cardSnapshot, setCard,
// restoreCard, generateOne). Pure apart from the panel calls.
const words = (s) => String(s || "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clip = (s, n = 220) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Everything the script says about a location (a slugline's place) or a prop. -> tool result */
export function gatherThing(script, query, kind) {
  const tool = `gather_${kind}`, q = words(query);
  if (!script?.scenes?.length) return { tool, ok: false, said: "There's no script loaded yet.", observe: "no script" };
  let name = null;
  const scenes = [], lines = [];
  for (const sc of script.scenes) {
    const n = sc.number || String(sc.index + 1);
    const lw = words(sc.location);
    const hit = kind === "location" ? q.length && q.every((w) => lw.includes(w)) : (sc.breakdown?.props || []).some((p) => words(p).join(" ") === q.join(" "));
    const re = q.length ? new RegExp(`(?<![A-Za-z])${esc(q.join(" "))}`, "i") : null;
    const said = (sc.elements || []).map((e, i) => ({ e, line: i + 1 })).filter(({ e }) => e.type === "action" && re?.test(e.text || ""));
    if (!hit && !said.length) continue;
    if (!name) name = kind === "location" ? sc.location : query.replace(/^(the|a|an)\s+/i, "");
    scenes.push({ scene: n, line: 0, text: sc.heading, time: sc.time || "", int_ext: sc.int_ext || "" });
    if (kind === "location" && hit) { const i = (sc.elements || []).findIndex((e) => e.type === "action"); if (i >= 0) lines.push({ scene: n, line: i + 1, text: clip(sc.elements[i].text) }); }
    for (const { e, line } of said) if (!lines.some((x) => x.scene === n && x.line === line)) lines.push({ scene: n, line, text: clip(e.text) });
  }
  if (!name) return { tool, ok: false, said: `There's no ${kind} "${query}" in the script.`, observe: `no ${kind} "${query}"` };
  const said = `${name}: ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ${lines.length} line${lines.length === 1 ? "" : "s"} about it.`;
  return { tool, ok: true, kind, name, scenes, lines, said, did: [`read ${script.scenes.length} scenes for ${name}`],
    observe: `${said}\n${lines.slice(0, 6).map((x) => `[sc ${x.scene} · l ${x.line}] ${x.text}`).join("\n")}` };
}

const LOOK = /\b(dark|dim|bright|neon|rain[- ]?soaked|wet|dusty|grimy|filthy|cramped|huge|vast|empty|crowded|abandoned|derelict|rusted|rusty|old|new|modern|tin[- ]roof\w*|brick|concrete|wooden|tiled|flickering|bare bulb|candlelit|smoky|foggy|cold|warm|narrow|wide|tiny|battered|shiny|chrome|antique|stained|cracked|broken|leather|steel|glass)\b/gi;
export const THING_SYSTEM = "You are a production designer reading a screenplay. From the quoted lines only, describe how this location or prop looks on screen, in one line for a reference picture. Never invent what the lines don't support. Reply with JSON only: {\"description\": \"...\", \"cites\": [\"sc N · l M\"]}";

/** profile_location / profile_prop: the model, else the script's own adjectives (+ INT/EXT and time for a place). */
export async function profileThing(g, { llm = null, signal = null } = {}) {
  const tool = `profile_${g?.kind || "location"}`;
  if (!g?.ok) return { tool, ok: false, said: g?.said || "Gather it first.", observe: "nothing gathered" };
  let description = "", cites = [], by = "built-in";
  if (llm) {
    try {
      const raw = await llm(THING_SYSTEM, `${g.kind}: ${g.name}\n${g.lines.map((x) => `[sc ${x.scene} · l ${x.line}] ${x.text}`).join("\n")}`, { signal });
      const j = JSON.parse(String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/)?.[0] || "null");
      if (typeof j?.description === "string" && j.description.trim()) { description = clip(j.description.trim(), 400); cites = (j.cites || []).map(String).slice(0, 6); by = "model"; }
    } catch (e) { if (e?.cancelled || signal?.aborted) throw e; }
  }
  if (!description) {
    const bits = [];
    if (g.kind === "location") { const s = g.scenes[0]; if (s?.int_ext) bits.push(s.int_ext === "EXT" ? "exterior" : "interior"); const times = [...new Set(g.scenes.map((x) => x.time).filter(Boolean))]; if (times.length) bits.push(times.join(" / ").toLowerCase()); }
    for (const x of g.lines) for (const m of x.text.matchAll(LOOK)) { const w = m[1].toLowerCase(); if (!bits.includes(w)) { bits.push(w); cites.push(`sc ${x.scene} · l ${x.line}`); } }
    description = bits.join(", ");
    cites = [...new Set(cites)];
  }
  if (!description) return { tool, ok: false, said: `The script says nothing about how ${g.name} looks: tell me and I'll write it on the card.`, observe: "no look in the script" };
  return { tool, ok: true, kind: g.kind, name: g.name, by, description, cites, said: `${g.name}: ${description}.`, observe: `profile: ${description} (${cites.join("; ") || "no cites"})` };
}

/** The ② Cast card for a name and kind (location cards are "INT. WAREHOUSE": matched on the place words). */
export function findCard(panel, name, kind) {
  const items = (() => { try { return panel?.items?.() || []; } catch { return []; } })().filter((x) => !kind || x.kind === kind);
  const q = words(name).filter((w) => !["int", "ext"].includes(w)).join(" ");
  return items.find((x) => words(x.name).filter((w) => !["int", "ext"].includes(w)).join(" ") === q) ||
    items.find((x) => q && words(x.name).join(" ").includes(q)) || null;
}

/** update_*: write the description; undo restores the card exactly (cardSnapshot / restoreCard). */
export function updateThing(panel, { name, kind, description }) {
  const tool = `update_${kind}`, card = findCard(panel, name, kind);
  if (!card || !panel?.setCard) return { tool, ok: false, said: `There's no ② Cast card for ${name}.`, observe: `no ${kind} card: ${name}` };
  const before = panel.cardSnapshot?.(card.key) ?? null, text = clip(String(description || "").trim(), 600);
  panel.setCard(card.key, { description: text });
  return { tool, ok: true, key: card.key, said: `Wrote ${card.name}'s ② Cast description: "${text}".`, observe: `${card.key}.description = "${text}"`,
    undo: () => panel.restoreCard?.(card.key, before),
    check: () => (findCard(panel, card.name, kind)?.description === text ? { ok: true, said: `${card.name}'s card reads back the new description.` } : { ok: false, said: `${card.name}'s card doesn't show the new description.` }) };
}

/** regenerate_*: ONE card, only when confirmed (the approved plan or a yes). */
export async function regenerateThing(panel, { name, kind, confirmed = false }) {
  const tool = `regenerate_${kind}`, card = findCard(panel, name, kind);
  if (!card) return { tool, ok: false, said: `There's no ② Cast card for ${name}.`, observe: `no ${kind} card: ${name}` };
  if (!confirmed) return { tool, ok: false, needsConfirm: true, said: `Regenerate ${card.name}'s picture? It replaces the current one (one card, on the GPU).`, observe: "waiting for a yes" };
  const before = panel.cardSnapshot?.(card.key) ?? null;
  await panel.generateOne(card.key);
  return { tool, ok: true, gpu: true, said: `Regenerated ${card.name}'s reference picture (only that card).`, observe: `${card.key}: picture regenerated`, undo: () => panel.restoreCard?.(card.key, before) };
}
