import * as THREE from 'three';
import { meshField } from './surface-nets.js';

// S-expression AST → Three.js geometry
// Consumes the structured AST from codegen.js, knows nothing about blocks.
//
// Two-component (polarity, distance) model from lang-design.md:
//   polarity ∈ {-1, 0, +1}  — anti-solid / empty / solid
//   distance ∈ ℝ             — signed distance to nearest surface
//
// CSG operators compose each component independently:
//   union(A, B)     = (sgn(p_A + p_B),  min(d_A, d_B))
//   intersect(A, B) = (p_A × p_B,       max(d_A, d_B))
//   anti(A)         = (-polarity,        distance)       — flip charge
//   complement(A)   = (polarity,        -distance)       — flip geometry
//   fuse(A, B, k)   = (sgn(p_A + p_B),  smin(d_A, d_B, k))

const COLOR_MAP = {
  unset:  0xaaaaaa,
  gray:   0xaaaaaa,
  red:    0xff4444,
  blue:   0x4488ff,
  green:  0x44cc44,
  yellow: 0xffcc00,
  orange: 0xff8800
};

const DEFAULT_COLOR = 'gray';
const UNSET_COLOR = 'unset';

function hexToRgb(hex) {
  return [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255];
}

const DEFAULT_RGB = hexToRgb(COLOR_MAP[DEFAULT_COLOR]);
// Unset renders as gray but yields to any explicit color in CSG operations
const UNSET_RGB = DEFAULT_RGB;

// Does this AST node (or any subtree) require CSG field evaluation?
// If so, we must mesh the entire subtree via surface-nets rather than
// using Three.js primitives.
function needsFieldEval(node) {
  const type = node[0];
  if (type === 'intersect' || type === 'anti' || type === 'complement' || type === 'fuse') return true;
  // Check children recursively
  const start = (type === 'union' || type === 'intersect' || type === 'anti' || type === 'complement') ? 1 : 2;
  const children = node.slice(start);
  for (const child of children) {
    if (Array.isArray(child) && needsFieldEval(child)) return true;
  }
  return false;
}

let evalStats = null;

export function evaluate(ast) {
  evalStats = { nodes: 0, voxels: 0, meshTime: 0, resolution: csgResolution };
  const t0 = performance.now();
  if (!ast) return { group: new THREE.Group(), stats: evalStats };
  const result = evalNode(ast);
  evalStats.meshTime = Math.round(performance.now() - t0);
  if (!result) return { group: new THREE.Group(), stats: evalStats };
  const group = new THREE.Group();
  group.add(result);
  return { group, stats: evalStats };
}

function evalNode(node) {
  if (evalStats) evalStats.nodes++;
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      const s = p.size || 20;
      const geo = new THREE.BoxGeometry(s, s, s);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return new THREE.Mesh(geo, mat);
    }
    case 'sphere': {
      const p = node[1];
      const geo = new THREE.SphereGeometry(p.radius || 15, 32, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return new THREE.Mesh(geo, mat);
    }
    case 'cylinder': {
      const p = node[1];
      const r = p.radius || 10;
      const h = p.height || 30;
      const geo = new THREE.CylinderGeometry(r, r, h, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return new THREE.Mesh(geo, mat);
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) return null;
      // If any child needs field eval, mesh the whole translate
      if (needsFieldEval(node)) {
        return meshCSGNode(node);
      }
      const group = new THREE.Group();
      group.position.set(p.x || 0, p.y || 0, p.z || 0);
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    case 'paint': {
      if (needsFieldEval(node)) return meshCSGNode(node);
      const p = node[1];
      const color = COLOR_MAP[p.color] || COLOR_MAP[DEFAULT_COLOR];
      const children = node.slice(2);
      if (children.length === 0) return null;
      const group = new THREE.Group();
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) {
          paintObject(obj, color);
          group.add(obj);
        }
      }
      return group.children.length === 1 ? group.children[0] : group;
    }
    case 'recolor': {
      if (needsFieldEval(node)) return meshCSGNode(node);
      const p = node[1];
      const fromColor = COLOR_MAP[p.from] || COLOR_MAP[DEFAULT_COLOR];
      const toColor = COLOR_MAP[p.to] || COLOR_MAP[DEFAULT_COLOR];
      const children = node.slice(2);
      if (children.length === 0) return null;
      const group = new THREE.Group();
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) {
          recolorObject(obj, fromColor, toColor);
          group.add(obj);
        }
      }
      return group.children.length === 1 ? group.children[0] : group;
    }
    case 'union': {
      const children = node.slice(1);
      if (needsFieldEval(node)) {
        return meshCSGNode(node);
      }
      const group = new THREE.Group();
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    case 'intersect':
    case 'anti':
    case 'complement': {
      return meshCSGNode(node);
    }
    case 'fuse': {
      return meshCSGNode(node);
    }
    default:
      return null;
  }
}

