// Soundstage live editing (Milestone 9): drag anything on the set and it interacts with what it runs into, in real
// time. A drag builds a live physics world from the set at the playhead (through physengine.mjs, so the backend can be
// swapped): small props are pushable, the set, vehicles, animals and people block. While you drag:
//   a prop is grabbed: it follows the cursor along the floor and up onto surfaces (a crate onto a table), shoves
//     other props, and walls, cars and the floor stop it; let go and it falls, slides and tips over until it rests;
//   a person walks into props and pushes them, steps or climbs up onto a box, table or ledge under the cursor,
//     mounts a horse / bike / car seat / bench under the cursor (dismounts when dragged off), and C picks up (or puts
//     down) the small prop they're touching, which then comes along;
//   a vehicle or animal is driven kinematically and knocks props out of the way.
// When everything has come to rest the result is written into ordinary keys at the playhead as ONE undo step. The
// shot itself is still made by Simulate & bake: this is an editing aid, nothing here runs at render time.
import * as THREE from "../vendor/three.module.min.mjs";
import { createWorld } from "./physengine.mjs";
import { physicsOf } from "./physics.mjs";
import { dragTarget, damp, axisLock, edgeSnap, snapGrid, stepKind, yawTilt, liftBy, qyaw, qmul, qnorm } from "./manip.mjs";

/** Furniture with a top to set things on: a dragged prop rides up onto it instead of shoving it across the floor. */
const SURFACES = new Set(["table", "desk", "dining_table", "coffee_table", "bench", "kitchen_counter", "bed", "single_bed", "bookshelf", "wardrobe", "fridge", "washbasin"]);
const SETTLE_MAX_S = 4;          // stop simulating a drop after this long, whatever is still moving
const MOVE_EPS = 0.002, ROT_EPS = 0.004;

/** Real-world feel by kind: friction against the floor, a little bounce at most, and how much they resist tumbling. */
const FEEL = {
  crate: { friction: 0.75, restitution: 0.04 }, box: { friction: 0.7, restitution: 0.03 }, cube: { friction: 0.7, restitution: 0.04 },
  chair: { friction: 0.65, restitution: 0.05 }, stool: { friction: 0.65, restitution: 0.05 }, table: { friction: 0.7, restitution: 0.03 },
  sphere: { friction: 0.5, restitution: 0.45, angularDamping: 0.25 }, rock: { friction: 0.85, restitution: 0.02 },
  cone: { friction: 0.8, restitution: 0.05 }, cylinder: { friction: 0.7, restitution: 0.05 },
};

export class LiveEdit {
  /** K: the stage's kind tables {PERSON_KINDS, RIDEABLE, SITTABLE, SEATS, NO_COLLIDE, CAR_BODIES, NEVER_CARRIED, LIBRARY}. */
  constructor(stage, K) {
    this.s = stage;
    this.K = K;
    this.world = null;
    this.drag = null;       // the held object while the mouse is down
    this.settling = false;  // let go, things still moving
    this._raf = 0;
    this._t = 0;
    this.stats = { frames: 0, ms: 0, worst: 0 };
  }

  get busy() { return !!(this.drag || this.settling); }

  // ---------- who is what ----------
  _actor(id) { return this.s.state.actors.find((x) => x.id === id); }
  _isPerson(a) { return this.K.PERSON_KINDS.has(a?.kind); }
  _stationary(a) {
    const k = this.s._actorKeys(a);
    return k.every((x) => Math.hypot(x.position[0] - k[0].position[0], x.position[1] - k[0].position[1], x.position[2] - k[0].position[2]) < 1e-4);
  }
  _hasRiders(a) { return this.s.state.actors.some((x) => x.mount_id === a.id); }
  _height(a) {
    const L = this.K.LIBRARY[a.kind];
    return (a.height_m || L?.height || a.recipe?.size_m?.[1] || 1) * (a.scale || 1);
  }
  /** Pushed around while you drag something into it (editing only): small, stationary, unbaked props, unless set Static / Off. */
  pushable(a) {
    if (!a || !this.s._physCanMove(a) || a.physics?.baked) return false;
    const mode = a.physics?.mode;
    if (mode === "static" || mode === "off" || a.physics?.pushable === false) return false;
    if (!this._stationary(a) || this._hasRiders(a)) return false;
    return this._height(a) <= 1.6 && physicsOf(a).mass <= 120;
  }
  /** Does it collide at all? (trees, rugs, lamps, flying things, cards, riders and carried things don't.) */
  _collides(a) {
    const L = this.K.LIBRARY[a.kind];
    return !(a.mount_id || a.carry_id || a.kind === "card" || a.set_xform || L?.flies || this.K.NO_COLLIDE.has(a.kind) || a.physics?.mode === "off");
  }

