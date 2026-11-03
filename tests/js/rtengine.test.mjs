// The real-time player engine (web/cut/rtengine.mjs): proxy URLs and the width ladder, the drift policy, the pre-roll
// plan, the proxy answers (200 / 202 / 404), the <video> pool, and a simulated 60 s cut with 15 edits played through a
// fake <video> that costs what the real takes cost (one keyframe: a seek costs 5 ms per frame from frame 0).
import test from "node:test";
import assert from "node:assert/strict";
import { proxyWidth, viewerWidth, proxyUrl, preferProxy, driftRate, planAt, ProxyBook, RtPlayer, DRIFT, LEAD_S } from "../../web/cut/rtengine.mjs";

const RATE = 24, VSYNC = 1000 / 60;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

test("proxy widths: the viewer's device pixels rounded up the 480/640/960/1280/1920 ladder, capped at its canvas", () => {
  assert.deepEqual([1, 480, 481, 640, 700, 960, 961, 1280, 1920, 4000].map(proxyWidth), [480, 480, 640, 640, 960, 960, 1280, 1280, 1920, 1920]);
  assert.equal(viewerWidth(500, 1), 640);
  assert.equal(viewerWidth(700, 1), 960);
  assert.equal(viewerWidth(900, 2), 1920);
  assert.equal(viewerWidth(900, 2, 960), 960, "never wider than the canvas the picture is drawn into");
  assert.equal(viewerWidth(0, 1, 960), 960, "a hidden viewer (no CSS width) asks for its canvas width");
});

test("proxy URLs: a /view take at any prefix maps to /soundstage/proxy with every field and w; anything else has none", () => {
  assert.equal(proxyUrl("/api/view?filename=final_sound_00057_.mp4&subfolder=soundstage&type=output", 960),
    "/api/soundstage/proxy?filename=final_sound_00057_.mp4&subfolder=soundstage&type=output&w=960");
  assert.equal(proxyUrl("/view?filename=a%20b.mp4&subfolder=&type=output&t=17", 640), "/soundstage/proxy?filename=a+b.mp4&subfolder=&type=output&t=17&w=640");
  assert.equal(proxyUrl("http://127.0.0.1:8189/api/view?filename=x.mp4&type=output&w=480", 1280), "http://127.0.0.1:8189/api/soundstage/proxy?filename=x.mp4&type=output&w=1280");
  for (const u of ["demo_media/draft_sc2_master.mp4", "blob:http://x/1", "/api/preview?filename=x.mp4", "/api/view?subfolder=x", null]) assert.equal(proxyUrl(u, 960), null, String(u));
});

test("prefer the proxy when the source is wider than needed, heavier than 6 Mbps, or not known yet", () => {
  assert.equal(preferProxy({ width: 2624, bitrate: 12e6 }, 960), true);
  assert.equal(preferProxy({ width: 1312 }, 960), true);
  assert.equal(preferProxy({ width: 640, bitrate: 1.4e6 }, 960), false);
  assert.equal(preferProxy({ width: 960, bitrate: 9e6 }, 960), true);
  assert.equal(preferProxy(null, 960), true);
});

test("drift policy: dead band, then a 3-8 % nudge toward the clock, a seek only past 6 frames or after a jump", () => {
  assert.deepEqual(driftRate(0.8, 1), { rate: 1, seek: false, nudging: false });
  const ahead = driftRate(2, 1), behind = driftRate(-3, 1), far = driftRate(5.9, 1);
  assert.ok(ahead.rate < 1 && ahead.rate >= 0.92 && !ahead.seek, "ahead: slower");
  assert.ok(behind.rate > 1 && behind.rate <= 1.08 && !behind.seek, "behind: faster");
  assert.ok(Math.abs(1 - far.rate) > Math.abs(1 - ahead.rate), "more drift, a bigger nudge");
  assert.ok(Math.abs(1 - driftRate(1.01, 1).rate - DRIFT.min) < 1e-3 && Math.abs(1 - driftRate(6, 1).rate) <= DRIFT.max + 1e-9);
  assert.equal(driftRate(6.5, 1).seek, true);
  assert.equal(driftRate(-7, 1).seek, true);
  assert.equal(driftRate(0.7, 1, { jump: true }).seek, true, "after a jump half a frame is enough to seek");
  assert.equal(driftRate(0.4, 1, { jump: true }).seek, false);
  assert.equal(driftRate(0.8, 1, { nudging: true }).nudging, true, "keeps nudging until within half a frame");
  assert.equal(driftRate(0.4, 1, { nudging: true }).nudging, false);
  assert.ok(Math.abs(driftRate(3, 2).rate - 2 * driftRate(3, 1).rate) < 1e-9, "the nudge scales with the shuttle speed");
});

