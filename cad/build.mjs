// Crow enclosure: parametric model -> STL files + fit check.
//   node --stack-size=65500 cad/build.mjs
// Outputs:
//   cad/stl/*.stl          print-ready (each part placed the way it should sit on the bed)
//   web/models/*.json      assembly orientation, for the 3D viewer (indexed mesh, base64)
//   web/models/assembly.json  parts, colours, explode offsets, electronics boxes
// The same parameters drive cad/crow.scad (OpenSCAD version for editing).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hull, box, cylinder, roundedBox, prism, roundedRect2D, stadium2D, unionAll, outlineExtrude, toMesh, stlBinary, bounds } from './csg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  W: 96, D: 70, H: 78,          // outside of the shell (mm)
  RV: 14, RT: 5,                // plan corner radius, top edge radius
  T: 2.4,                       // wall
  FLOOR: 3,                     // floor plate thickness
  FIT: 0.3,                     // clearance between floor plate and shell
  WIN_W: 25, WIN_H: 14, WIN_Z: 56, WIN_R: 1.5,   // OLED window (0.96" SSD1306 active area is 21.7 x 10.9)
  OLED_PCB: 28.4, OLED_POCKET_DEPTH: 4, OLED_OFFSET_Z: 0,
  LED_Z: 36, LED_D: 5.2,
  GRILL_Z: 20, GRILL_R: 10, GRILL_HOLE: 2.0, GRILL_PITCH: 3.6,
  BUZZER_D: 12.4, BUZZER_CUP: 5,
  PERCH_D: 16.2, PERCH_Y: 6,    // 16 mm panel-mount momentary button
  TUFT_X: -26, TUFT_Y: -14, TUFT_SLOT: [12, 3.2],
  PIN_Y: 0, PIN_Z: 56, PIN_D: 2.2,     // SOS pinhole on the right side
  BOARD_X: -20, BOARD_W: 25.4, BOARD_L: 57, USB_Z: 8,   // LOLIN D32 class board, USB to the back
  USB_W: 13, USB_H: 9,
  BATT: [34, 50, 10], BATT_X: 17,      // 103450 LiPo, centre x
  POST_D: 8, POST_HOLE: 2.6, POST_TOP: 15, CSK_D: 5.6,   // M3 countersunk self-tappers
};
const { W, D, H, RV, RT, T } = P;
const IN = { w: W - 2 * T, d: D - 2 * T, rv: RV - T, rt: RT - T };
const FRONT = -D / 2, BACK = D / 2, RIGHT = W / 2;
const FIN = FRONT + T, BIN = BACK - T, RIN = RIGHT - T, LIN = -RIGHT + T;   // inner wall planes

// screw posts sit in the four plan corners, overlapping the wall a little
const postOff = (IN.rv - P.POST_D / 2 + 0.4) / Math.SQRT2;
const POSTS = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sy]) => [sx * (W / 2 - RV + postOff), sy * (D / 2 - RV + postOff)]);