  /** Collision shapes of an actor: [{id, half, center}] in its own frame (cars: body + cabin; people: the torso). */
  _shapes(a, g) {
    const sig = `${a.scale || 1}|${a.height_m || 0}|${g.uuid}`;
    let box = g.userData._lbox?.sig === sig ? g.userData._lbox.box : null;
    if (!box) { box = this.s._localBox(g); g.userData._lbox = { sig, box }; }
    if (!box) return [];
    const [hx, hy, hz] = box.half, [cx, cy, cz] = box.center;
    if (this._isPerson(a)) return [{ id: a.id, half: [Math.max(0.12, hx * 0.6), hy, Math.max(0.1, hz * 0.75)], center: box.center }];
    if (this.K.CAR_BODIES.has(a.kind)) {
      const y0 = cy - hy, H = 2 * hy;
      return [{ id: `${a.id}#body`, half: [hx, H * 0.24, hz], center: [cx, y0 + H * 0.32, cz] },
        { id: `${a.id}#cabin`, half: [hx * 0.9, H * 0.22, hz * 0.5], center: [cx, y0 + H * 0.78, cz - hz * 0.08] }];
    }
    if (a.kind === "sphere") return [{ id: a.id, half: box.half, center: box.center, sphere: Math.min(hx, hy, hz) }];
    return [{ id: a.id, half: box.half, center: box.center }];
  }

  // ---------- the world ----------
  /** Build the live world from the set as it stands at the playhead. `heldId` is the object about to be dragged. */
  _build(heldId, heldMode) {
    this.world?.dispose();
    const w = createWorld({ floor: true, substeps: 8 });
    const bodies = new Map();   // actor id -> [body ids]
    const meta = new Map();     // actor id -> {start pos, start quat, dynamic}
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    for (const a of this.s.state.actors) {
      const g = this.s.actorMeshes.get(a.id);
      if (!g || !g.visible) continue;
      const held = a.id === heldId;
      if (!held && !this._collides(a)) continue;
      g.updateMatrixWorld(true);
      g.getWorldPosition(pos); g.getWorldQuaternion(quat);
      const shapes = this._shapes(a, g);
      if (!shapes.length) continue;
      const dynamic = held ? heldMode === "prop" : this.pushable(a) && !(heldMode === "prop" && SURFACES.has(a.kind));
      const type = held ? (heldMode === "kinematic" ? "kinematic" : "dynamic") : dynamic ? "dynamic" : "static";
      const p = physicsOf(a), feel = FEEL[a.kind] || {};
      const ids = [];
      for (const sh of shapes) {
        ids.push(w.addBody({ id: sh.id, shape: sh.sphere ? "sphere" : "box", half: sh.half, center: sh.center, radius: sh.sphere || 0, type,
          mass: this._isPerson(a) ? 75 : p.mass, friction: a.physics?.friction ?? feel.friction ?? 0.7,
          restitution: a.physics?.bounce ?? feel.restitution ?? 0.05, angularDamping: feel.angularDamping ?? 1.4, linearDamping: 0.08,
          pos: pos.toArray(), quat: [quat.x, quat.y, quat.z, quat.w], asleep: !held && dynamic }));
      }
      bodies.set(a.id, ids);
      meta.set(a.id, { pos: pos.toArray(), quat: [quat.x, quat.y, quat.z, quat.w], dynamic, held });
    }
    for (const c of this.s._setCollidersCached()) w.addBody({ id: c.id, shape: "box", half: c.half, center: [0, 0, 0], type: "static", pos: c.pos, quat: c.quat });
    this.world = w; this.bodies = bodies; this.meta = meta;
  }

  _actorOfBody(bid) { return bid && bid !== "__ground" ? String(bid).split("#")[0] : null; }

