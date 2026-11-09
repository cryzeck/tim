// ============================================================================
//  Game: state machine, building, UI, camera and the main loop
// ============================================================================
const Game = {
  mode: 'boot', L: null, levelIndex: null, insts: [], bin: {}, held: null, sim: null,
  speed: 1, acc: 0, hintsUsed: 0, won: false, attract: false, stallShown: false, runStart: 0
};
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const ptr = { x: 0, y: 0, down: false, sx: 0, sy: 0, t: 0, moved: false, button: 0, inside: false };
let floorPick = null, ghost = null, hoverInst = null, selBox = null, guides = null, hintGhost = null;
let planeH = null;           // null = snap to surfaces; number = working plane height while holding
let grab = [0, 0];           // keeps a picked-up part under the cursor
const THUMBS = {};

// ---------------------------------------------------------------------------
//  Thumbnails: each part is rendered once with a tiny offscreen renderer
// ---------------------------------------------------------------------------
function renderThumbs() {
  const S = 144;
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
  catch (e) { return; }
  r.setPixelRatio(1); r.setSize(S, S, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;
  const sc = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r);
  sc.environment = pm.fromScene(new RoomEnvironment(r), 0.04).texture;
  sc.add(new THREE.HemisphereLight(0xe8f0ff, 0x40301f, 0.9));
  const dl = new THREE.DirectionalLight(0xfff0dc, 2.2); dl.position.set(3, 6, 4); sc.add(dl);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 60);
  const box = new THREE.Box3(), c = new THREE.Vector3(), size = new THREE.Vector3();
  for (const id of PART_ORDER) {
    const def = PARTS[id];
    const fake = { id: id + '-thumb', ch: def.defaultCh ?? null, v: {}, r: 0 };
    const g = def.build(fake);
    def.reset?.(fake);
    g.traverse(o => { if (o.isSprite || o.isLine) o.visible = false; });
    sc.add(g);
    g.updateMatrixWorld(true);
    box.makeEmpty();
    g.traverse(o => { if (o.isMesh && o.visible && o.parent.visible) { o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); box.union(bb); } });
    box.getCenter(c); box.getSize(size);
    const rad = size.length() / 2;
    const dist = rad / Math.sin((cam.fov * Math.PI / 180) / 2) * 0.92;
    const dir = new THREE.Vector3(1.0, 0.75, 1.35).normalize();
    cam.position.copy(c).addScaledVector(dir, dist);
    cam.lookAt(c);
    r.render(sc, cam);
    THUMBS[id] = r.domElement.toDataURL('image/png');
    sc.remove(g);
  }
  pm.dispose();
  r.dispose();
  r.forceContextLoss?.();
}

// ---------------------------------------------------------------------------
//  Instances on the bench
// ---------------------------------------------------------------------------
function makeInst(spec, fixed) {
  const [t, i, j, k, r = 0, o = {}] = spec;
  return new Inst(t, i, j, k, r, { fixed, id: o.id, ch: o.ch });
}
function addInst(inst) { Game.insts.push(inst); scene.add(inst.group); benchChanged(); }
function removeInst(inst) {
  const n = Game.insts.indexOf(inst);
  if (n >= 0) Game.insts.splice(n, 1);
  scene.remove(inst.group);
  if (hoverInst === inst) setHover(null);
  benchChanged();
}
function clearInsts() { for (const inst of Game.insts) scene.remove(inst.group); Game.insts = []; setHover(null); }
function findInst(id) { return Game.insts.find(x => x.id === id); }
function occMap(except) {
  const m = new Map();
  for (const inst of Game.insts) if (inst !== except) for (const c of inst.cells()) m.set(c.join(','), inst);
  return m;
}
function placeProblem(type, i, j, k, r, except) {
  const occ = occMap(except);
  for (const [x, y, z] of PARTS[type].cells) {
    const [dx, dz] = rotXZ(x, z, r);
    const c = [i + dx, j + y, k + dz];
    if (!inBoard(c[0], c[1], c[2])) return c[1] >= BOARD.h ? 'Too high — that is above the ceiling of this bench.' : 'That spot is outside the build area.';
    if (occ.has(c.join(','))) return 'Something is already in that spot.';
  }
  return null;
}
function placedSpecs() {
  return Game.insts.filter(x => !x.fixed).map(x => [x.type, x.i, x.j, x.k, x.r, x.ch ? { ch: x.ch } : {}]);
}
function benchChanged() {
  if (Game.mode === 'edit' || Game.mode === 'boot') rebuildGuides();
  saveDraftSoon();
}

// Dashed plumb lines from floating parts down to whatever holds them up — a depth cue.
function rebuildGuides() {
  if (guides) { scene.remove(guides); guides.geometry.dispose(); guides = null; }
  const pts = [];
  const occ = occMap();
  for (const inst of Game.insts) {
    if (inst.j === 0) continue;
    const cells = inst.cells();
    const seen = new Set();
    for (const [ci, cj, ck] of cells) {
      if (seen.has(ci + ',' + ck)) continue; seen.add(ci + ',' + ck);
      let low = cj;
      for (const c of cells) if (c[0] === ci && c[2] === ck) low = Math.min(low, c[1]);
      let y = 0;
      for (let jj = low - 1; jj >= 0; jj--) { const o = occ.get(ci + ',' + jj + ',' + ck); if (o && o !== inst) { y = jj + 1; break; } }
      if (low - y < 0.5) continue;
      const w = cellToWorld(ci, low, ck);
      pts.push(w.x, low, w.z, w.x, y + 0.01, w.z);
      // footprint tick
      const s = 0.12;
      pts.push(w.x - s, y + 0.012, w.z, w.x + s, y + 0.012, w.z, w.x, y + 0.012, w.z - s, w.x, y + 0.012, w.z + s);
    }
  }
  if (!pts.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  guides = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: 0xbfe6ff, dashSize: 0.08, gapSize: 0.07, transparent: true, opacity: 0.55, depthWrite: false }));
  guides.computeLineDistances();
  guides.visible = Game.mode === 'edit';
  scene.add(guides);
}

// ---------------------------------------------------------------------------
//  Levels
// ---------------------------------------------------------------------------
function levelByIndex(idx) { return idx === 'sandbox' ? SANDBOX : LEVELS[idx]; }
function loadLevel(idx, opts = {}) {
  stopAttract();
  if (Game.sim) stopRun(true);
  cancelHeld(true);
  hideHint();
  const L = levelByIndex(idx);
  Game.L = L; Game.levelIndex = idx; Game.hintsUsed = 0; Game.won = false; Game.hintStep = 0;
  clearInsts();
  BOARD.w = L.board[0]; BOARD.d = L.board[1]; BOARD.h = L.board[2];
  buildSet(L.name);
  makeFloorPick();
  for (const f of L.fixed || []) addInst(makeInst(f, true));
  Game.bin = {};
  for (const [t, n] of Object.entries(L.bin || {})) Game.bin[t] = n === -1 ? Infinity : n;
  const placed = opts.placed || (opts.fresh ? null : store.get('draft.' + L.key, null));
  if (placed) for (const p of placed) {
    if (!(Game.bin[p[0]] > 0)) continue;
    if (placeProblem(p[0], p[1], p[2], p[3], p[4] || 0)) continue;
    addInst(makeInst(p, false));
    Game.bin[p[0]]--;
  }
  setMode('edit');
  renderBin(); renderGoals(); renderLevelName();
  homeCamera(true);
  rebuildGuides();
  $('#hud').hidden = false;
  $('#title').hidden = true;
  updateViewOffset();
  if (opts.brief !== false) showBrief();
}
let draftTimer = 0;
function saveDraftSoon() {
  if (!Game.L || Game.attract) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => store.set('draft.' + Game.L.key, placedSpecs()), 250);
}
function makeFloorPick() {
  if (floorPick) scene.remove(floorPick);
  floorPick = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.w, BOARD.d), new THREE.MeshBasicMaterial({ visible: false }));
  floorPick.rotation.x = -Math.PI / 2;
  floorPick.position.y = 0.001;
  scene.add(floorPick);
}

