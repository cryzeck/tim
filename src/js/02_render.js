// ============================================================================
//  Rendering: renderer, workshop scene, procedural textures, materials, FX
// ============================================================================
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
} catch (e) {
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font:600 18px/1.5 var(--font-body);color:var(--chalk);background:var(--ink)';
  msg.textContent = 'Det Utrolige Apparatet trenger WebGL, og denne nettleseren klarte ikke å starte det. Prøv en annen nettleser, eller slå på maskinvareakselerasjon.';
  document.body.appendChild(msg);
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const BG = 0x101b2f;
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 34, 80);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
camera.position.set(8, 9, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.maxPolarAngle = Math.PI * 0.485;
controls.minDistance = 3.5;
controls.maxDistance = 46;
controls.screenSpacePanning = false;
controls.zoomSpeed = 0.9;
controls.rotateSpeed = 0.7;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// Lights: warm workshop key light from above (shadows fall almost straight down,
// which doubles as a depth cue while placing parts), cool fill, sky/ground bounce.
const hemi = new THREE.HemisphereLight(0xd6e6ff, 0x3a2a1c, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe4c0, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);
const fill = new THREE.DirectionalLight(0x9db9ff, 0.45);
fill.position.set(12, 6, -10);
scene.add(fill);

// ----------------------------------------------------------------------------
//  Board coordinates. One cell = one world unit. Floor of the board is y = 0.
// ----------------------------------------------------------------------------
const BOARD = { w: 10, d: 6, h: 7 };
function cellToWorld(i, j, k, out = new THREE.Vector3()) {
  return out.set(i - BOARD.w / 2 + 0.5, j, k - BOARD.d / 2 + 0.5);
}
function inBoard(i, j, k) {
  return i >= 0 && k >= 0 && j >= 0 && i < BOARD.w && k < BOARD.d && j < BOARD.h;
}

// ----------------------------------------------------------------------------
//  Procedural textures
// ----------------------------------------------------------------------------
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, MAX_ANISO);
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
  return t;
}

