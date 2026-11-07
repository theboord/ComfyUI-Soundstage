// node --test tests/js/modelplan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  fmtBytes, relName, stateFor, stateLabel, groupItems, defaultSelection, selectionTotals, footerLine, licenceLine,
  licencesFor, canConfirm, idsForMissing, stepsFor, progressLine, HF_TOKENS_URL, offlineStatus, offlineSteps, OFFLINE_TEXT,
  fetchableIds, jobNote, noServer, tokenNote, FAIL_TEXT,
} from "../../web/models/plan.mjs";
import { keyGuard, installKeyGuard, openPanels } from "../../web/models/panel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAT = JSON.parse(readFileSync(join(ROOT, "web/models/catalog.json"), "utf8"));
const status = (over = {}, files = {}) => ({
  groups: CAT.groups, licences: CAT.licences, installed_files: files,
  items: CAT.items.map((it) => ({ ...it, state: "missing", have_bytes: 0, ...(over[it.id] || {}) })),
});
const byId = (s, id) => s.items.find((i) => i.id === id);

test("fmtBytes", () => {
  assert.equal(fmtBytes(5830000000), "5.83 GB");
  assert.equal(fmtBytes(21500000000), "21.5 GB");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(null), "size unknown");
});

test("relName keeps the subfolder", () => {
  assert.equal(relName(byId(status(), "ltx25-layout-lora")), "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors");
});

test("stateFor: installed, partial %, missing, and another build of the same model", () => {
  const s = status({ "flux2-vae": { state: "installed" }, "sam31": { state: "partial", have_bytes: 875000000 } },
    { diffusion_models: ["flux3-image-klein-fp8-scaled.safetensors"], loras: ["ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"] });
  assert.deepEqual(stateFor(byId(s, "flux2-vae"), s.installed_files), { state: "installed" });
  assert.deepEqual(stateFor(byId(s, "sam31"), s.installed_files), { state: "partial", pct: 50 });
  const ob = stateFor(byId(s, "flux3-klein-int8"), s.installed_files);
  assert.equal(ob.state, "other_build");
  assert.equal(ob.using, "flux3-image-klein-fp8-scaled.safetensors");
  assert.match(stateLabel(ob), /^Using your build: /);
  // the LoRA at the folder root (not under ltx2.5/) counts as your build too
  assert.equal(stateFor(byId(s, "ltx25-layout-lora"), s.installed_files).state, "other_build");
  assert.deepEqual(stateFor(byId(s, "qwen35-4b"), s.installed_files), { state: "missing" });
  assert.equal(stateLabel({ state: "partial", pct: 50 }), "Partly downloaded 50%");
});

test("grouping follows catalog group order and default selection skips optional + installed", () => {
  const s = status({ "flux2-vae": { state: "installed" } });
  const g = groupItems(s);
  assert.deepEqual(g.map((x) => x.group.id), CAT.groups.map((x) => x.id));
  assert.equal(g.reduce((n, x) => n + x.items.length, 0), CAT.items.length);
  const sel = defaultSelection(s);
  assert.ok(sel.includes("flux3-klein-int8") && sel.includes("ltx25-distilled-int8"));
  assert.ok(!sel.includes("flux2-vae") && !sel.includes("ltx25-temporal-x2") && !sel.includes("sam31"));
});

test("totals add up, partial counts only what's left, unknown sizes counted", () => {
  const s = status({ "sam31": { state: "partial", have_bytes: 750000000 } });
  const t = selectionTotals(s.items, ["flux3-klein-int8", "qwen3vl-4b-int8", "flux2-vae", "sam31", "qwen-image-vae"]);
  assert.deepEqual(t, { count: 5, bytes: 5830000000 + 4860000000 + 340000000 + 1000000000, unknown: 1 });
  assert.equal(footerLine(t), "Download 5 files · 12.0 GB + 1 of unknown size");
  assert.equal(footerLine({ count: 0 }), "Nothing selected");
});

