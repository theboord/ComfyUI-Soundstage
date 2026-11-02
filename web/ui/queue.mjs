// Light queue watching and the stage-by-reference client (soundstage/queuewatch.py, soundstage/stagestore.py).
//
// The App never fetches GET /queue or GET /history: those serialise every queued and finished prompt in full, and
// with a few big scenes queued they froze the pod (2026-11-01). Watch the queue with queueSummary(); follow your own
// prompt with websocket events, and with GET /history/{prompt_id} as the fallback for a missed event.
//
//   queueSummary(api, {ids, clientId, limit})  -> {running, pending, items:[{prompt_id, state, position, ...}]} | null
//   idsIn(summary, state?)                      -> Set of prompt ids ("running", "pending" or both)
//   storeStage(api, text)                       -> the reference string for a big stage value, or null (keep inline)
//   resolveStageValue(api, value)               -> the stage value with a reference loaded back, or the value as is

export const SUMMARY_PATH = "/soundstage/queue_summary";
export const STORE_PATH = "/soundstage/stage_store";
export const INLINE_MAX = 16 * 1024;   // mirrors stagestore.INLINE_MAX: smaller stage values stay inline

/** The queue summary (counts plus ids, never payloads), or null when the server can't say (away, older pack). */
export async function queueSummary(api, { ids = null, clientId = null, limit = null } = {}) {
  const q = new URLSearchParams();
  if (ids?.length) q.set("ids", [...ids].join(","));
  if (clientId) q.set("client_id", clientId);
  if (limit) q.set("limit", String(limit));
  try {
    const r = await api.fetchApi(q.toString() ? `${SUMMARY_PATH}?${q}` : SUMMARY_PATH);
    if (!r || (r.status && r.status !== 200)) return null;
    const j = await r.json();
    return j && Number.isFinite(j.running) && Number.isFinite(j.pending) && Array.isArray(j.items) ? j : null;
  } catch { return null; }
}

/** Prompt ids in a summary: every item, or only the running / pending ones. */
export function idsIn(summary, state = null) {
  return new Set((summary?.items || []).filter((it) => !state || it.state === state).map((it) => it.prompt_id));
}

/** A reference string ('{"stage_ref":…}') looked at without parsing a big inline stage. */
export function stageRefOf(value) {
  if (typeof value !== "string" || value.length > 4096 || !value.includes('"stage_ref"')) return null;
  try {
    const d = JSON.parse(value);
    return d && typeof d.stage_ref === "string" && /^[0-9a-f]{64}$/.test(d.stage_ref) && !("scene" in d) ? d : null;
  } catch { return null; }
}

// One upload per distinct stage value per page (the server dedupes too). Keyed by the value itself.
const stored = new Map();

/** Store a big stage value on the server; returns the reference string to queue instead, or null to send it inline
 *  (small value, older server, a QA guard, the tunnel blinked). */
export async function storeStage(api, text) {
  if (typeof text !== "string" || text.length <= INLINE_MAX) return null;
  if (stored.has(text)) return stored.get(text);
  try {
    const r = await api.fetchApi(STORE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    if (!r || (r.status && r.status !== 200)) return null;
    const j = await r.json();
    if (!j || !stageRefOf(j.value)) return null;
    stored.set(text, j.value);
    if (stored.size > 4) stored.delete(stored.keys().next().value);
    return j.value;
  } catch { return null; }
}

/** A stage value as the widget can load it: a reference is fetched back from the server's store. Throws when the
 *  server doesn't have it (a workflow from another machine). */
export async function resolveStageValue(api, value) {
  const ref = stageRefOf(value);
  if (!ref) return value;
  const r = await api.fetchApi(`${STORE_PATH}/${ref.stage_ref}`);
  if (!r || (r.status && r.status !== 200)) throw new Error(`this server doesn't have stage ${ref.stage_ref.slice(0, 12)}`);
  const text = await r.text();
  if (ref.look_start === false || ref.frame_lock === false) {
    const d = JSON.parse(text);
    for (const k of ["look_start", "frame_lock"]) if (k in ref) d[k] = ref[k];
    return JSON.stringify(d);
  }
  return text;
}

/** Test hook: forget the uploads this page made. */
export function _resetStored() { stored.clear(); }
