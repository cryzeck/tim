// ============================================================================
//  Simulation — builds a cannon-es world from the placed parts and runs it at a
//  fixed 240 Hz. Everything that matters (goals, triggers) is evaluated per
//  physics step, so a run is identical whatever the frame rate.
// ============================================================================
function makePhysMats() {
  const M = (friction, restitution) => new CANNON.Material({ friction, restitution });
  const mats = {
    floor: M(0.6, 0.55), wood: M(0.55, 0.6), woodSoft: M(0.6, 0.15), metal: M(0.35, 0.6), slick: M(0.04, 0.05),
    dead: M(0.4, 0), belt: M(1.0, 0.05), clay: M(0.6, 0.35), rubberPad: M(0.9, 0.3),
    bowling: M(0.5, 0.3), rubber: M(0.9, 0.95), steel: M(0.4, 0.5), beach: M(0.7, 0.85),
    balloon: M(0.3, 0.6), domino: M(0.45, 0.5), crate: M(0.4, 0.15)
  };
  return mats;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

class Sim {
  constructor(insts, goals, opts = {}) {
    this.silent = !!opts.silent;
    this.listeners = opts.listeners || {};
    this.running = true;
    const world = this.world = new CANNON.World({ gravity: V3(0, -G, 0), allowSleep: true });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 18;
    // cannon-es clamps friction *impulses* per step against mu*|frictionGravity|*m, i.e. it
    // treats the slip force as an impulse. Scaling by DT restores physical Coulomb friction.
    world.frictionGravity = V3(0, G * DT, 0);
    world.defaultContactMaterial.friction = 0.45;
    world.defaultContactMaterial.restitution = 0.3;
    this.mats = makePhysMats();
    this.time = 0;
    this.steps = 0;
    this.channels = {};
    this.chListeners = {};
    this.actors = [];
    this.dyn = [];
    this.containers = {};
    this.flags = {};
    this.removeQueue = [];
    this.quiet = 0;
    this.goals = goals || [];
    this.goalState = this.goals.map(() => false);
    this.insideT = this.goals.map(() => 0);
    this.insts = insts;
    this.occ = new Map();
    for (const inst of insts) for (const c of inst.cells()) this.occ.set(c.join(','), inst);
    const floor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: this.mats.floor });
    floor.addShape(BOX(BOARD.w / 2 + 7, 0.5, BOARD.d / 2 + 6), V3(0, -0.5, 1));
    world.addBody(floor);
    // fixed order: statics first so pairs & ids are stable
    const sorted = insts.slice().sort((a, b) => (a.def.dynamic ? 1 : 0) - (b.def.dynamic ? 1 : 0));
    for (const inst of sorted) inst.def.physics?.(inst, this);
  }

  occAt(i, j, k) { return this.occ.get(i + ',' + j + ',' + k); }

  // One cannon body per material: cannon-es takes restitution from *body* materials,
  // so e.g. a slick curved wall must not share a body with a bouncy wooden floor.
  staticBody(inst, list, mat) {
    const groups = new Map();
    for (const e of list) {
      const m = e.m || mat || 'wood';
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(e);
    }
    const p = inst.base();
    const q = cq('y', inst.r * Math.PI / 2);
    let first = null;
    for (const [m, entries] of groups) {
      const b = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: this.mats[m] });
      for (const e of entries) {
        e.s.material = this.mats[m];
        b.addShape(e.s, V3(e.p[0], e.p[1], e.p[2]), e.q);
      }
      b.position.set(p.x, p.y, p.z);
      b.quaternion.copy(q);
      b.userData = { inst };
      this.world.addBody(b);
      if (!first) first = b;
    }
    return first;
  }

  dynBody(inst, o) {
    const b = new CANNON.Body({ mass: o.mass, material: this.mats[o.mat] });
    for (const e of o.shapes) { e.s.material = this.mats[o.mat]; b.addShape(e.s, e.p ? V3(e.p[0], e.p[1], e.p[2]) : undefined, e.q); }
    const c = o.center || inst.def.center || [0, 0, 0];
    const p = inst.local(c[0], c[1], c[2]);
    b.position.set(p.x, p.y, p.z);
    let q = cq('y', inst.r * Math.PI / 2);
    if (o.q0) q = q.mult(o.q0);
    b.quaternion.copy(q);
    b.linearDamping = o.linDamp ?? 0.02;
    b.angularDamping = o.angDamp ?? 0.05;
    b.allowSleep = true;
    b.sleepSpeedLimit = 0.1;
    b.sleepTimeLimit = 0.6;
    if (o.noRotate) b.angularFactor.set(0, 0, 0);
    const d = {
      inst, body: b, pv: new CANNON.Vec3(), windArea: o.windArea || 0, magnetic: !!o.magnetic,
      balloon: !!o.balloon, child: o.child || null, snd: o.snd || 'wood', gone: false, roll: o.roll || 0, grounded: false, radius: o.radius || 0
    };
    b.userData = { inst, dyn: d };
    this.world.addBody(b);
    this.dyn.push(d);
    if (!this.silent) {
      b.addEventListener('collide', (e) => {
        const od = e.body.userData && e.body.userData.dyn;
        if (od && e.body.id < b.id) return; // one sound per dynamic pair
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (v > 0.7) this.fx('hit', b.position, { v, snd: d.snd, other: od ? od.snd : (e.body.userData?.inst?.def.id || 'floor') });
      });
    }
    return d;
  }

  addActor(a) { this.actors.push(a); return a; }

  onChannel(ch, fn) { (this.chListeners[ch] ||= []).push(fn); if (this.channels[ch]) fn(); }
  activate(ch, pos) {
    if (this.channels[ch]) return;
    this.channels[ch] = true;
    for (const fn of this.chListeners[ch] || []) fn();
    this.fx('channel', pos, ch);
  }
  flag(key, pos) {
    if (this.flags[key] !== undefined) return;
    this.flags[key] = this.time;
    this.listeners.flag?.(key, pos);
  }
  fx(kind, pos, val) { if (!this.silent && this.listeners.fx) this.listeners.fx(kind, pos, val); }

  wakeInBox(minX, maxX, minY, maxY, minZ, maxZ) {
    for (const d of this.dyn) {
      const p = d.body.position;
      if (!d.gone && p.x > minX && p.x < maxX && p.y > minY && p.y < maxY && p.z > minZ && p.z < maxZ) d.body.wakeUp();
    }
  }
  removeDyn(d, why) { if (d.gone) return; d.gone = true; d.why = why; this.removeQueue.push(d); }
  popBalloon(d) {
    if (d.gone) return;
    const p = new THREE.Vector3().copy(d.body.position);
    this.flag('pop:' + d.inst.id, p);
    this.fx('pop', p);
    this.removeDyn(d, 'pop');
  }

  step() {
    for (const d of this.dyn) { const v = d.body.velocity; d.pv.set(v.x, v.y, v.z); }
    for (const a of this.actors) if (a.pre) a.pre(DT, this);
    this.world.step(DT);
    const cs = this.world.contacts;
    for (let n = 0; n < cs.length; n++) {
      const c = cs[n];
      // cannon-es may swap bi/bj relative to si/sj, so resolve owners via shape.body
      if (c.si.onTouch) c.si.onTouch(c.si.body === c.bi ? c.bj : c.bi, c);
      if (c.sj.onTouch) c.sj.onTouch(c.sj.body === c.bj ? c.bi : c.bj, c);
      if (c.ni.y > 0.5 || c.ni.y < -0.5) {
        const da = c.bi.userData && c.bi.userData.dyn, db = c.bj.userData && c.bj.userData.dyn;
        if (da && da.roll) da.grounded = true;
        if (db && db.roll) db.grounded = true;
      }
    }
    // rolling resistance for balls that are actually resting on something
    for (const d of this.dyn) {
      if (!d.grounded) continue;
      d.grounded = false;
      const f = 1 - d.roll * DT, v = d.body.velocity, w = d.body.angularVelocity;
      v.x *= f; v.z *= f; w.x *= f; w.y *= f; w.z *= f;
    }
    for (const a of this.actors) if (a.post) a.post(DT, this);
    let moving = false;
    for (const d of this.dyn) {
      if (d.gone) continue;
      const b = d.body;
      if (b.position.y < -6) { this.removeDyn(d, 'fell'); continue; }
      if (b.sleepState !== CANNON.Body.SLEEPING && (b.velocity.lengthSquared() > 0.01 || b.angularVelocity.lengthSquared() > 0.04)) moving = true;
    }
    for (const d of this.removeQueue) { this.world.removeBody(d.body); }
    this.removeQueue.length = 0;
    this.quiet = moving ? 0 : this.quiet + DT;
    this.time += DT;
    this.steps++;
    this.evalGoals();
  }

  evalGoals() {
    for (let g = 0; g < this.goals.length; g++) {
      if (this.goalState[g]) continue;
      const goal = this.goals[g];
      let ok = false;
      switch (goal.type) {
        case 'ring': case 'pop': case 'press': case 'light':
          ok = this.flags[goal.type + ':' + goal.id] !== undefined; break;
        case 'inside': {
          const box = this.containers[goal.id];
          let inside = false;
          if (box) for (const d of this.dyn) {
            if (d.gone) continue;
            if (goal.what && goal.what !== 'any' && d.inst.type !== goal.what && d.inst.id !== goal.what) continue;
            const p = d.body.position;
            if (p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY && p.z > box.minZ && p.z < box.maxZ) { inside = true; break; }
          }
          this.insideT[g] = inside ? this.insideT[g] + DT : 0;
          ok = this.insideT[g] >= 0.4;
          if (ok) this.listeners.flag?.('inside:' + goal.id, box.pos);
          break;
        }
        case 'topple': {
          let all = true, any = false;
          for (const d of this.dyn) {
            if (d.inst.type !== (goal.what || 'domino')) continue;
            any = true;
            const q = d.body.quaternion;
            const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // y component of body's up axis
            if (!d.gone && upY > 0.5) { all = false; break; }
          }
          ok = any && all; break;
        }
        case 'away': ok = this.dyn.some(d => d.inst.id === goal.id && d.gone && d.why === 'away'); break;
      }
      if (ok) { this.goalState[g] = true; this.listeners.goal?.(g, goal); }
    }
  }
  get won() { return this.goals.length > 0 && this.goalState.every(Boolean); }

  hum() { let h = 0; for (const a of this.actors) if (a.hum) h = Math.max(h, a.hum()); return h; }

  sync() {
    for (const d of this.dyn) {
      if (d.gone) { d.inst.group.visible = false; continue; }
      const b = d.body;
      if (d.child) {
        d.inst.toLocal(b.position, d.child.position);
        _q.setFromAxisAngle(_up, -d.inst.r * Math.PI / 2);
        _q2.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        d.child.quaternion.copy(_q).multiply(_q2);
      } else {
        d.inst.group.position.set(b.position.x, b.position.y, b.position.z);
        d.inst.group.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      }
    }
    for (const a of this.actors) if (a.sync) a.sync();
  }
  fxFrame(dt) { for (const a of this.actors) if (a.fx) a.fx(dt); }
}
