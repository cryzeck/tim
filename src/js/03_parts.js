// ============================================================================
//  Parts catalogue — every gadget's look (THREE) and behaviour (cannon-es).
//  Local frame: origin at the anchor cell's bottom-centre, +x = "forward".
// ============================================================================
const PARTS = {};
const PART_ORDER = [];
function defPart(id, def) {
  def.id = id;
  def.cells = def.cells || [[0, 0, 0]];
  PARTS[id] = def;
  PART_ORDER.push(id);
}

let INST_SEQ = 1;
class Inst {
  constructor(type, i, j, k, r = 0, o = {}) {
    this.type = type;
    this.def = PARTS[type];
    if (!this.def) throw new Error('Unknown part ' + type);
    this.i = i; this.j = j; this.k = k;
    this.r = ((r % 4) + 4) % 4;
    this.fixed = !!o.fixed;
    this.id = o.id || type + '#' + INST_SEQ++;
    this.ch = o.ch !== undefined ? o.ch : (this.def.defaultCh ?? null);
    this.v = {}; // named visual children
    this.group = this.def.build(this);
    this.group.traverse(m => { m.userData.inst = this; });
    this.place();
  }
  cells() {
    return this.def.cells.map(([x, y, z]) => { const [dx, dz] = rotXZ(x, z, this.r); return [this.i + dx, this.j + y, this.k + dz]; });
  }
  base(out = new THREE.Vector3()) { return cellToWorld(this.i, this.j, this.k, out); }
  local(x, y, z, out = new THREE.Vector3()) {
    const [dx, dz] = rotXZ(x, z, this.r);
    this.base(out); out.x += dx; out.y += y; out.z += dz; return out;
  }
  dir(x, z) { const [dx, dz] = rotXZ(x, z, this.r); return new THREE.Vector3(dx, 0, dz); }
  place() {
    const c = this.def.center || [0, 0, 0];
    this.local(c[0], c[1], c[2], this.group.position);
    this.group.rotation.set(0, this.r * Math.PI / 2, 0);
    this.group.visible = true;
    if (this.def.reset) this.def.reset(this);
  }
  // world (cannon) point -> this part's local frame (for animating children of a static group)
  toLocal(p, out = new THREE.Vector3()) {
    const b = this.base();
    const [x, z] = rotXZ(p.x - b.x, p.z - b.z, 4 - this.r);
    return out.set(x, p.y - b.y, z);
  }
  setChannel(ch) {
    this.ch = ch;
    if (this.def.paintChannel) this.def.paintChannel(this);
  }
}

// ---- cannon quaternion helpers ---------------------------------------------
const AX = { x: new CANNON.Vec3(1, 0, 0), y: new CANNON.Vec3(0, 1, 0), z: new CANNON.Vec3(0, 0, 1) };
function cq(axis, ang) { const q = new CANNON.Quaternion(); q.setFromAxisAngle(AX[axis], ang); return q; }
const V3 = (x, y, z) => new CANNON.Vec3(x, y, z);
const BOX = (x, y, z) => new CANNON.Box(new CANNON.Vec3(x, y, z));

// Painted alphabet faces for the toy blocks
const LETTER_MATS = [];
function letterMat(n) {
  if (!LETTER_MATS.length) {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const cols = ['#d6412f', '#2c6dd1', '#379a55', '#e89b1c', '#8a4fc7', '#1f9aa0'];
    letters.forEach((L, idx) => {
      const t = canvasTex(128, 128, (g, w, h) => {
        g.drawImage(TEX.woodLight.image, 0, 0, w, h);
        g.strokeStyle = cols[idx]; g.lineWidth = 9; g.strokeRect(9, 9, w - 18, h - 18);
        g.fillStyle = cols[idx]; g.font = '900 78px "Big Shoulders Stencil Display", Impact, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(L, w / 2, h / 2 + 4);
      });
      LETTER_MATS.push(std({ map: t, roughness: 0.68 }));
    });
  }
  return LETTER_MATS[n % LETTER_MATS.length];
}
function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function prismGeo(points, depth) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

// ============================================================================
//  STRUCTURE
// ============================================================================
defPart('block', {
  name: 'Toy Block', cat: 'Structure', blocksWind: true,
  desc: 'A solid wooden block. Stack it, build walls and towers, or block the wind.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.98, 0.98, 0.98, 0.06), letterMat(hashId(inst.id)), 0, 0.49, 0));
    return g;
  },
  physics(inst, sim) { sim.staticBody(inst, [{ s: BOX(0.5, 0.5, 0.5), p: [0, 0.5, 0] }], 'wood'); }
});

defPart('platform', {
  name: 'Shelf', cat: 'Structure',
  desc: 'A thin floating shelf. Its top is the floor of the cell it sits in.',
  build() {
    const g = new THREE.Group();
    g.add(mk(gRBox(1, 0.08, 1, 0.025), MAT.plank, 0, -0.04, 0));
    g.add(mk(gBox(0.06, 0.16, 0.7), MAT.iron, -0.38, -0.14, 0), mk(gBox(0.06, 0.16, 0.7), MAT.iron, 0.38, -0.14, 0));
    return g;
  },
  physics(inst, sim) { sim.staticBody(inst, [{ s: BOX(0.5, 0.04, 0.5), p: [0, -0.04, 0] }], 'wood'); }
});

const RAMP_A = Math.atan2(1, 2), RAMP_L = Math.sqrt(5);
const RAMP_N = new THREE.Vector2(Math.sin(RAMP_A), Math.cos(RAMP_A));
defPart('ramp', {
  name: 'Ramp', cat: 'Structure', cells: [[0, 0, 0], [1, 0, 0]],
  desc: 'Drops one level over two cells. Chain ramps nose-to-tail for a long, smooth run.',
  build() {
    const g = new THREE.Group();
    const wedge = mk(prismGeo([[-0.5, 0], [1.45, 0], [-0.5, 0.975]], 0.88), MAT.woodMid); // tucked under the plank (no z-fighting)
    g.add(wedge);
    // light top plank, sunk so its top is the physical surface
    const top = mk(gBox(RAMP_L + 0.01, 0.03, 0.9), MAT.plank, 0.5 - RAMP_N.x * 0.015, 0.5 - RAMP_N.y * 0.015, 0, { rz: -RAMP_A });
    g.add(top);
    for (const s of [-1, 1]) {
      g.add(mk(gBox(RAMP_L, 0.06, 0.04), MAT.brass, 0.5 + RAMP_N.x * 0.13, 0.5 + RAMP_N.y * 0.13, s * 0.46, { rz: -RAMP_A }));
      g.add(mk(gBox(RAMP_L * 0.98, 0.16, 0.012), MAT.darkMetal, 0.5 + RAMP_N.x * 0.07, 0.5 + RAMP_N.y * 0.07, s * 0.46, { rz: -RAMP_A }));
    }
    return g;
  },
  physics(inst, sim) {
    const v = [V3(-0.5, 0, -0.45), V3(1.5, 0, -0.45), V3(-0.5, 1, -0.45), V3(-0.5, 0, 0.45), V3(1.5, 0, 0.45), V3(-0.5, 1, 0.45)];
    const f = [[0, 1, 4, 3], [0, 3, 5, 2], [1, 2, 5, 4], [0, 2, 1], [3, 4, 5]];
    const wedge = new CANNON.ConvexPolyhedron({ vertices: v, faces: f });
    const list = [{ s: wedge, p: [0, 0, 0], m: 'wood' }];
    for (const s of [-1, 1]) list.push({ s: BOX(RAMP_L / 2, 0.1, 0.02), p: [0.5 + RAMP_N.x * 0.06, 0.5 + RAMP_N.y * 0.06, s * 0.46], q: cq('z', -RAMP_A), m: 'slick' });
    sim.staticBody(inst, list, 'wood');
  }
});

