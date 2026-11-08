// node --test tests/js/shaders_browser.test.mjs
// The Depth pass shader (web/stage/depthshader.mjs: skinned, unskinned, cut-out) and the selection outline
// (web/stage/outline.mjs: stencil mask + hull, skinned) compiled and rendered in real WebGL, in a headless Chromium
// already on this machine (tests/browser/run_shaders.mjs installs nothing). Node alone can't compile GLSL, so before
// this neither shader had ever been compiled by a test. Skipped, saying so, when no browser is found.
import test from "node:test";
import assert from "node:assert/strict";
import { runShaders, findBrowser } from "../browser/run_shaders.mjs";

const browser = findBrowser();

test("Depth and outline shaders compile and render in WebGL: a posed skinned mesh's Depth silhouette matches its colour silhouette; the outline rings it", { skip: browser ? false : "no headless Chromium / Chrome on this machine (run tests/browser/run_shaders.mjs where one is)", timeout: 90000 }, async () => {
  const r = await runShaders();
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.errors, [], "no shader compile / link errors, no exceptions");
  const c = r.checks;
  for (const k of ["depth_skinned", "depth_unskinned", "depth_cutout"]) {
    assert.ok(c[k].colourPx > 200, `${k}: the mesh is on screen (${c[k].colourPx} px)`);
    assert.ok(c[k].iou >= 0.9, `${k}: Depth silhouette vs colour silhouette overlap ${c[k].iou}`);
  }
  // the bend matters: the bind pose covers different pixels, so a Depth pass that ignored skinning would fail above
  assert.ok(c.depth_skinned.bindVsPosedIou < 0.7, `posed vs bind pose overlap ${c.depth_skinned.bindVsPosedIou}`);
  const o = c.outline_skinned;
  assert.equal(o.insidePx, 0, "the outline draws nothing over the object (stencil mask)");
  assert.ok(o.ringPx > 40, `an outline ring outside the silhouette (${o.ringPx} px)`);
  assert.ok(o.ringNearSilhouette >= 0.95, `the ring hugs the posed silhouette (${o.ringNearSilhouette} within 4 px)`);
});

