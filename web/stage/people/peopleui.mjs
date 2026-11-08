// Lifelike people (people overhaul M1): the look controls.
//   Face (per person, saved on the actor): in the selected person's Appearance row, next to build, hair and wardrobe.
//     Shown, or faceless: a plain mannequin face (no painted brows, eyes or lips, no lashes), the hair kept.
//   Device tier (this browser): beside the view modes (Wire / Color / Depth), because it changes the whole stage.
// mkSelect is the App's own select builder (web/soundstage.js).
export const FACE_TIP = "Lifelike people: show the face, or faceless (a plain mannequin face with no brows, eyes, lips or lashes; the hair stays).";
export const SWIM_TIP = "Swim: what this person does in a pool, a tank or the sea. Tread water (head up), swim a stroke, float on the back, dive with scuba (neutral, hovers), or Can't swim: they struggle at the surface for a few seconds, then sink slowly and settle on the bottom (Sink slowly: unconscious, no struggle). Auto swims as keyed. Ask can set it too (stage.setSwim).";
export const TIER_TIP = "Device tier: how much the stage asks of this machine. Auto picks one from the GPU (Phone, Low, Standard); Low shows up to 6 lifelike people per shot and Phone 2, the rest as marked stand-ins. Saved for this browser only.";

/** The Face tooltip for a person right now: a stand-in says why (avatarStatus is recomputed by every setFrame, so
 *  this is read fresh each time, never kept). People are never shown as clay (Lifelike-only plan). */
export function faceTip(stage, id) {
  const st = id ? stage.avatarStatus?.(id) : null;
  if (st?.shownAs === "standin") return `${FACE_TIP} Shown as a stand-in now: ${st.loading ? "the lifelike body is still loading" : "lifelike people are not installed (or not made yet for this kind)"}.`;
  return FACE_TIP;
}

export function peopleLookControls(stage, mkSelect) {
  const face = mkSelect("Face", { shown: { label: "shown" }, faceless: { label: "faceless" } }, "shown", (v) => stage.setFace(v));
  face.wrap.title = FACE_TIP;
  let id = null;
  const refreshTip = () => { face.wrap.title = faceTip(stage, id); };
  // The reason can change without the selection changing (a key added, Drive, a jump, the tier): re-read
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

/** The scene-level control group beside the view modes (a .ss-views group): the device tier picker (tierPicker).
 *  It held the Blocking toggle until Lifelike-only L2 retired it with the clay look (a saved people_look is dropped on
 *  load, scenemigrate.mjs). */
export function sceneViewControls(stage) {
  const el = document.createElement("div");
  el.className = "ss-views ss-tierview";
  el.style.marginLeft = "4px";
  const tier = tierPicker(stage);
  if (tier) el.append(tier.el);
  const sync = () => { tier?.sync(); };
  sync();
  return { el, sync, tier };
}

/** The device tier picker (web/stage/tier.mjs): Auto (the probe's pick, named) or a tier; saved per browser. */
export function tierPicker(stage) {
  if (typeof document === "undefined" || typeof stage?.setTier !== "function") return null;
  const sel = document.createElement("select");
  sel.title = TIER_TIP;
  sel.setAttribute("aria-label", "Device tier");
  sel.style.marginLeft = "4px";
  const opts = [["auto", "Auto"], ["TP", "Phone"], ["T0", "Low"], ["T1", "Standard"], ["Hero", "Hero"]];
  for (const [v, label] of opts) sel.append(Object.assign(document.createElement("option"), { value: v, textContent: label }));
  sel.addEventListener("pointerdown", (e) => e.stopPropagation());
  sel.addEventListener("change", () => { stage.setTier(sel.value); sync(); });
  const sync = () => {
    sel.value = stage.tierPick || "auto";
    const auto = sel.querySelector('option[value="auto"]');
    if (auto) auto.textContent = `Auto (${({ TP: "Phone", T0: "Low", T1: "Standard", Hero: "Hero" })[stage.tierProbe?.tier] || "Standard"})`;
  };
  sync();
  return { el: sel, sync };
}
