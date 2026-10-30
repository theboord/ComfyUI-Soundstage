// Soundstage touch-up wiring: the App's "Use touched-up still" switch and the canvas still that feeds it.
//
// tools/app_build/touchup.py adds SoundstageCanvasImage ("Touch-up · canvas still", reads a PNG from input/) and a
// lazy ComfySwitchNode titled "Use touched-up still" between the look still and motion. The Canvas tab
// (web/canvas/canvas.mjs) saves its composite to input/soundstage/ and calls setTouchupStill + setTouchupEnabled.

export const RUNG2_TITLE = /^Rung 2\b/;
export const SWITCH_TITLE = "Use touched-up still";
const STILL_TYPE = "SoundstageCanvasImage";

const allNodes = (app) => app?.graph?._nodes || app?.graph?.nodes || [];
const isType = (n, t) => n.comfyClass === t || n.type === t;

export function findTouchupNodes(app) {
  const nodes = allNodes(app);
  return {
    still: nodes.find((n) => isType(n, STILL_TYPE)) || null,
    toggle: nodes.find((n) => isType(n, "ComfySwitchNode") && n.title === SWITCH_TITLE) || null,
  };
}

function setWidget(node, name, value) {
  const w = node?.widgets?.find((x) => x.name === name);
  if (!w) return false;
  w.value = value;
  w.callback?.(w.value);
  return true;
}

export function isTouchupEnabled(app) {
  return Boolean(findTouchupNodes(app).toggle?.widgets?.find((w) => w.name === "switch")?.value);
}

export function setTouchupEnabled(app, on) {
  const ok = setWidget(findTouchupNodes(app).toggle, "switch", Boolean(on));
  app?.graph?.setDirtyCanvas?.(true, true);
  return ok;
}

/** Point the canvas-still node at an input/-relative PNG (e.g. "soundstage/look_still_ab12.png"). */
export function setTouchupStill(app, path) {
  const ok = setWidget(findTouchupNodes(app).still, "image", path);
  app?.graph?.setDirtyCanvas?.(true, true);
  return ok;
}

/** Call cb({filename, subfolder, type}) each time the "Rung 2 · …" output node finishes. Returns an unsubscribe. */
export function watchRung2(api, app, cb) {
  const handler = (e) => {
    const d = e.detail || {};
    const id = String(d.display_node ?? d.node ?? "").split(":").pop();
    const node = app.graph?.getNodeById?.(Number(id));
    const img = d.output?.images?.[0];
    if (node && RUNG2_TITLE.test(node.title || "") && img) cb(img, node);
  };
  api.addEventListener("executed", handler);
  return () => api.removeEventListener("executed", handler);
}

/** The most recent rung-2 image shown in this session, or null. */
export function lastRung2Image(app) {
  const node = allNodes(app).find((n) => RUNG2_TITLE.test(n.title || ""));
  return node?.images?.[0] || null;
}