test("runShaders deletes the browser's --user-data-dir afterwards (it left one ss-shaders-<pid> folder per run in the temp dir)", { timeout: 30000 }, async () => {
  // A stand-in browser (a shell script, no Chrome needed) fills its profile folder like Chrome does and prints no result.
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
  try {
    const log = join(box, "dir.txt"), exe = join(box, "fake-chrome");
    writeFileSync(exe, `#!/bin/sh\nfor a; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}"; mkdir -p "$d/Default"; echo x > "$d/Default/Cookies"; printf %s "$d" > "${log}";; esac; done\n`);
    chmodSync(exe, 0o755);
    const r = await runShaders({ browser: exe, timeoutMs: 20000 });
    assert.ok(r.error, "the stand-in prints no result");
    const dir = readFileSync(log, "utf8");
    assert.ok(dir.includes("ss-shaders-"), `the profile folder was ${dir}`);
    assert.equal(existsSync(dir), false, `the profile folder is deleted after the run: ${dir}`);
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test("runShaders on timeout stops the whole browser (its helper processes too) before deleting the profile: a helper writing late left ss-shaders-<x> behind", { timeout: 30000 }, async () => {
  // Seventh review: on timeout only the main process was killed and rmSync ran at once; a child still running wrote
  // into the profile afterwards and the folder came back (ss-shaders-o9iXU1). The stand-in browser forks a helper that
  // writes into the profile 3 s after it starts, then hangs so the 2 s timeout fires.
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
  let dir = "";
  try {
    const log = join(box, "dir.txt"), exe = join(box, "fake-chrome");
    writeFileSync(exe, `#!/bin/sh\nfor a; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}"; mkdir -p "$d/Default"; printf %s "$d" > "${log}";; esac; done\n( sleep 3; mkdir -p "$d/Default"; echo late > "$d/Default/Late" ) </dev/null >/dev/null 2>&1 &\nsleep 20\n`);
    chmodSync(exe, 0o755);
    const r = await runShaders({ browser: exe, timeoutMs: 2000 }).catch((e) => ({ error: String(e) }));
    assert.match(String(r.error), /timed out/, `the stand-in hangs: ${r.error}`);
    dir = readFileSync(log, "utf8");
    assert.ok(dir.includes("ss-shaders-"), `the profile folder was ${dir}`);
    await new Promise((ok) => setTimeout(ok, 3000));   // past the helper's late write
    assert.equal(existsSync(dir), false, `the profile folder stays deleted after the helper's late write: ${dir}`);
  } finally { rmSync(box, { recursive: true, force: true }); if (dir.includes("ss-shaders-")) rmSync(dir, { recursive: true, force: true }); }
});

test("no harness in this checkout names a browser profile folder by process id (the old ss-shaders-<pid> harness leaked one folder per run)", async () => {
  // Eighth review: the leftover folders kept growing after the harness fix because other checkouts and exported old
  // trees still run the old harness. This guards this checkout: every profile folder must come from mkdtemp.
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pidDir = new RegExp("ss-[a-z]+-\\$\\{process" + "\\.pid\\}");
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === ".git" || n === "vendor" || n === "people") continue;
      const p = join(d, n), s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(m?js|py|sh)$/.test(n) && s.size < 2e6 && pidDir.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
    }
  };
  for (const d of ["tests", "tools"]) walk(join(root, d));
  assert.deepEqual(hits, [], `pid-named profile folders in ${hits.join(", ")}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  test(`runShaders stopped by ${sig} (Ctrl-C) still stops the browser's process group and deletes the profile (a SIGTERM'd run left ss-shaders-WrZGjD and its Chrome running)`, { timeout: 30000 }, async () => {
    // Final review: a signal skips `finally`, so the detached stand-in browser kept running and its profile stayed.
    // A child Node runs the harness with a stand-in that records its pid and profile, then hangs; we signal the child.
    const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawn } = await import("node:child_process");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
    let dir = "", pid = 0, hpid = 0;
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    try {
      // The stand-in forks a helper (as Chrome forks GPU / renderer processes) and records its pid before its own.
      const log = join(box, "dir.txt"), pidf = join(box, "pid.txt"), hpidf = join(box, "helper.txt"), exe = join(box, "fake-chrome"), runner = join(box, "run.mjs");
      writeFileSync(exe, `#!/bin/sh\nfor a; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}"; mkdir -p "$d/Default"; printf %s "$d" > "${log}";; esac; done\n( sleep 20; mkdir -p "$d/Default"; echo late > "$d/Default/Late" ) </dev/null >/dev/null 2>&1 &\necho $! > "${hpidf}"\necho $$ > "${pidf}.tmp"; mv "${pidf}.tmp" "${pidf}"\nsleep 30\n`);
      chmodSync(exe, 0o755);
      const harness = pathToFileURL(fileURLToPath(new URL("../browser/run_shaders.mjs", import.meta.url))).href;
      writeFileSync(runner, `import { runShaders } from ${JSON.stringify(harness)};\nawait runShaders({ browser: ${JSON.stringify(exe)}, timeoutMs: 25000 });\n`);
      const node = spawn(process.execPath, [runner], { stdio: "ignore" });
      const gone = new Promise((ok) => node.once("exit", (code, signal) => ok({ code, signal })));
      for (let i = 0; i < 100 && !(existsSync(log) && existsSync(pidf)); i++) await new Promise((ok) => setTimeout(ok, 100));
      dir = readFileSync(log, "utf8"); pid = Number(readFileSync(pidf, "utf8"));
      assert.ok(dir.includes("ss-shaders-") && existsSync(dir), `the profile folder was made: ${dir}`);
      assert.ok(alive(pid), "the stand-in browser is running");
      node.kill(sig);
      const end = await gone;
      assert.equal(end.signal, sig, `the run still ends by ${sig} (${JSON.stringify(end)})`);
      hpid = Number(readFileSync(hpidf, "utf8"));
      for (let i = 0; i < 20 && (alive(pid) || alive(hpid)); i++) await new Promise((ok) => setTimeout(ok, 100));
      assert.equal(alive(pid), false, "the stand-in browser was stopped");
      // the helper too: killing only the main pid (child.kill) passed this test before (review)
      assert.equal(alive(hpid), false, "the stand-in's helper process was stopped with it (the whole process group)");
      assert.equal(existsSync(dir), false, `the profile folder is deleted: ${dir}`);
    } finally {
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      if (hpid) { try { process.kill(hpid, "SIGKILL"); } catch {} }
      rmSync(box, { recursive: true, force: true });
      if (dir.includes("ss-shaders-")) rmSync(dir, { recursive: true, force: true });
    }
  });
}