const spans = (rows) => {
  let rec = 0;
  return rows.map((r, i) => { const s = { id: `v1:${i}`, key: r.key, lo: rec - (r.pre || 0), hi: rec + r.out - r.in + (r.post || 0), src0: r.in - (r.pre || 0) }; rec += r.out - r.in; return s; });
};

test("pre-roll plan: what is on screen, then the next clips within the lead, nearest first, at most three", () => {
  const sp = spans([{ key: "A", in: 10, out: 70 }, { key: "B", in: 5, out: 17 }, { key: "C", in: 30, out: 90 }, { key: "D", in: 0, out: 50 }]);
  assert.deepEqual(planAt(sp, 10, { lead: () => 36 }).map((d) => [d.id, d.role]), [["v1:0", "active"]], "nothing starts within 1.5 s");
  const at30 = planAt(sp, 30, { lead: () => 36 });
  assert.deepEqual(at30.map((d) => [d.id, d.role, d.park ?? d.src, d.at]), [["v1:0", "active", 40, undefined], ["v1:1", "preroll", 5, 60]]);
  const at50 = planAt(sp, 50, { lead: () => 36 });
  assert.deepEqual(at50.map((d) => d.id), ["v1:0", "v1:1", "v1:2"], "a 12-frame clip: the one after it is pre-rolled too");
  assert.deepEqual(planAt(sp, 50, { lead: () => 200 }).map((d) => d.id), ["v1:0", "v1:1", "v1:2", "v1:3"]);
  assert.deepEqual(planAt(sp, 50, { lead: () => 200, ahead: 2 }).map((d) => d.id), ["v1:0", "v1:1", "v1:2"], "at most `ahead` of them");
  assert.deepEqual(planAt(sp, 50, { lead: (k) => (k === "C" ? 10 : 36) }).map((d) => d.id), ["v1:0", "v1:1"], "the lead is per take");
  // a dissolve: the incoming clip is on screen `pre` frames before its cut, from its handle
  const dis = spans([{ key: "A", in: 0, out: 60, post: 6 }, { key: "B", in: 20, out: 80, pre: 6 }]);
  assert.deepEqual(planAt(dis, 56, { lead: () => 36 }).map((d) => [d.id, d.role, d.src ?? d.park]), [["v1:0", "active", 56], ["v1:1", "active", 16]]);
  assert.deepEqual(planAt(dis, 20, { lead: () => 36 }).map((d) => [d.id, d.role, d.park, d.at]), [["v1:0", "active", undefined, undefined], ["v1:1", "preroll", 14, 54]]);
  // a loop: past the end the cut comes round, so the clip at the loop start is parked before the wrap
  const lp = planAt(sp, 160, { lead: () => 36, loop: { start: 0, end: 182 } });
  assert.deepEqual(lp.map((d) => [d.id, d.role, d.park ?? d.src, d.at]), [["v1:3", "active", 28, undefined], ["v1:0", "preroll", 10, 182]]);
  const mid = planAt(sp, 100, { lead: () => 36, loop: { start: 65, end: 110 } });
  assert.deepEqual(mid.filter((d) => d.role === "preroll"), [{ id: "v1:1", key: "B", role: "preroll", park: 10, at: 110, lo: 10 }],
    "a mark-in inside a clip parks it there; a clip past the loop's end never plays");
});

// ---------------------------------------------------------------- ProxyBook

function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const q = replies[url.replace(/^.*\?/, "?")] ?? replies["*"];
    const r = typeof q === "function" ? q(calls.length) : Array.isArray(q) ? q.shift() : q;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}
