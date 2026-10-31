// ③ Set: "Import world…" (Milestone 12). Uploads a world file (plus a .gltf's .bin / textures or an .obj's .mtl) and
// makes it the Set, then shows what came in: its size, units and up axis with the reason, one-click fixes, colliders,
// cameras that became shots, and the draw-call savings.
import { WORLD_ACCEPT, WORLD_MESH_FORMATS, WORLD_SPLAT_FORMATS, extOf } from "./importworld.mjs";
import { SOURCE_PRESETS, fmtLen } from "./units.mjs";

const CSS = `
.ss-worldpanel{position:fixed;z-index:100500;width:min(430px,calc(100vw - 24px));background:#1d1b22;color:#e8e4ee;border:1px solid #3d3946;
  border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);padding:12px 14px;font:13px/1.45 system-ui,sans-serif}
.ss-worldpanel[hidden]{display:none}
.ss-worldpanel .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ss-worldpanel .hd b{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ss-worldpanel .readout{font-size:15px;font-weight:600;margin:2px 0 4px}
.ss-worldpanel .why,.ss-worldpanel .stats{color:#b7b0c2;font-size:12px;margin:4px 0}
.ss-worldpanel .fix{background:#3a2f12;border:1px solid #7a6324;color:#ffe6a6;border-radius:8px;padding:6px 8px;margin:6px 0}
.ss-worldpanel .row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0}
.ss-worldpanel select,.ss-worldpanel input[type=number]{background:#2a2731;color:#e8e4ee;border:1px solid #474252;border-radius:6px;padding:3px 5px;font:inherit}
.ss-worldpanel input[type=number]{width:64px}
.ss-worldpanel button{background:#2f2b37;color:#e8e4ee;border:1px solid #4b4656;border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
.ss-worldpanel button.go{background:#e39a40;border-color:#e39a40;color:#1b1406;font-weight:600}
.ss-worldpanel button:hover{filter:brightness(1.15)}
.ss-worldpanel .err{color:#ff9d8a}
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const select = (label, value, options, onChange) => {
  const s = el("select", { on: { change: () => onChange(s.value), pointerdown: (e) => e.stopPropagation() } },
    ...options.map(([v, t]) => { const o = el("option", { value: v }, t); if (v === value) o.selected = true; return o; }));
  return el("label", {}, `${label} `, s);
};

/** Upload the picked files into input/soundstage_worlds; resolves {main, files} (blob URLs when the upload fails). */
async function uploadAll(api, list) {
  const files = {};
  let main = null, temporary = false;
  const isMain = (f) => [...WORLD_MESH_FORMATS, ...WORLD_SPLAT_FORMATS].includes(extOf(f.name));
  for (const f of list) {
    let url = null;
    try {
      const body = new FormData();
      body.append("image", f, f.name);
      body.append("type", "input");
      body.append("subfolder", "soundstage_worlds");
      body.append("overwrite", "true");
      const r = await api.fetchApi("/upload/image", { method: "POST", body });
      const j = r.status === 200 ? await r.json() : null;
      if (j?.name) url = api.apiURL(`/view?filename=${encodeURIComponent(j.name)}&subfolder=${encodeURIComponent(j.subfolder || "")}&type=input`);
    } catch { /* fall back below */ }
    if (!url) { url = URL.createObjectURL(f); temporary = true; }
    files[f.name] = url;
    if (!main && isMain(f)) main = { name: f.name, url };
  }
  return { main, files, temporary };
}

/** The "Import world…" button, its hidden file input and the floating world panel. */
export function worldControls(stage, { api, status = null } = {}) {
  if (!document.getElementById("ss-worldpanel-css")) document.head.append(el("style", { id: "ss-worldpanel-css" }, CSS));
  const say = (t) => { const s = typeof status === "function" ? status() : status; if (s) s.textContent = t; };
  const input = el("input", { type: "file", accept: WORLD_ACCEPT, multiple: true, hidden: true });
  const button = el("button", { type: "button", class: "ss-btn ss-worldbtn",
    title: "Bring a whole location in as the Set: GLB / glTF / FBX / OBJ from Blender, Unreal, Maya or Sketchfab, or a Gaussian splat (.spz .splat .ply). Units, up axis and the floor are worked out; the meshes become colliders; cameras in the file become shots. Pick a .gltf together with its .bin and textures." },
    "Import world…");
  const panel = el("div", { class: "ss-worldpanel", hidden: true });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  const place = () => {
    const r = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.min(r.bottom + 6, innerHeight - panel.offsetHeight - 8)}px`;
  };
  const open = () => { if (!panel.isConnected) document.body.append(panel); panel.hidden = false; place(); };
  const close = () => { panel.hidden = true; };
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  button.addEventListener("pointerdown", (e) => e.stopPropagation());
  button.addEventListener("click", () => {
    if (stage.state.world?.url) { if (panel.hidden) { render(stage.worldMount?.info); open(); } else close(); }
    else input.click();
  });
  const mount = () => stage.worldMount;

  function render(info) {
    const w = stage.state.world;
    button.textContent = w?.url ? `World: ${w.name || "imported"}` : "Import world…";
    if (!w?.url) { panel.replaceChildren(); close(); return; }
    const kids = [el("div", { class: "hd" }, el("b", {}, `World: ${w.name || "imported"}`),
      el("button", { type: "button", title: "Close", on: { click: close } }, "×"))];
    if (!info) kids.push(el("div", { class: "why" }, "Loading…"));
    else if (info.error) kids.push(el("div", { class: "err" }, `Couldn't load it: ${info.error}`));
    else {
      kids.push(el("div", { class: "readout" }, info.readout));
      kids.push(el("div", { class: "why" }, `Units: ${info.units} (${info.reasons.units}) · Up: ${String(info.up).toUpperCase()} (${info.reasons.up}) · main floor put on the stage floor`));
      for (const f of info.fixes || []) {
        kids.push(el("div", { class: "fix" }, `${f.text}. `, el("button", { type: "button", class: "go", on: { click: () => mount().applyFix(f) } }, f.label)));
      }
      kids.push(el("div", { class: "row" },
        select("Came from", w.source || "auto", [["auto", "Auto"], ...Object.entries(SOURCE_PRESETS).map(([k, v]) => [k, v.label])], (v) => mount().setWorld({ source: v, up: "auto", units: "auto", scale_mul: 1 })),
        select("Units", w.units || "auto", [["auto", "Auto"], ["m", "m"], ["cm", "cm"], ["mm", "mm"], ["in", "in"], ["ft", "ft"]], (v) => mount().setWorld({ units: v, scale_mul: 1 })),
        select("Up", w.up || "auto", [["auto", "Auto"], ["y", "Y"], ["z", "Z"], ["-y", "−Y"], ["-z", "−Z"], ["x", "X"]], (v) => mount().setWorld({ up: v }))));
      const hIn = el("input", { type: "number", min: "0.1", step: "0.1", value: info.size?.[1] ? (+info.size[1].toFixed(2)) : "" });
      kids.push(el("div", { class: "row" }, "Make it ", hIn, " m tall",
        el("button", { type: "button", on: { click: () => mount().setHeight(+hIn.value) } }, "Set"),
        el("button", { type: "button", title: "One tenth the size", on: { click: () => mount().setWorld({ scale_mul: (w.scale_mul || 1) * 0.1 }) } }, "×0.1"),
        el("button", { type: "button", title: "Ten times the size", on: { click: () => mount().setWorld({ scale_mul: (w.scale_mul || 1) * 10 }) } }, "×10")));
      const col = el("input", { type: "checkbox" }); col.checked = w.colliders !== false;
      col.addEventListener("change", () => mount().setWorld({ colliders: col.checked }));
      const grd = el("input", { type: "checkbox" }); grd.checked = w.hide_ground !== false;
      grd.addEventListener("change", () => mount().setWorld({ hide_ground: grd.checked }));
      const kinds = Object.entries(info.colliderKinds || {}).map(([k, n]) => `${n} ${k}`).join(", ");
      kids.push(el("div", { class: "row" },
        el("label", { title: kinds ? `Box proxies: ${kinds}` : "" }, col, ` Physics colliders (${info.colliders}${info.collidersDropped ? `, ${info.collidersDropped} small ones left out` : ""})`),
        el("label", {}, grd, " Hide the stage floor")));
      const bits = [];
      if (!info.splat) bits.push(`${info.meshes} meshes → ${info.draws} draw calls`, `${info.tris >= 1e6 ? (info.tris / 1e6).toFixed(1) + " M" : Math.round(info.tris / 1000) + " k"} triangles`);
      else bits.push("Gaussian splat: shows in Color view; clay, depth and physics see only the stage floor");
      if (info.lods) bits.push(`${info.lods} far LODs`);
      if (info.shots?.length) bits.push(`cameras → shots: ${info.shots.join(", ")}`);
      if (info.animated) bits.push(`${info.animated} animated object${info.animated > 1 ? "s" : ""} play on the timeline`);
      if (info.lights) bits.push(`${info.lights} file light${info.lights > 1 ? "s" : ""} off (the stage lights the set)`);
      if (w.temporary) bits.push("not uploaded: this world lasts until you reload the page");
      kids.push(el("div", { class: "stats" }, bits.join(" · ")));
      kids.push(el("div", { class: "row" },
        info.animated ? el("button", { type: "button", on: { click: () => mount().matchShotLength() } }, "Match shot length to its animation") : null,
        el("button", { type: "button", on: { click: () => { mount().removeWorld(); render(null); } } }, "Remove world")));
    }
    panel.replaceChildren(...kids);
    if (!panel.hidden) place();
  }

  const hook = () => { if (mount()) mount().onInfo = (info) => { render(info); if (info && !info.error) say(`${info.readout}.`); }; };
  hook();
  input.addEventListener("change", async () => {
    const list = [...(input.files || [])];
    input.value = "";
    if (!list.length) return;
    say(`Uploading ${list.map((f) => f.name).join(", ")}…`);
    const up = await uploadAll(api, list);
    if (!up.main) { say("Pick a GLB, glTF, FBX, OBJ, PLY, STL or splat file (a .gltf with its .bin and textures)."); return; }
    hook();
    render(null);
    open();
    const deps = Object.fromEntries(Object.entries(up.files).filter(([n]) => n !== up.main.name));
    const info = await mount().importWorld(up.main.url, { name: up.main.name, format: extOf(up.main.name), files: deps, temporary: up.temporary });
    if (info) say(`${info.readout} (${fmtLen(info.size[0])} wide). Physics: ${info.colliders} colliders.`);
  });
  return { button, input, panel, render };
}
