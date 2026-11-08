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
      const hpid = Number(readFileSync(f.hpidf, "utf8"));
      for (let i = 0; i < 20 && (alive(pid) || alive(hpid)); i++) await sleep(100);
      assert.equal(alive(pid), false, "the stand-in browser was stopped");
      // the helper too: killing only the main pid (child.kill) passed this test before (review)
      assert.equal(alive(hpid), false, "the stand-in's helper process was stopped with it (the whole process group)");
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

// Every script anywhere in tools/ or tests/ that imports tools/qa/lib.mjs and starts a browser with launch() must
// await its close(). Review: the first version of this test listed 9 files in tools/qa/ only, and verify_tour,
// test_tryit, ss_kit, drive and make_scenes called `b.close(); process.exit()` and left their ssqa-* profile.
export function launchImporters(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "vendor", "people"].includes(n.name)) continue;
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (/\.m?js$/.test(n.name) && !/(^|\/)tools\/qa\/(lib|browser_proc)\.mjs$/.test(p) && !p.endsWith("qa_browser_cleanup.test.mjs")) {
        const s = readFileSync(p, "utf8");
        if (/["'](?:\.\/|(?:\.\.\/)+(?:qa\/)?|(?:\.\.\/)+tools\/qa\/)lib\.mjs["']/.test(s) && /\blaunch\(/.test(s)) out.push({ path: p.slice(root.length + 1), src: s });
      }
    }
  };
  for (const d of ["tools", "tests"]) walk(join(root, d));
  return out;
}

export function unawaitedCloses(src) {
  const vars = [...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+launch\(/g)].map((m) => m[1]);
  const bad = [];
  for (const v of new Set(vars)) {
    const re = new RegExp(`(await\\s+)?\\b${v}\\.close(?:\\?\\.)?\\(\\)`, "g");
    for (const m of src.matchAll(re)) if (!m[1]) bad.push(`${v}.close() at line ${src.slice(0, m.index).split("\n").length}`);
  }
  return bad;
}

test("every script that imports tools/qa/lib.mjs and calls launch() waits for close() (the profile is deleted before the process exits)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const files = launchImporters(root);
  // the scan finds the drivers outside tools/qa/ too (a scan that matched nothing would pass)
  for (const p of ["tools/tryit/verify_tour.mjs", "tools/tryit/test_tryit.mjs", "tools/interop/realscenes/ss_kit.mjs", "tools/v2s_bench/harness/drive.mjs", "tools/qa/visual_baseline.mjs"])
    assert.ok(files.some((f) => f.path === p), `the scan finds ${p} (found ${files.map((f) => f.path).join(", ")})`);
  const bad = files.flatMap((f) => unawaitedCloses(f.src).map((b) => `${f.path}: ${b}`));
  assert.deepEqual(bad, []);
});

// A stand-in Chrome that answers DevTools just enough for launch() to finish (GET /json/list and a WebSocket that
// replies {id, result: {}} to every command). Node, no packages; written as an executable script.
function fakeCdpChrome(box) {
  const log = join(box, "dir.txt"), exe = join(box, "fake-cdp-chrome");
  writeFileSync(exe, `#!${process.execPath}
const http = require("node:http"), crypto = require("node:crypto"), fs = require("node:fs");
let port = 0, dir = "";
for (const a of process.argv.slice(2)) { if (a.startsWith("--remote-debugging-port=")) port = +a.split("=")[1]; if (a.startsWith("--user-data-dir=")) dir = a.slice(16); }
fs.mkdirSync(dir + "/Default", { recursive: true }); fs.writeFileSync(dir + "/Default/Cookies", "x"); fs.writeFileSync(${JSON.stringify(log)}, dir);
const srv = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/1" }])); });
srv.on("upgrade", (q, s) => {
  const acc = crypto.createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  s.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + acc + "\\r\\n\\r\\n");
  let buf = Buffer.alloc(0);
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len)), op = buf[0] & 15;
      buf = buf.subarray(off + 4 + len);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      if (op !== 1) continue;
      const out = Buffer.from(JSON.stringify({ id: JSON.parse(body).id, result: {} }));
      s.write(Buffer.concat([Buffer.from(out.length < 126 ? [0x81, out.length] : [0x81, 126, out.length >> 8, out.length & 255]), out]));
    }
  });
  s.on("error", () => {});
});
srv.listen(port, "127.0.0.1");
`);
  chmodSync(exe, 0o755);
  return { exe, log };
}

test("launch(): close() without await followed by process.exit() still deletes the ssqa-* profile (the exit guard stays armed until it is gone)", { timeout: 30000 }, async () => {
  // Review of the close() rework: close() released the exit guard at once and deleted the profile only after an
  // await, so `b.close(); process.exit()` left the whole profile on every run.
  const box = mkdtempSync(join(tmpdir(), "ss-fakebrowser-"));
  const f = fakeCdpChrome(box);
  let dir = "";
  try {
    const port = 9300 + Math.floor(Math.random() * 500);
    const c = await runChild(box, `import { launch } from ${JSON.stringify(LIB)};
const b = await launch({ port: ${port}, chrome: ${JSON.stringify(f.exe)}, startMs: 10000 });
console.log("UP " + b.profile);
b.close();
process.exit(0);
`);
    const end = await c.exit;
    assert.match(c.out(), /UP .*ssqa-/, `launch() finished against the stand-in: ${c.out()} ${JSON.stringify(end)}`);
    dir = readFileSync(f.log, "utf8");
    assert.ok(dir.includes("ssqa-"), dir);
    assert.equal(existsSync(dir), false, `the profile folder is deleted although close() was not awaited: ${dir}`);
  } finally { if (dir.includes("ssqa-")) rmSync(dir, { recursive: true, force: true }); rmSync(box, { recursive: true, force: true }); }
});

test("the close() scan itself: an un-awaited close is caught, an awaited one (also close?.()) is not", () => {
  assert.deepEqual(unawaitedCloses("const b = await launch({});\ntry {} finally { b.close(); }\nprocess.exit(0);"), ["b.close() at line 2"]);
  assert.deepEqual(unawaitedCloses("const b = await launch({});\n} finally { await b.close(); }"), []);
  assert.deepEqual(unawaitedCloses("const b = await launch({});\n} finally { await b.close?.(); }"), []);
  assert.deepEqual(unawaitedCloses("const br = await launch({});\nbr.close?.();"), ["br.close() at line 2"]);
  assert.deepEqual(unawaitedCloses("const b = await launch({});\nsrv.close();\nws.close();"), []);
});

test("every test file that makes a temp folder with mkdtempSync also removes one (takecheck left one ss-tc-* per run)", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const bad = readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).filter((n) => {
    const s = readFileSync(join(dir, n), "utf8");
    return /mkdtempSync\(/.test(s) && !/rmSync\(/.test(s);
  });
  assert.deepEqual(bad, []);
});