// ---------------------------------------------------------------------------
//  Modes: edit <-> run
// ---------------------------------------------------------------------------
function setMode(m) {
  Game.mode = m;
  const edit = m === 'edit';
  $('#runLabel').textContent = edit ? 'Run' : 'Reset';
  $('#runBtn').classList.toggle('running', !edit);
  $('#runIcon').innerHTML = edit ? '<path d="M7 4l13 8-13 8z"/>' : '<rect x="5" y="5" width="14" height="14" rx="2"/>';
  $('#bin').style.opacity = edit ? '' : '0.55';
  $('#bin').style.pointerEvents = edit ? '' : 'none';
  if (guides) guides.visible = edit;
  updateTools();
  updateStatus();
  updateWorkStatus();
}
function startRun() {
  if (Game.mode !== 'edit') return;
  cancelHeld();
  hideHint();
  setHover(null);
  Game.sim = new Sim(Game.insts, Game.L.goals, { listeners: simListeners });
  Game.acc = 0; Game.won = false; Game.stallShown = false;
  setMode('run');
  renderGoals();
  Sound.start();
}
function stopRun(silent) {
  if (!Game.sim) return;
  Game.sim.running = false;
  Game.sim = null;
  for (const inst of Game.insts) inst.place();
  FX.clear();
  clearPopTexts();
  Sound.setHum(0);
  if (!silent) Sound.reset();
  setMode('edit');
  renderGoals();
  updatePointer();
}
function toggleRun() { if (Game.mode === 'edit') startRun(); else if (Game.mode === 'run') stopRun(); }

const simListeners = {
  fx(kind, pos, val) {
    if (Game.attract && kind !== 'hit') { /* keep the title quiet-ish */ }
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);
    switch (kind) {
      case 'hit': {
        let s = val.snd;
        if (s !== 'heavy' && /funnel|bell|magnet|fan|lamp|conveyor|ram/.test(val.other)) s = 'metal';
        Sound.hit(s, val.v);
        if (val.snd === 'heavy' && val.v > 4) FX.burst('puff', p.clone().setY(p.y - 0.2), 7, { colors: [0xe9e1cf], speed: 1.4, gravity: -0.6, life: 0.7, size: 1.8, grow: 1.6, drag: 0.9 });
        break;
      }
      case 'boing': Sound.boing(); FX.burst('spark', p, 8, { colors: [0x9fd0ff, 0xffffff], speed: 2.5, life: 0.45, gravity: 3 }); break;
      case 'bumper': Sound.bumper(); FX.burst('spark', p, 12, { colors: [0xff3d7f, 0xffe066], speed: 4.5, life: 0.4, gravity: 2 }); break;
      case 'bell': Sound.bell(); FX.burst('spark', p, 24, { colors: [0xffd34d, 0xfff3b0], speed: 3.6, life: 0.8, gravity: 1 }); popText(p, 'Ding!', '#ffd34d'); break;
      case 'pop': Sound.pop(); FX.burst('confetti', p, 30, { colors: [0xff3b5c, 0xff6b81, 0xffd0d8], speed: 4.5, life: 1.3, gravity: 6 }); popText(p, 'Pop!', '#ff6b81'); break;
      case 'press': Sound.press(); popText(p, 'Click!', '#eef5ff'); break;
      case 'channel': Sound.zap(); FX.burst('spark', p, 18, { colors: [CH_HEX[val], 0xffffff], speed: 3.2, life: 0.55, gravity: 2 }); break;
      case 'ram': Sound.whoosh(); break;
    }
  },
  flag(key, pos) {
    if (key.startsWith('inside:') && pos) popText(new THREE.Vector3(pos.x, pos.y + 0.4, pos.z), 'In!', '#62e3a4');
    if (key.startsWith('light:') && pos) popText(new THREE.Vector3(pos.x, pos.y + 0.4, pos.z), 'Let there be light!', '#ffe07a');
  },
  goal(g) {
    if (Game.attract) return;
    Sound.goal();
    const li = $$('#goals li')[g];
    if (li) li.classList.add('done');
    const goal = Game.L.goals[g];
    const inst = findInst(goal.id);
    if (inst) FX.burst('confetti', inst.local(0, 1, 0), 40, { colors: [0x62e3a4, 0xeef5ff, 0xffd34d], speed: 4, life: 1.6, gravity: 5 });
  }
};

function checkRunState() {
  const sim = Game.sim;
  if (!sim || Game.attract) return;
  updateWorkStatus();
  if (sim.won && !Game.won) {
    Game.won = true;
    Game.winTime = sim.time;
    setTimeout(() => { if (Game.sim && Game.won) celebrate(); }, 700);
  }
  if (!sim.won && !Game.stallShown && Game.L.goals.length && ((sim.quiet > 2.5 && sim.time > 3) || sim.time > MAX_RUN_TIME)) {
    Game.stallShown = true;
    toast('The machine has stopped. Press Reset, adjust it, and run it again.', 'warn', 4200);
  }
}

// ---------------------------------------------------------------------------
//  Win & progress
// ---------------------------------------------------------------------------
function progress() { return store.get('progress', {}); }
function celebrate() {
  Sound.win();
  const W = BOARD.w, D = BOARD.d;
  for (let n = 0; n < 6; n++) FX.burst('confetti', new THREE.Vector3((Math.random() - 0.5) * W, BOARD.h + 1, (Math.random() - 0.5) * D), 50, { colors: [0xff7b22, 0xe8b75e, 0x62e3a4, 0x2e7fe0, 0xeef5ff, 0xff3d7f], speed: 3, life: 3.2, gravity: 4, up: 0.3, drag: 0.6 });
  const fl = $('#flash'); fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 60);
  const L = Game.L;
  const used = placedSpecs().length;
  const stars = 1 + (used <= L.par ? 1 : 0) + (Game.hintsUsed === 0 ? 1 : 0);
  const prog = progress();
  const prev = prog[L.key] || { stars: 0, best: Infinity };
  prog[L.key] = { stars: Math.max(prev.stars, stars), best: Math.min(prev.best ?? Infinity, used) };
  store.set('progress', prog);
  showWin(stars, used);
}

