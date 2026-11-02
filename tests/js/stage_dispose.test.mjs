// Removing a Soundstage node disposes its Stage. RotateTools' window key/blur listeners and the three Parts panels'
// 250 ms polls were never torn down: each removed node left them running against its dead stage (never collected).
import test from "node:test";
import assert from "node:assert/strict";
import { RotateTools } from "../../web/stage/rotate.mjs";
import { Stage } from "../../web/stage/stage.mjs";

test("RotateTools.dispose removes every window listener it added", () => {
  const g = globalThis, add0 = g.addEventListener, rem0 = g.removeEventListener;
  const b0 = RotateTools.prototype._buildRing, p0 = RotateTools.prototype._bindPointer;
  RotateTools.prototype._buildRing = RotateTools.prototype._bindPointer = () => {};
  try {
    const fns = [];
    g.addEventListener = (t, f) => fns.push(f);
    g.removeEventListener = (t, f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); };
    const rt = new RotateTools({});
    assert.equal(fns.length, 3);
    rt.dispose();
    assert.equal(fns.length, 0);
  } finally {
    g.addEventListener = add0; g.removeEventListener = rem0;
    RotateTools.prototype._buildRing = b0; RotateTools.prototype._bindPointer = p0;
  }
});

test("Stage.dispose stops the rotate tools and the Parts panels", () => {
  const seen = [];
  const st = Object.assign(Object.create(Stage.prototype), { renderer: { dispose() { seen.push("renderer"); } },
    rotTools: { dispose() { seen.push("rotate"); } }, _partsPanels: { dispose() { seen.push("parts"); } } });
  st.dispose();
  assert.deepEqual(seen.sort(), ["parts", "renderer", "rotate"]);
});
