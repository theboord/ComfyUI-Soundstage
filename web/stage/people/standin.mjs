// The marked stand-in person (Lifelike-only plan 4.2, Mike's decision 2026-11-07: "marked stand-in people + an install
// banner, captures not blocked"). Shown for a person with no lifelike body: the Rocketbox kit is not installed or
// failed to load, it is still loading, or the kind has no avatar yet (children).
//
// FLAW (L1): the plan's stand-in is the SMOOTH PROXY (4.1: an SDF of the person in the rest pose, marching cubes in a
// worker, skinned to the logic rig), which lands with L2+L3. Until then the stand-in is the logic rig's own geometry
// in one flat, striped "stand-in" material, tagged role:'standin' and g.userData.shownAs = 'standin', so it is never
// the clay look's colours and every pass, capture sheet and test can tell it from a lifelike body. It is still the
// rig's shapes.
import * as THREE from "../../vendor/three.module.min.mjs";

let _mat = null;
/** One shared material: pale blue-grey with soft diagonal stripes (world space), so it reads as a placeholder. */
export function standInMaterial() {
  if (_mat) return _mat;
  const m = new THREE.MeshStandardMaterial({ name: "standin_person", color: 0xb4bcc6, roughness: 0.55, metalness: 0 });
  m.userData = { role: "standin", standin: true };
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSiW;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvSiW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vSiW;")
      .replace("#include <color_fragment>", "#include <color_fragment>\nfloat siS = step(0.5, fract((vSiW.x + vSiW.y + vSiW.z) * 6.0));\ndiffuseColor.rgb *= mix(0.86, 1.0, siS);");
  };
  m.customProgramCacheKey = () => "ss-standin-person";
  _mat = m;
  return m;
}

/** Show the person group g as the marked stand-in (on) or put its own materials back (off). Idempotent. */
export function setStandIn(g, on, { loading = false } = {}) {
  if (!g) return;
  g.userData.peopleLoading = !!(on && loading);
  if (!!g.userData.standIn === !!on) return;
  const mat = standInMaterial();
  g.traverse((o) => {
    if (!o.isMesh || o.userData.avatar) return;
    if (on) { o.userData.lookMat = o.material; o.material = mat; o.userData.role = "standin"; }
    else if (o.userData.lookMat) { o.material = o.userData.lookMat; delete o.userData.lookMat; o.userData.role = "logic"; }
  });
  g.userData.standIn = !!on;
  g.userData.shownAs = on ? "standin" : "lifelike";
}