function woodTex(seed, base, dark, light, opts = {}) {
  const w = opts.w || 256, h = opts.h || 256;
  return canvasTex(w, h, (g) => {
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    // broad tone variation
    for (let i = 0; i < 6; i++) {
      g.fillStyle = r() < 0.5 ? dark : light;
      g.globalAlpha = 0.05 + r() * 0.06;
      g.fillRect(0, r() * h, w, 10 + r() * 40);
    }
    // grain
    const lines = opts.lines || 46;
    for (let i = 0; i < lines; i++) {
      const y0 = r() * h, amp = 1 + r() * 5, fq = 0.008 + r() * 0.03, ph = r() * 10;
      g.strokeStyle = r() < 0.65 ? dark : light;
      g.globalAlpha = 0.07 + r() * 0.2;
      g.lineWidth = 0.5 + r() * 2;
      g.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = y0 + Math.sin(x * fq + ph) * amp + Math.sin(x * 0.11 + ph * 3) * 0.5;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    // a knot or two
    for (let k = 0; k < (opts.knots ?? 1); k++) {
      const kx = r() * w, ky = r() * h;
      for (let i = 6; i > 0; i--) {
        g.globalAlpha = 0.08; g.strokeStyle = dark; g.lineWidth = 1.2;
        g.beginPath(); g.ellipse(kx, ky, i * 3.2, i * 1.3, 0, 0, TAU); g.stroke();
      }
    }
    if (opts.planks) {
      g.globalAlpha = 0.5; g.fillStyle = dark;
      for (let i = 1; i < opts.planks; i++) g.fillRect(0, (i * h) / opts.planks - 1, w, 2);
    }
    g.globalAlpha = 1;
  }, opts);
}

// The board: a green self-healing cutting mat with a ruled margin (one tick per tenth of a cell)
function matTexture(W, D) {
  const S = 64, M = 0.6; // px per cell, margin in cells
  const pw = Math.round((W + M * 2) * S), ph = Math.round((D + M * 2) * S);
  return canvasTex(pw, ph, (g) => {
    g.fillStyle = '#2d6a59'; g.fillRect(0, 0, pw, ph);
    const r = rng(11);
    for (let i = 0; i < 2600; i++) { // speckle
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
      g.fillRect(r() * pw, r() * ph, 2, 2);
    }
    const ox = M * S, oy = M * S;
    // diagonal 45° guides
    g.strokeStyle = 'rgba(190,235,215,0.10)'; g.lineWidth = 1;
    for (let i = -D; i < W; i += 2) {
      g.beginPath(); g.moveTo(ox + i * S, oy); g.lineTo(ox + (i + D) * S, oy + D * S); g.stroke();
    }
    // cell grid
    for (let i = 0; i <= W; i++) {
      g.strokeStyle = i % 5 === 0 ? 'rgba(235,250,240,0.55)' : 'rgba(200,240,220,0.28)';
      g.lineWidth = i % 5 === 0 ? 2 : 1.2;
      g.beginPath(); g.moveTo(ox + i * S, oy); g.lineTo(ox + i * S, oy + D * S); g.stroke();
    }
    for (let k = 0; k <= D; k++) {
      g.strokeStyle = k % 5 === 0 ? 'rgba(235,250,240,0.55)' : 'rgba(200,240,220,0.28)';
      g.lineWidth = k % 5 === 0 ? 2 : 1.2;
      g.beginPath(); g.moveTo(ox, oy + k * S); g.lineTo(ox + W * S, oy + k * S); g.stroke();
    }
    // ruler ticks in the margin
    g.strokeStyle = 'rgba(245,230,140,0.75)'; g.fillStyle = 'rgba(245,230,140,0.85)';
    g.font = '600 15px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let t = 0; t <= W * 10; t++) {
      const x = ox + (t / 10) * S, len = t % 10 === 0 ? 14 : t % 5 === 0 ? 9 : 5;
      g.lineWidth = t % 10 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(x, oy - 2); g.lineTo(x, oy - 2 - len); g.stroke();
      g.beginPath(); g.moveTo(x, oy + D * S + 2); g.lineTo(x, oy + D * S + 2 + len); g.stroke();
      if (t % 10 === 0 && t / 10 < W) g.fillText(String.fromCharCode(65 + t / 10), x + S / 2, oy + D * S + 22);
    }
    for (let t = 0; t <= D * 10; t++) {
      const y = oy + (t / 10) * S, len = t % 10 === 0 ? 14 : t % 5 === 0 ? 9 : 5;
      g.lineWidth = t % 10 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(ox - 2, y); g.lineTo(ox - 2 - len, y); g.stroke();
      g.beginPath(); g.moveTo(ox + W * S + 2, y); g.lineTo(ox + W * S + 2 + len, y); g.stroke();
      if (t % 10 === 0 && t / 10 < D) g.fillText(String(t / 10 + 1), ox - 24, y + S / 2);
    }
  });
}

