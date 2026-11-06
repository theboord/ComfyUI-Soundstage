// node --test tests/js/ask_robust.test.mjs
// ✦ Ask never hangs (QA 2026-11-04, Mike on the pod: "it's not responding back... it's hanging on to the question I had
// and I can't lock it in"). The real chat (web/agent/directorpanel.mjs) and Ask (web/agent/ask.mjs) are mounted on a
// tiny fake DOM and driven through send(), Enter, the Send button, Stop and Esc, with a server and a local model that
// never answer. Root causes, each with its regression test below:
//   1. the answer hook and the planner had no time limit (the local model: 90 s, the Director routes: none), and the
//      question wasn't shown until the answer came: a silent hang;
//   2. while a request hung, every new question got "One moment: still on the last one." and its words were thrown
//      away (the box had already been cleared), so the old question "stuck";
//   3. "lock it in" (or "looks good", "ship it") wasn't a yes: any other words while a plan waits throw the plan away
//      and plan again, so the plan could never be applied by saying so;
//   4. a free-form answer that failed or timed out was swallowed (catch { return null }) with no word in the chat;
//   5. Whisper: letting go of the mic before the browser granted it left `listening` set, so the mic kept recording
//      in the background and every later press did nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------- a tiny DOM, enough for the chat
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
    this.selectedOptions = [];
  }
  get parentNode() { return this.parent; }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e === doc.body || e === doc.head; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tagName === "#TEXT" ? this._text : this.children.map((c) => c.textContent).join(""); }
  set textContent(t) { this.children = []; if (t) this.append(String(t)); }
  set innerHTML(_) { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); if (k === "hidden") this.hidden = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) { const n = k instanceof El ? k : doc.createTextNode(String(k)); n.parent?._drop(n); n.parent = this; this.children.push(n); } }
  prepend(...kids) { for (const k of kids.reverse()) { const n = k instanceof El ? k : doc.createTextNode(String(k)); n.parent = this; this.children.unshift(n); } }
  insertBefore(n, ref) { n.parent?._drop(n); n.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  after(n) { const p = this.parent; if (!p) return; n.parent?._drop(n); n.parent = p; p.children.splice(p.children.indexOf(this) + 1, 0, n); }
  _drop(n) { this.children = this.children.filter((c) => c !== n); }
  remove() { this.parent?._drop(this); this.parent = null; }
  replaceChildren(...kids) { for (const c of this.children) c.parent = null; this.children = []; this.append(...kids); }
  contains(n) { for (let e = n; e; e = e.parent) if (e === this) return true; return false; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  _match(sel) {
    return sel.split(",").some((one) => {
      const m = one.trim().match(/^([a-z]*)((?:\.[\w-]+)*)$/i);
      if (!m) return false;
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      return m[2].split(".").filter(Boolean).every((c) => this.classList.contains(c));
    });
  }
  matches(sel) { return this._match(sel); }
  querySelectorAll(sel) { return this.all().filter((e) => e._match(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(t, f) { (this._ev[t] ||= []).push(f); }
  removeEventListener(t, f) { this._ev[t] = (this._ev[t] || []).filter((x) => x !== f); }
  dispatch(t, ev = {}) { const e = { type: t, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, button: 0, ...ev }; for (const f of this._ev[t] || []) f(e); return e; }
  click() { this.dispatch("click"); }
  focus() { doc.activeElement = this; }
  blur() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getClientRects() { return []; }
}
const doc = {
  createElement: (t) => new El(t), createElementNS: (_, t) => new El(t),
  createTextNode: (t) => { const n = new El("#text"); n._text = String(t); return n; },
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null,
  addEventListener() {}, removeEventListener() {},
};
doc.head = new El("head"); doc.body = new El("body");
const winEv = {};
globalThis.document = doc;
globalThis.window = { innerWidth: 1440, innerHeight: 900, addEventListener: (t, f) => (winEv[t] ||= []).push(f),
  removeEventListener: (t, f) => { winEv[t] = (winEv[t] || []).filter((x) => x !== f); } };
globalThis.getComputedStyle = () => ({ position: "relative", fontFamily: "sans-serif", visibility: "visible", display: "block" });
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.Node = El;
globalThis.navigator ||= {};

const { mountDirector } = await import("../../web/agent/directorpanel.mjs");
const { mountAsk, modelFor } = await import("../../web/agent/ask.mjs");
const { Conversation } = await import("../../web/agent/assistant.mjs");
const { withTimeout, cancelledError } = await import("../../web/agent/agent.mjs");
const { YES_RE, ASK_TIMEOUT_MS } = await import("../../web/agent/director.mjs");

// ---------------------------------------------------------------- the App around it
const never = () => new Promise(() => {});
const stage = { state: { actors: [], shots: [{ id: "s1" }] }, toJSON() { return { actors: [], shots: [{ id: "s1", name: "Shot 1" }], active_shot: "s1" }; }, activeShot: () => ({ id: "s1" }) };
function fakeApi(routes = {}) {
  const seen = [];
  return { seen, clientId: "t", addEventListener() {}, removeEventListener() {},
    async fetchApi(path, init = {}) {
      seen.push(path);
      const f = routes[path];
      if (f === "hang") return never();
      const out = f ? await f(init.body ? JSON.parse(init.body) : null) : (path.endsWith("/info") ? { available: false, tools: [] } : {});
      return { status: out?.error ? 500 : 200, ok: !out?.error, json: async () => out };
    } };
}
const PLAN = (b) => ({ command: b.command, calls: [{ tool: "weather", args: { kind: "rain" }, plan: "I'll make it rain" }], backend: "rules", confirm: false });
const alive = [];
after(() => { for (const f of alive) f(); });   // a failed assertion never leaves the chat's timers running
function mount(routes = {}, { ask = true, host: extra = {} } = {}) {
  const root = new El("div"); doc.body.append(root);
  const api = fakeApi({ "/soundstage/director/plan": PLAN, ...routes });
  const dir = mountDirector({ root, api, stage, host: {} });
  const a = ask ? mountAsk({ root, dir, host: { context: () => ({ step: "set" }), ...extra } }) : null;
  dir.director.backend = "rules";
  dir.director.limits = { turnMs: 300, postMs: 120 };   // the same code path, with short limits for the test
  const msgs = () => dir.panel.querySelectorAll(".msg").map((m) => ({ cls: m.className, text: m.textContent }));
  const last = () => msgs().at(-1);
  let gone = false;
  const done = () => { if (gone) return; gone = true; a?.destroy(); dir.destroy(); root.remove(); };
  alive.push(done);
  return { root, api, dir, ask: a, msgs, last, done };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const enter = (dir, text) => { dir.input.value = text; dir.input.dispatch("keydown", { key: "Enter" }); };
const sendBtn = (dir) => dir.panel.querySelector(".comp").children.at(-1);

// ---------------------------------------------------------------- the helpers
test("withTimeout settles: the value, a timeout (timedOut) or Stop (cancelled), never a hang", async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  await assert.rejects(withTimeout(never(), 30, "the model"), (e) => e.timedOut && /the model took longer than 0 s/.test(e.message));
  const c = new AbortController();
  const p = withTimeout(never(), 5000, "x", c.signal);
  c.abort();
  await assert.rejects(p, (e) => e.cancelled === true);
  await assert.rejects(withTimeout(never(), 5000, "x", c.signal), (e) => e.cancelled, "already stopped: at once");
  assert.equal(cancelledError().cancelled, true);
  assert.ok(ASK_TIMEOUT_MS >= 60000 && ASK_TIMEOUT_MS <= 120000, "room for the local model's cold load, still bounded");
});

test("root cause 3: \"lock it in\" and friends apply a waiting plan; a new order still replans", () => {
  for (const y of ["lock it in", "Lock it in!", "lock it", "ok lock it in", "looks good", "yes please", "ship it", "do that", "perfect", "that's it", "apply the plan", "ok, do it"])
    assert.ok(YES_RE.test(y), y);
  for (const n of ["yes, and make it rain", "lock the car in place", "make it look good at night"]) assert.ok(!YES_RE.test(n), n);
});

test("root cause 4: a model that fails, never answers, or isn't there is said, within its limit", async () => {
  const base = { resolvedBackend: async () => "ollama", _gpuBusy: async () => false, info: async () => ({ model: "m" }), ollama: { model: "q" } };
  const convo = (d) => new Conversation({ script: () => null, llm: modelFor(d, { ms: 60 }) });
  const t0 = Date.now();
  const slow = await convo({ ...base, _llm: never }).turn("how do I juggle?");
  assert.equal(slow, null, "nothing for the checks: the chat falls back to the recipes");
  const c1 = convo({ ...base, _llm: never }); await c1.turn("how do I juggle?");
  assert.match(c1.lastWhy, /didn't answer in time/);
  assert.ok(Date.now() - t0 < 2000, "bounded");
  const c2 = convo({ ...base, _llm: async () => { throw new Error("connection refused"); } }); await c2.turn("q?");
  assert.match(c2.lastWhy, /failed \(connection refused\)/);
  const c3 = convo({ ...base, resolvedBackend: async () => "rules" }); await c3.turn("q?");
  assert.match(c3.lastWhy, /language model isn't loaded/);
  const c4 = convo({ ...base, resolvedBackend: async () => "qwen", _gpuBusy: async () => true }); await c4.turn("q?");
  assert.match(c4.lastWhy, /GPU is busy/);
  const ok = await convo({ ...base, _llm: async () => '{"reply":"Open ③ Set, then Add object.","tools":[]}' }).turn("q?");
  assert.equal(ok.reply, "Open ③ Set, then Add object.");
  assert.equal(ok.by, "model");
  const c = new AbortController(); c.abort();
  await assert.rejects(convo({ ...base, _llm: never }).turn("q?", { signal: c.signal }), (e) => e.cancelled, "stopped: no answer, no error card");
});

test("the local model's job takes a Stop: it rejects at once and leaves the queue", async () => {
  const { runLocalModel } = await import("../../web/agent/agent.mjs");
  const api = fakeApi({ "/prompt": () => ({ prompt_id: "p1" }), "/queue": () => ({}) });
  const c = new AbortController();
  const p = runLocalModel(api, { system: "s", prompt: "p", max_length: 10, model: "m" }, { timeoutMs: 60000, signal: c.signal });
  await tick(5);
  c.abort();
  await assert.rejects(p, (e) => e.cancelled);
  await tick(5);
  assert.ok(api.seen.includes("/queue"), "the job was taken off the queue");
});

// ---------------------------------------------------------------- the chat
test("root cause 1: the question shows at once with Thinking… and a Stop, before any answer", async () => {
  const m = mount({ "/soundstage/director/plan": "hang" });
  m.dir.send("make it rain");
  await tick();
  const ms = m.msgs();
  assert.equal(ms.at(-2).text, "make it rain", "the question is in the chat right away");
  assert.match(ms.at(-1).text, /Thinking…|Reading that…/);
  assert.match(ms.at(-1).text, /Stop/);
  m.done();
});

test("root cause 1: a planner that never answers ends in a clear error within the time limit", async () => {
  const m = mount({ "/soundstage/director/plan": "hang" });
  const t0 = Date.now();
  const r = await m.dir.send("make it rain");
  assert.ok(Date.now() - t0 < 1500, "within the turn's limit");
  assert.match(r.error, /took longer than/);
  assert.match(m.last().text, /I couldn't plan that: .*took longer than/);
  assert.doesNotMatch(m.msgs().map((x) => x.cls).join(" "), /wait/, "no Thinking… left behind");
  // and the next question goes through
  m.api.fetchApi = fakeApi({ "/soundstage/director/plan": PLAN }).fetchApi;
  const r2 = await m.dir.send("make it snow");
  assert.ok(r2.plan, "answered");
  m.done();
});

test("root cause 2: a newer question stops a stuck one instead of being turned away; the stale answer is dropped", async () => {
  let release;
  let n = 0;
  const m = mount({ "/soundstage/director/plan": (b) => (++n === 1 ? new Promise((r) => { release = () => r(PLAN(b)); }) : PLAN(b)) });
  const first = m.dir.send("make it rain");
  await tick();
  const second = await m.dir.send("make it snow");
  assert.ok(second.plan, "the second one is planned, not refused");
  assert.ok(!m.msgs().some((x) => /still on the last one/.test(x.text)));
  release();
  assert.equal(await first, null, "the first one's late answer is dropped");
  assert.equal(m.dir.pending.command, "make it snow", "the plan waiting is the newest one");
  m.done();
});

test("Stop (the button, Esc, or \"stop\") gives up on a stuck question, and the chat stays open and ready", async () => {
  const m = mount({ "/soundstage/director/plan": "hang" });
  const p = m.dir.send("make it rain");
  await tick();
  m.dir.panel.querySelector("button.stop").click();
  assert.equal(await p, null);
  assert.match(m.last().text, /Stopped/);
  assert.equal(m.dir.isOpen(), true);
  // Esc in the box
  const p2 = m.dir.send("make it snow");
  await tick();
  m.dir.input.dispatch("keydown", { key: "Escape" });
  assert.equal(await p2, null);
  for (const f of winEv.keyup || []) f({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(m.dir.isOpen(), true, "the Esc that stopped it doesn't also close the chat");
  // typed "stop"
  const p3 = m.dir.send("make it foggy");
  await tick();
  await m.dir.send("stop");
  assert.equal(await p3, null);
  assert.match(m.last().text, /Stopped/);
  m.done();
});

test("Enter and Send both submit, and the box is empty and focused for the next question", async () => {
  const m = mount();
  enter(m.dir, "make it rain");
  assert.equal(m.dir.input.value, "", "cleared at once");
  await tick(10);
  assert.equal(m.dir.pending.command, "make it rain");
  m.dir.input.value = "make it snow";
  sendBtn(m.dir).click();
  assert.equal(m.dir.input.value, "");
  assert.equal(doc.activeElement, m.dir.input, "ready to type again");
  await tick(10);
  assert.equal(m.dir.pending.command, "make it snow");
  m.done();
});

test("root cause 3 in the chat: \"lock it in\" applies the plan, with Undo this", async () => {
  const m = mount();
  let applied = 0;
  m.dir.director.apply = async () => { applied++; return { ok: true, results: [{ ok: true, said: "It's raining." }], said: ["It's raining."], next: [], undoable: true }; };
  m.dir.director.undoStack = [{ label: "rain" }];
  await m.dir.send("make it rain");
  assert.ok(m.dir.pending);
  await m.dir.send("lock it in");
  assert.equal(applied, 1);
  assert.equal(m.dir.pending, null);
  assert.ok(m.dir.panel.querySelectorAll("button").some((b) => /Undo this/.test(b.textContent)), "Undo this is there");
  // and Enter on an empty box applies a waiting plan too
  await m.dir.send("make it snow");
  enter(m.dir, "");
  await tick(5);
  assert.equal(applied, 2);
  m.done();
});

test("Ask: a question with a recipe answers at once with Show me and Do it for me; Do it for me plans", async () => {
  const m = mount();
  const r = await m.dir.send("how do I make the car crash into the boxes?");
  assert.ok(r.answer);
  const btns = m.dir.panel.querySelectorAll("button").map((b) => b.textContent);
  assert.ok(btns.some((t) => /Show me/.test(t)));
  const doIt = m.dir.panel.querySelector(".log").querySelectorAll("button.go").at(-1);
  assert.match(doIt.textContent, /Do it for me/);
  doIt.click();
  await tick(10);
  assert.ok(m.dir.pending, "Do it for me gives a plan to Apply");
  m.done();
});

test("Ask: an unknown question with a model that never answers still gets an answer card, not a hang", async () => {
  const m = mount();
  const d = m.dir.director;
  d.limits = { turnMs: 2000, postMs: 120, modelMs: 60 };   // the same code path, with short limits
  d.resolvedBackend = async () => "ollama";
  d._gpuBusy = async () => false;
  d.info = async () => ({ model: "m" });
  d._llm = never;
  const ask = await import("../../web/agent/ask.mjs");
  assert.ok(ask.FREE_ANSWER_MS < ASK_TIMEOUT_MS, "the model gives up before the chat does");
  const r = await m.dir.send("how do I juggle oranges?");
  assert.ok(r.answer);
  assert.match(m.last().text, /didn't answer in time\.I don't have a recipe for that one yet/);
  m.done();
});

test("an answer hook that throws is said in the chat (it used to fall through silently)", async () => {
  const m = mount();
  m.dir.setAnswer(async () => { throw new Error("recipe table broke"); });
  const r = await m.dir.send("how do I add rain?");
  assert.match(r.error, /recipe table broke/);
  assert.match(m.last().text, /I couldn't answer that: recipe table broke/);
  m.done();
});

test("applying a plan isn't stopped by a new message: the words go back in the box", async () => {
  const m = mount();
  let finish;
  m.dir.director.apply = () => new Promise((r) => { finish = () => r({ ok: true, results: [], said: [], next: [] }); });
  await m.dir.send("make it rain");
  const ap = m.dir.apply();
  await tick();
  m.dir.input.value = "";
  await m.dir.send("make it snow");
  assert.equal(m.dir.input.value, "make it snow", "nothing typed is lost");
  assert.match(m.last().text, /still applying/);
  finish(); await ap;
  m.done();
});

test("root cause 5: letting go of the mic before it's granted ends that press; the next press can talk", async () => {
  let grant;
  const tracks = [];
  globalThis.navigator.mediaDevices = { getUserMedia: () => new Promise((r) => { grant = () => r({ getTracks: () => [{ stop() { tracks.push("stopped"); } }] }); }) };
  const m = mount({}, { ask: false });
  m.dir.setVoice("whisper");
  m.dir.startTalk("mouse");
  await tick();
  m.dir.stopTalk();          // let go while the browser still asks for the mic
  grant();
  await tick(5);
  assert.deepEqual(tracks, ["stopped"], "the mic is released, not left recording");
  let asked = 0;
  globalThis.navigator.mediaDevices = { getUserMedia: async () => { asked++; throw new Error("denied"); } };
  await m.dir.startTalk("mouse");
  assert.equal(asked, 1, "the next press talks (it used to be blocked)");
  m.done();
  delete globalThis.navigator.mediaDevices;
});

test("Mike's request in the chat: no model, so it says so and runs the cast, props and script checks; Apply, then Undo", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseScript } = await import("../../web/script/parse.mjs");
  let script = parseScript(readFileSync(new URL("./fixtures/script/planted.fountain", import.meta.url), "utf8"), { format: "fountain" });
  const original = script;
  const m = mount({ "/soundstage/director/plan": () => { throw new Error("the planner must not run"); } },
    { host: { script: () => script, setScript: (s) => { script = s; } } });
  const r = await m.dir.send("double-check the characters to make sure they don't match (no duplicates), check the props are actually props, read the script and analyse it");
  assert.ok(r.answer, "an answer, not a plan");
  assert.equal(m.dir.pending, null, "no shot or beat was planned");
  const txt = m.last().text;
  assert.match(txt, /language model isn't loaded .* so I used the built-in checks/);
  for (const t of ["Script analysis", "Cast check", "Props check", "What I did:"]) assert.ok(txt.includes(t), t);
  assert.match(txt, /MARA and MARRA are 1 letter apart/);
  const apply = m.dir.panel.querySelector(".log").querySelectorAll("button.go").find((b) => /^Apply \d+ fix/.test(b.textContent.trim()));
  assert.ok(apply, "fixes wait for an OK");
  apply.click();
  assert.ok(!script.characters.some((c) => c.name === "MARRA"), "applied");
  assert.match(m.last().text, /What I did/);
  const undo = m.dir.panel.querySelector(".log").children.at(-1).querySelectorAll("button").find((b) => /Undo/.test(b.textContent));
  undo.click();
  assert.equal(script, original, "one Undo puts the script back");
  // a vague one gets a question with choices
  await m.dir.send("check it");
  assert.match(m.last().text, /What should I check\?/);
  assert.ok(m.dir.panel.querySelector(".chips").children.some((b) => /The props/.test(b.textContent)));
  // New chat: the log and the conversation start over
  assert.ok(m.ask.conversation.history.length > 0);
  m.dir.panel.querySelector("button.newchat").click();
  assert.equal(m.ask.conversation.history.length, 0);
  assert.equal(m.dir.panel.querySelectorAll(".msg").length, 1, "only the greeting");
  m.done();
});

test("an error gets a Retry that asks again", async () => {
  let n = 0;
  const m = mount({ "/soundstage/director/plan": (b) => (++n === 1 ? never() : PLAN(b)) });
  await m.dir.send("make it rain");
  const retry = m.dir.panel.querySelector(".log").children.at(-1).querySelectorAll("button").find((b) => /Retry/.test(b.textContent));
  assert.ok(retry, "Retry under the error");
  retry.click();
  await tick(20);
  assert.equal(m.dir.pending?.command, "make it rain");
  m.done();
});