  // ---------- a drag ----------
  /**
   * Start dragging actor `id` from a pointer event `e` (ray = the stage's raycaster, aimed). Returns false when this
   * object can't be dragged live (the caller falls back to the plain floor drag).
   */
  begin(id, e, ray) {
    this.finish();
    const a = this._actor(id), g = this.s.actorMeshes.get(id);
    if (!a || !g) return false;
    // A rider: dragging them off the horse or out of the car dismounts them (on release, if they aren't put back).
    const wasMount = a.mount_id ? { mount_id: a.mount_id, pose: a.pose, seat: a.seat, mount_at: a.mount_at } : null;
    if (wasMount) {
      g.updateMatrixWorld(true);
      const p = g.getWorldPosition(new THREE.Vector3());
      delete a.mount_id; delete a.pose; delete a.seat; delete a.mount_at;
      const k = this.s._editActorKey(a);
      k.position = [+p.x.toFixed(3), 0, +p.z.toFixed(3)];
      this.s._yCache?.delete(a);
      this._silentFrame();
    }
    // Dragged out of someone's hands: it is put down (and falls where you let go).
    let putDown = null;
    if (a.carry_id) { putDown = this._actor(a.carry_id); delete a.carry_id; delete a.carry_at; this._silentFrame(); }
    const person = this._isPerson(a);
    const L = this.K.LIBRARY[a.kind];
    const settles = !person && this.s._physCanMove(a) && !a.physics?.baked && a.physics?.mode !== "off" && !this._hasRiders(a);
    const mode = person ? "person" : settles ? "prop" : (L?.rig === "vehicle" || L?.rig === "quadruped" || a.physics?.baked || this._hasRiders(a)) ? "kinematic" : "prop";
    this._build(id, mode);
    if (!this.bodies.has(id)) return false;
    g.updateMatrixWorld(true);
    const start = g.position.clone();
    const base = person ? (this.s._actorKeys(a).find((k) => k.frame === this.s.frame)?.position?.[1] ?? this.s._actorPosAt(a, this.s.frame)[1] ?? 0) : start.y;
    const q0 = this._planeHit(ray, Math.max(0, base)) || start.clone();
    const yt = yawTilt(g.quaternion.toArray());
    const yaw0 = mode === "prop" ? yt.yawDeg * Math.PI / 180 : g.rotation.y;
    const tilt = mode === "prop" ? yt.tilt : null;
    this.drag = {
      id, a, g, mode, settles, person, wasMount, start: start.toArray(), base: Math.max(0, base), lift: 0,
      grab: [start.x - q0.x, 0, start.z - q0.z], cur: start.toArray(), yaw: yaw0, yaw0, tilt,
      quat: g.quaternion.toArray(), ray: { o: ray.ray.origin.toArray(), d: ray.ray.direction.toArray() },
      mods: {}, x: e.clientX, y: e.clientY, rotX: null, axis: null, support: null, mountHost: null, guides: [],
      carried: this.s.state.actors.filter((x) => x.carry_id === id).map((x) => x.id), moved: false, t0: performance.now(),
      putDown, overPerson: null,
    };
    this.s.highlight?.setGhost(id);
    this._loop();
    return true;
  }