test("licence lines: revenue limit, geo flag for MiniMax, de-duplicated across items", () => {
  const s = status();
  const lines = licencesFor(s.items, ["ltx25-distilled-int8", "ltx25-gemma4-int8", "ltx25-video-vae", "minimax-h3-fl2va-int8"], CAT.licences);
  assert.deepEqual(lines.map((l) => l.key), ["ltx2-community", "gemma", "minimax-h3"]);
  assert.equal(lines[0].line, "LTX-2 Community License: Commercial use below $10M annual revenue");
  assert.deepEqual(lines[0].items, ["ltx25-distilled-int8", "ltx25-gemma4-int8", "ltx25-video-vae"]);
  assert.equal(lines[1].limit, null);
  const mm = lines[2];
  assert.equal(mm.geo, "Not licensed in the USA, the EU, the UK or South Korea");
  assert.ok(lines.every((l) => l.url.startsWith("https://")));
  assert.equal(licenceLine("x", { name: "X", revenue_limit_usd: null, geo_excluded: [] }).geo, null);
});

test("canConfirm needs every licence ticked", () => {
  const lines = licencesFor(status().items, ["flux3-klein-int8", "flux2-vae"], CAT.licences);
  assert.equal(canConfirm(lines, []), false);
  assert.equal(canConfirm(lines, ["flux-kommunity"]), false);
  assert.equal(canConfirm(lines, ["flux-kommunity", "apache-2.0"]), true);
  assert.equal(canConfirm([], []), false);
});

test("idsForMissing: the notice's file names map to catalog ids, by file then by family", () => {
  const { ids, unknown } = idsForMissing([
    "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",     // exact file, other folder
    "ltx-2.5-22b-distilled-transformer-bf16.safetensors",              // family match (bf16 vs int8)
    "krea2_turbo_fp8_scaled.safetensors",                              // repo file name, saved under another name
    "something-else-entirely.safetensors", "not a model",
  ], CAT.items);
  assert.deepEqual(ids, ["ltx25-layout-lora", "ltx25-distilled-int8", "krea2-turbo-fp8"]);
  assert.deepEqual(unknown, ["something-else-entirely.safetensors", "not a model"]);
});

test("steps for a gated model link to the repo page and the token page", () => {
  const it = byId(status(), "ltx25-distilled-int8");
  assert.deepEqual(stepsFor(it, "ok"), []);
  const s1 = stepsFor(it, "sign_in");
  assert.equal(s1[0].href, HF_TOKENS_URL);
  assert.match(s1[0].text, /read access is enough/);
  assert.equal(s1[1].href, "https://huggingface.co/Lightricks/LTX-2.5");
  assert.equal(s1.at(-1).text, "Check again");
  assert.deepEqual(stepsFor(it, "sign_in", true).map((s) => s.href || null), ["https://huggingface.co/Lightricks/LTX-2.5", null]);
  const s2 = stepsFor(it, "licence");
  assert.match(s2[0].text, /accept its licence/);
  assert.equal(stepsFor(byId(status(), "sam31"), "not_found").length, 1);
});

test("progress line", () => {
  assert.equal(progressLine({ id: "a", phase: "downloading", bytes: 41, total: 100, rate: 12300000, eta: 120 }, "FLUX.2 VAE"),
    "FLUX.2 VAE · 41% · 12.3 MB/s · 2 min left");
  assert.match(progressLine({ id: "a", phase: "hashing" }), /checking/);
  assert.equal(progressLine(null), "");
});

