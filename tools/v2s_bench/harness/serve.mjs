// v2s_bench harness server: serves the repo (so the page imports the real web/stage/stage.mjs), the bench data under
// /data/, answers /view from local takes first and otherwise proxies GETs to ComfyUI (SS_URL), and saves what the page
// POSTs to /save?p=<path under the data dir>. No npm packages. GET-only towards ComfyUI: it never queues anything.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, normalize, dirname, extname, resolve } from "node:path";

const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
  ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain" };

function safeJoin(base, rel) {
  const p = normalize(join(base, decodeURIComponent(rel)));
  if (!p.startsWith(resolve(base))) throw new Error("path escapes its root");
  return p;
}

/** Start the server. root = repo root, data = bench data dir, takes = dir holding mocap takes (soundstage/mocap/...). */
export function serve({ root, data, takes = null, port = 8795, upstream = process.env.SS_URL || "http://127.0.0.1:8189" }) {
  const srv = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (req.method === "POST" && u.pathname === "/save") {
        const dst = safeJoin(data, u.searchParams.get("p") || "");
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await mkdir(dirname(dst), { recursive: true });
        await writeFile(dst, Buffer.concat(chunks));
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (u.pathname === "/view") {
        const sub = u.searchParams.get("subfolder") || "", fn = u.searchParams.get("filename") || "";
        if (takes) {
          try {
            const local = safeJoin(takes, join(sub, fn));
            await stat(local);
            res.writeHead(200, { "Content-Type": TYPES[extname(local)] || "application/octet-stream" }).end(await readFile(local));
            return;
          } catch { /* not local: ask ComfyUI */ }
        }
        const r = await fetch(upstream + req.url);
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/octet-stream" });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const base = u.pathname.startsWith("/data/") ? data : root;
      const rel = u.pathname.startsWith("/data/") ? u.pathname.slice(6) : u.pathname;
      const file = safeJoin(base, rel);
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end(String(e?.message || e));
    }
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}
