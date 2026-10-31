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
import { dragTarget, damp, axisLock, edgeSnap, snapGrid, yawTilt, liftBy, qyaw, qmul, qnorm, stepArc, stepDuration, massForSize, legIK } from "./manip.mjs";

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

  get busy() { return !!(this.drag || this.tail || this.settling); }

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
  /** Too heavy to shove by walking into it, low enough to climb: a full crate, a rock (a person goes up onto it). */
  _climbable(a) {
    const h = this._height(a);
    return h >= 0.45 && h <= 1.7 && this._mass(a) >= 15;
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
    // Shoes, tyres and wheels that dip a few mm under the origin would lift the body off the floor: trim them.
    let [hx, hy, hz] = box.half, [cx, cy, cz] = box.center;
    if (cy - hy < 0 && cy + hy > 0.05) { const top = cy + hy; cy = top / 2; hy = top / 2; }
    box = { half: [hx, hy, hz], center: [cx, cy, cz] };
    // People: the torso, at least 0.4 m across (feet and arms reach that far; and standing that close beside a crate
    // must not read as standing on it).
    if (this._isPerson(a)) return [{ id: a.id, half: [Math.max(0.2, hx * 0.6), hy, Math.max(0.2, hz * 0.75)], center: box.center }];
    if (this.K.CAR_BODIES.has(a.kind)) {
      const y0 = cy - hy, H = 2 * hy;
      return [{ id: `${a.id}#body`, half: [hx, H * 0.24, hz], center: [cx, y0 + H * 0.32, cz] },
        { id: `${a.id}#cabin`, half: [hx * 0.9, H * 0.22, hz * 0.5], center: [cx, y0 + H * 0.78, cz - hz * 0.08] }];
    }
    if (a.kind === "sphere") return [{ id: a.id, half: box.half, center: box.center, sphere: Math.min(hx, hy, hz) }];
    return [{ id: a.id, half: box.half, center: box.center }];
  }

  /** Real-world weight: the kind's mass at its library size, scaled with volume (a half-size crate is a light box). */
  _mass(a) {
    if (Number.isFinite(+a.physics?.mass) && a.physics?.mass !== "" && a.physics?.mass != null) return physicsOf(a).mass;
    const L = this.K.LIBRARY[a.kind], ref = L?.height || 1;
    return massForSize(physicsOf(a).mass, (a.scale || 1) * ((a.height_m || ref) / ref));
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
      // Tables and counters hold still under a prop being set on them or a person climbing up (they aren't shoved).
      const dynamic = held ? heldMode === "prop" : this.pushable(a) && !((heldMode === "prop" || heldMode === "person") && SURFACES.has(a.kind)) &&
        !(heldMode === "person" && this._climbable(a));
      const type = held ? (heldMode === "kinematic" ? "kinematic" : "dynamic") : dynamic ? "dynamic" : "static";
      const p = physicsOf(a), feel = FEEL[a.kind] || {};
      const ids = [];
      for (const sh of shapes) {
        ids.push(w.addBody({ id: sh.id, shape: sh.sphere ? "sphere" : "box", half: sh.half, center: sh.center, radius: sh.sphere || 0, type,
          mass: this._isPerson(a) ? 75 : this._mass(a), friction: a.physics?.friction ?? feel.friction ?? 0.7,
          restitution: a.physics?.bounce ?? feel.restitution ?? 0.05, angularDamping: feel.angularDamping ?? 1.4, linearDamping: 0.08,
          pushFlat: this._isPerson(a),
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
    // A rider: they stay in the saddle (or seat) while the cursor is still over it; dragged off, they hop down.
    const wasMount = a.mount_id && !(a.mount_at > this.s.frame) ? { mount_id: a.mount_id, pose: a.pose, seat: a.seat, mount_at: a.mount_at } : null;
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
    const base = wasMount ? start.y : person ? (this.s._actorKeys(a).find((k) => k.frame === this.s.frame)?.position?.[1] ?? this.s._actorPosAt(a, this.s.frame)[1] ?? 0) : start.y;
    // The pressed point on the object: it stays under the cursor for the whole drag (at its own height).
    const h0 = ray.ray && typeof ray.intersectObject === "function" ? ray.intersectObject(g, true)[0]?.point : null;
    const q0 = h0 || this._planeHit(ray, Math.max(0, base) + 0.5) || this._planeHit(ray, Math.max(0, base)) || start.clone();
    const yt = yawTilt(g.quaternion.toArray());
    const yaw0 = mode === "prop" ? yt.yawDeg * Math.PI / 180 : g.rotation.y;
    const tilt = mode === "prop" ? yt.tilt : null;
    this.drag = {
      id, a, g, mode, settles, person, wasMount, start: start.toArray(), base: Math.max(0, base), lift: 0,
      grab: [q0.x - start.x, THREE.MathUtils.clamp(q0.y - start.y, 0.02, person ? 1.7 : 50), q0.z - start.z], cur: start.toArray(), yaw: yaw0, yaw0, tilt,
      quat: g.quaternion.toArray(), ray: { o: ray.ray.origin.toArray(), d: ray.ray.direction.toArray() },
      mods: {}, x: e.clientX, y: e.clientY, rotX: null, axis: null, support: null, mountHost: wasMount ? a.mount_id : null, guides: [],
      carried: this.s.state.actors.filter((x) => x.carry_id === id).map((x) => x.id), moved: false, t0: performance.now(),
      putDown, overPerson: null, surfY: person ? Math.max(0, base) : start.y, liftCur: 0, step: null,
    };
    if (wasMount) for (const bid of this.bodies.get(id) || []) this.world.setBodyProps(bid, { type: "static", pos: [0, -50, 0] });   // seated: out of the way
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
    // Let go halfway up onto a crate (or still walking to its edge): the climb finishes first, then they're let go.
    if (d.step || d.approaching) { this.tail = d; this._loop(); return; }
    this._release(d);
  }

  /** Let go: the held thing falls and settles (a prop) or stays put (a person, a vehicle); then it is written down. */
  _release(d) {
    if (d.mode === "prop" && d.settles) this.world.setKinematicTarget(d.id, null);   // let go: it falls and settles
    else if (this.bodies.has(d.id)) for (const bid of this.bodies.get(d.id)) {
      if (d.person || d.mode === "prop") this.world.setBodyProps(bid, { type: "static" });
    }
    this._unignore(d);
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
    // A climb still finishing after the release: run it out now (no drawing in between).
    for (let i = 0; i < 240 && this.tail; i++) this._tick(1 / 60, true);
    if (this.tail) { const t = this.tail; this.tail = null; this._release(t); }
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
      try { this._tick(dt || 1 / 60); } catch (err) { console.warn("Soundstage live", err); this.drag = null; this.tail = null; this.settling = false; this.world = null; return; }
      const ms = performance.now() - t0;
      this.stats.frames++; this.stats.ms += ms; this.stats.worst = Math.max(this.stats.worst, ms);
      if (this.settling && !this.drag && !this.tail) {
        const quiet = !this.world || (this.world.awakeCount?.() ?? 0) === 0;
        if (quiet || now - this._settleT0 > SETTLE_MAX_S * 1000) { this.finish(); return; }
      }
      if (this.drag || this.tail || this.settling) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _tick(dt, quiet = false) {
    const d = this.drag || this.tail, w = this.world;
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
      // The figure is where its body is (the stage's own hop-over-obstacles height is for walked paths, not a drag).
      if (d.person && !d.mountHost && pose) d.g.position.y = Math.max(0, pose.pos[1]);
      if (d.person && !d.mountHost) this._stepPose(d, pose);
      if (d.mountHost && d.mountBlend) {   // easing into the seat
        d.mountBlend.t += dt;
        const u = d.mountBlend.t / d.mountBlend.dur;
        if (u >= 1) d.mountBlend = null;
        else d.g.position.set(...stepArc(d.mountBlend.from, d.g.position.toArray(), u));
      }
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
    if (this.tail && !this.tail.step && !this.tail.approaching) { const t = this.tail; this.tail = null; this._release(t); }
    if (!quiet) this.s.render();
  }

  /** Where the held thing goes this frame. */
  _steer(d, dt) {
    const w = this.world;
    const exclude = new Set([...(this.bodies.get(d.id) || []), ...d.carried.flatMap((c) => this.bodies.get(c) || [])]);
    const o = d.ray.o, dir = d.ray.d;
    const planeHit = (y) => { const p = this._planeHitRay(o, dir, y); return p && p.toArray(); };
    let target;
    if (d.rotX != null) target = { pos: [d.cur[0], d.surfY, d.cur[2]], support: d.support, surface: true };
    else {
      let hit = w.raycast(o, dir, 800, { exclude });
      // A person over a horse, bike, car seat or bench: they mount it (shown live; kept if you let go there).
      const hostId = d.person && hit ? this._actorOfBody(hit.id) : null;
      const host = hostId && this._actor(hostId);
      if (d.person && host && this._mountable(host)) { this._previewMount(d, host, hit.point); return; }
      if (d.mountHost) this._clearMount(d);
      // A person pressed against the side of a box, a table or a ledge (the cursor is on its face): they climb up onto
      // its top, if it is low enough, rather than shoving it.
      if (d.person && hit && hit.id !== "__ground" && hit.normal[1] <= 0.7) {
        const top = w.raycast([hit.point[0] + dir[0] * 0.2, 40, hit.point[2] + dir[2] * 0.2], [0, -1, 0], 80, { exclude });
        if (top && top.id === hit.id && top.normal[1] > 0.7 && top.point[1] <= 1.75) hit = top;
      }
      // A prop only goes up onto a pushable crate it is already above (lifted with the wheel); lower down it pushes it.
      if (!d.person && hit && hit.id !== "__ground" && this.meta.get(this._actorOfBody(hit.id))?.dynamic) {
        const now = w.getPose(this.bodies.get(d.id)?.[0]);
        if (!now || now.pos[1] < hit.point[1] - 0.08) hit = null;
      }
      // A prop over a person: they take it (on release); it isn't set on their head.
      const over = !d.person && hit ? this._actor(this._actorOfBody(hit.id)) : null;
      d.overPerson = over && this._isPerson(over) && !over.mount_id && this._carriable(d.a) ? over.id : null;
      // Fixed surfaces under its middle: a table, a static prop or a ledge it slides onto (not a car, a person, an animal).
      const fixedEx = new Set(exclude);
      for (const [aid, ids] of this.bodies) {
        const oa = this._actor(aid), L = oa && this.K.LIBRARY[oa.kind];
        if (this.meta.get(aid)?.dynamic || this._isPerson(oa) || L?.rig === "vehicle" || L?.rig === "quadruped") for (const b of ids) fixedEx.add(b);
      }
      const support = d.person ? () => 0 : (x, z) => {
        const u = w.raycast([x, 40, z], [0, -1, 0], 80, { exclude: fixedEx });
        return u && u.id !== "__ground" && u.normal[1] > 0.7 && u.point[1] <= 1.8 ? { y: u.point[1], id: u.id } : 0;
      };
      target = dragTarget(d.overPerson ? null : hit, d.grab, planeHit, d.person ? 1.75 : 1.8, support);
      if (!target) return;
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
    const prevSupport = d.support;
    if (target.support !== d.support) {
      if (d.supportWasDynamic) w.setBodyProps(d.support, { type: "dynamic" });
      d.supportWasDynamic = false;
      const sa = this._actor(this._actorOfBody(target.support));
      if (target.support && sa && this.meta.get(sa.id)?.dynamic) { w.setBodyProps(target.support, { type: "static" }); d.supportWasDynamic = true; }
      d.support = target.support;
    }
    d.base = target.pos[1];
    d.liftCur = d.mode === "prop" ? damp(d.liftCur || 0, d.lift, 12, dt) : 0;   // the wheel raises it smoothly
    const want = [target.pos[0], target.pos[1] + d.liftCur, target.pos[2]];
    if (d.respawn) {
      d.respawn = false;
      d.step = null;
      for (const bid of this.bodies.get(d.id) || []) { this.world.setBodyProps(bid, { type: "dynamic", pos: d.cur }); this.world.setKinematicTarget(bid, d.cur, qyaw(d.yaw)); }
    }
    const own = this.bodies.get(d.id) || [];
    const yq = qyaw(d.yaw), q = d.tilt ? qnorm(qmul(yq, d.tilt)) : yq;
    // A change of level (onto a crate, a table, a ledge; down off it; off a horse): an eased step, up first and then
    // across (down: across, then a drop), never a pop. What it climbs onto or steps off doesn't snag it on the way.
    // Going up onto something still a stride away: walk (or slide) up to its edge first, then climb.
    if (target.pos[1] > d.surfY + 0.05 && target.support && d.cur[1] < target.pos[1] - 0.05 && !d.step) {
      const gap = this._gapTo(d, target.support, want);
      d.approaching = gap > 0.12;
      if (d.approaching) {
        const k = Math.min(1, 1.6 * dt / Math.max(0.05, gap));   // ~1.6 m/s toward the edge, no faster
        d.cur = [d.cur[0] + (want[0] - d.cur[0]) * Math.min(k, 1 - Math.exp(-32 * dt)), d.cur[1], d.cur[2] + (want[2] - d.cur[2]) * Math.min(k, 1 - Math.exp(-32 * dt))];
        for (const bid of own) w.setKinematicTarget(bid, d.cur, q);
        return;
      }
    }
    d.approaching = false;
    if (Math.abs(target.pos[1] - d.surfY) > 0.05) {
      const up = target.pos[1] > d.surfY;
      const pass = [...(up ? [target.support] : [prevSupport, d.support]), ...(d.hostIgnore || [])].filter(Boolean);
      // From where the body really is (it may have been held back by what it's now climbing), not where it was told.
      const at = own[0] && w.getPose(own[0]);
      if (at && at.pos[1] > -10) d.cur = [...at.pos];
      d.step = { p0: [...d.cur], t: 0, dur: stepDuration(target.pos[1] - d.cur[1], d.person), up };
      this._ignore(d, pass);
      d.surfY = target.pos[1];
    } else if (!d.step) d.surfY = target.pos[1];
    if (d.step) {
      d.step.t += dt;
      const u = d.step.t / d.step.dur;
      d.cur = stepArc(d.step.p0, want, u);
      d.step.u = Math.min(1, u);
      if (u >= 1) { d.step = null; this._unignore(d); d.hostIgnore = null; }
      for (const bid of own) w.setKinematicTarget(bid, d.cur, q);
      return;
    }
    // A little smoothing: the object keeps up with the cursor (~30 ms) but never jumps.
    d.cur = damp(d.cur, want, 32, dt);
    for (const bid of own) w.setKinematicTarget(bid, d.cur, q);
  }

  /** Horizontal gap (m) between the held body and `sid` along the way to `want` (Infinity if it isn't in the way). */
  _gapTo(d, sid, want) {
    const w = this.world, own = this.bodies.get(d.id) || [];
    const p = w.getPose(own[0]);
    if (!p) return 0;
    const dx = want[0] - p.pos[0], dz = want[2] - p.pos[2], L = Math.hypot(dx, dz);
    if (L < 1e-3) return 0;
    const sh = this._shapes(d.a, d.g)[0];
    const r = sh ? Math.min(sh.half[0], sh.half[2]) : 0.2;
    const ex = new Set([...own, ...(d.carried || []).flatMap((c) => this.bodies.get(c) || [])]);
    let best = Infinity;
    for (const hy of [0.12, 0.35]) {
      const h = w.raycast([p.pos[0], p.pos[1] + hy, p.pos[2]], [dx / L, 0, dz / L], L + 1, { exclude: ex });
      if (h && h.id === sid) best = Math.min(best, h.distance - r);
    }
    return best === Infinity ? 0 : best;
  }

  /** Let the held thing pass through these bodies (what it is climbing onto or stepping off) until the step is done. */
  _ignore(d, ids) {
    this._unignore(d);
    const own = this.bodies.get(d.id) || [];
    for (const bid of own) for (const o of ids) this.world?.ignorePair?.(bid, o, true);
    d.ignoring = ids;
  }
  _unignore(d) {
    if (!d.ignoring?.length) { d.ignoring = null; return; }
    for (const bid of this.bodies.get(d.id) || []) for (const o of d.ignoring) this.world?.ignorePair?.(bid, o, false);
    d.ignoring = null;
  }

  _regrab(d) {
    const p = this._planeHitRay(d.ray.o, d.ray.d, d.cur[1] + d.grab[1]);
    return p ? [p.x - d.cur[0], d.grab[1], p.z - d.cur[2]] : d.grab;
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
    // Swing up into the saddle / seat from where they are (not a pop): blended over the next ~0.45 s.
    if (d.mountHost !== host.id) { d.g.updateMatrixWorld(true); d.mountBlend = { from: d.g.position.toArray(), t: 0, dur: 0.45 }; }
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
    // Hop back down from where they sit (an eased step to where the cursor is, not a jump to the ground).
    d.g.updateMatrixWorld(true);
    const from = d.g.position.toArray();
    d.hostIgnore = [...(this.bodies.get(d.mountHost) || [])];
    delete a.mount_id; delete a.pose; delete a.seat; delete a.mount_at;
    d.mountHost = null; d.mountBlend = null;
    d.cur = from; d.surfY = from[1];
    for (const bid of this.bodies.get(d.id) || []) for (const h of d.hostIgnore) this.world.ignorePair?.(bid, h, true);
    d.respawn = true;
    this._silentFrame();
  }

  /**
   * The step / climb pose (IK) while a person changes level: going up, the lead foot is planted on the top (two-bone
   * IK, so the knee comes up high for a crate and the leg straightens as they rise), the trailing leg pushes off and
   * the arms reach forward for a big climb; going down, the lead leg reaches down and both knees give on landing.
   */
  _stepPose(d, pose) {
    if (!pose) return;
    const st = d.step;
    const u = st ? Math.min(1, st.t / st.dur) : 1;
    d._climbW = damp(d._climbW || 0, st ? 1 : 0, st ? 30 : 9, 1 / 60);
    const w = d._climbW;
    if (w < 0.01) return;
    const up = st ? st.up : d._lastUp;
    if (st) d._lastUp = st.up;
    const limbs = d.g.userData.limbs || [];
    const hipL = limbs.find((l) => l.part === "hip" && l.side > 0);
    const kneeL = hipL && hipL.pivot.children.find((c) => c.userData?.jkind === "knee");
    const sc = d.g.scale?.y || 1;
    const L1 = kneeL ? Math.abs(kneeL.position.y) * sc : 0.45, L2 = L1 * 1.05, hipH = hipL ? hipL.pivot.position.y * sc : 0.9;
    const rise = Math.max(0.05, (st ? d.surfY : pose.pos[1]) - (st?.p0?.[1] ?? pose.pos[1]));
    const s = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    for (const l of limbs) {
      const lead = l.side > 0;
      if (up) {
        // Lead foot: up onto the top edge, then stays planted there while the body comes up over it.
        const topY = d.surfY + 0.03, footZ = 0.24;
        const ik = legIK(topY - (pose.pos[1] + hipH), footZ, L1, L2);
        const plant = s(u / 0.3) * (1 - s((u - 0.82) / 0.18));
        const push = Math.sin(Math.PI * u);
        if (l.part === "hip") l.pivot.rotation.x += (lead ? -ik.hip * plant : 0.25 * push) * w;
        if (l.part === "knee") l.pivot.rotation.x += (lead ? ik.knee * plant : 0.7 * push) * w;
        const reach = Math.min(1, rise / 0.6) * push;
        if (l.part === "shoulder") l.pivot.rotation.x += -1.1 * reach * w;
        if (l.part === "elbow") l.pivot.rotation.x += -0.35 * reach * w;
      } else {
        const reachDown = Math.sin(Math.PI * Math.min(1, u / 0.8));
        const land = Math.sin(Math.PI * s((u - 0.7) / 0.3));
        if (l.part === "hip") l.pivot.rotation.x += (-(lead ? 0.55 : 0.1) * reachDown - 0.45 * land) * w;
        if (l.part === "knee") l.pivot.rotation.x += ((lead ? 0.15 : 0.5) * reachDown + 0.8 * land) * w;
        if (l.part === "shoulder") l.pivot.rotation.x += -0.4 * reachDown * w;
      }
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
