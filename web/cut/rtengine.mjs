// Soundstage real-time player engine: rendered takes play at true speed in the Cut (and any player built on it).
// Measured (D8): every take has one keyframe, so a seek costs ~5 ms per frame of distance from frame 0 (up to 580 ms).
// So the element on screen never seeks in steady play: it plays natively and follows the master clock by nudging its
// playbackRate; the next clip's element is loaded and parked on its first frame well before the edit and started
// just ahead of it. Proxies (GET /soundstage/proxy: narrow, GOP 12) make the seeks that remain (scrub, reverse, 8x)
// cheap and the files light. The pure parts (proxy URLs, the drift policy, the pre-roll plan, ProxyBook) run in node
// (tests/js/rtengine.test.mjs); RtPlayer is the thin DOM layer over a pool of <video> elements.

export const PROXY_WIDTHS = [480, 640, 960, 1280, 1920];
export const PROXY_MBPS = 6;      // a source heavier than this plays its proxy even when it is not wider than the viewer
export const LEAD_S = 1.5;        // pre-roll: the next clip is parked this far ahead of its edit...
export const LEAD_PENDING_S = 3;  // ...and this far while its media or its proxy is still on its way
// Drift in frames: within `dead` nothing happens; up to `seek` the rate is nudged min..max (until within `settle`);
// past `seek`, or after a jump (a seek, an edit, a loop) anything past `settle`, the element seeks.
export const DRIFT = { dead: 1, seek: 6, min: 0.03, max: 0.08, settle: 0.5 };
export const HOLD_FRAMES = 6;     // an element settling holds the last picture this long while playing, then clay stands in

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ema = (a, b, k) => (a == null ? b : a + (b - a) * k);
const HAVE_METADATA = 1, HAVE_CURRENT_DATA = 2;

/** The proxy width for a picture `px` device pixels wide: the next rung of PROXY_WIDTHS up (the largest past it). */
export function proxyWidth(px) {
  return PROXY_WIDTHS.find((w) => w >= px) ?? PROXY_WIDTHS[PROXY_WIDTHS.length - 1];
}

/** The width a viewer needs: its CSS width times devicePixelRatio, no more than the canvas it draws into, on the ladder. */
export function viewerWidth(cssPx, dpr = 1, cap = Infinity) {
  const px = Math.min((cssPx || 0) * (dpr || 1) || cap, cap);
  return proxyWidth(Number.isFinite(px) && px > 0 ? px : 960);
}