const TEX = {};
function initTextures() {
  TEX.woodLight = woodTex(1, '#d9b07a', '#9c6b3a', '#f0cf9c');
  TEX.woodMid = woodTex(2, '#b27a45', '#6e4421', '#cf9a62');
  TEX.woodDark = woodTex(3, '#6f4426', '#3c220f', '#8d5a34');
  TEX.plank = woodTex(4, '#e6c38c', '#a87a45', '#f6deae', { knots: 0 });
  TEX.table = woodTex(5, '#8b5a32', '#4f2f16', '#a77344', { w: 512, h: 512, planks: 4, lines: 120, knots: 3, repeat: [3, 3] });
  TEX.pegboard = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8a6a48'; g.fillRect(0, 0, w, h);
    const r = rng(9);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.05})`; g.fillRect(r() * w, r() * h, 3, 3); }
    for (let y = 16; y < h; y += 32) for (let x = 16; x < w; x += 32) {
      g.fillStyle = '#2a1d12'; g.beginPath(); g.arc(x, y, 4.2, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,230,190,0.18)'; g.beginPath(); g.arc(x + 0.8, y + 1.2, 4.2, 0, Math.PI); g.fill();
    }
  }, { repeat: [8, 4] });
  TEX.belt = canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#26282c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3d4046'; g.lineWidth = 7; g.lineCap = 'round';
    for (let x = -32; x < w + 32; x += 32) {
      g.beginPath(); g.moveTo(x, 6); g.lineTo(x + 16, h / 2); g.lineTo(x, h - 6); g.stroke();
    }
  }, { repeat: [3, 1] });
  TEX.beach = canvasTex(256, 128, (g, w, h) => {
    const cols = ['#f24b3d', '#ffffff', '#2f7de1', '#ffffff', '#f6c533', '#ffffff'];
    cols.forEach((c, i) => { g.fillStyle = c; g.fillRect((i * w) / 6, 0, w / 6 + 1, h); });
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
  });
  TEX.bowling = canvasTex(256, 128, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#3b1a6e'); grd.addColorStop(0.5, '#6a2bb0'); grd.addColorStop(1, '#2a1150');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    const r = rng(21);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(${150 + r() * 100},${80 + r() * 80},255,${0.12 + r() * 0.18})`;
      g.lineWidth = 2 + r() * 6; g.beginPath();
      const y = r() * h; g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 80, w * 0.6, y + (r() - 0.5) * 80, w, y + (r() - 0.5) * 30); g.stroke();
    }
    g.fillStyle = '#0c0614';
    [[0.24, 0.36], [0.3, 0.3], [0.27, 0.46]].forEach(([u, v], i) => { g.beginPath(); g.ellipse(u * w, v * h, i === 2 ? 7 : 5, i === 2 ? 9 : 7, 0, 0, TAU); g.fill(); });
  });
  TEX.crate = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#c99b62'; g.fillRect(0, 0, w, h);
    const r = rng(31);
    for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(90,60,20,${r() * 0.06})`; g.fillRect(r() * w, r() * h, 1 + r() * 30, 1); }
    g.fillStyle = 'rgba(232,206,150,0.85)'; g.fillRect(w * 0.42, 0, w * 0.16, h); // tape
    g.strokeStyle = 'rgba(70,40,15,0.6)'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = 'rgba(60,35,15,0.7)'; g.font = '800 28px "Big Shoulders Stencil Display", Impact, sans-serif';
    g.textAlign = 'center'; g.fillText('DENNE SIDEN OPP', w / 2, h * 0.22);
    g.beginPath(); g.moveTo(w * 0.3, h * 0.7); g.lineTo(w * 0.3, h * 0.42); g.lineTo(w * 0.22, h * 0.5); g.moveTo(w * 0.3, h * 0.42); g.lineTo(w * 0.38, h * 0.5);
    g.moveTo(w * 0.7, h * 0.7); g.lineTo(w * 0.7, h * 0.42); g.lineTo(w * 0.62, h * 0.5); g.moveTo(w * 0.7, h * 0.42); g.lineTo(w * 0.78, h * 0.5);
    g.lineWidth = 7; g.strokeStyle = 'rgba(60,35,15,0.7)'; g.stroke();
  });
  TEX.domino = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#f7f3ea'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#20232a'; g.fillRect(10, h / 2 - 2, w - 20, 4);
    const pip = (x, y) => { g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill(); };
    pip(w * 0.3, h * 0.12); pip(w * 0.7, h * 0.12); pip(w * 0.5, h * 0.25); pip(w * 0.3, h * 0.38); pip(w * 0.7, h * 0.38);
    pip(w * 0.3, h * 0.65); pip(w * 0.7, h * 0.85); pip(w * 0.5, h * 0.75);
  });
  TEX.lampGlow = canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,240,190,1)'); grd.addColorStop(0.3, 'rgba(255,200,90,0.45)'); grd.addColorStop(1, 'rgba(255,170,50,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

// ----------------------------------------------------------------------------
//  Materials
// ----------------------------------------------------------------------------
const MAT = {};
function std(o) { return new THREE.MeshStandardMaterial(Object.assign({ envMapIntensity: 0.55 }, o)); }
function initMaterials() {
  MAT.woodLight = std({ map: TEX.woodLight, roughness: 0.7 });
  MAT.woodMid = std({ map: TEX.woodMid, roughness: 0.66 });
  MAT.woodDark = std({ map: TEX.woodDark, roughness: 0.6 });
  MAT.plank = std({ map: TEX.plank, roughness: 0.55 });
  MAT.table = std({ map: TEX.table, roughness: 0.7, color: 0xd8c8b8 });
  MAT.pegboard = std({ map: TEX.pegboard, roughness: 0.95, color: 0x9a8a78 });
  MAT.steel = std({ color: 0xc3ccd6, metalness: 0.92, roughness: 0.28, envMapIntensity: 1 });
  MAT.chrome = std({ color: 0xe8edf2, metalness: 1, roughness: 0.12, envMapIntensity: 1.2 });
  MAT.brass = std({ color: 0xd9a54d, metalness: 0.95, roughness: 0.3, envMapIntensity: 1 });
  MAT.copper = std({ color: 0xc9744a, metalness: 0.9, roughness: 0.35, envMapIntensity: 1 });
  MAT.darkMetal = std({ color: 0x3b4049, metalness: 0.7, roughness: 0.42 });
  MAT.iron = std({ color: 0x5a6068, metalness: 0.8, roughness: 0.5 });
  MAT.rubber = std({ color: 0x23262b, roughness: 0.9 });
  MAT.belt = std({ map: TEX.belt, roughness: 0.85 });
  MAT.red = std({ color: 0xd6412f, roughness: 0.42 });
  MAT.blue = std({ color: 0x2c6dd1, roughness: 0.42 });
  MAT.yellow = std({ color: 0xf2b72a, roughness: 0.42 });
  MAT.green = std({ color: 0x379a55, roughness: 0.45 });
  MAT.teal = std({ color: 0x2aa198, roughness: 0.45 });
  MAT.cream = std({ color: 0xf1ead9, roughness: 0.5 });
  MAT.white = std({ color: 0xf5f3ee, roughness: 0.35 });
  MAT.black = std({ color: 0x1a1c20, roughness: 0.5 });
  MAT.trampoline = std({ color: 0x1e2a3a, roughness: 0.75 });
  MAT.cactus = std({ color: 0x4f9a4a, roughness: 0.75 });
  MAT.terracotta = std({ color: 0xc0643c, roughness: 0.85 });
  MAT.spine = std({ color: 0xfff6d8, roughness: 0.4 });
  MAT.crate = std({ map: TEX.crate, roughness: 0.85 });
  MAT.domino = std({ map: TEX.domino, roughness: 0.3 });
  MAT.dominoSide = std({ color: 0xf7f3ea, roughness: 0.3 });
  MAT.beach = new THREE.MeshPhysicalMaterial({ map: TEX.beach, roughness: 0.35, clearcoat: 0.6, envMapIntensity: 0.6 });
  MAT.bowling = new THREE.MeshPhysicalMaterial({ map: TEX.bowling, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.9 });
  MAT.rubberBall = new THREE.MeshPhysicalMaterial({ color: 0xff4f7b, roughness: 0.45, clearcoat: 0.4, envMapIntensity: 0.6 });
  MAT.balloon = new THREE.MeshPhysicalMaterial({ color: 0xff3b5c, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.15, sheen: 0.3, envMapIntensity: 0.8 });
  MAT.string = new THREE.LineBasicMaterial({ color: 0xf2efe6 });
  MAT.bulbOff = std({ color: 0xd8d4c4, roughness: 0.15, transparent: true, opacity: 0.75 });
  MAT.bulbOn = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });
  MAT.glow = new THREE.SpriteMaterial({ map: TEX.lampGlow, color: 0xffd27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  MAT.ghostOk = new THREE.MeshBasicMaterial({ color: 0x7cf0b0, transparent: true, opacity: 0.55, depthWrite: false });
  MAT.ghostBad = new THREE.MeshBasicMaterial({ color: 0xff5a4d, transparent: true, opacity: 0.55, depthWrite: false });
  MAT.hint = new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.35, depthWrite: false });
  MAT.channel = {};
  for (const c of CHANNELS) MAT.channel[c] = std({ color: CH_HEX[c], roughness: 0.35, emissive: CH_HEX[c], emissiveIntensity: 0.18 });
  MAT.channelNone = std({ color: 0x8a919b, roughness: 0.5 });
}
function chMat(ch) { return ch ? MAT.channel[ch] : MAT.channelNone; }

// ----------------------------------------------------------------------------
//  Mesh helpers (geometry is cached & shared)
// ----------------------------------------------------------------------------
const GEO = new Map();
function cachedGeo(key, make) { let g = GEO.get(key); if (!g) { g = make(); GEO.set(key, g); } return g; }
const gBox = (w, h, d) => cachedGeo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const gRBox = (w, h, d, r = 0.04) => cachedGeo(`rb${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)));
const gCyl = (rt, rb, h, seg = 24, open = false) => cachedGeo(`c${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
const gSphere = (r, ws = 32, hs = 20) => cachedGeo(`s${r},${ws}`, () => new THREE.SphereGeometry(r, ws, hs));
const gTorus = (r, t, rs = 12, ts = 32, arc = TAU) => cachedGeo(`t${r},${t},${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));

