// node --test tests/js/modelplan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  fmtBytes, relName, stateFor, stateLabel, groupItems, defaultSelection, selectionTotals, footerLine, licenceLine,
  licencesFor, canConfirm, idsForMissing, stepsFor, progressLine, HF_TOKENS_URL, offlineStatus, offlineSteps, OFFLINE_TEXT,
} from "../../web/models/plan.mjs";

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
