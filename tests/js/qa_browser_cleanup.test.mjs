// node --test tests/js/qa_browser_cleanup.test.mjs
// tools/qa/lib.mjs launch(): the throwaway Chrome profile (ssqa-*) is deleted however the run ends, and the whole
// browser process group is stopped first. Final review: close() killed only the main Chrome process and deleted the
// profile at once (helpers wrote into it afterwards), a Chrome that never answered left its profile, and Ctrl-C /
// SIGTERM left both. 282 ssqa-* folders (3.8 GB) had piled up. Stand-in browsers (shell scripts) only: no Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = pathToFileURL(fileURLToPath(new URL("../../tools/qa/lib.mjs", import.meta.url))).href;
const PROC = pathToFileURL(fileURLToPath(new URL("../../tools/qa/browser_proc.mjs", import.meta.url))).href;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

// A stand-in Chrome: records its pid and profile, forks a helper that writes into the profile `late` s in, then hangs.
function fakeChrome(box, late = 3) {
  const log = join(box, "dir.txt"), pidf = join(box, "pid.txt"), hpidf = join(box, "helper.txt"), exe = join(box, "fake-chrome");
  writeFileSync(exe, `#!/bin/sh
for a; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}"; mkdir -p "$d/Default"; printf %s "$d" > "${log}";; esac; done
( sleep ${late}; mkdir -p "$d/Default"; echo late > "$d/Default/Late" ) </dev/null >/dev/null 2>&1 &
echo $! > "${hpidf}"
echo $$ > "${pidf}.tmp"; mv "${pidf}.tmp" "${pidf}"
sleep 30
`);
  chmodSync(exe, 0o755);
  return { exe, log, pidf, hpidf };
}

async function runChild(box, code, env = {}) {
  const runner = join(box, "run.mjs");
  writeFileSync(runner, code);
  const node = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "";
  node.stdout.on("data", (d) => (out += d)); node.stderr.on("data", (d) => (out += d));
  const exit = new Promise((ok) => node.once("exit", (code, signal) => ok({ code, signal })));
  return { node, exit, out: () => out };
}

function cleanup(box, f) {
  for (const p of [f.pidf, f.hpidf]) { try { const n = Number(readFileSync(p, "utf8")); try { process.kill(-n, "SIGKILL"); } catch {} try { process.kill(n, "SIGKILL"); } catch {} } catch {} }
  try { const d = readFileSync(f.log, "utf8"); if (d.includes("ssqa-")) rmSync(d, { recursive: true, force: true }); } catch {}
  rmSync(box, { recursive: true, force: true });
}

test("launch(): a Chrome that never answers is stopped with its helpers and its ssqa-* profile is deleted (and stays deleted)", { timeout: 60000 }, async () => {
  const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
  const f = fakeChrome(box, 3);
  try {
    const c = await runChild(box, `import { launch } from ${JSON.stringify(LIB)};
try { await launch({ port: 1, chrome: ${JSON.stringify(f.exe)}, startMs: 1500 }); console.log("STARTED"); } catch (e) { console.log("ERR " + e.message); }
`, { CHROME: f.exe });
    const end = await c.exit;
    assert.match(c.out(), /ERR Chrome did not start/, `${c.out()} ${JSON.stringify(end)}`);
    const dir = readFileSync(f.log, "utf8");
    assert.ok(dir.includes("ssqa-"), dir);
    await sleep(3500);   // past the helper's late write
    assert.equal(alive(Number(readFileSync(f.hpidf, "utf8"))), false, "the helper was stopped with the browser");
    assert.equal(existsSync(dir), false, `the profile folder is deleted and stays deleted: ${dir}`);
  } finally { cleanup(box, f); }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  test(`launch(): a QA run stopped by ${sig} stops the browser group and deletes its ssqa-* profile`, { timeout: 30000 }, async () => {
    const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
    const f = fakeChrome(box, 20);
    try {
      const c = await runChild(box, `import { launch } from ${JSON.stringify(LIB)};
await launch({ port: 1, chrome: ${JSON.stringify(f.exe)}, startMs: 25000 });
`, { CHROME: f.exe });
      for (let i = 0; i < 100 && !(existsSync(f.log) && existsSync(f.pidf)); i++) await sleep(100);
      const dir = readFileSync(f.log, "utf8"), pid = Number(readFileSync(f.pidf, "utf8"));
      assert.ok(existsSync(dir) && alive(pid), "the stand-in runs with its profile");
      c.node.kill(sig);
      const end = await c.exit;
      assert.equal(end.signal, sig, `the run still ends by ${sig}`);
      for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
      assert.equal(alive(pid), false, "the stand-in browser was stopped");
      assert.equal(existsSync(dir), false, `the profile folder is deleted: ${dir}`);
    } finally { cleanup(box, f); }
  });
}

test("stopBrowser (what close() runs): stops the whole group before deleting, so a helper's late write can't bring the profile back", { timeout: 30000 }, async () => {
  const { spawnBrowser, stopBrowser } = await import(PROC);
  const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
  const f = fakeChrome(box, 2);
  const prof = mkdtempSync(join(tmpdir(), "ssqa-"));
  try {
    const child = spawnBrowser(f.exe, [`--user-data-dir=${prof}`], { stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(f.hpidf); i++) await sleep(100);
    await stopBrowser(child, prof);
    await sleep(2500);
    assert.equal(existsSync(prof), false, `the profile stays deleted after the helper's late write: ${prof}`);
  } finally { rmSync(prof, { recursive: true, force: true }); cleanup(box, f); }
});

test("tools/qa drivers wait for close() (the profile is deleted after the browser is gone, before the process exits)", () => {
  const dir = fileURLToPath(new URL("../../tools/qa/", import.meta.url));
  const bad = [];
  for (const n of ["editlink_click", "playback_bench", "scenestrip_overlap", "passes_viewer", "toprow_check", "v2s_compare", "popover_sweep", "v2sfix_click", "visual_baseline"]) {
    const s = readFileSync(join(dir, n + ".mjs"), "utf8");
    if (/\bb\.close\(\)/.test(s.replace(/await b\.close\(\)/g, ""))) bad.push(n);
  }
  assert.deepEqual(bad, []);
});

test("every test file that makes a temp folder with mkdtempSync also removes one (takecheck left one ss-tc-* per run)", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const bad = readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).filter((n) => {
    const s = readFileSync(join(dir, n), "utf8");
    return /mkdtempSync\(/.test(s) && !/rmSync\(/.test(s);
  });
  assert.deepEqual(bad, []);
});
