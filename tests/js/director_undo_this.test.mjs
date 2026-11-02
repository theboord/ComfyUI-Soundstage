// Every applied Director turn gets an "Undo this" button. They all called director.undo(), which pops the newest turn:
// "Undo this" under turn A reverted turn B (and the log said "Undid: B").
import test from "node:test";
import assert from "node:assert/strict";
import { undoOwnTurn } from "../../web/agent/directorpanel.mjs";

function fakeDirector() {
  return { undoStack: [], redoStack: [], state: [],
    apply(label) { this.state.push(label); this.undoStack.push({ label }); return this.undoStack[this.undoStack.length - 1]; },
    undo() { const e = this.undoStack.pop(); if (!e) return null; this.state.pop(); this.redoStack.push(e); return e.label; } };
}

test("Undo this undoes its own turn only while it is the newest", () => {
  const d = fakeDirector();
  const a = d.apply("A"), b = d.apply("B");
  const early = undoOwnTurn(d, a);
  assert.equal(early.done, false);
  assert.deepEqual(d.state, ["A", "B"], "B is not undone by A's button");
  assert.deepEqual(undoOwnTurn(d, b), { done: true, said: "Undid: B" });
  assert.deepEqual(undoOwnTurn(d, a), { done: true, said: "Undid: A" });
  assert.deepEqual(d.state, []);
  assert.equal(undoOwnTurn(d, b).said, "That change is already undone.");
});
