// One fetch per static JSON file per page (Jon's canvas-speed report, 2026-11-08: lighting_setups.json was fetched
// three times and style_presets.json twice on every App load). fetchJSON(url) shares one request between callers and
// hands each a fresh copy (callers may change what they get). A failed fetch is not remembered, so a later call retries.
// Node (tests, file: URLs) reads the file directly.
const cache = new Map();
export const stats = { fetches: 0 };

const copy = (v) => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** The parsed JSON at url (a URL or string), fetched once per page; rejects on a network error or a non-OK answer. */
export function fetchJSON(url, init = { cache: "no-cache" }) {
  const key = String(url);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (key.startsWith("file:")) {
        const fs = await import("node:fs");
        return JSON.parse(fs.readFileSync(new URL(key), "utf8"));
      }
      stats.fetches++;
      const r = await fetch(key, init);
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
      return r.json();
    })();
    cache.set(key, p);
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  }
  return p.then(copy);
}

/** Forget what was fetched (tests). */
export function clearJSONCache() { cache.clear(); stats.fetches = 0; }
