// ✦ Ask's co-pilot in the chat (web/agent/copilot.mjs; docs/assistant.md): the plan card (numbered steps, Lock it in /
// Discard), the live progress while it runs (each step's result, Stop), and "What I did" with the self-check and ONE
// Undo for the whole plan. Mounted by web/agent/ask.mjs; the App's hooks come from soundstage.js (host).
import { icon } from "../ui/icons.mjs";
import { Copilot, route, planFor, validateCall, YES } from "./copilot.mjs";

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k === "class") e.className = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/** The Director as the co-pilot's set hands: direct calls (select_shot, lens, preset, cut…) or an order through its planner. */
export function directorHands(d) {
  return {
    calls: async (calls, label) => { const r = await d.apply({ command: label, calls }); return { ok: r.ok, said: (r.said || []).join(" "), undoable: r.undoable }; },
    order: async (text, { signal = null } = {}) => {
      const p = await d.propose(text, { signal });
      if (!p.calls?.length) return { ok: false, said: `The set planner couldn't turn "${text}" into a change${p.rejected?.length ? `: ${p.rejected.map((x) => x.reason || x).join("; ")}` : ""}.` };
      const r = await d.apply(p);   // GPU calls are skipped here (they need the Director's own OK)
      return { ok: r.ok, said: (r.said || []).join(" "), undoable: r.undoable };
    },
    undo: () => d.undo(),
  };
}

/**
 * -> {copilot, claims(text), answer(text, {signal}) -> {cls, nodes, chips} | null}. claims: a pending plan / question,
 * or words the co-pilot's router knows (a symptom, a recipe, "build X from the script", "where is…").
 */