// ---------------------------------------------------------------------------
//  Pointer, raycasting & the placement ghost
// ---------------------------------------------------------------------------
function visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }
function castHits() {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ptr.x - rect.left) / rect.width) * 2 - 1, -((ptr.y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = Game.insts.map(i => i.group);
  if (floorPick) targets.push(floorPick);
  return raycaster.intersectObjects(targets, true).filter(h => (h.object === floorPick || (h.object.isMesh && visibleChain(h.object))));
}
function snapCell(hit) {
  const W = BOARD.w, D = BOARD.d;
  if (hit.object === floorPick) return [Math.floor(hit.point.x + W / 2), 0, Math.floor(hit.point.z + D / 2)];
  const inst = hit.object.userData.inst;
  if (!inst) return null;
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const s = ay >= ax && ay >= az ? [0, Math.sign(n.y) || 1, 0] : ax >= az ? [Math.sign(n.x), 0, 0] : [0, 0, Math.sign(n.z)];
  const cells = inst.cells();
  let best = cells[0], bd = Infinity;
  for (const c of cells) {
    const w = cellToWorld(c[0], c[1], c[2]);
    const d = (hit.point.x - w.x) ** 2 + (hit.point.y - w.y - 0.5) ** 2 + (hit.point.z - w.z) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  let c = [best[0] + s[0], best[1] + s[1], best[2] + s[2]];
  for (let g = 0; g < 3 && cells.some(q => q[0] === c[0] && q[1] === c[1] && q[2] === c[2]); g++) c = [c[0] + s[0], c[1] + s[1], c[2] + s[2]];
  c[1] = Math.max(0, c[1]);
  return c;
}
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function planeCell(h) {
  _plane.constant = -h;
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(_plane, p)) return null;
  return [Math.floor(p.x + BOARD.w / 2), h, Math.floor(p.z + BOARD.d / 2)];
}

function updatePointer() {
  if (Game.mode !== 'edit' || !ptr.inside) { if (ghost) ghost.group.visible = false; setHover(null); hideHoverLabel(); return; }
  const hits = castHits();
  if (Game.held) {
    let cell = null;
    if (planeH === null) { if (hits.length) cell = snapCell(hits[0]); }
    else { const pc = planeCell(planeH); if (pc) cell = [pc[0] + grab[0], planeH, pc[2] + grab[1]]; }
    setGhostCell(cell);
    hideHoverLabel();
  } else {
    const h = hits.find(x => x.object !== floorPick);
    setHover(h ? h.object.userData.inst : null);
  }
}

function makeGhost(type, r, ch) {
  removeGhost();
  const def = PARTS[type];
  const fake = { id: 'ghost', ch, v: {}, r, dip: 0 };
  const g = def.build(fake);
  def.reset?.(fake);
  const meshes = [];
  g.traverse(o => {
    if (o.isMesh) {
      const keep = Object.values(MAT.channel).includes(o.material) || o.material === MAT.channelNone;
      if (!keep) meshes.push(o);
      o.castShadow = false; o.receiveShadow = false; o.renderOrder = 5;
    } else if (o.isLine || o.isSprite) o.visible = false;
  });
  const marker = new THREE.Group();
  const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), new THREE.LineDashedMaterial({ color: 0x7cf0b0, dashSize: 0.1, gapSize: 0.07, transparent: true, opacity: 0.9, depthWrite: false }));
  drop.computeLineDistances();
  const foot = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 24), new THREE.MeshBasicMaterial({ color: 0x7cf0b0, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  foot.rotation.x = -Math.PI / 2;
  marker.add(drop, foot);
  scene.add(g, marker);
  ghost = { group: g, marker, drop, foot, meshes, type, r, ch, cell: null, valid: false, fake };
  setGhostMat(true);
  g.visible = false; marker.visible = false;
}
function setGhostMat(ok) {
  if (!ghost) return;
  ghost.valid = ok;
  const m = ok ? MAT.ghostOk : MAT.ghostBad;
  for (const o of ghost.meshes) o.material = m;
  const col = ok ? 0x7cf0b0 : 0xff5e50;
  ghost.drop.material.color.setHex(col); ghost.foot.material.color.setHex(col);
}
function removeGhost() {
  if (!ghost) return;
  scene.remove(ghost.group, ghost.marker);
  ghost = null;
  if (buildGrid) buildGrid.visible = false;
}
function setGhostCell(cell) {
  if (!ghost) return;
  if (!cell) { ghost.group.visible = false; ghost.marker.visible = false; ghost.cell = null; if (buildGrid) buildGrid.visible = false; updateStatus(); return; }
  cell[1] = clamp(cell[1], 0, BOARD.h - 1);
  ghost.cell = cell;
  const [i, j, k] = cell;
  const def = PARTS[ghost.type];
  const c = def.center || [0, 0, 0];
  const [dx, dz] = rotXZ(c[0], c[2], ghost.r);
  cellToWorld(i, j, k, ghost.group.position);
  ghost.group.position.x += dx; ghost.group.position.y += c[1]; ghost.group.position.z += dz;
  ghost.group.rotation.set(0, ghost.r * Math.PI / 2, 0);
  ghost.group.visible = true;
  const problem = placeProblem(ghost.type, i, j, k, ghost.r, null);
  ghost.problem = problem;
  setGhostMat(!problem);
  // plumb line to the support below
  const occ = occMap();
  let sy = 0;
  for (let jj = j - 1; jj >= 0; jj--) if (occ.has(i + ',' + jj + ',' + k)) { sy = jj + 1; break; }
  const base = cellToWorld(i, j, k);
  ghost.marker.position.set(base.x, j, base.z);
  ghost.drop.scale.y = Math.max(0.001, j - sy);
  ghost.drop.computeLineDistances();
  ghost.foot.position.y = -(j - sy) + 0.015;
  ghost.marker.visible = true;
  ghost.drop.visible = j - sy > 0.05;
  if (buildGrid) { buildGrid.visible = planeH !== null || j > 0; buildGrid.position.y = j + 0.005; }
  updateStatus();
}

function setHover(inst) {
  if (hoverInst === inst) return;
  hoverInst = inst;
  if (selBox) { scene.remove(selBox); selBox = null; }
  canvas.style.cursor = inst ? (inst.fixed ? 'not-allowed' : 'grab') : '';
  if (inst) {
    const box = new THREE.Box3();
    for (const [ci, cj, ck] of inst.cells()) {
      const w = cellToWorld(ci, cj, ck);
      box.expandByPoint(new THREE.Vector3(w.x - 0.5, cj, w.z - 0.5));
      box.expandByPoint(new THREE.Vector3(w.x + 0.5, cj + 1, w.z + 0.5));
    }
    box.expandByScalar(0.02);
    selBox = new THREE.Box3Helper(box, inst.fixed ? 0xe8b75e : 0x7cf0b0);
    selBox.material.transparent = true; selBox.material.opacity = 0.85; selBox.material.depthTest = false;
    scene.add(selBox);
    showHoverLabel(inst);
  } else hideHoverLabel();
  updateStatus();
}
function showHoverLabel(inst) {
  const el = $('#hoverLabel');
  el.textContent = inst.def.name + (inst.fixed ? '  ·  part of the puzzle' : '') + (inst.ch ? '  ·  ' + CH_LABEL[inst.ch] + ' wire' : '');
  el.style.left = ptr.x + 'px'; el.style.top = ptr.y + 'px';
  el.hidden = false;
}
function hideHoverLabel() { $('#hoverLabel').hidden = true; }

// ---------------------------------------------------------------------------
//  Holding, placing, moving
// ---------------------------------------------------------------------------
function holdFromBin(type, keep = {}) {
  if (Game.mode !== 'edit') return;
  if (Game.held && Game.held.from) cancelHeld();
  if (!(Game.bin[type] > 0)) { Sound.nope(); return; }
  const def = PARTS[type];
  const ch = keep.ch !== undefined ? keep.ch : (def.defaultCh ?? null);
  Game.held = { type, r: keep.r ?? (Game.held && Game.held.type === type ? Game.held.r : 0), ch, from: null };
  if (!keep.continuing) { planeH = null; grab = [0, 0]; }
  makeGhost(type, Game.held.r, ch);
  controls.mouseButtons.LEFT = -1;
  setHover(null);
  renderBinActive();
  updateTools();
  updatePointer();
  if (!keep.continuing) Sound.pickup();
}
function pickUp(inst) {
  if (inst.fixed || Game.mode !== 'edit') return;
  const hits = castHits();
  removeInst(inst);
  Game.held = { type: inst.type, r: inst.r, ch: inst.ch, from: { i: inst.i, j: inst.j, k: inst.k, r: inst.r, ch: inst.ch } };
  planeH = inst.j;
  raycaster.setFromCamera(ndc, camera);
  const pc = planeCell(planeH);
  grab = pc ? [inst.i - pc[0], inst.k - pc[2]] : [0, 0];
  void hits;
  makeGhost(inst.type, inst.r, inst.ch);
  controls.mouseButtons.LEFT = -1;
  Sound.pickup();
  renderBinActive();
  updateTools();
  updatePointer();
}
function tryPlace() {
  const h = Game.held;
  if (!h || !ghost) return;
  if (!ghost.cell) return;
  const [i, j, k] = ghost.cell;
  const problem = placeProblem(h.type, i, j, k, h.r);
  if (problem) { Sound.nope(); toast(problem, 'warn', 1800); return; }
  const inst = new Inst(h.type, i, j, k, h.r, { ch: h.ch });
  addInst(inst);
  Sound.place();
  FX.burst('puff', inst.local(0, 0.05, 0), 8, { colors: [0xf4ead8], speed: 1.6, gravity: -0.4, life: 0.5, size: 1.4, grow: 1.2, up: 0.2, drag: 0.9 });
  const fromBin = !h.from;
  if (fromBin && Game.bin[h.type] !== Infinity) Game.bin[h.type]--;
  Game.held = null;
  removeGhost();
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (fromBin && Game.bin[h.type] > 0) holdFromBin(h.type, { r: h.r, ch: h.ch, continuing: true });
  else { planeH = null; grab = [0, 0]; }
  renderBin();
  updateTools();
  updatePointer();
}
function cancelHeld(silent) {
  const h = Game.held;
  if (!h) return;
  if (h.from) {
    const f = h.from;
    if (!placeProblem(h.type, f.i, f.j, f.k, f.r)) addInst(new Inst(h.type, f.i, f.j, f.k, f.r, { ch: f.ch }));
    else if (Game.bin[h.type] !== Infinity) Game.bin[h.type] = (Game.bin[h.type] || 0) + 1;
  }
  Game.held = null;
  planeH = null; grab = [0, 0];
  removeGhost();
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  renderBin();
  updateTools();
  updateStatus();
  if (!silent) Sound.click();
}
function returnToBin(inst) {
  if (inst) {
    if (inst.fixed) { Sound.nope(); toast('That part belongs to the puzzle and cannot be removed.', 'warn'); return; }
    removeInst(inst);
    if (Game.bin[inst.type] !== Infinity) Game.bin[inst.type] = (Game.bin[inst.type] || 0) + 1;
  } else if (Game.held) {
    const h = Game.held;
    if (h.from && Game.bin[h.type] !== Infinity) Game.bin[h.type] = (Game.bin[h.type] || 0) + 1;
    Game.held = null; planeH = null; grab = [0, 0];
    removeGhost();
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  } else return;
  Sound.remove();
  renderBin(); updateTools(); updateStatus(); updatePointer();
}
function rotateAction() {
  if (Game.mode !== 'edit') return;
  if (Game.held) {
    Game.held.r = (Game.held.r + 1) % 4;
    ghost.r = Game.held.r;
    Sound.rotate();
    updatePointer();
    return;
  }
  const inst = hoverInst;
  if (inst && !inst.fixed) {
    const nr = (inst.r + 1) % 4;
    if (placeProblem(inst.type, inst.i, inst.j, inst.k, nr, inst)) { Sound.nope(); toast('No room to turn it there.', 'warn', 1500); return; }
    removeInst(inst);
    const ni = new Inst(inst.type, inst.i, inst.j, inst.k, nr, { ch: inst.ch });
    addInst(ni);
    Sound.rotate();
    updatePointer();
  }
}
function heightAction(d) {
  if (Game.mode !== 'edit' || !Game.held) return;
  const cur = ghost && ghost.cell ? ghost.cell[1] : 0;
  const before = ghost && ghost.cell ? ghost.cell.slice() : null;
  const nh = clamp((planeH === null ? cur : planeH) + d, 0, BOARD.h - 1);
  planeH = nh;
  if (before) {
    const pc = planeCell(nh);
    if (pc) grab = [before[0] - pc[0], before[2] - pc[2]];
  }
  Sound.rotate();
  updatePointer();
}
function wireAction() {
  if (Game.mode !== 'edit') return;
  const target = Game.held ? Game.held : (hoverInst && !hoverInst.fixed ? hoverInst : null);
  const type = Game.held ? Game.held.type : target && target.type;
  if (!target || !PARTS[type].channel) { Sound.nope(); toast('Only fans, belts, rams, magnets, plates and bulbs take a wire colour.', 'warn', 2200); return; }
  const cycle = PARTS[type].channel === 'switch' ? CHANNELS : [null, ...CHANNELS];
  const next = cycle[(cycle.indexOf(target.ch) + 1) % cycle.length];
  if (Game.held) { Game.held.ch = next; makeGhost(type, Game.held.r, next); updatePointer(); }
  else { hoverInst.setChannel(next); showHoverLabel(hoverInst); saveDraftSoon(); }
  Sound.click();
  updateTools();
  toast(next ? `${CH_LABEL[next]} wire: runs when a ${CH_LABEL[next].toLowerCase()} plate is pressed.` : 'No wire: runs from the moment the machine starts.', '', 1800);
}

// ---------------------------------------------------------------------------
//  Hints: reveal the next part of the reference solution as a golden ghost
// ---------------------------------------------------------------------------
function showHint() {
  if (Game.mode !== 'edit' || !Game.L.solution) { if (!Game.L.solution) toast('No hints in the free workshop. Anything goes.', '', 1800); return; }
  hideHint();
  const placed = Game.insts.filter(x => !x.fixed);
  const sol = Game.L.solution;
  const match = (s) => placed.some(p => p.type === s[0] && p.i === s[1] && p.j === s[2] && p.k === s[3] && (p.r === (s[4] || 0) || PARTS[p.type].symmetric));
  const next = sol.find(s => !match(s));
  if (!next) { toast('Every hinted part is already in place. Press Run!', '', 2200); return; }
  Game.hintsUsed++;
  const [t, i, j, k, r = 0, o = {}] = next;
  const def = PARTS[t];
  const fake = { id: 'hint', ch: o.ch ?? def.defaultCh ?? null, v: {}, r };
  const g = def.build(fake); def.reset?.(fake);
  g.traverse(m => { if (m.isMesh) { m.material = MAT.hint; m.castShadow = false; m.renderOrder = 4; } else if (m.isLine || m.isSprite) m.visible = false; });
  const c = def.center || [0, 0, 0];
  const [dx, dz] = rotXZ(c[0], c[2], r);
  cellToWorld(i, j, k, g.position); g.position.x += dx; g.position.y += c[1]; g.position.z += dz;
  g.rotation.y = r * Math.PI / 2;
  scene.add(g);
  hintGhost = g;
  const where = `column ${String.fromCharCode(65 + i)}, row ${k + 1}` + (j ? `, ${j} up` : ', on the mat');
  toast(`Hint: a ${def.name}${o.ch ? ' on the ' + CH_LABEL[o.ch].toLowerCase() + ' wire' : ''} goes at ${where}.`, '', 3600);
  Sound.goal();
}
function hideHint() { if (hintGhost) { scene.remove(hintGhost); hintGhost = null; } }

// ---------------------------------------------------------------------------
//  UI rendering
// ---------------------------------------------------------------------------
function renderLevelName() {
  const L = Game.L;
  $('#levelName').textContent = Game.levelIndex === 'sandbox' ? 'Free workshop · no rules' : `Puzzle ${String(Game.levelIndex + 1).padStart(2, '0')} / ${LEVELS.length} · ${L.name}`;
}
function goalText(goal) {
  if (goal.text) return goal.text;
  const what = goal.what && PARTS[goal.what] ? PARTS[goal.what].name.toLowerCase() : 'object';
  switch (goal.type) {
    case 'ring': return 'Ring the bell';
    case 'inside': return `Land the ${what} in the basket`;
    case 'pop': return 'Pop the balloon';
    case 'press': return 'Press the plate';
    case 'light': return 'Light the bulb';
    case 'topple': return 'Topple every domino';
    case 'away': return 'Let the balloon fly free';
  }
  return goal.type;
}
function renderGoals() {
  const ul = $('#goals');
  ul.innerHTML = '';
  const goals = Game.L.goals || [];
  if (!goals.length) {
    const li = document.createElement('li'); li.className = 'sandbox';
    li.textContent = 'No work order. Build whatever you like and press Run.';
    ul.appendChild(li);
  }
  goals.forEach((g, n) => {
    const li = document.createElement('li');
    if (Game.sim && Game.sim.goalState[n]) li.classList.add('done');
    li.innerHTML = '<div class="box"></div><span></span>';
    li.querySelector('span').textContent = goalText(g);
    ul.appendChild(li);
  });
  updateWorkStatus();
}
function updateWorkStatus() {
  const el = $('#woStatus');
  if (!el || !Game.L) return;
  if (Game.mode === 'run' && Game.sim) {
    const t = Game.sim.time;
    el.textContent = Game.won ? `Done in ${(Game.winTime ?? t).toFixed(1)} s` : `Running ${t.toFixed(1)} s`;
  } else {
    const n = placedSpecs().length;
    el.textContent = Game.L.goals.length ? `Par ${Game.L.par} parts · used ${n}` : `${n} parts placed`;
  }
}
function binTypes() {
  return Object.keys(Game.bin).sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b));
}
function renderBin() {
  const list = $('#binList');
  list.innerHTML = '';
  const types = binTypes();
  let total = 0;
  let lastCat = null;
  types.forEach((t, n) => {
    const def = PARTS[t];
    const cnt = Game.bin[t];
    if (cnt !== Infinity) total += cnt;
    if (Game.levelIndex === 'sandbox' && def.cat !== lastCat) {
      const h = document.createElement('div'); h.className = 'bin-cat eyebrow'; h.textContent = def.cat; list.appendChild(h); lastCat = def.cat;
    }
    const card = document.createElement('button');
    card.className = 'card' + (cnt > 0 ? '' : ' empty');
    card.dataset.type = t;
    card.innerHTML = `${n < 9 ? `<span class="key">${n + 1}</span>` : ''}<img alt="" src="${THUMBS[t] || ''}"><span class="nm"></span><span class="ct">${cnt === Infinity ? '∞' : '×' + cnt}</span>`;
    card.querySelector('.nm').textContent = def.name;
    card.addEventListener('click', () => { Sound.unlock(); holdFromBin(t); });
    card.addEventListener('mouseenter', () => showTip(card, def));
    card.addEventListener('mouseleave', hideTip);
    list.appendChild(card);
  });
  if (!types.length) {
    const p = document.createElement('div'); p.className = 'bin-empty-note';
    p.textContent = 'Nothing to add. Everything you need is already on the bench.';
    list.appendChild(p);
  }
  $('#binCount').textContent = Game.levelIndex === 'sandbox' ? 'unlimited' : `${total} left`;
  renderBinActive();
  updateWorkStatus();
}
function renderBinActive() {
  $$('#binList .card').forEach(c => c.classList.toggle('active', !!Game.held && !Game.held.from && c.dataset.type === Game.held.type));
}
function showTip(card, def) {
  const tip = $('#tip');
  tip.innerHTML = `<b></b><span></span>`;
  tip.querySelector('b').textContent = def.name;
  tip.querySelector('span').textContent = def.desc;
  tip.hidden = false;
  const r = card.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, r.left - tr.width - 12) + 'px';
  tip.style.top = clamp(r.top, 8, window.innerHeight - tr.height - 8) + 'px';
}
function hideTip() { $('#tip').hidden = true; }

