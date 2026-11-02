// Soundstage secondaries on the stage (Milestone 28): draws the particle system (particles.mjs) and the soft bodies
// (softbody.mjs) and wires them into the Stage with a few hooks (installSecondary).
//
//  - One FX object replaces the Milestone 21 impact puffs, the gait agent's hoof / foot dust and the Milestone 13
//    tyre smoke: every emitter feeds one cached, deterministic simulation; the frame on screen (or in a capture) is a
//    lookup. Dust is a soft billboard with density (noise atlas, per-puff spin, top-lit shading, near-camera fade),
//    debris an instanced mesh of chunks / splinters / grains, sparks an additive layer, plus the metal-hit flash.
//    Clay and Color only: userData.glass keeps it out of Depth and the ID matte; mode "dust" is a dust matte.
//  - Soft bodies are library kinds (tarp, flag, curtain, cape, rope, cable, rope_bridge, cardboard, sand_pile,
//    gravel_pile). "Simulate & bake" bakes them after the rigid bodies, against every prop, person and vehicle on its
//    keyed / baked motion, into a vertex cache the stage plays back (rebuilt deterministically if the page reloads).
import * as THREE from "../vendor/three.module.min.mjs";
import * as PT from "./particles.mjs";
import * as SB from "./softbody.mjs";
import { samplePos, sampleQuat } from "./physics.mjs";
import * as Gait from "./gait.mjs";

/** Library entries for the soft kinds (merged into the stage's LIBRARY by installSecondary). */
export const SOFT_LIBRARY = Object.fromEntries(Object.entries(SB.SOFT_KINDS).map(([k, v]) => [k, {
  label: v.label, height: v.type === "cloth" || v.type === "rope" ? v.h : v.type === "cardboard" ? v.size[1] : v.height, rig: "static", soft: v.type }]));

// ---------- the FX object ----------
let _atlas = null;
/** A 2 x 2 atlas of seeded puff sprites (soft lumpy blobs with a dense core), so no two puffs look stamped. */
function puffAtlas() {
  if (_atlas) return _atlas;
  if (typeof document === "undefined") {   // headless (node tests): a plain white texture stands in
    _atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    _atlas.needsUpdate = true;
    return _atlas;
  }
  const N = 256, cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const c = cv.getContext("2d");
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * 128, oy = Math.floor(t / 2) * 128;
    for (let i = 0; i < 26; i++) {
      const a = PT.hash(t, i, 1) * 6.2832, r = Math.sqrt(PT.hash(t, i, 2)) * 30, s = 16 + PT.hash(t, i, 3) * 22;
      const x = ox + 64 + Math.cos(a) * r, y = oy + 64 + Math.sin(a) * r;
      const g = c.createRadialGradient(x, y, 0, x, y, s);
      const al = 0.16 + 0.14 * PT.hash(t, i, 4);
      g.addColorStop(0, `rgba(255,255,255,${al})`); g.addColorStop(0.55, `rgba(255,255,255,${al * 0.45})`); g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g; c.beginPath(); c.arc(x, y, s, 0, 7); c.fill();
    }
    // Keep the edges of each cell clear (rotated sampling never shows a seam).
    const m = c.createRadialGradient(ox + 64, oy + 64, 40, ox + 64, oy + 64, 64);
    m.addColorStop(0, "rgba(0,0,0,0)"); m.addColorStop(1, "rgba(0,0,0,1)");
    c.globalCompositeOperation = "destination-out"; c.fillStyle = m; c.fillRect(ox, oy, 128, 128); c.globalCompositeOperation = "source-over";
  }
  _atlas = new THREE.CanvasTexture(cv);
  _atlas.colorSpace = THREE.SRGBColorSpace;
  return _atlas;
}