const vid = (status = 206) => new Response(null, { status, headers: { "content-type": "video/mp4", "content-range": "bytes 0-1/669000" } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SRC = "/api/view?filename=final_00071_.mp4&subfolder=soundstage&type=output";

test("proxy answers: the route's JSON probe (soundstage/proxy.py) names the proxy to play, under the take's API prefix", async () => {
  const ready = { status: "ready", url: "/soundstage/proxy?filename=final_00071_.mp4&subfolder=soundstage&type=output&w=960&v=0123456789ab", error: null };
  const { fetch, calls } = fakeFetch({ "*": json(200, ready) });
  const changed = [];
  const book = new ProxyBook({ fetch, onChange: (s) => changed.push(s) });
  const e = book.ask(SRC, 960);
  assert.equal(e.state, "probing");
  await flush();
  assert.equal(calls[0].url, `${proxyUrl(SRC, 960)}&probe=1`, "a probe: the status, never the file");
  assert.equal(e.state, "ready");
  assert.equal(e.play, `/api${ready.url}`, "its versioned URL (a re-render under the same name is a new one), through /api like the take");
  assert.deepEqual(changed, [SRC]);
  assert.equal(book.ask(SRC, 960), e, "asked once per take and width");
  assert.equal(calls.length, 1);
  const abs = new ProxyBook({ fetch: fakeFetch({ "*": json(200, ready) }).fetch });
  const a = abs.ask("http://127.0.0.1:8189/api/view?filename=final_00071_.mp4&subfolder=soundstage&type=output", 960);
  await flush();
  assert.equal(a.play, `http://127.0.0.1:8189/api${ready.url}`);
  // pending (a 202, or the probe's 200 saying so) waits; error (a 422, or the probe's 200 saying so) plays the source
  for (const [res, state] of [[json(202, { status: "pending", retry_ms: 2000, ahead: 1, url: ready.url }), "building"],
    [json(200, { status: "pending", retry_ms: 1000, url: ready.url }), "building"], [json(422, { status: "error", error: "ffmpeg failed", url: ready.url }), "none"],
    [json(200, { status: "error", error: "ffmpeg failed", url: ready.url }), "none"], [json(400, { status: "error", error: "not a video file" }), "none"]]) {
    const b = new ProxyBook({ fetch: fakeFetch({ "*": res }).fetch, timer: () => {} });
    const x = b.ask(SRC, 960);
    await flush();
    assert.equal(x.state, state, `${res.status} ${state}`);
    assert.equal(b.noRoute, false);
  }
});

test("proxy answers: a server that sends the proxy itself plays it, without downloading it twice; JSON may name a file", async () => {
  const { fetch, calls } = fakeFetch({ "*": vid(206) });
  const book = new ProxyBook({ fetch });
  const e = book.ask(SRC, 960);
  await flush();
  assert.equal(e.state, "ready");
  assert.equal(e.play, proxyUrl(SRC, 960));
  assert.equal(calls[0].init.headers.Range, "bytes=0-1", "the probe asks for two bytes");
  assert.equal(calls[0].init.signal.aborted, true, "a video answer is cut off after its headers");
  const named = new ProxyBook({ fetch: fakeFetch({ "*": json(200, { filename: "p_960.mp4", subfolder: "soundstage_proxies", type: "temp", source: { width: 2624, bitrate: 12e6 } }) }).fetch });
  const n = named.ask(SRC, 960);
  await flush();
  assert.equal(n.play, "/api/view?filename=p_960.mp4&subfolder=soundstage_proxies&type=temp");
  assert.equal(n.info.width, 2624);
  const skip = new ProxyBook({ fetch: fakeFetch({ "*": json(200, { status: "none" }) }).fetch });
  const k = skip.ask(SRC, 960);
  await flush();
  assert.equal(k.state, "none", "the server may say the source plays as it is");
});

test("proxy answers: 202 keeps the source and asks again after retry_ms, then plays the proxy", async () => {
  let n = 0;
  const { fetch, calls } = fakeFetch({ "*": () => (++n < 3 ? json(202, { status: "building", retry_ms: 700 }) : vid(200)) });
  const timers = [];
  const changed = [];
  const book = new ProxyBook({ fetch, timer: (fn, ms) => timers.push({ fn, ms }), onChange: (s) => changed.push(s) });
  const e = book.ask(SRC, 640);
  await flush();
  assert.equal(e.state, "building");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 700);
  assert.equal(calls.length, 1, "nothing more until the retry");
  timers.shift().fn();
  await flush();
  assert.equal(e.state, "building");
  timers.shift().fn();
  await flush();
  assert.equal(e.state, "ready");
  assert.equal(calls.length, 3);
  assert.deepEqual(changed, [SRC], "one change: when it became ready");
  // a Retry-After header (seconds) when the body names no retry_ms, clamped to 0.25..15 s
  const t2 = [];
  const b2 = new ProxyBook({ fetch: fakeFetch({ "*": new Response("", { status: 202, headers: { "retry-after": "2" } }) }).fetch, timer: (fn, ms) => t2.push(ms) });
  b2.ask(SRC, 960);
  await flush();
  assert.deepEqual(t2, [2000]);
  // it gives up after maxTries
  const t3 = [];
  const b3 = new ProxyBook({ fetch: fakeFetch({ "*": () => json(202, {}) }).fetch, timer: (fn) => t3.push(fn), maxTries: 2 });
  const e3 = b3.ask(SRC, 960);
  await flush();
  t3.shift()();
  await flush();
  assert.equal(e3.state, "none");
});

test("proxy answers: a plain 404 means an older server, so no proxies (and no more probes) this session", async () => {
  const { fetch, calls } = fakeFetch({ "*": new Response("404: Not Found", { status: 404, headers: { "content-type": "text/plain" } }) });
  const changed = [];
  const book = new ProxyBook({ fetch, onChange: (s) => changed.push(s), parallel: 1 });
  const a = book.ask(SRC, 960), b = book.ask(SRC.replace("final_00071_", "draft_00123_"), 960);
  await flush();
  assert.equal(book.noRoute, true);
  assert.equal(a.state, "none");
  assert.equal(b.state, "none", "the queued one is dropped");
  assert.equal(calls.length, 1, "one 404 settles it");
  assert.equal(book.ask(SRC.replace("final_00071_", "x"), 960), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(changed, [null]);
  // a JSON 404 is about that file only; the route is there
  const j = fakeFetch({ "?filename=gone.mp4&type=output&w=960&probe=1": json(404, { status: "error", error: "no such file: gone.mp4" }), "*": vid(206) });
  const b2 = new ProxyBook({ fetch: j.fetch });
  const gone = b2.ask("/view?filename=gone.mp4&type=output", 960), ok = b2.ask("/view?filename=here.mp4&type=output", 960);
  await flush();
  assert.equal(b2.noRoute, false);
  assert.equal(gone.state, "none");
  assert.equal(ok.state, "ready");
  // a network error or a 500 is that file only too
  const b3 = new ProxyBook({ fetch: fakeFetch({ "*": [new TypeError("fetch failed"), json(500, { error: "x" })] }).fetch });
  const e1 = b3.ask(SRC, 960), e2 = b3.ask(SRC, 480);
  await flush();
  assert.deepEqual([e1.state, e2.state, b3.noRoute], ["none", "none", false]);
  assert.equal(new ProxyBook({ fetch }).ask("demo_media/x.mp4", 960), null, "a file next to the page has no proxy");
});

// ---------------------------------------------------------------- the <video> pool, on a simulated clock

/** A <video> as far as the engine uses it: loading, seeking and starting take time; a playing media clock runs at
 *  playbackRate (times `skew`), presenting a new frame (requestVideoFrameCallback) whenever its frame number changes. */
class FakeVideo {
  constructor(sim) {
    Object.assign(this, { sim, readyState: 0, paused: true, seeking: false, muted: false, volume: 1, playbackRate: 1, preload: "", playsInline: false,
      duration: NaN, videoWidth: 0, videoHeight: 0, pos: 0, _src: "", on: {}, cbs: new Map(), n: 0, loadAt: null, pending: null, runFrom: null });
    sim.videos.push(this);
  }
  get src() { return this._src; }
  set src(u) {
    Object.assign(this, { _src: u, readyState: 0, paused: true, seeking: false, pos: 0, pending: null, runFrom: null, loadAt: this.sim.now + this.sim.media(u).loadMs });
    this.sim.loads.push(u);
  }
  removeAttribute() { Object.assign(this, { _src: "", readyState: 0, loadAt: null, pending: null, runFrom: null }); }
  load() {}
  get currentTime() { return this.pos; }
  set currentTime(t) {
    const m = this.sim.media(this._src);
    this.sim.seeks.push({ at: this.sim.now, el: this, t, paused: this.paused, src: this._src });
    this.seeking = true;
    this.readyState = 1;   // as Chrome does: HAVE_METADATA until the seek lands
    this.pending = { t, at: this.sim.now + m.seekMs(t * RATE) };
  }
  play() { if (this.paused) { this.paused = false; this.runFrom = this.sim.now + this.sim.media(this._src).startMs; } return Promise.resolve(); }
  pause() { this.paused = true; this.runFrom = null; }
  addEventListener(t, fn) { (this.on[t] ||= []).push(fn); }
  emit(t) { for (const fn of this.on[t] || []) fn(); }
  requestVideoFrameCallback(cb) { this.cbs.set(++this.n, cb); return this.n; }
  cancelVideoFrameCallback(id) { this.cbs.delete(id); }
  get seekable() { return { length: 1, end: () => this.duration }; }
  present() {
    const cbs = [...this.cbs.values()];
    this.cbs.clear();
    for (const cb of cbs) cb(this.sim.now, { mediaTime: Math.floor(this.pos * RATE + 1e-6) / RATE, expectedDisplayTime: this.sim.now });
  }
  step(t0, t1) {
    if (!this._src) return;
    const m = this.sim.media(this._src);
    if (this.loadAt != null && t1 >= this.loadAt) {
      Object.assign(this, { loadAt: null, readyState: 4, duration: (m.durFrames ?? m.frames) / RATE, videoWidth: m.width, videoHeight: Math.round(m.width * 0.537) });
      this.emit("loadedmetadata"); this.emit("loadeddata"); this.present();
    }
    if (this.pending && t1 >= this.pending.at) {
      this.pos = Math.min(Math.max(0, this.pending.t), this.duration);
      Object.assign(this, { pending: null, seeking: false, readyState: 4 });
      this.emit("seeked"); this.present();
    }
    if (!this.paused && !this.seeking && this.runFrom != null && t1 > this.runFrom) {
      const from = Math.max(t0, this.runFrom), before = Math.floor(this.pos * RATE + 1e-6);
      this.pos = Math.min(this.duration, this.pos + ((t1 - from) / 1000) * this.playbackRate * (m.skew || 1));
      if (this.pos >= this.duration) this.pause();
      if (Math.floor(this.pos * RATE + 1e-6) !== before) this.present();
    }
  }
}

/** A cut on a simulated wall clock: still at the head for 0.6 s, then playing (the clock holds 50 ms at the start, as
 *  the Cut's does, so the picture can start with it); every tick the plan's demands go to the engine. Reports what
 *  each tick showed. */
function simulate(rows, takes, { seconds = 60, speed = 1, hold = 0.6 } = {}) {
  const sim = { now: 0, videos: [], seeks: [], loads: [], media: (u) => takes[u] };
  const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now, need: () => 960 });
  const sp = spans(rows), total = sp[sp.length - 1].hi;
  const t0 = hold * 1000;
  const shown = [];
  for (let t = 0; t <= t0 + seconds * 1000; t += VSYNC) {
    const prev = sim.now;
    sim.now = t;
    for (const v of sim.videos) v.step(prev, t);
    const playing = t >= t0;
    const clock = (T) => (playing ? Math.max(0, ((T - t0 - 50) / 1000) * speed * RATE) : 0);
    const f = clock(t);
    if (f >= total) break;
    rt.begin({ mode: playing ? "play" : "still", speed: playing ? speed : 0, rate: RATE, now: t, frame: f, clock, jump: false, audio: false });
    const lead = (k) => (rt.ready(k) ? LEAD_S : 3) * RATE * Math.max(1, speed);
    for (const d of planAt(sp, f, { lead: playing ? lead : () => 0 })) {
      const el = rt.want(d.id, d.key, d);
      if (d.role === "active" && d.id === sp.find((s) => f >= s.lo && f < s.hi)?.id) {
        shown.push({ t, f, want: Math.floor(d.src), got: el ? Math.floor(el.pos * RATE + 1e-6) : null, el, playing });
      }
    }
    rt.end();
  }
  return { sim, rt, shown, t0, sp };
}

