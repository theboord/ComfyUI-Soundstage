// Model downloader, pure helpers (no DOM; tests/js/modelplan.test.mjs). The panel (panel.mjs) draws what these return.
//
// The server's /soundstage/models/status gives the catalog items with a state (installed / partial / missing) and the
// files each models folder already has. Here: group the items, work out "you already have another build of this"
// (the same matching the missing-model notice uses), add up sizes, list the licences a selection needs, and the
// steps for a gated model.

import { baseName, familyKey, closestModel, shortModelName, isModelFile } from "../ui/modelmatch.mjs";

export const HF_TOKENS_URL = "https://huggingface.co/settings/tokens";
const HF = "https://huggingface.co";

/** 1234567890 -> "1.23 GB" (decimal, like Hugging Face shows sizes). null -> "size unknown". */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "size unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

/** The file's name inside its models folder, as ComfyUI lists it ("ltx2.5/foo.safetensors"). */
export const relName = (item) => (item.subdir ? `${item.subdir}/` : "") + item.saved_name;

/**
 * The row state: the server's installed / partial / missing, plus "other_build" when the folder already has a
 * different build of the same model (fp8 when the catalog has int8), so nobody downloads 20 GB they don't need.
 * Returns { state, using?, pct? }.
 */
export function stateFor(item, installedFiles = {}) {
  const s = item.state || "missing";
  // size_note: the file differs from the catalog's rounded size estimate. Only a hint, never a reason to re-download.
  if (s === "installed") return item.size_note ? { state: "installed", sizeNote: true } : { state: "installed" };
  if (s === "unknown") return { state: "unknown" };
  const list = (installedFiles || {})[item.folder] || [];
  // ComfyUI lists every folder of this type (extra_model_paths.yaml adds more): the exact name anywhere is the model.
  // Only an exact size known to differ (wrong_size, from the server) overrides that.
  if (!item.wrong_size && list.includes(relName(item))) return { state: "installed" };
  const got = closestModel(relName(item), list);
  if (got && got !== relName(item)) return { state: "other_build", using: got, label: shortModelName(got) };
  const wrong = item.wrong_size ? { wrong: true } : {};
  if (s === "partial") {
    const pct = item.size ? Math.min(99, Math.floor((100 * (item.have_bytes || 0)) / item.size)) : null;
    return { state: "partial", pct, ...wrong };
  }
  return { state: "missing", ...wrong };
}

/** Chip text for a row state. */
export function stateLabel(st) {
  switch (st.state) {
    case "installed": return st.sizeNote ? "Installed (size differs from the estimate)" : "Installed";
    case "other_build": return `Using your build: ${st.label}`;
    case "partial": return st.pct == null ? "Partly downloaded" : `Partly downloaded ${st.pct}%`;
    case "unknown": return "Not checked (no server)";
    default: return st.wrong ? "Wrong size: download again" : "Missing";
  }
}

/** Items grouped in catalog group order: [{ group, items }] (empty groups dropped). */
export function groupItems(status) {
  const groups = status.groups || [];
  const out = groups.map((g) => ({ group: g, items: (status.items || []).filter((it) => it.group === g.id) }));
  return out.filter((g) => g.items.length);
}

/** Ids a fresh panel ticks: missing (or partial) non-optional items of default groups. */
export function defaultSelection(status) {
  const def = new Set((status.groups || []).filter((g) => g.default).map((g) => g.id));
  return (status.items || []).filter((it) => def.has(it.group) && !it.optional
    && ["missing", "partial"].includes(stateFor(it, status.installed_files).state)).map((it) => it.id);
}

/** { count, bytes, unknown } for the selected items; bytes still to fetch (a partial file counts what's left). */
export function selectionTotals(items, selected) {
  const sel = new Set(selected);
  let count = 0, bytes = 0, unknown = 0;
  for (const it of items || []) {
    if (!sel.has(it.id)) continue;
    count++;
    if (it.size == null) unknown++;
    else bytes += Math.max(0, it.size - (it.state === "partial" ? it.have_bytes || 0 : 0));
  }
  return { count, bytes, unknown };
}

/**
 * The ticked ids the Download button and the confirm both use: everything ticked except what is already installed
 * (or unchecked offline). A ticked "Using your build" row stays in: ticking it asks for the catalog's build too.
 */
export function fetchableIds(items, selected, installedFiles = {}) {
  const by = new Map((items || []).map((it) => [it.id, it]));
  return [...(selected || [])].filter((i) => by.has(i) && !["installed", "unknown"].includes(stateFor(by.get(i), installedFiles).state));
}

/**
 * The panel's note once the queued files are no longer running: how many finished, how many failed (the failed
 * rows carry their own red line). prog: { done:[{id}], failed:[{id}] }; queued: the ids this panel queued.
 */
