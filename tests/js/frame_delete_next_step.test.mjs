// node --test tests/js/frame_delete_next_step.test.mjs
// Three fixes from Mike using the App (2026-11-02):
//  A. ④ Frame: every frame has a Delete (trash) and the list a Clear all, with Undo for 5 s; the shot's chosen frame
//     is only deleted after a question in the page (never confirm()). Reject stays: it keeps a record Delete doesn't.
//  B. ③ Set: "④ Make the first frame →" (or Remake) goes to ④ Frame and paints from the clay as it is now.
//  C. The try-it demo: a Run / Generate on an edited stage says the replay is recorded, and every frame is labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (...p) => readFileSync(join(ROOT, ...p), "utf8");

// ------------------------------------------------------------------ a small DOM, enough for the pipeline's h()
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.parentNode = null; this.style = {};
    this.dataset = {}; this.hidden = false; this._text = ""; this.listeners = {}; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; if (k === "class") this.className = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ stopPropagation() {}, preventDefault() {}, currentTarget: this, ...ev }); }
  click() { if (this.onclick) this.onclick({ stopPropagation() {} }); this.dispatch("click"); }
  append(...k) { for (const c of k) { const n = typeof c === "string" ? Object.assign(new El("#text"), { _text: c }) : c; if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((x) => x !== n); n.parentNode = this; this.children.push(n); } }
  replaceChildren(...k) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...k); }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { return true; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(v) { this._text = ""; }
  focus() {}
  getClientRects() { return this.hidden ? [] : [1]; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  find(fn) { return this.all().find(fn); }
}
globalThis.document ||= { createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), getElementById: () => null, head: { append() {} },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };

const { Pipeline, setNextLabel, withoutFrames, FRAME_UNDO_MS } = await import("../../web/pipeline/pipeline.mjs");
const { rejectTip } = await import("../../web/dailies/approval.mjs");

/** A pipeline with only what ④ Frame's list, Delete and the ③ Set button touch. */
function fakePipe({ chosen = null, look = null } = {}) {
  const p = Object.create(Pipeline.prototype);
  const calls = { forget: [], remember: [], go: [], gen: [], set: [], saved: 0, openCanvas: 0 };
  const renders = { s1: look ? { look } : {} };
  p.ctx = {
    stage: { activeShot: () => ({ id: "s1", name: "Shot 1" }) },
    getRenders: (sid) => renders[sid] || {},
    forgetRender: (sid, kind) => { calls.forget.push([sid, kind]); const was = renders[sid]?.look ? { filename: "look.png", subfolder: "", type: "output" } : null; delete renders[sid].look; return was; },
    rememberRender: (sid, kind, f) => { calls.remember.push([sid, kind, f]); renders[sid].look = `/view?filename=${f.filename}`; },
    saveChosen: () => { calls.saved++; },
    openCanvas: () => { calls.openCanvas++; },
    ladder: { setSource() {}, clearSource() {}, draw() {} },
  };
  p.views = { frame: new El("section") };
  p.views.frame.hidden = false;
  p.candidates = { s1: [{ url: "a.png", seed: 1 }, { url: "b.png", seed: 2 }, { url: "c.png", seed: 3 }] };
  p.chosen = chosen ? { s1: chosen } : {};
  p.touched = {};
  p._autoPick = {};
  p.inflight = new Map();
  p.shotRows = [];
  p.current = "frame";
  p.btns = {};
  p.f = { grid: new El("div"), status: new El("div"), useTouch: { checked: false } };
  p.f.clearAll = new El("button"); p.f.ask = new El("div"); p.f.ask.hidden = true;
  p.f.candBar = new El("div"); p.f.candBar.append(p.f.ask, p.f.clearAll);
  p.set = (id, name, v) => { calls.set.push([id, name, v]); return true; };
  p.mark = () => {};
  p._drawShotRows = () => {};
  p.go = (k) => { calls.go.push(k); p.current = k; };
  p.generateFrames = async (all) => { calls.gen.push(all); };
  return { p, calls, renders };
}
const urls = (p) => (p.candidates.s1 || []).map((c) => c.url);
const toast = (p) => p._toast;
const askButtons = (p) => p.f.ask.children.filter((c) => c.tagName === "BUTTON");

