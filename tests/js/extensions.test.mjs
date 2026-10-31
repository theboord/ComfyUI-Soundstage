// node --test tests/js/extensions.test.mjs
// ComfyUI imports EVERY .js file under web/ as a frontend extension (WEB_DIRECTORY = ./web), demo helpers included.
// A helper meant for the static demo must not change the real page: the demo's .glb fetch shim once did, and every
// .glb request in ComfyUI went to a missing .b64.txt (the rigged horse and the car bodies never loaded).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "vendor" ? [] : walk(p)) : [p]; });

test("no auto-loaded .js file under web/ patches window.fetch", () => {
  const offenders = walk(WEB).filter((p) => p.endsWith(".js")).filter((p) => /window\.fetch\s*=(?!=)/.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders.map((p) => relative(WEB, p)), []);
});

test("the demo still loads its .glb shim (as .mjs, which ComfyUI does not auto-load)", () => {
  assert.match(readFileSync(join(WEB, "demo", "demo.mjs"), "utf8"), /import "\.\/scripts\/glbshim\.mjs"/);
});
