// node --test tests/js/agent.test.mjs
// The browser applies the server's ops with applyOpsToScene(); it must give exactly what Python's apply_ops()
// gives (fixture written by `python3 tests/test_agent.py --write-fixture`), and each op's undo must revert it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyOpsToScene, inverseOf, applyOps, SceneAgent } from "../../web/agent/agent.mjs";

const CASES = JSON.parse(readFileSync(new URL("../agent_fixtures/ops_parity.json", import.meta.url), "utf8"));

// Python's json.dumps(sort_keys=True) equivalent, so key order does not matter.
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

for (const c of CASES) {
  test(`ops parity: ${c.command}`, () => {
    assert.equal(canon(applyOpsToScene(c.scene, c.ops)), canon(c.expected));
    assert.equal(canon(applyOpsToScene(c.expected, c.inverse)), canon(c.scene));
    assert.equal(canon(inverseOf(c.ops)), canon(c.inverse));
  });
}

test("applyOpsToScene does not mutate its input", () => {
  const c = CASES[0];
  const before = canon(c.scene);
  applyOpsToScene(c.scene, c.ops);
  assert.equal(canon(c.scene), before);
});

/** A stand-in with the public Stage surface the agent uses. */
function fakeStage(scene) {
  return {
    state: structuredClone(scene), frame: 12, selected: null, changes: 0,
    toJSON() { return structuredClone(this.state); },
    load(s) { this.state = structuredClone(s); this.frame = 0; },
    setFrame(f) { this.frame = f; },
    select(id) { this.selected = id; },
    onChange() { this.changes++; },
  };
}

test("applyOps drives the stage through load() and keeps the playhead", () => {
  const c = CASES[0];
  const stage = fakeStage(c.scene);
  applyOps(stage, c.ops);
  assert.equal(canon(stage.state), canon(c.expected));
  assert.equal(stage.frame, 12);
  assert.equal(stage.changes, 1);
});

test("SceneAgent edit + undo/redo against a fake server (rules path, no model)", async () => {
  const c = CASES.find((x) => x.command.includes("over-the-shoulder")) || CASES[0];
  const stage = fakeStage(c.scene);
  const api = {
    clientId: "t",
    addEventListener() {}, removeEventListener() {},
    async fetchApi(path, opts) {
      if (path === "/soundstage/agent/info") return { status: 200, json: async () => ({ available: false }) };
      if (path === "/soundstage/agent/edit") {
        const body = JSON.parse(opts.body);
        assert.equal(body.command, c.command);
        assert.equal(body.llm_text, null);
        return { status: 200, json: async () => ({ ops: c.ops, inverse: c.inverse, summary: "ok", notes: [] }) };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const agent = new SceneAgent({ api, stage, designProps: false });
  await agent.edit(c.command);
  assert.equal(canon(stage.state), canon(c.expected));
  agent.undo();
  assert.equal(canon(stage.state), canon(c.scene));
  agent.redo();
  assert.equal(canon(stage.state), canon(c.expected));
  assert.equal(agent.history.length, 2);
});