export function jobNote(queued, prog) {
  const q = new Set(queued || []);
  if (!q.size) return "";
  const last = (arr) => { const m = new Map(); for (const x of arr || []) if (q.has(x.id)) m.set(x.id, x); return m; };
  const done = last(prog?.done), failed = last(prog?.failed);
  for (const id of done.keys()) failed.delete(id);
  const nd = done.size, nf = failed.size;
  const parts = [];
  if (nd) parts.push(`${nd} file${nd === 1 ? "" : "s"} downloaded. Reload the workflow so the loaders see the new files.`);
  if (nf) parts.push(`${nf} file${nf === 1 ? "" : "s"} didn't download: see the red line on ${nf === 1 ? "its row" : "each row"}.`);
  return parts.join(" ");
}

/** "Download 3 files · 6.53 GB" (+ " + 1 of unknown size"). */
export function footerLine(t) {
  if (!t.count) return "Nothing selected";
  const unk = t.unknown ? ` + ${t.unknown} of unknown size` : "";
  return `Download ${t.count} file${t.count === 1 ? "" : "s"} · ${fmtBytes(t.bytes)}${unk}`;
}

const usd = (n) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n.toLocaleString("en-US")}`);
const GEO = { US: "the USA", EU: "the EU", UK: "the UK", KR: "South Korea" };

/** One licence, in plain words: { key, name, url, line, limit, geo } (geo: the red warning line, or null). */
export function licenceLine(key, lic) {
  const limit = lic.revenue_limit_usd != null ? `Commercial use below ${usd(lic.revenue_limit_usd)} annual revenue` : null;
  const ex = (lic.geo_excluded || []).map((c) => GEO[c] || c);
  const geo = ex.length ? `Not licensed in ${ex.length > 1 ? ex.slice(0, -1).join(", ") + " or " + ex.at(-1) : ex[0]}` : null;
  return { key, name: lic.name, url: lic.url, limit, geo, line: [lic.name, limit].filter(Boolean).join(": ") };
}

/** Every licence the selection needs, in first-seen order, with which items use it. */
export function licencesFor(items, selected, licences) {
  const sel = new Set(selected);
  const out = new Map();
  for (const it of items || []) {
    if (!sel.has(it.id)) continue;
    for (const k of it.licences || []) {
      if (!out.has(k)) out.set(k, { ...licenceLine(k, (licences || {})[k] || { name: k }), items: [] });
      out.get(k).items.push(it.id);
    }
  }
  return [...out.values()];
}

/** The Download button in the confirm dialog: only when every licence is ticked (and there is something). */
export function canConfirm(lines, ticked) {
  const t = new Set(ticked);
  return lines.length > 0 && lines.every((l) => t.has(l.key));
}

/**
 * The notice's missing file names -> catalog ids: first the exact file (by base name), then the same model family
 * (the workflow named bf16, the catalog has int8). Unknown names are returned in `unknown`.
 */
export function idsForMissing(missing, items) {
  const ids = [], unknown = [];
  for (const m of missing || []) {
    if (!isModelFile(m)) { unknown.push(m); continue; }
    const b = baseName(m).toLowerCase();
    let hit = (items || []).find((it) => it.saved_name.toLowerCase() === b || baseName(it.path).toLowerCase() === b);
    if (!hit) { const f = familyKey(m); hit = f ? (items || []).find((it) => familyKey(it.saved_name) === f) : null; }
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else unknown.push(m);
  }
  return { ids, unknown };
}

/**
 * What to do when an item can't be fetched yet. access: "sign_in" | "licence" | "not_found" | "error" | "ok".
 * Returns [{ text, href? }] steps in order; [] when it's ready.
 */
export function stepsFor(item, access, signedIn = false) {
  const repo = `${HF}/${item.repo}`;
  const token = { text: "Make a read token on Hugging Face (read access is enough) and paste it above", href: HF_TOKENS_URL };
  const accept = { text: `Open ${item.repo} on Hugging Face and accept its licence`, href: repo };
  switch (access) {
    case "ok": return [];
    case "sign_in": return item.gated ? [...(signedIn ? [] : [token]), accept, { text: "Check again" }] : [token, { text: "Check again" }];
    case "licence": return [accept, { text: "Check again" }];
    case "bad_token": return [{ text: "Your Hugging Face token was refused: replace it above" }, { text: "Check again" }];
    case "not_found": return [{ text: "Hugging Face can't find this file. It may have moved; see MODELS.md", href: repo }];
    default: return [{ text: "Couldn't reach Hugging Face. Check the connection and try again" }];
  }
}

/**
 * The panel when no ComfyUI server answers (the try-it demo, or the server is down): the catalog itself
 * (web/models/catalog.json), in the same shape as /soundstage/models/status, read-only. Nothing is checked or
 * fetched: every row is "unknown", and `offline` tells the panel to drop the checkboxes, token box and Download.
 */
export function offlineStatus(catalog) {
  const cat = catalog || {};
  return {
    offline: true, groups: cat.groups || [], licences: cat.licences || {}, sets: cat.sets || {},
    items: (cat.items || []).map((it) => ({ ...it, state: "unknown", have_bytes: 0, repo_url: `${HF}/${it.repo}` })),
    installed_files: {}, signed_in: false, user: null, token_source: null, free_bytes: {}, busy: false,
  };
}

/** Offline, a gated row shows what it will need, without the "Check again" button (there's nothing to check with). */
export function offlineSteps(item) {
  if (!item.gated) return [];
  return stepsFor(item, "sign_in", false).filter((s) => s.text !== "Check again")   // no token box offline: no "paste it above"
    .map((s) => (s.href === HF_TOKENS_URL ? { ...s, text: "Make a read token on Hugging Face (read access is enough)" } : s));
}

/** The try-it demo has no ComfyUI server: say so without asking one (a request there would log a 404). */
export const noServer = (g = globalThis) => !!g?.__demo;

const SOURCE = { saved: "the token saved on this computer", environment: "the HF_TOKEN set for ComfyUI", hf_cli: "your huggingface-cli login" };

/**
 * What the token box says. status: { signed_in, user, token_source, token_fallback }.
 * Returns { line, canRemove, pasteButton, pasteNote, removeNote }. A pasted token is saved and always wins over
 * HF_TOKEN and the huggingface-cli login; Remove token goes back to whichever of those is there.
 */
export function tokenNote(status = {}) {
  const src = status.signed_in ? status.token_source : null;
  const fb = status.token_fallback;
  const fbName = fb && fb !== "saved" ? SOURCE[fb] : null;
  if (src === "saved") {
    return { line: `Hugging Face: signed in${status.user ? ` as ${status.user}` : ""} (using ${SOURCE.saved})`, canRemove: true,
      pasteButton: "Replace token…", pasteNote: "The new token replaces the saved one.",
      removeNote: fbName ? `Remove token goes back to ${fbName}.` : "" };
  }
  if (src === "environment" || src === "hf_cli") {
    return { line: `Hugging Face: using ${SOURCE[src]}`, canRemove: false, pasteButton: "Use a different token…",
      pasteNote: `Use my saved token: a token you save here is used instead of ${SOURCE[src]} (a saved token always wins). Remove token goes back to it.`,
      removeNote: "" };
  }
  return { line: "Some models need a Hugging Face sign-in.", canRemove: false, pasteButton: null, pasteNote: "", removeNote: "" };
}

/** The banner over the offline list. */
export const OFFLINE_TEXT = "The App's server isn't answering, so this is the list of model files and their licences only. "
  + "Checking what you have and downloading need the App running in ComfyUI.";

/** The one-line progress text: "flux2-vae · 41% · 12.3 MB/s · 2 min left". */
export function progressLine(cur, title = cur?.id) {
  if (!cur) return "";
  if (cur.phase === "hashing") return `${title} · checking the part already downloaded…`;
  if (cur.phase === "verifying") return `${title} · verifying…`;
  if (cur.phase === "checking") return `${title} · starting…`;
  const pct = cur.total ? `${Math.floor((100 * cur.bytes) / cur.total)}%` : fmtBytes(cur.bytes);
  const rate = cur.rate ? `${fmtBytes(cur.rate)}/s` : null;
  const eta = cur.eta == null ? null : cur.eta < 90 ? `${cur.eta} s left` : `${Math.round(cur.eta / 60)} min left`;
  return [title, pct, rate, eta].filter(Boolean).join(" · ");
}

/** What a failed job says. */
export const FAIL_TEXT = {
  sign_in: "Sign in with your Hugging Face token",
  licence: "Accept the licence on Hugging Face, then try again",
  bad_token: "Your Hugging Face token was refused: replace it above",
  not_model: "Got a web page instead of the model file (a Wi-Fi sign-in page or a proxy?). Nothing was saved",
  not_found: "Hugging Face can't find this file",
  disk: "Not enough free disk space",
  verify: "The file didn't match and was deleted. Try again",
  network: "The connection dropped. Click Download again to resume",
  path: "Refused: that file would go outside the models folder",
  cancelled: "Cancelled (the part downloaded so far is kept)",
  revision: "The pinned version is gone from Hugging Face",
  error: "Couldn't reach Hugging Face",
};
