// Import a file into the App (local try-it build) through WorldMount.importWorld and measure what came in.
//   node ss_import.mjs <url-under-staging> <outdir> [--frames 0,23,47] [--hide REGEX] [--fps 24] [--aspect 16:9] [--merge 0|1] [--port 9671]
// Writes <outdir>/ss_info.json, ss_clay_<f>.png, ss_color_<f>.jpg, ss_mask_<f>.png (white geometry on black, hidden
// names removed), app_panel.jpg (the world panel open).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "../../qa/lib.mjs";

const [file, out, ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const frames = opt("--frames", "0").split(",").map(Number);
const hide = opt("--hide", "");
const fps = +opt("--fps", "24"), aspect = opt("--aspect", "16:9"), merge = opt("--merge", "0") === "1";
const port = +opt("--port", "9671");
const URL0 = process.env.SS_PAGE || "http://127.0.0.1:8771/local.html";
mkdirSync(out, { recursive: true });

const b = await launch({ port, w: 1440, h: 900, angle: process.env.SS_ANGLE || "metal" });
const js = (code) => b.ev(`const D = window.__demo, node = D?.node, stage = node?.ssStage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code}`);
try {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#three` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage")) break; } catch { /* loading */ } }
  await sleep(3000);
  const info = JSON.parse(await js(`
    stage.state.shot = { ...(stage.state.shot || {}), fps: ${fps} }; stage.setAspect(${JSON.stringify(aspect)});
    const THREE_B = (await import(new URL('extensions/soundstage/vendor/three.module.min.mjs', document.baseURI).href)).Box3; const t0 = performance.now();
    const blobOf = async (u) => URL.createObjectURL(await (await fetch(u + '#raw')).blob());
    const base = ${JSON.stringify(file)}.replace(/[^/]*$/, ''), files = {};
    for (const d of ${JSON.stringify(opt("--deps", ""))}.split(',').filter(Boolean)) files[d.split('/').pop()] = await blobOf(base + d);
    const name = ${JSON.stringify(file)}.split('/').pop();
    const inf = await stage.worldMount.importWorld(await blobOf(${JSON.stringify(file)}), { name, format: name.split('.').pop().toLowerCase(), files, temporary: true, merge: ${merge} });
    const ms = performance.now() - t0;
    if (!inf) { await sleep(3000); return JSON.stringify({ error: "no info", info: stage.worldMount.info, world: stage.state.world, prep: !!stage.worldMount.prep }); }
    const mats = new Map(); let textured = 0, meshes = 0, lights = 0, cams = 0;
    stage.worldMount.group.traverse((o) => { if (o.isLight) lights++; if (o.isCamera) cams++; if (!o.isMesh) return; meshes++;
      for (const m of [].concat(o.material)) if (m && !mats.has(m.uuid)) { mats.set(m.uuid, { name: m.name, type: m.type, map: !!m.map, normal: !!m.normalMap, color: m.color?.getHexString?.(), transparent: m.transparent, opacity: m.opacity }); } });
    const ext = []; { const bx = new THREE_B(); stage.worldMount.group.updateMatrixWorld(true); stage.worldMount.group.traverse((o) => { if (!o.isMesh) return; bx.setFromObject(o); ext.push([+bx.max.y.toFixed(2), +bx.min.y.toFixed(2), o.name, o.isSkinnedMesh ? 'skinned' : '']); }); }
    const highest = [...ext].sort((a, b) => b[0] - a[0]).slice(0, 5), lowest = [...ext].sort((a, b) => a[1] - b[1]).slice(0, 3);
    const shot = stage._shots().find((x) => x.id === stage.state.active_shot);
    const keys = shot?.camera_keys || [];
    const pick = (f) => keys.find((k) => k.frame === f) || keys[Math.min(keys.length - 1, f)];
    const w = stage.state.world;
    return JSON.stringify({ ms: Math.round(ms), readout: inf.readout, size: inf.size, units: inf.units, up: inf.up, reasons: inf.reasons, fixes: inf.fixes,
      meshes: inf.meshes, draws: inf.draws, tris: inf.tris, colliders: inf.colliders, colliderKinds: inf.colliderKinds, lights_in_file: inf.lights, animated: inf.animated, shots: inf.shots, animStart: inf.animStart, highest, lowest,
      xf: stage.worldMount.xf && { scale: stage.worldMount.xf.scale, lift: stage.worldMount.xf.lift, offset: stage.worldMount.xf.offset },
      world: { units: w.units, up: w.up, source: w.source }, active_shot: shot && { id: shot.id, name: shot.name, n_keys: keys.length, roll_deg_dropped: shot.roll_deg_dropped,
        keys: ${JSON.stringify(frames)}.map(pick) }, shot_frames: stage.state.shot.frames, fps: stage.state.shot.fps, fw: stage.fw, fh: stage.fh,
      materials: [...mats.values()], material_count: mats.size, textured: [...mats.values()].filter((m) => m.map).length, live_lights_under_world: lights, cameras_under_world: cams });`));
  writeFileSync(join(out, "ss_info.json"), JSON.stringify(info, null, 1));
  console.log(file, info.error ? "ERROR " + JSON.stringify(info).slice(0,600) : `${info.readout} | units ${info.units} (${info.reasons?.units}) up ${info.up} (${info.reasons?.up}) | shots ${JSON.stringify(info.shots)} | mats ${info.material_count} (${info.textured} textured) | ${info.ms} ms`);
  if (!info.error) {
    // The world panel, for the screenshot.
    await js("const btn = [...document.querySelectorAll('button')].find((x) => /^World:/.test(x.textContent)); btn?.click(); return 1");
    await sleep(1200);
    await b.shot(join(out, "app_panel.jpg"), { jpeg: { quality: 80 } });
    await js("const p = document.querySelector('.ss-worldpanel'); if (p) p.hidden = true; return 1");
    for (const f of frames) {
      for (const mode of ["clay", "color"]) {
        const d = await js(`const c = stage.renderFrameTo(${JSON.stringify(mode)}, ${f}); return c.toDataURL(${mode === "color" ? "'image/jpeg', 0.85" : "'image/png'"});`);
        writeFileSync(join(out, `ss_${mode}_${f}.${mode === "color" ? "jpg" : "png"}`), Buffer.from(d.split(",")[1], "base64"));
      }
      // Silhouette: the world only, the named shell hidden, white on black through the shot camera.
      const d = await js(`const THREE = await import(new URL('extensions/soundstage/vendor/three.module.min.mjs', document.baseURI).href);
        const re = ${JSON.stringify(hide)} ? new RegExp(${JSON.stringify(hide)}) : null, hidden = [], wg = stage.worldMount.group;
        const inWorld = (o) => { for (let a = o; a; a = a.parent) if (a === wg) return true; return false; };
        stage.setFrameSilent(${f});
        stage.scene.traverse((o) => { if (!o.visible) return; if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !inWorld(o)) { o.visible = false; hidden.push(o); }
          else if (re && inWorld(o) && o.name && re.test(o.name)) { o.visible = false; hidden.push(o); } });
        const keep = { bg: stage.scene.background, ov: stage.scene.overrideMaterial, fog: stage.scene.fog };
        stage.scene.background = new THREE.Color(0); stage.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }); stage.scene.fog = null;
        const r = stage.renderer, prev = new THREE.Vector2(); r.getSize(prev); r.setSize(stage.fw, stage.fh, false);
        const tm = r.toneMapping; r.toneMapping = THREE.NoToneMapping; r.setRenderTarget(null); r.render(stage.scene, stage.camera);
        const o2 = document.createElement('canvas'); o2.width = stage.fw; o2.height = stage.fh; o2.getContext('2d').drawImage(stage.canvas, 0, 0);
        r.toneMapping = tm; Object.assign(stage.scene, { background: keep.bg, overrideMaterial: keep.ov, fog: keep.fog }); for (const o of hidden) o.visible = true;
        r.setSize(prev.x, prev.y, false); stage.render();
        const im = o2.getContext('2d').getImageData(0, 0, o2.width, o2.height).data; let n = 0; for (let i = 0; i < im.length; i += 4) n += im[i] > 127;
        return JSON.stringify({ url: o2.toDataURL('image/png'), hidden: hidden.length, cover: n / (o2.width * o2.height), corner: [...im.slice(0, 4)] });`);
      const m = JSON.parse(d);
      writeFileSync(join(out, `ss_mask_${f}.png`), Buffer.from(m.url.split(",")[1], "base64"));
      console.log(`  frame ${f}: mask cover ${(m.cover * 100).toFixed(1)}%, ${m.hidden} nodes hidden, id-pass corner ${m.corner}`);
    }
  }
  const errs = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon|WebGL|GPU stall/i.test(l));
  if (errs.length) { console.log("console errors:", errs.slice(0, 5)); writeFileSync(join(out, "ss_console.txt"), errs.join("\n")); }
} finally { await b.close?.(); }
process.exit(0);
