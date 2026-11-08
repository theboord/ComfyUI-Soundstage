// The start screen: pick a project when the App opens, like Avid's project window, Resolve's Project Manager or
// Premiere's Home screen (Mike 2026-11-04: "a front page, like load project… like any editing program"). docs/projects.md
//
//   import { openHome, shouldShowHome, sortProjects, filterProjects, thumbFallback, gridMove } from "./project/home.mjs";
//   openHome({ ctl, api, host: { onDemo, onScript }, onDemand })   -> {el, close}
//
// Left: New project · Open project… · Open collected project… · Try the demo scene · Import a script.
// Main: recent projects (GET /soundstage/project/list), newest first, search and Recent / Name sort; each card has a
// picture (chosen first frame → look frame → final / draft poster → stage previz → a coloured initial card;
// never a clay frame: Lifelike-only plan §1.4), the name, "2 h ago",
// scenes · shots · takes, an "autosave newer" badge, and a ⋯ menu (Open, Duplicate, Rename, Collect, Restore autosave…,
// Delete = move to projects/.trash/, confirmed on the card itself). Keys: arrows between cards, Enter opens, ⌘/Ctrl+N
// new, Esc closes when it was opened on demand. In the try-it demo (no server) only the demo and the script show.
import { openMenu } from "../ui/popover.mjs";
import { icon } from "../ui/icons.mjs";
import { TOKENS as T } from "../ui/theme.mjs";
import { ago, projectNameOf } from "./store.mjs";

// ------------------------------------------------------------------------------------------------ pure

/**
 * Show the start screen on its own? Only for a blank Soundstage App: no project name in the workflow, the untouched
 * default stage, no script, no renders, not the try-it demo, and not already shown in this tab.
 */
export function shouldShowHome({ tryit = false, shown = false, launch = true } = {}) {
  // v2 (Mike, 2026-11-04): the App always opens on the project screen, once per page load, unless the user turned it
  // off ("Show this screen when Soundstage opens") or this is the try-it demo.
  return !(tryit || shown || launch === false);
}

const LAUNCH_KEY = "ss.home.launch";
/** The launch preference, on by default. localStorage can throw (private windows): then it stays on. */
export function launchEnabled() { try { return localStorage.getItem(LAUNCH_KEY) !== "0"; } catch { return true; } }
export function setLaunchEnabled(on) { try { localStorage.setItem(LAUNCH_KEY, on ? "1" : "0"); } catch { /* storage blocked */ } }

/** Sort a copy: "recent" (newest save first) or "name" (A → Z, case-insensitive, numbers in order). */
export function sortProjects(list, by = "recent") {
  const a = [...(list || [])];
  const byName = (x, y) => String(x.name).localeCompare(String(y.name), undefined, { sensitivity: "base", numeric: true });
  return by === "name" ? a.sort(byName) : a.sort((x, y) => (y.saved_at || 0) - (x.saved_at || 0) || byName(x, y));
}

/** Projects whose name has every word of the query (case- and accent-insensitive). */
export function filterProjects(list, q = "") {
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = fold(q).split(/\s+/).filter(Boolean);
  return (list || []).filter((p) => words.every((w) => fold(p.name).includes(w)));
}

const PALETTE = ["#f2ff59", "#7ee2a8", "#7ab8ff", "#ff9f6e", "#d49bff", "#ff7aa8", "#5fd4d4", "#e8c56b"];

/** A card with no picture: its initial on a colour picked from its name (same name, same colour). */
export function thumbFallback(name) {
  const s = String(name || "").trim();
  let h = 0;
  for (const ch of s) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  const initial = (s.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();
  return { initial, color: PALETTE[h % PALETTE.length] };
}

/** "3 scenes · 12 shots · 40 takes" (singular for one, parts with 0 left out; "Empty" when all are 0). */
export function countsLine(c = {}) {
  const part = (n, w) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : null);
  return [part(c.scenes, "scene"), part(c.shots, "shot"), part(c.takes, "take")].filter(Boolean).join(" · ") || "Empty";
}

