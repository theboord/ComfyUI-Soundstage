// node --test tests/js/hosthooks.test.mjs
// Hooks the App shell hands to the Director / Ask host for Ask's undo and quality tools (web/hosthooks.mjs, wired in
// web/soundstage.js), and the Director's Book forgetDecision(id):
//   host.cutSig   a function returning the Cut's current signature (changes on every Cut edit, back on its Undo)
//   host.quality  {get(), set(values), clear(keys)} for ⑤ Motion's quality settings, on the Motion panel's own state
//   book.forgetDecision(id)  removes a decision note and saves the book to the server at once, returning {ok}
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- a tiny DOM (the Book view and the Motion panel)
class ClassList {
  constructor(el) { this.el = el; }
  get _l() { return (this.el.className || "").split(/\s+/).filter(Boolean); }
  contains(c) { return this._l.includes(c); }
  add(...c) { this.el.className = [...new Set([...this._l, ...c])].join(" "); }
  remove(...c) { this.el.className = this._l.filter((x) => !c.includes(x)).join(" "); }
  toggle(c, on) { if (on ?? !this.contains(c)) this.add(c); else this.remove(c); }
}
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.style = {};
    this.className = ""; this.classList = new ClassList(this); this._ev = {}; this._text = ""; this.value = ""; this.hidden = false; this.options = [];
    this.nodeType = tag === "#text" ? 3 : 1;
  }
  get parentNode() { return this.parent; }
  get textContent() { return this.tagName === "#TEXT" ? this._text : this.children.map((c) => c.textContent).join(""); }
  set textContent(t) { this.children = []; if (t) this.append(String(t)); }
  set innerHTML(_) { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); if (k === "hidden") this.hidden = true; if (k === "value") this.value = String(v); if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) { const n = k instanceof El ? k : doc.createTextNode(String(k)); n.parent = this; this.children.push(n); } }
  prepend(...kids) { this.append(...kids); }
  insertBefore(n) { this.append(n); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains() { return false; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener(t, f) { (this._ev[t] ||= []).push(f); }
  removeEventListener() {}
  dispatchEvent(e) { for (const f of this._ev[e.type] || []) f(e); return true; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}
const doc = {
  createElement: (t) => new El(t), createElementNS: (_, t) => new El(t),
  createTextNode: (t) => { const n = new El("#text"); n._text = String(t); return n; },
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
};
doc.head = new El("head"); doc.body = new El("body");
globalThis.document ||= doc;
globalThis.window ||= { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 };
globalThis.Node ||= El;
globalThis.Option ||= class extends El { constructor(text, value) { super("option"); this.text = text; this.value = value; } };

const { cutSigOf, cutSignature, qualityHook, hashText } = await import("../../web/hosthooks.mjs");
const { CutPanel } = await import("../../web/cut/cut.mjs");
const { LtxAdvanced } = await import("../../web/motion/ltxadvanced.mjs");
const { Pipeline } = await import("../../web/pipeline/pipeline.mjs");
const { mountBook } = await import("../../web/book/book.mjs");

const SRC = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
const section = (start, end) => { const a = SRC.indexOf(start); return SRC.slice(a, SRC.indexOf(end, a)); };

// ---------------------------------------------------------------- the wiring in web/soundstage.js
test("soundstage.js hands the Director host cutSig and quality, and Ask the same quality hook", () => {
  assert.match(SRC, /import \{ cutSigOf, qualityHook, smoothAgentShots \} from "\.\/hosthooks\.mjs"/);
  assert.match(SRC, /const agent = new SceneAgent\([\s\S]{0,300}?\}\);\n  smoothAgentShots\(agent, stage\);/, "the scene agent's shots go onto the smooth curve");
  assert.match(SRC, /const qualityHost = qualityHook\(\(\) => pipeline\);/);
  const dir = section("node.ssDirector = mountDirector(", "node.ssAsk = mountAsk(");
  assert.match(dir, /cutSig: cutSigOf\(cut\)/, "the Director host gets the Cut's signature function");
  assert.match(dir, /quality: qualityHost/, "the Director host gets the quality hook");
  const ask = section("node.ssAsk = mountAsk(", "mountProjectBar(");
  assert.match(ask, /quality: qualityHost/, "Ask uses the same hook (one place for ⑤ Motion's settings)");
  assert.doesNotMatch(ask, /_setAdherence/, "no second copy of the quality code");
  // `cut` there is the CutPanel the App builds
  assert.match(SRC, /const cut = new CutPanel\(cutView,/);
});

// ---------------------------------------------------------------- (a) host.cutSig on the real CutPanel edit / undo
function cutPanel() {
  const c = Object.create(CutPanel.prototype);
  c.project = { name: "t", fps: 24, shots: [{ id: "a", frames: 48 }, { id: "b", frames: 48 }], cut: [{ shot_id: "a", in: 4, out: 40 }, { shot_id: "b", in: 4, out: 40 }],
    audio: [], audio_tracks: [], titles: [], subtitles: [], fade_out: null, burn_subtitles: false, graphics: [] };
  c.history = []; c.future = []; c.sel = 0; c.rate = 24;
  c._afterEdit = () => {}; c.say = () => {}; c._inspect = () => {};
  return c;
}
test("host.cutSig: the Cut's signature changes when a transition goes on and comes back with the Cut's Undo", () => {
  const cut = cutPanel();
  const sig = cutSigOf(cut);
  const s0 = sig();
  assert.equal(typeof s0, "string");
  assert.equal(sig(), s0, "stable while nothing changes");
  cut.setTransition(1, "dissolve");
  const s1 = sig();
  assert.notEqual(s1, s0, "a transition is an edit");
  cut.undo();
  assert.equal(sig(), s0, "the Cut's Undo restores the signature (so Ask can tell its transition was the last edit)");
  cut.setTransition(1, "dissolve");
  assert.equal(sig(), s1, "the same edit gives the same signature");
  cut.setTransition(2, "dip_black");   // the tail fade
  assert.notEqual(sig(), s1);
  // anything without a project still answers
  assert.equal(cutSigOf(null)(), "none");
  assert.equal(cutSignature({ cut: [] }), cutSignature({ cut: [], playhead: 9 }), "only the editable state counts (not playhead, zoom)");
  assert.match(hashText("x"), /^[0-9a-f]{8}:1$/);
});

// ---------------------------------------------------------------- (c) host.quality on the real Motion settings
function motion() {
  let stored = {};
  const pipe = Object.create(Pipeline.prototype);
  Object.assign(pipe, {
    ctx: { app: { graph: { _nodes: [] } }, stage: { activeShot: () => ({ id: "s1" }), toJSON: () => ({ shot: { frames: 97, fps: 24 } }), fw: 960, fh: 512 },
      loadLtx: () => stored, saveLtx: (v) => { stored = JSON.parse(JSON.stringify(v)); } },
    _motionNote: () => { pipe.notes = (pipe.notes || 0) + 1; },
    _syncAdherence: () => { pipe.synced = (pipe.synced || 0) + 1; }, _applyVideo: () => {},
  });
  pipe.ltx = new LtxAdvanced(pipe);
  const follow = new El("input"); follow.setAttribute("value", "0.85");
  follow.addEventListener("input", () => { pipe.followed = follow.value; });
  pipe.f = { follow };
  return { pipe, stored: () => stored };
}
test("host.quality: get / set / clear change the Motion panel's own state (the shot's saved settings) and refresh it", () => {
  const { pipe, stored } = motion();
  const q = qualityHook(() => pipe);
  const q0 = q.get();
  assert.deepEqual(Object.keys(q0).sort(), ["adherence", "follow_clay", "ic_lora", "preset"]);
  assert.equal(q0.adherence, "Exact");
  assert.equal(q0.follow_clay, 0.85);
  const after = q.set({ adherence: "Loose", preset: "Draft", follow_clay: 0.95 });
  assert.equal(after.adherence, "Loose");
  assert.equal(after.preset, "Draft");
  assert.equal(after.follow_clay, 0.95);
  assert.equal(stored().s1.adherence, "Loose", "saved through the panel's store (LtxStore), per shot");
  assert.equal(stored().s1.preset, "Draft");
  assert.equal(pipe.ltx.settings().adherence, "Loose", "the panel reads the same");
  assert.equal(pipe.followed, "0.95", "the slider's own input handler ran");
  assert.ok(pipe.notes > 0 && pipe.synced > 0, "the panel refreshed");
  q.set({ ic_lora: 0.6 });
  assert.equal(q.get().ic_lora, 0.6);
  // clear: back to the defaults, the same state
  const notes = pipe.notes;
  const c = q.clear(["adherence", "ic_lora"]);
  assert.equal(c.adherence, "Exact");
  assert.equal("adherence" in stored().s1, false, "the override is gone from the saved settings");
  assert.equal("ic_lora" in (stored().s1 || {}), false);
  assert.ok(pipe.notes > notes, "refreshed");
  q.clear(["preset", "follow_clay"]);
  assert.equal(q.get().preset, "Final", "the default preset");
  assert.equal(q.get().follow_clay, 0.85);
  assert.deepEqual(q.clear(["nonsense"]), q.get(), "unknown keys are ignored");
  // set then undo through set(before): what the co-pilot does
  const before = q.get();
  q.set({ adherence: "Balanced" });
  q.set({ adherence: before.adherence });
  assert.equal(q.get().adherence, before.adherence);
  assert.deepEqual(qualityHook(() => null).get(), {}, "no pipeline yet: empty, no throw");
});

// ---------------------------------------------------------------- (b) book.forgetDecision on the real Book
test("book.forgetDecision(id): the decision note goes and the book is saved to the server at once; {ok}", async () => {
  const posts = [];
  const api = { fetchApi: async (path, init) => { if (init?.method === "POST") posts.push([path, JSON.parse(init.body)]); return { status: 200, json: async () => ({}) }; },
    addEventListener() {} };
  const props = {};
  let saves = 0, notes = 0;
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props, save: () => { saves++; }, onNotes: () => { notes++; } } });
  try {
    const n = book.recordDecision({ command: "make it rain", calls: [{ tool: "weather", args: { kind: "rain" } }], results: [{ ok: true }] });
    assert.ok(n?.id, "a decision note");
    assert.ok(book.book.notes.some((x) => x.id === n.id));
    posts.length = 0;
    const s0 = saves;
    assert.deepEqual(await book.forgetDecision(n.id), { ok: true, copies: 0 });
    assert.equal(book.book.notes.some((x) => x.id === n.id), false, "removed");
    assert.equal(props.ss_book.notes.some((x) => x.id === n.id), false, "the workflow copy too");
    assert.ok(saves > s0, "the workflow is saved");
    assert.equal(posts.length, 2, "saved to the server now, not after the 1.2 s debounce, then the older copies cleaned");
    assert.equal(posts[0][0], "/soundstage/book/save");
    assert.equal(posts[0][1].book.notes.some((x) => x.id === n.id), false, "the server copy has no note");
    assert.equal(posts[1][0], "/soundstage/book/forget");
    assert.deepEqual(posts[1][1].ids, [n.id]);
    assert.ok(notes > 0, "the Script panel's notes refresh");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(posts.length, 2, "no second, late save of the old book");
    // twice, or a made-up id: not ok, nothing saved
    assert.equal((await book.forgetDecision(n.id)).ok, false);
    assert.match((await book.forgetDecision("nope")).error, /no note 'nope'/);
    // the director's own notes are never removed this way
    await book.addNote("keep the lamp off until she enters", { sceneId: "sc_1", source: "director" });
    const mine = book.book.notes.at(-1);
    const r = await book.forgetDecision(mine.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /not a decision/);
    assert.ok(book.book.notes.some((x) => x.id === mine.id));
  } finally { book.dispose(); }
});

