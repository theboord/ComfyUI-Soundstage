// Lifelike people (people overhaul M1): the look controls.
//   Face (per person, saved on the actor): in the selected person's Appearance row, next to build, hair and wardrobe.
//     Shown, or faceless: a plain mannequin face (no painted brows, eyes or lips, no lashes), the hair kept.
//   Blocking (the whole scene, saved with it as state.people_look): a toggle beside the view modes (Wire / Clay /
//     Color / Depth), because it changes how the whole stage looks, not one person.
// mkSelect is the App's own select builder (web/soundstage.js).
export const FACE_TIP = "Lifelike people: show the face, or faceless (a plain mannequin face with no brows, eyes, lips or lashes; the hair stays). The clay figure has no face either way.";
export const SWIM_TIP = "Swim: what this person does in a pool, a tank or the sea. Tread water (head up), swim a stroke, float on the back, dive with scuba (neutral, hovers), or Can't swim: they struggle at the surface for a few seconds, then sink slowly and settle on the bottom (Sink slowly: unconscious, no struggle). Auto swims as keyed. Ask can set it too (stage.setSwim).";
export const BLOCKING_TIP = "Blocking look: show every person as the clay figure (the walk, keys and passes run the same either way). Saved with the scene.";

/** The Face tooltip for a person right now: why they show as clay, if they do (avatarStatus is recomputed by every
 *  setFrame, so this is read fresh each time, never kept). */
export function faceTip(stage, id) {
  const st = id ? stage.avatarStatus?.(id) : null;
  return st?.installed && !st.shown && st.reason ? `${FACE_TIP} Shown as clay now: ${st.reason}.` : FACE_TIP;
}

export function peopleLookControls(stage, mkSelect) {
  const face = mkSelect("Face", { shown: { label: "shown" }, faceless: { label: "faceless" } }, "shown", (v) => stage.setFace(v));
  face.wrap.title = FACE_TIP;
  let id = null;
  const refreshTip = () => { face.wrap.title = faceTip(stage, id); };
  // The reason can change without the selection changing (a key added, Drive, a jump, the blocking toggle): re-read
  // it whenever the pointer or focus comes to the control, as well as on every sync.
  face.wrap.addEventListener("pointerenter", refreshTip);
  face.wrap.addEventListener("focusin", refreshTip);
  const sync = (info) => {
    if (!info) return;
    id = info.id;
    face.sel.value = info.face === "faceless" ? "faceless" : "shown";
    refreshTip();
  };
  return { face, sync, refreshTip };
}

/** Swim control for the selected person (stage.setSwim; the modes are buoyancy.mjs SWIM_MODES). */
export function swimControl(stage, mkSelect, modes) {
  const sel = mkSelect("Swim", Object.fromEntries(modes.map(([v, label]) => [v, { label }])), "auto", (v) => stage.setSwim?.(null, v));
  sel.wrap.title = SWIM_TIP;
  const sync = (info) => { if (info) sel.sel.value = info.swim || "auto"; };
  return { swim: sel, sync };
}

/** The scene-level Blocking toggle, styled like the view-mode buttons (a .ss-views group of one pressed button). */
export function blockingToggle(stage) {
  const el = document.createElement("div");
  el.className = "ss-views ss-blockview";
  el.style.marginLeft = "4px";
  const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Blocking", title: BLOCKING_TIP });
  b.setAttribute("aria-label", "Blocking look");
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", () => { stage.setBlockingLook(stage.state?.people_look !== "blocking"); sync(); });
  el.append(b);
  const sync = () => b.setAttribute("aria-pressed", String(stage.state?.people_look === "blocking"));
  sync();
  return { el, button: b, sync };
}