// ------------------------------------------------------------------ A. Delete, Clear all, Undo
test("withoutFrames drops exactly the frames asked for", () => {
  const list = [{ url: "a" }, { url: "b" }, { url: "c" }];
  assert.deepEqual(withoutFrames(list, ["b"]).map((c) => c.url), ["a", "c"]);
  assert.deepEqual(withoutFrames(list, new Set(["a", "c"])).map((c) => c.url), ["b"]);
  assert.deepEqual(withoutFrames(null, ["a"]), []);
  assert.equal(FRAME_UNDO_MS, 5000);
});

test("every candidate tile has a trash button, and Clear all shows once there are frames", () => {
  const { p } = fakePipe({ chosen: { url: "b.png" } });
  p._drawCandidates();
  const tiles = p.f.grid.children;
  assert.equal(tiles.length, 3);
  for (const t of tiles) assert.ok(t.find((e) => e.className === "ss-cdel"), "a trash on every tile");
  assert.match(tiles[1].find((e) => e.className === "ss-cdel").attrs.title, /chosen frame, so you are asked first/);
  assert.match(tiles[0].find((e) => e.className === "ss-cdel").attrs.title, /Reject .* keeps it on record/);
  assert.equal(p.f.clearAll.hidden, false);
  p.candidates.s1 = [];
  p._drawCandidates();
  assert.equal(p.f.clearAll.hidden, true);
});

test("Delete on a frame that is not chosen takes it off at once, with a 5 s Undo that brings it back", async () => {
  const had = globalThis.confirm;
  globalThis.confirm = () => { throw new Error("no browser dialogs"); };
  try {
    const { p } = fakePipe({ chosen: { url: "b.png" } });
    assert.equal(p.deleteCandidate(p.candidates.s1[0]), true);
    assert.deepEqual(urls(p), ["b.png", "c.png"]);
    assert.equal(toast(p).el.hidden, false);
    assert.match(toast(p).tx.textContent, /Deleted 1 frame/);
    assert.equal(toast(p).el.parentNode, p.views.frame, "the toast lives in the step (the step screens hide the rest)");
    toast(p).un.onclick();
    assert.deepEqual(urls(p), ["a.png", "b.png", "c.png"]);
    assert.equal(toast(p).el.hidden, true);
    assert.equal(p.chosen.s1.url, "b.png");
    clearTimeout(toast(p).timer);
  } finally { globalThis.confirm = had; }
});

test("the Undo toast goes by itself after 5 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { p } = fakePipe();
  p.deleteCandidate(p.candidates.s1[2]);
  assert.equal(toast(p).el.hidden, false);
  t.mock.timers.tick(4999);
  assert.equal(toast(p).el.hidden, false);
  t.mock.timers.tick(2);
  assert.equal(toast(p).el.hidden, true);
});

test("the chosen frame is never deleted without an answer in the page; Delete it removes it and its saved render, Undo puts both back", () => {
  const had = globalThis.confirm;
  globalThis.confirm = () => { throw new Error("no browser dialogs"); };
  try {
    const { p, calls, renders } = fakePipe({ chosen: { url: "b.png", seed: 2 }, look: "b.png" });
    assert.equal(p.deleteCandidate(p.candidates.s1[1]), false);
    assert.deepEqual(urls(p), ["a.png", "b.png", "c.png"], "nothing goes before the answer");
    assert.equal(p.f.ask.hidden, false);
    assert.match(p.f.ask.textContent, /chosen frame/);
    // Keep it: nothing changes
    askButtons(p).find((b) => /Keep it/.test(b.textContent)).dispatch("click");
    assert.equal(p.f.ask.hidden, true);
    assert.deepEqual(urls(p), ["a.png", "b.png", "c.png"]);
    // Delete it
    p.deleteCandidate(p.candidates.s1[1]);
    askButtons(p).find((b) => /Delete it/.test(b.textContent)).dispatch("click");
    assert.deepEqual(urls(p), ["a.png", "c.png"]);
    assert.equal(p.chosen.s1, undefined);
    assert.deepEqual(calls.forget, [["s1", "look"]]);
    assert.equal(renders.s1.look, undefined);
    assert.match(toast(p).tx.textContent, /the chosen one too/);
    toast(p).un.onclick();
    assert.deepEqual(urls(p), ["a.png", "b.png", "c.png"]);
    assert.equal(p.chosen.s1.url, "b.png");
    assert.equal(calls.remember.at(-1)[2].filename, "look.png");
    clearTimeout(toast(p).timer);
  } finally { globalThis.confirm = had; }
});

