// Make the try-it demo's generated scenes with the real App, in a hidden Chrome on a local build:
//   drycreek.json   the sample script with the western, chase and beach stages and their real renders (ScriptSync)
//   stunt.json      the red sports car's reverse J-turn on the night street, with the Milestone 13 renders
//   physics.json    a live-physics playground: a person, crates, light boxes, a table and a horse
//   <set>.json      the seven Milestone 11 sets, each set up by the App's own scene setup from a slugline
//
//   python3 tools/tryit/build_tryit.py --out <dir>/staging   (once, so the page and the base scenes exist)
//   cd <dir> && python3 -m http.server 8771 &
//   node tools/tryit/make_scenes.mjs http://127.0.0.1:8771/local.html   then build again to ship them
// Hand-made scenes (western, chase, car, ...) are not touched. The generated JSONs are committed in tools/tryit/scenes.
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../qa/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "scenes");
const URL0 = process.argv[2] || "http://127.0.0.1:8771/local.html";
const PORT = +(process.env.CDP_PORT || 9672);
const only = new Set((process.env.ONLY || "").split(",").filter(Boolean));
const base = (k) => JSON.parse(readFileSync(join(OUT, `${k}.json`), "utf8"));
const R = (filename) => ({ filename, subfolder: "", type: "output" });

const b = await launch({ port: PORT, w: 1440, h: 900 });
async function open(key) {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#${key}` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage")) break; } catch { /* loading */ } }
  await sleep(2500);
}
const ev = (code) => b.ev(`const D = window.__demo, node = D.node, stage = node.ssStage, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mod = (p) => import(new URL('./extensions/soundstage/' + p, document.baseURI).href); ${code}`);
const save = (key, data) => { writeFileSync(join(OUT, `${key}.json`), JSON.stringify(data)); console.log("wrote", key); };
const want = (k) => !only.size || only.has(k);

