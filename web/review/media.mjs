// Loading review clips so they can be scrubbed to any frame.
//
// Why: a <video> can only jump to a time inside its `seekable` ranges. A server that ignores HTTP Range requests
// (Python's http.server, which serves the local test build; some proxies) gives a video whose seekable range is [0, 0]:
// every `currentTime = t` silently snaps back to 0, so the layer sits on frame 0 while the others move. That is what
// froze the Draft layer in the old Review slider. Reading the clip into memory once (a blob: URL) makes every frame
// seekable whatever the server does, and lets us read the real fps / frame count from the MP4 header.
import { mp4Info } from "./mp4info.mjs";

export const MAX_BLOB_BYTES = 768 * 1024 * 1024;   // bigger than this streams from its URL instead (seek may be limited)

/** True when the video can seek across its whole length (false on a server without Range support). */
export function coversDuration(video) {
  const d = video?.duration;
  if (!(d > 0) || !Number.isFinite(d)) return true;   // not known yet / a live stream: nothing to judge
  const s = video.seekable;
  if (!s || !s.length) return false;
  return s.start(0) <= 0.05 && s.end(s.length - 1) >= d - 0.1;
}

const objectURL = (blob) => (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : null);

/**
 * Read a clip (a URL or a File/Blob) into a seekable blob: URL, plus what its header says.
 * @returns {Promise<{ src:string, info:object|null, blob:boolean, revoke:()=>void }>}
 */
export async function loadClip(source, { fetchImpl = globalThis.fetch, maxBytes = MAX_BLOB_BYTES } = {}) {
  const none = () => {};
  if (typeof source !== "string") {   // a dropped File / Blob
    const buf = await source.arrayBuffer();
    const src = objectURL(source);
    return { src, info: mp4Info(buf), blob: true, revoke: () => { try { URL.revokeObjectURL(src); } catch { /* gone */ } } };
  }
  if (source.startsWith("blob:") || source.startsWith("data:")) return { src: source, info: null, blob: true, revoke: none };
  try {
    const res = await fetchImpl(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = +res.headers?.get?.("content-length") || 0;
    if (len > maxBytes) { try { res.body?.cancel?.(); } catch { /* fine */ } return { src: source, info: null, blob: false, revoke: none }; }
    const buf = await res.arrayBuffer();
    const type = res.headers?.get?.("content-type") || "video/mp4";
    const src = objectURL(new Blob([buf], { type }));
    if (!src) return { src: source, info: mp4Info(buf), blob: false, revoke: none };
    return { src, info: mp4Info(buf), blob: true, revoke: () => { try { URL.revokeObjectURL(src); } catch { /* gone */ } } };
  } catch {
    return { src: source, info: null, blob: false, revoke: none };   // let the <video> try the URL itself
  }
}
