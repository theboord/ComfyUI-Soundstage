// Clay frames for the Director's Book storyboard strip (Milestone 23). Any scene's stage (also the ones waiting off
// the live stage) is loaded into a hidden scratch Stage (its own small WebGL canvas, the same trick as the Presets'
// previews in web/presets/livethumbs.mjs), and each shot is rendered in clay at its first frame. The user's stage, its
// history and its undo are never touched. Frames are cached by scene + shot signature as JPEG data URLs.
//
//   const clay = new ClayFrames({ stage });          // stage: the user's Stage (only its constructor is used)
//   const url = await clay.frame(sceneJSON, shotId)    // "data:image/jpeg;base64,..." or null

const W = 384, H = 216;

function sig(scene, shotId) {
  const s = JSON.stringify([shotId, scene?.environment, scene?.lighting, scene?.actors, scene?.props, (scene?.shots || []).find((x) => x.id === shotId)]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

export class ClayFrames {
  constructor({ stage, doc = typeof document !== "undefined" ? document : null, makeStage = null } = {}) {
    this.stage = stage; this.doc = doc;
    this.makeStage = makeStage || ((el) => new stage.constructor(el, () => {}));
    this.cache = new Map();
    this.scratch = null;
    this._mx = Promise.resolve();
    this.loaded = null;
  }

  _ensure() {
    if (this.scratch) return this.scratch;
    const box = this.doc.createElement("div");
    box.className = "ss-bk-scratch";
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;overflow:hidden;pointer-events:none;visibility:hidden;contain:strict`;
    this.doc.body.append(box);
    const P = this.stage?.constructor?.prototype, own = P && Object.prototype.hasOwnProperty.call(P, "render") ? P.render : null;
    if (own) P.render = function () {};
    try { this.scratch = this.makeStage(box); } finally { if (own) P.render = own; }
    try { this.scratch._ro?.disconnect(); } catch { /* */ }
    try { const sh = this.scratch.sun?.shadow; if (sh) { sh.mapSize.set(1024, 1024); sh.map?.dispose?.(); sh.map = null; } } catch { /* */ }
    return this.scratch;
  }

  cached(scene, shotId) { return this.cache.get(sig(scene, shotId)) || null; }

  /** The clay frame of one shot of a scene (serialised: one render at a time). */
  frame(scene, shotId, frame = 0) {
    const key = sig(scene, shotId);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    const run = this._mx.then(() => this._render(scene, shotId, frame, key));
    this._mx = run.catch(() => null);
    return run;
  }

  async _render(scene, shotId, frame, key) {
    if (this.cache.has(key)) return this.cache.get(key);
    let url = null;
    try {
      const S = this._ensure();
      const sceneKey = JSON.stringify({ ...scene, active_shot: undefined });
      if (this.loaded !== sceneKey) {
        S._muteRecord = true;
        try { S.load(JSON.parse(JSON.stringify(scene))); } finally { S._muteRecord = false; }
        this.loaded = sceneKey;
        S.view = "clay";
      }
      S.state.active_shot = shotId;
      S._rigCache = null;
      const ar = (S.fw || 16) / (S.fh || 9);
      let rw = W, rh = Math.round(W / ar);
      if (rh < H) { rh = H; rw = Math.round(H * ar); }
      S.renderer.setSize(rw, rh, false);
      S.setFrameSilent(frame);
      S._renderMode("clay", true);
      const c = this.doc.createElement("canvas");
      c.width = W; c.height = H;
      c.getContext("2d").drawImage(S.canvas, Math.max(0, (rw - W) / 2), Math.max(0, (rh - H) / 2), Math.min(W, rw), Math.min(H, rh), 0, 0, W, H);
      url = c.toDataURL("image/jpeg", 0.82);
      await new Promise((r) => setTimeout(r, 0));
    } catch (e) { console.warn("[Soundstage] book clay frame", e); url = null; }
    this.cache.set(key, url);
    if (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value);
    return url;
  }

  dispose() {
    try { this.scratch?.dispose?.(); } catch { /* */ }
    this.scratch?.canvas?.parentElement?.remove?.();
    this.scratch = null;
  }
}
