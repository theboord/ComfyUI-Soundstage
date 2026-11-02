// Stage probe: runs the real Soundstage stage (web/stage/stage.mjs) on one scene and writes, per frame,
//   - the shot camera (position, rotation, intrinsics at the stage frame size),
//   - every actor's oriented box (centre, heading, size) and main colour,
//   - every clay person's COCO-18 joints (web/stage/posepass.mjs personKeypoints, the App's own definition),
//   - the ID pass (PNG) and optionally the Color pass (JPEG), exactly as the App renders them.
// Job: probe.html?job=<path under /data/> -> {scene: <path under /data/> | {...}, out: <prefix under /data/>,
//      modes: ["id", "color"], every: 1, frames: N?, drop_backdrop: true, clip, kind: "truth" | "recon"}
// Output: /data/<out>.json (schema v2s-bench/1), /data/<out>_id/NNNN.png, /data/<out>_color/NNNN.jpg.
import * as THREE from "../../../web/vendor/three.module.min.mjs";
import { Stage } from "../../../web/stage/stage.mjs";
import { personKeypoints } from "../../../web/stage/posepass.mjs";

const log = (t) => { document.getElementById("log").textContent = t; };
const st = (window.__probe = { state: "starting", f: 0, n: 0, errors: [] });
window.addEventListener("error", (e) => st.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => st.errors.push(String(e.reason?.message || e.reason)));