test("Clear all asks when the chosen frame is in the list, and can keep just that one", () => {
  const { p } = fakePipe({ chosen: { url: "c.png" } });
  assert.equal(p.clearCandidates(), false);
  assert.equal(urls(p).length, 3);
  const keep = askButtons(p).find((b) => /Keep the chosen one, clear 2/.test(b.textContent));
  assert.ok(keep, "a Keep-the-chosen-one choice");
  keep.dispatch("click");
  assert.deepEqual(urls(p), ["c.png"]);
  assert.equal(p.chosen.s1.url, "c.png");
  clearTimeout(toast(p).timer);
  // Clear all, confirmed
  const q = fakePipe({ chosen: { url: "c.png" } }).p;
  q.clearCandidates();
  askButtons(q).find((b) => b.textContent === "Clear all").dispatch("click");
  assert.deepEqual(urls(q), []);
  assert.equal(q.chosen.s1, undefined);
  clearTimeout(toast(q).timer);
});

test("Delete takes off that one tile even when the same file shows twice (the demo replays its frames in a loop)", () => {
  const { p } = fakePipe({ chosen: { url: "b.png" } });
  p.candidates.s1.push({ url: "b.png", seed: 2 });
  assert.equal(p.deleteCandidate(p.candidates.s1[3]), true, "a twin of the chosen frame goes without a question");
  assert.deepEqual(urls(p), ["a.png", "b.png", "c.png"]);
  assert.equal(p.chosen.s1.url, "b.png", "the other tile is still the chosen frame");
  clearTimeout(toast(p).timer);
});

test("Clear all without a chosen frame among them clears at once, with Undo", () => {
  const { p } = fakePipe();
  assert.equal(p.clearCandidates(), true);
  assert.deepEqual(urls(p), []);
  assert.match(toast(p).tx.textContent, /Deleted 3 frames/);
  toast(p).un.onclick();
  assert.equal(urls(p).length, 3);
  clearTimeout(toast(p).timer);
});

