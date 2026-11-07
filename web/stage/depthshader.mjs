// The Depth pass shader, shared by the stage (stage.mjs) and the sets that draw their own Depth (sets/underwater.mjs).
// It skins (three's skinning chunks, as outline.mjs does), so rigged bodies (the horse, the lifelike people) draw in
// their pose instead of frozen in their bind pose; unskinned meshes compile without them (USE_SKINNING undefined).
// With the CUTOUT define it also takes a colour map's alpha and an alpha test, for cut-out cards (the lifelike people's
// hair and lashes, people/cutout.mjs): without it the card would write depth over its whole quad.
import * as THREE from "../vendor/three.module.min.mjs";

export const DEPTH_SHADER = {
  vertex: `#include <common>
    #include <skinning_pars_vertex>
    varying float vViewZ;
    #ifdef CUTOUT
    varying vec2 vCutUv;
    #endif
    void main(){
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      #ifdef CUTOUT
      vCutUv = uv;
      #endif
      vec4 mv = modelViewMatrix * vec4(transformed,1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragment: `uniform float uNear; uniform float uFar; varying float vViewZ;
    #ifdef CUTOUT
    uniform sampler2D uMap; uniform float uAlphaTest; varying vec2 vCutUv;
    #endif
    void main(){
      #ifdef CUTOUT
      if (texture2D(uMap, vCutUv).a < uAlphaTest) discard;
      #endif
      float d = clamp((vViewZ - uNear)/(uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - d), 1.0); }`,
};

/** A Depth pass material between near and far (metres). userData.depthPass marks it, so a cut-out version can be made
 *  from it with the same (shared) near / far uniforms: depthCutout. */
export function depthPassMaterial(near, far) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: near }, uFar: { value: far } },
    vertexShader: DEPTH_SHADER.vertex,
    fragmentShader: DEPTH_SHADER.fragment,
  });
  m.userData.depthPass = true;
  return m;
}

/** The cut-out version of a Depth pass material for a card material src (its map's alpha, its alphaTest, its side). */
export function depthCutout(depth, src) {
  const m = new THREE.ShaderMaterial({
    defines: { CUTOUT: "" },
    uniforms: { uNear: depth.uniforms.uNear, uFar: depth.uniforms.uFar, uMap: { value: src.map }, uAlphaTest: { value: src.alphaTest || 0.5 } },
    vertexShader: depth.vertexShader,
    fragmentShader: depth.fragmentShader,
    side: src.side,
  });
  m.userData.depthPass = true;
  return m;
}
