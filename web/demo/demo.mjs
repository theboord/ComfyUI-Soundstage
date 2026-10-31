// Soundstage App, static demo: the real App widget (extensions/soundstage/soundstage.js) on a stand-in ComfyUI.
import "./scripts/glbshim.mjs";   // .mjs: ComfyUI loads every .js under web/ as an extension, and this shim must never patch fetch there
import { app } from "./scripts/app.js";
import { api, demo } from "./scripts/api.js";
import "./extensions/soundstage/soundstage.js";

const $ = (id) => document.getElementById(id);
const SCENES = [
  { key: "western", label: "Western: riders at sunset" },
  { key: "chase", label: "Car chase" },
  { key: "car", label: "In the car" },
  { key: "three", label: "Three in a car" },
  { key: "aliens", label: "Sci-fi: Alien invasion" },
  { key: "horror", label: "Horror: Haunted woods" },
  { key: "romance", label: "Romance: Beach at sunset" },
  { key: "kaiju", label: "Monster: Kaiju attack" },
  { key: "torch", label: "Flashlight search" },
];
const key = SCENES.some((s) => s.key === location.hash.slice(1)) ? location.hash.slice(1) : "western";

// Scene tabs (a full reload per scene, like opening another workflow).
for (const s of SCENES) {
  const a = Object.assign(document.createElement("a"), { href: `#${s.key}`, textContent: s.label });
  if (s.key === key) a.setAttribute("aria-current", "page");
  $("tabs").append(a);
}
addEventListener("hashchange", () => location.reload());

let toastT = 0;
demo.toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 5200);
};

const data = await (await fetch(new URL(`./r/scenes/${key}.json`, import.meta.url))).json();
const vocab = await fetch(new URL("./r/canned/advisor_vocab.json", import.meta.url)).then((r) => r.json()).catch(() => ({}));
demo.scene = { key, compile: data.compile, advisor: data.advisor, vocab, cut: data.cut, cutSeconds: data.cutSeconds,
  renders: JSON.parse(JSON.stringify(data.props?.ss_renders || {})) };   // frozen: what the GPU actually made

// The App graph: the stage node plus the nodes it reads and the rung outputs it listens to.
const { Node, Widget } = app;
const W = (name, value, options) => new Widget(name, value, options);
const g = app.graph;
const v = data.widgets || {};
const stageNode = g.add(new Node(9045, "SoundstageStage", "stage"));
stageNode.properties = JSON.parse(JSON.stringify(data.props || {}));
g.add(new Node(9056, "KSampler", "Look still (Krea 2, depth-steered)", [W("seed", v.seed ?? 205204803), W("steps", 8), W("cfg", 1), W("denoise", v.denoise ?? 0.85)]));
g.add(new Node(9081, "SoundstageEditImage", "Still model (any)", [W("model", v.still_model || data.stillModels?.[1] || "", { values: data.stillModels || [] }), W("seed", 0), W("lora", "None", { values: ["None", "your_character.safetensors", "your_house_style.safetensors"] }), W("lora_strength", 1), W("steps", 0), W("cfg", 0), W("negative", ""), W("ref_files", "")]));
g.add(new Node(5516, "Sampler", "Sampler - Distilled (8 steps)", [W("cfg", 1), W("sampler_name", "euler_ancestral")]));
g.add(new Node(9034, "Sampler", "Upscale and re-sampler (3 steps)", [W("cfg", 1), W("sampler_name", "euler_ancestral")]));
g.add(new Node(5509, "PrimitiveStringMultiline", "Prompt (negative)", [W("value", "")]));
g.add(new Node(9082, "ComfySwitchNode", "Still model · use picker", [W("switch", false)]));
g.add(new Node(9083, "SoundstageGenerateVideo", "Video model (any)", [W("model", data.videoModels?.[0] || "", { values: data.videoModels || [] }), W("seed", 0)]));
g.add(new Node(9084, "ComfySwitchNode", "Video model · use picker", [W("switch", false)]));
g.add(new Node(9086, "ComfySwitchNode", "Use touched-up still", [W("switch", false)]));
g.add(new Node(9087, "SoundstageShotSound", "Sound · line, SFX, music", ["line", "character", "voice", "dialogue_engine", "sfx_prompt", "music_mood"]
  .map((n) => W(n, (v.sound || {})[n] ?? ""))));
g.add(new Node(9092, "SoundstageWhen", "Audio drives the video", [W("enabled", false)]));
g.add(new Node(9096, "SoundstageQuality", "Quality · motion freedom", [W("motion_freedom", v.motion_freedom ?? 0.5), W("quality", "Draft")]));
const stepNode = g.add(new Node(9059, "SoundstageStep", "NEXT ▸ (1 Stage · 2 Look · 3 Draft · 4 Final · 5 Layers)", [W("step", 1)]));
g.add(new Node(9079, "SoundstageLook", "Look (Look tab → prompts)", [W("look", data.look || "")]));
for (const [id, title] of [[9099, "Rung 1 · Previz video"], [9060, "Rung 1 · Stage frame 1"], [9058, "Rung 2 · Look still"],
  [9063, "Rung 3 · Motion draft"], [4852, "Rung 4 · Final"], [9090, "Rung 4 · Final + sound"], [9094, "Rung 4 · Final · audio-driven"],
  [9077, "Rung 5 · Layer Pack"], [9078, "Rung 5 · Layers preview"], [9097, "Rung 5 · Layer Pack folder"]]) g.add(new Node(id, "Output", title));
app.extensionManager.workflow.activeWorkflow.path = `workflows/${data.workflow || key}.json`;

const ext = app.extensions.find((e) => e.name === "soundstage.stage");
ext.getCustomWidgets().SOUNDSTAGE_STAGE(stageNode, "stage");
$("host").append(stageNode.domWidget.element);
stageNode.domWidget.value = data.scene;      // like ComfyUI restoring the workflow's widget value

demo.getShot = () => stageNode.ssStage?.activeShot().id;
demo.getStep = () => stepNode.widgets[0].value;

// App mode's Run button: queue at the current rung, then climb one (the Step node's "increment").
$("run").addEventListener("click", async () => {
  const w = stepNode.widgets[0];
  await app.queuePrompt(0, 1);
  w.value = Math.min(5, (+w.value || 1) + 1);
  $("runStep").textContent = `next: step ${w.value}`;
});
$("runStep").textContent = "next: step 1";

// The Advisor starts from the scene's own description (a new visitor hasn't typed one yet).
try {
  const desc = JSON.parse(data.look || "{}").description;
  const ta = document.querySelector(".ss-advisorview textarea");
  if (desc && ta && !ta.value) { ta.value = desc; ta.dispatchEvent(new Event("input", { bubbles: true })); }
} catch { /* no look */ }
$("sceneNote").textContent = data.note || "";
