// Cut-out cards in the passes that replace materials (review M1, defect 1). The lifelike people's hair and lashes are
// cards: quads whose shape is the alpha of the colour PNG (alphaTest). The Depth, Clay and Wire passes draw the scene
// with ONE override material (scene.overrideMaterial) and the ID pass gives every mesh one flat material; neither has
// the card's map or alpha test, so every card drew as a solid quad (a helmet of rectangles around the head).
//
// Fix: for the duration of one render, every card material of a shown lifelike person is swapped for a version of the
// pass material that keeps the card's map ALPHA (not its colour) and alphaTest, marked allowOverride = false so three's
// renderer (WebGLRenderer renderObjects: `c.allowOverride === true && override !== null`) draws it instead of the
// override. The body and head groups keep taking the override as before. Restored right after the render.
import * as THREE from "../../vendor/three.module.min.mjs";
import { depthCutout } from "../depthshader.mjs";

/** A material that is a cut-out card: shown, with a colour map, and an alpha test. */
export const isCutout = (m) => !!(m && m.visible !== false && m.alphaTest > 0 && m.map);

/** Take only the alpha of the colour map (the card's shape); the colour stays the material's own (clay grey, ID hue). */
export function alphaOnlyMap(m) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>",
      "#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif");
  };
  m.customProgramCacheKey = () => "ss-alpha-only-map";
  return m;
}

const cache = new WeakMap();   // card material -> Map(pass material -> its cut-out version)

/**
 * The cut-out version of pass material ov for card src (cached per pair): a Depth pass material (userData.depthPass)
 * gets the CUTOUT Depth shader with the same near / far uniforms; a lit or basic material (clay, wire) is cloned with
 * the card's map (alpha only), alphaTest and side. null for an override this doesn't know (left to the override).
 */
export function passCutout(src, ov) {
  let per = cache.get(src);
  if (!per) cache.set(src, (per = new Map()));
  if (per.has(ov)) return per.get(ov);
  let m = null;
  if (ov.userData?.depthPass && ov.uniforms?.uNear) m = depthCutout(ov, src);
  else if (!ov.isShaderMaterial && (ov.isMeshStandardMaterial || ov.isMeshBasicMaterial || ov.isMeshLambertMaterial || ov.isMeshPhongMaterial)) {
    m = alphaOnlyMap(ov.clone());
    m.map = src.map;
    m.alphaTest = src.alphaTest;
    m.side = src.side;
    m.transparent = false;
  }
  if (m) { m.allowOverride = false; m.name = `${src.name || "card"}~${ov.name || ov.type}`; }
  per.set(ov, m);
  return m;
}

/** The materials of one mesh for a pass with override ov: cards swapped for their cut-out versions. null = no card. */
export function cutoutMaterials(mats, ov) {
  const list = Array.isArray(mats) ? mats : [mats];
  if (!list.some(isCutout)) return null;
  const out = list.map((m) => (isCutout(m) ? passCutout(m, ov) || m : m));
  return Array.isArray(mats) ? out : out[0];
}

/**
 * Before a render with scene.overrideMaterial = ov: every shown lifelike person's card groups take the cut-out pass
 * material. Returns the function that puts the materials back (call it right after the render).
 */
export function swapAvatarCutouts(stage, ov) {
  const back = [];
  if (!ov) return () => {};
  for (const g of stage.actorMeshes?.values() || []) {
    const skin = g?.userData?.humanSkin;
    if (!skin?.shown) continue;
    skin.holder.traverse((o) => {
      if (!o.isMesh) return;
      const m = cutoutMaterials(o.material, ov);
      if (!m) return;
      back.push([o, o.material]);
      o.material = m;
    });
  }
  return () => { for (const [o, m] of back) o.material = m; };
}

/**
 * The ID pass material(s) for a mesh whose own material is mats: one flat colour, but a card keeps its cut-out
 * (map alpha + alphaTest) and a hidden group (faceless lashes) stays hidden. Every returned material is new (the ID
 * pass disposes them after the render), except hidden ones, which are the mesh's own.
 */
export function idMaterial(mats, color) {
  const flat = () => new THREE.MeshBasicMaterial({ color });
  if (!Array.isArray(mats)) {
    if (!isCutout(mats)) return flat();
    const m = alphaOnlyMap(flat());
    Object.assign(m, { map: mats.map, alphaTest: mats.alphaTest, side: mats.side });
    return m;
  }
  return mats.map((m) => (m && m.visible === false ? m : idMaterial(m, color)));
}
