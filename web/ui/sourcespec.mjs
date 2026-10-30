// Source fidelity (docs/source_fidelity.md): "what goes in also goes out the same".
// Every clip or plate brought into Soundstage is probed on the server (GET /soundstage/source_spec, ffprobe) and
// its spec rides with the scene and the shot, so the NLE exports point at the camera original with its own reel,
// timecode and rate, and the Layer Pack renders at the source size and rate. Pure helpers + one fetch; no DOM.

/** Camera RAW that needs the vendor SDK to decode: Soundstage works from a proxy and keeps the link. */
export const CAMERA_RAW = { ".r3d": "RED R3D", ".braw": "Blackmagic RAW", ".ari": "ARRIRAW", ".arx": "ARRIRAW HDE",
  ".crm": "Canon Cinema RAW Light", ".nev": "Nikon N-RAW" };

/** "RED R3D" for a camera RAW file name, else null. */
export function cameraRaw(name) {
  const m = /\.[a-z0-9]+$/i.exec(String(name || ""));
  return (m && CAMERA_RAW[m[0].toLowerCase()]) || null;
}

/** The file picker accept list, camera RAW included (picked RAW asks for its proxy next). */
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.mkv,.mxf,.m4v," + Object.keys(CAMERA_RAW).join(",");

const fpsLabel = (f) => (Math.abs(f - Math.round(f)) > 1e-3 ? String(Number(f.toFixed(3))) : String(Math.round(f)));

/** "Source: 3840×2160 · 23.976 · ProRes 4444 · Rec.709 · 10-bit" (the server's line when it sent one). */
export function sourceLine(spec) {
  if (!spec || typeof spec !== "object") return "";
  if (spec.line) return spec.line;
  const bits = [];
  if (spec.width && spec.height) bits.push(`${spec.width}×${spec.height}`);
  if (Number(spec.fps)) bits.push(fpsLabel(Number(spec.fps)));
  if (spec.codec_label || spec.codec) bits.push(spec.codec_label || spec.codec);
  if (spec.colour) bits.push(spec.colour);
  if (spec.bit_depth) bits.push(`${spec.bit_depth}-bit`);
  if (spec.tc_start && spec.tc_start !== "00:00:00:00") bits.push(`TC ${spec.tc_start}`);
  let line = `Source: ${bits.join(" · ") || String(spec.camera_original || spec.path || spec.file || "?").split("/").pop()}`;
  if (spec.proxy) line += ". Working from a proxy; your export relinks to the camera original.";
  return line;
}

/**
 * Probe a file the server already has: {filename, subfolder?, type? (input|output), original? (camera RAW name it is
 * a proxy of)} -> the spec, or null when the server can't say (older server, no ffprobe).
 */
export async function fetchSourceSpec(api, { filename, subfolder = "", type = "input", original = "" }) {
  if (!filename) return null;
  const q = new URLSearchParams({ filename, subfolder, type });
  if (original) q.set("original", original);
  try {
    const r = await api.fetchApi(`/soundstage/source_spec?${q}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j && !j.error ? j : null;
  } catch {
    return null;
  }
}

/** Explain a camera RAW pick in plain words (the UI then asks for the proxy). */
export const rawExplainer = (name) =>
  `${name} is ${cameraRaw(name)}: Soundstage can't decode it without the camera maker's SDK. Pick the proxy made from it ` +
  "(ProRes, DNxHR or H.264). Working from a proxy; your export relinks to the camera original.";