const takes = (over = {}) => Object.fromEntries(["T1", "T2", "T3", "T4", "T5", "T6"].map((k) => [k, {
  frames: 240, width: 2624, loadMs: 120, startMs: 40, seekMs: (f) => 20 + 5 * f, ...(over[k] || {}) }]));

// 60 s, 16 clips, 15 edits: a take cut against itself (T1), a through edit (T3 0-60 then 60-120), two 12-frame clips.
const CUT60 = [["T2", 13, 112], ["T5", 3, 123], ["T4", 12, 101], ["T1", 52, 111], ["T1", 15, 113], ["T3", 0, 60], ["T3", 60, 120], ["T6", 25, 37],
  ["T6", 140, 152], ["T1", 1, 105], ["T5", 11, 171], ["T3", 41, 126], ["T2", 107, 210], ["T4", 21, 191], ["T6", 18, 73], ["T3", 6, 160]]
  .map(([key, i, o]) => ({ key, in: i, out: o }));

test("a simulated 60 s cut with 15 edits plays without one seek on a playing element", () => {
  assert.equal(CUT60.reduce((n, r) => n + r.out - r.in, 0), 1440);
  const { sim, rt, shown, t0, sp } = simulate(CUT60, takes());
  const played = shown.filter((s) => s.playing);
  assert.ok(played.length > 3500, `played ${played.length} ticks`);
  // Every seek is on a paused element: the first clip shown at the head, then one pre-roll park per clip at most.
  assert.equal(rt.stats.seeks.active, 0, "no seek on the picture while it plays");
  assert.deepEqual(sim.seeks.filter((s) => !s.paused), [], "no seek on any playing element");
  const during = sim.seeks.filter((s) => s.at >= t0);
  assert.ok(during.length <= 15, `${during.length} pre-roll parks for 15 incoming clips`);
  assert.equal(rt.stats.seeks.preroll, during.length);
  // each park lands well ahead of its edit: at least 1.5 s ahead less the load
  for (const s of during) {
    const target = Math.floor(s.t * RATE);
    const clip = sp.find((x, i) => i > 0 && x.src0 === target && x.lo * (1000 / RATE) + t0 > s.at);
    assert.ok(clip, `a park at source frame ${target} is for an upcoming clip`);
    assert.ok(clip.lo * (1000 / RATE) + t0 - s.at >= 1.2 * 1000, `parked ${Math.round(clip.lo * (1000 / RATE) + t0 - s.at)} ms before its edit`);
  }
  // the picture is there on every tick once it started, and on the clock's frame (one frame either side at most)
  const late = played.filter((s) => s.t > t0 + 200);
  assert.deepEqual(late.filter((s) => s.got == null).map((s) => s.f.toFixed(1)), [], "never a held or empty tick, edits included");
  const off = late.filter((s) => Math.abs(s.got - s.want) > 1);
  assert.deepEqual(off.map((s) => `${s.f.toFixed(1)}: ${s.got} for ${s.want}`), []);
  // A 60 Hz tick shows a 24 fps frame up to a third of a frame late or early; what matters is no lag that stays.
  const bias = late.reduce((n, s) => n + (s.got - s.want), 0) / late.length;
  assert.ok(Math.abs(bias) < 0.2, `no lasting lag or lead (mean ${bias.toFixed(3)} frames)`);
  assert.ok(late.filter((s) => s.got === s.want).length / late.length > 0.8, "on the clock's frame most of the time");
  // the through edit carried on in the same element; the take cut against itself got a second one
  const elAt = (rec) => late.find((s) => s.f >= rec && s.f < rec + 1)?.el;
  assert.equal(elAt(sp[6].lo + 2), elAt(sp[5].lo + 30), "a through edit keeps the element that is playing");
  assert.notEqual(elAt(sp[4].lo + 2), elAt(sp[3].lo + 30), "a take cut against itself plays from a second element");
  assert.ok(rt.slots.length <= 6);
});