// ---- CSG field meshing ----
// Mesh a CSG node using the two-component (polarity, distance) model.
// Returns a Three.js Group containing solid and anti-solid meshes.

let csgResolution = 48;
export function getResolution() { return csgResolution; }
export function setResolution(n) { csgResolution = Math.max(16, Math.min(192, n)); }

function meshCSGNode(node) {
  const res = csgResolution;
  if (evalStats) evalStats.voxels += (res + 1) ** 3;
  const bounds = estimateBounds(node);
  const csgField = evalCSGField(node);
  const group = new THREE.Group();

  // Solid mesh (polarity > 0) with per-vertex color from the field
  const solidField = (x, y, z) => {
    const { polarity, distance } = csgField(x, y, z);
    if (polarity > 0) return distance;
    return Math.abs(distance) + 0.01;
  };
  const solidColorField = (x, y, z) => {
    const c = csgField(x, y, z).color;
    return c === UNSET_COLOR ? UNSET_RGB : c;
  };

  const solidGeo = meshField(solidField, bounds, res, solidColorField);
  if (solidGeo.index && solidGeo.index.count > 0) {
    const solidMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });
    group.add(new THREE.Mesh(solidGeo, solidMat));
  }

  // Anti-solid mesh (polarity < 0): translucent ghost
  const antiField = (x, y, z) => {
    const { polarity, distance } = csgField(x, y, z);
    if (polarity < 0) return distance;
    return Math.abs(distance) + 0.01;
  };

  const antiGeo = meshField(antiField, bounds, res);
  if (antiGeo.index && antiGeo.index.count > 0) {
    const antiMat = new THREE.MeshStandardMaterial({
      color: 0xcc4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    });
    group.add(new THREE.Mesh(antiGeo, antiMat));
  }

  return group;
}

// ---- Three-component CSG field evaluation ----
// Returns (x, y, z) => { polarity: -1|0|+1, distance: number, color: [r,g,b] }

const EMPTY = { polarity: 0, distance: 1e10, color: UNSET_COLOR };

function evalCSGField(node) {
  const type = node[0];

  switch (type) {
    case 'sphere': {
      const r = node[1].radius || 15;
      return (x, y, z) => {
        const d = Math.sqrt(x*x + y*y + z*z) - r;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - s, qy = Math.abs(y) - s, qz = Math.abs(z) - s;
        const outside = Math.sqrt(Math.max(qx,0)**2 + Math.max(qy,0)**2 + Math.max(qz,0)**2);
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'cylinder': {
      const r = node[1].radius || 10;
      const h = node[1].height || 30;
      return (x, y, z) => {
        const dx = Math.sqrt(x*x + z*z) - r;
        const dy = Math.abs(y) - h / 2;
        const outside = Math.sqrt(Math.max(dx,0)**2 + Math.max(dy,0)**2);
        const inside = Math.min(Math.max(dx, dy), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'translate': {
      const p = node[1];
      const tx = p.x || 0, ty = p.y || 0, tz = p.z || 0;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      if (children.length === 1) {
        const child = evalCSGField(children[0]);
        return (x, y, z) => child(x - tx, y - ty, z - tz);
      }
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        return csgUnion(fields.map(f => f(px, py, pz)));
      };
    }
    case 'paint': {
      const colorName = node[1].color || DEFAULT_COLOR;
      const color = colorName === UNSET_COLOR
        ? UNSET_COLOR
        : hexToRgb(COLOR_MAP[colorName] || COLOR_MAP[DEFAULT_COLOR]);
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const inner = children.length === 1
        ? evalCSGField(children[0])
        : ((fields) => (x, y, z) => csgUnion(fields.map(f => f(x, y, z))))(children.map(c => evalCSGField(c)));
      return (x, y, z) => {
        const r = inner(x, y, z);
        return { polarity: r.polarity, distance: r.distance, color };
      };
    }
    case 'recolor': {
      const fromName = node[1].from || DEFAULT_COLOR;
      const fromRgb = hexToRgb(COLOR_MAP[fromName] || COLOR_MAP[DEFAULT_COLOR]);
      const toName = node[1].to || DEFAULT_COLOR;
      const toColor = toName === UNSET_COLOR
        ? UNSET_COLOR
        : hexToRgb(COLOR_MAP[toName] || COLOR_MAP[DEFAULT_COLOR]);
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const inner = children.length === 1
        ? evalCSGField(children[0])
        : ((fields) => (x, y, z) => csgUnion(fields.map(f => f(x, y, z))))(children.map(c => evalCSGField(c)));
      return (x, y, z) => {
        const r = inner(x, y, z);
        const match = r.color !== UNSET_COLOR
          ? fromName !== UNSET_COLOR && Math.abs(r.color[0] - fromRgb[0]) + Math.abs(r.color[1] - fromRgb[1]) + Math.abs(r.color[2] - fromRgb[2]) < 0.05
          : fromName === UNSET_COLOR;
        return { polarity: r.polarity, distance: r.distance, color: match ? toColor : r.color };
      };
    }
    case 'union': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgUnion(fields.map(f => f(x, y, z)));
    }
    case 'intersect': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgIntersect(fields.map(f => f(x, y, z)));
    }
    case 'anti': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        return { polarity: -r.polarity, distance: r.distance, color: r.color };
      };
    }
    case 'complement': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        return { polarity: r.polarity, distance: -r.distance, color: r.color };
      };
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => {
        const results = fields.map(f => f(x, y, z));
        let pSum = 0;
        for (const r of results) pSum += r.polarity;
        // Smooth min distance
        const distances = results.map(r => r.distance);
        const neg = distances.map(d => -d / k);
        const maxNeg = Math.max(...neg);
        let sum = 0;
        for (const v of neg) sum += Math.exp(v - maxNeg);
        const dist = -k * (Math.log(sum) + maxNeg);
        // Blend colors weighted by softmin contribution (closer = more weight)
        // Unset colors are excluded from the blend; if all unset, stay unset
        const weights = neg.map(v => Math.exp(v - maxNeg));
        let setTotal = 0;
        for (let i = 0; i < results.length; i++) {
          if (results[i].color !== UNSET_COLOR) setTotal += weights[i];
        }
        let color = UNSET_COLOR;
        if (setTotal > 0) {
          color = [0, 0, 0];
          for (let i = 0; i < results.length; i++) {
            if (results[i].color === UNSET_COLOR) continue;
            const w = weights[i] / setTotal;
            color[0] += results[i].color[0] * w;
            color[1] += results[i].color[1] * w;
            color[2] += results[i].color[2] * w;
          }
        }
        return { polarity: Math.sign(pSum), distance: dist, color };
      };
    }
    default:
      return () => ({ polarity: 0, distance: 0, color: UNSET_COLOR });
  }
}

