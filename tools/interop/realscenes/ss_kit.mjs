// Export a try-it scene's active shot as the DCC kit (the App's own exportForDCC) and render the Soundstage side:
// clay frames and silhouettes (id pass, stage floor hidden).
//   node ss_kit.mjs <scene key> <outdir> [--frames 0,48,96] [--port 9680]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "../../qa/lib.mjs";
const [key, out, ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const frames = opt("--frames", "0,48,96").split(",").map(Number);
const URL0 = process.env.SS_PAGE || "http://127.0.0.1:8771/local.html";
mkdirSync(out, { recursive: true });
const b = await launch({ port: +opt("--port", "9680"), w: 1440, h: 900, angle: process.env.SS_ANGLE || "metal" });
const js = (code) => b.ev(`const D = window.__demo, node = D?.node, stage = node?.ssStage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code}`);
try {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#${key}` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage")) break; } catch { /* loading */ } }
  await sleep(4000);
  const kit = JSON.parse(await js(`const X = await import(new URL('extensions/soundstage/stage/interop/exportdcc.mjs', document.baseURI).href);
    const k = await X.exportForDCC(stage);
    let s = ''; const u = k.zip; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return JSON.stringify({ name: k.name, report: k.report, b64: btoa(s), shot: stage.activeShot?.()?.name, frames: stage.state.shot?.frames, fps: stage.state.shot?.fps, fw: stage.fw, fh: stage.fh,
      world: stage.state.world?.name || null, set: stage.state.environment?.set, actors: (stage.state.actors || []).map((a) => a.kind) });`));
  writeFileSync(join(out, kit.name), Buffer.from(kit.b64, "base64"));
  delete kit.b64;
  writeFileSync(join(out, "ss_kit_info.json"), JSON.stringify(kit, null, 1));
  console.log(JSON.stringify(kit));
  for (const f of frames) {
    const d = await js(`const c = stage.renderFrameTo('clay', ${f}); return c.toDataURL('image/png');`);
    writeFileSync(join(out, `ss_clay_${f}.png`), Buffer.from(d.split(",")[1], "base64"));
    const m = JSON.parse(await js(`const THREE = await import(new URL('extensions/soundstage/vendor/three.module.min.mjs', document.baseURI).href);
      const root = stage.root, handles = new Set(stage.lightHandles?.values() || []), hidden = [];
      const under = (o, r) => { for (let a = o; a; a = a.parent) if (a === r) return true; return false; };
      const skip = (o) => o === stage.ground || o === stage.selRing || handles.has(o) || o === stage.weather?.object || o.userData.splatOnly || o.userData.secondaryFx || o.userData.worldSky || o.isPoints || o.isSprite || o.isLine;
      stage.setFrameSilent(${f});
      stage.scene.traverse((o) => { if (!o.visible) return; if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && !under(o, root)) { o.visible = false; hidden.push(o); } else if (o !== root && under(o, root) && skip(o)) { o.visible = false; hidden.push(o); } });
      const keep = { bg: stage.scene.background, ov: stage.scene.overrideMaterial, fog: stage.scene.fog };
      stage.scene.background = new THREE.Color(0); stage.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }); stage.scene.fog = null;
      const r = stage.renderer, prev = new THREE.Vector2(); r.getSize(prev); r.setSize(stage.fw, stage.fh, false);
      const tm = r.toneMapping; r.toneMapping = THREE.NoToneMapping; r.setRenderTarget(null); r.render(stage.scene, stage.camera);
      const o2 = document.createElement('canvas'); o2.width = stage.fw; o2.height = stage.fh; o2.getContext('2d').drawImage(stage.canvas, 0, 0);
      r.toneMapping = tm; Object.assign(stage.scene, { background: keep.bg, overrideMaterial: keep.ov, fog: keep.fog }); for (const o of hidden) o.visible = true;
      r.setSize(prev.x, prev.y, false); stage.render();
      const im = o2.getContext('2d').getImageData(0, 0, o2.width, o2.height).data; let n = 0; for (let i = 0; i < im.length; i += 4) n += im[i] > 127;
      return JSON.stringify({ url: o2.toDataURL('image/png'), cover: n / (o2.width * o2.height) });`));
    writeFileSync(join(out, `ss_mask_${f}.png`), Buffer.from(m.url.split(",")[1], "base64"));
    console.log(`frame ${f}: silhouette cover ${(m.cover * 100).toFixed(1)}%`);
  }
  const errs = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon|WebGL|GPU stall/i.test(l));
  if (errs.length) console.log("console errors:", errs.slice(0, 5));
} finally { b.close(); }
process.exit(0);