function mk(geo, mat, x = 0, y = 0, z = 0, o = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (o.rx) m.rotation.x = o.rx;
  if (o.ry) m.rotation.y = o.ry;
  if (o.rz) m.rotation.z = o.rz;
  if (o.s) m.scale.setScalar(o.s);
  m.castShadow = o.cast !== false;
  m.receiveShadow = o.recv !== false;
  return m;
}
function group(...children) { const g = new THREE.Group(); children.forEach(c => c && g.add(c)); return g; }

// ----------------------------------------------------------------------------
//  The workshop set (rebuilt per level to fit the board)
// ----------------------------------------------------------------------------
let setGroup = null;
let buildGrid = null;
function buildSet(levelTitle) {
  if (setGroup) { scene.remove(setGroup); setGroup.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose?.(); }); }
  setGroup = new THREE.Group();
  const W = BOARD.w, D = BOARD.d;
  // table slab
  const TW = W + 14, TD = D + 12;
  const table = mk(new THREE.BoxGeometry(TW, 1.2, TD), MAT.table, 0, -0.645, 1, { cast: false });
  setGroup.add(table);
  // cutting mat
  const M = 0.6;
  const matTex = matTexture(W, D);
  const mat = mk(new THREE.BoxGeometry(W + M * 2, 0.04, D + M * 2), [
    std({ color: 0x24594a, roughness: 0.8 }), std({ color: 0x24594a, roughness: 0.8 }),
    std({ map: matTex, roughness: 0.82 }), std({ color: 0x24594a }), std({ color: 0x24594a, roughness: 0.8 }), std({ color: 0x24594a, roughness: 0.8 })
  ], 0, -0.02, 0, { cast: false });
  setGroup.add(mat);
  // pegboard wall behind
  const wall = mk(new THREE.PlaneGeometry(TW + 70, 40), MAT.pegboard, 0, 14, -D / 2 - 7, { cast: false });
  setGroup.add(wall);
  // hanging tools (silhouettes on the pegboard)
  const tools = new THREE.Group();
  const toolMat = MAT.darkMetal;
  const hammer = group(mk(gBox(0.18, 2.4, 0.12), MAT.woodMid, 0, 0, 0), mk(gRBox(1.1, 0.36, 0.3, 0.06), MAT.iron, 0, 1.25, 0));
  hammer.position.set(-W / 2 - 1, 6.5, -D / 2 - 6.8); hammer.rotation.z = 0.1;
  const wrench = group(mk(gBox(0.22, 2.6, 0.08), toolMat, 0, 0, 0), mk(gTorus(0.3, 0.1, 8, 20, TAU * 0.8), toolMat, 0, 1.45, 0, { rz: -0.9 }));
  wrench.position.set(-W / 2 + 1.2, 6.8, -D / 2 - 6.8); wrench.rotation.z = -0.15;
  const saw = group(mk(gBox(2.8, 0.9, 0.04), MAT.steel, 0, 0, 0), mk(gRBox(0.7, 1.0, 0.16, 0.12), MAT.red, 1.65, 0.1, 0));
  saw.position.set(W / 2 - 1, 7.2, -D / 2 - 6.85);
  const coil = mk(gTorus(0.9, 0.12, 8, 28), MAT.copper, W / 2 + 3, 6.2, -D / 2 - 6.7);
  tools.add(hammer, wrench, saw, coil);
  setGroup.add(tools);
  // blueprint sheet + mug as tabletop props, well clear of the board
  const bp = canvasTex(512, 360, (g, w, h) => {
    g.fillStyle = '#1d4f8c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (let x = 0; x < w; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2;
    g.strokeRect(14, 14, w - 28, h - 28);
    g.beginPath(); g.arc(150, 170, 60, 0, TAU); g.stroke();
    g.beginPath(); g.arc(150, 170, 18, 0, TAU); g.stroke();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; g.beginPath(); g.moveTo(150 + Math.cos(a) * 60, 170 + Math.sin(a) * 60); g.lineTo(150 + Math.cos(a) * 74, 170 + Math.sin(a) * 74); g.stroke(); }
    g.beginPath(); g.moveTo(240, 250); g.lineTo(460, 120); g.stroke();
    g.beginPath(); g.arc(300, 214, 22, 0, TAU); g.stroke();
    g.setLineDash([6, 6]); g.beginPath(); g.moveTo(300, 214); g.lineTo(300, 300); g.lineTo(470, 300); g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '800 30px "Big Shoulders Stencil Display", Impact, sans-serif';
    g.fillText((levelTitle || 'APPARATET').toUpperCase().slice(0, 22), 28, 56);
    g.font = '500 14px "IBM Plex Mono", monospace';
    g.fillText('TEGN. NR. DUA-' + String(W * 100 + D).padStart(4, '0') + '   MÅLESTOKK 1:1 RUTE', 28, h - 30);
  });
  const sheet = mk(new THREE.PlaneGeometry(4.2, 2.95), std({ map: bp, roughness: 0.9 }), W / 2 + 4.2, 0.012, D / 2 + 1.5, { rx: -Math.PI / 2, cast: false });
  sheet.rotation.z = 0.18;
  setGroup.add(sheet);
  const mug = group(
    mk(gCyl(0.42, 0.38, 0.95, 28), std({ color: 0xe9e2d0, roughness: 0.35 }), 0, 0.475, 0),
    mk(gCyl(0.37, 0.37, 0.02, 24), std({ color: 0x3a1f10, roughness: 0.2 }), 0, 0.86, 0, { cast: false }),
    mk(gTorus(0.22, 0.06, 8, 20), std({ color: 0xe9e2d0, roughness: 0.35 }), 0.46, 0.5, 0, { ry: 0 })
  );
  mug.position.set(-W / 2 - 3.2, 0, D / 2 + 1.2);
  setGroup.add(mug);
  const pencil = group(mk(gCyl(0.06, 0.06, 2.4, 6), MAT.yellow, 0, 0, 0, { rz: Math.PI / 2 }), mk(gCyl(0.0, 0.06, 0.25, 6), MAT.cream, 1.32, 0, 0, { rz: -Math.PI / 2 }));
  pencil.position.set(-W / 2 - 2.6, 0.06, -D / 2 + 0.5); pencil.rotation.y = 0.7;
  setGroup.add(pencil);
  scene.add(setGroup);

  // shadow camera fits the board
  const ext = Math.max(W, D) * 0.75 + 4;
  sun.position.set(-3.5, 18, 6);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 50;
  sc.updateProjectionMatrix();

  // build-height grid (shown while holding a part above the floor)
  if (buildGrid) scene.remove(buildGrid);
  const pts = [];
  for (let i = 0; i <= W; i++) { pts.push(i - W / 2, 0, -D / 2, i - W / 2, 0, D / 2); }
  for (let k = 0; k <= D; k++) { pts.push(-W / 2, 0, k - D / 2, W / 2, 0, k - D / 2); }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  buildGrid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.22, depthWrite: false }));
  buildGrid.visible = false;
  scene.add(buildGrid);
}