// CSG union: (sgn(p_A + p_B), min(d_A, d_B), color preferring set over unset)
function csgUnion(results) {
  let pSum = 0;
  let best = results[0];
  for (const r of results) {
    pSum += r.polarity;
    if (r.distance < best.distance) best = r;
  }
  // Prefer any explicitly-set color over unset
  let color = best.color;
  if (color === UNSET_COLOR) {
    for (const r of results) {
      if (r.color !== UNSET_COLOR) { color = r.color; break; }
    }
  }
  return { polarity: Math.sign(pSum), distance: best.distance, color };
}

// CSG intersect: (product of polarities, max(d_A, d_B), color preferring set over unset)
function csgIntersect(results) {
  let pProd = results[0].polarity;
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    pProd *= results[i].polarity;
    if (results[i].distance > best.distance) best = results[i];
  }
  // Prefer any explicitly-set color over unset
  let color = best.color;
  if (color === UNSET_COLOR) {
    for (const r of results) {
      if (r.color !== UNSET_COLOR) { color = r.color; break; }
    }
  }
  return { polarity: pProd, distance: best.distance, color };
}

// Traverse a Three.js object and set all mesh materials to the given color
function paintObject(obj, color) {
  obj.traverse(child => {
    if (child.isMesh && child.material) {
      child.material = child.material.clone();
      child.material.color.setHex(color);
    }
  });
}

// Traverse and swap materials matching fromColor to toColor
function recolorObject(obj, fromColor, toColor) {
  obj.traverse(child => {
    if (child.isMesh && child.material) {
      if (child.material.color.getHex() === fromColor) {
        child.material = child.material.clone();
        child.material.color.setHex(toColor);
      }
    }
  });
}

// ---- SDF evaluation: AST → field function (x,y,z) => distance ----
// (Legacy, used by fuse for backward compat; also usable standalone)
// Color nodes (paint, recolor) are transparent to field evaluation.