test("book.forgetDecision(id) waits for the server save: {ok} only after the POST answers; a failed save is {ok:false} and the note comes back", async () => {
  let answer = null;          // how the next POST ends: () => response, or throws
  let release = null;         // the POST waits for this
  const api = { fetchApi: (path, init) => (init?.method === "POST"
    ? new Promise((res, rej) => { release = () => { try { res(answer()); } catch (e) { rej(e); } }; })
    : Promise.resolve({ status: 200, json: async () => ({}) })), addEventListener() {} };
  const props = {};
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props } });
  const has = (id) => book.book.notes.some((x) => x.id === id);
  try {
    // 1. success: not settled until the server answers
    const a = book.recordDecision({ command: "make it rain", calls: [{ tool: "weather", args: { kind: "rain" } }], results: [{ ok: true }] });
    let settled = null;
    const p = book.forgetDecision(a.id).then((r) => { settled = r; return r; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, null, "still waiting for the POST");
    assert.equal(has(a.id), false, "gone locally while it saves");
    answer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, path: "x", removed: 3 }) });
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, null, "still waiting for the server to clean the older copies");
    release();                                    // the /forget POST
    assert.deepEqual(await p, { ok: true, copies: 3 });
    // 2. the server answers 500: not ok, the error says so, the note is back (book and server agree)
    const b = book.recordDecision({ command: "add fog", calls: [{ tool: "weather", args: { kind: "fog" } }], results: [{ ok: true }] });
    const at = book.book.notes.findIndex((x) => x.id === b.id);
    const q = book.forgetDecision(b.id);
    await new Promise((r) => setTimeout(r, 0));
    answer = () => ({ ok: false, status: 500, json: async () => ({ error: "disk full" }) });
    release();
    const rb = await q;
    assert.equal(rb.ok, false);
    assert.match(rb.error, /disk full/);
    assert.ok(has(b.id), "the note is put back");
    assert.equal(book.book.notes.findIndex((x) => x.id === b.id), at, "in its old place");
    assert.ok(props.ss_book.notes.some((x) => x.id === b.id), "the workflow copy has it again");
    // 3. the network fails (fetch rejects): not ok, never thrown, note back
    const q2 = book.forgetDecision(b.id);
    await new Promise((r) => setTimeout(r, 0));
    answer = () => { throw new Error("connection refused"); };
    release();
    const rc = await q2;
    assert.equal(rc.ok, false);
    assert.match(rc.error, /connection refused/);
    assert.ok(has(b.id));
  } finally { book.dispose(); }
});

