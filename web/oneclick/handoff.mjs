// ✦ One-click › Hand-off › Send a move from your phone: a QR code for the phone viewfinder that carries a clip code, so
// the phone can Film a move (web/vcam/film.mjs) and send it here. The clip arrives as a "clip" event on the vcam channel
// and lands where the phone said: Capture motion (SAM 3D Body onto a person), Real performance (body, face and voice
// drive a character) or Footage (⑤ Motion's Ripple / Recast). Server side: /soundstage/vcam/clipcode, /clip (vcam.py).
import { registerOneClick } from "./oneclick.mjs";
import { qrSvg } from "../vcam/qr.mjs";
import { viewfinderUrl, isLoopback, VF_EVENT } from "../vcam/vfcore.mjs";
import { withClipCode, DESTS } from "../vcam/film.mjs";

let CODE = null;

/** This desktop's clip code (minted once per page; null when the server is older and has no clip route). */
export async function clipCode(api) {
  if (CODE) return CODE;
  try {
    const r = await api.fetchApi("/soundstage/vcam/clipcode", { method: "POST" });
    if (r.ok) CODE = (await r.json()).code || null;
  } catch { /* */ }
  return CODE;
}

/** The phone's address: the LAN bridge's https URL when it runs (else this page's), with the clip code. */
export async function phoneUrl(api, origin = globalThis.location?.origin || "") {
  let pair = null;
  try { pair = await (await api.fetchApi("/soundstage/vcam/pair")).json(); } catch { /* */ }
  const url = viewfinderUrl(origin + (api.api_base || ""), pair);
  return { url: withClipCode(url, await clipCode(api)), https: /^https:/.test(url), loopback: isLoopback(url), bridge: !!pair?.url };
}

/** Listen for clips the phone sends; returns the unsubscribe. */
export function listenPhoneClips(api, onClip) {
  const fn = (e) => { const d = e?.detail; if (d?.type === "clip" && d.ref) onClip(d); };
  api.addEventListener(VF_EVENT, fn);
  return () => api.removeEventListener(VF_EVENT, fn);
}

/** A clip event -> a File (fetched from /view), named like the upload. */
export async function clipFile(api, info) {
  const q = new URLSearchParams({ filename: info.name, subfolder: info.subfolder || "", type: info.kind || "input" });
  const r = await api.fetchApi(`/view?${q}`);
  if (!r.ok) throw new Error(`couldn't fetch the clip (${r.status})`);
  const blob = await r.blob();
  return new File([blob], info.name, { type: blob.type || "video/mp4" });
}

/** What a destination does, in words (the status line). */
export const destWords = (d) => (DESTS.find((x) => x[0] === d) || DESTS[0])[1];

/**
 * Land a phone clip. host = {api, say(msg), capture(file), footage(file), performance(file), ask(file)}: the App's own
 * entry points (web/soundstage.js passes them). Any that's missing falls back to ask (the "What is this video for?" card).
 */
export async function landPhoneClip(info, host) {
  const say = host.say || (() => {});
  say(`A clip arrived from ${info.device || "the phone"} (${destWords(info.dest)}): bringing it in…`);
  const go = { motion: host.capture, performance: host.performance, footage: host.footage }[info.dest] || host.ask;
  let f = null;
  // the fetch too: this runs from an event listener, so a failed /view must end in the status line, not an
  // unhandled rejection
  try { f = await clipFile(host.api, info); await (go || host.ask)(f, info); }
  catch (e) { say(`Couldn't bring in the phone's clip: ${e.message}`); }
  return f;
}

/** Real performance for the selected (or first) person, with the phone's clip already in the dialog. */
export async function openPerformanceWith(file, { api, stage, actorId, pipeline, cast, say = () => {} }) {
  if (!actorId) { say("Select the character this performance is for, then send the clip again."); return; }
  const { openPerformance } = await import("../performance/performance.mjs");
  const done = openPerformance({ api, stage, actorId, pipeline, cast, onStatus: say });
  const input = document.querySelector('.ss-perf input[type="file"]');
  if (input && typeof DataTransfer === "function") {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  }
  return done;
}

function showQr(target, ctx, info) {
  const card = document.createElement("div");
  card.className = "ss-oc-qr";
  card.setAttribute("role", "dialog");
  card.style.cssText = "position:fixed;z-index:100001;right:16px;bottom:16px;width:290px;background:#17141b;color:#ece8ee;border:1px solid rgba(242,255,89,.35);border-radius:14px;padding:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);font:13px/1.4 'Soundstage Grotesk',system-ui,sans-serif";
  const warn = !info.https ? `<div style="color:#ffb340;font-size:12px;margin-top:6px">The phone camera needs https: run <b>python3 tools/vcam_bridge.py</b> on this computer (docs/vcam.md), then open this again.</div>` : "";
  card.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-weight:600">Send a move from your phone<button aria-label="Close" style="margin-left:auto;background:none;border:0;color:#a9a3ad;font-size:18px;cursor:pointer">×</button></div>
    <div style="color:#a9a3ad;font-size:12px;margin-top:4px">Scan, tap <b>Film</b>, pick ${DESTS.map((d) => d[1]).join(" · ")}, record. It lands here.</div>
    <div style="display:grid;place-items:center;background:#fff;border-radius:10px;padding:6px;margin:8px 0">${qrSvg(info.url, { px: 236 })}</div>
    <div style="font:11px ui-monospace,Menlo,monospace;word-break:break-all;color:#cfc8d2">${info.url.replace(/[<>&]/g, "")}</div>${warn}`;
  card.querySelector("button").onclick = () => card.remove();
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  (ctx.root || document.body).append(card);
  return card;
}

registerOneClick({
  id: "phone_move", group: "Hand-off", label: "Send a move from your phone", order: 2, gpu: false,
  hint: "A QR for your phone: film a real move or performance and it lands here (Capture motion, Real performance, Footage)",
  applies: ["still", "clip"], keywords: ["phone", "qr", "film", "mirror", "capture", "record", "mocap"],
  async run(target, ctx) {
    const info = await phoneUrl(ctx.api);
    if (!CODE) throw new Error("this server needs a restart to know the phone clip route");
    showQr(target, ctx, info);
    ctx.say?.(info.https ? "Scan the QR with your phone, tap Film, record: the clip lands here." : "QR shown. The phone camera needs the https bridge (tools/vcam_bridge.py).");
    return null;
  },
});

export const HANDOFF_IDS = ["phone_move"];