test("a take whose clock runs 2 % slow is nudged back, still without a seek", () => {
  const { sim, rt, shown, t0 } = simulate(CUT60, takes({ T3: { skew: 0.98 }, T5: { skew: 1.02 }, T1: { startMs: 90 } }));
  assert.equal(rt.stats.seeks.active, 0);
  assert.deepEqual(sim.seeks.filter((s) => !s.paused), []);
  assert.ok(rt.stats.nudges > 0, "nudged");
  const late = shown.filter((s) => s.playing && s.t > t0 + 200);
  const worst = Math.max(...late.map((s) => Math.abs(s.got - s.want)));
  assert.ok(worst <= 2, `within two frames throughout (worst ${worst})`);
});

test("a take that ends a frame short of its clip holds its last frame: no seek back at the tail", () => {
  // Chrome can report a take's duration short of its last frame's end (4.674 s for a 113-frame take): the clip runs on.
  const { sim, rt, shown, t0 } = simulate([{ key: "T1", in: 60, out: 113 }, { key: "T2", in: 0, out: 40 }],
    takes({ T1: { frames: 113, durFrames: 112.2 } }), { seconds: 3.5 });
  assert.deepEqual(sim.seeks.filter((s) => s.at > t0).map((s) => s.t), [], "the tail is held, the next clip needs no park");
  assert.equal(rt.stats.seeks.active + rt.stats.seeks.still, 1, "only the first frame was shown by a seek, before play");
  const tail = shown.filter((s) => s.playing && s.f >= 52 && s.f < 53);   // source 112 on: past where the media ends
  assert.ok(tail.length >= 2 && tail.every((s) => s.got === 112), `its last frame on every tick to the edit: ${tail.map((s) => s.got)}`);
});