test("book.forgetDecision: by ref, every copy server-side; a failed clean-up says removed and scrubDecision retries", async () => {
  const posts = [];
  let forgetAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, removed: 5 }) });
  const api = { fetchApi: async (path, init) => {
    if (init?.method === "POST") posts.push([path, JSON.parse(init.body)]);
    return path === "/soundstage/book/forget" ? forgetAnswer() : { status: 200, json: async () => ({ ok: true }) };
  }, addEventListener() {} };
  const props = {};
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props } });
  const TYPED = "could you make it pour with rain outside the window please";
  try {
    const a = book.recordDecision({ command: TYPED, ref: "p_0a1b2c3d:turn_42", calls: [{ tool: "weather", args: { weather: "rain" } }, { tool: "light", args: { type: "key" } }], results: [{ ok: true }, { ok: true }] });
    assert.equal(a.text, "Weather: rain; Light: key");
    assert.equal(JSON.stringify(props.ss_book).includes(TYPED), false, "the workflow copy never had the typed sentence");
    await new Promise((r) => setTimeout(r, 1300));                 // the debounced server save
    assert.equal(posts.some(([, b]) => JSON.stringify(b).includes(TYPED)), false, "nor did anything sent to the server");
    posts.length = 0;
    assert.deepEqual(await book.forgetDecision("p_0a1b2c3d:turn_42"), { ok: true, copies: 5 });
    assert.equal(book.book.notes.some((x) => x.id === a.id), false);
    assert.deepEqual(posts.map((p) => p[0]), ["/soundstage/book/save", "/soundstage/book/forget"]);
    assert.deepEqual(posts[1][1].ids.sort(), [a.id, "p_0a1b2c3d:turn_42"].sort());
    // the clean-up fails (an older server without the route): the note stays gone, the answer says so
    const b = book.recordDecision({ command: "add fog", calls: [{ tool: "weather", args: { kind: "fog" } }], results: [{ ok: true }] });
    forgetAnswer = () => ({ ok: false, status: 404, json: async () => { throw new Error("not json"); } });
    const r = await book.forgetDecision(b.id);
    assert.equal(r.ok, false);
    assert.equal(r.removed, true);
    assert.match(r.error, /older stored copies could not be cleaned: .*HTTP 404/);
    assert.equal(book.book.notes.some((x) => x.id === b.id), false, "not put back: the book and the server agree");
    forgetAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, removed: 2 }) });
    assert.deepEqual(await book.scrubDecision(b.id), { ok: true, copies: 2 });
  } finally { book.dispose(); }
});

