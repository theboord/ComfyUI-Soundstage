// Soundstage QA: the playback bench's web server (no npm packages).
//
// Serves this repo's web/ folder, so web/cut/demo.html and cut.mjs run exactly as committed, and reverse-proxies
// GET /view and GET /api/view to the pod (default http://127.0.0.1:8189, the SSH tunnel), streaming, with the
// Range header passed through. The media then reaches the page same-origin THROUGH THE TUNNEL, as in the app.
//
//   node tools/qa/playback_server.mjs --port 8790 --project <fixture.json>            # media through the tunnel
//   node tools/qa/playback_server.mjs --port 8790 --project <fixture.json> --local-media <dir>[,<dir>...]
//                                                    # /view is answered from those folders: decode cost without the network
// Other options:
//   --pod http://127.0.0.1:8189     where /view is proxied to (GET only; nothing else is ever forwarded)
//   --bench-media <dir>             served at /bench-media/ (the audio bed and other local bench files)
//   --log <file.jsonl>              one line per request: method, path, range, status, bytes, ms
//
// Safety: only GET and HEAD are answered. Any other method gets 405 here and is never forwarded. The only pod path
// this server ever requests is /view (with the page's query string).
import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join, normalize, extname, resolve, sep } from "node:path";
import { REPO } from "./lib.mjs";

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".glb": "model/gltf-binary", ".wasm": "application/wasm",
};

/** Parse a single-range "bytes=a-b" header against a file of `size` bytes: {start, end} (inclusive) or null for "whole file". */
export function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2])); }
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

function sendFile(req, res, file, log, extraHeaders = {}) {
  const st = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  const r = parseRange(req.headers.range, st.size);
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Last-Modified": st.mtime.toUTCString(),
    ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, ...extraHeaders };
  if (r?.unsatisfiable) { res.writeHead(416, { ...head, "Content-Range": `bytes */${st.size}` }); res.end(); log(416, 0); return; }
  const start = r ? r.start : 0, end = r ? r.end : st.size - 1;
  res.writeHead(r ? 206 : 200, { ...head, "Content-Length": end - start + 1, ...(r ? { "Content-Range": `bytes ${start}-${end}/${st.size}` } : {}) });
  if (req.method === "HEAD") { res.end(); log(r ? 206 : 200, 0); return; }
  let n = 0;
  const s = createReadStream(file, { start, end });
  s.on("data", (b) => { n += b.length; });
  s.on("end", () => log(r ? 206 : 200, n));
  s.on("error", () => { res.destroy(); log(500, n); });
  res.on("close", () => { if (!s.destroyed) { s.destroy(); log(r ? 206 : 200, n, "aborted"); } });
  s.pipe(res);
}

/** Start the server. Returns {server, port, close, stats}. */
export function startServer({ port = 8790, project = null, pod = "http://127.0.0.1:8189", localMedia = [], benchMedia = null, logFile = null, quiet = true } = {}) {
  const web = join(REPO, "web");
  localMedia = localMedia.map((d) => resolve(d));
  benchMedia = benchMedia ? resolve(benchMedia) : null;
  const podURL = new URL(pod);
  const stats = { requests: 0, viewBytes: 0, viewRequests: 0, viewAborted: 0, rejected: 0 };
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://x");
    const rec = { t: t0, m: req.method, p: url.pathname, q: url.search.slice(0, 200), range: req.headers.range || null };
    const log = (status, bytes, note) => {
      stats.requests++;
      if (/\/view$/.test(url.pathname)) { stats.viewRequests++; stats.viewBytes += bytes; if (note === "aborted") stats.viewAborted++; }
      const line = { ...rec, status, bytes, ms: Date.now() - t0, ...(note ? { note } : {}) };
      if (logFile) { try { appendFileSync(logFile, JSON.stringify(line) + "\n"); } catch { /* best effort */ } }
      if (!quiet) console.log(JSON.stringify(line));
    };
    if (req.method !== "GET" && req.method !== "HEAD") { stats.rejected++; res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); log(405, 0); return; }

    // The pod's /view (the app calls it as /api/view): from local folders, or proxied through the tunnel.
    if (url.pathname === "/view" || url.pathname === "/api/view") {
      if (localMedia.length) {
        const name = url.searchParams.get("filename") || "";
        const sub = url.searchParams.get("subfolder") || "";
        if (!name || /[\\/]/.test(name) || name.startsWith(".")) { res.writeHead(400); res.end(); log(400, 0); return; }
        const hit = localMedia.flatMap((d) => [join(d, sub, name), join(d, name)]).find((f) => existsSync(f));
        if (!hit) { res.writeHead(404); res.end(); log(404, 0); return; }
        sendFile(req, res, hit, log);
        return;
      }
      if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); log(405, 0); return; }   // only GET reaches the pod
      const headers = { Accept: req.headers.accept || "*/*" };
      if (req.headers.range) headers.Range = req.headers.range;
      if (req.headers["if-range"]) headers["If-Range"] = req.headers["if-range"];
      const up = http.request({ host: podURL.hostname, port: podURL.port || 80, method: "GET", path: "/view" + url.search, headers }, (pr) => {
        const keep = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition", "cache-control"];
        const h = {};
        for (const k of keep) if (pr.headers[k] != null) h[k] = pr.headers[k];
        res.writeHead(pr.statusCode || 502, h);
        let n = 0;
        pr.on("data", (b) => { n += b.length; });
        pr.on("end", () => log(pr.statusCode, n));
        res.on("close", () => { if (!pr.complete) { pr.destroy(); log(pr.statusCode, n, "aborted"); } });
        pr.pipe(res);
      });
      up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(); log(502, 0, String(e.message).slice(0, 80)); });
      up.end();
      return;
    }

    // Local bench files (the audio bed, control transcodes referenced by URL).
    if (benchMedia && url.pathname.startsWith("/bench-media/")) {
      const f = normalize(join(benchMedia, decodeURIComponent(url.pathname.slice("/bench-media/".length))));
      if (!f.startsWith(resolve(benchMedia) + sep) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); log(404, 0); return; }
      sendFile(req, res, f, log);
      return;
    }

    // The fixture replaces the demo project (demo.html fetches ./demo_project.json).
    if (project && url.pathname === "/cut/demo_project.json") {
      const body = readFileSync(project);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      log(200, body.length);
      return;
    }

    // Everything else: this repo's web/ folder.
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const f = normalize(join(web, rel));
    if (!f.startsWith(resolve(web) + sep) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); log(404, 0); return; }
    sendFile(req, res, f, log, { "Cache-Control": "no-store" });
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok({ server, port: server.address().port, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

function argv(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const localArg = argv("--local-media");
  const s = await startServer({
    port: Number(argv("--port", 8790)), project: argv("--project"), pod: argv("--pod", "http://127.0.0.1:8189"),
    localMedia: localArg ? localArg.split(",") : [], benchMedia: argv("--bench-media"), logFile: argv("--log"), quiet: !process.argv.includes("--verbose"),
  });
  console.log(`playback server on http://127.0.0.1:${s.port}/cut/demo.html  (${localArg ? "local media: " + localArg : "media through " + argv("--pod", "http://127.0.0.1:8189")})`);
}
