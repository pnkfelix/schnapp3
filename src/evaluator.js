import * as THREE from 'three';
import { meshField } from './surface-nets.js';
import { evalCSGFieldInterval } from './interval-eval.js';
import { buildOctree, meshOctreeLeaves, resToDepth } from './octree-mesh.js';

// S-expression AST → Three.js geometry
// Consumes the structured AST from codegen.js, knows nothing about blocks.
//
// Two-component (polarity, distance) model from lang-design.md:
//   polarity ∈ {-1, 0, +1}  — anti-solid / empty / solid

// Anti-solid visual: checkerboard surface + wireframe outline.
// The checkerboard discards alternating 3D cells so parts of the surface
// are truly invisible. The wireframe shows the full silhouette so the
// shape remains legible even with half the surface missing.
export function addAntiMesh(group, geo) {
  // Checkerboard surface
  group.add(new THREE.Mesh(geo, _makeAntiCheckerMat()));
  // Wireframe overlay (mode-dependent)
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x993333,
    transparent: true,
    opacity: 0.25,
    depthWrite: false
  });
  if (antiWireframeMode === 'full') {
    wireMat.wireframe = true;
    group.add(new THREE.Mesh(geo, wireMat));
  } else if (antiWireframeMode === 'edges') {
    const edgesGeo = new THREE.EdgesGeometry(geo, 30); // 30° threshold
    const linesMat = new THREE.LineBasicMaterial({
      color: 0x993333,
      transparent: true,
      opacity: 0.5
    });
    group.add(new THREE.LineSegments(edgesGeo, linesMat));
  }
  // 'off' → no wireframe added
}