// ------------------------------------------------------------------ shell
function shell() {
  const t0 = Date.now();
  const outer = roundedBox({ w: W, d: D, z0: 0, z1: H, rv: RV, rt: RT });
  const inner = roundedBox({ w: IN.w, d: IN.d, z0: -1, z1: H - T, rv: IN.rv, rt: IN.rt });
  let s = outer.subtract(inner);

  // --- things added inside
  const adds = [];
  for (const [x, y] of POSTS) {
    adds.push(cylinder({ c: [x, y, P.FLOOR], r: P.POST_D / 2, h: P.POST_TOP - P.FLOOR, seg: 24 }));
    // 45 degree cone above each post so it prints upside down without supports
    const k = 3.6 / Math.SQRT2;
    const cx = x + Math.sign(x) * k, cy = y + Math.sign(y) * k;
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push([x + (P.POST_D / 2) * Math.cos(a), y + (P.POST_D / 2) * Math.sin(a), P.POST_TOP]);
      pts.push([cx + 0.3 * Math.cos(a), cy + 0.3 * Math.sin(a), P.POST_TOP + P.POST_D + 0.2]);
    }
    adds.push(hull(pts));
  }
  // OLED pocket: a frame the module drops into from behind (top left open for the header + wires)
  const oz = P.WIN_Z + P.OLED_OFFSET_Z, half = P.OLED_PCB / 2, wall = 1.6, y0 = FIN - 0.4, y1 = FIN + P.OLED_POCKET_DEPTH;
  adds.push(box([-half - wall, y0, oz - half - wall], [half + wall, y1, oz - half]));           // bottom bar
  adds.push(box([-half - wall, y0, oz - half - wall], [-half, y1, oz + half - 4]));             // left
  adds.push(box([half, y0, oz - half - wall], [half + wall, y1, oz + half - 4]));               // right
  // buzzer cup behind the grill
  const cup = cylinder({ c: [0, FIN - 0.4, P.GRILL_Z], r: P.BUZZER_D / 2 + 1.4, h: P.BUZZER_CUP + 0.4, axis: 'y', seg: 32 })
    .subtract(cylinder({ c: [0, FIN - 1, P.GRILL_Z], r: P.BUZZER_D / 2, h: P.BUZZER_CUP + 2, axis: 'y', seg: 32 }));
  adds.push(cup);
  // SOS switch boss on the right wall: holds a 6x6 mm tact switch facing the pinhole
  adds.push(box([RIN - 5, P.PIN_Y - 5, P.PIN_Z - 5], [RIN + 0.4, P.PIN_Y + 5, P.PIN_Z + 5])
    .subtract(box([RIN - 6, P.PIN_Y - 3.2, P.PIN_Z - 3.2], [RIN + 0.01, P.PIN_Y + 3.2, P.PIN_Z + 3.2])));
  // RTC ledge on the left wall (DS3231 board stands on it, coin cell toward the wall)
  adds.push(box([LIN - 0.4, -19, 21], [LIN + 4, 19, 23]));
  s = s.union(unionAll(adds));

  // --- holes
  const cuts = [];
  cuts.push(prism(roundedRect2D(P.WIN_W, P.WIN_H, P.WIN_R), 0, T + 2).rotateX(90).translate([0, FRONT + T + 1, P.WIN_Z]));
  cuts.push(cylinder({ c: [0, FRONT - 1, P.LED_Z], r: P.LED_D / 2, h: T + 2, axis: 'y', seg: 24 }));
  for (let row = -4; row <= 4; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = (col + (row % 2 ? 0.5 : 0)) * P.GRILL_PITCH, z = row * P.GRILL_PITCH * 0.866;
      const r = Math.hypot(x, z);
      if (r > P.GRILL_R) continue;
      if (r + P.GRILL_HOLE / 2 > P.BUZZER_D / 2 - 0.2 && r - P.GRILL_HOLE / 2 < P.BUZZER_D / 2 + 1.6) continue;  // keep clear of the cup wall
      cuts.push(cylinder({ c: [x, FRONT - 1, P.GRILL_Z + z], r: P.GRILL_HOLE / 2, h: T + 2, axis: 'y', seg: 12 }));
    }
  }
  cuts.push(cylinder({ c: [0, P.PERCH_Y, H - T - 1], r: P.PERCH_D / 2, h: T + 2, seg: 40 }));
  cuts.push(box([P.TUFT_X - P.TUFT_SLOT[0] / 2, P.TUFT_Y - P.TUFT_SLOT[1] / 2, H - T - 1], [P.TUFT_X + P.TUFT_SLOT[0] / 2, P.TUFT_Y + P.TUFT_SLOT[1] / 2, H + 1]));
  cuts.push(cylinder({ c: [RIN - 1, P.PIN_Y, P.PIN_Z], r: P.PIN_D / 2, h: T + 2, axis: 'x', seg: 16 }));
  cuts.push(prism(stadium2D(-(P.USB_W - P.USB_H) / 2, 0, (P.USB_W - P.USB_H) / 2, 0, P.USB_H), 0, T + 2).rotateX(90).translate([P.BOARD_X, BACK + 1, P.USB_Z]));
  for (const x of [8, 18, 28]) cuts.push(prism(stadium2D(0, -8, 0, 8, 2.4), 0, T + 2).rotateX(90).translate([x, BACK + 1, 48]));
  for (const [x, y] of POSTS) cuts.push(cylinder({ c: [x, y, P.FLOOR - 0.1], r: P.POST_HOLE / 2, h: 10, seg: 16 }));
  s = s.subtract(unionAll(cuts));
  console.log(`  shell built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return s;
}

// ------------------------------------------------------------------ floor plate
function floor() {
  const c = P.FIT;
  let f = prism(roundedRect2D(IN.w - 2 * c, IN.d - 2 * c, IN.rv - c, 10), 0, P.FLOOR);
  const adds = [];
  // board cradle: two rails with a 2 mm ledge, plus a front stop
  const bx = P.BOARD_X, hw = P.BOARD_W / 2 + 0.3, yb = BIN - 1.5, yf = yb - P.BOARD_L;
  for (const s of [-1, 1]) {
    const e = bx + s * hw;
    adds.push(box([Math.min(e, e + s * 1.6), yf + 2, P.FLOOR - 0.1], [Math.max(e, e + s * 1.6), yb - 1, P.FLOOR + 6]));
    adds.push(box([Math.min(e, e - s * 2), yf + 2, P.FLOOR - 0.1], [Math.max(e, e - s * 2), yb - 1, P.FLOOR + 2]));
  }
  adds.push(box([bx - 6, yf - 1.6, P.FLOOR - 0.1], [bx + 6, yf, P.FLOOR + 5]));
  // battery corral
  const [bw, bl] = P.BATT;
  for (const s of [-1, 1]) {
    const e = P.BATT_X + s * (bw / 2 + 0.5);
    adds.push(box([Math.min(e, e + s * 1.6), -bl / 2 + 5, P.FLOOR - 0.1], [Math.max(e, e + s * 1.6), bl / 2 - 5, P.FLOOR + 5]));
  }
  f = f.union(unionAll(adds));
  // countersunk M3 holes under each post
  const cuts = [];
  for (const [x, y] of POSTS) {
    cuts.push(cylinder({ c: [x, y, -1], r: 1.7, h: P.FLOOR + 2, seg: 20 }));
    cuts.push(cylinder({ c: [x, y, -0.01], r: P.CSK_D / 2, r2: 1.7, h: (P.CSK_D / 2 - 1.7) + 0.01, seg: 20 }));
  }
  // cable notch so the battery lead can reach the board
  cuts.push(box([-4.5, -6, P.FLOOR - 0.5], [-0.5, 6, P.FLOOR + 6]));
  return f.subtract(unionAll(cuts));
}

// ------------------------------------------------------------------ crow feet (glue under the front of the floor)
function foot() {
  // toes point forward (-y); the spur points back
  const toes = [[-28, 15], [0, 17], [28, 15]].map(([deg, len]) => {
    const a = (-90 + deg) * Math.PI / 180;
    return prism(stadium2D(0, 0, Math.cos(a) * len, Math.sin(a) * len, 4.6, 8), 0, 3);
  });
  const heel = cylinder({ c: [0, 1.3, 0], r: 5.6, h: 3, seg: 30 });
  const spur = prism(stadium2D(0, 0, 0, 9, 4, 8), 0, 3);
  return outlineExtrude(unionAll([...toes, heel, spur]), 0, 3);
}

// ------------------------------------------------------------------ tuft (slots into the top)
function tuft() {
  // modelled lying flat (X across, Y up the feathers, Z thickness): print it like this
  const th = 3;
  const feathers = [[-24, 14, 4.6], [0, 17, 5], [22, 11, 4.4]].map(([deg, len, wd]) => {
    const a = (90 + deg) * Math.PI / 180;
    return prism(stadium2D(0, 0, Math.cos(a) * len, Math.sin(a) * len, wd, 10), 0, th);
  });
  const base = prism(stadium2D(-5, 0, 5, 0, 5, 8), 0, th);
  const tab = box([-(P.TUFT_SLOT[0] - 0.4) / 2, -4.5, 0], [(P.TUFT_SLOT[0] - 0.4) / 2, 0.5, th]);   // 3 mm tab in a 3.2 mm slot
  return outlineExtrude(unionAll([...feathers, base, tab]), 0, th);
}

// ------------------------------------------------------------------ electronics (for the fit check + viewer)
const B = (name, min, max, color) => ({ name, min, max, color });
const COMPONENTS = [
  B('OLED module', [-13.7, FIN + 0.2, P.WIN_Z - 13.9], [13.7, FIN + 2.8, P.WIN_Z + 13.9], '#2a6cf0'),
  B('OLED header + jumpers', [-6, FIN + 2.8, P.WIN_Z + 9], [6, FIN + 16, P.WIN_Z + 14], '#7b8494'),
  B('ESP32 board', [P.BOARD_X - 12.7, BIN - 1.5 - P.BOARD_L, P.FLOOR + 2], [P.BOARD_X + 12.7, BIN - 1.5, P.FLOOR + 2 + 1.6 + 3.2], '#1f8a5b'),
  B('LiPo 2000 mAh', [P.BATT_X - 17, -25, P.FLOOR], [P.BATT_X + 17, 25, P.FLOOR + 10], '#c9ced8'),
  B('DS3231 RTC', [LIN + 0.6, -19, 23.2], [LIN + 14.6, 19, 45.2], '#8a3fd1'),
  B('Buzzer', [-6, FIN + 0.3, P.GRILL_Z - 6], [6, FIN + 9.8, P.GRILL_Z + 6], '#d94a3a'),
  B('Perch button body', [-10, P.PERCH_Y - 10, H - T - 26], [10, P.PERCH_Y + 10, H - T], '#d6a440'),
  B('SOS tact switch', [RIN - 5, P.PIN_Y - 3, P.PIN_Z - 3], [RIN, P.PIN_Y + 3, P.PIN_Z + 3], '#e0e0e0'),
  B('Rage LED', [-2.6, FIN, P.LED_Z - 2.6], [2.6, FIN + 9, P.LED_Z + 2.6], '#ff3b2a'),
];
// solid features the electronics must not hit
const FEATURES = [
  ...POSTS.map(([x, y], i) => B(`post ${i + 1}`, [x - P.POST_D / 2, y - P.POST_D / 2, P.FLOOR], [x + P.POST_D / 2, y + P.POST_D / 2, P.POST_TOP + P.POST_D], '')),
  B('board rails', [P.BOARD_X - 14.6, BIN - 1.5 - P.BOARD_L + 2, P.FLOOR], [P.BOARD_X - 12.7, BIN - 2.5, P.FLOOR + 6], ''),
  B('board rails R', [P.BOARD_X + 12.7, BIN - 1.5 - P.BOARD_L + 2, P.FLOOR], [P.BOARD_X + 14.6, BIN - 2.5, P.FLOOR + 6], ''),
  B('battery corral L', [P.BATT_X - 17 - 2.1, -20, P.FLOOR], [P.BATT_X - 17 - 0.5, 20, P.FLOOR + 5], ''),
  B('battery corral R', [P.BATT_X + 17 + 0.5, -20, P.FLOOR], [P.BATT_X + 17 + 2.1, 20, P.FLOOR + 5], ''),
  B('SOS boss', [RIN - 5, P.PIN_Y - 5, P.PIN_Z - 5], [RIN, P.PIN_Y + 5, P.PIN_Z + 5], ''),
];

function insideCavity(p) {
  // inside the inner rounded box (plan corners + top edge), above the floor
  const ax = Math.abs(p[0]), ay = Math.abs(p[1]);
  const cx = IN.w / 2 - IN.rv, cy = IN.d / 2 - IN.rv;
  if (p[2] < P.FLOOR - 1e-6 || p[2] > H - T + 1e-6) return false;
  const dx = Math.max(0, ax - cx), dy = Math.max(0, ay - cy);
  let rPlan = IN.rv;
  const zTop = H - T - IN.rt;
  if (p[2] > zTop) rPlan = IN.rv - IN.rt + Math.sqrt(Math.max(0, IN.rt ** 2 - (p[2] - zTop) ** 2));
  if (ax > IN.w / 2 + 1e-6 || ay > IN.d / 2 + 1e-6) return false;
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy) <= rPlan + 1e-6;
  // flat faces near the top edge
  if (p[2] > zTop) {
    const shrink = IN.rv - rPlan;
    return ax <= IN.w / 2 - shrink + 1e-6 && ay <= IN.d / 2 - shrink + 1e-6;
  }
  return true;
}
const overlap = (a, b) => [0, 1, 2].every(k => a.min[k] < b.max[k] - 0.05 && b.min[k] < a.max[k] - 0.05);

function fitCheck() {
  const problems = [];
  for (const c of COMPONENTS) {
    for (const x of [c.min[0], c.max[0]]) for (const y of [c.min[1], c.max[1]]) for (const z of [c.min[2], c.max[2]]) {
      if (!insideCavity([x, y, z])) { problems.push(`${c.name} pokes out of the shell at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`); break; }
    }
  }
  for (let i = 0; i < COMPONENTS.length; i++) {
    for (let j = i + 1; j < COMPONENTS.length; j++) if (overlap(COMPONENTS[i], COMPONENTS[j])) problems.push(`${COMPONENTS[i].name} overlaps ${COMPONENTS[j].name}`);
    for (const f of FEATURES) {
      if (COMPONENTS[i].name === 'SOS tact switch' && f.name === 'SOS boss') continue;   // it sits in it
      if (overlap(COMPONENTS[i], f)) problems.push(`${COMPONENTS[i].name} hits ${f.name}`);
    }
  }
  return [...new Set(problems)];
}

// ------------------------------------------------------------------ build
// Viewer meshes: indexed, base64 Float32 positions + Uint32 indices (smaller than STL, and a type the web host serves)
function meshJson(verts, tris) {
  const v = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => { v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2]; });
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => { idx[i * 3] = t[0]; idx[i * 3 + 1] = t[1]; idx[i * 3 + 2] = t[2]; });
  return JSON.stringify({ v: Buffer.from(v.buffer).toString('base64'), i: Buffer.from(idx.buffer).toString('base64') });
}
const PETG = 1.27; // g/cm3
mkdirSync(join(ROOT, 'cad/stl'), { recursive: true });
mkdirSync(join(ROOT, 'web/models'), { recursive: true });

const problems = fitCheck();
console.log(problems.length ? `Fit check: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}` : 'Fit check: every part fits, nothing collides.');

const parts = [
  { id: 'shell', name: 'Shell', make: shell, color: '#24262f', print: (p) => [p[0], -p[1], H - p[2]], explode: [0, 0, 0], qty: 1, note: 'Print upside down (as exported): top on the bed. PETG, 0.2 mm layers, 3 walls, 20% infill. No supports needed.' },
  { id: 'floor', name: 'Floor plate', make: floor, color: '#3a3d48', print: (p) => p, explode: [0, 0, -38], qty: 1, note: 'Print flat, ribs up.' },
  { id: 'foot', name: 'Crow foot', make: foot, color: '#ffad3b', print: (p) => p, explode: [0, 0, -60], qty: 2, place: [[-20, FRONT + 9, -3], [20, FRONT + 9, -3]], note: 'Print 2 in orange. Glue under the front of the floor so the toes peek out.' },
  { id: 'tuft', name: 'Tuft', make: tuft, color: '#24262f', print: (p) => p, explode: [0, 0, 30], qty: 1, assemble: (p) => [p[0] + P.TUFT_X, P.TUFT_Y + 1.5 - p[2], H + p[1]], note: 'Print flat. The tab glues into the slot on top.' },
];

const assembly = { units: 'mm', params: P, parts: [], components: COMPONENTS, fit: problems };
let grams = 0;
for (const part of parts) {
  const solid = part.make();
  const mesh = toMesh(solid);
  const r = mesh.report;
  const g = (Math.abs(r.volumeMm3) / 1000) * PETG * part.qty;
  grams += g;
  console.log(`${part.name}: ${r.triangles} triangles, ${r.openEdges} open edges, ${r.duplicateEdges} non-manifold edges, ${r.tJunctionsFixed} T-junctions repaired, ${(Math.abs(r.volumeMm3) / 1000).toFixed(1)} cm3, ~${g.toFixed(0)} g PETG${part.qty > 1 ? ` (x${part.qty})` : ''}`);
  const b = bounds(solid);
  // print-ready copy
  const printMesh = { verts: mesh.verts.map(part.print), tris: mesh.tris };
  writeFileSync(join(ROOT, `cad/stl/crow-${part.id}.stl`), stlBinary(printMesh, `crow ${part.id}`));
  // assembly copy for the viewer
  const asm = part.assemble ? mesh.verts.map(part.assemble) : mesh.verts;
  if (part.place) {
    for (const [k, off] of part.place.entries()) {
      const id = `${part.id}-${k + 1}`;
      writeFileSync(join(ROOT, `web/models/${id}.json`), meshJson(asm.map(p => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]), mesh.tris));
      assembly.parts.push({ id, name: part.name, file: `models/${id}.json`, color: part.color, explode: part.explode });
    }
  } else {
    writeFileSync(join(ROOT, `web/models/${part.id}.json`), meshJson(asm, mesh.tris));
    assembly.parts.push({ id: part.id, name: part.name, file: `models/${part.id}.json`, color: part.color, explode: part.explode });
  }
  part.report = { ...r, bounds: b, grams: g };
}
assembly.filamentGrams = Math.round(grams);
writeFileSync(join(ROOT, 'web/models/assembly.json'), JSON.stringify(assembly, null, 1));
writeFileSync(join(ROOT, 'cad/stl/README.txt'), [
  'Crow enclosure, print-ready STL files (mm). Generated by cad/build.mjs.', '',
  ...parts.map(p => `crow-${p.id}.stl  x${p.qty}  ${p.note}`), '',
  `Total filament: about ${Math.round(grams)} g of PETG (solid volume; your slicer's estimate will be lower with infill).`,
  'Hardware: 4x M3x8 countersunk self-tapping screws (or M3 screws + heat-set inserts: drill posts to 4 mm), 2 stick-on rubber bumpers (3 mm) under the back.',
].join('\n'));
console.log(`Filament total: ~${Math.round(grams)} g`);
if (parts.some(p => p.report.openEdges)) { console.log('WARNING: some meshes are not closed.'); process.exitCode = 1; }
if (problems.length) process.exitCode = 1;