const CURVE_R = 0.72;
defPart('curve', {
  name: 'Curved Rail', cat: 'Structure',
  desc: 'Turns a rolling ball through 90°. Works in either direction.',
  build() {
    const g = new THREE.Group();
    g.add(mk(gBox(1, 0.05, 1), MAT.plank, 0, -0.022, 0));
    const wallGeo = cachedGeo('curvewall', () => new THREE.CylinderGeometry(CURVE_R + 0.03, CURVE_R + 0.03, 0.34, 18, 1, true, Math.PI / 2, Math.PI / 2));
    const wallMat = cachedGeo('curvewallmat', () => { const m = MAT.brass.clone(); m.side = THREE.DoubleSide; return m; });
    g.add(mk(wallGeo, wallMat, -0.5, 0.17, 0.5));
    const rimGeo = cachedGeo('curverim', () => new THREE.TorusGeometry(CURVE_R + 0.03, 0.025, 6, 18, Math.PI / 2));
    const rim = mk(rimGeo, MAT.brass, -0.5, 0.34, 0.5, { rx: Math.PI / 2 });
    rim.rotation.z = -Math.PI / 2; // arc from +x around to -z
    g.add(rim);
    return g;
  },
  physics(inst, sim) {
    const list = [{ s: BOX(0.5, 0.04, 0.5), p: [0, -0.04, 0], m: 'wood' }];
    const n = 7;
    for (let s = 0; s < n; s++) {
      const t0 = -Math.PI / 2 + (s / n) * (Math.PI / 2), t1 = -Math.PI / 2 + ((s + 1) / n) * (Math.PI / 2);
      const tm = (t0 + t1) / 2, rr = CURVE_R + 0.03;
      const len = rr * (t1 - t0) * 1.12;
      const cx = -0.5 + rr * Math.cos(tm), cz = 0.5 + rr * Math.sin(tm);
      const phi = Math.atan2(-Math.cos(tm), -Math.sin(tm));
      list.push({ s: BOX(len / 2, 0.17, 0.03), p: [cx, 0.17, cz], q: cq('y', phi), m: 'slick' });
    }
    sim.staticBody(inst, list, 'wood');
    // Rail guidance: while a ball rides the wall, keep its velocity tangent to the arc so it
    // leaves square to the exit face instead of skidding off at an angle.
    const C = inst.local(-0.5, 0, 0.5);
    const steer = (other) => {
      const d = other.userData?.dyn; if (!d || !d.roll) return;
      const v = other.velocity, p = other.position;
      let tx = -(p.z - C.z), tz = p.x - C.x;
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      if (tx * v.x + tz * v.z < 0) { tx = -tx; tz = -tz; }
      const sp = Math.hypot(v.x, v.z);
      v.x = tx * sp; v.z = tz * sp;
      const r = d.radius || 0.2; // spin to match, or old spin would skid it sideways later
      other.angularVelocity.set(v.z / r, 0, -v.x / r);
    };
    for (let n = 1; n < list.length; n++) list[n].s.onTouch = steer;
  }
});

defPart('funnel', {
  name: 'Funnel', cat: 'Structure',
  desc: 'Catches anything that falls in and drops it out of the bottom, dead centre. Beach balls are too big to fit.',
  build() {
    const g = new THREE.Group();
    const m = cachedGeo('funnelmat', () => { const mm = MAT.copper.clone(); mm.side = THREE.DoubleSide; return mm; });
    g.add(mk(gCyl(0.48 * Math.SQRT2, 0.27 * Math.SQRT2, 0.5, 4, true), m, 0, 0.75, 0, { ry: Math.PI / 4 }));
    g.add(mk(gCyl(0.29 * Math.SQRT2, 0.29 * Math.SQRT2, 0.2, 4, true), m, 0, 0.4, 0, { ry: Math.PI / 4 }));
    g.add(mk(gCyl(0.5 * Math.SQRT2, 0.5 * Math.SQRT2, 0.04, 4, true), MAT.brass, 0, 0.99, 0, { ry: Math.PI / 4 }));
    return g;
  },
  physics(inst, sim) {
    const list = [];
    const beta = Math.atan2(0.21, 0.5), half = Math.hypot(0.21, 0.5) / 2;
    for (let s = 0; s < 4; s++) {
      const a = s * Math.PI / 2;
      const q = cq('y', a).mult(cq('z', -beta));
      const [px, pz] = rotXZ(0.375 + 0.03, 0, s);
      list.push({ s: BOX(0.02, half + 0.03, 0.5), p: [px, 0.75, pz], q, m: 'metal' });
      const [tx, tz] = rotXZ(0.29, 0, s);
      list.push({ s: BOX(0.02, 0.1, 0.31), p: [tx, 0.4, tz], q: cq('y', a), m: 'metal' });
    }
    sim.staticBody(inst, list, 'metal');
    // The throat squares things up: anything passing through leaves centred and falling straight.
    const c = inst.base();
    sim.addActor({
      post() {
        for (const d of sim.dyn) {
          if (d.gone) continue;
          const p = d.body.position;
          const dx = p.x - c.x, dz = p.z - c.z, dy = p.y - c.y;
          if (dy < 0.05 || dy > 0.62 || Math.abs(dx) > 0.3 || Math.abs(dz) > 0.3) continue;
          const v = d.body.velocity;
          v.x *= 0.5; v.z *= 0.5;
          p.x -= dx * 0.25; p.z -= dz * 0.25;
          d.body.angularVelocity.scale(0.5, d.body.angularVelocity);
        }
      }
    });
  }
});

