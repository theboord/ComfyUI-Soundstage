// "Film a move": the phone viewfinder records a real clip with the phone's own camera (MediaRecorder) and hands it to the
// desktop App, where it lands as Capture motion (SAM 3D Body onto a person), a Real performance (body, face and voice
// drive a character) or Footage (Ripple / Recast). The clip goes up to POST /soundstage/vcam/clip with the clip code
// the desktop's QR carries (soundstage/vcam.py) and only over https: phones refuse the camera on plain http, and the
// LAN bridge (tools/vcam_bridge.py) is the https way in. No imports: the viewfinder and the desktop both use it.

export const DESTS = [
  ["motion", "Capture motion", "Your movement onto a person on the set (SAM 3D Body)"],
  ["performance", "Real performance", "Your body, face and voice drive a character"],
  ["footage", "Footage", "Keep the real clip: Ripple or Recast it"],
];
export const MAX_SECONDS = 60;
export const MAX_BYTES = 300 * 1024 * 1024;
const MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus", "video/webm"];

/** The URL with the clip code added (the desktop's QR). */
export function withClipCode(url, code) {
  if (!code) return String(url);
  const u = String(url);
  return `${u}${u.includes("?") ? "&" : "?"}clip=${encodeURIComponent(code)}`;
}

/** The clip code from the viewfinder's own address (?clip=), else null. */
export function clipCodeFrom(search) {
  const v = new URLSearchParams(String(search || "")).get("clip");
  return v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** The first recording format this phone supports (iPhone: MP4/H.264; Android: WebM), or "" for the default. */
export function pickMime(isSupported) {
  for (const m of MIMES) { try { if (isSupported(m)) return m; } catch { /* */ } }
  return "";
}

/** Can this page film? true, or why not, in plain words. */
export function canFilm({ secure = false, media = false, recorder = false, code = null } = {}) {
  if (!secure) return "Film a move needs the https address: run tools/vcam_bridge.py on the computer and scan its QR again";
  if (!media || !recorder) return "this browser can't record video (try Safari on iPhone or Chrome on Android)";
  if (!code) return "scan the QR code on the computer again (this link has no clip code)";
  return true;
}

export function uploadUrl({ code, device = "", dest = "motion", name = "move" }) {
  const q = new URLSearchParams({ code, device, dest: DESTS.some((d) => d[0] === dest) ? dest : "motion", name: String(name).slice(0, 40) });
  return `/soundstage/vcam/clip?${q}`;
}

export const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const CSS = `
#film { position:fixed; inset:0; z-index:50; background:#000; display:none; }
#film.on { display:block; }
#film video { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; }
#film .bar { position:absolute; left:calc(12px + var(--safe-l, 0px)); right:calc(12px + var(--safe-r, 0px)); top:calc(8px + var(--safe-t, 0px));
  display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
#film .seg { display:flex; border-radius:999px; overflow:hidden; }
#film .seg button, #film .x { background:rgba(14,12,18,.62); color:#f3f1f4; border:1px solid rgba(255,255,255,.16); padding:7px 11px; font:600 12px system-ui; }
#film .seg button[aria-pressed=true] { color:#111; background:#f2ff59; }
#film .x { border-radius:999px; margin-left:auto; }
#film .rec { position:absolute; right:calc(18px + var(--safe-r, 0px)); top:50%; transform:translateY(-50%); width:68px; height:68px; border-radius:50%;
  border:4px solid #fff; background:transparent; padding:0; }
#film .rec i { display:block; margin:auto; width:52px; height:52px; border-radius:50%; background:#ff3b30; transition:all .15s; }
#film.recording .rec i { width:26px; height:26px; border-radius:6px; }
#film .msg { position:absolute; left:50%; bottom:calc(14px + var(--safe-b, 0px)); transform:translateX(-50%); max-width:86%;
  background:rgba(14,12,18,.78); color:#f3f1f4; border-radius:12px; padding:8px 12px; font:13px/1.35 system-ui; text-align:center; }
#film .tc { color:#ff3b30; font:700 14px ui-monospace, monospace; display:none; }
#film.recording .tc { display:inline; }
`;

/**
 * The phone side: a full-screen camera with a destination switch and a record button. Mount once; open() shows it.
 * opts = {doc, device, code, fetch, toast(msg), onSent(info)}
 */
export class FilmPanel {
  constructor({ doc = document, device = "phone", code = null, fetchFn = (...a) => fetch(...a), toast = () => {}, onSent = () => {} } = {}) {
    Object.assign(this, { doc, device, code, fetchFn, toast, onSent });
    this.dest = "motion";
    this.stream = null; this.rec = null; this.chunks = []; this.t0 = 0; this.timer = 0;
    if (!doc.getElementById("ss-film-css")) { const s = doc.createElement("style"); s.id = "ss-film-css"; s.textContent = CSS; doc.head.append(s); }
    const el = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
    this.video = el("video", { playsinline: "", muted: "", autoplay: "" });
    this.video.muted = true;
    this.segBtns = DESTS.map(([k, label, tip]) => { const b = el("button", { type: "button", "aria-pressed": String(k === this.dest), title: tip }, label); b.onclick = () => this.setDest(k); return b; });
    this.tc = el("span", { class: "tc" }, "0:00");
    this.close = el("button", { type: "button", class: "x" }, "Done");
    this.recBtn = el("button", { type: "button", class: "rec", "aria-label": "Record a clip" }, el("i"));
    this.msg = el("div", { class: "msg" }, "Film yourself or someone who agreed. Head to toe for action, chest up for dialogue.");
    this.root = el("div", { id: "film", role: "dialog", "aria-label": "Film a move" }, this.video,
      el("div", { class: "bar" }, el("div", { class: "seg", role: "group", "aria-label": "Send it as" }, ...this.segBtns), this.tc, this.close), this.recBtn, this.msg);
    doc.body.append(this.root);
    this.close.onclick = () => this.hide();
    this.recBtn.onclick = () => (this.rec?.state === "recording" ? this.stop() : this.start());
  }

  setDest(k) { this.dest = k; this.segBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(DESTS[i][0] === k))); }
  say(m) { this.msg.textContent = m; }

  async open() {
    const win = this.doc.defaultView || globalThis;
    const ok = canFilm({ secure: !!win.isSecureContext, media: !!win.navigator?.mediaDevices?.getUserMedia, recorder: typeof win.MediaRecorder === "function", code: this.code });
    if (ok !== true) { this.toast(ok); return false; }
    this.root.classList.add("on");
    try {
      this.stream = this.stream || await win.navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
    } catch (e) { this.say(`The camera didn't open (${e.name || e.message}). Allow camera and microphone for this page.`); }
    return true;
  }

  hide() { if (this.rec?.state === "recording") this.stop(); this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.root.classList.remove("on"); }

  start() {
    if (!this.stream) return;
    const win = this.doc.defaultView || globalThis;
    const mime = pickMime((m) => win.MediaRecorder.isTypeSupported(m));
    this.chunks = [];
    this.rec = new win.MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 12e6 } : { videoBitsPerSecond: 12e6 });
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this.send();
    this.rec.start(1000);
    this.t0 = performance.now();
    this.root.classList.add("recording");
    this.timer = setInterval(() => {
      const s = (performance.now() - this.t0) / 1000;
      this.tc.textContent = fmtSecs(s);
      if (s >= MAX_SECONDS) this.stop();
    }, 250);
    this.say("Recording… tap ■ to stop.");
  }

  stop() { clearInterval(this.timer); this.root.classList.remove("recording"); try { this.rec?.stop(); } catch { /* */ } }

  async send() {
    const type = (this.rec?.mimeType || this.chunks[0]?.type || "video/mp4").split(";")[0];
    const blob = new Blob(this.chunks, { type });
    if (blob.size > MAX_BYTES) { this.say("That clip is over 300 MB: film a shorter move."); return; }
    this.say(`Sending ${(blob.size / 1e6).toFixed(1)} MB to the computer…`);
    try {
      const r = await this.fetchFn(uploadUrl({ code: this.code, device: this.device, dest: this.dest, name: "move" }),
        { method: "POST", headers: { "Content-Type": type }, body: blob, credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const label = DESTS.find((d) => d[0] === this.dest)?.[1] || "a clip";
      this.say(`Sent. It's on the computer as ${label}: finish it there.`);
      this.toast(`Clip sent as ${label}`);
      this.onSent(j);
    } catch (e) { this.say(`Couldn't send it: ${e.message}`); }
  }
}
