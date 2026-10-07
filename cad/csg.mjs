// A small solid-modelling kernel for the Crow enclosure (no dependencies):
//   - hull(points): 3D convex hull -> solid (rounded boxes, cylinders, wedges are all hulls)
//   - BSP-tree booleans: union / subtract / intersect (after Evan Wallace's csg.js, MIT)
//   - toMesh(): welds vertices, repairs T-junctions, triangulates, checks the mesh is closed
//   - stlBinary(): writes a binary STL
// Units are millimetres. Z is up.

const EPS = 1e-6;

// ------------------------------------------------------------------ vectors
export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

// ------------------------------------------------------------------ BSP CSG
class Plane {
  constructor(n, w) { this.n = n; this.w = w; }
  static from(a, b, c) {
    const n = V.unit(V.cross(V.sub(b, a), V.sub(c, a)));
    return new Plane(n, V.dot(n, a));
  }
  clone() { return new Plane(this.n.slice(), this.w); }
  flip() { this.n = V.mul(this.n, -1); this.w = -this.w; }
  split(poly, cf, cb, f, b) {
    const COP = 0, FR = 1, BK = 2, SP = 3;
    let pt = 0;
    const types = poly.v.map(p => {
      const t = V.dot(this.n, p) - this.w;
      const ty = t < -1e-5 ? BK : t > 1e-5 ? FR : COP;
      pt |= ty;
      return ty;
    });
    if (pt === COP) (V.dot(this.n, poly.plane.n) > 0 ? cf : cb).push(poly);
    else if (pt === FR) f.push(poly);
    else if (pt === BK) b.push(poly);
    else {
      const fv = [], bv = [];
      const n = poly.v.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ti = types[i], tj = types[j], vi = poly.v[i], vj = poly.v[j];
        if (ti !== BK) fv.push(vi);
        if (ti !== FR) bv.push(vi);
        if ((ti | tj) === SP) {
          const t = (this.w - V.dot(this.n, vi)) / V.dot(this.n, V.sub(vj, vi));
          const v = V.lerp(vi, vj, t);
          fv.push(v); bv.push(v);
        }
      }
      // each piece gets its own plane object: flip() mutates it in place
      if (fv.length >= 3) f.push(new Poly(fv, poly.plane.clone()));
      if (bv.length >= 3) b.push(new Poly(bv, poly.plane.clone()));
    }
  }
}

class Poly {
  constructor(v, plane) { this.v = v; this.plane = plane || Plane.from(v[0], v[1], v[2]); }
  clone() { return new Poly(this.v.map(p => p.slice()), this.plane.clone()); }
  flip() { this.v.reverse(); this.plane.flip(); }
}

class Node {
  constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
  invert() {
    for (const p of this.polys) p.flip();
    this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    [this.front, this.back] = [this.back, this.front];
  }
  clip(polys) {
    if (!this.plane) return polys.slice();
    let f = [], b = [];
    for (const p of polys) this.plane.split(p, f, b, f, b);
    if (this.front) f = this.front.clip(f);
    b = this.back ? this.back.clip(b) : [];
    return f.concat(b);
  }
  clipTo(bsp) {
    this.polys = bsp.clip(this.polys);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }
  all() {
    let out = this.polys.slice();
    if (this.front) out = out.concat(this.front.all());
    if (this.back) out = out.concat(this.back.all());
    return out;
  }
  build(polys) {
    if (!polys.length) return;
    if (!this.plane) this.plane = polys[0].plane.clone();
    const f = [], b = [];
    for (const p of polys) this.plane.split(p, this.polys, this.polys, f, b);
    if (f.length) { if (!this.front) this.front = new Node(); this.front.build(f); }
    if (b.length) { if (!this.back) this.back = new Node(); this.back.build(b); }
  }
}