// ============================================================================
//  BOUNCERS
// ============================================================================
defPart('trampoline', {
  name: 'Trampoline', cat: 'Bouncers',
  desc: 'Throws anything that lands on it back up — about as high as it fell from.',
  build(inst) {
    const g = new THREE.Group();
    for (const [x, z] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) g.add(mk(gCyl(0.04, 0.05, 0.2, 8), MAT.darkMetal, x, 0.1, z));
    g.add(mk(gTorus(0.65, 0.045, 6, 4), MAT.blue, 0, 0.24, 0, { rx: Math.PI / 2 }));
    g.children[g.children.length - 1].rotation.z = Math.PI / 4;
    const pad = mk(gBox(0.82, 0.02, 0.82), MAT.trampoline, 0, 0.255, 0);
    g.add(pad);
    inst.v.pad = pad;
    return g;
  },
  reset(inst) { inst.v.pad.position.y = 0.255; inst.v.pad.scale.set(1, 1, 1); inst.dip = 0; },
  physics(inst, sim) {
    const mem = BOX(0.42, 0.04, 0.42);
    const frame = [];
    for (const [x, z, hx, hz] of [[-0.46, 0, 0.04, 0.5], [0.46, 0, 0.04, 0.5], [0, -0.46, 0.5, 0.04], [0, 0.46, 0.5, 0.04]]) frame.push({ s: BOX(hx, 0.13, hz), p: [x, 0.13, z], m: 'wood' });
    sim.staticBody(inst, [{ s: mem, p: [0, 0.22, 0], m: 'dead' }, ...frame], 'wood');
    mem.onTouch = (other) => {
      const d = other.userData?.dyn; if (!d) return;
      const vin = d.pv.y;
      if (vin < -1.2 && other.velocity.y < -vin * 0.5) {
        other.velocity.y = Math.min(17, -vin * 0.86 + 0.6);
        inst.dip = 1;
        sim.fx('boing', other.position, Math.abs(vin));
      }
    };
    sim.addActor({ fx(dt) { inst.dip = Math.max(0, (inst.dip || 0) - dt * 4); inst.v.pad.position.y = 0.255 - Math.sin(inst.dip * Math.PI) * 0.06; } });
  }
});

defPart('bumper', {
  name: 'Kicker', cat: 'Bouncers', blocksWind: true,
  desc: 'A pinball kicker. Anything that touches it gets booted toward the arrow at speed, whichever way it came from.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gCyl(0.38, 0.42, 0.12, 28), MAT.darkMetal, 0, 0.06, 0));
    const ring = mk(gCyl(0.32, 0.32, 0.3, 28), std({ color: 0xff3d7f, roughness: 0.3, emissive: 0xff3d7f, emissiveIntensity: 0.1 }), 0, 0.27, 0);
    g.add(ring);
    g.add(mk(gCyl(0.35, 0.35, 0.06, 28), MAT.white, 0, 0.45, 0));
    const arrow = mk(prismGeo([[-0.12, -0.07], [0.04, -0.07], [0.04, -0.15], [0.24, 0], [0.04, 0.15], [0.04, 0.07], [-0.12, 0.07]], 0.04), MAT.yellow, 0, 0.5, 0, { rx: -Math.PI / 2 });
    g.add(arrow);
    inst.v.ring = ring;
    return g;
  },
  reset(inst) { inst.v.ring.material.emissiveIntensity = 0.1; inst.flash = 0; },
  physics(inst, sim) {
    const cyl = new CANNON.Cylinder(0.34, 0.4, 0.48, 16);
    sim.staticBody(inst, [{ s: cyl, p: [0, 0.24, 0] }], 'dead');
    const dir = inst.dir(1, 0);
    const center = inst.local(0, 0.24, 0);
    cyl.onTouch = (other) => {
      const d = other.userData?.dyn; if (!d || d.balloon) return;
      if (sim.time - (d.lastBump || -1) < 0.15) return;
      const sp = 6.5;
      // launch from just in front of the kicker so it never fights its way through the post
      const p = other.position;
      const ahead = (p.x - center.x) * dir.x + (p.z - center.z) * dir.z;
      if (ahead < 0.1) {
        const side = -(p.x - center.x) * dir.z + (p.z - center.z) * dir.x;
        const reach = 0.42 + (d.radius || 0.25);
        p.x = center.x + dir.x * reach - dir.z * side * 0.3;
        p.z = center.z + dir.z * reach + dir.x * side * 0.3;
        p.y = Math.max(p.y, center.y - 0.24 + (d.radius || 0.25));
      }
      other.velocity.set(dir.x * sp, Math.max(other.velocity.y, 1.2), dir.z * sp);
      other.angularVelocity.set(0, 0, 0);
      d.lastBump = sim.time;
      inst.flash = 1;
      sim.fx('bumper', other.position);
    };
    sim.addActor({ fx(dt) { inst.flash = Math.max(0, (inst.flash || 0) - dt * 5); inst.v.ring.material.emissiveIntensity = 0.1 + inst.flash * 1.6; } });
  }
});

// ============================================================================
//  OBJECTS (dynamic)
// ============================================================================
function defBall(id, o) {
  defPart(id, {
    name: o.name, cat: 'Objects', dynamic: true, center: [0, o.r, 0], desc: o.desc,
    build() {
      const g = new THREE.Group();
      g.add(mk(gSphere(o.r, 36, 24), o.mat()));
      return g;
    },
    physics(inst, sim) {
      sim.dynBody(inst, {
        shapes: [{ s: new CANNON.Sphere(o.r) }], mass: o.mass, mat: o.pmat, linDamp: o.linDamp ?? 0.01, angDamp: o.angDamp ?? 0.05, roll: o.roll,
        snd: o.snd, windArea: Math.PI * o.r * o.r, magnetic: !!o.magnetic, radius: o.r
      });
    }
  });
}
defBall('bowling', { name: 'Bowling Ball', r: 0.24, mass: 4, roll: 0.32, pmat: 'bowling', snd: 'heavy', mat: () => MAT.bowling, desc: 'Heavy and stubborn. Barely bounces, shrugs off wind, and flattens anything in its way.' });
defBall('rubber', { name: 'Rubber Ball', r: 0.17, mass: 0.35, roll: 0.45, pmat: 'rubber', snd: 'rubber', mat: () => MAT.rubberBall, desc: 'Light and very bouncy.' });
defBall('marble', { name: 'Steel Ball', r: 0.14, mass: 0.9, roll: 0.25, pmat: 'steel', snd: 'metal', magnetic: true, mat: () => MAT.chrome, desc: 'A small, dense steel ball. Magnets pull it in.' });
defBall('beach', { name: 'Beach Ball', r: 0.36, mass: 0.12, pmat: 'beach', snd: 'soft', angDamp: 0.3, linDamp: 0.4, roll: 0.7, mat: () => MAT.beach, desc: 'Big and feather-light. Fans push it a long way. Too big for funnels.' });