function _makeAntiCheckerMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor:      { value: new THREE.Color(0xcc4444) },
      uOpacity:    { value: 0.35 },
      uSquareSize: { value: antiCheckerSize }   // world-unit size of each checker square
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3  uColor;
      uniform float uOpacity;
      uniform float uSquareSize;
      varying vec3  vWorldPos;
      varying vec3  vNormal;
      void main() {
        // 3D checkerboard: uses all three world-space coordinates so
        // the pattern is view-angle-independent. No projection needed.
        vec3 cell = floor(vWorldPos / uSquareSize);
        if (mod(cell.x + cell.y + cell.z, 2.0) < 0.5) discard;

        // Simple diffuse-ish shading so the surface reads as 3D
        float ndl = 0.4 + 0.6 * abs(dot(vNormal, normalize(vec3(1.0, 2.0, 3.0))));
        gl_FragColor = vec4(uColor * ndl, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
}
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
export function needsFieldEval(node) {
  if (!node || !Array.isArray(node)) return false;
  const type = node[0];
  if (type === 'intersect' || type === 'anti' || type === 'complement' || type === 'fuse'
      || type === 'mirror' || type === 'rotate' || type === 'twist' || type === 'radial'
      || type === 'stretch' || type === 'tile' || type === 'bend' || type === 'taper') return true;
  // Tags are metadata wrappers — recurse into the inner child
  if (type === 'tag' || type === 'tags') return node.length > 2 ? needsFieldEval(node[2]) : false;
  // PL nodes should be expanded before reaching here, but handle gracefully
  if (type === 'let' || type === 'var' || type === 'grow' || type === 'fractal' || type === 'stir' || type === 'enzyme' || type === 'scalar') return false;
  // Check children recursively
  const start = (type === 'union' || type === 'intersect' || type === 'anti' || type === 'complement') ? 1 : 2;
  const children = node.slice(start);
  for (const child of children) {
    if (Array.isArray(child) && needsFieldEval(child)) return true;
  }
  return false;
}

let evalStats = null;
let useOctree = true;
export function getUseOctree() { return useOctree; }
export function setUseOctree(v) { useOctree = v; }

let antiCheckerSize = 3.0;
export function getAntiCheckerSize() { return antiCheckerSize; }
export function setAntiCheckerSize(v) { antiCheckerSize = v; }

// 'off' | 'full' | 'edges'
let antiWireframeMode = 'full';
const WIREFRAME_MODES = ['off', 'full', 'edges'];
export function getAntiWireframeMode() { return antiWireframeMode; }
export function setAntiWireframeMode(v) { antiWireframeMode = v; }
export function cycleAntiWireframeMode() {
  const i = WIREFRAME_MODES.indexOf(antiWireframeMode);
  antiWireframeMode = WIREFRAME_MODES[(i + 1) % WIREFRAME_MODES.length];
  return antiWireframeMode;
}

export function evaluate(ast) {
  evalStats = { nodes: 0, voxels: 0, meshTime: 0, resolution: csgResolution, octree: null };
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
  if (!node || !Array.isArray(node)) {
    // Bundles from curried stir: evaluate the non-enzyme items as a union
    if (node && node.__bundle) {
      const group = new THREE.Group();
      for (const item of node.items) {
        const obj = evalNode(item);
        if (obj) group.add(obj);
      }
      return group.children.length ? group : null;
    }
    return null; // skip enzyme closures, etc.
  }
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
    case 'tag':
    case 'tags': {
      // Tags are metadata — strip and evaluate the inner child
      const inner = node.length > 2 ? node[2] : null;
      return inner ? evalNode(inner) : null;
    }
    case 'intersect':
    case 'anti':
    case 'complement': {
      return meshCSGNode(node);
    }
    case 'fuse': {
      return meshCSGNode(node);
    }
    case 'mirror':
    case 'rotate':
    case 'twist':
    case 'radial':
    case 'stretch':
    case 'tile':
    case 'bend':
    case 'taper': {
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
export function setResolution(n) { csgResolution = Math.max(16, n); }

function meshCSGNode(node) {
  const res = csgResolution;
  const bounds = estimateBounds(node);
  const csgField = evalCSGField(node);
  const group = new THREE.Group();

  // Solid field: positive polarity → use SDF distance; otherwise push outside
  const solidField = (x, y, z) => {
    const { polarity, distance } = csgField(x, y, z);
    if (polarity > 0) return distance;
    return Math.abs(distance) + 0.01;
  };
  const solidColorField = (x, y, z) => {
    const c = csgField(x, y, z).color;
    return c === UNSET_COLOR ? UNSET_RGB : c;
  };

  // Anti field: negative polarity → use SDF distance
  const antiField = (x, y, z) => {
    const { polarity, distance } = csgField(x, y, z);
    if (polarity < 0) return distance;
    return Math.abs(distance) + 0.01;
  };

  if (useOctree) {
    // ---- Octree-accelerated path ----
    const depth = resToDepth(res);
    const octreeStats = {
      nodesVisited: 0, nodesCulledOutside: 0, nodesCulledInside: 0,
      leafCells: 0, activeCells: 0, surfaceVerts: 0, pointEvals: 0, faces: 0
    };

    // Build interval evaluator for solid field
    let intervalField;
    try {
      intervalField = evalCSGFieldInterval(node);
    } catch (e) {
      console.warn('Octree interval eval failed, falling back to uniform grid:', e);
      return meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField);
    }

    // For the solid mesh, the actual field is:
    //   polarity > 0  → distance  (the SDF)
    //   polarity <= 0 → abs(distance) + 0.01  (always positive → no surface)
    // So if the polarity interval is entirely <= 0, there's no solid surface.
    // If distance interval is entirely > 0, there's no surface either.
    // We return { distance: [lo, hi] } for the octree classifier.
    const solidIntervalField = (xIv, yIv, zIv) => {
      const r = intervalField(xIv, yIv, zIv);
      // If polarity can never be > 0, this region has no solid → push distance positive
      if (r.polarity[1] <= 0) {
        return { distance: [0.01, Infinity], polarity: [0, 0] };
      }
      return r;
    };

    const leaves = buildOctree(solidIntervalField, bounds, depth, octreeStats);

    // buildOctree returns null if it bailed out (interval arithmetic wasn't helping)
    if (leaves === null) {
      if (evalStats) {
        octreeStats.bailedOut = true;
        evalStats.octree = octreeStats;
      }
      return meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField);
    }

    const solidGeo = meshOctreeLeaves(leaves, solidField, bounds, depth, solidColorField, octreeStats);

    if (solidGeo.index && solidGeo.index.count > 0) {
      const solidMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide
      });
      group.add(new THREE.Mesh(solidGeo, solidMat));
    }

    // Anti-solid: use uniform grid (anti-solids are typically small/rare)
    if (evalStats) evalStats.voxels += (res + 1) ** 3;
    const antiGeo = meshField(antiField, bounds, res);
    if (antiGeo.index && antiGeo.index.count > 0) {
      addAntiMesh(group, antiGeo);
    }

    // Record stats
    if (evalStats) {
      evalStats.octree = octreeStats;
      evalStats.voxels += octreeStats.pointEvals;
    }

  } else {
    // ---- Original uniform grid path ----
    return meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField);
  }

  return group;
}