test("no browser confirm() anywhere in ④ Frame's delete code", () => {
  const s = src("web", "pipeline", "pipeline.mjs");
  const del = s.slice(s.indexOf("_drawCandBar() {"), s.indexOf("_hideToast() {"));
  assert.ok(del.length > 1000);
  assert.doesNotMatch(del, /\bconfirm\(|\balert\(|\bprompt\(/);
});

test("Reject stays and says what it keeps that Delete doesn't", () => {
  const f = rejectTip("frame"), m = rejectTip("motion");
  for (const t of [f, m]) {
    assert.match(t, /keep this take on record as rejected/);
    assert.match(t, /Takes shows it dimmed and can filter it/);
    assert.match(t, /does not change the next generation/);
  }
  assert.match(f, /trash on its tile/);
  assert.match(src("web", "dailies", "approval.mjs"), /choice\("rejected", "✕", "Reject", rejectTip\(step\)\)/);
  // The record Reject keeps is real: the bin dims it, the status filter has it, the Director's cut skips it.
  assert.match(src("web", "dailies", "bin.mjs"), /data-status=rejected/);
  assert.match(src("web", "agent", "director.mjs"), /!inCut\.has\(id\) && !rejected\(id\)/);
});

// ------------------------------------------------------------------ B. ③ Set → ④ Frame
test("the ③ Set button reads Make, or Remake when the shot has a frame", () => {
  assert.equal(setNextLabel(false), "④ Make the first frame");
  assert.equal(setNextLabel(true), "④ Remake the first frame");
  const a = fakePipe().p;
  const b = a.setNextButton();
  assert.equal(b.textContent, "④ Make the first frame →");
  assert.match(b.attrs.class, /\bgo next\b/, "the same style as ⑤ Animate this frame →");
  a.chosen.s1 = { url: "a.png" };
  a._drawSetNext();
  assert.equal(b.textContent, "④ Remake the first frame →");
  const c = fakePipe({ look: "saved.png" }).p;   // a saved frame from an earlier session counts too
  assert.equal(c.setNextButton().textContent, "④ Remake the first frame →");
});

test("Make the first frame goes to ④ Frame and generates for this shot, never Paint Studio", async () => {
  const { p, calls } = fakePipe();
  p.candidates = {};
  await p.makeFirstFrame();
  assert.deepEqual(calls.go, ["frame"]);
  assert.deepEqual(calls.gen, [false], "one Generate, this shot only");
  assert.equal(calls.openCanvas, 0);
  assert.ok(!src("web", "pipeline", "pipeline.mjs").slice(src("web", "pipeline", "pipeline.mjs").indexOf("async makeFirstFrame()"), src("web", "pipeline", "pipeline.mjs").indexOf("// ------------------------------------------------------------------ ④ Frame")).includes("_openEditor"));
});

test("Remake keeps the old frame as a candidate (also after a reload, when the list starts empty)", async () => {
  const { p, calls } = fakePipe({ chosen: { url: "old.png", seed: 9, model: "FLUX 3 Klein · local" } });
  p.candidates = {};
  await p.makeFirstFrame();
  assert.deepEqual(urls(p), ["old.png"]);
  assert.equal(p.candidates.s1[0].seed, 9, "it keeps its seed and model, so picking it again reproduces it");
  assert.equal(p.chosen.s1.url, "old.png", "still the pick until you choose a new one");
  assert.deepEqual(calls.gen, [false]);
  // a saved look render with no chosen record
  const q = fakePipe({ look: "saved.png" });
  q.p.candidates = {};
  await q.p.makeFirstFrame();
  assert.deepEqual(urls(q.p), ["saved.png"]);
  // already in the list: not added twice
  const r = fakePipe({ chosen: { url: "b.png" } });
  await r.p.makeFirstFrame();
  assert.deepEqual(urls(r.p), ["a.png", "b.png", "c.png"]);
});

test("a shot whose frames are already painting is not queued twice", async () => {
  const { p, calls } = fakePipe();
  p.inflight.set("pid", { sid: "s1", step: 2 });
  await p.makeFirstFrame();
  assert.deepEqual(calls.go, ["frame"]);
  assert.deepEqual(calls.gen, []);
  assert.match(p.f.status.textContent, /already painting/);
});

test("the App puts the button on ③ Set's time bar, styled like the other next steps", () => {
  const app = src("web", "soundstage.js");
  assert.match(app, /time\.append\(pipeline\.setNextButton\(\)\)/);
  assert.match(app, /forgetRender: \(sid, kind\) => forgetRender\(sid, kind\)/);
  assert.match(src("web", "ui", "theme.mjs"), /\.ss-stage :is\(\.ss-pipeview, \.ss-time\) button\.go\.next \{/);
});

// ------------------------------------------------------------------ C. the try-it demo says when your edits are not re-rendered
const prov = await import("../../tools/tryit/shell/provenance.mjs");
const scene = () => ({ actors: [{ id: "car", kind: "sports_car", keys: [{ frame: 0, position: [0, 0, 0] }] }], shots: [{ id: "s1", camera: { focal_mm: 35 } }],
  environment: { set: "street_night" }, lighting: { preset: "noir" }, camera: { focal_mm: 35 }, selected: null, frame: 0 });

test("the stage fingerprint follows what a render is made from, not the playhead or the selection", () => {
  const a = scene();
  const base = prov.rememberBaseline({}, a);
  assert.equal(prov.editedSince(base, { ...scene(), frame: 40, selected: "car" }), false, "scrubbing and selecting are not edits");
  assert.equal(prov.editedSince(base, { ...scene(), camera: { focal_mm: 35.000001 } }), false, "float noise is not an edit");
  assert.equal(prov.editedSince(base, { ...scene(), camera: { focal_mm: 50 } }), true, "a lens change is");
  const moved = scene(); moved.actors[0].keys[0].position = [2, 0, 0];
  assert.equal(prov.editedSince(base, moved), true, "moving the car is");
  const added = scene(); added.actors.push({ id: "man", kind: "man" });
  assert.equal(prov.editedSince(base, added), true, "adding someone is");
  const shot2 = scene(); shot2.shots.push({ id: "s2" });
  assert.equal(prov.editedSince(base, shot2), true, "adding a setup is");
  assert.equal(prov.editedSince({}, a), false, "no baseline yet, no claim");
});

test("each script scene keeps its own baseline, and a forced one resets it", () => {
  const sc1 = { ...scene(), shots: [{ id: "a", scene_id: "sc1" }] }, sc2 = { ...scene(), shots: [{ id: "b", scene_id: "sc2" }] };
  const base = {};
  prov.rememberBaseline(base, sc1);
  prov.rememberBaseline(base, sc2);
  assert.equal(prov.editedSince(base, sc2), false, "switching to another scene of the script is not an edit");
  const edited = { ...sc1, camera: { focal_mm: 90 } };
  prov.rememberBaseline(base, edited);   // a later lazy call does not overwrite
  assert.equal(prov.editedSince(base, edited), true);
  prov.rememberBaseline(base, edited, true);   // a tour stop's own setup
  assert.equal(prov.editedSince(base, edited), false);
});

test("the note: exact words, the install link, only for ④ Frame and ⑤ Motion replays of an edited stage", () => {
  assert.equal(prov.replayNotice({ step: 2, edited: false }), null);
  const n = prov.replayNotice({ step: 2, edited: true });
  assert.equal(n.note, "This demo replays recorded renders, so your edits don't re-render here. With the full install, ④ makes new frames from your edited set.");
  assert.equal(n.link, "https://github.com/theboord/ComfyUI-Soundstage#install");
  assert.equal(n.mode, prov.REPLAYED);
  assert.equal(n.where, "④ Frame");
  assert.equal(prov.replayNotice({ step: 3, edited: true }).where, "⑤ Motion");
  assert.equal(prov.replayNotice({ step: 4, edited: true }).where, "⑤ Motion");
  assert.equal(prov.replayNotice({ step: 5, edited: true }), null, "⑦'s Layer Pack keeps its own note");
  assert.equal(prov.RECORDED_LABEL, "Recorded example");
  assert.match(src("README.md"), /^## Install$/m, "the README section the link points at");
});

test("the shell wires it: the replay asks first, the note reuses the Replayed badge, every frame tile is labelled", () => {
  const api = src("tools", "tryit", "shell", "scripts", "api.js");
  const demo = src("tools", "tryit", "shell", "demo.mjs");
  assert.match(api, /function replay\(id, shot, step\) \{\n[^\n]*\n\s*try \{ demo\.onReplay\?\.\(\{ shot, step \}\); \}/, "replay() tells the shell before it plays anything back");
  assert.match(demo, /demo\.onReplay = \(\{ step \}\) => \{\n\s*const n = replayNotice\(\{ step, edited: edited\(\) \}\);/);
  assert.match(demo, /editNote\.replaceChildren\(provBadge\(\{ mode: REPLAYED, note: n\.note \}\)/, "the note leads with the same Replayed badge as the bar");
  assert.match(demo, /b\.textContent = `\$\{GLYPH\[REPLAYED\]\} \$\{RECORDED_LABEL\}`/);
  assert.match(demo, /baseline\(true\);\s+\/\/ what a stop sets up/, "a tour stop's own changes are not the visitor's edit");
  assert.match(src("tools", "tryit", "shell", "index.html"), /\.demo-editnote \{/);
});
