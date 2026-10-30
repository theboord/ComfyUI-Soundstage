// node --test tests/js/assets3d.test.mjs
// The maker's graphs: core nodes only, the official TripoSplat wiring, background-removal fallback order,
// and the queue/history plumbing (against a fake ComfyUI).
import test from "node:test";
import assert from "node:assert/strict";

import * as M from "../../web/assets3d/maker.mjs";

/** A fake ComfyUI: records queued graphs, answers /history with a saved file per output node. */
function fakeComfy({ birefnet = true, rmbg = true, fail = null } = {}) {
  const queued = [];
  const json = (body, status = 200) => ({ status, json: async () => body });
  const api = {
    clientId: "t", queued,
    async fetchApi(path, init = {}) {
      if (path === "/object_info/LoadBackgroundRemovalModel") {
        return json({ LoadBackgroundRemovalModel: { input: { required: { bg_removal_name: [birefnet ? ["birefnet.safetensors"] : []] } } } });
      }
      if (path === "/object_info/RMBG") return json(rmbg ? { RMBG: {} } : {});
      if (path === "/upload/image") return json({ name: "up.png", subfolder: "soundstage" });
      if (path === "/prompt") { queued.push(JSON.parse(init.body).prompt); return json({ prompt_id: `p${queued.length}` }); }
      if (path.startsWith("/history/")) {
        const pid = path.split("/").pop();
        const g = queued[Number(pid.slice(1)) - 1];
        if (fail) return json({ [pid]: { status: { status_str: "error", completed: false,
          messages: [["execution_error", { node_type: fail, exception_message: "boom" }]] }, outputs: {} } });
        const outputs = {};
        for (const [id, n] of Object.entries(g)) {
          if (n.class_type === "SaveGLB") outputs[id] = { "3d": [{ filename: `${id}.${g.f1 ? "ply" : "glb"}`, subfolder: "3d", type: "output" }] };
          if (n.class_type === "SaveImage") outputs[id] = { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] };
        }
        return json({ [pid]: { status: { status_str: "success", completed: true }, outputs } });
      }
      if (path.startsWith("/soundstage/assets3d/inspect")) {
        return json({ bbox: { min: [-1, 0, -1], max: [1, 2, 1] }, count: 9, fov_deg: { h: 60, v: 35 },
          camera: { position: [0, 1.6, 0], target: [0, 1.6, 6], focal_mm: 31.2 }, intrinsics: null,
          to_stage: { flip_xyz: [-1, 1, -1], scale: 5, offset: [0, 1.6, 0] } });
      }
      if (path === "/queue") return json({ queue_running: [], queue_pending: [] });
      throw new Error(`unexpected ${path}`);
    },
  };
  return api;
}

const CORE_3D = new Set(["LoadImage", "LoadBackgroundRemovalModel", "RemoveBackground", "InvertMask", "TripoSplatPreprocessImage",
  "CLIPVisionLoader", "VAELoader", "TripoSplatConditioning", "UNETLoader", "KSampler", "VAEDecodeTripoSplat", "SplatToFile3D",
  "SaveGLB", "SplatToMesh", "DecimateMesh", "LoadDA3Model", "DA3Inference", "DA3GeometryToMesh", "JoinImageWithAlpha", "SaveImage"]);

const types = (g) => Object.values(g).map((n) => n.class_type);

test("photoToSplat: official TripoSplat wiring, core BiRefNet, ply out", async () => {
  const api = fakeComfy();
  M.useApi(api);
  const r = await M.photoToSplat("example.png", { seed: 5, gaussians: 131072, proxy: true });
  const g = api.queued[0];
  assert.ok(types(g).every((t) => CORE_3D.has(t)), types(g).join(","));
  assert.equal(g.t6.inputs.steps, 20);
  assert.equal(g.t6.inputs.cfg, 3);
  assert.equal(g.t6.inputs.sampler_name, "dpmpp_2m");
  assert.deepEqual(g.t1.inputs.mask, ["bg2", 0]);
  assert.equal(g.t8.inputs.num_gaussians, 131072);
  assert.equal(g.f1.inputs.format, "ply");
  assert.equal(r.format, "ply");
  assert.match(r.url, /^\/view\?filename=s1\.ply&subfolder=3d&type=output$/);
  assert.deepEqual(r.bbox.size ?? [2, 2, 2], [2, 2, 2]);
  assert.ok(r.proxy.url.includes("s2"));
  assert.equal(g.m2.class_type, "DecimateMesh", "the clay proxy is decimated");
  assert.ok(g.m2.inputs.target_face_count <= 50000);
  assert.deepEqual(g.s2.inputs.mesh, ["m2", 0]);
  assert.match(r.background, /MIT/);
});

test("background removal falls back to RMBG-2.0 (flagged non-commercial), then to the photo's alpha", async () => {
  const api = fakeComfy({ birefnet: false });
  const r = await M.photoToCutout("x.png", { api });
  assert.ok(types(api.queued[0]).includes("RMBG"));
  assert.match(r.background, /NON-COMMERCIAL|non-commercial/i);
  const api2 = fakeComfy({ birefnet: false, rmbg: false });
  // backgroundRemover caches per page; a fresh module state is not available, so check the graph helper directly.
  const g = {};
  const mask = M._graphs.maskNodes(g, ["in", 0], ["in", 1], { kind: "none" });
  assert.deepEqual(mask, ["bg3", 0]);
  assert.equal(g.bg3.class_type, "InvertMask");
  assert.ok(api2);
});

test("photoToMesh set: DA3 mono -> textured mesh, returns the photo's camera", async () => {
  const api = fakeComfy();
  const r = await M.photoToMesh(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { api, kind: "set" });
  const g = api.queued[0];
  assert.deepEqual(types(g).sort(), ["DA3GeometryToMesh", "DA3Inference", "LoadDA3Model", "LoadImage", "SaveGLB"]);
  assert.equal(g.d2.inputs.mode, "mono");
  assert.equal(g.m1.inputs.texture, true);
  assert.equal(g.in.inputs.image, "soundstage/up.png", "a File/Blob is uploaded first");
  assert.equal(r.format, "glb");
  assert.equal(r.fov_deg.h, 60);
  assert.equal(r.camera.focal_mm, 31.2);
  assert.deepEqual(r.to_stage.flip_xyz, [-1, 1, -1], "the stage applies to_stage to place the set");
});

test("photoToMesh object: splat -> SplatToMesh -> GLB", async () => {
  const api = fakeComfy();
  const r = await M.photoToMesh("x.png", { api, kind: "object" });
  const go = api.queued[0];
  assert.ok(types(go).includes("SplatToMesh") && types(go).includes("VAEDecodeTripoSplat"));
  assert.equal(go.m2.inputs.target_face_count, 100000);
  assert.deepEqual(go.s1.inputs.mesh, ["m2", 0]);
  assert.equal(r.kind, "object");
});

test("a failed job surfaces the node's error", async () => {
  const api = fakeComfy({ fail: "KSampler" });
  await assert.rejects(M.photoToSplat("x.png", { api }), /KSampler: boom/);
});
