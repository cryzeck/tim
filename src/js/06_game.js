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
let selInst = null, selOutline = null;   // the placed part the tool buttons act on (tap to select)
let gesture = null;          // the pointer gesture in progress: look | held | part | bin
const activePointers = new Set();
const undoStack = [];
const THUMBS = {};

// Touch or mouse: decided by the last pointer used, so an iPad with a trackpad works too.
let usingTouch = window.matchMedia?.('(hover: none) and (pointer: coarse)').matches || false;
function setTouchUI(on) {
  if (on === usingTouch && document.body.classList.contains('touch') === on) return;
  usingTouch = on;
  document.body.classList.toggle('touch', on);
  updateStatus();
}

// One finger (or the left mouse button) orbits the camera, except while a part is being
// held or dragged: then it moves the part, and two fingers turn and zoom the view instead.
function syncCamera() {
  const block = !!Game.held || (gesture && gesture.kind === 'part');
  controls.mouseButtons.LEFT = block ? -1 : THREE.MOUSE.ROTATE;
  controls.touches.ONE = block ? -1 : THREE.TOUCH.ROTATE;
  controls.touches.TWO = block ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
}

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
  if (selInst === inst) select(null);
  benchChanged();
}
function clearInsts() { for (const inst of Game.insts) scene.remove(inst.group); Game.insts = []; setHover(null); select(null); }
// Swap a placed part for a moved/turned copy, keeping it selected
function replaceInst(inst, i, j, k, r) {
  const wasSel = selInst === inst;
  removeInst(inst);
  const ni = new Inst(inst.type, i, j, k, r, { ch: inst.ch });
  addInst(ni);
  if (wasSel) select(ni);
  return ni;
}

// ---------------------------------------------------------------------------
//  Undo: a snapshot of the player's parts and the bin before each change
// ---------------------------------------------------------------------------
function snapshot() { return { placed: placedSpecs(), bin: { ...Game.bin } }; }
function pushUndo(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 80) undoStack.shift();
  updateTools();
}
function undo() {
  if (Game.mode !== 'edit') return;
  if (Game.held) { cancelHeld(); return; } // putting down what you hold is the first undo
  const s = undoStack.pop();
  if (!s) { Sound.nope(); toast('Det er ingenting å angre.', '', 1400); return; }
  for (const inst of Game.insts.filter(x => !x.fixed)) scene.remove(inst.group);
  Game.insts = Game.insts.filter(x => x.fixed);
  for (const p of s.placed) { const inst = makeInst(p, false); Game.insts.push(inst); scene.add(inst.group); }
  Game.bin = { ...s.bin };
  setHover(null); select(null);
  benchChanged();
  Sound.remove();
  renderBin(); updateTools(); updatePointer();
}

// ---------------------------------------------------------------------------
//  Selection: tap a placed part, then Turn / Up / Down / Colour / Remove act on it
// ---------------------------------------------------------------------------
function select(inst) {
  if (inst && (inst.fixed || Game.mode !== 'edit')) inst = null;
  if (selInst === inst) return;
  selInst = inst;
  if (selOutline) { scene.remove(selOutline); selOutline = null; }
  if (inst) {
    selOutline = new THREE.Box3Helper(cellBox(inst, 0.05), 0xff7b22);
    selOutline.material.transparent = true; selOutline.material.depthTest = false; selOutline.renderOrder = 6;
    scene.add(selOutline);
  }
  updateTools();
  updateStatus();
}
function cellBox(inst, pad) {
  const box = new THREE.Box3();
  for (const [ci, cj, ck] of inst.cells()) {
    const w = cellToWorld(ci, cj, ck);
    box.expandByPoint(new THREE.Vector3(w.x - 0.5, cj, w.z - 0.5));
    box.expandByPoint(new THREE.Vector3(w.x + 0.5, cj + 1, w.z + 0.5));
  }
  return box.expandByScalar(pad);
}
// What the dock buttons act on; the keyboard also reaches the part under the mouse.
function toolTarget(keyboard) {
  if (Game.mode !== 'edit') return null;
  if (keyboard && hoverInst && !hoverInst.fixed) return hoverInst;
  return selInst;
}