test("book Forget names its project (host.project()); a server ok:false (a copy left) is not ok", async () => {
  const posts = [];
  let forgetAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, removed: 1 }) });
  const api = { fetchApi: async (path, init) => {
    if (init?.method === "POST") posts.push([path, JSON.parse(init.body)]);
    return path === "/soundstage/book/forget" ? forgetAnswer() : { status: 200, json: async () => ({ ok: true }) };
  }, addEventListener() {} };
  const props = {};
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props,
    project: () => ({ id: "p_aaaaaaaa", name: "Film" }) } });
  try {
    const a = book.recordDecision({ command: "rain", calls: [{ tool: "weather", args: { weather: "rain" } }], results: [{ ok: true }] });
    posts.length = 0;
    assert.deepEqual(await book.forgetDecision(a.id), { ok: true, copies: 1 });
    assert.deepEqual(posts[0][1].project, { id: "p_aaaaaaaa", name: "Film" }, "the book save says whose book it is");
    assert.deepEqual(posts[1][1].project, { id: "p_aaaaaaaa", name: "Film" }, "Forget cleans only this project's copies");
    forgetAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: false, removed: 2, error: "1 stored copy not cleaned: Big.json (over 64 MB, not read)",
      skipped: [{ path: "Big.json", why: "over 64 MB, not read" }], still_mentions: [], errors: [] }) });
    const r = await book.scrubDecision(a.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /Big\.json/);
  } finally { book.dispose(); }
});