// ----------------------------------------------------------------------------
//  Particle FX — pooled instanced quads (confetti) and blobs (sparks & puffs)
// ----------------------------------------------------------------------------
const FX = (() => {
  const N = 600;
  const confGeo = new THREE.PlaneGeometry(0.13, 0.08);
  const confMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6, envMapIntensity: 0.5 });
  const conf = new THREE.InstancedMesh(confGeo, confMat, N);
  const blobGeo = new THREE.IcosahedronGeometry(0.06, 0);
  const blobMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  const blob = new THREE.InstancedMesh(blobGeo, blobMat, N);
  conf.frustumCulled = blob.frustumCulled = false;
  const color = new THREE.Color();
  for (let i = 0; i < N; i++) { conf.setColorAt(i, color.set(0xffffff)); blob.setColorAt(i, color.set(0xffffff)); }
  const parts = [];
  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < N; i++) { conf.setMatrixAt(i, zero); blob.setMatrixAt(i, zero); }
  scene.add(conf, blob);
  let nextC = 0, nextB = 0;
  function spawn(kind, pos, o) {
    const isConf = kind === 'confetti';
    const idx = isConf ? (nextC = (nextC + 1) % N) : (nextB = (nextB + 1) % N);
    const sp = o.speed ?? 3;
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * (o.up ?? 1), Math.random() - 0.5).normalize();
    const p = {
      kind, idx, isConf,
      pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * (o.spread ?? 0.1), (Math.random() - 0.5) * (o.spread ?? 0.1), (Math.random() - 0.5) * (o.spread ?? 0.1))),
      vel: dir.multiplyScalar(sp * (0.4 + Math.random() * 0.8)).add(o.vel || new THREE.Vector3()),
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
      life: 0, max: (o.life ?? 1) * (0.6 + Math.random() * 0.6), g: o.gravity ?? 9, drag: o.drag ?? 0.5,
      size: (o.size ?? 1) * (0.6 + Math.random() * 0.7), grow: o.grow ?? 0
    };
    const cols = o.colors || [0xffffff];
    (isConf ? conf : blob).setColorAt(idx, color.set(cols[(Math.random() * cols.length) | 0]));
    (isConf ? conf : blob).instanceColor.needsUpdate = true;
    parts.push(p);
  }
  return {
    burst(kind, pos, count, o = {}) { for (let i = 0; i < count; i++) spawn(kind, pos, o); },
    clear() { for (const p of parts) (p.isConf ? conf : blob).setMatrixAt(p.idx, zero); parts.length = 0; conf.instanceMatrix.needsUpdate = blob.instanceMatrix.needsUpdate = true; },
    update(dt) {
      if (!parts.length) return;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        const mesh = p.isConf ? conf : blob;
        if (p.life >= p.max) { mesh.setMatrixAt(p.idx, zero); parts.splice(i, 1); continue; }
        p.vel.y -= p.g * dt;
        p.vel.multiplyScalar(Math.pow(1 - Math.min(0.99, p.drag), dt));
        if (p.isConf) { p.vel.x += Math.sin(p.life * 7 + p.idx) * dt * 2; }
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.02 && p.isConf) { p.pos.y = 0.02; p.vel.set(0, 0, 0); p.spin.multiplyScalar(0.9); }
        p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
        const t = p.life / p.max;
        const s = p.size * (p.isConf ? 1 : (1 + p.grow * t) * (1 - t * t));
        dummy.position.copy(p.pos); dummy.rotation.copy(p.rot); dummy.scale.setScalar(Math.max(0.0001, s));
        dummy.updateMatrix();
        mesh.setMatrixAt(p.idx, dummy.matrix);
      }
      conf.instanceMatrix.needsUpdate = true; blob.instanceMatrix.needsUpdate = true;
    }
  };
})();