// ---------------------------------------------------------------------------
//  Trails: coloured dots mark where every ball, box and balloon went on the last
//  run, and stay after Reset so you can see what to change.
// ---------------------------------------------------------------------------
const Trail = (() => {
  const MAX = 2400, GAP = 0.17;
  const COLORS = { bowling: 0xff9a3d, rubber: 0xff4f9a, marble: 0x9fe0ff, beach: 0xffe066, crate: 0xf0c27a, balloon: 0xff6b81 };
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.065, 10, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }), MAX);
  const col = new THREE.Color(), m4 = new THREE.Matrix4();
  for (let i = 0; i < MAX; i++) mesh.setColorAt(i, col.set(0xffffff));
  mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 3;
  scene.add(mesh);
  const last = new Map();
  return {
    clear() { mesh.count = 0; last.clear(); mesh.material.opacity = 0.95; },
    record(sim) {
      for (const d of sim.dyn) {
        if (d.gone || mesh.count >= MAX) continue;
        const c = COLORS[d.inst.type];
        if (c === undefined) continue;
        const p = d.body.position, l = last.get(d);
        if (l && (p.x - l.x) ** 2 + (p.y - l.y) ** 2 + (p.z - l.z) ** 2 < GAP * GAP) continue;
        last.set(d, { x: p.x, y: p.y, z: p.z });
        const n = mesh.count++;
        mesh.setMatrixAt(n, m4.makeTranslation(p.x, p.y, p.z));
        mesh.setColorAt(n, col.set(c));
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      }
    },
    fade() { mesh.material.opacity = 0.75; },
    get count() { return mesh.count; }
  };
})();
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
    if (!inBoard(c[0], c[1], c[2])) return c[1] >= BOARD.h ? 'For høyt! Det er over taket på denne benken.' : c[1] < 0 ? 'Lenger ned går det ikke.' : 'Der er du utenfor byggeområdet.';
    if (occ.has(c.join(','))) return 'Det står noe der allerede.';
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
  undoStack.length = 0;
  Trail.clear();
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
  $('#runLabel').textContent = edit ? 'Start' : 'Stopp';
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
  select(null);
  Trail.clear();
  Game.sim = new Sim(Game.insts, Game.L.goals, { listeners: simListeners });
  Game.acc = 0; Game.won = false; Game.stallShown = false;
  setMode('run');
  renderGoals();
  Sound.start();
  Sound.duck(true);
}
function stopRun(silent) {
  if (!Game.sim) return;
  Game.sim.running = false;
  Game.sim = null;
  for (const inst of Game.insts) inst.place();
  FX.clear();
  clearPopTexts();
  Sound.setHum(0);
  Sound.duck(false);
  Trail.fade();
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
      case 'bell': Sound.bell(); FX.burst('spark', p, 24, { colors: [0xffd34d, 0xfff3b0], speed: 3.6, life: 0.8, gravity: 1 }); popText(p, 'Pling!', '#ffd34d'); break;
      case 'pop': Sound.pop(); FX.burst('confetti', p, 30, { colors: [0xff3b5c, 0xff6b81, 0xffd0d8], speed: 4.5, life: 1.3, gravity: 6 }); popText(p, 'Pang!', '#ff6b81'); break;
      case 'press': Sound.press(); popText(p, 'Klikk!', '#eef5ff'); break;
      case 'channel': Sound.zap(); FX.burst('spark', p, 18, { colors: [CH_HEX[val], 0xffffff], speed: 3.2, life: 0.55, gravity: 2 }); break;
      case 'ram': Sound.whoosh(); break;
    }
  },
  flag(key, pos) {
    if (key.startsWith('inside:') && pos) popText(new THREE.Vector3(pos.x, pos.y + 0.4, pos.z), 'Oppi!', '#62e3a4');
    if (key.startsWith('light:') && pos) popText(new THREE.Vector3(pos.x, pos.y + 0.4, pos.z), 'Det ble lys!', '#ffe07a');
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
    toast(Trail.count ? 'Maskinen har stoppet. Prikkene viser hvor tingene gikk. Trykk Stopp, endre litt og prøv igjen!' : 'Maskinen har stoppet. Trykk Stopp, endre litt og prøv igjen!', 'warn', 5200);
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
  if (Game.mode !== 'edit') { if (ghost) { ghost.group.visible = false; ghost.marker.visible = false; } setHover(null); hideHoverLabel(); return; }
  // A finger that has lifted leaves no pointer behind: keep a held part where it was put
  // down, and show no hover.
  const touchIdle = usingTouch && !ptr.down;
  if (touchIdle || !ptr.inside) {
    setHover(null); hideHoverLabel();
    if (ghost) {
      if (touchIdle && ghost.cell) setGhostCell(ghost.cell.slice());
      else if (!touchIdle) { ghost.group.visible = false; ghost.marker.visible = false; }
    }
    return;
  }
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
    selBox = new THREE.Box3Helper(cellBox(inst, 0.02), inst.fixed ? 0xe8b75e : 0x7cf0b0);
    selBox.material.transparent = true; selBox.material.opacity = 0.85; selBox.material.depthTest = false;
    scene.add(selBox);
    showHoverLabel(inst);
  } else hideHoverLabel();
  updateStatus();
}
function showHoverLabel(inst) {
  const el = $('#hoverLabel');
  el.textContent = inst.def.name + (inst.fixed ? '  ·  hører til brettet' : '') + (inst.ch ? '  ·  ' + CH_ADJ[inst.ch] + ' ledning' : '');
  el.style.left = ptr.x + 'px'; el.style.top = ptr.y + 'px';
  el.hidden = false;
}
function hideHoverLabel() { $('#hoverLabel').hidden = true; }