try {
  // ------------------------------------------------------------------ Dry Creek: the sample script + real dailies
  if (want("drycreek")) {
    const west = base("western"), chase = base("chase"), beach = base("romance");
    await open("blank");
    const out = await ev(`
      const { DEMO_SCRIPT } = await mod('script/demo_script.mjs');
      const { scopeShots } = await mod('script/scenes.mjs');
      const { loadScene } = await mod('agent/agent.mjs');
      const S = node.ssScript;
      S.panel._write(structuredClone(DEMO_SCRIPT), 'sample');
      await sleep(800);
      const parts = ${JSON.stringify([["sc_1", west], ["sc_3", beach], ["sc_2", chase]].map(([id, d]) => [id, d.scene, d.props]))};
      const renders = {}, chosen = {};
      for (const [sid, sceneStr, props] of parts) {
        const r = S.switchScene(sid, { setup: false });
        if (!r.ok) throw new Error('switch ' + sid + ' ' + r.why);
        await sleep(300);
        const j = JSON.parse(sceneStr);
        const map = scopeShots(j, sid, { all: true });
        for (const [k, v] of Object.entries(props.ss_renders || {})) renders[map[k] || k] = v;
        for (const [k, v] of Object.entries(props.ss_chosen?.chosen || {})) chosen[map[k] || k] = v;
        const cut = (props.ss_cut?.cut || []).map((e) => ({ ...e, shot_id: map[e.shot_id] || e.shot_id }));
        node.properties.ss_cut = { ...(props.ss_cut || {}), cut };
        loadScene(stage, j);
        stage.resetHistory?.();
        await sleep(600);
      }
      node.properties.ss_renders = renders;
      node.properties.ss_chosen = { chosen, touched: {} };
      S.persist();
      await sleep(300);
      return JSON.stringify({ scene: JSON.stringify(stage.toJSON()), props: node.properties });`);
    const o = JSON.parse(out);
    save("drycreek", { ...chase, workflow: "Soundstage_DryCreek", scene: o.scene,
      note: "Dry Creek: the sample script with its desert, main street and beach scenes staged and rendered. Open Takes or ScriptSync to see the real dailies on the lined script.",
      props: { ss_renders: o.props.ss_renders, ss_chosen: o.props.ss_chosen, ss_cut: o.props.ss_cut, ss_script: o.props.ss_script } });
  }

  // ------------------------------------------------------------------ the reverse J-turn (Milestone 13)
  if (want("stunt")) {
    const chase = base("chase");
    await open("chase");
    const out = await ev(`
      const j = stage.toJSON();
      const car = j.actors.find((a) => a.kind === 'sports_car');
      const keep = new Set([car.id, ...j.actors.filter((a) => a.mount?.host === car.id || a.ride === car.id || a.seat_of === car.id || a.carry_id === car.id).map((a) => a.id)]);
      for (const a of j.actors) if (a.kind === 'woman' || a.kind === 'man') { if (JSON.stringify(a).includes(car.id)) keep.add(a.id); }
      j.actors = j.actors.filter((a) => keep.has(a.id));
      j.shot = { ...j.shot, frames: 121, fps: 24 };
      j.shots = [{ id: 'jturn', name: 'Camera A · 100mm tripod', setup: 'wide', camera_keys: [{ frame: 0, position: [5, 1.2, 40], target: car.keys[0].position, focal_mm: 100 }] }];
      j.active_shot = 'jturn';
      stage.load(j);
      stage.applyStunt(car.id, 'reverse_jturn');
      // Camera A pans to follow: a target key every 12 frames on the car.
      const s2 = stage.toJSON();
      const c2 = s2.actors.find((a) => a.id === car.id);
      const at = (f) => { const ks = c2.keys; let k0 = ks[0], k1 = ks[ks.length - 1];
        for (let i = 0; i < ks.length - 1; i++) if (ks[i].frame <= f && ks[i + 1].frame >= f) { k0 = ks[i]; k1 = ks[i + 1]; break; }
        const t = k1.frame === k0.frame ? 0 : (f - k0.frame) / (k1.frame - k0.frame); return k0.position.map((v, i) => +(v + (k1.position[i] - v) * t).toFixed(2)); };
      const mid = at(60);
      const pos = [mid[0] + 5, 1.2, mid[2] + 26];
      s2.shots[0].camera_keys = [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120].map((f) => { const p = at(f); return { frame: f, position: pos, target: [p[0], 0.7, p[2]], focal_mm: 100 }; });
      s2.camera = { position: pos, target: s2.shots[0].camera_keys[0].target, focal_mm: 100 };
      stage.load(s2);
      return JSON.stringify(stage.toJSON());`);
    const scene = JSON.parse(out);
    save("stunt", { ...chase, workflow: "Soundstage_Stunt_JTurn", scene: JSON.stringify(scene),
      note: "Stunt: select the red sports car, then Stunt in its properties. The reverse J-turn replays the real FLUX 3 Klein frames, the LTX-2.5 draft and the final with sound.",
      props: { ss_renders: { jturn: { previz: R("m_stunt_previz.mp4"), look: R("m_stunt_look.jpg"), draft: R("m_stunt_draft.mp4"), final_sound: R("m_stunt_final_sound.mp4") } },
        ss_chosen: { chosen: {}, touched: {} }, ss_cut: { cut: [{ shot_id: "jturn", in: 0, out: 121 }] } },
      candidates: { jturn: ["m_stunt_seed_1.jpg", "m_stunt_seed_2.jpg", "m_stunt_seed_3.jpg", "m_stunt_seed_4.jpg"].map(R) },
      compile: undefined, advisor: undefined, cut: undefined, cutSeconds: undefined, cutOrder: ["jturn"] });
  }

  // ------------------------------------------------------------------ live physics playground (Milestones 9 + 10)
  if (want("physics")) {
    const west = base("western");
    const A = (id, name, kind, x, z, extra = {}) => ({ id, name, kind, keys: [{ frame: 0, position: [x, extra.y || 0, z] }], position: [x, extra.y || 0, z], ...extra });
    const actors = [
      A("sam", "Sam", "man", -2.0, -0.9, { height_m: 1.8, rotation_deg: 90 }),
      A("crate_a", "Crate A", "crate", 0.2, 1.6, { height_m: 0.8 }),
      A("crate_b", "Crate B", "crate", 1.2, 1.6, { height_m: 0.8 }),
      A("crate_c", "Crate C", "crate", 2.2, 1.6, { height_m: 0.8 }),
      A("table", "Table", "table", 3.4, -1.2, { height_m: 0.75 }),
      A("box_1", "Light box 1", "crate", -1.2, -0.8, { height_m: 0.4 }),
      A("box_2", "Light box 2", "crate", -0.4, -1.6, { height_m: 0.4 }),
      A("tower_1", "Carton 1", "crate", 0.9, -2.8, { height_m: 0.4 }),
      A("tower_2", "Carton 2", "crate", 0.9, -2.8, { height_m: 0.4, y: 0.4 }),
      A("tower_3", "Carton 3", "crate", 0.9, -2.8, { height_m: 0.4, y: 0.8 }),
      A("horse", "Horse", "horse", -4.6, 3.2, { height_m: 1.6, rotation_deg: 90 }),
    ];
    const cam = { position: [0.2, 3.6, -9.5], target: [0, 0.6, 0], focal_mm: 26 };
    const scene = { version: 2, shot: { frames: 121, fps: 24 }, environment: { set: "desert", weather: "none", density: 0.5, water_level: 2.5 },
      lighting: { mode: "time", hour: 15, day_of_year: 200, latitude: 34.05, north_deg: 0, overcast: false, preset: null, lights: [] },
      sun: { azimuth_deg: 225, elevation_deg: 40 }, actors, props: [],
      shots: [{ id: "wide", name: "Wide", setup: "wide", camera_keys: [{ frame: 0, ...cam }] }], active_shot: "wide", camera: cam };
    save("physics", { workflow: "Soundstage_LivePhysics", scene: JSON.stringify(scene), look: "",
      note: "Live physics: drag Sam onto a crate to climb it, over the horse to mount, into a light box and press C to pick it up. Shove crates into the carton tower. Runs on the CPU solver here; GPU (AVBD) where WebGPU exists.",
      props: { ss_cut: { cut: [{ shot_id: "wide", in: 0, out: 121 }] } }, widgets: {}, stillModels: west.stillModels, videoModels: west.videoModels });
  }

  // ------------------------------------------------------------------ the Milestone 11 sets, set up from sluglines
  const SETS = [
    ["underwater", "UNDERWATER - CORAL REEF - DAY", "", "Maya, a diver, swims slowly over the coral reef as light rays dance through the water.", ["MAYA"],
      { look: "m_underwater_look.jpg", draft: "m_underwater_draft.mp4", final_sound: "m_underwater_final.mp4" }, ["m_underwater_seed_a.jpg", "m_underwater_seed_b.jpg"]],
    ["fire", "BURNING BUILDING - NIGHT", "EXT", "Cole, a firefighter, walks past the burning building as embers drift through the smoke.", ["COLE"],
      { look: "m_fire_look.jpg", draft: "m_fire_draft.mp4" }, ["m_fire_seed_a.jpg", "m_fire_seed_b.jpg"]],
    ["airplane", "AIRPLANE CABIN - DAY", "INT", "Nora sits by the window of the airliner, clouds sliding past outside.", ["NORA"],
      { look: "m_airplane_look.jpg", draft: "m_airplane_draft.mp4" }, ["m_airplane_seed_a.jpg", "m_airplane_seed_b.jpg"]],
    ["train", "TRAIN - PASSENGER CAR - DAY", "INT", "Eli sits by the window of the train as the countryside streams by.", ["ELI"],
      { look: "m_train_look.jpg", draft: "m_train_draft.mp4", final_sound: "m_train_final.mp4" }, ["m_train_seed_a.jpg", "m_train_seed_b.jpg"]],
    ["platform", "TRAIN STATION - PLATFORM - MORNING", "EXT", "Ada waits on the platform as the train pulls in.", ["ADA"], null, []],
    ["runway", "AIRPORT RUNWAY - DAY", "EXT", "An airliner rolls down the runway and lifts off.", [], null, []],
    ["clouds", "ABOVE THE CLOUDS - DAY", "EXT", "The airliner cruises above a sea of clouds.", [], null, []],
  ];
  const west = base("western");
  for (const [key, loc, ie, action, cast, rend, cands] of SETS) {
    if (!want(key)) continue;
    await open("blank");
    const heading = `${ie ? ie + ". " : ""}${loc}`;
    const [location, time] = [loc.split(" - ").slice(0, -1).join(" - "), loc.split(" - ").pop()];
    const sc = { id: "sc_1", number: "1", heading, int_ext: ie, location, time, index: 1, eighths: 4, numbered: true, section: "",
      elements: [{ type: "action", text: action }], characters: cast, synopsis: action, outline: action,
      breakdown: { cast, extras: [], props: [], vehicles: [], animals: [], wardrobe: [] } };
    const script = { title: "New sets", author: "Soundstage demo", scenes: [sc],
      characters: cast.map((n) => ({ name: n, scenes: ["sc_1"], lines: 0, description: "" })) };
    const out = await ev(`
      const S = node.ssScript;
      S.panel._write(${JSON.stringify(script)}, 'sample');
      await sleep(800);
      const r = S.switchScene('sc_1');
      await sleep(1500);
      try { S.setUpScene(); } catch (e) { console.warn('setup', e); }
      await sleep(1500);
      S.persist();
      return JSON.stringify({ ok: r.ok, scene: JSON.stringify(stage.toJSON()), props: node.properties, shot: stage.activeShot().id, set: stage.toJSON().environment.set });`);
    const o = JSON.parse(out);
    console.log(key, o.set, o.shot);
    const props = { ss_script: o.props.ss_script, ss_cut: { cut: [{ shot_id: o.shot, in: 0, out: 97 }] }, ss_chosen: { chosen: {}, touched: {} } };
    if (rend) props.ss_renders = { [o.shot]: Object.fromEntries(Object.entries(rend).map(([k, f]) => [k, R(f)])) };
    save(key, { workflow: `Soundstage_Set_${key}`, scene: o.scene, look: "", props, widgets: {}, stillModels: west.stillModels, videoModels: west.videoModels,
      candidates: cands.length ? { [o.shot]: cands.map(R) } : undefined,
      note: `${heading}: set up by the App from the slugline (set, camera, blocking${cast.length ? ", cast" : ""}).${rend ? " Frame and Motion replay the real FLUX 3 Klein frame and LTX-2.5 renders of this set." : " Stage only: not rendered on the GPU for the demo."}` });
  }
} finally {
  console.log(b.logs.filter((l) => !/favicon/.test(l)).join("\n"));
  b.close();
}