/** Arrow-key move in a grid of n cards, `cols` across. Returns the new index (clamped; stays put at the edges). */
export function gridMove(i, key, cols, n) {
  if (n <= 0) return -1;
  const c = Math.max(1, cols);
  const j = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - c, ArrowDown: i + c, Home: 0, End: n - 1 }[key];
  if (j === undefined) return i;
  if (j < 0) return key === "ArrowUp" ? i : 0;
  if (j >= n) return key === "ArrowDown" ? i : n - 1;
  return j;
}

// ------------------------------------------------------------------------------------------------ DOM

const SORT_KEY = "ss_home_sort";
const CSS = `
.ss-home .launch{display:flex;gap:6px;align-items:center;font-size:12px;color:#b9b3bf;cursor:pointer;margin:0 0 8px}
.ss-home .launch input{accent-color:#f2ff59}
.ss-home { position:fixed; inset:0; z-index:10000; display:grid; grid-template-columns:260px 1fr; background:${T.bg};
  color:${T.text}; font-family:var(--ss-font, ui-sans-serif, system-ui, sans-serif); font-size:13px; }
.ss-home button { font:inherit; color:inherit; cursor:pointer; }
.ss-home .side { display:flex; flex-direction:column; gap:8px; padding:24px 18px; border-right:1px solid ${T.line}; background:${T.raised}; }
.ss-home .brand { font-weight:800; font-stretch:condensed; text-transform:uppercase; letter-spacing:.04em; font-size:20px; color:${T.accent}; margin:0 0 14px; }
.ss-home .act { display:flex; align-items:center; gap:10px; text-align:left; padding:10px 12px; border-radius:10px;
  background:${T.card}; border:1px solid ${T.line}; }
.ss-home .act:hover, .ss-home .act:focus-visible { background:${T.hover}; border-color:${T.lineStrong}; outline:none; }
.ss-home .act.main { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; font-weight:700; }
.ss-home .act .k { margin-left:auto; opacity:.6; font-size:11px; }
.ss-home .side .grow { flex:1; }
.ss-home .side .skip { background:none; border:none; color:${T.muted}; text-align:left; padding:6px 2px; }
.ss-home .pane { display:flex; flex-direction:column; min-width:0; min-height:0; }
.ss-home .top { display:flex; align-items:center; gap:10px; padding:18px 24px; border-bottom:1px solid ${T.line}; }
.ss-home .top h2 { margin:0 auto 0 0; font-size:18px; }
.ss-home .top input, .ss-home .top select { background:rgba(0,0,0,.22); color:${T.text}; border:1px solid ${T.line}; border-radius:8px; padding:7px 10px; font:inherit; }
.ss-home .top input { width:240px; }
.ss-home .top .x { background:${T.card}; border:1px solid ${T.line}; border-radius:8px; padding:6px 10px; }
.ss-home .grid { flex:1; overflow:auto; padding:20px 24px; display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:16px; align-content:start; }
.ss-home .card { position:relative; display:flex; flex-direction:column; border-radius:14px; overflow:hidden; background:${T.card};
  border:1px solid ${T.line}; text-align:left; padding:0; }
.ss-home .card:hover { background:${T.cardHover}; border-color:${T.lineStrong}; }
.ss-home .card:focus-visible, .ss-home .card.sel { outline:2px solid ${T.accent}; outline-offset:2px; }
.ss-home .pic { flex:none; aspect-ratio:16/9; background:#121015; display:grid; place-items:center; overflow:hidden; }
.ss-home .pic img, .ss-home .pic video { width:100%; height:100%; object-fit:cover; display:block; }
.ss-home .pic .ini { font-size:44px; font-weight:800; color:${T.accentInk}; width:100%; height:100%; display:grid; place-items:center; }
.ss-home .meta { flex:none; padding:10px 12px 12px; display:flex; flex-direction:column; gap:3px; }
.ss-home .meta .nm { font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:28px; }
.ss-home .meta .sub { color:${T.muted}; font-size:12px; }
.ss-home .badge { position:absolute; top:8px; left:8px; background:${T.glassStrong}; color:${T.accent}; border:1px solid ${T.accentLine};
  border-radius:999px; padding:2px 8px; font-size:11px; }
.ss-home .more { position:absolute; right:8px; bottom:10px; background:none; border:none; padding:4px; border-radius:6px; color:${T.muted}; }
.ss-home .more:hover { background:${T.hover}; color:${T.text}; }
.ss-home .confirm { padding:10px 12px 12px; display:flex; flex-direction:column; gap:8px; }
.ss-home .confirm .row { display:flex; gap:8px; }
.ss-home .confirm .danger { background:${T.danger}; color:#211927; border:none; border-radius:8px; padding:6px 10px; font-weight:700; }
.ss-home .confirm .cancel { background:${T.raised}; border:1px solid ${T.line}; border-radius:8px; padding:6px 10px; }
.ss-home .empty { color:${T.muted}; padding:40px 24px; grid-column:1/-1; max-width:60ch; line-height:1.5; }
@media (max-width:720px) { .ss-home { grid-template-columns:1fr; grid-template-rows:auto auto; overflow:auto; } .ss-home .grid { overflow:visible; padding:16px; } .ss-home .top { padding:12px 16px; flex-wrap:wrap; } .ss-home .side { padding:16px; } .ss-home .brand { margin-bottom:6px; } .ss-home .side { border-right:none; border-bottom:1px solid ${T.line}; } .ss-home .top input { width:140px; } }
`;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = v;
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}