function updateTools() {
  const edit = Game.mode === 'edit';
  const h = Game.held;
  const target = h || (hoverInst && !hoverInst.fixed ? hoverInst : null);
  $('#rotBtn').disabled = !edit;
  $('#upBtn').disabled = !edit || !h;
  $('#downBtn').disabled = !edit || !h;
  $('#wireBtn').disabled = !edit;
  $('#delBtn').disabled = !edit;
  $('#hintBtn').disabled = !edit || !Game.L || !Game.L.solution;
  $('#clearBtn').disabled = !edit;
  const ch = target ? target.ch : null;
  const dot = $('#wireDot');
  dot.style.background = ch ? CH_CSS[ch] : '#8a919b';
}
function updateStatus() {
  const el = $('#status');
  if (!el) return;
  if (Game.mode === 'run') { el.innerHTML = '<b>Machine running.</b> Drag to look around · <kbd>Space</kbd> reset'; return; }
  if (Game.held) {
    const def = PARTS[Game.held.type];
    const hgt = ghost && ghost.cell ? ghost.cell[1] : 0;
    el.innerHTML = `<b>${def.name}</b> · height ${hgt}${planeH !== null ? ' (locked)' : ''}<br>Click to place · <kbd>R</kbd> rotate · <kbd>Q</kbd>/<kbd>E</kbd> lower/raise${def.channel ? ' · <kbd>C</kbd> wire' : ''} · <kbd>Esc</kbd> cancel`;
  } else if (hoverInst) {
    el.innerHTML = hoverInst.fixed ? `<b>${hoverInst.def.name}</b> · part of the puzzle, stays put` : `<b>${hoverInst.def.name}</b> · click to move · <kbd>R</kbd> rotate · <kbd>X</kbd> back to bin${hoverInst.def.channel ? ' · <kbd>C</kbd> wire' : ''}`;
  } else {
    el.innerHTML = 'Pick a part from the bin · drag to orbit · scroll to zoom · <kbd>Space</kbd> run';
  }
  updateTools();
}

