// node --test tests/js/canvasui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { layoutPref, setLayoutPref, rememberFlag } from "../../web/ui/canvasui.mjs";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("the canvas layout is the default; Classic is remembered", () => {
  const s = mem();
  assert.equal(layoutPref(s), "canvas");
  setLayoutPref("classic", s);
  assert.equal(layoutPref(s), "classic");
  setLayoutPref("canvas", s);
  assert.equal(layoutPref(s), "canvas");
  setLayoutPref("nonsense", s);
  assert.equal(layoutPref(s), "canvas");
});

test("blocked storage never throws and falls back to the canvas layout", () => {
  assert.equal(layoutPref(broken), "canvas");
  assert.doesNotThrow(() => setLayoutPref("classic", broken));
  assert.equal(layoutPref(undefined), "canvas");
});

test("panel flags: default until set, then remembered; blocked storage keeps the default", () => {
  const s = mem();
  const f = rememberFlag("ss_cl_x", true, s);
  assert.equal(f.get(), true);
  f.set(false);
  assert.equal(f.get(), false);
  assert.equal(rememberFlag("ss_cl_x", true, s).get(), false);
  const b = rememberFlag("ss_cl_y", false, broken);
  assert.equal(b.get(), false);
  assert.doesNotThrow(() => b.set(true));
});

test("hidden pop-over buttons stay hidden (Ripple hides Sound & music / Dialogue & voice)", async () => {
  // .ss-clpopbtn is display:flex !important, which beats the [hidden] attribute unless a rule says otherwise.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../../web/ui/canvasui.mjs", import.meta.url), "utf8");
  assert.match(css, /button\.ss-clpopbtn \{ display:flex !important/);
  assert.match(css, /button\.ss-clpopbtn\[hidden\] \{ display:none !important; \}/);
});