defPart('domino', {
  name: 'Domino', cat: 'Objects', dynamic: true, cells: [[0, 0, 0], [0, 1, 0]], center: [0, 0.8, 0],
  desc: 'Stand them in a row one cell apart and topple the first one. Falls along its facing.',
  build() {
    const g = new THREE.Group();
    const m = MAT.dominoSide;
    g.add(mk(gBox(0.16, 1.6, 0.62), [MAT.domino, MAT.domino, m, m, m, m]));
    return g;
  },
  physics(inst, sim) {
    const shape = BOX(0.08, 0.8, 0.31);
    const d = sim.dynBody(inst, { shapes: [{ s: shape }], mass: 0.5, mat: 'domino', snd: 'domino', windArea: 0.9, linDamp: 0.02, angDamp: 0.05 });
    d.domino = true;
    // Topple assist: a falling domino always passes enough momentum on to the next one.
    // Pure rigid-body contact loses too much energy per hit for long chains to be reliable.
    shape.onTouch = (other) => {
      const od = other.userData?.dyn;
      if (!od || !od.domino) return;
      const b = d.body;
      if (dominoUp(b) > 0.97 || dominoUp(other) < 0.55) return; // I'm upright, or it's already down
      let dx = other.position.x - b.position.x, dz = other.position.z - b.position.z;
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const ax = dz, az = -dx; // axis = up × dir
      const w = other.angularVelocity;
      const along = w.x * ax + w.z * az;
      if (along < 2.4) { w.x += ax * (2.4 - along); w.z += az * (2.4 - along); }
      other.wakeUp();
    };
  }
});

defPart('crate', {
  name: 'Cardboard Box', cat: 'Objects', dynamic: true, center: [0, 0.4, 0],
  desc: 'A light box. It slides, tumbles and catches the wind.',
  build() { const g = new THREE.Group(); g.add(mk(gRBox(0.8, 0.8, 0.8, 0.03), MAT.crate)); return g; },
  physics(inst, sim) { sim.dynBody(inst, { shapes: [{ s: BOX(0.4, 0.4, 0.4) }], mass: 0.25, mat: 'crate', snd: 'soft', windArea: 0.64 }); }
});

defPart('balloon', {
  name: 'Balloon', cat: 'Objects', dynamic: true, center: [0, 0.5, 0],
  desc: 'Floats upward. Pops on pins and cactus spines. Blows around easily.',
  build() {
    const g = new THREE.Group();
    const b = mk(gSphere(0.28, 32, 24), MAT.balloon); b.scale.set(1, 1.16, 1);
    g.add(b);
    g.add(mk(gCyl(0.0, 0.05, 0.07, 10), MAT.balloon, 0, -0.34, 0));
    const pts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3(Math.sin(t * 5) * 0.03 * t, -0.37 - t * 0.55, Math.cos(t * 4) * 0.02 * t)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), MAT.string));
    return g;
  },
  physics(inst, sim) {
    const d = sim.dynBody(inst, { shapes: [{ s: new CANNON.Sphere(0.29) }], mass: 0.05, mat: 'balloon', snd: 'soft', windArea: 0.12, linDamp: 0.85, angDamp: 0.9, noRotate: true, balloon: true });
    d.body.allowSleep = false;
    sim.addActor({
      pre() { if (!d.gone) d.body.applyForce(V3(0, d.body.mass * G * 1.35, 0)); },
      post() { if (!d.gone && d.body.position.y > BOARD.h + 7) sim.removeDyn(d, 'away'); }
    });
  }
});

// ============================================================================
//  MACHINES
// ============================================================================
defPart('seesaw', {
  name: 'Seesaw', cat: 'Machines', cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
  desc: 'Starts tipped toward its first cell. Drop something heavy on the high end and whatever sits in the low end goes flying. Balls dropped onto either end land in its cups.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(prismGeo([[-0.28, 0], [0.28, 0], [0, 0.45]], 0.42), MAT.red, 1, 0, 0));
    g.add(mk(gCyl(0.05, 0.05, 0.7, 12), MAT.brass, 1, 0.5, 0, { rx: Math.PI / 2 }));
    for (const x of [-0.24, 2.24]) g.add(mk(gRBox(0.12, 0.075, 0.4, 0.02), MAT.rubber, x, 0.0375, 0));
    const plank = new THREE.Group();
    const inner = new THREE.Group(); inner.position.x = SEESAW_COM; // body origin sits off-centre
    inner.add(mk(gRBox(2.86, 0.1, 0.6, 0.03), MAT.woodLight));
    for (const s of [-1, 1]) inner.add(mk(gBox(0.06, 0.09, 0.6), MAT.woodMid, s * 1.4, 0.095, 0));
    inner.add(mk(gBox(0.4, 0.012, 0.61), MAT.red, -1.12, 0.051, 0, { cast: false }));
    plank.add(inner);
    g.add(plank);
    inst.v.plank = plank;
    return g;
  },
  reset(inst) { inst.v.plank.position.set(1 - SEESAW_COM * Math.cos(SEESAW_TILT), 0.5 - SEESAW_COM * Math.sin(SEESAW_TILT), 0); inst.v.plank.rotation.set(0, 0, SEESAW_TILT); },
  physics(inst, sim) {
    const anchor = sim.staticBody(inst, [{ s: BOX(0.18, 0.2, 0.21), p: [1, 0.2, 0] }], 'wood');
    sim.staticBody(inst, [{ s: BOX(0.06, 0.0375, 0.2), p: [-0.24, 0.0375, 0] }, { s: BOX(0.06, 0.0375, 0.2), p: [2.24, 0.0375, 0] }], 'rubberPad');
    const LIP = 0.045;
    const d = sim.dynBody(inst, {
      // low end lips: enough to cradle a ball, low enough not to swallow the launch
      shapes: [{ s: BOX(1.43, 0.05, 0.3), p: [SEESAW_COM, 0, 0] }, { s: BOX(0.03, LIP, 0.3), p: [SEESAW_COM - 1.4, 0.05 + LIP, 0] }, { s: BOX(0.03, LIP, 0.3), p: [SEESAW_COM + 1.4, 0.05 + LIP, 0] }],
      mass: 0.8, mat: 'woodSoft', snd: 'wood', q0: cq('z', SEESAW_TILT), angDamp: 0.05, child: inst.v.plank, windArea: 0,
      center: [1 - SEESAW_COM * Math.cos(SEESAW_TILT), 0.5 - SEESAW_COM * Math.sin(SEESAW_TILT), 0]
    });
    const hinge = new CANNON.HingeConstraint(anchor, d.body, { pivotA: V3(1, 0.5, 0), axisA: V3(0, 0, 1), pivotB: V3(SEESAW_COM, 0, 0), axisB: V3(0, 0, 1), collideConnected: false });
    sim.world.addConstraint(hinge);
  }
});
const SEESAW_TILT = 0.29; // ~17°, the -x end rests on its stop
const SEESAW_COM = 0.15; // centre of mass sits this far toward the resting end
function dominoUp(b) { const q = b.quaternion; return 1 - 2 * (q.x * q.x + q.z * q.z); }