/** The secondary-FX object: {object, set(sim, frame, flash), matte(on)}. */
export function buildSecondaryFx() {
  const group = new THREE.Group();
  group.userData.secondaryFx = true;
  const L = PT.LIMITS;
  // Dust.
  const dg = new THREE.BufferGeometry();
  const dpos = new Float32Array(L.dust * 3), dcol = new Float32Array(L.dust * 4), dsz = new Float32Array(L.dust), drot = new Float32Array(L.dust), dtex = new Float32Array(L.dust);
  dg.setAttribute("position", new THREE.BufferAttribute(dpos, 3));
  dg.setAttribute("color", new THREE.BufferAttribute(dcol, 4));
  dg.setAttribute("pSize", new THREE.BufferAttribute(dsz, 1));
  dg.setAttribute("pRot", new THREE.BufferAttribute(drot, 1));
  dg.setAttribute("pTex", new THREE.BufferAttribute(dtex, 1));
  dg.setDrawRange(0, 0);
  const uMatte = { value: 0 };
  const dm = new THREE.PointsMaterial({ color: 0xffffff, size: 1, map: puffAtlas(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
  dm.allowOverride = false;   // Clay would draw them as squares
  dm.onBeforeCompile = (sh) => {
    sh.uniforms.uMatte = uMatte;
    sh.vertexShader = sh.vertexShader.replace("uniform float size;", "uniform float size;\nattribute float pSize;\nattribute float pRot;\nattribute float pTex;\nvarying float vRot;\nvarying float vTex;\nvarying float vFade;")
      .replace("gl_PointSize = size;", "gl_PointSize = size * pSize * projectionMatrix[1][1];\nvRot = pRot; vTex = pTex;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFade = smoothstep(0.8, 4.5, -mvPosition.z);");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uMatte;\nvarying float vRot;\nvarying float vTex;\nvarying float vFade;")
      .replace("#include <map_particle_fragment>", `
        vec2 pc = gl_PointCoord - 0.5; float cs = cos(vRot), sn = sin(vRot);
        pc = clamp(vec2(cs * pc.x - sn * pc.y, sn * pc.x + cs * pc.y) + 0.5, 0.0, 1.0);
        vec2 cuv = (vec2(mod(vTex, 2.0), floor(vTex / 2.0)) + vec2(pc.x, 1.0 - pc.y)) * 0.5;
        vec4 tx = texture2D(map, cuv);
        // Top-lit, self-shadowed underside: the cheap read of a volume.
        float shade = mix(0.68, 1.08, 1.0 - gl_PointCoord.y);
        diffuseColor.rgb *= mix(shade, 1.0, uMatte);
        diffuseColor.a *= tx.a * 2.2 * vFade;
        if (uMatte > 0.5) diffuseColor.rgb = vec3(1.0);`);
  };
  dm.customProgramCacheKey = () => "ss_m28_dust";
  const dust = new THREE.Points(dg, dm);
  dust.frustumCulled = false; dust.renderOrder = 2; dust.userData.glass = true; dust.userData.m28Dust = true;
  group.add(dust);
  // Debris: instanced chunks.
  const bm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bm, L.debris);
  debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debris.setColorAt(0, new THREE.Color(1, 1, 1));
  debris.count = 0; debris.frustumCulled = false; debris.castShadow = true; debris.receiveShadow = false;
  debris.userData.glass = true; debris.userData.noCollide = true; debris.userData.m28Debris = true;
  group.add(debris);
  // Sparks.
  const sg = new THREE.BufferGeometry();
  const spos = new Float32Array(L.sparks * 3), scol = new Float32Array(L.sparks * 4), ssz = new Float32Array(L.sparks);
  sg.setAttribute("position", new THREE.BufferAttribute(spos, 3));
  sg.setAttribute("color", new THREE.BufferAttribute(scol, 4));
  sg.setAttribute("pSize", new THREE.BufferAttribute(ssz, 1));
  sg.setDrawRange(0, 0);
  const sm = new THREE.PointsMaterial({ color: 0xffffff, size: 1, map: puffAtlas(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending });
  sm.allowOverride = false;
  sm.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace("uniform float size;", "uniform float size;\nattribute float pSize;").replace("gl_PointSize = size;", "gl_PointSize = size * pSize * projectionMatrix[1][1];"); };
  sm.customProgramCacheKey = () => "ss_m28_sparks";
  const sparks = new THREE.Points(sg, sm);
  sparks.frustumCulled = false; sparks.renderOrder = 3; sparks.userData.glass = true;
  group.add(sparks);
  const light = new THREE.PointLight(0xffd9a0, 0, 9, 2);
  light.userData.impactFlash = true;
  group.add(light);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Sc = new THREE.Vector3(), C = new THREE.Color();
  const set = (sim, F, flash = null) => {
    const fr = sim?.frames?.[Math.max(0, Math.min((sim?.frames?.length || 1) - 1, F | 0))];
    const nd = fr ? fr.n.dust : 0, nb = fr ? fr.n.debris : 0, ns = fr ? fr.n.sparks : 0;
    for (let i = 0; i < nd; i++) {
      const o = i * PT.STRIDE.dust, d = fr.dust;
      dpos[i * 3] = d[o]; dpos[i * 3 + 1] = d[o + 1]; dpos[i * 3 + 2] = d[o + 2];
      dsz[i] = d[o + 3]; dcol[i * 4] = d[o + 5]; dcol[i * 4 + 1] = d[o + 6]; dcol[i * 4 + 2] = d[o + 7]; dcol[i * 4 + 3] = d[o + 4];
      drot[i] = d[o + 8]; dtex[i] = d[o + 9];
    }
    dg.setDrawRange(0, nd);
    for (const k of ["position", "color", "pSize", "pRot", "pTex"]) dg.attributes[k].needsUpdate = true;
    for (let i = 0; i < nb; i++) {
      const o = i * PT.STRIDE.debris, d = fr.debris;
      M.compose(V.set(d[o], d[o + 1], d[o + 2]), Q.set(d[o + 3], d[o + 4], d[o + 5], d[o + 6]), Sc.set(d[o + 7], d[o + 8], d[o + 9]));
      debris.setMatrixAt(i, M);
      debris.setColorAt(i, C.setRGB(d[o + 10], d[o + 11], d[o + 12], THREE.SRGBColorSpace));
    }
    debris.count = nb;
    debris.instanceMatrix.needsUpdate = true;
    if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
    for (let i = 0; i < ns; i++) {
      const o = i * PT.STRIDE.sparks, d = fr.sparks, a = d[o + 7];
      spos[i * 3] = d[o]; spos[i * 3 + 1] = d[o + 1]; spos[i * 3 + 2] = d[o + 2];
      scol[i * 4] = 1; scol[i * 4 + 1] = 0.85 - 0.25 * (1 - a); scol[i * 4 + 2] = 0.55 - 0.4 * (1 - a); scol[i * 4 + 3] = a;
      ssz[i] = d[o + 6];
    }
    sg.setDrawRange(0, ns);
    for (const k of ["position", "color", "pSize"]) sg.attributes[k].needsUpdate = true;
    light.intensity = flash?.intensity || 0;
    if (flash?.intensity) light.position.set(flash.pos[0], Math.max(0.3, flash.pos[1] + 0.3), flash.pos[2]);
    group.visible = nd + nb + ns > 0 || !!flash?.intensity;
    return { dust: nd, debris: nb, sparks: ns };
  };
  return { object: group, set, light, dust, debris, sparks, matte: (on) => { uMatte.value = on ? 1 : 0; } };
}

// ---------- soft-body meshes ----------
/** A mesh for a soft body's topology (its own frame): cloth two-sided, cardboard a shell, ropes tubes, grains instances. */
export function buildSoftMesh(S, color, mat) {
  const g = new THREE.Group();
  g.userData.softParts = [];
  if (S.tris.length) {
    const n = S.n, two = S.type === "cloth";
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(3 * n * (two ? 2 : 1));
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const idx = [];
    for (const [a, b, c] of S.tris) idx.push(a, b, c);
    if (two) for (const [a, b, c] of S.tris) idx.push(a + n, c + n, b + n);
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat(color));
    m.castShadow = m.receiveShadow = true;
    m.userData.softTris = { two, n };
    g.add(m); g.userData.softParts.push(m);
  }
  for (const line of S.lines) {
    const sides = 6, np = line.length, r = S.type === "rope" ? S.radius * 1.2 : 0.02;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(np * sides * 3), 3));
    const idx = [];
    for (let i = 0; i < np - 1; i++) for (let k = 0; k < sides; k++) {
      const a = i * sides + k, b = i * sides + (k + 1) % sides, c = a + sides, d = b + sides;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat(color));
    m.castShadow = true;
    m.userData.softTube = { line: [...line], sides, r };
    g.add(m); g.userData.softParts.push(m);
  }
  if (S.type === "grains") {
    const m = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat(color), S.n);
    m.castShadow = true; m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const C = new THREE.Color(color);
    for (let i = 0; i < S.n; i++) { const k = 0.82 + 0.3 * PT.hash(i, 7, 1); m.setColorAt(i, new THREE.Color(C.r * k, C.g * k, C.b * k)); }
    m.userData.softGrains = { r: S.radius };
    g.add(m); g.userData.softParts.push(m);
  }
  return g;
}

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _V = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Euler();
/** Write a frame of world positions into a soft mesh, through the actor's inverse world matrix. */
export function setSoftMesh(mesh, world, inv) {
  const loc = new Float32Array(world.length);
  for (let i = 0; i < world.length; i += 3) { _V.set(world[i], world[i + 1], world[i + 2]).applyMatrix4(inv); loc[i] = _V.x; loc[i + 1] = _V.y; loc[i + 2] = _V.z; }
  for (const m of mesh.userData.softParts) {
    if (m.userData.softTris) {
      const p = m.geometry.attributes.position.array, { two, n } = m.userData.softTris;
      p.set(loc.subarray(0, 3 * n)); if (two) p.set(loc.subarray(0, 3 * n), 3 * n);
      m.geometry.attributes.position.needsUpdate = true;
      m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
    } else if (m.userData.softTube) {
      const { line, sides, r } = m.userData.softTube, p = m.geometry.attributes.position.array;
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)], c = line[i];
        let t = [loc[3 * b] - loc[3 * a], loc[3 * b + 1] - loc[3 * a + 1], loc[3 * b + 2] - loc[3 * a + 2]];
        const tl = Math.hypot(...t) || 1; t = t.map((x) => x / tl);
        const up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
        const ul = Math.hypot(...u) || 1; u = u.map((x) => x / ul);
        const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
        for (let k = 0; k < sides; k++) {
          const an = (k / sides) * 6.2832, cs = Math.cos(an) * r, sn = Math.sin(an) * r, o = (i * sides + k) * 3;
          p[o] = loc[3 * c] + u[0] * cs + w[0] * sn; p[o + 1] = loc[3 * c + 1] + u[1] * cs + w[1] * sn; p[o + 2] = loc[3 * c + 2] + u[2] * cs + w[2] * sn;
        }
      }
      m.geometry.attributes.position.needsUpdate = true;
      m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
    } else if (m.userData.softGrains) {
      const r = m.userData.softGrains.r;
      for (let i = 0; i < m.count; i++) {
        const k = 0.75 + 0.4 * PT.hash(i, 3, 2);
        _E.set(PT.hash(i, 1) * 6.3, PT.hash(i, 2) * 6.3, PT.hash(i, 4) * 6.3);
        _M.compose(_V.set(loc[3 * i], loc[3 * i + 1], loc[3 * i + 2]), _Q.setFromEuler(_E), _S.set(r * k, r * k * (0.8 + 0.3 * PT.hash(i, 5)), r * k));
        m.setMatrixAt(i, _M);
      }
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere?.();
    }
  }
}

