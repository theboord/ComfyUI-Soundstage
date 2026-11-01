// Film lights over time (Milestone 26): a light's intensity, colour temperature (K), cone angle and softness can be
// keyed (objparts.mjs channels on the light: l.parts), and a light can flicker (candle, failing fluorescent, TV,
// lightning, strobe, police, slow pulse), deterministically: frame f always gives the same level, so every render of
// a shot flickers the same. A practical (the lamp is in shot) gets a lit bulb the clay guide shows; motivated and
// practical lights are said as such in the lighting note. Applied to the built three.js lights before every render.
import * as THREE from "../vendor/three.module.min.mjs";
import { LIGHT_TYPES, kelvinToColor } from "./lighting.mjs";
import { partAt, flickerAt, policeColourAt } from "./objparts.mjs";

const DEG = Math.PI / 180;

/** The values a light plays at a frame: {intensity, kelvin, angle, softness, level (flicker), colour}. */
export function lightAt(l, frame, fps = 24) {
  const spec = LIGHT_TYPES[l.type] || LIGHT_TYPES.key;
  const val = (ch, d) => { const v = partAt(l, ch, frame); return v === null || v === undefined ? d : v; };
  const intensity = val("intensity", l.intensity ?? spec.intensity);
  const kelvin = val("kelvin", l.kelvin ?? spec.kelvin);
  const angle = val("angle", l.angle ?? spec.angle);
  const softness = val("softness", l.softness ?? spec.softness);
  const flicker = val("flicker", "off"), amt = val("flicker_amt", 0.6);
  const seed = [...String(l.id || "")].reduce((n, c) => n + c.charCodeAt(0), 0) % 29;
  const level = flickerAt(flicker, frame, fps, amt, seed);
  const police = flicker === "police" ? policeColourAt(frame / fps) : null;
  return { intensity, kelvin, angle, softness, flicker, level, police, motivation: val("motivation", "film") };
}

/** Push every light's keyed / flickering values into its three.js light (and its practical bulb). */
export function apply(st) {
  const lights = st.state.lighting?.lights || [];
  // Bulbs live in the scene by light id (the lights themselves are rebuilt on every edit).
  const bulbs = (st._bulbs ||= new Map());
  for (const [id, b] of bulbs) if (!lights.some((x) => x.id === id && x.parts)) { b.removeFromParent(); bulbs.delete(id); }
  if (!st.lightObjs?.length || !lights.length) return;
  const fps = st.state.shot?.fps || 24, f = st.frame || 0;
  for (const o of st.lightObjs) {
    const l = lights.find((x) => x.id === o.id);
    if (!l || !l.parts) continue;
    o.bulb = bulbs.get(l.id);
    const v = lightAt(l, f, fps);
    const point = !!o.light.isPointLight;
    o.light.intensity = v.intensity * (point ? 3 : 5) * v.level;
    o.light.color.copy(v.police != null ? new THREE.Color(v.police) : kelvinToColor(v.kelvin));
    if (!point) { o.light.angle = Math.min(89, v.angle) * DEG; o.light.penumbra = Math.max(0, Math.min(1, v.softness)); }
    // A practical shows in shot: a small glowing bulb at the light, lit in Clay and Color.
    if (v.motivation === "practical" && !o.bulb) {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.5 });
      m.allowOverride = false;
      o.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), m);
      o.bulb.userData.lightBulb = true;
      o.bulb.castShadow = false;
      st.scene.add(o.bulb);
      bulbs.set(l.id, o.bulb);
    }
    if (o.bulb) {
      o.bulb.visible = v.motivation === "practical";
      o.bulb.position.copy(o.light.position);
      o.bulb.material.emissive.copy(o.light.color);
      o.bulb.material.emissiveIntensity = 1.6 * Math.min(2, v.level * (v.intensity / Math.max(0.1, LIGHT_TYPES[l.type]?.intensity || 1)));
    }
  }
}

/** Words for the lighting note: "a practical warm tungsten lamp, flickering like a candle". */
export function lightWords(l, frame = 0, fps = 24) {
  const v = lightAt(l, frame, fps);
  const out = [];
  if (v.motivation === "practical") out.push("a practical lamp in shot");
  else if (v.motivation === "motivated") out.push("motivated light");
  const fw = { candle: "flickering like a candle flame", fluorescent: "a failing fluorescent stuttering", tv: "the shifting glow of a TV",
    lightning: "lightning flashes", strobe: "a hard strobe", police: "red and blue police light washing over", pulse: "a slow pulse" }[v.flicker];
  if (fw) out.push(fw);
  const keys = l.parts?.intensity;
  if (keys?.length > 1) {
    const a = keys[0].v, b = keys[keys.length - 1].v;
    if (b < a * 0.5) out.push("dimming down"); else if (b > a * 1.5) out.push("brightening up");
  }
  return out.join(", ");
}