export class Solid {
  constructor(polys = []) { this.polys = polys; }
  clone() { return new Solid(this.polys.map(p => p.clone())); }
  union(o) {
    const a = new Node(this.clone().polys), b = new Node(o.clone().polys);
    a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all());
    return new Solid(a.all());
  }
  subtract(o) {
    const a = new Node(this.clone().polys), b = new Node(o.clone().polys);
    a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert();
    return new Solid(a.all());
  }
  intersect(o) {
    const a = new Node(this.clone().polys), b = new Node(o.clone().polys);
    a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.all()); a.invert();
    return new Solid(a.all());
  }
  map(fn) {
    return new Solid(this.polys.map(p => {
      const v = p.v.map(fn);
      return new Poly(v);
    }));
  }
  translate(t) { return this.map(p => V.add(p, t)); }
  // rotate about Z by deg, then X by degX (enough for this model)
  rotateZ(deg) { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return this.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]); }
  rotateY(deg) { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return this.map(p => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]); }
  rotateX(deg) { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return this.map(p => [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]); }
  // mirror flips winding, so reverse each polygon to keep normals outward
  mirrorX() { return new Solid(this.polys.map(p => new Poly(p.v.map(q => [-q[0], q[1], q[2]]).reverse()))); }
}

export function unionAll(list) {
  // balanced pairwise union keeps BSP trees small
  let items = list.filter(Boolean);
  while (items.length > 1) {
    const next = [];
    for (let i = 0; i < items.length; i += 2) next.push(i + 1 < items.length ? items[i].union(items[i + 1]) : items[i]);
    items = next;
  }
  return items[0] || new Solid();
}

// ------------------------------------------------------------------ convex hull
export function hull(points) {
  // dedupe
  const seen = new Map(), pts = [];
  for (const p of points) {
    const k = p.map(x => Math.round(x * 1e6)).join(',');
    if (!seen.has(k)) { seen.set(k, 1); pts.push(p); }
  }
  if (pts.length < 4) throw new Error('hull needs 4+ points');
  const scale = Math.max(...pts.flat().map(Math.abs), 1);
  const eps = 1e-9 * scale;

  // initial tetrahedron
  let i0 = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[i0][0]) i0 = i;
  let i1 = -1, best = -1;
  for (let i = 0; i < pts.length; i++) { const d = V.len(V.sub(pts[i], pts[i0])); if (d > best) { best = d; i1 = i; } }
  let i2 = -1; best = -1;
  const dir01 = V.unit(V.sub(pts[i1], pts[i0]));
  for (let i = 0; i < pts.length; i++) { const d = V.len(V.cross(V.sub(pts[i], pts[i0]), dir01)); if (d > best) { best = d; i2 = i; } }
  const n012 = V.unit(V.cross(V.sub(pts[i1], pts[i0]), V.sub(pts[i2], pts[i0])));
  let i3 = -1; best = -1;
  for (let i = 0; i < pts.length; i++) { const d = Math.abs(V.dot(V.sub(pts[i], pts[i0]), n012)); if (d > best) { best = d; i3 = i; } }
  if (best < eps) throw new Error('hull points are coplanar');

  const centroid = V.mul(V.add(V.add(pts[i0], pts[i1]), V.add(pts[i2], pts[i3])), 0.25);
  const faces = [];
  const mkFace = (a, b, c) => {
    let n = V.cross(V.sub(pts[b], pts[a]), V.sub(pts[c], pts[a]));
    let f = { a, b, c };
    if (V.dot(n, V.sub(centroid, pts[a])) > 0) { f = { a, c: b, b: c }; n = V.mul(n, -1); }
    f.n = V.unit(n); f.d = V.dot(f.n, pts[f.a]);
    return f;
  };
  faces.push(mkFace(i0, i1, i2), mkFace(i0, i1, i3), mkFace(i0, i2, i3), mkFace(i1, i2, i3));
  let live = faces.slice();

  for (let pi = 0; pi < pts.length; pi++) {
    if (pi === i0 || pi === i1 || pi === i2 || pi === i3) continue;
    const p = pts[pi];
    const visible = live.filter(f => V.dot(f.n, p) - f.d > eps);
    if (!visible.length) continue;
    const edges = new Set();
    for (const f of visible) for (const [x, y] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) edges.add(`${x},${y}`);
    const horizon = [];
    for (const e of edges) { const [x, y] = e.split(',').map(Number); if (!edges.has(`${y},${x}`)) horizon.push([x, y]); }
    const vis = new Set(visible);
    live = live.filter(f => !vis.has(f));
    for (const [x, y] of horizon) {
      const n = V.unit(V.cross(V.sub(pts[y], pts[x]), V.sub(p, pts[x])));
      live.push({ a: x, b: y, c: pi, n, d: V.dot(n, pts[x]) });
    }
  }
  return new Solid(live.map(f => new Poly([pts[f.a].slice(), pts[f.b].slice(), pts[f.c].slice()])));
}