test("panel module only talks to its own routes and never writes the token into the page", () => {
  const src = readFileSync(join(ROOT, "web/models/panel.mjs"), "utf8");
  const urls = [...src.matchAll(/["'`](\/soundstage\/[^"'`?]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6 && urls.every((u) => u.startsWith("/soundstage/models/")), urls.join(","));
  assert.match(src, /type = "password"|type: "password"/);
  assert.match(src, /autocomplete/);
  assert.ok(!/localStorage|sessionStorage/.test(src), "the token must not go to browser storage");
});

test("offline (no server): the catalog read-only, nothing ticked, gated rows show the Hugging Face steps", () => {
  const s = offlineStatus(CAT);
  assert.equal(s.offline, true);
  assert.equal(s.items.length, CAT.items.length);
  assert.deepEqual(groupItems(s).map((g) => g.group.id), CAT.groups.map((g) => g.id));
  for (const it of s.items) assert.deepEqual(stateFor(it, s.installed_files), { state: "unknown" });
  assert.equal(stateLabel({ state: "unknown" }), "Not checked (no server)");
  assert.deepEqual(defaultSelection(s), []);
  const gated = byId(s, "flux3-klein-int8");
  const steps = offlineSteps(gated);
  assert.deepEqual(steps.map((x) => x.href), [HF_TOKENS_URL, `https://huggingface.co/${gated.repo}`]);
  assert.ok(!steps.some((x) => x.text === "Check again" || /paste it above/.test(x.text)));
  assert.deepEqual(offlineSteps(byId(s, "sam31")), []);
  assert.match(OFFLINE_TEXT, /ComfyUI/);
  assert.equal(offlineStatus(null).items.length, 0);
});

test("fetchableIds: footer and confirm use the same ids; a ticked 'Using your build' row is kept, installed dropped", () => {
  const s = status({ "flux2-vae": { state: "installed" } },
    { diffusion_models: ["flux3-image-klein-fp8.safetensors"] });
  assert.equal(stateFor(byId(s, "flux3-klein-int8"), s.installed_files).state, "other_build");
  const ids = fetchableIds(s.items, ["flux3-klein-int8", "flux2-vae", "nope"], s.installed_files);
  assert.deepEqual(ids, ["flux3-klein-int8"]);
  // so the confirm dialog always has a licence to tick for what the footer counted
  const lines = licencesFor(s.items, ids, s.licences);
  assert.ok(lines.length > 0);
  assert.equal(selectionTotals(s.items, ids).count, 1);
  assert.deepEqual(fetchableIds(offlineStatus(CAT).items, ["flux2-vae"], {}), []);
});

test("a wrong-size file with the right name is labelled for download again", () => {
  const st = stateFor({ ...byId(status(), "flux2-vae"), state: "missing", wrong_size: true }, { vae: ["flux2-vae.safetensors"] });
  assert.equal(st.state, "missing");
  assert.equal(stateLabel(st), "Wrong size: download again");
});

test("an installed file off the rounded catalog size gets a soft note only, and is not pre-ticked", () => {
  const s = status();
  const it = { ...byId(s, "flux2-vae"), state: "installed", size_note: true };
  const st = stateFor(it, { vae: ["flux2-vae.safetensors"] });
  assert.equal(st.state, "installed");
  assert.equal(stateLabel(st), "Installed (size differs from the estimate)");
  assert.equal(stateLabel(stateFor({ ...it, size_note: false }, {})), "Installed");
  const items = s.items.map((x) => (x.id === "flux2-vae" ? it : x));
  const sel = defaultSelection({ ...s, items, installed_files: { vae: ["flux2-vae.safetensors"] } });
  assert.ok(!sel.includes("flux2-vae"));
  // the same row reported missing would be pre-ticked, so the check above is meaningful
  const miss = s.items.map((x) => (x.id === "flux2-vae" ? { ...x, state: "missing" } : x));
  assert.ok(defaultSelection({ ...s, items: miss, installed_files: {} }).includes("flux2-vae"));
});

test("jobNote: a fast failure (before any progress poll) is reported, and successes say to reload", () => {
  assert.equal(jobNote([], { done: [], failed: [] }), "");
  assert.match(jobNote(["a"], { done: [], failed: [{ id: "a", code: "disk" }] }), /1 file didn't download/);
  const n = jobNote(["a", "b", "c"], { done: [{ id: "a" }, { id: "b" }], failed: [{ id: "c" }, { id: "zz" }] });
  assert.match(n, /2 files downloaded\. Reload the workflow/);
  assert.match(n, /1 file didn't download/);
  // a retry that succeeded is not reported as failed
  assert.doesNotMatch(jobNote(["a"], { done: [{ id: "a" }], failed: [{ id: "a" }] }), /didn't/);
});

test("panel: Cancel stops the current file only; a failed /status after the first load doesn't go offline", () => {
  const src = readFileSync(join(ROOT, "web/models/panel.mjs"), "utf8");
  assert.ok(src.includes('call("/soundstage/models/cancel", { id: cur.id })'));
  assert.ok(!src.includes("all: true"));
  assert.match(src, /if \(!first && this\.status && !this\.status\.offline\)/);
});

test("a file with the exact name in any listed models folder is installed, even if the server's first folder lacks it", () => {
  // installed_files merges every folder ComfyUI lists (extra_model_paths.yaml); the server row may say missing
  const it = { ...byId(status(), "flux2-vae"), state: "missing" };
  assert.deepEqual(stateFor(it, { vae: ["flux2-vae.safetensors"] }), { state: "installed" });
  const lora = { ...byId(status(), "ltx25-layout-lora"), state: "missing" };
  assert.equal(stateFor(lora, { loras: [relName(lora)] }).state, "installed");
  // an exact size known to differ still wins
  assert.equal(stateFor({ ...it, wrong_size: true }, { vae: ["flux2-vae.safetensors"] }).state, "missing");
  const s = status({}, { vae: ["flux2-vae.safetensors"] });
  assert.ok(!defaultSelection(s).includes("flux2-vae"));
  assert.ok(!fetchableIds(s.items, ["flux2-vae"], s.installed_files).length);
});

test("a refused token says replace it, not 'can't find this file'", () => {
  const it = byId(status(), "flux2-vae");
  const steps = stepsFor(it, "bad_token", true);
  assert.equal(steps[0].text, "Your Hugging Face token was refused: replace it above");
  assert.ok(!steps.some((x) => /can't find/.test(x.text)));
  assert.match(FAIL_TEXT.bad_token, /refused: replace it above/);
  assert.match(FAIL_TEXT.not_model, /web page/);
});

test("token box: says which token is in use, a pasted one wins, Remove goes back to the fallback", () => {
  const env = tokenNote({ signed_in: true, token_source: "environment", token_fallback: "environment" });
  assert.match(env.line, /HF_TOKEN/);
  assert.equal(env.canRemove, false);
  assert.equal(env.pasteButton, "Use a different token…");
  assert.match(env.pasteNote, /^Use my saved token: .*instead of the HF_TOKEN/);
  const cli = tokenNote({ signed_in: true, token_source: "hf_cli", token_fallback: "hf_cli" });
  assert.match(cli.line, /huggingface-cli/);
  const saved = tokenNote({ signed_in: true, token_source: "saved", token_fallback: "environment", user: "jane-doe" });
  assert.match(saved.line, /jane-doe/);
  assert.ok(saved.canRemove && saved.pasteButton === "Replace token…");
  assert.match(saved.removeNote, /goes back to the HF_TOKEN/);
  assert.equal(tokenNote({ signed_in: true, token_source: "saved", token_fallback: null }).removeNote, "");
  assert.equal(tokenNote({ signed_in: false }).pasteButton, null);
});

test("no server in the try-it demo is detected without a request", () => {
  assert.equal(noServer({ __demo: { app: 1 } }), true);
  assert.equal(noServer({}), false);
  assert.equal(noServer(null), false);
  const src = readFileSync(join(ROOT, "web/models/panel.mjs"), "utf8");
  assert.match(src, /if \(first && noServer\(\)\) throw/);
});

test("while the panel is open no key reaches the App behind it; Esc closes it", () => {
  const win = new EventTarget();
  assert.equal(installKeyGuard(win), true);
  assert.equal(installKeyGuard(win), false);           // once
  const app = [];
  win.addEventListener("keydown", (e) => app.push(e.key), true);   // the App's window capture listeners come later
  const key = (k, o = {}) => { const e = new Event("keydown", { cancelable: true }); Object.assign(e, { key: k, ...o }); win.dispatchEvent(e); return e; };
  const panel = { closed: false, close() { this.closed = true; openPanels.delete(this); } };
  openPanels.add(panel);
  key("Tab"); key("h"); key("H"); key("z", { metaKey: true }); key(" ");
  assert.deepEqual(app, []);
  assert.equal(panel.closed, false);
  const esc = key("Escape");
  assert.equal(panel.closed, true);
  assert.equal(esc.defaultPrevented, true);
  assert.deepEqual(app, []);
  key("h");                                             // closed: keys reach the App again
  assert.deepEqual(app, ["h"]);
  // the dialog root gets the same guard in the capture phase
  const src = readFileSync(join(ROOT, "web/models/panel.mjs"), "utf8");
  assert.match(src, /this\.root\.addEventListener\("keydown", keyGuard, true\)/);
  assert.ok(!/document\.addEventListener\("keydown"/.test(src));
});
