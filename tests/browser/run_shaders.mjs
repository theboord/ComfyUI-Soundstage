// node tests/browser/run_shaders.mjs [--browser /path/to/chrome]
// Serves the repo on a free localhost port, opens tests/browser/shaders.html in a headless Chromium and prints the
// JSON result (the Depth pass shader and the selection outline compiled and rendered in real WebGL, with pixel checks).
// Installs nothing: it uses a browser already on this machine (SOUNDSTAGE_BROWSER, --browser, a Playwright cache's
// chrome-headless-shell / Chromium, or Google Chrome / Chromium in their usual places). Exit 0 and prints the result;
// exit 2 with {"skipped": "..."} when no browser is found.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function findBrowser(explicit = null) {
  const c = [];
  if (explicit) c.push(explicit);
  if (process.env.SOUNDSTAGE_BROWSER) c.push(process.env.SOUNDSTAGE_BROWSER);
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")].filter(Boolean);
  for (const base of caches) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort().reverse()) {
      if (d.startsWith("chromium_headless_shell-")) for (const sub of ["chrome-mac", "chrome-mac-arm64", "chrome-mac-x64", "chrome-linux", "chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) c.push(join(base, d, sub, "chrome-headless-shell"));
      if (d.startsWith("chromium-")) {
        for (const sub of ["chrome-mac", "chrome-mac-arm64", "chrome-mac-x64"]) c.push(join(base, d, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), join(base, d, sub, "Chromium.app/Contents/MacOS/Chromium"));
        c.push(join(base, d, "chrome-linux", "chrome"));
      }
    }
  }
  c.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  return c.find((p) => p && existsSync(p)) || null;
}

const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };

function serve() {
  const srv = createServer(async (req, res) => {
    try {
      const p = resolve(ROOT, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!(p === ROOT || p.startsWith(ROOT + sep)) || !(await stat(p)).isFile()) throw new Error("no");
      res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
      res.end(await readFile(p));
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

export async function runShaders({ browser = null, timeoutMs = 60000 } = {}) {
  const exe = findBrowser(browser);
  if (!exe) return { skipped: "no headless Chromium or Chrome found on this machine (nothing is installed by this check)" };
  const srv = await serve();
  // A fresh profile folder per run, deleted when the browser is done (one ss-shaders-<pid> was left behind per run).
  const profile = mkdtempSync(join(tmpdir(), "ss-shaders-"));
  const url = `http://127.0.0.1:${srv.address().port}/tests/browser/shaders.html`;
  const args = ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-gpu-sandbox", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", `--user-data-dir=${profile}`,
    "--virtual-time-budget=20000", "--dump-dom", url];
  try {
    const dom = await new Promise((ok, fail) => {
      const p = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
      let o = "", e = "";
      const t = setTimeout(() => { p.kill("SIGKILL"); fail(new Error(`browser timed out: ${e.slice(-500)}`)); }, timeoutMs);
      p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
      p.on("close", () => { clearTimeout(t); ok({ o, e }); });
      p.on("error", (err) => { clearTimeout(t); fail(err); });
    });
    const m = dom.o.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    const text = m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
    if (!text || text === "pending") return { browser: exe, error: `no result from the page (stderr tail: ${dom.e.slice(-800)})` };
    return { browser: exe, ...JSON.parse(text) };
  } finally {
    srv.close();
    // after a timeout the killed browser can still be closing files: retry for a moment
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--browser");
  const r = await runShaders({ browser: i > 0 ? process.argv[i + 1] : null });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.skipped ? 2 : r.ok ? 0 : 1);
}
