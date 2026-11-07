// node --test tests/js/assistant_brain.test.mjs
// ✦ Ask's bundled brain (soundstage/assistant.py): "auto" picks the server's Ollama assistant when it's ready, else the
// built-in Qwen3.5 4B; the chat goes through the server proxy (a pod's Ollama isn't reachable from the browser);
// pickOllama prefers the assistant model; the warm-up says warming up, then ready.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Director, ASSISTANT, pickOllama } from "../../web/agent/director.mjs";

const stage = { toJSON: () => ({ shots: [], actors: [], active_shot: null }) };
const READY = { backend: "ollama", model: "qwen3:30b-a3b", device: "gpu", loaded: false, reason: "48 GB VRAM" };

const fakeApi = (handlers) => {
  const seen = [];
  return { seen, clientId: "t", addEventListener() {}, removeEventListener() {},
    async fetchApi(path, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      seen.push({ path, body });
      const out = handlers[path]?.(body);
      if (out === undefined) return { status: 404, ok: false, json: async () => ({ error: "no route" }) };
      return { status: out.error ? 500 : 200, ok: !out.error, json: async () => out };
    } };
};
const routes = (status) => ({
  "/soundstage/assistant/status": status ? () => status : undefined,
  "/soundstage/director/info": () => ({ available: true, tools: [] }),
  "/soundstage/queue_summary": () => ({ running: 0, pending: 0, items: [] }),
  "/soundstage/director/prompt": () => ({ system: "S", prompt: "U", max_length: 100 }),
  "/soundstage/director/plan": (b) => ({ calls: [], notes: [], llm: b.llm_text }),
  "/soundstage/assistant/chat": (b) => ({ message: { content: '{"calls":[{"tool":"play"}]}' }, got: b }),
});

test("auto: the bundled Ollama assistant when the server has it, through the server proxy", async () => {
  const api = fakeApi(routes(READY));
  const d = new Director({ api, stage, host: {} });
  d.backend = "auto"; d.ollama = { url: "http://127.0.0.1:11434", model: "" };
  const f0 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("the browser must not call Ollama directly"); };
  try {
    assert.equal(await d.resolvedBackend(), "ollama");
    const p = await d.propose("play it");
    assert.equal(p.used_backend, "ollama");
    assert.equal(p.llm, '{"calls":[{"tool":"play"}]}');
    const chat = api.seen.find((x) => x.path === "/soundstage/assistant/chat");
    assert.ok(chat, "went through the proxy");
    assert.equal(chat.body.format, "json");
    assert.equal(chat.body.keep_alive, undefined, "the server decides how long the model stays");
    assert.equal(chat.body.messages[0].content, "S");
    assert.ok(!api.seen.some((x) => x.path === "/prompt"), "nothing on the GPU queue");
  } finally { globalThis.fetch = f0; }
});

test("auto: no assistant (route away, Ollama down, too little RAM) falls back to the built-in Qwen3.5 4B", async () => {
  for (const st of [null, { ...READY, backend: "qwen", reason: "Ollama isn't running" }, { ...READY, backend: "qwen", device: "none" }]) {
    const d = new Director({ api: fakeApi(routes(st)), stage, host: {} });
    d.backend = "auto";
    assert.equal(await d.resolvedBackend(), "qwen", JSON.stringify(st));
  }
  const d = new Director({ api: fakeApi(routes({ ...READY })), stage, host: {} });
  d.backend = "rules";
  assert.equal(await d.resolvedBackend(), "rules", "a backend picked in ⚙ wins");
});

test("an Ollama model picked in ⚙ that isn't the assistant goes straight to that Ollama", async () => {
  const d = new Director({ api: fakeApi(routes(READY)), stage, host: {} });
  d.ollama = { url: "http://127.0.0.1:11434", model: "llama3:8b" };
  assert.equal(await d._viaServer(), false);
  d.ollama.model = "qwen3:30b-a3b";
  assert.equal(await d._viaServer(), true);
});

test("pickOllama prefers the assistant model, else the largest text model", () => {
  const models = [{ name: "llama3.1:70b", size: "70B" }, { name: "qwen3:30b-a3b", size: "30.5B" }, { name: "nomic-embed", size: "" }];
  assert.equal(pickOllama(models).name, ASSISTANT.model);
  assert.equal(pickOllama(models, "qwen3:8b").name, "llama3.1:70b");
  assert.equal(pickOllama([{ name: "qwen3:8b:latest" }], "qwen3:8b").name, "qwen3:8b:latest");
});

test("coldStart: only when this turn would have to load the bundled assistant, and it posts nothing", async () => {
  const coldApi = fakeApi(routes({ ...READY, loaded: false }));
  assert.equal(await new Director({ api: coldApi, stage, host: {} }).coldStart(), true);
  assert.deepEqual(coldApi.seen.filter((x) => x.method === "POST" || x.body), [], "asking must not load anything");
  assert.equal(await new Director({ api: fakeApi(routes({ ...READY, loaded: true })), stage, host: {} }).coldStart(), false);
  assert.equal(await new Director({ api: fakeApi(routes(null)), stage, host: {} }).coldStart(), false);
  const rules = new Director({ api: fakeApi(routes({ ...READY, loaded: false })), stage, host: {} });
  rules.backend = "rules";
  assert.equal(await rules.coldStart(), false, "a backend picked in the settings loads no assistant");
  const other = new Director({ api: fakeApi(routes({ ...READY, loaded: false })), stage, host: {} });
  other.ollama = { url: "http://127.0.0.1:11434", model: "llama3:8b" };
  assert.equal(await other.coldStart(), false, "another Ollama model is not the bundled assistant");
});

test("opening the App has no way to load the model: no warm-up call, and the browser never sets how long it stays", () => {
  const read = (p) => readFileSync(new URL(`../../web/agent/${p}`, import.meta.url), "utf8");
  for (const f of ["director.mjs", "directorpanel.mjs"]) {
    assert.doesNotMatch(read(f), /warmup|warmUp|keep_alive/, f);
  }
});