// ---------------------------------------------------------------------------
//  Holding, placing, moving
// ---------------------------------------------------------------------------
function holdFromBin(type, keep = {}) {
  if (Game.mode !== 'edit') return;
  if (Game.held && Game.held.from) cancelHeld(true);
  if (!(Game.bin[type] > 0)) { Sound.nope(); toast('Det er tomt for denne delen.', 'warn', 1500); return; }
  const def = PARTS[type];
  const ch = keep.ch !== undefined ? keep.ch : (def.defaultCh ?? null);
  Game.held = { type, r: keep.r ?? (Game.held && Game.held.type === type ? Game.held.r : 0), ch, from: null };
  if (!keep.continuing) { planeH = null; grab = [0, 0]; }
  makeGhost(type, Game.held.r, ch);
  select(null);
  syncCamera();
  setHover(null);
  renderBinActive();
  updateTools();
  updatePointer();
  // A tap on a card with a finger: park the part in the middle of the bench, where it can
  // be seen and dragged into place.
  if (keep.park && ghost && !ghost.cell) setGhostCell(parkCell(type, Game.held.r));
  if (!keep.continuing) Sound.pickup();
}
function parkCell(type, r) {
  const ci = Math.floor(BOARD.w / 2), ck = Math.floor(BOARD.d / 2);
  for (let j = 0; j < BOARD.h; j++) for (let ring = 0; ring < Math.max(BOARD.w, BOARD.d); ring++)
    for (let di = -ring; di <= ring; di++) for (let dk = -ring; dk <= ring; dk++) {
      if (Math.max(Math.abs(di), Math.abs(dk)) !== ring) continue;
      if (!placeProblem(type, ci + di, j, ck + dk, r)) return [ci + di, j, ck + dk];
    }
  return [ci, 0, ck];
}
function pickUp(inst) {
  if (inst.fixed || Game.mode !== 'edit') return;
  const snap = snapshot();
  removeInst(inst);
  Game.held = { type: inst.type, r: inst.r, ch: inst.ch, from: { i: inst.i, j: inst.j, k: inst.k, r: inst.r, ch: inst.ch }, undoSnap: snap };
  // Parts lifted off the mat follow the surfaces under the pointer (so they can be dropped
  // on top of things); parts already up in the air keep their height while they move.
  planeH = inst.j > 0 ? inst.j : null;
  grab = [0, 0];
  if (planeH !== null) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((ptr.x - rect.left) / rect.width) * 2 - 1, -((ptr.y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const pc = planeCell(planeH);
    if (pc) grab = [inst.i - pc[0], inst.k - pc[2]];
  }
  makeGhost(inst.type, inst.r, inst.ch);
  syncCamera();
  Sound.pickup();
  renderBinActive();
  updateTools();
  updatePointer();
}
function tryPlace() {
  const h = Game.held;
  if (!h || !ghost) return false;
  if (!ghost.cell) return false;
  const [i, j, k] = ghost.cell;
  const problem = placeProblem(h.type, i, j, k, h.r);
  if (problem) { Sound.nope(); toast(problem, 'warn', 1800); return false; }
  pushUndo(h.undoSnap || snapshot());
  const inst = new Inst(h.type, i, j, k, h.r, { ch: h.ch });
  addInst(inst);
  Sound.place();
  FX.burst('puff', inst.local(0, 0.05, 0), 8, { colors: [0xf4ead8], speed: 1.6, gravity: -0.4, life: 0.5, size: 1.4, grow: 1.2, up: 0.2, drag: 0.9 });
  const fromBin = !h.from;
  if (fromBin && Game.bin[h.type] !== Infinity) Game.bin[h.type]--;
  Game.held = null;
  removeGhost();
  syncCamera();
  // With a mouse, keep "stamping" more of the same part; with a finger, select the new
  // part instead so Turn / Up / Down work on it straight away.
  if (!usingTouch && fromBin && Game.bin[h.type] > 0) holdFromBin(h.type, { r: h.r, ch: h.ch, continuing: true });
  else { planeH = null; grab = [0, 0]; select(inst); }
  renderBin();
  updateTools();
  updatePointer();
  return true;
}
function cancelHeld(silent) {
  const h = Game.held;
  if (!h) return;
  if (h.from) {
    const f = h.from;
    if (!placeProblem(h.type, f.i, f.j, f.k, f.r)) addInst(new Inst(h.type, f.i, f.j, f.k, f.r, { ch: f.ch }));
    else { pushUndo(h.undoSnap); if (Game.bin[h.type] !== Infinity) Game.bin[h.type] = (Game.bin[h.type] || 0) + 1; } // its old spot got taken
  }
  Game.held = null;
  planeH = null; grab = [0, 0];
  removeGhost();
  syncCamera();
  renderBin();
  updateTools();
  updateStatus();
  if (!silent) Sound.click();
}
function returnToBin(inst, opts = {}) {
  if (inst) {
    if (inst.fixed) { Sound.nope(); toast('Den delen hører til brettet og kan ikke fjernes.', 'warn'); return; }
    if (!opts.noUndo) pushUndo();
    removeInst(inst);
    if (Game.bin[inst.type] !== Infinity) Game.bin[inst.type] = (Game.bin[inst.type] || 0) + 1;
  } else if (Game.held) {
    const h = Game.held;
    if (h.from) { pushUndo(h.undoSnap); if (Game.bin[h.type] !== Infinity) Game.bin[h.type] = (Game.bin[h.type] || 0) + 1; }
    Game.held = null; planeH = null; grab = [0, 0];
    removeGhost();
    syncCamera();
  } else return;
  if (!opts.silent) Sound.remove();
  renderBin(); updateTools(); updateStatus(); updatePointer();
}
function rotateAction(keyboard) {
  if (Game.mode !== 'edit') return;
  if (Game.held) {
    Game.held.r = (Game.held.r + 1) % 4;
    ghost.r = Game.held.r;
    Sound.rotate();
    if (ghost.cell) setGhostCell(ghost.cell.slice());
    updatePointer();
    return;
  }
  const inst = toolTarget(keyboard);
  if (!inst) { nothingSelected(); return; }
  const nr = (inst.r + 1) % 4;
  if (placeProblem(inst.type, inst.i, inst.j, inst.k, nr, inst)) { Sound.nope(); toast('Det er ikke plass til å snu den der.', 'warn', 1500); return; }
  pushUndo();
  replaceInst(inst, inst.i, inst.j, inst.k, nr);
  Sound.rotate();
  updatePointer();
}
function heightAction(d, keyboard) {
  if (Game.mode !== 'edit') return;
  if (!Game.held) { // move a placed part straight up or down
    const inst = toolTarget(keyboard);
    if (!inst) { nothingSelected(); return; }
    const problem = placeProblem(inst.type, inst.i, inst.j + d, inst.k, inst.r, inst);
    if (problem) { Sound.nope(); toast(d > 0 && problem.startsWith('Det står') ? 'Det er noe i veien over den.' : d < 0 && problem.startsWith('Det står') ? 'Det er noe i veien under den.' : problem, 'warn', 1600); return; }
    pushUndo();
    replaceInst(inst, inst.i, inst.j + d, inst.k, inst.r);
    Sound.rotate();
    updatePointer();
    return;
  }
  const cur = ghost && ghost.cell ? ghost.cell[1] : 0;
  const before = ghost && ghost.cell ? ghost.cell.slice() : null;
  const nh = clamp((planeH === null ? cur : planeH) + d, 0, BOARD.h - 1);
  planeH = nh;
  if (usingTouch && !ptr.down) {
    // no finger on the bench: lift the parked part in place
    if (before) setGhostCell([before[0], nh, before[2]]);
    grab = [0, 0];
  } else {
    if (before) {
      const pc = planeCell(nh);
      if (pc) grab = [before[0] - pc[0], before[2] - pc[2]];
    }
    updatePointer();
  }
  Sound.rotate();
}
function wireAction(keyboard) {
  if (Game.mode !== 'edit') return;
  const target = Game.held ? Game.held : toolTarget(keyboard);
  const type = target && target.type;
  if (!target) { nothingSelected(); return; }
  if (!PARTS[type].channel) { Sound.nope(); toast('Bare vifter, bånd, fjærstøtere, magneter, trykkplater og lyspærer kan få farge.', 'warn', 2400); return; }
  const cycle = PARTS[type].channel === 'switch' ? CHANNELS : [null, ...CHANNELS];
  const next = cycle[(cycle.indexOf(target.ch) + 1) % cycle.length];
  if (Game.held) { Game.held.ch = next; const cell = ghost && ghost.cell; makeGhost(type, Game.held.r, next); if (cell) setGhostCell(cell.slice()); updatePointer(); }
  else { pushUndo(); target.setChannel(next); if (hoverInst === target) showHoverLabel(target); saveDraftSoon(); }
  Sound.click();
  updateTools();
  const msg = !next ? 'Ingen farge: går hele tiden fra maskinen starter.'
    : type === 'button' ? `${CH_LABEL[next]}: slår på alt med ${CH_ADJ[next]} farge.`
    : type === 'lamp' ? `${CH_LABEL[next]}: lyser når en ${CH_ADJ[next]} trykkplate blir trykket.`
    : `${CH_LABEL[next]}: starter når en ${CH_ADJ[next]} trykkplate blir trykket.`;
  toast(msg, '', 2400);
}
function nothingSelected() {
  Sound.nope();
  toast(usingTouch ? 'Trykk på en del du har satt ut først.' : 'Klikk på en del du har satt ut først, eller hold musen over den.', '', 1800);
}

// ---------------------------------------------------------------------------
//  Hints: reveal the next part of the reference solution as a golden ghost
// ---------------------------------------------------------------------------
function showHint() {
  if (Game.mode !== 'edit' || !Game.L.solution) { if (!Game.L.solution) toast('Det fins ingen tips i det frie verkstedet. Her er alt lov!', '', 2000); return; }
  hideHint();
  const placed = Game.insts.filter(x => !x.fixed);
  const sol = Game.L.solution;
  const match = (s) => placed.some(p => p.type === s[0] && p.i === s[1] && p.j === s[2] && p.k === s[3] && (p.r === (s[4] || 0) || PARTS[p.type].symmetric));
  const next = sol.find(s => !match(s));
  if (!next) { toast('Alle tipsdelene står allerede på plass. Trykk Start!', '', 2200); return; }
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
  const where = `${String.fromCharCode(65 + i)}${k + 1}` + (j ? `, ${j} opp` : '');
  const art = def.art === 'et' ? 'Et' : 'En';
  toast(`Tips: ${art} ${def.name.toLowerCase()}${o.ch ? ` med ${CH_ADJ[o.ch]} farge` : ''} skal stå der den gule skyggen er (${where}).`, '', 4200);
  Sound.goal();
}
function hideHint() { if (hintGhost) { scene.remove(hintGhost); hintGhost = null; } }

// ---------------------------------------------------------------------------
//  UI rendering
// ---------------------------------------------------------------------------
function renderLevelName() {
  const L = Game.L;
  $('#levelName').textContent = Game.levelIndex === 'sandbox' ? 'Fritt verksted · ingen regler' : `Brett ${String(Game.levelIndex + 1).padStart(2, '0')} av ${LEVELS.length} · ${L.name}`;
}
function goalText(goal) {
  if (goal.text) return goal.text;
  const what = goal.what && PARTS[goal.what] ? (PARTS[goal.what].the || PARTS[goal.what].name.toLowerCase()) : 'tingen';
  switch (goal.type) {
    case 'ring': return 'Ring med bjella';
    case 'inside': return `Få ${what} oppi kurven`;
    case 'pop': return 'Sprekk ballongen';
    case 'press': return 'Trykk på trykkplaten';
    case 'light': return 'Tenn lyspæra';
    case 'topple': return 'Velt alle dominobrikkene';
    case 'away': return 'La ballongen fly fritt';
  }
  return goal.type;
}
function renderGoals() {
  const ul = $('#goals');
  ul.innerHTML = '';
  const goals = Game.L.goals || [];
  if (!goals.length) {
    const li = document.createElement('li'); li.className = 'sandbox';
    li.textContent = 'Ingen oppdrag. Bygg hva du vil, og trykk Start.';
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
    el.textContent = Game.won ? `Ferdig på ${(Game.winTime ?? t).toFixed(1)} s` : `Går · ${t.toFixed(1)} s`;
  } else {
    const n = placedSpecs().length;
    const deler = x => x === 1 ? 'del' : 'deler';
    el.textContent = Game.L.goals.length ? `Mål: ${Game.L.par} ${deler(Game.L.par)} · brukt ${n}` : `${n} ${deler(n)} satt ut`;
  }
}
function binTypes() {
  return Object.keys(Game.bin).sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b));
}
let lastBinDrag = 0;
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
    card.innerHTML = `${n < 9 ? `<span class="key">${n + 1}</span>` : ''}<img alt="" draggable="false" src="${THUMBS[t] || ''}"><span class="nm"></span><span class="ct">${cnt === Infinity ? '∞' : '×' + cnt}</span>`;
    card.querySelector('.nm').textContent = def.name;
    // Drag a card out onto the bench, or tap it and then tap the bench.
    card.addEventListener('pointerdown', (e) => binPointerDown(e, t));
    card.addEventListener('click', () => {
      if (performance.now() - lastBinDrag < 450) return;
      if (Game.held && !Game.held.from && Game.held.type === t) { cancelHeld(); return; } // tap again: put it back
      holdFromBin(t, { park: usingTouch });
      if (usingTouch && Game.held) toast(`${def.name}: ${def.desc}`, '', 4000);
    });
    card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(card, def); });
    card.addEventListener('pointerleave', hideTip);
    list.appendChild(card);
  });
  if (!types.length) {
    const p = document.createElement('div'); p.className = 'bin-empty-note';
    p.textContent = 'Ingenting å legge til. Alt du trenger, står allerede på benken.';
    list.appendChild(p);
  }
  $('#binCount').textContent = Game.levelIndex === 'sandbox' ? 'uendelig' : `${total} igjen`;
  renderBinActive();
  updateWorkStatus();
  updateTools();
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
  const target = h || selInst;
  // Buttons that need a part stay pressable but dimmed: pressing one explains what to do.
  for (const id of ['#rotBtn', '#upBtn', '#downBtn', '#delBtn']) { $(id).disabled = !edit; $(id).classList.toggle('idle', !target); }
  $('#wireBtn').disabled = !edit;
  $('#wireBtn').classList.toggle('idle', !target || !PARTS[target.type].channel);
  // the colour button only shows up on benches where colours matter
  $('#wireBtn').hidden = !(Game.L && (Game.levelIndex === 'sandbox' || Object.keys(Game.L.bin || {}).some(t => PARTS[t]?.channel)));
  $('#undoBtn').disabled = !edit || (!undoStack.length && !(h && h.from));
  $('#hintBtn').disabled = !edit || !Game.L || !Game.L.solution;
  $('#clearBtn').disabled = !edit || !Game.insts.some(x => !x.fixed);
  const ch = target ? target.ch : null;
  const dot = $('#wireDot');
  dot.style.background = ch ? CH_CSS[ch] : '#8a919b';
}
function updateStatus() {
  const el = $('#status');
  if (!el) return;
  const T = usingTouch;
  if (Game.mode === 'run') {
    el.innerHTML = T ? '<b>Maskinen går.</b> Dra med én finger for å se deg rundt.' : '<b>Maskinen går.</b> Dra for å se deg rundt · <kbd>Mellomrom</kbd> stopp';
  } else if (Game.held) {
    const def = PARTS[Game.held.type];
    const hgt = ghost && ghost.cell ? ghost.cell[1] : 0;
    el.innerHTML = T
      ? `<b>${esc(def.name)}</b> · høyde ${hgt}<br>Dra den dit den skal stå, og slipp. Opp og Ned løfter og senker den.`
      : `<b>${esc(def.name)}</b> · høyde ${hgt}${planeH !== null ? ' (låst)' : ''}<br>Klikk for å sette den ned · <kbd>R</kbd> snu · <kbd>Q</kbd>/<kbd>E</kbd> ned/opp${def.channel ? ' · <kbd>C</kbd> farge' : ''} · <kbd>Esc</kbd> avbryt`;
  } else if (hoverInst || selInst) {
    const inst = hoverInst || selInst;
    if (inst.fixed) el.innerHTML = `<b>${esc(inst.def.name)}</b> · hører til brettet og står fast`;
    else el.innerHTML = T
      ? `<b>${esc(inst.def.name)}</b> · ${esc(inst.def.desc)}<br>Dra den for å flytte den, eller bruk knappene nede.`
      : `<b>${esc(inst.def.name)}</b> · klikk for å velge · dra for å flytte · <kbd>R</kbd> snu · <kbd>Q</kbd>/<kbd>E</kbd> ned/opp · <kbd>X</kbd> tilbake i kassen${inst.def.channel ? ' · <kbd>C</kbd> farge' : ''}`;
  } else {
    el.innerHTML = T
      ? 'Dra en del fra kassen ut på benken. Trykk på en del for å velge den. Dra med én finger for å se deg rundt, og knip med to for å zoome.'
      : 'Dra en del fra kassen ut på benken · dra for å se deg rundt · rull for å zoome · <kbd>Mellomrom</kbd> start';
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
    openModal(`<div class="eyebrow">Fritt verksted</div><h2>Ingen regler, alle delene</h2>
      <p>Alle delene, så mange du vil, på den største benken i verkstedet. Det er ikke noe oppdrag. Bygg noe vilt og trykk Start!</p>
      <div class="row"><button class="btn primary" data-act="close">Åpne verkstedet</button></div>`);
    return;
  }
  const n = Game.levelIndex + 1;
  const goals = L.goals.map(g => `<li><div class="box"></div><span>${esc(goalText(g))}</span></li>`).join('');
  openModal(`<div class="eyebrow">Brett ${String(n).padStart(2, '0')} av ${LEVELS.length} · mål: ${L.par} ${L.par === 1 ? 'del' : 'deler'}</div>
    <h2>${esc(L.name)}</h2>
    <div class="note">${esc(L.brief)}<span class="sig">— O. Tannhjul, sjefsoppfinner</span></div>
    <div class="eyebrow">Oppdrag</div><ul class="goals">${goals}</ul>
    <div class="eyebrow" style="margin-top:14px">I delekassen</div><div class="chips">${Object.keys(L.bin).length ? chipsFor(L.bin) : '<span class="chip" style="padding:4px 8px">Ingenting. Bruk det som står på benken.</span>'}</div>
    <div class="row"><button class="btn primary" data-act="close">Begynn å bygge</button><button class="btn" data-act="levels">Alle brett</button></div>`,
    { actions: { levels: showLevels } });
}
function starSvg(on, n) {
  return `<svg class="star${on ? ' on pop' : ''}" style="animation-delay:${0.15 + n * 0.18}s" viewBox="0 0 24 24"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>`;
}
function showWin(stars, used) {
  const L = Game.L;
  const quips = [
    'Storartet. Helt unødvendig, og helt storartet.',
    'Naboene kommer til å snakke om dette. La dem bare snakke!',
    'Dette legger jeg i mappen «Triumfer, utrolige».',
    'Ikke ett eneste fornuftig steg i hele greia. Perfekt.',
    'Et sted sitter en helt vanlig spak og gråter av misunnelse.'
  ];
  const q = quips[(Game.levelIndex * 7 + used) % quips.length];
  const last = Game.levelIndex === LEVELS.length - 1;
  openModal(`<div class="eyebrow">Oppdraget er løst</div><h2>${last ? 'Det store apparatet virker!' : 'Det virker!'}</h2>
    <div class="stars">${[0, 1, 2].map(n => starSvg(n < stars, n)).join('')}</div>
    <ul class="stat-list">
      <li><span class="k">Maskintid</span><span>${(Game.winTime || 0).toFixed(1)} sekunder</span></li>
      <li><span class="k">Deler du la til</span><span class="${used <= L.par ? 'y' : ''}">${used} (mål ${L.par})${used <= L.par ? ' ★' : ''}</span></li>
      <li><span class="k">Tips brukt</span><span class="${Game.hintsUsed === 0 ? 'y' : ''}">${Game.hintsUsed}${Game.hintsUsed === 0 ? ' ★' : ''}</span></li>
    </ul>
    <div class="note">${q}<span class="sig">— O. Tannhjul</span></div>
    <div class="row">${last ? '<button class="btn primary" data-act="sandbox">Åpne det frie verkstedet</button>' : '<button class="btn primary" data-act="next">Neste brett</button>'}<button class="btn" data-act="watch">Se på maskinen</button><button class="btn" data-act="levels">Alle brett</button></div>`,
    { actions: { next: () => { closeModal(); loadLevel(Game.levelIndex + 1); }, watch: closeModal, levels: showLevels, sandbox: () => { closeModal(); loadLevel('sandbox'); } } });
}
function showLevels() {
  const prog = progress();
  const firstOpen = LEVELS.findIndex(L => !(prog[L.key]?.stars > 0));
  const cards = LEVELS.map((L, n) => {
    const s = prog[L.key]?.stars || 0;
    return `<button class="lvl${n === firstOpen ? ' next' : ''}" data-act="lvl${n}"><span class="n">${String(n + 1).padStart(2, '0')}${n === firstOpen ? ' · neste' : ''}</span><span class="t">${esc(L.name)}</span><span class="s">${[0, 1, 2].map(k => `<span class="${k < s ? 'on' : ''}">★</span>`).join('')}</span></button>`;
  }).join('');
  const actions = { sandbox: () => { closeModal(); loadLevel('sandbox'); } };
  LEVELS.forEach((L, n) => { actions['lvl' + n] = () => { closeModal(); loadLevel(n); }; });
  const total = LEVELS.reduce((a, L) => a + (prog[L.key]?.stars || 0), 0);
  openModal(`<div class="eyebrow">${total} av ${LEVELS.length * 3} stjerner</div><h2>Brett</h2>
    <p>Hvert brett har et oppdrag og en kasse med deler. Løser du det, får du én stjerne. Bruker du ikke flere deler enn målet, får du to. Klarer du det uten tips, får du tre.</p>
    <div class="levels">${cards}<button class="lvl sandbox" data-act="sandbox"><span class="n">∞</span><span class="t">Fritt verksted</span><span class="s" style="color:var(--muted);letter-spacing:0;font-size:13px">alle deler, ingen regler</span></button></div>`,
    { actions });
}
function showHelp() {
  const gloss = PART_ORDER.map(id => `<button class="chip" data-part="${id}"><img alt="" src="${THUMBS[id] || ''}">${esc(PARTS[id].name)}</button>`).join('');
  openModal(`<div class="eyebrow">Bruksanvisning</div><h2>Slik spiller du</h2>
    <p>Hvert brett har et oppdrag: ring med bjella, sprekk ballongen eller få kula oppi kurven. Dra deler fra kassen ut på benken, og trykk <b>Start</b>. Deler med gul ramme hører til brettet og kan ikke flyttes. Gikk det galt? Trykk <b>Stopp</b>. Prikkene viser hvor tingene trillet. Endre litt og prøv igjen!</p>
    <h3>Bygge</h3>
    <div class="keys">
      <div class="k">Dra fra kassen</div><span>Dra en del ut på benken og slipp den der den skal stå. Du kan også trykke på delen i kassen og så på benken.</span>
      <div class="k">Trykk på en del</div><span>Velger den. Den får en oransje ramme, og knappene <b>Snu</b>, <b>Opp</b>, <b>Ned</b> og <b>Fjern</b> virker på den.</span>
      <div class="k">Dra en del</div><span>Flytter den. Dra den tilbake til kassen for å fjerne den.</span>
      <div class="k">Opp og Ned</div><span>Løfter delen opp i lufta eller senker den. Ting kan sveve, og kuler faller når maskinen starter.</span>
      <div class="k">Farge</div><span>En trykkplate slår på alle deler med samme farge.</span>
      <div class="k">Angre</div><span>Går ett steg tilbake.</span>
      <div class="k">Tips</div><span>En gul skygge viser hvor en del skal stå. Da får du én stjerne mindre.</span>
      <div class="k">Se deg rundt</div><span>Dra med én finger på et tomt sted for å snu kameraet, og knip med to fingre for å zoome. Med mus: dra, og rull med hjulet.</span>
    </div>
    <div class="kbd-help"><h3>Tastatur</h3>
    <div class="keys">
      <div class="k"><kbd>R</kbd></div><span>Snu delen du holder, eller den under musepekeren.</span>
      <div class="k"><kbd>E</kbd> / <kbd>Q</kbd></div><span>Opp eller ned ett hakk.</span>
      <div class="k"><kbd>C</kbd></div><span>Bytt farge på ledningen.</span>
      <div class="k"><kbd>X</kbd> / <kbd>Del</kbd></div><span>Legg delen tilbake i kassen.</span>
      <div class="k"><kbd>Z</kbd></div><span>Angre.</span>
      <div class="k"><kbd>Esc</kbd> / høyreklikk</div><span>Legg fra deg det du holder.</span>
      <div class="k"><kbd>Mellomrom</kbd></div><span>Start eller stopp maskinen.</span>
      <div class="k"><kbd>V</kbd></div><span>Bytt kameravinkel. «Forfra» ser ut som en tegning fra siden.</span>
      <div class="k"><kbd>H</kbd></div><span>Vis et tips.</span>
      <div class="k"><kbd>1</kbd>–<kbd>9</kbd></div><span>Ta delen på den plassen i kassen.</span>
    </div></div>
    <h3>Delene</h3><p style="margin:0 0 6px;color:var(--muted)">Trykk på en del for å lese hva den gjør.</p><div class="chips">${gloss}</div>`);
  $$('#modal .chip[data-part]').forEach(c => c.addEventListener('click', () => { const d = PARTS[c.dataset.part]; toast(`${d.name}: ${d.desc}`, '', 4200); }));
}
// ---------------------------------------------------------------------------
//  Camera
// ---------------------------------------------------------------------------
const VIEWS = ['Angled', 'Front', 'Top', 'Side'];
const VIEW_LABELS = { Angled: 'Skrå', Front: 'Forfra', Top: 'Ovenfra', Side: 'Fra siden' };
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
  $('#viewLabel').textContent = 'Visning';
  tweenTo(viewPose('Angled'), instant);
}
function tweenTo(p, instant) {
  if (instant) { camera.position.copy(p.pos); controls.target.copy(p.target); controls.update(); camTween = null; return; }
  camTween = { fp: camera.position.clone(), ft: controls.target.clone(), tp: p.pos, tt: p.target, t: 0 };
}
function cycleView() {
  viewIdx = (viewIdx + 1) % VIEWS.length;
  $('#viewLabel').textContent = VIEW_LABELS[VIEWS[viewIdx]];
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
  $('#titleSpec').textContent = `${LEVELS.length} brett · ${PART_ORDER.length} deler · ${solved ? solved + ' løst så langt' : 'dra for å se deg rundt'}`;
  $('#playBtn').textContent = solved ? 'Fortsett å bygge' : 'Begynn å bygge';
}
function startAttract() {
  stopAttract();
  Game.attract = true;
  const L = SHOWCASE;
  Game.L = L; Game.levelIndex = null;
  clearInsts();
  Trail.clear();
  BOARD.w = L.board[0]; BOARD.d = L.board[1]; BOARD.h = L.board[2];
  buildSet('Det Utrolige Apparatet');
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
// A press on the bench means one of four things, decided when the finger/button goes down:
//   look  - empty space or a puzzle part: drag orbits the camera, a tap clears the selection
//   held  - a part is in hand: drag moves it, lifting the finger puts it down
//   part  - one of your placed parts: a tap selects it, a drag picks it up and moves it
//   bin   - a card in the parts bin: a drag carries the part out onto the bench
// The handler runs in the capture phase on window, so it runs before OrbitControls and can
// stop one finger from turning the camera while it is moving a part.
function onPointerDown(e) {
  setTouchUI(e.pointerType !== 'mouse');
  if (e.isPrimary) activePointers.clear(); // a fresh touch sequence: forget any lost pointers
  activePointers.add(e.pointerId);
  if (activePointers.size > 1) { // a second finger: this is a pinch or a turn, not a placement
    if (gesture) {
      gesture.multi = true;
      if (gesture.kind === 'part') gesture.kind = 'look';
      if (gesture.kind === 'bin' && gesture.moved) $('#dragAvatar').hidden = true;
      syncCamera();
    }
    return;
  }
  if (e.target !== canvas) return; // bin cards start their own gesture
  ptr.down = true; ptr.moved = false; ptr.sx = e.clientX; ptr.sy = e.clientY; ptr.t = performance.now(); ptr.button = e.button;
  ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
  camTween = null;
  canvas.focus({ preventScroll: true });
  gesture = { kind: 'look', id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, multi: false, button: e.button, inst: null, touch: e.pointerType !== 'mouse' };
  if (Game.mode !== 'edit' || e.button !== 0) return;
  updatePointer(); // the held part jumps under the finger, or we find what was pressed
  if (Game.held) gesture.kind = 'held';
  else if (hoverInst) {
    gesture.inst = hoverInst;
    if (!hoverInst.fixed) { gesture.kind = 'part'; syncCamera(); }
  }
}
function binPointerDown(e, type) {
  if (Game.mode !== 'edit' || e.button !== 0 || activePointers.size > 1) return;
  if (!(Game.bin[type] > 0)) return; // the click handler explains
  gesture = { kind: 'bin', type, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, multi: false, button: 0, over: false, touch: e.pointerType !== 'mouse' };
  ptr.x = e.clientX; ptr.y = e.clientY;
  hideTip();
}
function onPointerMove(e) {
  if (e.pointerType === 'mouse' && usingTouch) setTouchUI(false);
  const g = gesture;
  if (g && e.pointerId !== g.id) return; // other fingers belong to OrbitControls
  ptr.x = e.clientX; ptr.y = e.clientY;
  if (!g) { // plain mouse hover
    if (e.target === canvas) { ptr.inside = true; updatePointer(); moveHoverLabel(); }
    return;
  }
  if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > (g.touch ? 10 : 5)) {
    g.moved = true; ptr.moved = true;
    if (!g.multi && Game.mode === 'edit') {
      if (g.kind === 'part') { pickUp(g.inst); g.kind = Game.held ? 'held' : 'look'; }
      else if (g.kind === 'bin') startBinDrag(g);
    }
  }
  if (g.multi) return;
  if (g.kind === 'bin') { if (g.moved) binDragMove(g, e); return; }
  if (g.kind === 'held') { ptr.inside = true; updatePointer(); }
}
function overBin(x, y) { const el = document.elementFromPoint(x, y); return !!(el && el.closest('#bin')); }
function onPointerUp(e) {
  activePointers.delete(e.pointerId);
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  gesture = null;
  ptr.down = false;
  syncCamera();
  if (g.kind === 'bin') { endBinDrag(g, e); return; }
  if (g.multi || Game.mode !== 'edit') { updatePointer(); return; }
  if (g.button === 2) { if (!g.moved && Game.held) cancelHeld(); updatePointer(); return; }
  if (g.button !== 0) { updatePointer(); return; }
  if (g.kind === 'held') {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    updatePointer();
    if (el === canvas) tryPlace();
    else if (g.moved && Game.held?.from && el && el.closest('#bin')) returnToBin(null); // dragged back into the bin
    else if (g.moved && Game.held?.from) cancelHeld(); // dropped on a panel: back where it was
    updatePointer();
    return;
  }
  if (g.moved) { updatePointer(); return; } // that was a camera drag
  if (g.kind === 'part') select(g.inst);
  else {
    if (g.inst && g.inst.fixed) { Sound.nope(); toast(`${g.inst.def.name}: hører til brettet og står fast.`, 'warn', 2000); }
    select(null);
  }
  updatePointer();
}
function onPointerCancel(e) {
  activePointers.delete(e.pointerId);
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  gesture = null;
  ptr.down = false;
  $('#dragAvatar').hidden = true;
  if (g.kind === 'bin' && g.moved) cancelHeld(true);
  syncCamera();
  updatePointer();
}
function startBinDrag(g) {
  if (Game.held && !(Game.held.type === g.type && !Game.held.from)) cancelHeld(true);
  if (!Game.held) holdFromBin(g.type);
  if (!Game.held) { g.multi = true; return; }
  lastBinDrag = performance.now();
  const av = $('#dragAvatar');
  av.src = THUMBS[g.type] || '';
  av.hidden = false;
}
function binDragMove(g, e) {
  const onCanvas = document.elementFromPoint(e.clientX, e.clientY) === canvas;
  g.over = onCanvas;
  ptr.inside = onCanvas; ptr.down = true;
  const av = $('#dragAvatar');
  av.hidden = onCanvas; // over the bench the real ghost takes over
  if (!onCanvas) av.style.transform = `translate(${e.clientX - 42}px, ${e.clientY - 70}px)`;
  updatePointer();
}
function endBinDrag(g, e) {
  $('#dragAvatar').hidden = true;
  if (!g.moved || g.multi) { if (g.moved) cancelHeld(true); updatePointer(); return; } // a plain tap: the click handler takes it
  lastBinDrag = performance.now();
  const onCanvas = document.elementFromPoint(e.clientX, e.clientY) === canvas;
  updatePointer();
  if (onCanvas && Game.held) tryPlace(); // if the spot is taken, the part stays in hand, shown red
  else cancelHeld(true);
  updatePointer();
}
function moveHoverLabel() {
  if (hoverInst && !$('#hoverLabel').hidden) { const el = $('#hoverLabel'); el.style.left = ptr.x + 'px'; el.style.top = ptr.y + 'px'; }
}
function clearMine() {
  if (Game.mode !== 'edit') return;
  const mine = Game.insts.filter(x => !x.fixed);
  if (!mine.length) { toast('Du har ikke satt ut noen deler ennå.', '', 1600); return; }
  openModal(`<div class="eyebrow">Tøm benken</div><h2>Legge alt tilbake?</h2><p>Alle ${mine.length} delene du har satt ut, går tilbake i kassen. Brettets egne deler blir stående. Du kan angre etterpå.</p>
    <div class="row"><button class="btn primary" data-act="yes">Tøm benken</button><button class="btn" data-act="close">Behold dem</button></div>`,
    { actions: { yes: () => { cancelHeld(true); pushUndo(); for (const m of mine) returnToBin(m, { noUndo: true, silent: true }); Sound.remove(); closeModal(); } } });
}
function bindInput() {
  window.addEventListener('resize', onResize);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !gesture) { ptr.inside = false; updatePointer(); } });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (Game.modalOpen) { if (e.key === 'Escape') closeModal(); return; }
    if (!$('#title').hidden) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ' || k === 'enter') { e.preventDefault(); toggleRun(); }
    else if (k === 'r') rotateAction(true);
    else if (k === 'e' || k === 'pageup') heightAction(1, true);
    else if (k === 'q' || k === 'pagedown') heightAction(-1, true);
    else if (k === 'c') wireAction(true);
    else if (k === 'z') undo();
    else if (k === 'x' || k === 'delete' || k === 'backspace') { e.preventDefault(); if (Game.held) returnToBin(null); else { const t = toolTarget(true); if (t) returnToBin(t); else nothingSelected(); } }
    else if (k === 'escape') { if (Game.held) cancelHeld(); else select(null); }
    else if (k === 'h') showHint();
    else if (k === 'v') cycleView();
    else if (/^[1-9]$/.test(k)) { const t = binTypes()[+k - 1]; if (t) holdFromBin(t); }
  });
  $('#runBtn').addEventListener('click', toggleRun);
  $('#rotBtn').addEventListener('click', () => rotateAction(false));
  $('#upBtn').addEventListener('click', () => heightAction(1, false));
  $('#downBtn').addEventListener('click', () => heightAction(-1, false));
  $('#wireBtn').addEventListener('click', () => wireAction(false));
  $('#delBtn').addEventListener('click', () => {
    if (Game.held) returnToBin(null);
    else if (selInst) returnToBin(selInst);
    else nothingSelected();
  });
  $('#undoBtn').addEventListener('click', undo);
  $('#hintBtn').addEventListener('click', showHint);
  $('#viewBtn').addEventListener('click', cycleView);
  $('#clearBtn').addEventListener('click', clearMine);
  $$('#speed button').forEach(b => b.addEventListener('click', () => {
    Game.speed = +b.dataset.s;
    $$('#speed button').forEach(x => x.classList.toggle('on', x === b));
  }));
  const sb = $('#soundBtn');
  sb.classList.toggle('off', Sound.muted);
  sb.addEventListener('click', () => { Sound.setMuted(!Sound.muted); sb.classList.toggle('off', Sound.muted); Sound.click(); });
  const mb = $('#musicBtn');
  mb.classList.toggle('off', Sound.musicOff);
  mb.addEventListener('click', () => { Sound.setMusic(Sound.musicOff); mb.classList.toggle('off', Sound.musicOff); });
  $('#helpBtn').addEventListener('click', showHelp);
  $('#levelsBtn').addEventListener('click', showLevels);
  $('#brandBtn').addEventListener('click', showTitle);
  $('#playBtn').addEventListener('click', () => { Sound.click(); continueGame(); });
  $('#puzzlesBtn').addEventListener('click', () => { Sound.click(); showLevels(); });
  $('#sandboxBtn').addEventListener('click', () => { Sound.click(); loadLevel('sandbox'); });
  $('#howBtn').addEventListener('click', () => { Sound.click(); showHelp(); });
  $('#modalWrap').addEventListener('pointerdown', (e) => { if (e.target.id === 'modalWrap') closeModal(); });
  setTouchUI(usingTouch);
  syncCamera();
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
    while (Game.acc >= DT && n < maxN && sim.time < MAX_RUN_TIME + 5) { sim.step(); if (!Game.attract) Trail.record(sim); Game.acc -= DT; n++; }
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
  get trailDots() { return Trail.count; }, get ghostCell() { return ghost && ghost.cell; }, get selected() { return selInst && [selInst.type, selInst.i, selInst.j, selInst.k, selInst.r]; }, get undoDepth() { return undoStack.length; }, Sound,
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
