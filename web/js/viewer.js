// 3D viewer for the Crow enclosure (three.js r128 from cdnjs). Loads the STL parts and the
// electronics boxes written by cad/build.mjs. The model's screen shows the simulator's live OLED.

const host = document.getElementById('viewer');
const canvas = document.getElementById('viewerCanvas');
const msg = document.getElementById('viewerMsg');
const explodeInput = document.getElementById('explode');
const gutsInput = document.getElementById('showGuts');

function b64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// meshes come from cad/build.mjs as indexed base64 arrays; split into flat-shaded triangles
function parseMesh({ v, i }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b64(v)), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(b64(i)), 1));
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

const FLOOR_MOUNTED = new Set(['ESP32 board', 'LiPo 2000 mAh']);
const LABELS = { 'OLED module': 'OLED face', 'ESP32 board': 'ESP32', 'LiPo 2000 mAh': 'LiPo', 'DS3231 RTC': 'Clock chip', 'Buzzer': 'Buzzer', 'Perch button body': 'Perch', 'SOS tact switch': 'SOS switch' };

async function main() {
  if (!window.THREE) { msg.textContent = 'The 3D viewer needs three.js from cdnjs, which did not load. The printable STL files are in Crow/cad/stl.'; return; }
  const asm = await (await fetch('models/assembly.json')).json();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const col = (hex) => new THREE.Color(hex).convertSRGBToLinear();   // r128 has no automatic color management
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 5, 3000);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1c26, 0.7));
  const key = new THREE.DirectionalLight(0xfff1dc, 1.6); key.position.set(160, 260, 220); scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 0.7); rim.position.set(-220, 120, -200); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(-100, -60, 200); scene.add(fill);

  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;   // the CAD is Z-up
  scene.add(world);
  const groups = { shell: new THREE.Group(), floor: new THREE.Group() };
  world.add(groups.shell, groups.floor);

  const meshes = [];
  await Promise.all(asm.parts.map(async (p) => {
    const data = await (await fetch(p.file)).json();
    const color = p.id === 'shell' || p.id === 'tuft' ? '#3b3e4c' : p.color;
    const mat = new THREE.MeshStandardMaterial({ color: col(color), roughness: 0.62, metalness: 0.05 });
    const mesh = new THREE.Mesh(parseMesh(data), mat);
    mesh.userData = { explode: p.id === 'floor' ? [0, 0, 0] : p.explode };   // the floor group moves the floor
    (p.id === 'floor' ? groups.floor : world).add(mesh);
    meshes.push(mesh);
  }));

  // brass perch button cap + rubber bumpers, for looks
  const P = asm.params;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 5, 40), new THREE.MeshStandardMaterial({ color: col('#d9ad55'), metalness: 0.7, roughness: 0.3 }));
  cap.rotation.x = Math.PI / 2; cap.position.set(0, P.PERCH_Y, P.H + 2.5);
  cap.userData = { explode: [0, 0, 14] };
  world.add(cap); meshes.push(cap);

  // electronics
  const guts = [];
  const labelLayer = document.createElement('div');
  labelLayer.className = 'viewer-labels';
  labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  host.appendChild(labelLayer);
  for (const c of asm.components) {
    const size = [0, 1, 2].map(k => c.max[k] - c.min[k]);
    const center = [0, 1, 2].map(k => (c.max[k] + c.min[k]) / 2);
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color: col(c.color), roughness: 0.5, transparent: true, opacity: 0.88 }));
    m.position.set(...center);
    (FLOOR_MOUNTED.has(c.name) ? groups.floor : groups.shell).add(m);
    guts.push(m);
    if (LABELS[c.name]) {
      const el = document.createElement('span');
      el.textContent = LABELS[c.name];
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);font:600 11px/1 "Atkinson Hyperlegible",system-ui,sans-serif;color:#fff;background:rgba(10,12,22,.75);padding:3px 6px;border-radius:6px;white-space:nowrap;';
      labelLayer.appendChild(el);
      m.userData.label = el;
    }
  }

  // the live face: the simulator's OLED canvas as a texture behind the window
  const oled = document.getElementById('oled');
  let screenTex = null;
  if (oled) {
    screenTex = new THREE.CanvasTexture(oled);
    screenTex.magFilter = THREE.NearestFilter;
    screenTex.minFilter = THREE.LinearFilter;
    screenTex.encoding = THREE.sRGBEncoding;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(P.WIN_W - 1, (P.WIN_W - 1) / 2), new THREE.MeshBasicMaterial({ map: screenTex }));
    screen.rotation.x = Math.PI / 2;
    screen.position.set(0, -P.D / 2 + P.T + 0.15, P.WIN_Z);
    groups.shell.add(screen);
  }

  // ground shadow
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(66, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
  shadow.position.set(0, 0, -3.2);
  world.add(shadow);

  // orbit
  let theta = 0.55, phi = 0.32, dist = 330, auto = true;
  const target = new THREE.Vector3(0, 34, 0);
  function placeCamera(ex = 0) {
    const d = dist * (1 + 0.5 * ex);   // back off when the parts spread out
    target.y = 34 - 8 * ex;
    camera.position.set(target.x + d * Math.sin(theta) * Math.cos(phi), target.y + d * Math.sin(phi), target.z + d * Math.cos(theta) * Math.cos(phi));
    camera.lookAt(target);
  }
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; auto = false; try { canvas.setPointerCapture(e.pointerId); } catch { /* fine without capture */ } });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    theta -= (e.clientX - drag.x) * 0.008;
    if (e.pointerType === 'mouse') phi = Math.max(-0.2, Math.min(1.35, phi + (e.clientY - drag.y) * 0.006));
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;   // plain scrolling keeps scrolling the page
    e.preventDefault();
    dist = Math.max(170, Math.min(620, dist * (1 + Math.sign(e.deltaY) * 0.08)));
  }, { passive: false });
  canvas.style.touchAction = 'pan-y';

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) requestAnimationFrame(frame); }).observe(host);

  let lastTex = 0;
  const v = new THREE.Vector3();
  function frame(t) {
    if (!visible) return;
    if (auto) theta += 0.0035;
    const ex = Number(explodeInput.value) / 100;
    for (const m of meshes) { const e = m.userData.explode || [0, 0, 0]; m.position.set(e[0] * ex, e[1] * ex, e[2] * ex); }
    groups.floor.position.set(0, 0, -38 * ex);
    groups.shell.position.set(0, 0, 0);
    const showGuts = gutsInput.checked;
    for (const g of guts) {
      g.visible = showGuts;
      const el = g.userData.label;
      if (el) {
        el.hidden = !showGuts || ex < 0.35;
        if (!el.hidden) {
          g.getWorldPosition(v); v.project(camera);
          el.style.left = `${(v.x * 0.5 + 0.5) * host.clientWidth}px`;
          el.style.top = `${(-v.y * 0.5 + 0.5) * host.clientHeight}px`;
        }
      }
    }
    // see through the shell a little when it's exploded and the guts are on
    const shellMesh = meshes.find(m => m.geometry.attributes.position.count > 50000);
    if (shellMesh) { shellMesh.material.transparent = showGuts && ex > 0.05; shellMesh.material.opacity = showGuts && ex > 0.05 ? 0.35 : 1; shellMesh.material.depthWrite = !(showGuts && ex > 0.05); }
    if (screenTex && t - lastTex > 100) { screenTex.needsUpdate = true; lastTex = t; }
    placeCamera(ex);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  msg.textContent = `${asm.parts.length} printed parts · about ${asm.filamentGrams} g of PETG · drag to turn${matchMedia('(pointer: fine)').matches ? ', ctrl + scroll to zoom' : ''}`;
  requestAnimationFrame(frame);
}

main().catch((e) => { msg.textContent = `Couldn't load the 3D model (${e.message}). The printable STL files are in Crow/cad/stl.`; });