// Original uniform-grid meshing (fallback)
function meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField) {
  if (evalStats) evalStats.voxels += (res + 1) ** 3;
  const group = new THREE.Group();

  const solidGeo = meshField(solidField, bounds, res, solidColorField);
  if (solidGeo.index && solidGeo.index.count > 0) {
    const solidMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });
    group.add(new THREE.Mesh(solidGeo, solidMat));
  }

  const antiGeo = meshField(antiField, bounds, res);
  if (antiGeo.index && antiGeo.index.count > 0) {
    addAntiMesh(group, antiGeo);
  }

  return group;
}

// ---- Three-component CSG field evaluation ----
// Returns (x, y, z) => { polarity: -1|0|+1, distance: number, color: [r,g,b] }

const EMPTY = { polarity: 0, distance: 1e10, color: UNSET_COLOR };

function evalCSGField(node) {
  if (!node || !Array.isArray(node)) return () => EMPTY;
  const type = node[0];

  switch (type) {
    case 'tag':
    case 'tags': {
      return node.length > 2 ? evalCSGField(node[2]) : () => EMPTY;
    }
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
        const nd = -r.distance;
        return { polarity: nd <= 0 ? 1 : 0, distance: nd, color: r.color };
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
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // mirror: reflect query point — abs() on the mirror axis
      return (x, y, z) => {
        if (axis === 'x') return child(Math.abs(x), y, z);
        if (axis === 'y') return child(x, Math.abs(y), z);
        return child(x, y, Math.abs(z));
      };
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const angleDeg = node[1].angle != null ? node[1].angle : 45;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // rotate: apply inverse rotation (negate angle) to query point
      const rad = -angleDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      return (x, y, z) => {
        if (axis === 'y') return child(c * x - s * z, y, s * x + c * z);
        if (axis === 'x') return child(x, c * y - s * z, s * y + c * z);
        return child(c * x - s * y, s * x + c * y, z);
      };
    }
    case 'twist': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.1;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // twist: rotate the cross-section perpendicular to axis by rate*distance_along_axis
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const angle = -rate * along;
        const c = Math.cos(angle), s = Math.sin(angle);
        const ru = c * u - s * v, rv = s * u + c * v;
        if (axis === 'y') return child(ru, y, rv);
        if (axis === 'x') return child(x, ru, rv);
        return child(ru, rv, z);
      };
    }
    case 'radial': {
      const axis = node[1].axis || 'y';
      const count = Math.max(2, Math.round(node[1].count || 6));
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      const sector = 2 * Math.PI / count;
      // radial: fold the query point into the first sector around the axis
      return (x, y, z) => {
        let u, v, w;
        if (axis === 'y') { u = x; v = z; w = y; }
        else if (axis === 'x') { u = y; v = z; w = x; }
        else { u = x; v = y; w = z; }
        let angle = Math.atan2(v, u);
        if (angle < 0) angle += 2 * Math.PI;
        angle = angle % sector;
        // Fold to nearest sector edge for symmetry
        if (angle > sector / 2) angle = sector - angle;
        const r = Math.sqrt(u * u + v * v);
        const nu = r * Math.cos(angle), nv = r * Math.sin(angle);
        if (axis === 'y') return child(nu, w, nv);
        if (axis === 'x') return child(w, nu, nv);
        return child(nu, nv, w);
      };
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // stretch: query inverse-scaled point, then scale distance by min scale factor
      // to maintain a valid SDF (conservative — overestimates distance for non-uniform)
      const minScale = Math.min(sx, sy, sz);
      return (x, y, z) => {
        const result = child(x / sx, y / sy, z / sz);
        return { polarity: result.polarity, distance: result.distance * minScale, color: result.color };
      };
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // tile: repeat by wrapping the query coordinate into [-spacing/2, spacing/2]
      const half = spacing / 2;
      return (x, y, z) => {
        let tx = x, ty = y, tz = z;
        if (axis === 'x') tx = ((x % spacing) + spacing + half) % spacing - half;
        else if (axis === 'y') ty = ((y % spacing) + spacing + half) % spacing - half;
        else tz = ((z % spacing) + spacing + half) % spacing - half;
        return child(tx, ty, tz);
      };
    }
    case 'bend': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.05;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // bend: curve space around the given axis
      // For axis='y': bend the x-y plane — x becomes the arc direction, y the "along" axis
      // The geometry bends so that straight lines along x curve into arcs
      return (x, y, z) => {
        if (rate === 0) return child(x, y, z);
        let along, perp, w;
        if (axis === 'y') { along = x; perp = y; w = z; }
        else if (axis === 'x') { along = y; perp = x; w = z; }
        else { along = x; perp = z; w = y; }
        const angle = along * rate;
        const c = Math.cos(angle), s = Math.sin(angle);
        const r = perp + 1 / rate;
        const na = s * r;
        const np = c * r - 1 / rate;
        if (axis === 'y') return child(na, np, w);
        if (axis === 'x') return child(np, na, w);
        return child(na, w, np);
      };
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      // taper: linearly scale cross-section based on position along axis
      // scale = 1 + rate * along — at along=0 scale is 1, grows/shrinks linearly
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const scale = Math.max(0.01, 1 + rate * along);
        const invScale = 1 / scale;
        const result = (axis === 'y') ? child(u * invScale, y, v * invScale)
                     : (axis === 'x') ? child(x, u * invScale, v * invScale)
                     : child(u * invScale, v * invScale, z);
        // Scale distance by the local scale factor to maintain valid SDF
        return { polarity: result.polarity, distance: result.distance * scale, color: result.color };
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
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        if (axis === 'x') return child(Math.abs(x), y, z);
        if (axis === 'y') return child(x, Math.abs(y), z);
        return child(x, y, Math.abs(z));
      };
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const angleDeg = node[1].angle != null ? node[1].angle : 45;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const rad = -angleDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      return (x, y, z) => {
        if (axis === 'y') return child(c * x - s * z, y, s * x + c * z);
        if (axis === 'x') return child(x, c * y - s * z, s * y + c * z);
        return child(c * x - s * y, s * x + c * y, z);
      };
    }
    case 'twist': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.1;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const angle = -rate * along;
        const c = Math.cos(angle), s = Math.sin(angle);
        const ru = c * u - s * v, rv = s * u + c * v;
        if (axis === 'y') return child(ru, y, rv);
        if (axis === 'x') return child(x, ru, rv);
        return child(ru, rv, z);
      };
    }
    case 'radial': {
      const axis = node[1].axis || 'y';
      const count = Math.max(2, Math.round(node[1].count || 6));
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const sector = 2 * Math.PI / count;
      return (x, y, z) => {
        let u, v, w;
        if (axis === 'y') { u = x; v = z; w = y; }
        else if (axis === 'x') { u = y; v = z; w = x; }
        else { u = x; v = y; w = z; }
        let angle = Math.atan2(v, u);
        if (angle < 0) angle += 2 * Math.PI;
        angle = angle % sector;
        if (angle > sector / 2) angle = sector - angle;
        const r = Math.sqrt(u * u + v * v);
        const nu = r * Math.cos(angle), nv = r * Math.sin(angle);
        if (axis === 'y') return child(nu, w, nv);
        if (axis === 'x') return child(w, nu, nv);
        return child(nu, nv, w);
      };
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const minScale = Math.min(sx, sy, sz);
      return (x, y, z) => child(x / sx, y / sy, z / sz) * minScale;
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const half = spacing / 2;
      return (x, y, z) => {
        let tx = x, ty = y, tz = z;
        if (axis === 'x') tx = ((x % spacing) + spacing + half) % spacing - half;
        else if (axis === 'y') ty = ((y % spacing) + spacing + half) % spacing - half;
        else tz = ((z % spacing) + spacing + half) % spacing - half;
        return child(tx, ty, tz);
      };
    }
    case 'bend': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.05;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        if (rate === 0) return child(x, y, z);
        let along, perp, w;
        if (axis === 'y') { along = x; perp = y; w = z; }
        else if (axis === 'x') { along = y; perp = x; w = z; }
        else { along = x; perp = z; w = y; }
        const angle = along * rate;
        const c = Math.cos(angle), s = Math.sin(angle);
        const r = perp + 1 / rate;
        const na = s * r;
        const np = c * r - 1 / rate;
        if (axis === 'y') return child(na, np, w);
        if (axis === 'x') return child(np, na, w);
        return child(na, w, np);
      };
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const scale = Math.max(0.01, 1 + rate * along);
        const invScale = 1 / scale;
        const d = (axis === 'y') ? child(u * invScale, y, v * invScale)
                : (axis === 'x') ? child(x, u * invScale, v * invScale)
                : child(u * invScale, v * invScale, z);
        return d * scale;
      };
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
    case 'mirror': {
      // Mirror doubles the child across an axis — expand bounds to be symmetric
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'x';
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const extent = Math.max(Math.abs(childBounds.min[ai]), Math.abs(childBounds.max[ai]));
      childBounds.min[ai] = offset[ai] - extent;
      childBounds.max[ai] = offset[ai] + extent;
      return childBounds;
    }
    case 'rotate': {
      // Rotation in the plane perpendicular to the axis — use max radial extent
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = Math.max(
        Math.abs(childBounds.min[a0]), Math.abs(childBounds.max[a0]),
        Math.abs(childBounds.min[a1]), Math.abs(childBounds.max[a1])
      );
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'twist': {
      // Twist can rotate the cross-section — expand to contain the rotated extent
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      // Conservative: use the max radial extent for both cross-section axes
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = Math.max(
        Math.abs(childBounds.min[a0]), Math.abs(childBounds.max[a0]),
        Math.abs(childBounds.min[a1]), Math.abs(childBounds.max[a1])
      );
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'radial': {
      // Radial repeat — expand to full circle around the axis
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = Math.max(
        Math.abs(childBounds.min[a0]), Math.abs(childBounds.max[a0]),
        Math.abs(childBounds.min[a1]), Math.abs(childBounds.max[a1])
      );
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'stretch': {
      // Stretch scales each axis — multiply child bounds by scale factors
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const scales = [sx, sy, sz];
      for (let i = 0; i < 3; i++) {
        const cen = offset[i];
        childBounds.min[i] = cen + (childBounds.min[i] - cen) * scales[i];
        childBounds.max[i] = cen + (childBounds.max[i] - cen) * scales[i];
        if (childBounds.min[i] > childBounds.max[i]) {
          [childBounds.min[i], childBounds.max[i]] = [childBounds.max[i], childBounds.min[i]];
        }
      }
      return childBounds;
    }
    case 'tile': {
      // Tile repeats along one axis — expand that axis to a large extent
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      // Show roughly 5 tiles in each direction
      const spacing = node[1].spacing || 30;
      const extent = spacing * 5;
      childBounds.min[ai] = offset[ai] - extent;
      childBounds.max[ai] = offset[ai] + extent;
      return childBounds;
    }
    case 'bend': {
      // Bend curves space — conservative expansion
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      // Bending can move geometry significantly; expand all axes by the child's max extent
      const maxExtent = Math.max(
        ...childBounds.max.map((v, i) => Math.abs(v - offset[i])),
        ...childBounds.min.map((v, i) => Math.abs(v - offset[i]))
      );
      for (let i = 0; i < 3; i++) {
        childBounds.min[i] = offset[i] - maxExtent;
        childBounds.max[i] = offset[i] + maxExtent;
      }
      return childBounds;
    }
    case 'taper': {
      // Taper scales cross-section — conservative: expand cross-section axes
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      // Find max scale factor across the along-axis extent
      const maxAlong = Math.max(
        Math.abs(childBounds.min[ai] - offset[ai]),
        Math.abs(childBounds.max[ai] - offset[ai])
      );
      const maxScale = Math.max(1, 1 + Math.abs(rate) * maxAlong);
      for (const a of [a0, a1]) {
        const ext = Math.max(
          Math.abs(childBounds.min[a] - offset[a]),
          Math.abs(childBounds.max[a] - offset[a])
        ) * maxScale;
        childBounds.min[a] = offset[a] - ext;
        childBounds.max[a] = offset[a] + ext;
      }
      return childBounds;
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
