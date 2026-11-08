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
