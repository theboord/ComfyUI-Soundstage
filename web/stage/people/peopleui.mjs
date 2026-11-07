// Lifelike people (people overhaul M1): the two look controls in the Appearance row, next to the person's build, hair
// and wardrobe. Face = shown / faceless (a plain mannequin head), saved on the person; Blocking look = every person as
// the clay figure (the whole scene, saved with it). mkSelect is the App's own select builder (web/soundstage.js).
export function peopleLookControls(stage, mkSelect) {
  const face = mkSelect("Face", { shown: { label: "shown" }, faceless: { label: "faceless" } }, "shown", (v) => stage.setFace(v));
  const FACE_TIP = "Lifelike people: show the face, or a faceless mannequin head. The clay figure has no face either way.";
  face.wrap.title = FACE_TIP;
  const blocking = document.createElement("label");
  const chk = Object.assign(document.createElement("input"), { type: "checkbox" });
  chk.style.cssText = "margin:0 4px 0 0;vertical-align:middle";
  chk.addEventListener("pointerdown", (e) => e.stopPropagation());
  chk.addEventListener("change", () => stage.setBlockingLook(chk.checked));
  blocking.append(chk, "Blocking look");
  blocking.title = "Show every person as the clay figure (the walk, keys and passes run the same either way)";
  const sync = (info) => {
    if (!info) return;
    face.sel.value = info.face === "faceless" ? "faceless" : "shown";
    chk.checked = stage.toJSON().people_look === "blocking";
    const st = stage.avatarStatus?.(info.id);
    face.wrap.title = st?.installed && !st.shown && st.reason ? `${FACE_TIP} Shown as clay now: ${st.reason}.` : FACE_TIP;
  };
  return { face, blocking, sync };
}