// ------------------------------------------------------------------ primitives (all convex hulls)
const arc = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });

export function box(min, max) {
  const p = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) p.push([x, y, z]);
  return hull(p);
}

export function cylinder({ c = [0, 0, 0], r = 1, r2 = null, h = 1, axis = 'z', seg = 32 }) {
  // c = centre of the bottom face (for axis x/y: centre of the low end)
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (const [t, rr] of [[0, r], [h, r2 ?? r]]) {
      const u = rr * Math.cos(a), v = rr * Math.sin(a);
      if (axis === 'z') pts.push([c[0] + u, c[1] + v, c[2] + t]);
      else if (axis === 'y') pts.push([c[0] + u, c[1] + t, c[2] + v]);
      else pts.push([c[0] + t, c[1] + u, c[2] + v]);
    }
  }
  return hull(pts);
}

// Rounded box: plan corners radius rv, top edges radius rt, flat bottom at z0, top at z1.
export function roundedBox({ w, d, z0, z1, rv, rt, seg = 10, segT = 5 }) {
  const pts = [];
  const cx = w / 2 - rv, cy = d / 2 - rv;
  for (const [sx, sy, a0] of [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, 1.5 * Math.PI]]) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([sx * cx + rv * ca, sy * cy + rv * sa, z0]);
      for (let j = 0; j <= segT; j++) {
        const phi = (j / segT) * (Math.PI / 2);
        const rr = rv - rt + rt * Math.cos(phi);
        pts.push([sx * cx + rr * ca, sy * cy + rr * sa, z1 - rt + rt * Math.sin(phi)]);
      }
    }
  }
  return hull(pts);
}

// Convex 2D outline [[x,y]...] extruded from z0 to z1
export function prism(outline, z0, z1) {
  return hull(outline.flatMap(([x, y]) => [[x, y, z0], [x, y, z1]]));
}

export function roundedRect2D(w, h, r, seg = 8, cx = 0, cy = 0) {
  const x = w / 2 - r, y = h / 2 - r;
  return [
    ...arc(cx + x, cy + y, r, 0, Math.PI / 2, seg), ...arc(cx - x, cy + y, r, Math.PI / 2, Math.PI, seg),
    ...arc(cx - x, cy - y, r, Math.PI, 1.5 * Math.PI, seg), ...arc(cx + x, cy - y, r, 1.5 * Math.PI, 2 * Math.PI, seg),
  ];
}

// stadium (capsule outline) from (x1,y1) to (x2,y2), width wd
export function stadium2D(x1, y1, x2, y2, wd, seg = 10) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  return [...arc(x2, y2, wd / 2, a - Math.PI / 2, a + Math.PI / 2, seg), ...arc(x1, y1, wd / 2, a + Math.PI / 2, a + 1.5 * Math.PI, seg)];
}