defPart('conveyor', {
  name: 'Conveyor Belt', cat: 'Machines', cells: [[0, 0, 0], [1, 0, 0]], channel: 'device',
  desc: 'Carries whatever lands on it toward the arrow, and grips well enough to take things on from the side. Runs all the time unless it is wired to a coloured plate.',
  build(inst) {
    const g = new THREE.Group();
    const tex = TEX.belt.clone(); tex.needsUpdate = true;
    const beltMat = MAT.belt.clone(); beltMat.map = tex;
    inst.v.tex = tex;
    g.add(mk(gBox(2, 0.04, 0.86), beltMat, 0.5, 0.2, 0));
    g.add(mk(gBox(2, 0.14, 0.82), MAT.rubber, 0.5, 0.11, 0));
    for (const s of [-1, 1]) {
      g.add(mk(gBox(2.04, 0.2, 0.05), MAT.darkMetal, 0.5, 0.11, s * 0.455));
      g.add(mk(gBox(2.04, 0.02, 0.06), MAT.yellow, 0.5, 0.215, s * 0.455));
    }
    for (const x of [-0.45, 1.45]) g.add(mk(gCyl(0.1, 0.1, 0.86, 16), MAT.steel, x, 0.11, 0, { rx: Math.PI / 2 }));
    for (const x of [-0.3, 1.3]) for (const s of [-1, 1]) g.add(mk(gBox(0.08, 0.06, 0.08), MAT.darkMetal, x, 0.03, s * 0.42));
    // direction arrow + channel lamp
    const arrow = mk(prismGeo([[-0.25, 0.08], [0.15, 0.08], [0.15, 0.16], [0.4, 0], [0.15, -0.16], [0.15, -0.08], [-0.25, -0.08]], 0.02), MAT.yellow, 0.5, 0.225, 0, { rx: -Math.PI / 2, cast: false });
    g.add(arrow);
    const lamp = mk(gSphere(0.07, 12, 8), chMat(inst.ch), -0.45, 0.12, 0.49);
    g.add(lamp);
    inst.v.lamp = lamp;
    return g;
  },
  paintChannel(inst) { inst.v.lamp.material = chMat(inst.ch); },
  reset(inst) { inst.v.tex.offset.x = 0; },
  physics(inst, sim) {
    const belt = BOX(1.0, 0.11, 0.48);
    sim.staticBody(inst, [{ s: belt, p: [0.5, 0.11, 0], m: 'belt' }], 'metal');
    const dir = inst.dir(1, 0);
    const SPEED = 2.6, ACC = 30;
    const on = () => !inst.ch || sim.channels[inst.ch];
    belt.onTouch = (other) => {
      if (!on() || other.type !== CANNON.Body.DYNAMIC) return;
      const v = other.velocity;
      const par = v.x * dir.x + v.z * dir.z;
      const dv = clamp(SPEED - par, -ACC * DT, ACC * DT);
      v.x += dir.x * dv; v.z += dir.z * dv;
      // gently centre sideways drift
      const px = -dir.z, pz = dir.x;
      const side = v.x * px + v.z * pz;
      v.x -= px * side * 0.08; v.z -= pz * side * 0.08;
      other.wakeUp();
    };
    const lo = inst.local(-0.5, 0, -0.5), hi = inst.local(1.5, 0, 0.5);
    const box = { minX: Math.min(lo.x, hi.x), maxX: Math.max(lo.x, hi.x), minZ: Math.min(lo.z, hi.z), maxZ: Math.max(lo.z, hi.z), y: lo.y };
    if (inst.ch) sim.onChannel(inst.ch, () => sim.wakeInBox(box.minX, box.maxX, box.y, box.y + 1.5, box.minZ, box.maxZ));
    sim.addActor({ fx(dt) { if (on()) inst.v.tex.offset.x -= dt * SPEED * 1.5; }, hum: () => on() ? 0.4 : 0 });
  }
});

defPart('fan', {
  name: 'Desk Fan', cat: 'Machines', channel: 'device', blocksWind: true,
  desc: 'Blows light things away along its facing, up to 7 cells. Blocks stop the wind. Runs all the time unless wired to a coloured button.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gCyl(0.3, 0.34, 0.08, 24), MAT.darkMetal, -0.1, 0.04, 0));
    g.add(mk(gCyl(0.04, 0.04, 0.3, 10), MAT.steel, -0.1, 0.22, 0));
    g.add(mk(gCyl(0.13, 0.15, 0.3, 20), MAT.teal, -0.18, 0.5, 0, { rz: Math.PI / 2 }));
    const cage = new THREE.Group();
    cage.position.set(0.05, 0.5, 0);
    cage.add(mk(gTorus(0.38, 0.025, 8, 36), MAT.chrome, 0, 0, 0, { ry: Math.PI / 2 }));
    cage.add(mk(gTorus(0.25, 0.012, 6, 30), MAT.chrome, 0.06, 0, 0, { ry: Math.PI / 2 }));
    for (let s = 0; s < 6; s++) cage.add(mk(gBox(0.01, 0.76, 0.012), MAT.chrome, 0.06, 0, 0, { rx: (s / 6) * Math.PI }));
    const blades = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const bl = mk(gRBox(0.02, 0.3, 0.13, 0.01), MAT.teal, 0, 0.17, 0);
      const holder = new THREE.Group(); holder.rotation.x = (b / 4) * TAU; bl.rotation.y = 0.35; holder.add(bl); blades.add(holder);
    }
    blades.add(mk(gSphere(0.06, 12, 8), chMat(inst.ch), 0.02, 0, 0));
    cage.add(blades);
    g.add(cage);
    inst.v.blades = blades;
    inst.v.hub = blades.children[blades.children.length - 1];
    // wind streaks
    const streaks = new THREE.Group();
    const sm = new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.35, depthWrite: false });
    for (let s = 0; s < 14; s++) {
      const m = new THREE.Mesh(gBox(0.4, 0.012, 0.012), sm);
      m.userData.seed = Math.random();
      m.userData.y = 0.15 + Math.random() * 0.75; m.userData.z = (Math.random() - 0.5) * 0.85;
      streaks.add(m);
    }
    streaks.visible = false;
    g.add(streaks);
    inst.v.streaks = streaks;
    return g;
  },
  paintChannel(inst) { inst.v.hub.material = chMat(inst.ch); },
  reset(inst) { inst.v.streaks.visible = false; inst.spin = 0; },
  physics(inst, sim) {
    sim.staticBody(inst, [{ s: BOX(0.12, 0.34, 0.4), p: [0.0, 0.5, 0] }, { s: BOX(0.3, 0.05, 0.3), p: [-0.1, 0.05, 0] }], 'metal');
    // wind reach: stops at the first blocking cell
    let reach = 7;
    for (let s = 1; s <= 7; s++) {
      const [dx, dz] = rotXZ(s, 0, inst.r);
      const occ = sim.occAt(inst.i + dx, inst.j, inst.k + dz);
      if (occ && occ !== inst && occ.def.blocksWind) { reach = s - 0.5; break; }
    }
    inst.reach = reach;
    const on = () => !inst.ch || sim.channels[inst.ch];
    const P = 2.2;
    sim.addActor({
      pre() {
        if (!on()) return;
        const b = inst.base();
        for (const d of sim.dyn) {
          if (d.gone || !d.windArea) continue;
          const p = d.body.position;
          const [lx, lz] = rotXZ(p.x - b.x, p.z - b.z, 4 - inst.r);
          const ly = p.y - b.y;
          if (lx < 0.3 || lx > reach + 0.5 || ly < -0.05 || ly > 1.1 || Math.abs(lz) > 0.62) continue;
          const fall = 1 - 0.55 * (lx / (reach + 0.5));
          const F = P * d.windArea * fall;
          const [wx, wz] = rotXZ(1, 0, inst.r);
          d.body.applyForce(V3(wx * F, 0, wz * F));
          if (d.body.sleepState) d.body.wakeUp();
        }
      },
      fx(dt) {
        const active = on() && sim.running;
        inst.spin = lerp(inst.spin || 0, active ? 28 : 0, Math.min(1, dt * 3));
        inst.v.blades.rotation.x += inst.spin * dt;
        inst.v.streaks.visible = active;
        if (active) {
          for (const m of inst.v.streaks.children) {
            m.userData.seed = (m.userData.seed + dt * (0.9 + (m.userData.y % 0.3))) % 1;
            const t = m.userData.seed;
            m.position.set(0.4 + t * reach, m.userData.y, m.userData.z);
            m.scale.x = 0.5 + t;
            m.material.opacity = 0.35 * Math.sin(t * Math.PI);
          }
        }
      },
      hum: () => on() ? 0.7 : 0
    });
  }
});