  /** Pointer moved (ray aimed at it). */
  move(e, ray) {
    const d = this.drag;
    if (!d) return;
    d.ray = { o: ray.ray.origin.toArray(), d: ray.ray.direction.toArray() };
    d.mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    if (e.altKey) {
      if (d.rotX == null) d.rotX = e.clientX;
      d.yaw = d.yaw0 + (e.clientX - d.rotX) * 0.01;   // ~0.57° a pixel
    } else if (d.rotX != null) { d.yaw0 = d.yaw; d.rotX = null; d.grab = this._regrab(d); }
    if (!e.shiftKey) d.axis = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) d.moved = true;
  }

  /** Wheel while holding a prop: raise / lower it (let go up there and it drops). Returns true if used. */
  wheel(e) {
    const d = this.drag;
    if (!d || d.mode !== "prop") return false;
    d.lift = liftBy(d.lift, e.deltaY * (e.deltaMode === 1 ? 33 : 1));
    d.moved = true;
    return true;
  }

  /** Keys while dragging: C picks up / puts down. Returns true if used. */
  key(e) {
    const d = this.drag;
    if (!d || !d.person || e.key.toLowerCase() !== "c") return false;
    if (d.carried.length) {
      for (const pid of d.carried) { const o = this._actor(pid); delete o.carry_id; delete o.carry_at; }
      this._note(`${this._name(d.a)} puts down ${d.carried.map((x) => this._name(this._actor(x))).join(", ")}.`);
      d.carried = [];
      this._silentFrame();
      return true;
    }
    const near = this._touchingProp(d);
    if (!near) { this._note("Nothing small enough to pick up here: walk them into a prop, then press C."); return true; }
    near.carry_id = d.id;
    near.carry_at = this.s.frame;
    d.carried = [near.id];
    for (const bid of this.bodies.get(near.id) || []) this.world.removeBody(bid);
    this.bodies.delete(near.id);
    this._silentFrame();
    this._note(`${this._name(d.a)} picks up ${this._name(near)}. Keep dragging: it comes along. C puts it down.`);
    return true;
  }

  /** Mouse released. */
  end() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.mode === "prop" && d.settles) this.world.setKinematicTarget(d.id, null);   // let go: it falls and settles
    else if (this.bodies.has(d.id)) for (const bid of this.bodies.get(d.id)) {
      if (d.person || d.mode === "prop") this.world.setBodyProps(bid, { type: "static" });
    }
    if (d.supportWasDynamic) this.world.setBodyProps(d.support, { type: "dynamic" });
    this.s.highlight?.setGhost(null);
    this.s.highlight?.setGuides([]);
    this.lastDrag = d;
    this.settling = true;
    this._settleT0 = performance.now();
    this._loop();
  }

  /** Stop now and write what is on the set into keys (one undo step). Safe to call any time. */
  finish() {
    if (this.drag) this.end();
    if (!this.settling) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.settling = false;
    this._commit(this.lastDrag);
    this.world?.dispose(); this.world = null;
    this.lastDrag = null;
  }

  // ---------- the loop ----------
  _loop() {
    if (this._raf || typeof requestAnimationFrame !== "function") return;   // (node tests drive _tick themselves)
    this._t = performance.now();
    const tick = () => {
      this._raf = 0;
      const now = performance.now(), dt = Math.min(1 / 20, (now - this._t) / 1000);
      this._t = now;
      const t0 = performance.now();
      try { this._tick(dt || 1 / 60); } catch (err) { console.warn("Soundstage live", err); this.drag = null; this.settling = false; this.world = null; return; }
      const ms = performance.now() - t0;
      this.stats.frames++; this.stats.ms += ms; this.stats.worst = Math.max(this.stats.worst, ms);
      if (this.settling && !this.drag) {
        const quiet = !this.world || (this.world.awakeCount?.() ?? 0) === 0;
        if (quiet || now - this._settleT0 > SETTLE_MAX_S * 1000) { this.finish(); return; }
      }
      if (this.drag || this.settling) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _tick(dt) {
    const d = this.drag, w = this.world;
    if (!w) return;
    if (d) this._steer(d, dt);
    w.step(dt);
    // The dragged person / vehicle drives its own keys (riders, carried things, the walk all follow); props are posed
    // straight from the world.
    if (d && (d.person || d.mode === "kinematic")) {
      const bid = this.bodies.get(d.id)?.[0];
      const pose = d.mountHost ? null : bid && w.getPose(bid);
      if (pose) {
        const k = this.s._editActorKey(d.a);
        k.position = [+pose.pos[0].toFixed(3), d.person ? +Math.max(0, pose.pos[1]).toFixed(3) : 0, +pose.pos[2].toFixed(3)];
        if (d.mode === "kinematic" && d.rotX != null) d.a.rotation_deg = Math.round(THREE.MathUtils.radToDeg(d.yaw));
        if (d.person && d.rotX != null) d.a.rotation_deg = Math.round(THREE.MathUtils.radToDeg(d.yaw));
        this.s._yCache?.delete(d.a);
      }
      this._silentFrame();
      if (d.person && !d.mountHost) this._stepPose(d, pose);
    }
    for (const [aid, ids] of this.bodies) {
      const m = this.meta.get(aid);
      if (!m) continue;
      if (!m.dynamic) continue;
      const g = this.s.actorMeshes.get(aid);
      const p = w.getPose(ids[0]);
      if (!g || !p) continue;
      g.position.set(...p.pos);
      g.quaternion.set(...p.quat);
    }
    this.s.render();
  }

  /** Where the held thing goes this frame. */
  _steer(d, dt) {
    const w = this.world;
    const exclude = new Set([...(this.bodies.get(d.id) || []), ...d.carried.flatMap((c) => this.bodies.get(c) || [])]);
    const o = d.ray.o, dir = d.ray.d;
    const planeHit = (y) => { const p = this._planeHitRay(o, dir, y); return p && p.toArray(); };
    let target;
    if (d.rotX != null) target = { pos: [...d.cur], support: d.support, surface: true };
    else {
      const hit = w.raycast(o, dir, 800, { exclude });
      // A person over a horse, bike, car seat or bench: they mount it (shown live; kept if you let go there).
      const hostId = d.person && hit ? this._actorOfBody(hit.id) : null;
      const host = hostId && this._actor(hostId);
      if (d.person && host && this._mountable(host)) { this._previewMount(d, host, hit.point); return; }
      if (d.mountHost) this._clearMount(d);
      // A prop over a person: they take it (on release); it isn't set on their head.
      const over = !d.person && hit ? this._actor(this._actorOfBody(hit.id)) : null;
      d.overPerson = over && this._isPerson(over) && !over.mount_id && this._carriable(d.a) ? over.id : null;
      target = dragTarget(d.overPerson ? null : hit, d.grab, d.base, planeHit, d.person ? 1.75 : 1.8);
      if (!target) return;
      if (d.person && target.surface) {
        const kind = stepKind(target.pos[1] - (target.support ? 0 : 0));
        if (kind === "blocked") { const p = planeHit(d.base); if (p) target = { pos: [p[0] + d.grab[0], d.base, p[2] + d.grab[2]], support: null, surface: false }; }
      }
      if (!d.person) {
        // Under its middle: a table, a static prop or a ledge it is being slid onto (not a car, a person or an animal).
        const ex = new Set(exclude);
        for (const [aid, ids] of this.bodies) {
          const o = this._actor(aid), L = o && this.K.LIBRARY[o.kind];
          if (this.meta.get(aid)?.dynamic || this._isPerson(o) || L?.rig === "vehicle" || L?.rig === "quadruped") for (const b of ids) ex.add(b);
        }
        const under = w.raycast([target.pos[0], 40, target.pos[2]], [0, -1, 0], 80, { exclude: ex });
        if (under && under.id !== "__ground" && under.normal[1] > 0.7 && under.point[1] <= 1.8 && under.point[1] > target.pos[1] + 0.01) {
          target = { pos: [target.pos[0], under.point[1], target.pos[2]], support: under.id, surface: true };
        }
      }
      if (d.mods.shift) { const r = axisLock(d.start, target.pos, d.axis); d.axis = r.axis; target.pos = r.pos; }
      if (this.s.snap) { target.pos[0] = snapGrid(target.pos[0], 0.1); target.pos[2] = snapGrid(target.pos[2], 0.1); }
      d.guides = [];
      if (!d.mods.ctrl && !d.person) {
        const fp = this._footprint(d, target.pos);
        if (fp) {
          const sn = edgeSnap(fp, this._footprints(d), 0.07, 2.5);
          target.pos[0] += sn.dx; target.pos[2] += sn.dz;
          d.guides = sn.guides.map((gd) => ({ ...gd, y: target.pos[1] + 0.01 }));
        }
      }
      if (d.axis) d.guides.push({ axis: d.axis === "x" ? "z" : "x", at: d.axis === "x" ? d.start[2] : d.start[0], span: null, y: target.pos[1] + 0.01, lock: d.axis, through: d.start });
      this.s.highlight?.setGuides(d.guides);
    }
    // What it stands on holds still while you climb onto it or set something on it.
    if (target.support !== d.support) {
      if (d.supportWasDynamic) w.setBodyProps(d.support, { type: "dynamic" });
      d.supportWasDynamic = false;
      const sa = this._actor(this._actorOfBody(target.support));
      if (target.support && sa && this.meta.get(sa.id)?.dynamic) { w.setBodyProps(target.support, { type: "static" }); d.supportWasDynamic = true; }
      d.support = target.support;
    }
    d.base = target.pos[1];
    const want = [target.pos[0], target.pos[1] + (d.mode === "prop" ? d.lift : 0), target.pos[2]];
    if (d.respawn) {
      d.respawn = false;
      d.cur = [...want];
      d.climbing = false;
      for (const bid of this.bodies.get(d.id) || []) { this.world.setBodyProps(bid, { type: "dynamic", pos: want }); this.world.setKinematicTarget(bid, want, qyaw(d.yaw)); }
    }
    if (d.person || d.mode === "prop") {
      // Stepping up onto (or down off) something: rise first, then over, without snagging on its edge.
      const pose = w.getPose(this.bodies.get(d.id)?.[0]);
      const changing = pose && Math.abs(pose.pos[1] - want[1]) > 0.03;
      if (changing !== !!d.climbing) for (const bid of this.bodies.get(d.id) || []) w.setBodyProps(bid, { type: changing ? "kinematic" : "dynamic" });
      d.climbing = changing;
      if (changing && pose) {
        const up = want[1] > pose.pos[1];
        d.cur = [damp(d.cur[0], want[0], up ? 9 : 14, dt), damp(d.cur[1], want[1], up ? 22 : 16, dt), damp(d.cur[2], want[2], up ? 9 : 14, dt)];
        const yq = qyaw(d.yaw);
        for (const bid of this.bodies.get(d.id) || []) w.setKinematicTarget(bid, d.cur, d.tilt ? qnorm(qmul(yq, d.tilt)) : yq);
        return;
      }
    }
    // A little smoothing: the object keeps up with the cursor (~30 ms) but never jumps.
    d.cur = damp(d.cur, want, 32, dt);
    const yawQ = qyaw(d.yaw);
    const q = d.tilt ? qnorm(qmul(yawQ, d.tilt)) : yawQ;
    for (const bid of this.bodies.get(d.id) || []) w.setKinematicTarget(bid, d.cur, q);
  }

  _regrab(d) {
    const p = this._planeHitRay(d.ray.o, d.ray.d, d.base);
    return p ? [d.cur[0] - p.x, 0, d.cur[2] - p.z] : d.grab;
  }

  // ---------- people ----------
  _mountable(host) {
    if (this._isPerson(host)) return false;
    return this.K.RIDEABLE.has(host.kind) || !!this.K.SEATS[host.kind] || this.K.SITTABLE.has(host.kind);
  }

  _previewMount(d, host, point) {
    const a = d.a;
    if (d.mountHost === host.id && (a.seat == null || !this.K.SEATS[host.kind])) return;
    let seat = null;
    if (this.K.SEATS[host.kind]) {   // the nearest seat to the cursor
      const hg = this.s.actorMeshes.get(host.id), L = this.K.LIBRARY[host.kind], ref = L?.height || 1;
      const k = (host.scale || 1) * ((host.height_m || ref) / ref);
      let sd = Infinity;
      this.K.SEATS[host.kind].forEach((s, i) => {
        const wp = new THREE.Vector3(s.pos[0] * k, 0, s.pos[2] * k).applyAxisAngle(new THREE.Vector3(0, 1, 0), hg.rotation.y).add(hg.position);
        const dd = Math.hypot(wp.x - point[0], wp.z - point[2]);
        if (dd < sd) { sd = dd; seat = i; }
      });
      if (d.mountHost === host.id && a.seat === seat) return;
    }
    a.mount_id = host.id;
    a.pose = this.K.RIDEABLE.has(host.kind) ? (this.K.MOUNTS[host.kind]?.pose || "sit") : "sit";
    if (seat != null) a.seat = seat; else delete a.seat;
    if (this.s.frame > 0) a.mount_at = this.s.frame; else delete a.mount_at;
    d.mountHost = host.id;
    for (const bid of this.bodies.get(d.id) || []) this.world.setBodyProps(bid, { type: "static", pos: [0, -50, 0] });   // out of the way
    this._silentFrame();
  }

  _clearMount(d) {
    const a = d.a;
    delete a.mount_id; delete a.pose; delete a.seat; delete a.mount_at;
    d.mountHost = null;
    d.respawn = true;   // back on foot where the cursor is (not inside the horse), once this frame's target is known
    this._silentFrame();
  }

  /** A step or climb pose while the person is rising onto something (knee up, arms forward), blended by the rise. */
  _stepPose(d, pose) {
    if (!pose) return;
    const prev = d._py ?? pose.pos[1];
    const rising = Math.max(0, d.base - pose.pos[1]) + Math.max(0, pose.pos[1] - prev) * 8;
    d._py = pose.pos[1];
    d._climb = damp(d._climb || 0, Math.min(1, rising * 3), 12, 1 / 60);
    const w = d._climb;
    if (w < 0.02) return;
    for (const l of d.g.userData.limbs || []) {
      const lead = l.side > 0;
      if (l.part === "hip") l.pivot.rotation.x += (lead ? -1.2 : -0.25) * w;
      if (l.part === "knee") l.pivot.rotation.x += (lead ? 1.5 : 0.35) * w;
      if (l.part === "shoulder") l.pivot.rotation.x += -0.9 * w;
      if (l.part === "elbow") l.pivot.rotation.x += -0.5 * w;
    }
  }

  /** The small prop a dragged person is touching (or nearly), that they could carry. */
  _touchingProp(d) {
    const g = d.g, pb = new THREE.Box3().setFromObject(g).expandByScalar(0.25);
    let best = null;
    for (const o of this.s.state.actors) {
      if (o.id === d.id || this._isPerson(o) || o.carry_id || o.mount_id || this.K.NEVER_CARRIED.has(o.kind)) continue;
      const og = this.s.actorMeshes.get(o.id);
      if (!og) continue;
      const ob = new THREE.Box3().setFromObject(og), size = ob.getSize(new THREE.Vector3());
      if (size.y > 1.0 || Math.max(size.x, size.z) > 1.6 || !pb.intersectsBox(ob)) continue;
      const dd = ob.getCenter(new THREE.Vector3()).distanceTo(g.position);
      if (!best || dd < best.dd) best = { o, dd };
    }
    return best?.o || null;
  }

  // ---------- footprints for edge snapping ----------
  _footprint(d, at) {
    const ids = this.bodies.get(d.id);
    if (!ids) return null;
    const m = this._boxOf(d.a);
    if (!m) return null;
    const c = Math.abs(Math.cos(d.yaw)), s = Math.abs(Math.sin(d.yaw));
    const ex = m.half[0] * c + m.half[2] * s, ez = m.half[0] * s + m.half[2] * c;
    const cx = at[0] + m.center[0] * Math.cos(d.yaw) + m.center[2] * Math.sin(d.yaw), cz = at[2] - m.center[0] * Math.sin(d.yaw) + m.center[2] * Math.cos(d.yaw);
    return { min: [cx - ex, cz - ez], max: [cx + ex, cz + ez] };
  }
  _boxOf(a) { return this.s.actorMeshes.get(a.id)?.userData?._lbox?.box || null; }
  _footprints(d) {
    if (d._fps) return d._fps;
    const out = [];
    for (const [aid] of this.bodies) {
      if (aid === d.id) continue;
      const g = this.s.actorMeshes.get(aid);
      if (!g) continue;
      const b = new THREE.Box3().setFromObject(g);
      if (b.isEmpty() || b.max.y - b.min.y > 4) continue;
      out.push({ id: aid, min: [b.min.x, b.min.z], max: [b.max.x, b.max.z] });
    }
    return (d._fps = out);
  }

  _carriable(o) {
    if (this.K.NEVER_CARRIED.has(o.kind)) return false;
    const b = this._boxOf(o);
    return !!b && b.half[1] * 2 <= 1.0 && Math.max(b.half[0], b.half[2]) * 2 <= 1.6;
  }

  /** Let a prop that was just moved some other way (the gizmo) fall and settle, then write it down (one undo step). */
  settle(id) {
    this.finish();
    const a = this._actor(id);
    if (!a || !this.s._physCanMove(a) || a.physics?.baked || a.physics?.mode === "off" || this._hasRiders(a)) return false;
    this._build(id, "prop");
    if (!this.bodies.has(id)) return false;
    this.lastDrag = { id, a, mode: "prop", settles: true, person: false, moved: true, lift: 0, carried: [], guides: [] };
    this.settling = true;
    this._settleT0 = performance.now();
    this._loop();
    return true;
  }

  // ---------- writing it down ----------
  _commit(d) {
    if (!d) return;
    const s = this.s, w = this.world;
    const changed = [];
    for (const [aid, ids] of this.bodies || []) {
      const m = this.meta.get(aid), a = this._actor(aid);
      if (!m || !a || !w) continue;
      if (aid === d.id && (d.person || d.mode === "kinematic")) continue;   // written as it went
      if (!m.dynamic && aid !== d.id) continue;
      const p = w.getPose(ids[0]);
      const moved = Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1], p.pos[2] - m.pos[2]) > MOVE_EPS ||
        1 - Math.abs(p.quat.reduce((acc, v, i) => acc + v * m.quat[i], 0)) > ROT_EPS;
      if (!moved) continue;
      this._writePose(a, p, aid === d.id);
      changed.push(a);
    }
    if (d.carried?.length || d.wasMount || d.mountHost || d.putDown) changed.push(d.a);
    let handed = null;
    if (d.overPerson && !d.person) {   // dropped onto a person: they carry it from the playhead
      const c = this._actor(d.overPerson);
      if (c) { d.a.carry_id = c.id; d.a.carry_at = Math.max(8, s.frame); handed = c; }
    }
    const draggedMoved = d.moved || d.lift > 0;
    s._obsCache = null;
    this.internal = true;
    try { s.setFrame(s.frame); } finally { this.internal = false; }
    if (draggedMoved || changed.length) s.onChange(s.toJSON());
    const pushed = changed.filter((a) => a.id !== d.id);
    let msg = this._noteText || null;
    if (handed) msg = `${this._name(handed)} picks up ${this._name(d.a)} at ${(d.a.carry_at / (s.state.shot?.fps || 24)).toFixed(1)} s and carries it. Drag it away to put it down.`;
    else if (d.putDown) msg = `${this._name(d.a)} is put down by ${this._name(d.putDown)}.`;
    else if (d.mountHost) {
      const h = this._actor(d.mountHost);
      msg = `${this._name(d.a)} ${this.K.SEATS[h.kind] ? `gets into ${this._name(h)}${d.a.seat != null ? ` (${this.K.SEATS[h.kind][d.a.seat]?.name} seat)` : ""}` : `is on ${this._name(h)}`}.`;
    } else if (d.person && d.base > 0.05 && d.support) {
      msg = `${this._name(d.a)} climbs onto ${this._name(this._actor(this._actorOfBody(d.support)))} (${d.base.toFixed(2)} m up).`;
    } else if (d.wasMount) msg = `${this._name(d.a)} gets off.`;
    if (pushed.length && !msg) msg = `Moved ${this._name(d.a)}; ${pushed.length === 1 ? `${this._name(pushed[0])} was` : `${pushed.length} things were`} pushed along.`;
    this._noteText = null;
    if (msg) s.onInteract?.(msg);
    s.onSelect?.(s.selectedInfo());
  }

  /** Put an actor where the world left it: the key at the playhead (the dragged one) or its only key (pushed ones). */
  _writePose(a, p, dragged) {
    const s = this.s;
    const lift = a.physics?.lift || 0;
    const y = Math.max(0, p.pos[1] - (a.physics?.mode === "dynamic" || a.physics?.mode === "static" ? lift : 0));
    if (lift && a.physics) a.physics.lift = 0;
    const pos = [+p.pos[0].toFixed(3), +y.toFixed(3), +p.pos[2].toFixed(3)];
    const keys = s._actorKeys(a);
    if (!dragged && this._stationary(a)) for (const k of keys) k.position = [...pos];
    else s._editActorKey(a).position = [...pos];
    a.position = [...keys[0].position];
    if (pos[1] > 0.002 || a.key_y) a.key_y = true;
    const { yawDeg, tilt } = yawTilt(p.quat);
    a.rotation_deg = yawDeg;
    if (tilt && this._stationary(a)) a.tilt = tilt; else delete a.tilt;
    s._headCache?.delete(a);
  }

  // ---------- small helpers ----------
  _silentFrame() { this.internal = true; try { this.s.setFrameSilent(this.s.frame); } finally { this.internal = false; } }
  _planeHit(ray, y) { return this._planeHitRay(ray.ray.origin.toArray(), ray.ray.direction.toArray(), y); }
  _planeHitRay(o, d, y) {
    if (Math.abs(d[1]) < 1e-6) return null;
    const t = (y - o[1]) / d[1];
    if (t <= 0 || t > 600) return null;
    return new THREE.Vector3(o[0] + d[0] * t, y, o[2] + d[2] * t);
  }
  _name(x) { return x ? x.name || this.K.LIBRARY[x.kind]?.label || x.kind : "it"; }
  _note(msg) { this._noteText = msg; this.s.onInteract?.(msg); }
}
