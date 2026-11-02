// The cases pinned in tests/js/fixtures/gfx_states.json: every template and variant, some moved, some recoloured.
// Both twins (web/cut/gfx.mjs, soundstage/cut/gfx.py) must produce these ops and cues exactly.
import { TEMPLATES } from "../../../web/cut/gfx.mjs";

export function gfxCases() {
  const out = [];
  let k = 0;
  for (const [tpl, d] of Object.entries(TEMPLATES)) {
    for (const v of d.variants) {
      k++;
      out.push({ id: `${tpl}_${v}`, template: tpl, variant: v, start_frame: 10 * k, frames: d.frames + (k % 3) * 6,
        ...(k % 2 ? { x: 24, y: -16 } : {}), ...(k % 4 === 1 ? { color: "#ffffff", accent: "#e39a40", blue: "anything" } : {}),
        ...(tpl === "kinetic" && v === "over" ? { text: "One two three four" } : {}),
        ...(tpl === "title" && v === "over" ? { text: "Turn it into\na 3D set." } : {}),
        ...(tpl === "callout" && v === "ring" ? { rect: [80, 60, 1400, 500, 12] } : {}),
        ...(tpl === "callout" && v === "click" ? { rect: [300.4, 120.5, 180, 40, 20] } : {}),
        ...(["pip", "dual", "device", "split"].includes(tpl) ? { a: { shot_id: "s1", in: 12 }, ...(tpl === "dual" ? { b: { shot_id: "s2", in: 3 } } : {}) } : {}) });
    }
  }
  out.push({ id: "bare", template: "nope", frames: 2, text: "Hello" });
  return out;
}

export const frames = (n) => [0, 1, 3, 4.375, 7, 10, 13.5, 14, 20, 30, n - 24, n - 14, n - 10, n - 8, n - 5, n - 1];