// ------------------------------------------------------------------ mesh output
export function toMesh(solid) {
  // 1. weld (tolerance-based, so points straddling a rounding boundary still merge)
  const WELD = 1e-4, WC = 1e-3;
  const wgrid = new Map(), verts = [];
  const vid = (p) => {
    const gx = Math.floor(p[0] / WC), gy = Math.floor(p[1] / WC), gz = Math.floor(p[2] / WC);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = wgrid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (list) for (const i of list) { const q = verts[i]; if (Math.abs(q[0] - p[0]) < WELD && Math.abs(q[1] - p[1]) < WELD && Math.abs(q[2] - p[2]) < WELD) return i; }
    }
    const i = verts.length; verts.push(p);
    const k = `${gx},${gy},${gz}`;
    if (!wgrid.has(k)) wgrid.set(k, []);
    wgrid.get(k).push(i);
    return i;
  };
  let polys = solid.polys.map(p => {
    const ids = [];
    for (const v of p.v) { const i = vid(v); if (ids[ids.length - 1] !== i) ids.push(i); }
    if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    return ids;
  }).filter(ids => ids.length >= 3);

  // 2. T-junctions: insert any vertex that lies on another polygon's edge
  const cell = 2.0, grid = new Map();
  const ck = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  verts.forEach((p, i) => { const k = ck(...p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  let inserted = 0;
  polys = polys.map(ids => {
    const out = [];
    let changed = false;
    for (let e = 0; e < ids.length; e++) {
      const ia = ids[e], ib = ids[(e + 1) % ids.length];
      out.push(ia);
      const a = verts[ia], b = verts[ib], ab = V.sub(b, a), L = V.len(ab);
      if (L < 1e-9) continue;
      const u = V.mul(ab, 1 / L);
      const lo = a.map((x, k) => Math.min(x, b[k])), hi = a.map((x, k) => Math.max(x, b[k]));
      const hits = [];
      for (let gx = Math.floor((lo[0] - 1e-4) / cell); gx <= Math.floor((hi[0] + 1e-4) / cell); gx++)
        for (let gy = Math.floor((lo[1] - 1e-4) / cell); gy <= Math.floor((hi[1] + 1e-4) / cell); gy++)
          for (let gz = Math.floor((lo[2] - 1e-4) / cell); gz <= Math.floor((hi[2] + 1e-4) / cell); gz++) {
            const list = grid.get(`${gx},${gy},${gz}`);
            if (!list) continue;
            for (const iv of list) {
              if (iv === ia || iv === ib) continue;
              const ap = V.sub(verts[iv], a), t = V.dot(ap, u);
              if (t <= 1e-4 || t >= L - 1e-4) continue;
              if (V.len(V.sub(ap, V.mul(u, t))) < 2e-4) hits.push([t, iv]);
            }
          }
      if (hits.length) { hits.sort((x, y) => x[0] - y[0]); for (const [, iv] of hits) out.push(iv); changed = true; inserted += hits.length; }
    }
    return { ids: out, changed };
  });

  // 3. triangulate: plain fan for untouched convex polygons, centre fan when points were inserted
  const tris = [];
  const collinear = (ids) => ids.some((id, i) => {
    const a = verts[ids[(i + ids.length - 1) % ids.length]], b = verts[id], c = verts[ids[(i + 1) % ids.length]];
    return V.len(V.cross(V.sub(b, a), V.sub(c, b))) < 1e-7 * (V.len(V.sub(b, a)) + V.len(V.sub(c, b)) + 1e-12);
  });
  for (const { ids, changed } of polys) {
    if (ids.length === 3 || (!changed && !collinear(ids))) { for (let i = 1; i < ids.length - 1; i++) tris.push([ids[0], ids[i], ids[i + 1]]); continue; }
    const c = V.mul(ids.reduce((s, i) => V.add(s, verts[i]), [0, 0, 0]), 1 / ids.length);
    const ci = verts.length; verts.push(c);
    for (let i = 0; i < ids.length; i++) tris.push([ids[i], ids[(i + 1) % ids.length], ci]);
  }

  // 4. drop zero-area triangles, then check closedness
  const area2 = (t) => V.len(V.cross(V.sub(verts[t[1]], verts[t[0]]), V.sub(verts[t[2]], verts[t[0]])));
  const good = tris.filter(t => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2] && area2(t) > 1e-10);
  const edgeUse = new Map();
  for (const t of good) for (let k = 0; k < 3; k++) { const e = `${t[k]},${t[(k + 1) % 3]}`; edgeUse.set(e, (edgeUse.get(e) || 0) + 1); }
  let open = 0, dup = 0;
  const openSamples = [];
  for (const [e, n] of edgeUse) {
    const [a, b] = e.split(',');
    if (!edgeUse.has(`${b},${a}`)) { open++; if (openSamples.length < 6) openSamples.push([verts[+a].map(x => +x.toFixed(4)), verts[+b].map(x => +x.toFixed(4))]); }
    if (n > 1) dup++;
  }
  let vol = 0;
  for (const t of good) vol += V.dot(verts[t[0]], V.cross(verts[t[1]], verts[t[2]])) / 6;
  return { verts, tris: good, report: { triangles: good.length, openEdges: open, duplicateEdges: dup, tJunctionsFixed: inserted, volumeMm3: vol, openSamples } };
}

export function stlBinary(mesh, name = 'crow') {
  const { verts, tris } = mesh;
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(name.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
    const n = V.unit(V.cross(V.sub(b, a), V.sub(c, a)));
    for (const v of [n, a, b, c]) { buf.writeFloatLE(v[0], o); buf.writeFloatLE(v[1], o + 4); buf.writeFloatLE(v[2], o + 8); o += 12; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

export function bounds(solid) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of solid.polys) for (const v of p.v) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  return { lo, hi };
}

// ------------------------------------------------------------------ clean extrusions for flat parts
// Slice a vertical-walled solid at mid-height to get its exact 2D outline, then rebuild it as a
// prism from that outline (walls + ear-clipped caps). Closed and manifold by construction, so flat
// parts made from many overlapping shapes don't inherit coplanar-cap seams from the booleans.
function area2D(loop) { let a = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

function earClip(loop) {
  const idx = loop.map((_, i) => i), tris = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = loop[ia], b = loop[ib], c = loop[ic];
      if (cross(a, b, c) <= 1e-12) continue;   // reflex or flat
      let ok = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inTri(loop[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

export function outlineExtrude(solid, z0, z1) {
  const zm = (z0 + z1) / 2, segs = [];
  for (const p of solid.polys) {
    if (Math.abs(p.plane.n[2]) > 0.5) continue;
    const hits = [];
    for (let i = 0; i < p.v.length; i++) {
      const a = p.v[i], b = p.v[(i + 1) % p.v.length];
      if ((a[2] - zm) * (b[2] - zm) < 0) { const t = (zm - a[2]) / (b[2] - a[2]); hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (hits.length !== 2) continue;
    const tx = -p.plane.n[1], ty = p.plane.n[0];
    const [h0, h1] = hits;
    segs.push((h1[0] - h0[0]) * tx + (h1[1] - h0[1]) * ty >= 0 ? [h0, h1] : [h1, h0]);
  }
  // chain segments into loops
  const k = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const from = new Map();
  for (const s of segs) from.set(k(s[0]), s);
  const used = new Set(), loops = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    const loop = [];
    let cur = s, guard = 0;
    while (cur && !used.has(cur) && guard++ < 100000) { used.add(cur); loop.push(cur[0]); cur = from.get(k(cur[1])); }
    // drop collinear points
    const clean = loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], c = loop[(i + 1) % loop.length];
      return Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) > 1e-9;
    });
    if (clean.length >= 3) loops.push(clean);
  }
  const outer = loops.filter(l => area2D(l) > 0);
  if (loops.length !== outer.length) throw new Error('outlineExtrude: holes are not supported');
  const polys = [];
  for (const loop of outer) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      polys.push(new Poly([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]));
    }
    for (const [a, b, c] of earClip(loop)) {
      polys.push(new Poly([[loop[a][0], loop[a][1], z1], [loop[b][0], loop[b][1], z1], [loop[c][0], loop[c][1], z1]]));
      polys.push(new Poly([[loop[c][0], loop[c][1], z0], [loop[b][0], loop[b][1], z0], [loop[a][0], loop[a][1], z0]]));
    }
  }
  return new Solid(polys);
}