test("a dissolve plays both clips natively in parallel: no seek per frame on the second one", () => {
  const rows = [{ key: "T1", in: 0, out: 60, post: 6 }, { key: "T2", in: 30, out: 120, pre: 6 }];
  const sim = { now: 0, videos: [], seeks: [], loads: [], media: (u) => takes()[u] };
  const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now });
  const sp = spans(rows), t0 = 600;
  let both = 0;
  for (let t = 0; t < t0 + 4000; t += VSYNC) {
    const prev = sim.now;
    sim.now = t;
    for (const v of sim.videos) v.step(prev, t);
    const clock = (T) => (T >= t0 ? ((T - t0) / 1000) * RATE : 0), f = clock(t);
    rt.begin({ mode: t >= t0 ? "play" : "still", speed: t >= t0 ? 1 : 0, rate: RATE, now: t, frame: f, clock });
    const ds = planAt(sp, f, { lead: () => 36 });
    const got = ds.map((d) => rt.want(d.id, d.key, d));
    if (t > t0 + 200 && ds.filter((d) => d.role === "active").length === 2) {
      both++;
      assert.ok(got[0] && got[1], `both pictures at frame ${f.toFixed(1)}`);
      for (const el of got) assert.equal(el.paused, false);
    }
    rt.end();
  }
  assert.ok(both >= 20, `${both} ticks inside the dissolve`);
  assert.deepEqual(sim.seeks.filter((s) => s.at > t0), sim.seeks.filter((s) => s.at > t0 && s.paused), "every seek once playing is a park");
  assert.equal(rt.stats.seeks.active, 0);
});