defPart('ram', {
  name: 'Spring Ram', cat: 'Machines', channel: 'device',
  desc: 'Punches one cell forward. Fires once, half a second after the start, or when its coloured button is pressed.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.6, 0.12, 0.7, 0.03), MAT.darkMetal, -0.15, 0.06, 0));
    g.add(mk(gRBox(0.5, 0.42, 0.5, 0.06), MAT.red, -0.17, 0.33, 0));
    g.add(mk(gCyl(0.12, 0.12, 0.08, 20), MAT.brass, 0.1, 0.35, 0, { rz: Math.PI / 2 }));
    const lamp = mk(gSphere(0.06, 12, 8), chMat(inst.ch), -0.17, 0.58, 0);
    g.add(lamp); inst.v.lamp = lamp;
    const rod = mk(gCyl(0.045, 0.045, 1, 12), MAT.chrome, 0, 0.35, 0, { rz: Math.PI / 2 });
    g.add(rod); inst.v.rod = rod;
    const pad = new THREE.Group();
    pad.add(mk(gRBox(0.12, 0.42, 0.56, 0.05), MAT.rubber, 0, 0, 0));
    pad.add(mk(gRBox(0.06, 0.3, 0.44, 0.03), MAT.yellow, -0.07, 0, 0));
    g.add(pad); inst.v.pad = pad;
    return g;
  },
  paintChannel(inst) { inst.v.lamp.material = chMat(inst.ch); },
  reset(inst) { inst.v.pad.position.set(RAM_REST, 0.35, 0); ramRod(inst, RAM_REST); },
  physics(inst, sim) {
    sim.staticBody(inst, [{ s: BOX(0.26, 0.27, 0.27), p: [-0.17, 0.27, 0] }], 'metal');
    const pad = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: sim.mats.rubberPad });
    pad.addShape(BOX(0.06, 0.21, 0.28));
    const p0 = inst.local(RAM_REST, 0.35, 0);
    pad.position.set(p0.x, p0.y, p0.z);
    pad.quaternion.copy(cq('y', inst.r * Math.PI / 2));
    pad.allowSleep = false;
    sim.world.addBody(pad);
    const dir = inst.dir(1, 0);
    let state = 'idle', ext = 0, hold = 0, fired = false;
    const fire = () => { if (!fired) { fired = true; state = 'out'; sim.fx('ram', p0); } };
    if (inst.ch) sim.onChannel(inst.ch, fire);
    const EXT = 0.85, OUT = 7.5, BACK = 1.6;
    sim.addActor({
      pre(dt) {
        if (!inst.ch && !fired && sim.time >= 0.5) fire();
        let v = 0;
        if (state === 'out') { v = OUT; if (ext + v * dt >= EXT) { v = (EXT - ext) / dt; state = 'hold'; hold = 0.35; } }
        else if (state === 'hold') { hold -= dt; if (hold <= 0) state = 'back'; }
        else if (state === 'back') { v = -BACK; if (ext + v * dt <= 0) { v = -ext / dt; state = 'done'; } }
        ext += v * dt;
        pad.velocity.set(dir.x * v, 0, dir.z * v);
      },
      sync() {
        const lp = inst.toLocal(pad.position);
        inst.v.pad.position.set(lp.x, 0.35, lp.z);
        ramRod(inst, lp.x);
      }
    });
  }
});
const RAM_REST = 0.3;
function ramRod(inst, padX) {
  const start = 0.06, len = Math.max(0.01, padX - 0.05 - start);
  inst.v.rod.scale.y = len;
  inst.v.rod.position.x = start + len / 2;
}

defPart('magnet', {
  name: 'Horseshoe Magnet', cat: 'Machines', channel: 'device', blocksWind: true,
  desc: 'Pulls steel balls toward its open end, from up to 4 cells away. Always on unless wired to a coloured button.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.6, 0.1, 0.6, 0.03), MAT.darkMetal, -0.1, 0.05, 0));
    g.add(mk(gCyl(0.05, 0.05, 0.25, 10), MAT.steel, -0.25, 0.22, 0));
    const shoe = mk(gTorus(0.22, 0.085, 12, 28, Math.PI), MAT.red, -0.08, 0.5, 0, { rz: Math.PI / 2 });
    g.add(shoe);
    for (const s of [-1, 1]) {
      g.add(mk(gCyl(0.085, 0.085, 0.24, 14), MAT.red, 0.04, 0.5 + s * 0.22, 0, { rz: Math.PI / 2 }));
      g.add(mk(gCyl(0.086, 0.086, 0.1, 14), MAT.chrome, 0.2, 0.5 + s * 0.22, 0, { rz: Math.PI / 2 }));
    }
    const lamp = mk(gSphere(0.05, 12, 8), chMat(inst.ch), -0.32, 0.5, 0);
    g.add(lamp); inst.v.lamp = lamp;
    // field ripples
    const rip = new THREE.Group();
    const rm = new THREE.MeshBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(gTorus(0.3, 0.01, 4, 32), rm.clone()); t.rotation.y = Math.PI / 2; t.position.set(0.3, 0.5, 0); rip.add(t); }
    rip.visible = false; g.add(rip); inst.v.rip = rip;
    return g;
  },
  paintChannel(inst) { inst.v.lamp.material = chMat(inst.ch); },
  reset(inst) { inst.v.rip.visible = false; },
  physics(inst, sim) {
    sim.staticBody(inst, [{ s: BOX(0.18, 0.32, 0.12), p: [-0.05, 0.5, 0] }, { s: BOX(0.3, 0.05, 0.3), p: [-0.1, 0.05, 0] }], 'metal');
    const pole = inst.local(0.3, 0.5, 0);
    const on = () => !inst.ch || sim.channels[inst.ch];
    sim.addActor({
      pre() {
        if (!on()) return;
        const b = inst.base();
        for (const d of sim.dyn) {
          if (d.gone || !d.magnetic) continue;
          const p = d.body.position;
          const [lx] = rotXZ(p.x - b.x, p.z - b.z, 4 - inst.r);
          if (lx < 0.1) continue;
          const dx = pole.x - p.x, dy = pole.y - p.y, dz = pole.z - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 4.5 * 4.5) continue;
          const L = Math.sqrt(d2) || 1;
          const F = Math.min(40, d.body.mass * 15 / (d2 + 0.35));
          d.body.applyForce(V3(dx / L * F, dy / L * F, dz / L * F));
          if (d.body.sleepState) d.body.wakeUp();
        }
      },
      fx(dt) {
        const active = on() && sim.running;
        inst.v.rip.visible = active;
        if (active) inst.v.rip.children.forEach((t, i) => {
          const ph = ((sim.time * 0.8 + i / 3) % 1);
          t.position.x = 0.3 + ph * 2.2; t.scale.setScalar(1 + ph * 2.5); t.material.opacity = 0.3 * (1 - ph);
        });
      }
    });
  }
});