export function evalField(node) {
  const type = node[0];

  switch (type) {
    case 'sphere': {
      const r = node[1].radius || 15;
      return (x, y, z) => Math.sqrt(x*x + y*y + z*z) - r;
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - s, qy = Math.abs(y) - s, qz = Math.abs(z) - s;
        const outside = Math.sqrt(
          Math.max(qx, 0)**2 + Math.max(qy, 0)**2 + Math.max(qz, 0)**2
        );
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        return outside + inside;
      };
    }
    case 'cylinder': {
      const r = node[1].radius || 10;
      const h = node[1].height || 30;
      return (x, y, z) => {
        const dx = Math.sqrt(x*x + z*z) - r;
        const dy = Math.abs(y) - h / 2;
        const outside = Math.sqrt(Math.max(dx, 0)**2 + Math.max(dy, 0)**2);
        const inside = Math.min(Math.max(dx, dy), 0);
        return outside + inside;
      };
    }
    case 'translate': {
      const p = node[1];
      const tx = p.x || 0, ty = p.y || 0, tz = p.z || 0;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      if (children.length === 1) {
        const child = evalField(children[0]);
        return (x, y, z) => child(x - tx, y - ty, z - tz);
      }
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        let d = fields[0](px, py, pz);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](px, py, pz));
        return d;
      };
    }
    case 'paint':
    case 'recolor': {
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      if (children.length === 1) return evalField(children[0]);
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'union': {
      const children = node.slice(1);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'intersect': {
      const children = node.slice(1);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.max(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'anti': {
      const children = node.slice(1);
      if (children.length === 0) return () => 1e10;
      return evalField(children[0]); // anti doesn't change the distance
    }
    case 'complement': {
      const children = node.slice(1);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => -child(x, y, z); // negate distance
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return softmin(fields, k);
    }
    default: {
      console.warn(`evalField: unknown node type "${type}", returning zero field`);
      return () => 0;
    }
  }
}

// Smooth minimum via stable log-sum-exp (softmin)
function softmin(fields, k) {
  if (fields.length === 1) return fields[0];
  return (x, y, z) => {
    const neg = fields.map(f => -f(x, y, z) / k);
    const maxNeg = Math.max(...neg);
    let sum = 0;
    for (const v of neg) sum += Math.exp(v - maxNeg);
    return -k * (Math.log(sum) + maxNeg);
  };
}

// ---- Bounding box estimation from AST ----

export function estimateBounds(node, offset = [0, 0, 0]) {
  const type = node[0];
  const pad = 5;

  switch (type) {
    case 'sphere': {
      const r = (node[1].radius || 15) + pad;
      return {
        min: [offset[0] - r, offset[1] - r, offset[2] - r],
        max: [offset[0] + r, offset[1] + r, offset[2] + r]
      };
    }
    case 'cube': {
      const h = (node[1].size || 20) / 2 + pad;
      return {
        min: [offset[0] - h, offset[1] - h, offset[2] - h],
        max: [offset[0] + h, offset[1] + h, offset[2] + h]
      };
    }
    case 'cylinder': {
      const r = (node[1].radius || 10) + pad;
      const h = (node[1].height || 30) / 2 + pad;
      return {
        min: [offset[0] - r, offset[1] - h, offset[2] - r],
        max: [offset[0] + r, offset[1] + h, offset[2] + r]
      };
    }
    case 'translate': {
      const p = node[1];
      const newOff = [offset[0] + (p.x||0), offset[1] + (p.y||0), offset[2] + (p.z||0)];
      const children = node.slice(2);
      return mergeBounds(children.map(c => estimateBounds(c, newOff)));
    }
    case 'paint':
    case 'recolor': {
      const children = node.slice(2);
      return mergeBounds(children.map(c => estimateBounds(c, offset)));
    }
    case 'anti':
    case 'complement': {
      const children = node.slice(1);
      return mergeBounds(children.map(c => estimateBounds(c, offset)));
    }
    case 'union':
    case 'intersect':
    case 'fuse': {
      const start = type === 'fuse' ? 2 : 1;
      const children = node.slice(start);
      const merged = mergeBounds(children.map(c => estimateBounds(c, offset)));
      if (type === 'fuse') {
        const k = (node[1].k || 5);
        merged.min = merged.min.map(v => v - k);
        merged.max = merged.max.map(v => v + k);
      }
      return merged;
    }
    default:
      return {
        min: [offset[0] - 20, offset[1] - 20, offset[2] - 20],
        max: [offset[0] + 20, offset[1] + 20, offset[2] + 20]
      };
  }
}

function mergeBounds(boundsList) {
  if (boundsList.length === 0) {
    return { min: [-20, -20, -20], max: [20, 20, 20] };
  }
  const min = [...boundsList[0].min];
  const max = [...boundsList[0].max];
  for (let i = 1; i < boundsList.length; i++) {
    for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], boundsList[i].min[j]);
      max[j] = Math.max(max[j], boundsList[i].max[j]);
    }
  }
  return { min, max };
}