test("book.forgetDecision on a decision the 40-entry cap dropped from the open Book still runs the server scrub (review finding 3)", async () => {
  const posts = [];
  let removed = 3;
  const api = { fetchApi: async (path, init) => {
    if (init?.method === "POST") posts.push([path, JSON.parse(init.body)]);
    return path === "/soundstage/book/forget" ? { ok: true, status: 200, json: async () => ({ ok: true, removed }) } : { status: 200, json: async () => ({ ok: true }) };
  }, addEventListener() {} };
  const props = {};
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props,
    project: () => ({ id: "p_aaaaaaaa", name: "Film" }) } });
  try {
    const first = book.recordDecision({ command: "make it rain", ref: "p_aaaaaaaa:turn_0001", calls: [{ tool: "weather", args: { kind: "rain" } }], results: [{ ok: true }] });
    for (let i = 0; i < 41; i++) book.recordDecision({ command: `fog ${i}`, calls: [{ tool: "weather", args: { kind: "fog" } }], results: [{ ok: true }] });
    assert.equal(book.book.notes.some((x) => x.id === first.id), false, "aged out of the open Book by the cap");
    posts.length = 0;
    assert.deepEqual(await book.forgetDecision(first.id), { ok: true, in_book: false, copies: 3 });
    assert.deepEqual(posts.map((p) => p[0]), ["/soundstage/book/forget"], "no book save, only the server scrub");
    assert.deepEqual(posts[0][1].ids, [first.id]);
    assert.deepEqual(posts[0][1].project, { id: "p_aaaaaaaa", name: "Film" });
    assert.equal((await book.forgetDecision("p_aaaaaaaa:turn_0001")).copies, 3, "by ref too");
    removed = 0;                                                   // nothing left anywhere: not ok, says so
    const r = await book.forgetDecision(first.id);
    assert.equal(r.ok, false);
    assert.equal(r.in_book, false);
    assert.match(r.error, /no note .* and no stored copy/);
  } finally { book.dispose(); }
});

