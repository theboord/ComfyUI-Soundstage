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
  if (s === "installed") return { state: "installed" };
  const list = (installedFiles || {})[item.folder] || [];
  const got = closestModel(relName(item), list);
  if (got && got !== relName(item)) return { state: "other_build", using: got, label: shortModelName(got) };
  if (s === "partial") {
    const pct = item.size ? Math.min(99, Math.floor((100 * (item.have_bytes || 0)) / item.size)) : null;
    return { state: "partial", pct };
  }
  return { state: "missing" };
}

/** Chip text for a row state. */
export function stateLabel(st) {
  switch (st.state) {
    case "installed": return "Installed";
    case "other_build": return `Using your build: ${st.label}`;
    case "partial": return st.pct == null ? "Partly downloaded" : `Partly downloaded ${st.pct}%`;
    default: return "Missing";
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
    case "not_found": return [{ text: "Hugging Face can't find this file. It may have moved; see MODELS.md", href: repo }];
    default: return [{ text: "Couldn't reach Hugging Face. Check the connection and try again" }];
  }
}

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
  not_found: "Hugging Face can't find this file",
  disk: "Not enough free disk space",
  verify: "The file didn't match and was deleted. Try again",
  network: "The connection dropped. Click Download again to resume",
  path: "Refused: that file would go outside the models folder",
  cancelled: "Cancelled (the part downloaded so far is kept)",
  revision: "The pinned version is gone from Hugging Face",
  error: "Couldn't reach Hugging Face",
};
