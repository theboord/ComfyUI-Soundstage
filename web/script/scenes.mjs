// Host-side scene bookkeeping for an imported script (no DOM; tests/js/scenes.test.mjs).
// The App has ONE live 3D stage. With a script, each script scene keeps its own stage: the scene on the stage is live,
// every other scene waits as a stage snapshot ({scene_id: stageJSON}). Switching scenes saves the live stage under its
// scene and loads the target's snapshot (or a fresh stage built from the scene's heading). Shots carry scene_id, and
// shots the scene agent makes (shot_1, shot_2, ...) get scene-scoped ids (sc_2__shot_1), so renders, chosen frames and
// cut clips, which are all keyed by shot id, never leak from one scene to another.
import { compactScript, hydrateScript } from "./parse.mjs";

/** Snapshot key of a stage that belongs to no scene (the stage you had before importing a script). */
export const NO_SCENE = "_none";
/** Over this many bytes the script text (elements) stays out of node.properties. */
export const SCRIPT_PROP_LIMIT = 250000;

const AGENT_ID = /^shot_\d+$/;

/**
 * Give a stage's shots to scene `sid`: tag scene_id, and give ids that are not unique across scenes (the agent's
 * shot_N, the default shot_1) a scene-scoped id `${sid}__${id}`. taken(id) says an id is already used somewhere
 * (renders, another scene, a previous build of this scene); then a time suffix keeps it unique.
 * Mutates st (a stage JSON or stage.state). Returns {oldId: newId} for the renamed shots.
 */
export function scopeShots(st, sid, { taken = () => false, all = false } = {}) {
  const map = {};
  if (!st || !sid || sid === NO_SCENE) return map;
  const used = new Set((st.shots || []).map((s) => s.id));
  for (const sh of st.shots || []) {
    if (!sh.scene_id) sh.scene_id = sid;
    const scoped = String(sh.id).startsWith(`${sid}__`);
    if (scoped || !(all || AGENT_ID.test(sh.id))) continue;
    let id = `${sid}__${sh.id}`;
    if (taken(id) || used.has(id)) {
      let n = 0;
      do id = `${sid}__${sh.id}_${(Date.now() + n++).toString(36)}`; while (taken(id) || used.has(id));
    }
    used.add(id);
    map[sh.id] = id;
    sh.id = id;
  }
  if (map[st.active_shot]) st.active_shot = map[st.active_shot];
  return map;
}

/** A stage JSON without the parts that change by looking (active shot): two equal signatures = nothing was edited. */
export function stageSig(st) {
  if (!st) return "";
  const { active_shot, ...rest } = st;
  return JSON.stringify(rest);
}

/**
 * Every script shot: the snapshots plus the live stage. [{id, name, scene_id, live}], scene_id null for a shot in no
 * scene. liveKey is the snapshot key of the live stage; liveShots are its shots ([] to leave them out, e.g. a fresh,
 * untouched scene stage that has no real shots yet).
 */
export function listShots(snaps, liveKey, liveShots) {
  const out = [];
  const sceneOf = (sh, k) => sh.scene_id || (k && k !== NO_SCENE ? k : null);
  for (const [k, st] of Object.entries(snaps || {})) {
    if (k === liveKey) continue;
    for (const sh of st?.shots || []) out.push({ id: sh.id, name: sh.name || sh.id, scene_id: sceneOf(sh, k), live: false });
  }
  for (const sh of liveShots || []) out.push({ id: sh.id, name: sh.name || sh.id, scene_id: sceneOf(sh, liveKey), live: true });
  return out;
}

/** Which snapshot key holds this shot id (liveKey when it is on the live stage), or null. */
export function keyOfShot(snaps, liveKey, liveShots, id) {
  if ((liveShots || []).some((s) => s.id === id)) return liveKey;
  for (const [k, st] of Object.entries(snaps || {})) if ((st?.shots || []).some((s) => s.id === id)) return k;
  return null;
}

/**
 * The Script as it is saved on the node: compactScript() (re-derivable parts dropped). When that is still over `limit`
 * bytes the scene text is left out too (headings, numbers, synopsis and notes stay) and the caller keeps the full text
 * elsewhere (ComfyUI userdata): node.properties ride along in every saved PNG/MP4's workflow metadata.
 * Returns {script, trimmed, bytes}.
 */
export function packScript(script, limit = SCRIPT_PROP_LIMIT) {
  if (!script) return { script: null, trimmed: false, bytes: 0 };
  const c = compactScript(script);
  const s = JSON.stringify(c);
  if (s.length <= limit) return { script: c, trimmed: false, bytes: s.length };
  const t = { ...c, trimmed: 1, scenes: c.scenes.map(({ elements, ...rest }) => rest) };
  return { script: t, trimmed: true, bytes: JSON.stringify(t).length };
}

/** Saved form -> a full Script. full: the untrimmed compact copy from userdata, when the saved one was trimmed. */
export function unpackScript(saved, full = null) {
  if (!saved || !Array.isArray(saved.scenes)) return null;
  if (!saved.trimmed) return hydrateScript(saved);
  if (full && Array.isArray(full.scenes)) {
    // The node's copy is the newer one for everything the director edits (notes, extra scene keys).
    const mine = new Map(saved.scenes.map((s) => [s.id, s]));
    const merged = { ...full, ...Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "scenes" && k !== "trimmed")),
      scenes: full.scenes.map((s) => ({ ...s, ...(mine.get(s.id) || {}), elements: s.elements })) };
    delete merged.trimmed;
    return hydrateScript(merged);
  }
  // No full text to be had: headings and notes only (no breakdown, no pages).
  const { trimmed, compact, ...rest } = saved;
  return { ...rest, scenes: saved.scenes.map((s) => ({ ...s, elements: [] })), characters: [] };
}

/** "SC12A" for the NLE scene field, "Sc 12A" for clip names; null when the shot is in no scene of the script. */
export function sceneNumberOf(script, sceneId) {
  const sc = sceneId && script?.scenes?.find((x) => x.id === sceneId);
  return sc ? String(sc.number) : null;
}

/**
 * A different script replaced this one: its sc_3 is not our sc_3. Re-key every snapshot (and the live key) under
 * `${tag}:` and re-tag their shots, so old shots show as "not in this script" instead of joining the new scenes.
 * Mutates snaps / cuts / liveState. Returns the new live key.
 */
export function retireScenes({ snaps, cuts, liveKey, liveState, tag }) {
  const re = (k) => (k && k !== NO_SCENE && !k.includes(":") ? `${tag}:${k}` : k);
  const retag = (st) => { for (const sh of st?.shots || []) if (sh.scene_id && !sh.scene_id.includes(":")) sh.scene_id = `${tag}:${sh.scene_id}`; };
  for (const bag of [snaps, cuts]) {
    for (const k of Object.keys(bag || {})) {
      const nk = re(k);
      if (nk !== k) { bag[nk] = bag[k]; delete bag[k]; }
    }
  }
  for (const st of Object.values(snaps || {})) retag(st);
  retag(liveState);
  return re(liveKey);
}