const VIEW = /^((?:[^?#]*\/)?)view\?([^#]*)$/;

/** The proxy route for a ComfyUI /view URL (/view, /api/view, http://host/api/view), or null for anything else (a file
 *  next to the page, a blob). Every query field is kept; w is the width asked for. */
export function proxyUrl(src, w) {
  const m = typeof src === "string" && VIEW.exec(src);
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  if (!q.get("filename")) return null;
  q.set("w", String(w));
  return `${m[1]}soundstage/proxy?${q}`;
}

/** A server URL ("/soundstage/proxy?..&v=..", API-relative as the route names it) under the API prefix `src` uses. */
function underApi(src, url) {
  if (/^[a-z]+:/i.test(url)) return url;
  return (VIEW.exec(src)?.[1] || "/") + url.replace(/^\//, "");
}

/** Play the proxy rather than the source: the source is wider than the viewer needs or heavier than PROXY_MBPS, or not
 *  known yet (renders run 1312-3328 wide; a small, light source is the exception). info: {width, bitrate}. */
export function preferProxy(info, need) {
  if (!info || !(info.width > 0)) return true;
  return info.width > need || (info.bitrate || 0) > PROXY_MBPS * 1e6;
}

/**
 * The drift policy. drift: frames the element's picture is ahead of the clock (negative: behind). Within DRIFT.dead it
 * plays at the shuttle speed; up to DRIFT.seek it nudges playbackRate 3-8 % toward the clock (and keeps nudging until
 * within DRIFT.settle, so it does not hover on the edge); past DRIFT.seek, or after a jump anything past DRIFT.settle,
 * it seeks. Returns {rate, seek, nudging}.
 */
export function driftRate(drift, speed = 1, { nudging = false, jump = false } = {}) {
  const a = Math.abs(drift);
  if (a > DRIFT.seek || (jump && a > DRIFT.settle)) return { rate: speed, seek: true, nudging: false };
  if (a <= DRIFT.settle || (!nudging && a <= DRIFT.dead)) return { rate: speed, seek: false, nudging: false };
  const k = DRIFT.min + (DRIFT.max - DRIFT.min) * clamp((a - DRIFT.dead) / (DRIFT.seek - DRIFT.dead), 0, 1);
  return { rate: speed * (1 - Math.sign(drift) * k), seek: false, nudging: true };
}

/**
 * Which spans want an element at record frame f. A span {id, key, lo, hi, src0} is on screen for lo <= f < hi and
 * shows source frame src0 + (f - lo): a clip with its transition handles, a V3 window. Returns the ones on screen (role
 * "active", src = the exact source position) then those starting within the lead, nearest first and at most `ahead`
 * of them (role "preroll", park = the source frame they start on, at = the record frame they start at): three, so two
 * half-second clips in a row still leave the one after them its full lead. With loop {start, end} the cut comes round
 * again past `end`. lead(key) is in record frames.
 */
export function planAt(spans, f, { lead = () => 0, ahead = 3, loop = null } = {}) {
  const on = [], next = [];
  for (const s of spans) {
    if (!s.key) continue;
    if (f >= s.lo && f < s.hi) { on.push({ id: s.id, key: s.key, role: "active", src: s.src0 + (f - s.lo), lo: s.src0 }); continue; }
    let at = s.lo, park = s.src0;
    if (loop && loop.end > loop.start && (at <= f || at >= loop.end)) {   // what the loop shows after it comes round
      const k0 = Math.max(s.lo, loop.start);
      if (k0 >= s.hi || k0 >= loop.end) continue;
      at = loop.end + (k0 - loop.start);
      park = s.src0 + (k0 - s.lo);
    }
    if (at > f && at - f <= lead(s.key)) next.push({ id: s.id, key: s.key, role: "preroll", park, at, lo: park });
  }
  next.sort((a, b) => a.at - b.at);
  return [...on, ...next.slice(0, ahead)];
}

/**
 * What the server says about proxies (soundstage/proxy.py), asked once per take and width and remembered for the
 * session. The probe is GET /soundstage/proxy?filename&subfolder&type&w&probe=1: JSON {status: ready | pending | error,
 * url, retry_ms} without the file. ready: play `url` (it carries the proxy's cache key, so a take re-rendered under the
 * same name is a new URL); pending, or a 202: keep the source and ask again after retry_ms (or Retry-After); error, a
 * 422 or a JSON 400 / 404: that file plays its source. A plain 404 is a server from before the route: no proxies this
 * session. A server that answers with the proxy itself plays it (the probe asks for 2 bytes of it).
 * Entries: {src, url, state: queued | probing | building | ready | none, play, info, tries}.
 */
export class ProxyBook {
  constructor({ fetch = null, timer = (fn, ms) => setTimeout(fn, ms), onChange = () => {}, parallel = 2, retryMs = 1500, maxTries = 80 } = {}) {
    this._fetch = fetch || ((...a) => globalThis.fetch(...a));
    this._timer = timer;
    this.onChange = onChange;   // (src) a take's proxy answer changed; (null) the route is missing
    this.parallel = parallel;   // probes in flight at once: the <video> elements need the sockets more
    this.retryMs = retryMs;
    this.maxTries = maxTries;
    this.noRoute = false;
    this.routeSeen = false;     // the route answered once (anything but a plain 404)
    this.map = new Map();       // proxy url -> entry
    this.queue = [];
    this.busy = 0;
  }

  /** The entry for a take at width w, probing it the first time (null: not a /view take, or no route). */
  ask(src, w) {
    if (this.noRoute) return null;
    const url = proxyUrl(src, w);
    if (!url) return null;
    let e = this.map.get(url);
    if (!e) {
      e = { src, url, state: "queued", play: null, info: null, tries: 0 };
      this.map.set(url, e);
      this.queue.push(e);
      this._pump();
    }
    return e;
  }

  /** The entry without asking. */
  peek(src, w) {
    if (this.noRoute) return null;
    const url = proxyUrl(src, w);
    return url ? this.map.get(url) || null : null;
  }

  /** The proxy would not play (a decode error): the source plays from now on. */
  fail(src, w) {
    const e = this.peek(src, w);
    if (e) { e.state = "none"; e.play = null; }
  }

  /** Stop: queued probes are dropped, pending retries do nothing, no answer is reported. */
  dispose() {
    this.disposed = true;
    this.queue.length = 0;
  }

  _pump() {
    if (this.disposed) return;
    // one at a time until the route has answered once: a server without it says so with a single 404
    while (this.busy < (this.routeSeen ? this.parallel : 1) && this.queue.length) {
      const e = this.queue.shift();
      if (e.state !== "queued" || this.noRoute) continue;
      this.busy++;
      this._probe(e).catch(() => this._set(e, "none")).finally(() => { this.busy--; this._pump(); });
    }
  }

  async _probe(e) {
    e.state = "probing";
    e.tries++;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let r, json = null;
    try {
      r = await this._fetch(`${e.url}&probe=1`, { headers: { Range: "bytes=0-1" }, cache: "no-store", signal: ctl?.signal });
      if (/json/i.test(r.headers?.get?.("content-type") || "")) json = await r.json().catch(() => null);
      else ctl?.abort();   // the proxy itself: its <video> fetches it in ranges
    } catch {
      return this._set(e, "none");
    }
    if (r.status === 404 && !json) {
      this.noRoute = true;   // a server from before the route: no proxies this session (the sources play)
      for (const x of this.map.values()) if (x.state !== "ready") x.state = "none";
      this.queue.length = 0;
      return this.onChange(null);
    }
    this.routeSeen = true;
    const st = String(json?.status || "").toLowerCase();
    if (!r.ok || /^(error|none|skip)$/.test(st)) return this._set(e, "none");   // that file only: its source plays
    if (r.status === 202 || /^(building|pending|queued|running)$/.test(st)) {
      if (e.tries >= this.maxTries) return this._set(e, "none");
      e.state = "building";
      const ms = clamp(Number(json?.retry_ms) || Number(r.headers?.get?.("retry-after")) * 1000 || this.retryMs, 250, 15000);
      this._timer(() => {
        if (e.state !== "building" || this.noRoute || this.disposed) return;
        e.state = "queued";
        this.queue.push(e);
        this._pump();
      }, ms);
      return;
    }
    if (!json) return this._set(e, "ready", r.redirected && r.url ? r.url : e.url);
    const play = json.url ? underApi(e.src, json.url) : json.filename ? e.url.replace(/soundstage\/proxy\?.*$/, `view?${new URLSearchParams({
      filename: json.filename, subfolder: json.subfolder || "", type: json.type || "output" })}`) : st === "ready" ? e.url : null;
    this._set(e, play ? "ready" : "none", play, json.source || null);
  }

  _set(e, state, play = null, info = null) {
    e.state = state;
    e.play = play;
    if (info) e.info = info;
    if (!this.disposed) this.onChange(e.src);
  }
}

/**
 * The <video> pool and how it is steered: the thin DOM layer. Each tick: begin(ctx), want() for every picture on screen
 * (role "active", returns the element once it presents that clip, else null) and every clip to get ready (role
 * "preroll"), then end(), which pauses the rest. Elements are keyed by media URL (a second one when a take is cut
 * against itself), at most `max`, the least recently wanted evicted. ctx: {mode: play | still | shuttle, speed, rate,
 * now, frame, clock (performance time -> record frame), jump (the clock just jumped), audio (take sound on)}.
 */
export class RtPlayer {
  constructor({ onChange = () => {}, onFail = () => {}, create = () => document.createElement("video"), now = () => performance.now(),
                fetch = null, timer, need = () => 960, max = 6 } = {}) {
    this.onChange = onChange;   // a picture or a proxy became ready: redraw
    this.onFail = onFail;       // a source would not load (url): the caller falls down the ladder
    this.create = create;
    this.now = now;
    this.need = need;           // the proxy width the viewer needs (viewerWidth)
    this.max = max;
    this._fetch = fetch || ((...a) => globalThis.fetch(...a));
    this.recs = new Map();      // source url -> {url, ok, info, blob}
    this.slots = [];
    this.tick = 0;
    this.tickMs = 1000 / 60;   // measured between begin() calls
    this.ctx = { mode: "still", speed: 0, rate: 0, now: 0, frame: 0, clock: () => 0, jump: false, audio: false };   // begin() sets it
    this.book = new ProxyBook({ fetch: this._fetch, timer, onChange: () => this.onChange() });
    this.probing = false;       // proxies are asked for once the viewer is on screen
    this.stats = { seeks: { active: 0, preroll: 0, still: 0, shuttle: 0 }, nudges: 0, starts: 0, loads: 0, evictions: 0 };
  }

  /** The media set after an edit: a record for every take a clip or a window can play (no element until one is
   *  wanted); takes no longer in the set are released with their elements. A take that would not load keeps its
   *  record (ok false) for the session, so failed() stays true and its clips stay down the ladder: never reloaded. */
  sync(urls) {
    const keep = new Set(urls);
    for (const u of keep) this.rec(u);
    for (const [u, r] of this.recs) {
      if (keep.has(u)) continue;
      for (const s of this.slots) if (s.key === u) this._unload(s);
      if (r.ok === false) continue;
      this.recs.delete(u);
      if (r.blob && r.blob !== "pending") URL.revokeObjectURL(r.blob);
    }
  }

  rec(url) {
    let r = this.recs.get(url);
    if (!r) {
      r = { url, ok: null, info: null, blob: null };
      this.recs.set(url, r);
      if (this.probing) this.book.ask(url, this.need());
    }
    return r;
  }

  /** Start asking for proxies (the viewer is on screen), for every take in the set. */
  probe() {
    if (this.probing) return;
    this.probing = true;
    for (const u of this.recs.keys()) this.book.ask(u, this.need());
  }

  failed(url) { return this.recs.get(url)?.ok === false; }

  /** Loaded once and its proxy question settled: the plain pre-roll lead is enough for it. */
  ready(url) {
    if (!this.recs.get(url)?.ok) return false;
    const px = this.book.peek(url, this.need());
    return !px || px.state === "ready" || px.state === "none";
  }

  begin(ctx) {
    const dt = ctx.now - this.ctx.now;
    if (dt > 0 && dt < 100) this.tickMs = ema(this.tickMs, dt, 0.2);   // starts are timed to the nearest tick
    this.tick++;
    this.ctx = { ...this.ctx, ...ctx };
  }

  end() {
    for (const s of this.slots) if (s.tick !== this.tick && s.el && !s.el.paused) s.el.pause();
  }

  pause() { for (const s of this.slots) if (s.el && !s.el.paused) s.el.pause(); }

  dispose() {
    this.disposed = true;   // no element is created again; the proxy book stops asking
    this.book.dispose();
    for (const s of this.slots) { this._unload(s); if (s.vfc != null) s.el.cancelVideoFrameCallback?.(s.vfc); }
    this.slots = [];
    for (const r of this.recs.values()) if (r.blob && r.blob !== "pending") URL.revokeObjectURL(r.blob);
    this.recs.clear();
  }

  /** The element wanted as `id` this tick (drawable or not). */
  el(id) { return this._mine(id)?.el || null; }

  /** The picture for `id` plays the take's proxy. */
  proxied(id) {
    const s = this._mine(id);
    return !!s?.url && s.url !== s.key && s.url !== this.recs.get(s.key)?.blob;
  }

  /** Why `id` drew nothing this tick: "settle" (it has had a picture and is seeking, starting or swapping to its
   *  proxy: hold the last one; a seeking element drops its readyState) or "load" (nothing to show yet). */
  waiting(id) {
    const s = this._mine(id);
    return s && (s.loaded || s.swap) ? "settle" : "load";
  }

  /**
   * Want the take `key` as `id` this tick. d: {role: "active", src (exact source frame now), lo (first source frame of
   * this showing), still (a held frame), silent (never heard: a V3 window), volume (0..1, its sound under a transition), stale (draw a picture still
   * settling)} or {role: "preroll", park, at, lo}. Returns the element when it presents this clip, else null.
   */
  want(id, key, d) {
    const { mode, rate } = this.ctx;
    const active = d.role === "active";
    // A take already playing into this clip (a through edit) needs no element of its own: the playing one carries on.
    if (!active && this.slots.some((x) => x.key === key && x.tick === this.tick && x.role === "active" && x.el && !x.el.paused
      && Math.abs(x.src + (d.at - this.ctx.frame) - d.park) <= 1)) return null;
    if (this.disposed || this.rec(key).ok === false) return null;   // a take that would not load is never loaded again
    const s = this._slot(id, key, d);
    if (!s) return null;
    Object.assign(s, { id, tick: this.tick, role: d.role, src: active ? d.src : d.park, lo: d.lo ?? 0 });
    const el = s.el;
    const url = this._playUrl(key);
    // Never swap the picture that is playing on screen; anywhere else a proxy that became ready takes over.
    if (s.url !== url && !(active && mode === "play" && s.url && el.readyState >= HAVE_CURRENT_DATA && !el.paused)) this._load(s, url);
    const audible = active && this.ctx.audio && !d.still && !d.silent;   // silent: a V3 window (the render has no sound for it)
    if (el.muted !== !audible) el.muted = !audible;
    if (audible) el.volume = clamp(d.volume ?? 1, 0, 1);
    if (el.readyState < HAVE_METADATA) return null;
    if (!active) { this._park(s, d); return null; }
    const shows = this._drawable(s);   // the frame it shows now, before a new seek moves it on (scrub, reverse, 8x)
    const last = Math.ceil(el.duration * rate - 1e-3) - 1;   // the media's last frame (a take can end short of its clip)
    if (mode === "play" && d.src >= last - 1 && this._pos(s) >= last) { /* played to its end: its last frame holds */ }
    else if (mode !== "play" || d.still || d.src >= last) this._show(s, Math.min(d.src, last));
    else this._steer(s, d.src);
    if (shows || this._drawable(s)) return el;
    return d.stale && s.loaded ? el : null;
  }

  _mine(id) { return this.slots.find((x) => x.id === id && x.tick === this.tick) || null; }

  _pos(s) { return s.el.readyState >= HAVE_METADATA ? s.el.currentTime * this.ctx.rate : NaN; }

  _frameNo(t) { return Math.floor(t * this.ctx.rate + 1e-4); }

  _drawable(s) {
    const el = s.el;
    return el.readyState >= HAVE_CURRENT_DATA && !el.seeking && s.shown?.gen === s.gen && s.shown.frame >= s.lo - 1;
  }

  /** The source the element should load: the proxy when ready and worth it (always for reverse / 8x), else the take. */
  _playUrl(key) {
    const r = this.recs.get(key);
    if (r?.blob && r.blob !== "pending") return r.blob;
    const px = this.probing ? this.book.ask(key, this.need()) : this.book.peek(key, this.need());   // the width may have changed
    if (px?.state === "ready" && (this.ctx.mode === "shuttle" || preferProxy(r?.info || px.info, this.need()))) return px.play;
    return key;
  }

  _slot(id, key, d) {
    const free = (x) => x.tick !== this.tick;
    const want = d.role === "active" ? d.src : d.park;
    let s = this.slots.find((x) => x.id === id && x.key === key && free(x));
    // the element already playing this take where the clip needs it (a through edit, the same take cut on)
    if (!s && d.role === "active") s = this.slots.find((x) => x.key === key && free(x) && x.el && !x.el.paused && Math.abs(this._pos(x) - want) <= 1.5);
    if (!s) s = this.slots.filter((x) => x.key === key && free(x)).sort((a, b) => Math.abs(this._pos(a) - want) - Math.abs(this._pos(b) - want))[0];
    if (!s) s = this.slots.find((x) => !x.key && free(x));
    if (!s && this.slots.length < this.max) s = this._new();
    if (!s) {
      s = this.slots.filter(free).sort((a, b) => a.tick - b.tick)[0];
      if (!s) return null;
      this._unload(s);
      this.stats.evictions++;
    }
    if (s.key !== key) { this._unload(s); s.key = key; }
    return s;
  }

  _new() {
    const el = this.create();
    el.muted = true;
    el.preload = "auto";
    el.playsInline = true;
    const s = { el, key: null, url: null, id: null, role: null, tick: 0, gen: 0, shown: null, src: 0, lo: 0, lat: 40, seekLat: 80,
                seekAt: 0, start: null, nudging: false, drift: 0, swap: false, loaded: false, vfc: null };
    el.addEventListener("loadedmetadata", () => this._meta(s));
    el.addEventListener("loadeddata", () => this._loaded(s));
    el.addEventListener("seeked", () => this._seeked(s));
    el.addEventListener("error", () => this._error(s));
    if (el.requestVideoFrameCallback) {
      const cb = (now, md) => { this._frame(s, now, md); s.vfc = el.requestVideoFrameCallback(cb); };
      s.vfc = el.requestVideoFrameCallback(cb);
    }
    this.slots.push(s);
    return s;
  }

  _load(s, url) {
    s.swap = !!s.url && s.shown != null;   // the same take swapping to its proxy: hold its picture meanwhile
    s.loaded = false;
    s.url = url;
    s.gen++;
    s.shown = null;
    s.start = null;
    s.nudging = false;
    if (s.el.dataset) s.el.dataset.take = s.key;   // the take it plays, when its src is the proxy (for QA tools)
    s.el.src = url;
    this.stats.loads++;
  }

  _unload(s) {
    if (s.url) {
      s.el.pause();
      s.el.removeAttribute("src");
      s.el.load();
    }
    s.key = s.url = s.id = null;
    s.gen++;
    s.shown = null;
    s.start = null;
    s.swap = s.loaded = false;
  }

  _meta(s) {
    const r = this.recs.get(s.key), el = s.el;
    if (!r || s.url !== s.key) return;   // a proxy or a blob says nothing about the source
    r.info = { width: el.videoWidth, height: el.videoHeight, duration: el.duration };
    // Narrow enough already: light enough too (PROXY_MBPS)? Its size (one byte asked for) over its length says.
    if (el.videoWidth <= this.need() && el.duration > 0 && proxyUrl(r.url, this.need()) && !this.book.noRoute) {
      const info = r.info, ctl = typeof AbortController === "function" ? new AbortController() : null;
      Promise.resolve(this._fetch(r.url, { headers: { Range: "bytes=0-0" }, signal: ctl?.signal })).then((x) => {
        ctl?.abort();   // its headers are all this needs
        const n = Number(/\/(\d+)\s*$/.exec(x.headers?.get?.("content-range") || "")?.[1] || x.headers?.get?.("content-length"));
        if (n > 1) { info.bitrate = (n * 8) / info.duration; this.onChange(); }
      }).catch(() => {});
    }
    // A server without HTTP Range makes the video unseekable: play it from memory instead.
    const sk = el.seekable;
    if (!r.blob && sk && !(sk.length && sk.end(sk.length - 1) >= el.duration - 0.05)) {
      r.blob = "pending";
      Promise.resolve(this._fetch(r.url)).then((x) => (x.ok ? x.blob() : Promise.reject(x.status))).then((b) => {
        if (this.recs.get(r.url) !== r) return;
        r.blob = URL.createObjectURL(b);
        this.onChange();
      }).catch(() => { r.blob = null; });
    }
  }

  _loaded(s) {
    const r = this.recs.get(s.key);
    if (r) r.ok = true;   // the take or its proxy decodes: it plays
    s.swap = false;
    s.loaded = true;
    if (!s.el.seeking) s.shown = { gen: s.gen, frame: this._frameNo(s.el.currentTime), at: this.now() };
    this.onChange();
  }

  _seeked(s) {
    if (s.seekAt) { s.seekLat = clamp(ema(s.seekLat, this.now() - s.seekAt, 0.5), 5, 1000); s.seekAt = 0; }
    s.shown = { gen: s.gen, frame: this._frameNo(s.el.currentTime), at: this.now() };
    this.onChange();
  }

  /** requestVideoFrameCallback: the frame now on screen, and the start latency the first new frame after play() shows. */
  _frame(s, now, md) {
    if (s.el.seeking || !s.url) return;
    const at = md.expectedDisplayTime ?? now;
    s.shown = { gen: s.gen, frame: this._frameNo(md.mediaTime), at };
    if (s.start && md.mediaTime > s.start.t + 1e-4) {
      const lat = at - s.start.at - ((md.mediaTime - s.start.t) * 1000) / (s.el.playbackRate || 1);
      s.lat = clamp(ema(s.lat, lat, 0.5), 0, 300);
      s.start = null;
    }
  }

  _error(s) {
    const r = this.recs.get(s.key);
    if (!r || !s.url) return;
    if (s.url !== s.key) {   // the proxy (or the in-memory copy) would not play: back to the take itself
      if (s.url === r.blob) r.blob = null; else this.book.fail(s.key, this.need());
      s.url = null;
      this.onChange();
      return;
    }
    r.ok = false;
    this.onFail(s.key);
    this.onChange();
  }

  _seek(s, pos, why) {
    const el = s.el, rate = this.ctx.rate, dur = el.duration;
    const end = Number.isFinite(dur) && dur > 0 ? Math.max(0, dur - 0.004) : Infinity;   // just inside: the last frame
    s.gen++;
    s.seekAt = this.now();
    s.start = null;
    s.nudging = false;
    s.drift = 0;
    el.currentTime = clamp(pos / rate, 0, end);
    this.stats.seeks[why]++;
  }

  _start(s) {
    const el = s.el;
    if (el.playbackRate !== this.ctx.speed) el.playbackRate = this.ctx.speed;
    s.start = { at: this.now(), t: el.currentTime };
    s.nudging = false;
    s.drift = 0;
    this.stats.starts++;
    // An unmuted take without a user gesture may be refused: play it muted rather than not at all.
    el.play()?.catch?.(() => { if (!el.muted) { el.muted = true; el.play()?.catch?.(() => {}); } });
  }

  /** Where the clock puts source position `src` (now) at performance time t. */
  _srcAt(src, t) { return src + (this.ctx.clock(t) - this.ctx.clock(this.ctx.now)); }

  /** A clip about to start: loaded, paused on its first frame, started just ahead of its edit so that its first frame
   *  lands on it (the element's measured start latency; it was parked mid-frame, so half a frame later than that). */
  _park(s, d) {
    const el = s.el, { mode, speed } = this.ctx;
    const p = d.park + 0.5;
    if (!el.paused || el.seeking) return;
    if (Math.abs(this._pos(s) - p) > 0.5) { this._seek(s, p, "preroll"); return; }
    if (mode === "play" && speed > 0 && this.ctx.clock(this.ctx.now + s.lat + this.tickMs / 2) >= d.at + 0.5) this._start(s);
  }

  /** Stopped, scrubbing, reverse, 8x, a held window: paused on the exact frame, at most one seek in flight (the newest
   *  target is taken once it lands). */
  _show(s, src) {
    const el = s.el;
    if (!el.paused) el.pause();
    s.start = null;
    const p = Math.floor(src + 1e-6) + 0.5;
    if (!el.seeking && Math.abs(this._pos(s) - p) > 0.5) this._seek(s, p, this.ctx.mode === "shuttle" ? "shuttle" : "still");
  }

  /** Playing: native playback at the shuttle speed, held to the clock by playbackRate. It seeks only to start far from
   *  where it is parked, after a jump, or past DRIFT.seek frames off. */
  _steer(s, src) {
    const el = s.el, { rate, speed, now, jump } = this.ctx;
    if (el.seeking) return;
    if (el.paused) {
      // Parked: start when the clock, a start latency from now, reaches where it waits (on the tick nearest that
      // moment); seek when it waits somewhere else.
      const ahead = this._pos(s) - this._srcAt(src, now + s.lat);
      if (ahead > 2 || ahead < -DRIFT.seek || (jump && ahead < -DRIFT.dead)) this._seek(s, this._srcAt(src, now + s.seekLat + s.lat) + 0.5, "active");
      else if (ahead <= this._srcAt(0, now + this.tickMs / 2)) this._start(s);
      return;
    }
    // The picture on screen (requestVideoFrameCallback) against the clock when it was shown: frame k is due from the
    // moment the clock reaches k, shown at the next vsync, so k + 0.25 is the middle of where it lands.
    const sh = s.shown;
    const raw = sh && sh.gen === s.gen && now - sh.at < 3000 / rate && now >= sh.at - 50
      ? sh.frame + 0.25 - this._srcAt(src, sh.at) : el.currentTime * rate - src;
    s.drift = jump ? raw : ema(s.drift, raw, 0.25);
    const act = driftRate(s.drift, speed, { nudging: s.nudging, jump });
    if (act.seek) {
      el.pause();
      this._seek(s, this._srcAt(src, now + s.seekLat + s.lat) + 0.5, "active");
      return;
    }
    if (act.nudging && !s.nudging) this.stats.nudges++;
    s.nudging = act.nudging;
    if (Math.abs(el.playbackRate - act.rate) > 0.004) el.playbackRate = act.rate;
  }
}