let toastTimer = 0;
function toast(msg, kind = '', ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'paper show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'paper'; }, ms);
}

// floating comic captions anchored in 3D
const popTexts = [];
function popText(pos, text, color) {
  if (Game.attract) return;
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `position:fixed;z-index:21;pointer-events:none;font-family:var(--font-display);font-weight:900;font-size:30px;text-transform:uppercase;color:${color};text-shadow:0 3px 0 #091629,0 0 12px rgba(0,0,0,.5);letter-spacing:.03em;white-space:nowrap;`;
  document.body.appendChild(el);
  popTexts.push({ el, pos: pos.clone(), t: 0 });
}
function updatePopTexts(dt) {
  const v = new THREE.Vector3();
  for (let n = popTexts.length - 1; n >= 0; n--) {
    const p = popTexts[n];
    p.t += dt;
    if (p.t > 1.4) { p.el.remove(); popTexts.splice(n, 1); continue; }
    v.copy(p.pos); v.y += p.t * 0.7;
    v.project(camera);
    const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const s = p.t < 0.15 ? 0.5 + p.t / 0.3 : 1;
    p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${s}) rotate(-6deg)`;
    p.el.style.left = '0'; p.el.style.top = '0';
    p.el.style.opacity = String(p.t > 1 ? 1 - (p.t - 1) / 0.4 : 1);
  }
}
function clearPopTexts() { for (const p of popTexts) p.el.remove(); popTexts.length = 0; }

// ---------------------------------------------------------------------------
//  Modals
// ---------------------------------------------------------------------------
function openModal(html, opts = {}) {
  const m = $('#modal');
  m.innerHTML = html + (opts.closable === false ? '' : '<button class="icon-btn paper close" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>');
  $('#modalWrap').hidden = false;
  m.scrollTop = 0;
  Game.modalOpen = true;
  Game.onModalClose = opts.onClose || null;
  m.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { Sound.unlock(); Sound.click(); (opts.actions?.[b.dataset.act] || closeModal)(); }));
  const first = m.querySelector('.btn.primary') || m.querySelector('button');
  first?.focus({ preventScroll: true });
}
function closeModal() {
  $('#modalWrap').hidden = true;
  Game.modalOpen = false;
  const cb = Game.onModalClose; Game.onModalClose = null;
  cb?.();
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function chipsFor(bin) {
  return Object.keys(bin).sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b)).map(t =>
    `<span class="chip"><img alt="" src="${THUMBS[t] || ''}">${esc(PARTS[t].name)} <b>${bin[t] === -1 || bin[t] === Infinity ? '∞' : '×' + bin[t]}</b></span>`).join('');
}
function showBrief() {
  const L = Game.L;
  if (Game.levelIndex === 'sandbox') {
    openModal(`<div class="eyebrow">Free workshop</div><h2>No rules, all the parts</h2>
      <p>Every gadget in the catalogue, in unlimited supply, on the biggest bench in the shop. There is no work order. Build something absurd, press Run, and enjoy it.</p>
      <div class="row"><button class="btn primary" data-act="close">Open the workshop</button></div>`);
    return;
  }
  const n = Game.levelIndex + 1;
  const goals = L.goals.map(g => `<li><div class="box"></div><span>${esc(goalText(g))}</span></li>`).join('');
  openModal(`<div class="eyebrow">Puzzle ${String(n).padStart(2, '0')} of ${LEVELS.length} · par ${L.par} parts</div>
    <h2>${esc(L.name)}</h2>
    <div class="note">${esc(L.brief)}<span class="sig">— O. Gearwhistle, Chief Tinkerer</span></div>
    <div class="eyebrow">Work order</div><ul class="goals">${goals}</ul>
    <div class="eyebrow" style="margin-top:14px">In your parts bin</div><div class="chips">${Object.keys(L.bin).length ? chipsFor(L.bin) : '<span class="chip" style="padding:4px 8px">Nothing. Use what is on the bench.</span>'}</div>
    <div class="row"><button class="btn primary" data-act="close">Start building</button><button class="btn" data-act="levels">All puzzles</button></div>`,
    { actions: { levels: showLevels } });
}
function starSvg(on, n) {
  return `<svg class="star${on ? ' on pop' : ''}" style="animation-delay:${0.15 + n * 0.18}s" viewBox="0 0 24 24"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>`;
}
function showWin(stars, used) {
  const L = Game.L;
  const quips = [
    'Magnificent. Utterly unnecessary, and magnificent.',
    'The neighbours will talk. Let them.',
    'I have filed this under "Triumphs, Improbable".',
    'Not one sensible step in the whole sequence. Perfect.',
    'Somewhere, a simple lever is weeping with envy.'
  ];
  const q = quips[(Game.levelIndex * 7 + used) % quips.length];
  const last = Game.levelIndex === LEVELS.length - 1;
  openModal(`<div class="eyebrow">Work order complete</div><h2>${last ? 'The grand apparatus works!' : 'It works!'}</h2>
    <div class="stars">${[0, 1, 2].map(n => starSvg(n < stars, n)).join('')}</div>
    <ul class="stat-list">
      <li><span class="k">Machine time</span><span>${(Game.winTime || 0).toFixed(1)} seconds</span></li>
      <li><span class="k">Parts you added</span><span class="${used <= L.par ? 'y' : ''}">${used} (par ${L.par})${used <= L.par ? ' ★' : ''}</span></li>
      <li><span class="k">Hints used</span><span class="${Game.hintsUsed === 0 ? 'y' : ''}">${Game.hintsUsed}${Game.hintsUsed === 0 ? ' ★' : ''}</span></li>
    </ul>
    <div class="note">${q}<span class="sig">— O. Gearwhistle</span></div>
    <div class="row">${last ? '<button class="btn primary" data-act="sandbox">Open the free workshop</button>' : '<button class="btn primary" data-act="next">Next puzzle</button>'}<button class="btn" data-act="watch">Keep watching</button><button class="btn" data-act="levels">All puzzles</button></div>`,
    { actions: { next: () => { closeModal(); loadLevel(Game.levelIndex + 1); }, watch: closeModal, levels: showLevels, sandbox: () => { closeModal(); loadLevel('sandbox'); } } });
}
function showLevels() {
  const prog = progress();
  const firstOpen = LEVELS.findIndex(L => !(prog[L.key]?.stars > 0));
  const cards = LEVELS.map((L, n) => {
    const s = prog[L.key]?.stars || 0;
    return `<button class="lvl${n === firstOpen ? ' next' : ''}" data-act="lvl${n}"><span class="n">${String(n + 1).padStart(2, '0')}${n === firstOpen ? ' · up next' : ''}</span><span class="t">${esc(L.name)}</span><span class="s">${[0, 1, 2].map(k => `<span class="${k < s ? 'on' : ''}">★</span>`).join('')}</span></button>`;
  }).join('');
  const actions = { sandbox: () => { closeModal(); loadLevel('sandbox'); } };
  LEVELS.forEach((L, n) => { actions['lvl' + n] = () => { closeModal(); loadLevel(n); }; });
  const total = LEVELS.reduce((a, L) => a + (prog[L.key]?.stars || 0), 0);
  openModal(`<div class="eyebrow">${total} of ${LEVELS.length * 3} stars collected</div><h2>Puzzles</h2>
    <p>Each puzzle comes with a work order and a bin of parts. Solve it for one star, stay at or under par for a second, and skip the hints for a third.</p>
    <div class="levels">${cards}<button class="lvl sandbox" data-act="sandbox"><span class="n">∞</span><span class="t">Free workshop</span><span class="s" style="color:var(--muted);letter-spacing:0;font-size:13px">every part, no rules</span></button></div>`,
    { actions });
}
function showHelp() {
  const gloss = PART_ORDER.map(id => `<span class="chip" title="${esc(PARTS[id].desc)}"><img alt="" src="${THUMBS[id] || ''}">${esc(PARTS[id].name)}</span>`).join('');
  openModal(`<div class="eyebrow">Shop manual</div><h2>How to play</h2>
    <p>Each puzzle sets a work order: ring a bell, pop a balloon, land a ball in a basket. Take parts from the bin, place them on the bench and press <b>Run</b>. Parts with a gold outline belong to the puzzle and cannot be moved. If the machine misbehaves, press <b>Reset</b>, adjust it and run it again.</p>
    <h3>Controls</h3>
    <div class="keys">
      <div class="k"><kbd>Click</kbd></div><span>Take a part from the bin, then click the bench to place it. Click a placed part to pick it up again.</span>
      <div class="k"><kbd>R</kbd></div><span>Rotate the part you are holding, or the one under the cursor.</span>
      <div class="k"><kbd>E</kbd> / <kbd>Q</kbd></div><span>Raise or lower the held part one level. Parts can float in mid-air, and objects drop when the machine starts.</span>
      <div class="k"><kbd>C</kbd></div><span>Choose a wire colour. A pressure plate switches on every gadget with the same colour.</span>
      <div class="k"><kbd>X</kbd> / <kbd>Del</kbd></div><span>Return a part to the bin.</span>
      <div class="k"><kbd>Esc</kbd> / right-click</div><span>Put down what you are holding.</span>
      <div class="k"><kbd>Space</kbd></div><span>Run or reset the machine.</span>
      <div class="k"><kbd>V</kbd></div><span>Switch camera view. Front view gives the classic flat, side-on look.</span>
      <div class="k"><kbd>H</kbd></div><span>Show a hint. Using one costs a star.</span>
      <div class="k"><kbd>1</kbd>–<kbd>9</kbd></div><span>Take the part in that slot of the bin.</span>
      <div class="k">Drag</div><span>Orbit the camera. Middle-drag or Shift-drag pans, and the wheel zooms. On touch, drag with one finger and pinch with two.</span>
    </div>
    <h3>The catalogue</h3><div class="chips">${gloss}</div>`);
}

// ---------------------------------------------------------------------------
//  Camera
// ---------------------------------------------------------------------------
const VIEWS = ['Angled', 'Front', 'Top', 'Side'];
let viewIdx = 0, camTween = null;
function viewPose(name) {
  const W = BOARD.w, D = BOARD.d, H = BOARD.h;
  const aspect = Math.max(0.5, camera.aspect);
  const span = Math.max(W, D * 0.9, H * 1.1);
  const fit = Math.min(1, aspect / 1.35) * (window.innerWidth < 860 && !Game.attract ? 0.8 : 1);
  const dist = span * 1.38 / fit + 4;
  const target = new THREE.Vector3(Game.L?.camShift?.[0] || 0, H * 0.22, Game.L?.camShift?.[1] || 0);
  const pos = target.clone();
  switch (name) {
    case 'Front': pos.add(new THREE.Vector3(0, H * 0.35, dist * 0.95)); break;
    case 'Top': pos.add(new THREE.Vector3(0, dist * 1.05, 0.02)); break;
    case 'Side': pos.add(new THREE.Vector3(dist * 0.95, H * 0.5, 0.0)); break;
    default: {
      const ang = Game.L?.camAngle ?? 0.62;
      pos.add(new THREE.Vector3(Math.sin(ang) * dist * 0.8, dist * 0.62, Math.cos(ang) * dist * 0.8));
    }
  }
  return { pos, target };
}
function homeCamera(instant) {
  viewIdx = 0;
  $('#viewLabel').textContent = 'View';
  tweenTo(viewPose('Angled'), instant);
}
function tweenTo(p, instant) {
  if (instant) { camera.position.copy(p.pos); controls.target.copy(p.target); controls.update(); camTween = null; return; }
  camTween = { fp: camera.position.clone(), ft: controls.target.clone(), tp: p.pos, tt: p.target, t: 0 };
}
function cycleView() {
  viewIdx = (viewIdx + 1) % VIEWS.length;
  $('#viewLabel').textContent = VIEWS[viewIdx];
  tweenTo(viewPose(VIEWS[viewIdx]));
  Sound.click();
}
function updateCamTween(dt) {
  if (!camTween) return;
  camTween.t = Math.min(1, camTween.t + dt / 0.7);
  const e = smooth(camTween.t);
  camera.position.lerpVectors(camTween.fp, camTween.tp, e);
  controls.target.lerpVectors(camTween.ft, camTween.tt, e);
  if (camTween.t >= 1) camTween = null;
}

// ---------------------------------------------------------------------------
//  Title screen with a self-running demo machine behind it
// ---------------------------------------------------------------------------
function showTitle() {
  if (Game.sim) stopRun(true);
  cancelHeld(true);
  closeModal();
  $('#hud').hidden = true;
  $('#title').hidden = false;
  startAttract();
  updateViewOffset();
  const prog = progress();
  const solved = LEVELS.filter(L => prog[L.key]?.stars > 0).length;
  $('#titleSpec').textContent = `${LEVELS.length} puzzles · ${PART_ORDER.length} gadgets · ${solved ? solved + ' solved so far' : 'drag to look around'}`;
  $('#playBtn').textContent = solved ? 'Continue tinkering' : 'Start tinkering';
}
function startAttract() {
  stopAttract();
  Game.attract = true;
  const L = SHOWCASE;
  Game.L = L; Game.levelIndex = null;
  clearInsts();
  BOARD.w = L.board[0]; BOARD.d = L.board[1]; BOARD.h = L.board[2];
  buildSet('Improbable Apparatus');
  makeFloorPick();
  for (const f of L.fixed) addInst(makeInst(f, true));
  if (guides) guides.visible = false;
  Game.mode = 'run';
  Game.sim = new Sim(Game.insts, L.goals, { listeners: simListeners });
  Game.acc = 0;
  updateViewOffset();
  tweenTo(viewPose('Angled'), true);
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
}
function stopAttract() {
  if (!Game.attract) return;
  Game.attract = false;
  controls.autoRotate = false;
  if (Game.sim) { Game.sim.running = false; Game.sim = null; }
  FX.clear();
  Sound.setHum(0);
  Game.mode = 'boot';
}
function attractTick() {
  const sim = Game.sim;
  if (sim && (sim.time > (SHOWCASE.loop || 16) || (sim.won && sim.quiet > 1.5))) {
    sim.running = false;
    for (const inst of Game.insts) inst.place();
    FX.clear();
    Game.sim = new Sim(Game.insts, SHOWCASE.goals, { listeners: simListeners });
    Game.acc = 0;
  }
}
function continueGame() {
  const prog = progress();
  const n = LEVELS.findIndex(L => !(prog[L.key]?.stars > 0));
  loadLevel(n < 0 ? 0 : n);
}

// ---------------------------------------------------------------------------
//  Input wiring
// ---------------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  updateViewOffset();
}
// Centre the 3D view in the part of the screen the HUD leaves uncovered.
function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight;
  let ox = 0, oy = 0;
  if (!Game.attract && !$('#hud').hidden) {
    if (w < 860) oy = Math.min(h * 0.22, 190);
    else { ox = Math.min(120, w * 0.08); oy = 30; }
  } else if (Game.attract && w >= 860) ox = -Math.min(260, w * 0.18);
  camera.setViewOffset(w, h, ox, oy, w, h);
  camera.updateProjectionMatrix();
}
function bindInput() {
  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointermove', (e) => {
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    if (ptr.down && Math.hypot(e.clientX - ptr.sx, e.clientY - ptr.sy) > 6) ptr.moved = true;
    if (!ptr.down || Game.held) updatePointer();
    if (hoverInst && !$('#hoverLabel').hidden) { const el = $('#hoverLabel'); el.style.left = ptr.x + 'px'; el.style.top = ptr.y + 'px'; }
  });
  canvas.addEventListener('pointerleave', () => { ptr.inside = false; updatePointer(); });
  canvas.addEventListener('pointerdown', (e) => {
    Sound.unlock();
    ptr.down = true; ptr.moved = false; ptr.sx = e.clientX; ptr.sy = e.clientY; ptr.t = performance.now(); ptr.button = e.button;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    camTween = null;
    if (e.pointerType !== 'mouse') updatePointer();
    canvas.focus({ preventScroll: true });
  });
  window.addEventListener('pointerup', (e) => {
    if (!ptr.down) return;
    ptr.down = false;
    if (ptr.moved || performance.now() - ptr.t > 600 || e.target !== canvas) { updatePointer(); return; }
    if (Game.mode !== 'edit') return;
    if (ptr.button === 2) { if (Game.held) cancelHeld(); return; }
    if (ptr.button !== 0) return;
    updatePointer();
    if (Game.held) tryPlace();
    else if (hoverInst) {
      if (hoverInst.fixed) { Sound.nope(); toast(`The ${hoverInst.def.name.toLowerCase()} is part of the puzzle and stays where it is.`, 'warn', 2000); }
      else pickUp(hoverInst);
    }
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (Game.modalOpen) { if (e.key === 'Escape') closeModal(); return; }
    if (!$('#title').hidden) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') { e.preventDefault(); toggleRun(); }
    else if (k === 'r') rotateAction();
    else if (k === 'e' || k === 'pageup') heightAction(1);
    else if (k === 'q' || k === 'pagedown') heightAction(-1);
    else if (k === 'c') wireAction();
    else if (k === 'x' || k === 'delete' || k === 'backspace') { e.preventDefault(); returnToBin(Game.held ? null : hoverInst); }
    else if (k === 'escape') cancelHeld();
    else if (k === 'h') showHint();
    else if (k === 'v') cycleView();
    else if (/^[1-9]$/.test(k)) { const t = binTypes()[+k - 1]; if (t) holdFromBin(t); }
  });
  $('#runBtn').addEventListener('click', () => { Sound.unlock(); toggleRun(); });
  $('#rotBtn').addEventListener('click', rotateAction);
  $('#upBtn').addEventListener('click', () => heightAction(1));
  $('#downBtn').addEventListener('click', () => heightAction(-1));
  $('#wireBtn').addEventListener('click', wireAction);
  $('#delBtn').addEventListener('click', () => {
    if (Game.held) returnToBin(null);
    else if (hoverInst) returnToBin(hoverInst);
    else toast('Hover over a part you placed, then press X to send it back to the bin.', '', 2200);
  });
  $('#hintBtn').addEventListener('click', showHint);
  $('#viewBtn').addEventListener('click', cycleView);
  $('#clearBtn').addEventListener('click', () => {
    if (Game.mode !== 'edit') return;
    const mine = Game.insts.filter(x => !x.fixed);
    if (!mine.length) { toast('Nothing of yours on the bench yet.', '', 1600); return; }
    openModal(`<div class="eyebrow">Clear the bench</div><h2>Put everything back?</h2><p>All ${mine.length} parts you placed go back into the bin. Puzzle parts stay where they are.</p>
      <div class="row"><button class="btn primary" data-act="yes">Clear my parts</button><button class="btn" data-act="close">Keep them</button></div>`,
      { actions: { yes: () => { cancelHeld(true); for (const m of mine) returnToBin(m); closeModal(); } } });
  });
  $$('#speed button').forEach(b => b.addEventListener('click', () => {
    Game.speed = +b.dataset.s;
    $$('#speed button').forEach(x => x.classList.toggle('on', x === b));
  }));
  const sb = $('#soundBtn');
  sb.classList.toggle('off', Sound.muted);
  sb.addEventListener('click', () => { Sound.unlock(); Sound.setMuted(!Sound.muted); sb.classList.toggle('off', Sound.muted); });
  $('#helpBtn').addEventListener('click', showHelp);
  $('#levelsBtn').addEventListener('click', showLevels);
  $('#brandBtn').addEventListener('click', showTitle);
  $('#playBtn').addEventListener('click', () => { Sound.unlock(); Sound.click(); continueGame(); });
  $('#puzzlesBtn').addEventListener('click', () => { Sound.unlock(); Sound.click(); showLevels(); });
  $('#sandboxBtn').addEventListener('click', () => { Sound.unlock(); Sound.click(); loadLevel('sandbox'); });
  $('#howBtn').addEventListener('click', () => { Sound.unlock(); Sound.click(); showHelp(); });
  $('#modalWrap').addEventListener('pointerdown', (e) => { if (e.target.id === 'modalWrap') closeModal(); });
}

// ---------------------------------------------------------------------------
//  Main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  const sim = Game.sim;
  if (sim) {
    Game.acc += dt * (Game.attract ? 1 : Game.speed);
    const maxN = Math.ceil(10 * (Game.attract ? 1 : Game.speed));
    let n = 0;
    while (Game.acc >= DT && n < maxN && sim.time < MAX_RUN_TIME + 5) { sim.step(); Game.acc -= DT; n++; }
    if (n >= maxN) Game.acc = 0;
    sim.sync();
    sim.fxFrame(dt);
    Sound.setHum(Game.attract ? 0 : sim.hum());
    if (Game.attract) attractTick(); else checkRunState();
  }
  FX.update(dt);
  updatePopTexts(dt);
  updateCamTween(dt);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
//  Headless test hooks (used by the automated level checks)
// ---------------------------------------------------------------------------
function headlessRun(L, specs, maxT = 40, jitter = 0, seed = 1) {
  const saved = [BOARD.w, BOARD.d, BOARD.h];
  BOARD.w = L.board[0]; BOARD.d = L.board[1]; BOARD.h = L.board[2];
  const insts = [];
  const problems = [];
  const occ = new Map();
  const add = (spec, fixed) => {
    const inst = makeInst(spec, fixed);
    for (const c of inst.cells()) {
      if (!inBoard(c[0], c[1], c[2])) problems.push(`${spec[0]} out of board at ${c}`);
      if (occ.has(c.join(','))) problems.push(`${spec[0]} overlaps ${occ.get(c.join(',')).type} at ${c}`);
      occ.set(c.join(','), inst);
    }
    insts.push(inst);
  };
  (L.fixed || []).forEach(f => add(f, true));
  specs.forEach(s => add(s, false));
  const sim = new Sim(insts, L.goals, { silent: true });
  if (jitter) {
    const r = rng(seed);
    for (const d of sim.dyn) { d.body.position.x += (r() - 0.5) * jitter; d.body.position.z += (r() - 0.5) * jitter; }
  }
  while (sim.time < maxT && !sim.won) sim.step();
  const out = { won: sim.won, time: +sim.time.toFixed(2), goals: sim.goalState.slice(), flags: Object.keys(sim.flags), problems };
  out.dyn = sim.dyn.map(d => ({ id: d.inst.id, t: d.inst.type, gone: d.gone, why: d.why, p: [d.body.position.x, d.body.position.y, d.body.position.z].map(v => +v.toFixed(2)) }));
  BOARD.w = saved[0]; BOARD.d = saved[1]; BOARD.h = saved[2];
  return out;
}
window.__IA = {
  get levels() { return LEVELS; }, SANDBOX, SHOWCASE, PARTS, Game, Sim, makeInst, BOARD, CANNON, loadLevel, headlessRun, showTitle, startRun, stopRun, camera, controls,
  place(spec) { const inst = makeInst(spec, false); addInst(inst); return inst.id; },
  tweenTo(pos, target) { tweenTo({ pos: new THREE.Vector3(...pos), target: new THREE.Vector3(...target) }, true); },
  applySolution() {
    for (const s of Game.L.solution || []) {
      if (placeProblem(s[0], s[1], s[2], s[3], s[4] || 0)) continue;
      addInst(makeInst(s, false));
      if (Game.bin[s[0]] !== Infinity) Game.bin[s[0]]--;
    }
    renderBin();
  },
  trace(L, specs, ids, maxT = 10, every = 0.25) {
    const saved = [BOARD.w, BOARD.d, BOARD.h];
    BOARD.w = L.board[0]; BOARD.d = L.board[1]; BOARD.h = L.board[2];
    const insts = [...(L.fixed || []).map(f => makeInst(f, true)), ...specs.map(s => makeInst(s, false))];
    const sim = new Sim(insts, L.goals, { silent: true });
    const rows = [];
    let next = 0;
    while (sim.time < maxT) {
      sim.step();
      if (sim.time >= next) {
        next += every;
        rows.push(sim.time.toFixed(2) + ' ' + sim.dyn.filter(d => !ids || ids.includes(d.inst.type) || ids.includes(d.inst.id)).map(d => d.inst.id.split('#')[0] + (d.gone ? '(x)' : '') + '[' + [d.body.position.x, d.body.position.y, d.body.position.z].map(v => v.toFixed(2)).join(',') + ']').join(' ') + ' ' + Object.keys(sim.flags).join(','));
      }
      if (sim.won) { rows.push('WON at ' + sim.time.toFixed(2)); break; }
    }
    BOARD.w = saved[0]; BOARD.d = saved[1]; BOARD.h = saved[2];
    return rows.join('\n');
  }
};

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
function boot(data) {
  initTextures();
  initMaterials();
  renderThumbs();
  onResize();
  bindInput();
  requestAnimationFrame(frame);
  const hot = window.claude?.hot;
  if (hot?.snapshot) {
    try {
      hot.snapshot(() => ({ level: Game.attract ? null : Game.levelIndex, placed: Game.attract ? null : placedSpecs() }));
    } catch (e) { /* not available */ }
  }
  const params = new URLSearchParams(location.search);
  if (data && data.level !== undefined && data.level !== null && levelByIndex(data.level)) {
    loadLevel(data.level, { placed: data.placed || [], brief: false });
  } else if (params.has('level')) {
    const v = params.get('level');
    loadLevel(v === 'sandbox' ? 'sandbox' : clamp(+v - 1, 0, LEVELS.length - 1), { brief: !params.has('nobrief'), fresh: params.has('fresh') });
  } else {
    showTitle();
  }
}
// Fonts feed the canvas textures (ruler labels, crate stencils), so wait for them briefly.
const fontsReady = (document.fonts && document.fonts.load)
  ? Promise.race([Promise.all([document.fonts.load('800 30px "Big Shoulders Stencil Display"'), document.fonts.load('600 15px "IBM Plex Mono"')]), new Promise(r => setTimeout(r, 1500))]).catch(() => {})
  : Promise.resolve();
fontsReady.then(() => {
  const hot = window.claude?.hot;
  if (hot?.ready) hot.ready(boot); else boot(hot?.data ?? {});
});