defPart('button', {
  name: 'Pressure Plate', cat: 'Machines', channel: 'switch', defaultCh: 'red',
  desc: 'When something lands on it, it switches on every gadget wired to the same colour. Stays on once pressed.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.9, 0.08, 0.9, 0.03), MAT.darkMetal, 0, 0.04, 0));
    const cap = mk(gRBox(0.72, 0.07, 0.72, 0.03), chMat(inst.ch), 0, 0.105, 0);
    g.add(cap); inst.v.cap = cap;
    return g;
  },
  paintChannel(inst) { inst.v.cap.material = chMat(inst.ch); },
  reset(inst) { inst.v.cap.position.y = 0.105; },
  physics(inst, sim) {
    const plate = BOX(0.36, 0.07, 0.36);
    sim.staticBody(inst, [{ s: BOX(0.45, 0.04, 0.45), p: [0, 0.04, 0] }, { s: plate, p: [0, 0.07, 0] }], 'metal');
    let pressed = false;
    plate.onTouch = (other) => {
      if (pressed || other.type !== CANNON.Body.DYNAMIC || other.mass < 0.1) return;
      pressed = true;
      inst.v.cap.position.y = 0.065;
      sim.flag('press:' + inst.id, inst.local(0, 0.2, 0));
      if (inst.ch) sim.activate(inst.ch, inst.local(0, 0.2, 0));
      sim.fx('press', inst.local(0, 0.15, 0));
    };
  }
});

// ============================================================================
//  HAZARDS
// ============================================================================
defPart('pins', {
  name: 'Pin Board', cat: 'Hazards', blocksWind: false,
  desc: 'A board studded with downward nails, mounted at the top of its cell. Pops balloons that float up into it.',
  build() {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.96, 0.1, 0.96, 0.02), MAT.woodDark, 0, 0.93, 0));
    const nailGeo = gCyl(0.012, 0.012, 0.22, 5), tipGeo = gCyl(0.0, 0.012, 0.05, 5);
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const x = -0.33 + a * 0.22, z = -0.33 + b * 0.22;
      g.add(mk(nailGeo, MAT.steel, x, 0.77, z, { recv: false }));
      g.add(mk(tipGeo, MAT.steel, x, 0.64, z, { recv: false, rx: Math.PI }));
    }
    return g;
  },
  physics(inst, sim) {
    const spikes = BOX(0.42, 0.14, 0.42);
    sim.staticBody(inst, [{ s: BOX(0.48, 0.05, 0.48), p: [0, 0.93, 0] }, { s: spikes, p: [0, 0.76, 0], m: 'metal' }], 'wood');
    spikes.onTouch = (other) => { const d = other.userData?.dyn; if (d && d.balloon) sim.popBalloon(d); };
  }
});

defPart('cactus', {
  name: 'Potted Cactus', cat: 'Hazards', blocksWind: true,
  desc: 'Prickly all over, pot included. Pops any balloon that touches it.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gCyl(0.26, 0.2, 0.34, 20), MAT.terracotta, 0, 0.17, 0));
    g.add(mk(gCyl(0.28, 0.28, 0.06, 20), MAT.terracotta, 0, 0.33, 0));
    g.add(mk(gCyl(0.24, 0.24, 0.02, 20), std({ color: 0x4a3222, roughness: 1 }), 0, 0.35, 0));
    const cap = (r, h) => cachedGeo(`cap${r},${h}`, () => new THREE.CapsuleGeometry(r, h, 6, 14));
    g.add(mk(cap(0.15, 0.5), MAT.cactus, 0, 0.66, 0));
    const arm1 = mk(cap(0.075, 0.18), MAT.cactus, 0.2, 0.72, 0); g.add(arm1);
    g.add(mk(cap(0.07, 0.08), MAT.cactus, 0.14, 0.62, 0, { rz: Math.PI / 2 }));
    const arm2 = mk(cap(0.07, 0.14), MAT.cactus, -0.19, 0.6, 0.02); g.add(arm2);
    g.add(mk(cap(0.065, 0.06), MAT.cactus, -0.13, 0.53, 0.01, { rz: Math.PI / 2 }));
    g.add(mk(gSphere(0.06, 10, 8), std({ color: 0xff6fa8, roughness: 0.6 }), 0, 1.0, 0));
    const r = rng(hashId(inst.id) + 3), sg = gCyl(0, 0.008, 0.06, 4);
    for (let i = 0; i < 34; i++) {
      const a = r() * TAU, y = 0.45 + r() * 0.48;
      const s = mk(sg, MAT.spine, Math.cos(a) * 0.15, y, Math.sin(a) * 0.15, { cast: false, recv: false });
      s.rotation.set(0, -a, -Math.PI / 2);
      g.add(s);
    }
    return g;
  },
  physics(inst, sim) {
    const body = new CANNON.Cylinder(0.2, 0.2, 0.75, 12), pot = new CANNON.Cylinder(0.27, 0.21, 0.36, 12);
    sim.staticBody(inst, [{ s: pot, p: [0, 0.18, 0], m: 'clay' }, { s: body, p: [0, 0.7, 0], m: 'clay' }], 'clay');
    body.onTouch = pot.onTouch = (other) => { const d = other.userData?.dyn; if (d && d.balloon) sim.popBalloon(d); };
  }
});