const SOFT_COLORS = { tarp: "#4f6b7a", flag: "#b23a32", curtain: "#7a4a5a", cape: "#5a4a6e", rope: "#a58a5c", cable: "#2b2d31", rope_bridge: "#8a6a44",
  cardboard: "#b08a5a", sand_pile: "#c9a46e", gravel_pile: "#8b8680" };

// ---------- the Stage hooks ----------
/**
 * Install the secondaries on the Stage class. deps: {LIBRARY, NO_COLLIDE, PERSON_KINDS, CAR_BODIES}. Overrides the old
 * per-system FX (_impactFxAt, _gaitDustAt, _tireSmoke) so everything runs through one system; adds _secondaryAt(frame)
 * (called once per setFrame), _renderDustMatte(cam), the soft-body bake and its panel API, and wraps simulatePhysics /
 * clearPhysics so "Simulate & bake" does rigid bodies then soft bodies.
 */
export function installSecondary(Stage, deps) {
  const { LIBRARY, NO_COLLIDE, PERSON_KINDS, CAR_BODIES } = deps;
  for (const [k, v] of Object.entries(SOFT_LIBRARY)) { if (!LIBRARY[k]) LIBRARY[k] = v; NO_COLLIDE.add(k); }
  const P = Stage.prototype;

  // The old systems feed this one now.
  P._impactFxAt = function () { if (this.impactFx) { this.impactFx.object.visible = false; this.impactFx.light.intensity = 0; } };
  P._gaitDustAt = function () { if (this.gaitDust) this.gaitDust.object.visible = false; };
  P._tireSmoke = function (a, g, dyn) {
    if (g.userData.tireSmoke) g.userData.tireSmoke.object.visible = false;
    if (!dyn || !dyn.smoke.some((s) => s.amount > 0.01)) { this._smokeSrc?.delete(a.id); return; }
    const h = (a.height_m || LIBRARY[a.kind]?.height || 1.45) / (LIBRARY[a.kind]?.height || 1.45);
    const rig = g.userData.wheelRig || [];
    const track = Math.max(0.78 * h, ...rig.map((w) => Math.abs(w.position.x)));
    const wheels = rig.length
      ? rig.flatMap((w) => (Math.abs(w.position.x) < 0.25 * track ? [track, -track] : [w.position.x]).map((x) => ({ x, z: w.position.z, front: w.position.z > 0 })))
      : [[0.78, 1.3], [-0.78, 1.3], [0.78, -1.3], [-0.78, -1.3]].map(([x, z]) => ({ x: x * h, z: z * h, front: z > 0 }));
    (this._smokeSrc ||= new Map()).set(a.id, { dyn, wheels, surface: a.stunt_sim?.surface || "dry", seed: [...String(a.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0) });
  };

  /** The ground preset in use and the choices: {ground, auto, choices: {id: label}}. */
  P.groundTypeInfo = function () {
    const env = this.state.environment || {}, o = this.state.physics?.ground || "auto";
    return { ground: PT.groundPresetFor(env.set, env.weather, o), setting: o, choices: Object.fromEntries([["auto", "Auto (from the set)"], ...PT.GROUND_TYPES.map((k) => [k, PT.GROUND_PRESETS[k].label])]) };
  };
  P.setGroundType = function (t) {
    if (t !== "auto" && !PT.GROUND_TYPES.includes(t)) return null;
    this.state.physics = { ...(this.state.physics || {}), ground: t };
    this.setFrame(this.frame); this.onChange(this.toJSON());
    return this.groundTypeInfo();
  };

  /** All the emitters on the shot (hits, breaks, strikes, tyre smoke). */
  P._secondaryEmitters = function () {
    const env = this.state.environment || {}, ph = this.state.physics || {}, fx = ph.fx || {};
    const fps = this.state.shot?.fps || 24, seed = ph.seed ?? 1;
    const ground = PT.groundPresetFor(env.set, env.weather, ph.ground);
    const em = [];
    if (ph.events?.length) {
      const velOf = (id, f) => {
        const a = this.state.actors.find((x) => x.id === id);
        if (!a) return [0, 0, 0];
        const at = (k) => (a.physics?.baked ? samplePos(a.keys || [], k) : this._actorPosAt(a, k));
        const p0 = at(f), p1 = at(f + 2);
        return [(p1[0] - p0[0]) * fps / 2, (p1[1] - p0[1]) * fps / 2, (p1[2] - p0[2]) * fps / 2];
      };
      em.push(...PT.emittersFromImpacts(ph.events, { ground, seed, dust: fx.dust !== false, debris: fx.debris !== false, sparks: fx.sparks !== false, velOf }));
    }
    if (ph.breaks?.length) em.push(...PT.emittersFromBreaks(ph.breaks, { fps, ground, seed }));
    const gd = Gait.groundDust(env.set, env.weather);
    if (gd.amount > 0 && this._gaitCache) {
      const strikes = [];
      for (const a of this.state.actors) {
        const c = this._gaitCache.get(a);
        if (!c || this.actorMeshes.get(a.id) !== c.g) continue;
        c.plan.strikes ||= Gait.strikeEvents(c.plan, { id: a.id, support: (x, z) => this._supportAt(x, z, 0) });
        strikes.push(...c.plan.strikes);
      }
      em.push(...PT.emittersFromStrikes(strikes, { amount: gd.amount, ground, seed, color: ground === "wet_spray" ? null : gd.color }));
    }
    for (const [id, s] of this._smokeSrc || []) {
      if (!this.state.actors.some((a) => a.id === id)) continue;
      const memo = (this._smokeEm ||= new WeakMap());
      let list = memo.get(s.dyn);
      if (!list || list.key !== `${s.surface}|${s.wheels.length}`) { list = PT.emittersFromSmoke(s.dyn, s.wheels, { fps, seed: s.seed, surface: s.surface, id }); list.key = `${s.surface}|${s.wheels.length}`; memo.set(s.dyn, list); }
      em.push(...list);
    }
    return em;
  };

  /** Draw the secondaries at a frame (one cached simulation of the whole shot) and play the soft bodies. */
  P._secondaryAt = function (frame) {
    if (this._softSampling) return;
    this._softAt(frame);
    const em = this._secondaryEmitters();
    if (!em.length) { if (this.secondary) { this.secondary.object.visible = false; this.secondary.light.intensity = 0; } this.secondaryFrame = null; return; }
    const fps = this.state.shot?.fps || 24, frames = this._lastFrame() + 1, seed = this.state.physics?.seed ?? 1;
    const boxes = this._setCollidersCached?.() || [];
    const opts = { frames, fps, seed, boxes };
    const sig = PT.emitterSig(em, opts);
    if (this._secSim?.sig !== sig) {
      const t0 = performance.now();
      this._secSim = { sig, sim: PT.simulateParticles(em, opts) };
      this._secSim.ms = Math.round(performance.now() - t0);
    }
    if (!this.secondary) this.secondary = buildSecondaryFx();
    if (this.secondary.object.parent !== this.root) this.root.add(this.secondary.object);   // the set was rebuilt
    const fx = this.state.physics?.fx || {};
    const flash = fx.sparks !== false ? PT.flashAt(this.state.physics?.events, frame, { fps }) : null;
    this.secondaryFrame = this.secondary.set(this._secSim.sim, frame, flash && { ...flash, intensity: flash.intensity * 5 });
  };

  /** What the particle system is doing: {emitters, ms, stats, frame: {dust, debris, sparks}, ground}. */
  P.secondaryInfo = function () {
    return { sig: this._secSim?.sig || null, ms: this._secSim?.ms ?? null, stats: this._secSim?.sim?.stats || null, frame: this.secondaryFrame || null, ground: this.groundTypeInfo().ground };
  };

  /** The dust matte (Layer Pack): the dust's density white on black, held out by everything solid in front of it. */
  P._renderDustMatte = function (cam) {
    const saved = [], black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.scene.traverse((o) => {
      if (o.userData.m28Dust) return;
      if (o.userData.glass || o.userData.splatOnly || o.isPoints || o.isLineSegments || o.isSprite) { saved.push([o, o.material, o.visible]); o.visible = false; return; }
      if (o.isMesh) { saved.push([o, o.material, o.visible]); o.material = black; }
    });
    const bg = this.scene.background, fog = this.scene.fog, ov = this.scene.overrideMaterial;
    this.scene.background = new THREE.Color(0x000000); this.scene.fog = null; this.scene.overrideMaterial = null;
    if (this.camHelper) this.camHelper.visible = false;
    this.secondary?.matte(true);
    try { this.renderer.render(this.scene, cam); } finally {
      this.secondary?.matte(false);
      for (const [o, m, v] of saved) { o.material = m; o.visible = v; }
      this.scene.background = bg; this.scene.fog = fog; this.scene.overrideMaterial = ov;
      black.dispose();
    }
  };

  // ---------- soft bodies ----------
  P._softActors = function () { return this.state.actors.filter((a) => SB.isSoftKind(a.kind) && a.physics?.mode !== "off"); };

  /** The soft body's mesh on its actor group (built once per spec; the stand-in cube is hidden). */
  P._ensureSoftMesh = function (a, g) {
    const spec = SB.softSpecOf(a);
    const key = JSON.stringify(spec);
    if (g.userData.softMesh?.userData.key === key) return g.userData.softMesh;
    if (g.userData.softMesh) g.remove(g.userData.softMesh);
    for (const o of g.children) { o.visible = false; o.userData.noCollide = true; }
    const S = SB.buildSoft(spec);
    const color = a.appearance?.color || SOFT_COLORS[a.kind] || "#9a9a9a";
    const mesh = buildSoftMesh(S, color, (c) => {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: S.type === "cloth" ? 0.95 : 0.9, side: THREE.DoubleSide, flatShading: S.type === "cardboard" });
      if (S.type === "grains") m.color.set(0xffffff);   // instance colours carry the tint
      return m;
    });
    mesh.userData.key = key;
    mesh.traverse((o) => { o.userData.actorId = a.id; o.userData.noCollide = true; });
    g.add(mesh);
    g.userData.softMesh = mesh;
    // The rest shape, in the actor's own frame, until it is baked.
    const rest = new Float32Array(S.rest);
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4();   // rest is already local: identity
    setSoftMesh(mesh, rest, inv);
    mesh.userData.restShown = true;
    return mesh;
  };

  /** Play the soft bodies' vertex caches at a frame (rebuilding a missing cache deterministically). */
  P._softAt = function (frame) {
    const list = this._softActors();
    if (!list.length) return;
    let needBake = false;
    for (const a of list) {
      const g = this.actorMeshes.get(a.id);
      if (!g) continue;
      this._ensureSoftMesh(a, g);
      if (a.physics?.soft_bake && !this._softCache?.get(a.id)) needBake = true;
    }
    if (needBake && !this._softRebuilding) {
      this._softRebuilding = true;
      try { this.simulateSoftBodies({ quiet: true, onlyMissing: true }); } finally { this._softRebuilding = false; }
    }
    for (const a of list) {
      const g = this.actorMeshes.get(a.id), c = this._softCache?.get(a.id);
      if (!g?.userData.softMesh) continue;
      if (!c || !a.physics?.soft_bake) {
        if (!g.userData.softMesh.userData.restShown) { setSoftMesh(g.userData.softMesh, new Float32Array(SB.buildSoft(SB.softSpecOf(a)).rest), new THREE.Matrix4()); g.userData.softMesh.userData.restShown = true; }
        continue;
      }
      g.updateMatrixWorld(true);
      const inv = g.matrixWorld.clone().invert();
      setSoftMesh(g.userData.softMesh, c.frames[Math.max(0, Math.min(c.frames.length - 1, frame | 0))], inv);
      g.userData.softMesh.userData.restShown = false;
    }
  };

  /** Collision proxies for the soft bodies: every solid actor's box(es) per frame, the set's boxes, broken pieces. */
  P._softColliderSpecs = function (posesOf) {
    const out = [];
    for (const a of this.state.actors) {
      if (SB.isSoftKind(a.kind) || a.physics?.mode === "off" || a.kind === "card" || NO_COLLIDE.has(a.kind) || a.set_xform || !this.actorMeshes.has(a.id)) continue;
      if (a.mount_id || a.carry_id) continue;
      const g = this.actorMeshes.get(a.id), box = g && this._localBox(g);
      if (!box) continue;
      let poses = posesOf.get(a.id);
      if (!poses) continue;
      const fr = a.physics?.fracture;
      if (fr) {   // the whole prop until it breaks; its pieces after that
        poses = poses.map((p, f) => (f >= fr.frame ? { pos: [0, -100, 0], quat: [0, 0, 0, 1] } : p));
        for (const [i, pc] of (fr.pieces || []).entries()) {
          const pp = poses.map((_, f) => (f < fr.frame - 1 ? { pos: [0, -100, 0], quat: [0, 0, 0, 1] } : { pos: samplePos(pc.keys, f), quat: sampleQuat(pc.keys, f) || [0, 0, 0, 1] }));
          out.push({ id: `${a.id}#piece${i}`, half: pc.half, center: pc.center, poses: pp });
        }
      }
      if (PERSON_KINDS.has(a.kind)) out.push({ id: a.id, half: [box.half[0] * 0.6, box.half[1], box.half[2] * 0.75], center: box.center, poses });
      else if (CAR_BODIES.has(a.kind)) {
        // A car rides over low things: the body's floor sits at ~22% of its height, the four tyres roll on the ground
        // (so a cardboard box is crushed under the body and flattened by the wheels, not bulldozed down the road).
        const [hx, hy, hz] = box.half, [cx, cy, cz] = box.center, y0 = cy - hy, H = 2 * hy, r = Math.min(0.36, H * 0.24);
        out.push({ id: `${a.id}#body`, half: [hx, H * 0.17, hz * 0.8], center: [cx, y0 + H * 0.39, cz - hz * 0.2], poses });
        // The nose, raked up 25°: what it meets is pushed down and under (a box is run over, not bulldozed).
        const th = -25 * Math.PI / 180;
        out.push({ id: `${a.id}#nose`, half: [hx, H * 0.17, hz * 0.3], center: [cx, y0 + H * 0.45, cz + hz * 0.68], rot: [Math.sin(th / 2), 0, 0, Math.cos(th / 2)], poses });
        out.push({ id: `${a.id}#cabin`, half: [hx * 0.9, H * 0.2, hz * 0.5], center: [cx, y0 + H * 0.76, cz - hz * 0.08], poses });
        for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) out.push({ id: `${a.id}#tyre`, half: [0.11, r, r * 0.8], center: [cx + sx * hx * 0.82, y0 + r, cz + sz * hz * 0.66], poses });
      } else out.push({ id: a.id, half: box.half, center: box.center, poses });
    }
    for (const c of this._setColliders?.() || []) out.push({ id: c.id, half: c.half, center: c.center || [0, 0, 0], poses: c.poses });
    return out;
  };

  /**
   * Bake every soft body over the shot against the props, people and vehicles on their keys (the rigid bodies are
   * baked first by simulatePhysics). opts: {quiet, onlyMissing, ids}. Returns {ok, bodies, ms, message, stats}.
   */
  P.simulateSoftBodies = function (opts = {}) {
    const t0 = performance.now();
    let list = this._softActors();
    if (opts.ids) list = list.filter((a) => opts.ids.includes(a.id));
    if (opts.onlyMissing) list = list.filter((a) => !this._softCache?.get(a.id));
    if (!list.length) return { ok: false, bodies: 0, message: "No soft bodies on the set." };
    const last = this._lastFrame(), fps = this.state.shot?.fps || 24, keep = this.frame;
    // Sample every actor's pose per frame once (soft bodies, their pin hosts and every collider).
    const posesOf = new Map(this.state.actors.map((a) => [a.id, []]));
    this._softSampling = true;
    try {
      for (let f = 0; f <= last; f++) {
        this.setFrameSilent(f);
        for (const a of this.state.actors) {
          const g = this.actorMeshes.get(a.id);
          if (!g) continue;
          posesOf.get(a.id).push({ pos: [g.position.x, g.position.y, g.position.z], quat: [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w], scale: g.scale.x });
        }
      }
    } finally { this._softSampling = false; }
    const colliders = this._softColliderSpecs(posesOf);
    this._softCache ||= new Map();
    const stats = {};
    for (const a of list) {
      const spec = SB.softSpecOf(a);
      const attachId = a.physics?.soft?.attach;
      const sopts = { frames: last + 1, fps, poses: posesOf.get(a.id), attach: attachId && posesOf.get(attachId) ? { poses: posesOf.get(attachId) } : null,
        colliders: colliders.filter((c) => c.id.split("#")[0] !== attachId) };
      const r = SB.simulateSoft(spec, sopts);
      this._softCache.set(a.id, { frames: r.frames, sys: r.sys });
      stats[a.id] = r.stats;
      a.physics = { ...(a.physics || {}), mode: a.physics?.mode === "off" ? "off" : "soft",
        soft_bake: { frames: last + 1, n: r.sys.n, type: r.sys.type, ms: r.stats.ms, max_stretch: r.stats.maxStretch, settled: r.stats.settledFrame } };
    }
    this.setFrameSilent(keep);
    if (!opts.quiet) { this.setFrame(keep); this.onChange(this.toJSON()); }
    const ms = Math.round(performance.now() - t0);
    const names = list.map((a) => a.name || a.kind).slice(0, 4).join(", ");
    return { ok: true, bodies: list.length, ms, stats, message: `Soft bodies: ${list.length} baked (${names}) in ${(ms / 1000).toFixed(1)} s.` };
  };

  P.clearSoftBodies = function () {
    let n = 0;
    for (const a of this._softActors()) if (a.physics?.soft_bake) { delete a.physics.soft_bake; this._softCache?.delete(a.id); n++; }
    for (const g of this.actorMeshes.values()) if (g.userData.softMesh) g.userData.softMesh.userData.restShown = false;
    return n;
  };

  /** The selected soft body's settings for the panel, or null. */
  P.softInfo = function (id = this.selected) {
    const a = this.state.actors.find((x) => x.id === id);
    const spec = a && SB.softSpecOf(a);
    if (!spec) return null;
    return { id: a.id, name: a.name, kind: a.kind, type: spec.type, spec, baked: !!a.physics?.soft_bake, bake: a.physics?.soft_bake || null,
      kinds: Object.entries(SB.SOFT_KINDS).filter(([, v]) => v.type === spec.type).map(([k, v]) => [k, v.label]),
      attach: a.physics?.soft?.attach || "", hosts: this.state.actors.filter((x) => x.id !== a.id && !SB.isSoftKind(x.kind)).map((x) => [x.id, x.name || x.kind]) };
  };
  /** Change a soft body's settings (patch merged into a.physics.soft; kind switches the library kind). Clears its bake. */
  P.setSoft = function (id, patch = {}) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a || !SB.isSoftKind(a.kind)) return null;
    const p = { ...patch };
    if (p.kind && SB.isSoftKind(p.kind)) { a.kind = p.kind; a.height_m = SOFT_LIBRARY[p.kind].height; delete p.kind; }
    a.physics = { ...(a.physics || {}), mode: "soft", soft: { ...(a.physics?.soft || {}), ...p } };
    delete a.physics.soft_bake; this._softCache?.delete(a.id);
    const g = this.actorMeshes.get(a.id);
    if (g) this._ensureSoftMesh(a, g);
    this.setFrame(this.frame); this.onChange(this.toJSON());
    return this.softInfo(id);
  };

  // "Simulate & bake" runs the rigid bodies, then the soft bodies on top of them; "Clear" clears both.
  const sim0 = P.simulatePhysics, clear0 = P.clearPhysics;
  P.simulatePhysics = function (opts = {}) {
    const soft = this._softActors();
    const dyn = this.state.actors.some((a) => a.physics?.mode === "dynamic" && this._physCanMove(a));
    let r = dyn || !soft.length ? sim0.call(this, opts) : { ok: true, message: "", bodies: 0 };
    if (!soft.length) return r;
    const s = this.simulateSoftBodies();
    return { ...r, ok: r.ok !== false || s.ok, soft: s, message: [r.ok !== false ? r.message : "", s.message].filter(Boolean).join(" ") };
  };
  P.clearPhysics = function (ids = null) {
    const n = clear0.call(this, ids);
    const s = ids ? 0 : this.clearSoftBodies();
    if (s && !n) { this.setFrame(this.frame); this.onChange(this.toJSON()); }
    return n + s;
  };
}