test("stopped, scrubbing and reverse: one seek in flight per element, the newest target taken when it lands", () => {
  const sim = { now: 0, videos: [], seeks: [], loads: [], media: () => ({ frames: 240, width: 960, loadMs: 50, startMs: 40, seekMs: () => 100 }) };
  const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now });
  let f = 0, drawn = 0, settling = 0;
  for (let t = 0; t < 2000; t += VSYNC) {
    const prev = sim.now;
    sim.now = t;
    for (const v of sim.videos) v.step(prev, t);
    if (t > 300) f = Math.max(0, 200 - ((t - 300) / 1000) * 4 * RATE);   // reverse at 4x from frame 200
    rt.begin({ mode: "shuttle", speed: -4, rate: RATE, now: t, frame: f, clock: () => f });
    if (rt.want("v1:0", "T", { role: "active", src: f, lo: 0 })) drawn++;
    else if (t > 300) { settling++; assert.equal(rt.waiting("v1:0"), "settle", "between seeks it holds its picture (no clay)"); }
    rt.end();
    assert.ok(sim.seeks.filter((s) => s.at <= t && s.at > t - 100).length <= 1, "never two seeks within one seek's time");
  }
  const landed = sim.seeks.filter((s) => s.at > 300).length - 1;
  assert.ok(drawn >= landed, `every frame a seek lands on is drawn (${drawn} drawn, ${landed} landed)`);
  assert.ok(settling > 0);
  const last = sim.seeks[sim.seeks.length - 1];
  assert.ok(Math.abs(last.t * RATE - (Math.floor(f) + 0.5)) < 30, "and keeps up with the newest target");
  assert.ok(rt.stats.seeks.shuttle > 5);
});

test("the pool: at most `max` elements, the least recently wanted evicted; a take that failed is reported", () => {
  const sim = { now: 0, videos: [], seeks: [], loads: [], media: () => ({ frames: 100, width: 640, loadMs: 10, startMs: 10, seekMs: () => 10 }) };
  const failed = [];
  const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now, max: 3, onFail: (u) => failed.push(u) });
  const tick = (keys) => {
    sim.now += VSYNC;
    for (const v of sim.videos) v.step(sim.now - VSYNC, sim.now);
    rt.begin({ mode: "still", speed: 0, rate: RATE, now: sim.now, frame: 0, clock: () => 0 });
    const out = keys.map((k) => rt.want(`id:${k}`, k, { role: "active", src: 0, lo: 0 }));
    rt.end();
    return out;
  };
  tick(["A", "B", "C"]);
  tick(["A", "B"]);
  tick(["A", "B", "D"]);
  assert.equal(sim.videos.length, 3, "three elements, reused");
  assert.equal(rt.stats.evictions, 1);
  assert.deepEqual(rt.slots.map((s) => s.key).sort(), ["A", "B", "D"], "C, wanted longest ago, gave its element to D");
  assert.deepEqual(tick(["A", "B", "D", "E"]).map((x) => !!x).slice(3), [false], "a fourth picture at once waits: no element to spare");
  rt.sync(["A", "B"]);
  assert.deepEqual(rt.slots.filter((s) => s.key).map((s) => s.key).sort(), ["A", "B"], "a take gone from the cut is released");
  const a = rt.slots.find((s) => s.key === "A");
  a.el.emit("error");
  assert.equal(rt.failed("A"), true);
  assert.deepEqual(failed, ["A"]);
});