// ============================================================================
//  GOALS
// ============================================================================
defPart('bell', {
  name: 'Brass Bell', cat: 'Goals', blocksWind: false,
  desc: 'Rings when something knocks it hard enough. It hangs low, so rolling balls, flying balls and falling dominoes can all reach it.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gRBox(0.86, 0.08, 0.62, 0.03), MAT.woodDark, -0.04, 0.04, 0));
    g.add(mk(gBox(0.09, 0.9, 0.09), MAT.woodDark, -0.41, 0.49, 0));
    g.add(mk(gBox(0.56, 0.09, 0.09), MAT.woodDark, -0.17, 0.93, 0));
    g.add(mk(gBox(0.04, 0.3, 0.04), MAT.brass, -0.3, 0.8, 0, { rz: -0.8 }));
    const pivot = new THREE.Group(); pivot.position.set(0.05, 0.88, 0);
    const prof = [[0.02, 0], [0.06, -0.02], [0.1, -0.06], [0.12, -0.15], [0.15, -0.3], [0.24, -0.45], [0.3, -0.52], [0.29, -0.55], [0.0, -0.55]].map(p => new THREE.Vector2(p[0], p[1]));
    const bellGeo = cachedGeo('bellgeo', () => new THREE.LatheGeometry(prof, 32));
    const bm = cachedGeo('bellmat', () => { const m = MAT.brass.clone(); m.side = THREE.DoubleSide; return m; });
    pivot.add(mk(bellGeo, bm, 0, -0.04, 0));
    pivot.add(mk(gSphere(0.055, 12, 8), MAT.iron, 0, -0.55, 0));
    g.add(pivot); inst.v.bell = pivot;
    return g;
  },
  reset(inst) { inst.v.bell.rotation.set(0, 0, 0); inst.swing = 0; },
  physics(inst, sim) {
    const bellShape = new CANNON.Cylinder(0.12, 0.3, 0.44, 14);
    const post = BOX(0.045, 0.45, 0.045), arm = BOX(0.28, 0.045, 0.045), basePlate = BOX(0.43, 0.04, 0.31);
    sim.staticBody(inst, [
      { s: basePlate, p: [-0.04, 0.04, 0] }, { s: post, p: [-0.41, 0.49, 0] },
      { s: arm, p: [-0.17, 0.93, 0] }, { s: bellShape, p: [0.05, 0.5, 0], m: 'metal' }
    ], 'wood');
    let last = -1;
    const ringable = new Set([bellShape, post, arm, basePlate]);
    const onHit = (e) => {
      if (!ringable.has(e.contact.si) && !ringable.has(e.contact.sj)) return;
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (v < 0.45 || sim.time - last < 0.25) return;
      last = sim.time;
      inst.swing = Math.min(1, 0.4 + v * 0.12);
      inst.swingT = 0;
      sim.flag('ring:' + inst.id, inst.local(0.05, 0.6, 0));
      sim.fx('bell', inst.local(0.05, 0.6, 0));
    };
    bellShape.body.addEventListener('collide', onHit);
    if (post.body !== bellShape.body) post.body.addEventListener('collide', onHit);
    sim.addActor({
      fx(dt) {
        if (!inst.swing) return;
        inst.swingT += dt;
        inst.v.bell.rotation.z = Math.sin(inst.swingT * 11) * 0.35 * inst.swing * Math.exp(-inst.swingT * 1.4);
        if (inst.swingT > 4) inst.swing = 0;
      }
    });
  }
});

defPart('basket', {
  name: 'Basket', cat: 'Goals',
  desc: 'A slatted wooden basket. Goals ask for a particular object to land inside and stay there.',
  build() {
    const g = new THREE.Group();
    g.add(mk(gBox(0.92, 0.05, 0.92), MAT.woodDark, 0, 0.025, 0));
    for (let s = 0; s < 4; s++) {
      const side = new THREE.Group(); side.rotation.y = s * Math.PI / 2;
      for (let y = 0; y < 3; y++) side.add(mk(gBox(0.05, 0.14, 0.94), y % 2 ? MAT.woodLight : MAT.woodMid, 0.45, 0.12 + y * 0.22, 0));
      side.add(mk(gBox(0.06, 0.72, 0.06), MAT.woodDark, 0.45, 0.36, 0.45));
      g.add(side);
    }
    return g;
  },
  physics(inst, sim) {
    const list = [{ s: BOX(0.46, 0.025, 0.46), p: [0, 0.025, 0] }];
    for (let s = 0; s < 4; s++) { const [x, z] = rotXZ(0.46, 0, s); list.push({ s: BOX(0.025, 0.36, 0.48), p: [x, 0.36, z], q: cq('y', s * Math.PI / 2) }); }
    sim.staticBody(inst, list, 'woodSoft');
    const c = inst.base();
    sim.containers[inst.id] = { minX: c.x - 0.43, maxX: c.x + 0.43, minY: c.y + 0.03, maxY: c.y + 0.85, minZ: c.z - 0.43, maxZ: c.z + 0.43, pos: inst.local(0, 0.6, 0) };
  }
});

defPart('lamp', {
  name: 'Light Bulb', cat: 'Goals', channel: 'switch', defaultCh: 'red', blocksWind: true,
  desc: 'Lights up when a pressure plate of its colour is pressed.',
  build(inst) {
    const g = new THREE.Group();
    g.add(mk(gCyl(0.3, 0.34, 0.1, 24), MAT.woodDark, 0, 0.05, 0));
    g.add(mk(gCyl(0.035, 0.035, 0.4, 10), MAT.brass, 0, 0.3, 0));
    g.add(mk(gCyl(0.1, 0.09, 0.14, 18), MAT.brass, 0, 0.55, 0));
    const ring = mk(gTorus(0.1, 0.02, 6, 18), chMat(inst.ch), 0, 0.5, 0, { rx: Math.PI / 2 });
    g.add(ring); inst.v.ring = ring;
    const bulb = mk(gSphere(0.17, 24, 16), MAT.bulbOff, 0, 0.75, 0); bulb.scale.set(1, 1.1, 1);
    g.add(bulb); inst.v.bulb = bulb;
    const glow = new THREE.Sprite(MAT.glow); glow.scale.setScalar(1.6); glow.position.set(0, 0.75, 0); glow.visible = false;
    g.add(glow); inst.v.glow = glow;
    return g;
  },
  paintChannel(inst) { inst.v.ring.material = chMat(inst.ch); },
  reset(inst) { inst.v.bulb.material = MAT.bulbOff; inst.v.glow.visible = false; },
  physics(inst, sim) {
    sim.staticBody(inst, [{ s: new CANNON.Cylinder(0.3, 0.34, 0.1, 12), p: [0, 0.05, 0] }, { s: new CANNON.Sphere(0.18), p: [0, 0.75, 0], m: 'metal' }, { s: BOX(0.05, 0.25, 0.05), p: [0, 0.35, 0] }], 'wood');
    const light = () => {
      inst.v.bulb.material = MAT.bulbOn; inst.v.glow.visible = true;
      sim.flag('light:' + inst.id, inst.local(0, 0.75, 0));
    };
    if (inst.ch) sim.onChannel(inst.ch, light);
  }
});

const BIN_GROUPS = ['Structure', 'Bouncers', 'Objects', 'Machines', 'Hazards', 'Goals'];