export function mountCopilot({ dir, host = {}, llm = null, check = null, where = null }) {
  const copilot = new Copilot({
    llm, where, check,
    script: () => { try { return host.script?.() || null; } catch { return null; } },
    shots: () => { try { return host.shots?.() || []; } catch { return []; } },
    cast: host.cast || null, stage: host.stage || null, quality: host.quality || null, cut: host.cut || null,
    shotLength: host.shotLength || null, director: dir.director ? directorHands(dir.director) : null,
  });
  const claims = (text) => !!(copilot.pending || copilot.confirmRegen) || !!route(text, { script: copilot.host.script() });

  /** "Do it for me" on a troubleshoot / plan_recipe card (main's knowCard): the runnable steps as a plan card, or null. */
  function doIt(r, text = "") {
    const words = r.tool === "troubleshoot" ? r.symptom || text : `add ${r.intent || text}`;
    const p = planFor(words, copilot.host.script());
    const steps = p.steps.map((s) => validateCall(s)).filter((v) => v.ok).map((v) => v.call);
    if (!steps.length) return null;
    const plan = copilot.propose(steps, r.title || words);
    return planCard(plan, { by: "built-in" });
  }

  function planCard(plan, r) {
    const list = h("ol", {}, ...plan.steps.map((s) => h("li", {}, s.say || `${s.name.replace(/_/g, " ")} ${Object.values(s.args).join(", ")}`)));
    const go = h("button", { type: "button", class: "go" }, icon("check", 13), "Lock it in");
    const no = h("button", { type: "button" }, "Discard");
    const row = h("div", { class: "row" }, go, no);
    go.addEventListener("click", () => { row.replaceChildren(); runPlan(); });
    no.addEventListener("click", () => { copilot.pending = null; row.replaceChildren(h("span", { class: "meta" }, "Dropped. Nothing changed.")); });
    return h("div", { class: "tool" }, h("div", { class: "ttl" }, `Plan: ${plan.title}`), list,
      h("div", { class: "meta" }, `Say "lock it in" (or press it) and I'll run it step by step, checking each result. One Undo takes it all back.${r.by === "model" ? "" : " (Planned by the built-in playbook.)"}`), row);
  }

  function resultBits(r) {
    const out = [];
    for (const x of r.results || []) {
      if (x.tool === "search_docs" && x.hits?.length) out.push(h("ul", {}, ...x.hits.map((t) => h("li", {}, h("b", {}, `${t.where}${t.control ? ` → ${t.control}` : ""}`), t.text ? `: ${String(t.text).slice(0, 160)}` : ""))));
      if (/^gather_(location|prop)$/.test(x.tool) && x.ok) out.push(h("details", {}, h("summary", {}, `What the script says (${x.lines.length})`),
        h("ul", {}, ...x.lines.map((c) => h("li", {}, `“${c.text}” — sc ${c.scene} · l ${c.line}`)))));
      if (x.tool === "troubleshoot" && x.entries?.[0]) out.push(h("div", { class: "why" }, `Why: ${x.entries[0].cause}`));
      if (x.tool === "plan_recipe" && x.craft) out.push(h("div", { class: "why" }, `Film craft: ${x.craft}`));
    }
    if (r.clicks?.length) out.push(h("div", { class: "ttl" }, "Do these by hand:"), h("ol", {}, ...r.clicks.map((c) => h("li", {}, c))));
    return out;
  }

  /** Run the pending plan with live progress, Stop, then What I did + one Undo. */
  function runPlan() {
    const steps = h("ol", {});
    const stop = h("button", { type: "button" }, icon("x", 12), "Stop");
    const card = dir.say("a how", h("div", { class: "ttl" }, `Running: ${copilot.pending?.title || "the plan"}`), steps, h("div", { class: "row" }, stop));
    stop.addEventListener("click", () => { copilot.stop(); stop.disabled = true; stop.textContent = "Stopping after this step…"; });
    copilot.execute({ onStep: ({ call, result }) => steps.append(h("li", { class: result.ok ? "ok" : "bad" }, result.said || call.name)) }).then((x) => {
      stop.remove();
      const undo = h("button", { type: "button" }, icon("undo-2", 13), x.stopped ? "Undo what I did" : "Undo");
      undo.addEventListener("click", () => { x.undo(); undo.disabled = true; dir.say("a", `Put back everything "${x.plan.title}" changed.`); copilot.remember("assistant", "(undid the plan)"); });
      const keep = x.stopped ? h("button", { type: "button", on: { click: (e) => { e.target.parentNode.replaceChildren(h("span", { class: "meta" }, "Kept what's done.")); } } }, "Keep it") : null;
      dir.say("a how", h("div", { class: "ttl" }, "What I did"), h("div", {}, x.said),
        x.did.length ? h("ul", {}, ...x.did.map((d) => h("li", { class: "ok" }, d))) : null,
        x.verified.length ? h("div", { class: "meta" }, `Checked: ${x.verified.map((v) => `${v.ok ? "✓" : "✗"} ${v.said}`).join(" ")}`) : null,
        x.canUndo() ? h("div", { class: "row" }, undo, keep) : null);
    }).catch((e) => dir.say("a", `The plan stopped: ${e.message || e}.`));
    return card;
  }

  async function answer(text, { signal = null } = {}) {
    const r = await copilot.turn(text, { signal });
    if (!r || r.fallback) return r?.fallback ? { fallback: true, why: r.why } : null;
    if (r.approved) { runPlan(); return { cls: "how", nodes: [h("div", {}, r.say)], chips: [] }; }
    const nodes = [];
    if (r.why) nodes.push(h("div", { class: "meta" }, `${cap(r.why)}, so I used the built-in playbook.`));
    if (r.say) nodes.push(h("div", {}, r.say));
    if (r.question && r.question !== r.say) nodes.push(h("div", {}, r.question));
    nodes.push(...resultBits(r));
    if (r.plan) nodes.push(planCard(r.plan, r));
    if (r.undo) { const u = h("button", { type: "button" }, icon("undo-2", 13), "Undo"); u.addEventListener("click", () => { r.undo(); u.disabled = true; }); nodes.push(h("div", { class: "row" }, u)); }
    const chips = (r.options || []).map((o) => ({ label: String(o), command: String(o) }));
    if (r.plan) chips.unshift({ label: "Lock it in", command: "lock it in" });
    return { cls: "how", nodes, chips };
  }
  return { copilot, claims, answer, doIt, isYes: (t) => YES.test(t) };
}