const readSort = () => { try { return localStorage.getItem(SORT_KEY) === "name" ? "name" : "recent"; } catch { return "recent"; } };
const writeSort = (v) => { try { localStorage.setItem(SORT_KEY, v); } catch { /* storage blocked */ } };

/** Open the start screen. Returns {el, close, refresh}. Only one at a time. */
export function openHome({ ctl, api, host = {}, onDemand = false, tryit = false, askName = null, current = null } = {}) {
  if (!document.getElementById("ss-home-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-home-css", textContent: CSS }));
  document.querySelector(".ss-home")?.remove();
  let list = [], sort = readSort(), q = "", sel = 0, closed = false;
  const say = (m) => { try { ctl?.say?.(m); } catch { /* */ } };
  const close = () => { if (closed) return; closed = true; el.remove(); window.removeEventListener("keydown", onKey, true); };
  const run = (fn) => async () => { try { await fn(); } catch (e) { say(String(e?.message || e)); } };
  const thenClose = (fn) => run(async () => { close(); await fn(); });

  const act = (ic, label, fn, { main = false, key = null, title = null } = {}) =>
    h("button", { type: "button", class: `act${main ? " main" : ""}`, title, on: { click: fn } }, icon(ic, 16), label, key ? h("span", { class: "k" }, key) : null);
  const side = h("nav", { class: "side", "aria-label": "Start" },
    h("div", { class: "brand" }, "Soundstage"),
    tryit ? null : act("plus", "New project", thenClose(() => ctl.newProject()), { main: true, key: "⌘N" }),
    tryit ? null : act("file-text", "Open project…", () => grid.querySelector(".card")?.focus(), { title: "Pick one from the list (or type to search)" }),
    tryit ? null : act("upload", "Open collected project…", (e) => collectedMenu(e.currentTarget)),
    act("clapperboard", "Try the demo scene", thenClose(() => host.onDemo?.())),
    act("file-text", tryit ? "Load a script" : "Import a script", thenClose(() => host.onScript?.()),
      { title: "Bring in a screenplay (Fountain, Final Draft, PDF); in a blank project it goes right here" }),
    h("div", { class: "grow" }),
    tryit ? null : h("label", { class: "launch", title: "When off, Soundstage opens straight into the current tab" },
      h("input", { type: "checkbox", checked: launchEnabled(), on: { change: (e) => setLaunchEnabled(e.target.checked) } }), " Show this screen when Soundstage opens"),
    h("button", { type: "button", class: "skip", on: { click: close } },
      onDemand ? "Back to the App (Esc)" : current ? `Continue with "${current}" (Esc)` : "Start with this blank stage"));

  const search = h("input", { type: "search", placeholder: "Search projects", "aria-label": "Search projects",
    on: { input: (e) => { q = e.target.value; sel = 0; draw(); } } });
  const sortSel = h("select", { "aria-label": "Sort", on: { change: (e) => { sort = e.target.value; writeSort(sort); draw(); } } },
    h("option", { value: "recent" }, "Recent"), h("option", { value: "name" }, "Name"));
  sortSel.value = sort;
  const top = h("div", { class: "top" }, h("h2", {}, "Projects"), tryit ? null : search, tryit ? null : sortSel,
    onDemand ? h("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close", on: { click: close } }, icon("x", 14)) : null);
  const grid = h("div", { class: "grid", role: "list" });
  const el = h("div", { class: "ss-home", role: "dialog", "aria-modal": "true", "aria-label": "Soundstage projects" },
    side, h("section", { class: "pane" }, top, grid));

  const shown = () => sortProjects(filterProjects(list, q), sort);

  function pic(p) {
    const box = h("div", { class: "pic" });
    const fb = () => { const f = thumbFallback(p.name); box.replaceChildren(h("div", { class: "ini", style: `background:${f.color}` }, f.initial)); };
    if (!p.thumb) { fb(); return box; }
    const url = api.apiURL ? api.apiURL(p.thumb) : p.thumb;
    const m = p.thumb_kind === "video"
      ? h("video", { src: `${url}#t=0.1`, muted: true, preload: "metadata", playsinline: true, "aria-hidden": "true" })
      : h("img", { src: url, alt: "", loading: "lazy" });
    m.addEventListener("error", fb);
    box.append(m);
    return box;
  }

  function confirmTrash(card, p) {
    const meta = card.querySelector(".meta, .confirm");
    const box = h("div", { class: "confirm" },
      h("div", {}, `Move "${p.name}" to the trash?`),
      h("div", { class: "sub" }, "It goes to projects/.trash/ in your ComfyUI user folder. Nothing is deleted."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "danger", on: { click: run(async (e) => {
          e?.stopPropagation?.();
          const r = await post("/soundstage/project/trash", { name: p.name });
          say(`Moved "${p.name}" to the trash (${r.trash}).`);
          await refresh();
        }) } }, "Move to trash"),
        h("button", { type: "button", class: "cancel", on: { click: (e) => { e.stopPropagation(); box.replaceWith(meta); card.focus(); } } }, "Cancel")));
    box.addEventListener("click", (e) => e.stopPropagation());
    meta.replaceWith(box);
    box.querySelector(".cancel").focus();
  }

  async function post(path, body) {
    const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
    return j;
  }

  async function collectedMenu(anchor) {
    let got = [];
    try { const r = await api.fetchApi("/soundstage/project/collected"); if (r.ok) got = (await r.json()).projects || []; } catch { /* none */ }
    openMenu([
      ...got.map((p) => ({ label: `${p.name} · ${p.size_mb} MB`, run: thenClose(() => ctl.openCollected(p.name)) })),
      ...(got.length ? ["-"] : [{ header: "No collected projects in output/soundstage_projects/ yet" }]),
      { label: "Upload a collected .zip…", icon: "upload", run: thenClose(() => ctl.uploadCollected()) },
    ], anchor, { makeIcon: icon });
  }

  const ask = async (title, v) => (askName ? askName(title, v) : (window.prompt(title, v) || "").trim() || null);

  function cardMenu(card, p, anchor) {
    openMenu([
      { label: "Open", icon: "file-text", run: thenClose(() => ctl.open(p.name)) },
      { label: "Duplicate…", icon: "copy", run: run(async () => {
        const to = await ask("Duplicate project as", `${p.name} copy`);
        if (!to) return;
        const r = await post("/soundstage/project/duplicate", { name: p.name, to });
        say(`Duplicated as "${r.name}".`);
        await refresh(r.name);
      }) },
      { label: "Rename…", icon: "wand-sparkles", run: run(async () => {
        const to = await ask("Rename project", p.name);
        if (!to || to === p.name) return;
        const r = await post("/soundstage/project/rename", { name: p.name, to });
        say(`Renamed to "${r.name}".`);
        await refresh(r.name);
      }) },
      { label: "Collect (zip)", icon: "package-plus", run: run(() => ctl.collect(p.name)) },
      { label: `Restore autosave…${p.autosaves ? ` (${p.autosaves})` : ""}`, icon: "rotate-ccw", disabled: !p.autosaves, run: run(async () => {
        const autos = await ctl.store.autosaves(p.name);
        openMenu(autos.map((a) => ({ label: `${new Date(a.at).toLocaleString()} · ${ago(a.at)} ago`,
          run: thenClose(() => ctl.restore(a.file, p.name)) })), anchor, { makeIcon: icon });
      }) },
      "-",
      { label: "Delete…", icon: "trash-2", danger: true, run: () => confirmTrash(card, p) },
    ], anchor, { makeIcon: icon });
  }

  function draw() {
    const items = shown();
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    if (!items.length) {
      grid.replaceChildren(h("div", { class: "empty" }, tryit
        ? "This is the try-it demo: there is no server to keep projects on. Try the demo scene, or load a script."
        : list.length ? `No project matches "${q}".` : "No saved projects yet. Start a New project, try the demo scene, or import a script. Projects you save from the pill at the top of the App show up here."));
      return;
    }
    grid.replaceChildren(...items.map((p, i) => {
      const card = h("div", { class: `card${i === sel ? " sel" : ""}`, role: "listitem", tabindex: i === sel ? "0" : "-1",
        "aria-label": `${p.name}, saved ${ago(p.saved_at)} ago, ${countsLine(p.counts)}`, "data-name": p.name });
      const more = h("button", { type: "button", class: "more", title: "More", "aria-label": `More for ${p.name}`, "aria-haspopup": "menu",
        on: { click: (e) => { e.stopPropagation(); cardMenu(card, p, more); } } }, icon("ellipsis", 16));
      card.append(...[pic(p),
        p.autosave_newer ? h("span", { class: "badge", title: `An autosave (${ago(p.autosave_at)} ago) is newer than the last Save` }, "Autosave newer") : null,
        h("div", { class: "meta" }, h("div", { class: "nm", title: p.name }, p.name),
          h("div", { class: "sub" }, `Saved ${ago(p.saved_at)} ago`), h("div", { class: "sub" }, countsLine(p.counts))),
        more].filter(Boolean));
      card.addEventListener("click", thenClose(() => ctl.open(p.name)));
      card.addEventListener("focus", () => { sel = i; for (const c of grid.querySelectorAll(".card")) c.classList.toggle("sel", c === card); });
      return card;
    }));
  }

  const cols = () => {
    const cards = [...grid.querySelectorAll(".card")];
    if (cards.length < 2) return 1;
    const y = cards[0].offsetTop;
    const n = cards.findIndex((c) => c.offsetTop !== y);
    return n < 0 ? cards.length : n;
  };

  function onKey(e) {
    if (closed) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "n" || e.key === "N") && !tryit) { e.preventDefault(); e.stopPropagation(); thenClose(() => ctl.newProject())(); return; }
    if (e.key === "Escape") {
      if (document.querySelector(".ss-popmenu")) return;       // the menu closes first
      e.stopPropagation();
      if (onDemand || current) close();
      return;
    }
    const inField = e.target?.closest?.("input, select, textarea");
    const cards = [...grid.querySelectorAll(".card")];
    if (!cards.length) return;
    if (/^Arrow|^Home$|^End$/.test(e.key) && (!inField || e.key === "ArrowDown")) {
      e.preventDefault(); e.stopPropagation();
      const from = inField ? -1 : sel;
      sel = from < 0 ? 0 : gridMove(sel, e.key, cols(), cards.length);
      cards[sel]?.focus();
    } else if (e.key === "Enter" && !inField && e.target?.classList?.contains("card")) {
      e.preventDefault(); e.stopPropagation();
      const p = shown()[sel];
      if (p) thenClose(() => ctl.open(p.name))();
    } else if (e.key === "Enter" && e.target === search && shown()[0]) {
      e.preventDefault();
      thenClose(() => ctl.open(shown()[0].name))();
    }
  }

  async function refresh(focusName = null) {
    if (tryit) { list = []; draw(); return; }
    try {
      const r = await api.fetchApi("/soundstage/project/list");
      list = r.ok ? ((await r.json()).projects || []) : [];
    } catch { list = []; }
    if (focusName) { const i = shown().findIndex((p) => p.name === focusName); if (i >= 0) sel = i; }
    draw();
    if (!closed && !el.contains(document.activeElement)) (grid.querySelector(".card") || side.querySelector(".act"))?.focus();
  }

  window.addEventListener("keydown", onKey, true);
  document.body.append(el);
  draw();
  refresh();
  return { el, close, refresh };
}