// ---------------------------------------------------------------- round 5, finding 3: Ask's addNote notes can be forgotten
test("book.addNote(text, {source: 'ask', ref}): kept with its ref; forgetDecision(ref) removes it here and server-side", async () => {
  const posts = [];
  const api = { fetchApi: async (path, init) => {
    if (init?.method === "POST") posts.push([path, JSON.parse(init.body)]);
    return path === "/soundstage/book/forget" ? { ok: true, status: 200, json: async () => ({ ok: true, removed: 3 }) }
      : path === "/soundstage/book/legacy" ? { ok: true, status: 200, json: async () => ({ ok: true, decisions: [{ id: "n_old", files: ["x"] }], files: ["x"] }) }
        : { status: 200, json: async () => ({ ok: true }) };
  }, addEventListener() {} };
  const props = {};
  const script = { title: "Test", scenes: [{ id: "sc_1", number: 1, heading: "INT. ROOM - DAY", elements: [], characters: [] }], characters: [] };
  const book = mountBook({ api, stage: null, host: { getScript: () => script, liveScene: () => "sc_1", props: () => props,
    project: () => ({ id: "p_aaaaaaaa", name: "Film" }) } });
  const TYPED = "remember the diner sign flickers when Jane Doe walks in";
  try {
    const n = await book.addNote(TYPED, { sceneId: "sc_1", source: "ask", ref: "p_aaaaaaaa:turn_7" });
    assert.equal(n.ref, "p_aaaaaaaa:turn_7");
    assert.ok(props.ss_book.notes.some((x) => x.id === n.id && x.ref === "p_aaaaaaaa:turn_7"), "saved with its ref");
    posts.length = 0;
    assert.deepEqual(await book.forgetDecision("p_aaaaaaaa:turn_7"), { ok: true, copies: 3 });
    assert.equal(JSON.stringify(props.ss_book).includes(TYPED), false, "gone from the workflow copy");
    assert.equal(JSON.stringify(book.book).includes(TYPED), false, "and from the open Book");
    assert.deepEqual(posts.map((p) => p[0]), ["/soundstage/book/save", "/soundstage/book/forget"]);
    assert.deepEqual(posts[1][1].ids.sort(), [n.id, "p_aaaaaaaa:turn_7"].sort());
    // by id works too; a ref spelled from the note's words is dropped
    const m = await book.addNote("Sign flickers on entry", { sceneId: "sc_1", source: "ask", ref: ":signflickersonentry" });
    assert.equal(m.ref, undefined);
    assert.equal((await book.forgetDecision(m.id)).ok, true);
    // Pitch's and the director's notes are still never removed
    const d = await book.addNote("keep the lamp off", { sceneId: "sc_1", source: "director", ref: "p_aaaaaaaa:turn_8" });
    assert.match((await book.forgetDecision("p_aaaaaaaa:turn_8")).error, /not a decision/);
    assert.ok(book.book.notes.some((x) => x.id === d.id));
  } finally { book.dispose(); }
});