// Count fetches in flight, so we wait for GLB models and mocap takes before rendering.
let inflight = 0, lastNet = performance.now();
const of = window.fetch.bind(window);
window.fetch = (...a) => { inflight++; lastNet = performance.now(); return of(...a).finally(() => { inflight--; lastNet = performance.now(); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(quietMs = 1500, maxMs = 60000) {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) {
    if (inflight === 0 && performance.now() - lastNet > quietMs) return true;
    await sleep(100);
  }
  return false;
}
const save = async (p, body) => {
  const r = await of(`/save?p=${encodeURIComponent(p)}`, { method: "POST", body });
  if (!r.ok) throw new Error(`save ${p}: ${r.status}`);
};
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function visibleChain(o) {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function actorBoxes(stage) {
  const byActor = new Map();
  stage.scene.updateMatrixWorld(true);
  stage.scene.traverse((o) => {
    const id = o.userData?.actorId;
    if (!id || !(o.isMesh || o.isSkinnedMesh) || o.userData.partProxy || !visibleChain(o)) return;
    if (!o.geometry) return;
    if (!byActor.has(id)) byActor.set(id, []);
    byActor.get(id).push(o);
  });
  const out = {};
  const v = new THREE.Vector3(), inv = new THREE.Matrix4(), F = new THREE.Matrix4();
  for (const [id, meshes] of byActor) {
    const g = stage.actorMeshes.get(id);
    if (!g) continue;
    const m = g.matrixWorld.elements;
    const yaw = Math.atan2(m[8], m[10]);          // local +Z (the actor's facing) on the ground
    const pos = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
    F.makeRotationY(yaw).setPosition(pos);
    inv.copy(F).invert();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const cols = {};
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const b = geo.boundingBox;
      if (!b || !Number.isFinite(b.min.x)) continue;
      const M = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      let area = 0;
      const wlo = new THREE.Vector3(Infinity, Infinity, Infinity), whi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(M);
        lo.min(v); hi.max(v); wlo.min(v); whi.max(v);
      }
      const d = whi.clone().sub(wlo);
      area = d.x * d.y + d.y * d.z + d.x * d.z;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (mat?.color && !mat.transparent && area > 0) {
        const hx = "#" + mat.color.getHexString();
        cols[hx] = (cols[hx] || 0) + area;
      }
    }
    if (!Number.isFinite(lo.x)) continue;
    const c = lo.clone().add(hi).multiplyScalar(0.5).applyMatrix4(F);
    const size = hi.clone().sub(lo);
    const color = Object.entries(cols).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    out[id] = { c: [r4(c.x), r4(c.y), r4(c.z)], yaw: r4((yaw * 180) / Math.PI), size: [r4(size.x), r4(size.y), r4(size.z)], color,
      root: [r4(pos.x), r4(pos.y), r4(pos.z)] };
  }
  return out;
}

async function main() {
  const q = new URLSearchParams(location.search);
  const job = await (await of(`/data/${q.get("job")}`)).json();
  let scene = typeof job.scene === "string" ? await (await of(`/data/${job.scene}`)).json() : job.scene;
  scene = scene.scene && !scene.actors ? scene.scene : scene;
  if (job.drop_backdrop !== false) {
    scene.actors = (scene.actors || []).filter((a) => !(a.kind === "glb" && (a.id === "v2s_backdrop" || /DA3/.test(a.name || ""))));
    delete scene.backdrop;
  }
  if (job.active_shot) scene.active_shot = job.active_shot;
  const stage = new Stage(document.getElementById("stage"), () => {});
  stage.fetchApi = (u) => window.fetch(u);
  stage.load(scene);
  stage.setFrame(0);
  await settle(1500, 90000);
  stage.setFrame(Math.min(10, (scene.shot?.frames || 97) - 1));
  stage.setFrame(0);
  await settle(1000, 60000);
  const n = job.frames || stage.state.shot?.frames || 97;
  const every = job.every || 1;
  const modes = job.modes || ["id"];
  const fw = stage.fw, fh = stage.fh;
  st.n = n;
  st.state = "running";
  const actors = stage.state.actors || [];
  const objects = {}, people = {};
  for (const a of actors) {
    const moving = (a.keys || []).length > 1 || !!a.mocap || !!a.stunt || !!a.mount_id || !!a.pose_keys?.length;
    objects[a.id] = { id: a.id, label: a.name || a.label || a.recipe?.name || a.kind, cls: a.kind === "custom" ? (a.recipe?.name || "custom") : a.kind,
      kind: a.kind, set_piece: !!a.set_piece, appearance: a.appearance || null, dynamic: moving, mocap: !!a.mocap, mount_id: a.mount_id || null,
      frames: [] };
  }
  const camera = [];
  for (let f = 0; f < n; f += every) {
    st.f = f;
    stage.setFrameSilent(f);
    const cam = stage.camera;
    cam.updateMatrixWorld(true);
    const e = cam.matrixWorld.elements;
    const fy = fh / 2 / Math.tan((cam.fov * Math.PI) / 360);
    camera.push({ f, pos: [r4(e[12]), r4(e[13]), r4(e[14])], R: [[r4(e[0]), r4(e[4]), r4(e[8])], [r4(e[1]), r4(e[5]), r4(e[9])], [r4(e[2]), r4(e[6]), r4(e[10])]],
      fx: r4(fy), fy: r4(fy), cx: fw / 2, cy: fh / 2 });
    const boxes = actorBoxes(stage);
    for (const [id, b] of Object.entries(boxes)) {
      if (!objects[id]) continue;
      objects[id].frames.push({ f, c: b.c, yaw: b.yaw, size: b.size, root: b.root });
      if (b.color && !objects[id].color) objects[id].color = b.color;
    }
    for (const a of actors) {
      const g = stage.actorMeshes.get(a.id);
      if (!g?.userData?.joints) continue;
      const kp = personKeypoints(g, cam.position);
      if (!kp) continue;
      (people[a.id] ||= []).push({ f, J: kp.body.map((p) => (p ? [r4(p.x), r4(p.y), r4(p.z)] : null)) });
    }
    for (const mode of modes) {
      const c = stage.renderFrameTo(mode, f);
      const blob = await new Promise((res) => c.toBlob(res, mode === "color" ? "image/jpeg" : "image/png", 0.92));
      await save(`${job.out}_${mode}/${String(f).padStart(4, "0")}.${mode === "color" ? "jpg" : "png"}`, blob);
    }
    if (f % 10 === 0) log(`${job.out}: frame ${f}/${n}`);
  }
  const ids = stage.idColors();
  const out = { schema: "v2s-bench/1", clip: job.clip || "", kind: job.kind || "stage", width: fw, height: fh, fps: stage.state.shot?.fps || 24,
    frames: n, every, axes: "stage: metres, Y up, ground y=0", camera, objects: Object.values(objects).map((o) => ({ ...o, id_color: ids[o.id] })),
    people: Object.entries(people).map(([id, fr]) => ({ id, object_id: id, joints: ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow",
      "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear"], frames: fr })),
    id_palette: ids, id_dir: modes.includes("id") ? `${job.out.split("/").pop()}_id` : null,
    color_dir: modes.includes("color") ? `${job.out.split("/").pop()}_color` : null, active_shot: stage.activeShot?.()?.id || null,
    exact: job.exact ?? true,
    errors: st.errors.slice(0, 20) };
  await save(`${job.out}.json`, new Blob([JSON.stringify(out)], { type: "application/json" }));
  st.state = "done";
  log(`done ${job.out}`);
}

main().catch((e) => { st.state = "error"; st.errors.push(String(e?.stack || e)); log(String(e)); });