test("a source as narrow as the viewer still plays its proxy when it is heavier than 6 Mbps (its size over its length)", async () => {
  const pick = async (bytes) => {
    let ready = false;
    const fetch = async (url, init = {}) => (/soundstage\/proxy/.test(url) ? (ready ? json(200, { status: "ready", url: `${url.replace(/^\/api/, "").replace("&probe=1", "")}&v=1` })
      : json(202, { status: "pending", retry_ms: 300 })) : new Response(null, { status: 206, headers: { "content-range": `bytes 0-0/${bytes}` } }));
    const timers = [];
    const sim = { now: 0, videos: [], seeks: [], loads: [], media: () => ({ frames: 96, width: 960, loadMs: 20, startMs: 30, seekMs: () => 15 }) };
    const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now, fetch, timer: (fn) => timers.push(fn) });
    const A = "/api/view?filename=a.mp4&type=output";
    rt.probe();
    const tick = () => {
      sim.now += VSYNC;
      for (const v of sim.videos) v.step(sim.now - VSYNC, sim.now);
      rt.begin({ mode: "still", speed: 0, rate: RATE, now: sim.now, frame: 0, clock: () => 0 });
      rt.want("a", A, { role: "active", src: 10, lo: 0 });
      rt.end();
    };
    for (let i = 0; i < 6; i++) tick();
    await flush();
    ready = true;
    timers.splice(0).forEach((fn) => fn());
    await flush();
    for (let i = 0; i < 3; i++) tick();
    return { loads: sim.loads, info: rt.recs.get(A).info };
  };
  const heavy = await pick(8e6), light = await pick(4e5);
  assert.equal(Math.round(heavy.info.bitrate / 1e6), 16, "8 MB over 4 s");
  assert.equal(heavy.loads.length, 2, "16 Mbps: the proxy takes over");
  assert.match(heavy.loads[1], /^\/api\/soundstage\/proxy\?.*&v=1$/);
  assert.equal(Math.round(light.info.bitrate / 1e5), 8);
  assert.deepEqual(light.loads, ["/api/view?filename=a.mp4&type=output"], "0.8 Mbps at the viewer's width: the source plays as it is");
});

test("a proxy that becomes ready takes over a parked element, never the one playing on screen", async () => {
  let ready = false;
  const fetch = async () => (ready ? vid(206) : json(202, { retry_ms: 300 }));
  const timers = [];
  const sim = { now: 0, videos: [], seeks: [], loads: [], media: () => ({ frames: 240, width: 2624, loadMs: 20, startMs: 30, seekMs: () => 15 }) };
  const rt = new RtPlayer({ create: () => new FakeVideo(sim), now: () => sim.now, fetch, timer: (fn) => timers.push(fn) });
  const A = "/api/view?filename=a.mp4&type=output", B = "/api/view?filename=b.mp4&type=output";
  rt.sync([A, B]);
  rt.probe();
  await flush();
  const run = (n, mode, wants) => {
    for (let i = 0; i < n; i++) {
      sim.now += VSYNC;
      for (const v of sim.videos) v.step(sim.now - VSYNC, sim.now);
      const f = mode === "play" ? (sim.now / 1000) * RATE : 0;
      rt.begin({ mode, speed: mode === "play" ? 1 : 0, rate: RATE, now: sim.now, frame: f, clock: (T) => (mode === "play" ? (T / 1000) * RATE : 0) });
      wants(f);
      rt.end();
    }
  };
  run(20, "play", (f) => { rt.want("a", A, { role: "active", src: f, lo: 0 }); rt.want("b", B, { role: "preroll", park: 40, at: 200, lo: 40 }); });
  assert.deepEqual(sim.loads, [A, B], "the takes themselves while their proxies are built");
  ready = true;
  timers.splice(0).forEach((fn) => fn());
  await flush();
  run(5, "play", (f) => { rt.want("a", A, { role: "active", src: f, lo: 0 }); rt.want("b", B, { role: "preroll", park: 40, at: 200, lo: 40 }); });
  assert.deepEqual(sim.loads, [A, B, proxyUrl(B, 960)], "the parked one swapped to its proxy; the playing one did not");
  assert.equal(rt.proxied("b"), true);
  assert.equal(rt.proxied("a"), false);
  run(3, "still", () => rt.want("a", A, { role: "active", src: 30, lo: 0 }));
  assert.equal(sim.loads[3], proxyUrl(A, 960), "stopped, the picture moves to its proxy too");
  assert.equal(rt.waiting("a"), "settle", "and holds its last picture meanwhile");
});
