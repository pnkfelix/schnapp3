import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { meshField } from './surface-nets.js';
import { evalCSGFieldInterval, setTextBoundsProvider } from './interval-eval.js';
import { buildOctree, meshOctreeLeaves, resToDepth } from './octree-mesh.js';
import { nodeChildren, COLOR_MAP, DEFAULT_COLOR, UNSET_COLOR, hexToRgb, DEFAULT_RGB, UNSET_RGB, EMPTY } from './eval/ast-utils.js';
import { estimateBounds, mergeBounds } from './eval/bounds.js';
import { evalField } from './eval/sdf-field.js';
import { addAntiMesh, getAntiCheckerSize, setAntiCheckerSize, getAntiWireframeMode, setAntiWireframeMode, cycleAntiWireframeMode } from './eval/anti-mesh.js';
import { getTextSDF, getTextSDFBounds } from './eval/text-sdf.js';
import { getFont } from './eval/font-cache.js';
import { parseSExpr } from './parser.js';
import { expandAST } from './expand.js';

// Wire up the text bounds provider so the interval evaluator uses actual
// text SDF geometry extents instead of approximate font metrics.
setTextBoundsProvider(getTextSDFBounds);

// S-expression AST → Three.js geometry
// Consumes the structured AST from codegen.js, knows nothing about blocks.
//
// Two-component (polarity, distance) model from lang-design.md:
//   polarity ∈ {-1, 0, +1}  — anti-solid / empty / solid

// Two-component (polarity, distance) model:
//   distance ∈ ℝ             — signed distance to nearest surface
//
// CSG operators compose each component independently:
//   union(A, B)     = (sgn(p_A + p_B),  min(d_A, d_B))
//   intersect(A, B) = (p_A × p_B,       max(d_A, d_B))
//   anti(A)         = (-polarity,        distance)       — flip charge
//   complement(A)   = (polarity,        -distance)       — flip geometry
//   fuse(A, B, k)   = (sgn(p_A + p_B),  smin(d_A, d_B, k))


// Does this AST node (or any subtree) require CSG field evaluation?
// If so, we must mesh the entire subtree via surface-nets rather than
// using Three.js primitives.
export function needsFieldEval(node) {
  if (!node || !Array.isArray(node)) return false;
  const type = node[0];
  if (type === 'intersect' || type === 'anti' || type === 'complement' || type === 'fuse'
      || type === 'mirror' || type === 'rotate' || type === 'twist' || type === 'radial'
      || type === 'stretch' || type === 'tile' || type === 'bend' || type === 'taper') return true;
  // PL nodes should be expanded before reaching here, but handle gracefully
  if (type === 'let' || type === 'var' || type === 'grow' || type === 'fractal' || type === 'stir' || type === 'enzyme' || type === 'tag' || type === 'tags' || type === 'scalar') return false;
  // Check children recursively (skip params object at node[1] if present)
  const children = nodeChildren(node);
  for (const child of children) {
    if (Array.isArray(child) && needsFieldEval(child)) return true;
  }
  return false;
}

let evalStats = null;
let useOctree = true;
export function getUseOctree() { return useOctree; }
export function setUseOctree(v) { useOctree = v; }

// ---- Two-layer subtree cache ----
//
// Layer 1 — Scene registry (identity-addressed by blockId):
//   Tracks which meshCSGNode results are live in the scene and what blocks
//   they depend on.  Used for targeted invalidation: notify(blockId) walks
//   the reverse index to mark affected entries as stale.
//
// Layer 2 — Mesh memo table (content-addressed by AST hash):
//   Caches meshCSGNode results by structural content of the AST subtree.
//   Survives across invalidation cycles: when a stale entry is re-evaluated,
//   the new AST is hashed and checked here before meshing.  Enables reuse
//   across time (undo) and space (shared subexpressions).

// --- Scene registry (Layer 1) ---
const sceneRegistry = new Map();  // blockId → { group, deps: Set<blockId>, contentHash, stale }
const depsIndex = new Map();      // blockId → Set<registryKey>

function registryAdd(rootId, group, deps, contentHash) {
  registryRemove(rootId);  // clean up any existing entry
  sceneRegistry.set(rootId, { group, deps, contentHash, stale: false });
  for (const dep of deps) {
    let set = depsIndex.get(dep);
    if (!set) { set = new Set(); depsIndex.set(dep, set); }
    set.add(rootId);
  }
}

function registryRemove(rootId) {
  const entry = sceneRegistry.get(rootId);
  if (!entry) return;
  for (const dep of entry.deps) {
    const set = depsIndex.get(dep);
    if (set) {
      set.delete(rootId);
      if (set.size === 0) depsIndex.delete(dep);
    }
  }
  sceneRegistry.delete(rootId);
}

function registryMarkStale(changedBlockId) {
  const affected = depsIndex.get(changedBlockId);
  if (!affected) return;
  for (const rootId of affected) {
    const entry = sceneRegistry.get(rootId);
    if (entry) entry.stale = true;
  }
}

// --- Memo table (Layer 2) ---
const memoTable = new Map();  // contentHash → THREE.Group
const MAX_MEMO_ENTRIES = 128;

function memoContentHash(node) {
  // JSON.stringify excludes non-enumerable _blockId — purely structural.
  // Only called for invalidated/new subtrees, not every frame.
  return JSON.stringify(node) + '@' + csgResolution;
}

function memoStore(hash, group) {
  if (memoTable.size >= MAX_MEMO_ENTRIES) {
    // Evict oldest (first in insertion order)
    const oldest = memoTable.keys().next().value;
    memoTable.delete(oldest);
  }
  memoTable.set(hash, deepCloneObject(group));
}

function memoLookup(hash) {
  const cached = memoTable.get(hash);
  if (!cached) return null;
  // Move to end (refresh LRU position)
  memoTable.delete(hash);
  memoTable.set(hash, cached);
  return deepCloneObject(cached);
}

// --- Public API ---

// Called at start of evaluate() with the changed blockId (or undefined for structural).
function invalidateForEdit(changedBlockId) {
  if (!changedBlockId) {
    // Structural change: clear scene registry, keep memo table
    sceneRegistry.clear();
    depsIndex.clear();
    return;
  }
  registryMarkStale(changedBlockId);
}

export function clearSubtreeCache() {
  sceneRegistry.clear();
  depsIndex.clear();
  memoTable.clear();
}

export function getSubtreeCacheStats() {
  let staleCount = 0;
  for (const e of sceneRegistry.values()) if (e.stale) staleCount++;
  return {
    registry: sceneRegistry.size,
    stale: staleCount,
    memo: memoTable.size,
    depsEdges: depsIndex.size,
  };
}

// --- Utilities ---

function collectBlockIds(node, ids) {
  if (!node || !Array.isArray(node)) return;
  if (node._blockId) ids.add(node._blockId);
  for (let i = 1; i < node.length; i++) {
    const v = node[i];
    if (Array.isArray(v)) {
      collectBlockIds(v, ids);
    } else if (v && typeof v === 'object') {
      for (const pv of Object.values(v)) {
        if (Array.isArray(pv)) collectBlockIds(pv, ids);
      }
    }
  }
}

function deepCloneObject(obj) {
  if (obj.isMesh) {
    const geo = obj.geometry.clone();
    const mat = obj.material.clone ? obj.material.clone() : obj.material;
    const mesh = new THREE.Mesh(geo, mat);
    if (obj.userData.vertexBlockIds) mesh.userData.vertexBlockIds = obj.userData.vertexBlockIds;
    if (obj.userData.blockId) mesh.userData.blockId = obj.userData.blockId;
    return mesh;
  }
  if (obj.isLineSegments) {
    const geo = obj.geometry.clone();
    const mat = obj.material.clone ? obj.material.clone() : obj.material;
    return new THREE.LineSegments(geo, mat);
  }
  // Group (or any Object3D with children)
  const clone = new THREE.Group();
  for (const child of obj.children) {
    clone.add(deepCloneObject(child));
  }
  return clone;
}

// Track objects reused from memo table during this evaluate() call.
// These should NOT be disposed when the old scene graph is replaced.
let currentRetained = null;

export function evaluate(ast, changedBlockId) {
  invalidateForEdit(changedBlockId);
  currentRetained = new Set();

  evalStats = { nodes: 0, voxels: 0, meshTime: 0, resolution: csgResolution, octree: null, cacheHits: 0 };
  const t0 = performance.now();
  if (!ast) return { group: new THREE.Group(), stats: evalStats, retained: currentRetained };
  const result = evalNode(ast);
  evalStats.meshTime = Math.round(performance.now() - t0);
  if (!result) return { group: new THREE.Group(), stats: evalStats, retained: currentRetained };
  const group = new THREE.Group();
  group.add(result);
  const retained = currentRetained;
  currentRetained = null;
  return { group, stats: evalStats, retained };
}

function tagBlockId(obj, node) {
  if (obj && node._blockId) obj.userData.blockId = node._blockId;
  return obj;
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
    if (node && node.__thunk) {
      console.warn('Thunk reached geometry evaluator — should have been forced');
    }
    return null; // skip enzyme closures, thunks, etc.
  }
  if (evalStats) evalStats.nodes++;
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      const s = p.size || 20;
      const geo = new THREE.BoxGeometry(s, s, s);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return tagBlockId(new THREE.Mesh(geo, mat), node);
    }
    case 'sphere': {
      const p = node[1];
      const geo = new THREE.SphereGeometry(p.radius || 15, 32, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return tagBlockId(new THREE.Mesh(geo, mat), node);
    }
    case 'cylinder': {
      const p = node[1];
      const r = p.radius || 10;
      const h = p.height || 30;
      const geo = new THREE.CylinderGeometry(r, r, h, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      return tagBlockId(new THREE.Mesh(geo, mat), node);
    }
    case 'text': {
      // Cache check — TextGeometry is expensive to construct
      const textBlockId = node._blockId;
      if (textBlockId) {
        const regEntry = sceneRegistry.get(textBlockId);
        if (regEntry && !regEntry.stale && regEntry.contentHash) {
          if (evalStats) evalStats.cacheHits++;
          if (currentRetained) {
            regEntry.group.traverse(obj => currentRetained.add(obj));
          }
          return regEntry.group;
        }
      }
      const textContentHash = memoContentHash(node);
      const textMemoHit = memoLookup(textContentHash);
      if (textMemoHit) {
        if (evalStats) evalStats.cacheHits++;
        if (textBlockId) {
          const deps = new Set([textBlockId]);
          registryAdd(textBlockId, textMemoHit, deps, textContentHash);
        }
        return textMemoHit;
      }

      const p = node[1];
      const content = p.content || 'Text';
      const fontSize = p.size || 20;
      const depth = p.depth || 4;
      const fontName = p.font || 'helvetiker';
      const font = getFont(fontName);
      if (!font) {
        // Font not loaded yet — show placeholder box, re-render will happen on load
        const pw = fontSize * content.length * 0.6;
        const geo = new THREE.BoxGeometry(pw, fontSize, depth);
        const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR], opacity: 0.3, transparent: true });
        return tagBlockId(new THREE.Mesh(geo, mat), node);
      }
      const geo = new TextGeometry(content, {
        font,
        size: fontSize,
        depth: depth,
        curveSegments: 6,
        bevelEnabled: true,
        bevelThickness: Math.min(depth * 0.1, 1),
        bevelSize: Math.min(fontSize * 0.03, 0.5),
        bevelOffset: 0,
        bevelSegments: 3
      });
      geo.computeBoundingBox();
      // Center the text geometry
      const bb = geo.boundingBox;
      const cx = -(bb.min.x + bb.max.x) / 2;
      const cy = -(bb.min.y + bb.max.y) / 2;
      const cz = -(bb.min.z + bb.max.z) / 2;
      geo.translate(cx, cy, cz);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[DEFAULT_COLOR] });
      const textMesh = new THREE.Mesh(geo, mat);
      // Cache the result
      memoStore(textContentHash, textMesh);
      if (textBlockId) {
        const deps = new Set([textBlockId]);
        registryAdd(textBlockId, textMesh, deps, textContentHash);
      }
      return tagBlockId(textMesh, node);
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) return null;
      // If any child needs field eval, mesh the whole translate
      if (needsFieldEval(node)) {
        return tagBlockId(meshCSGNode(node), node);
      }
      const group = new THREE.Group();
      group.position.set(p.x || 0, p.y || 0, p.z || 0);
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return tagBlockId(group, node);
    }
    case 'paint': {
      if (needsFieldEval(node)) return tagBlockId(meshCSGNode(node), node);
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
      const result = group.children.length === 1 ? group.children[0] : group;
      return tagBlockId(result, node);
    }
    case 'recolor': {
      if (needsFieldEval(node)) return tagBlockId(meshCSGNode(node), node);
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
      const result = group.children.length === 1 ? group.children[0] : group;
      return tagBlockId(result, node);
    }
    case 'union': {
      if (needsFieldEval(node)) {
        // If a direct child is anti/complement, its polarity must interact
        // with siblings — mesh the whole union as one SDF field.
        const children = nodeChildren(node);
        const hasAntiChild = children.some(c =>
          Array.isArray(c) && (c[0] === 'anti' || c[0] === 'complement'));
        if (hasAntiChild) {
          return tagBlockId(meshCSGNode(node), node);
        }
        // Otherwise, evaluate each child independently so each child's
        // meshCSGNode call can be cached separately.
        const group = new THREE.Group();
        for (const child of children) {
          const obj = evalNode(child);
          if (obj) group.add(obj);
        }
        return tagBlockId(group, node);
      }
      const group = new THREE.Group();
      for (const child of nodeChildren(node)) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return tagBlockId(group, node);
    }
    case 'scalar': {
      // Tagged scalars that survived to the evaluator — nothing to render
      return null;
    }
    case 'intersect':
    case 'anti':
    case 'complement': {
      return tagBlockId(meshCSGNode(node), node);
    }
    case 'fuse': {
      return tagBlockId(meshCSGNode(node), node);
    }
    case 'mirror':
    case 'rotate':
    case 'twist':
    case 'radial':
    case 'stretch':
    case 'tile':
    case 'bend':
    case 'taper': {
      return tagBlockId(meshCSGNode(node), node);
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
export function setResolution(n) {
  csgResolution = Math.max(16, n);
  // Resolution is part of memo content hash, so all entries are invalid
  sceneRegistry.clear();
  depsIndex.clear();
  memoTable.clear();
}

// Sample the CSG provenance field at each vertex and store as userData
function stampProvenance(mesh, csgField) {
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  const blockIds = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const r = csgField(pos.getX(i), pos.getY(i), pos.getZ(i));
    blockIds[i] = r.blockId || null;
  }
  mesh.userData.vertexBlockIds = blockIds;
}

// Build a provenance field from an AST for post-processing (progressive path)
export function buildProvenanceField(ast) {
  const field = evalCSGField(ast);
  return (x, y, z) => field(x, y, z).blockId || null;
}

function meshCSGNode(node) {
  const rootId = node._blockId;

  // Layer 1: scene registry — non-stale entry means geometry is still valid
  if (rootId) {
    const regEntry = sceneRegistry.get(rootId);
    if (regEntry && !regEntry.stale && regEntry.contentHash) {
      if (evalStats) evalStats.cacheHits++;
      // Mark this object as retained so viewport doesn't dispose it
      if (currentRetained) {
        regEntry.group.traverse(obj => currentRetained.add(obj));
      }
      return regEntry.group;
    }
  }

  // Layer 2: memo table — content-addressed lookup
  const contentHash = memoContentHash(node);
  const memoHit = memoLookup(contentHash);
  if (memoHit) {
    if (evalStats) evalStats.cacheHits++;
    // Register this result in the scene registry
    if (rootId) {
      const deps = new Set();
      collectBlockIds(node, deps);
      registryAdd(rootId, memoHit, deps, contentHash);
    }
    return memoHit;
  }

  // Helper: store result in both layers and return it
  function cacheAndReturn(result) {
    memoStore(contentHash, result);
    if (rootId) {
      const deps = new Set();
      collectBlockIds(node, deps);
      registryAdd(rootId, result, deps, contentHash);
    }
    return result;
  }

  // Cache miss — mesh from scratch
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
      return cacheAndReturn(meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField));
    }

    // For the solid mesh, the actual field is:
    //   polarity > 0  → distance  (the SDF)
    //   polarity <= 0 → abs(distance) + 0.01  (always positive → no surface)
    // So if the polarity interval is entirely <= 0, there's no solid surface.
    // If distance interval is entirely > 0, there's no surface either.
    // We return { distance: [lo, hi] } for the octree classifier.
    const solidIntervalField = (xIv, yIv, zIv) => {
      const r = intervalField(xIv, yIv, zIv);
      // No solid in this region — push distance positive
      if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
      // Entirely solid — use raw distance
      if (r.polarity[0] > 0) return r;
      // Polarity straddles: region contains a solid/cancelled boundary.
      // The solidField has a zero-crossing here even if the raw distance
      // interval is entirely negative. Force ambiguous classification.
      return {
        distance: [Math.min(r.distance[0], -0.01), Math.max(r.distance[1], 0.01)],
        polarity: r.polarity
      };
    };

    const leaves = buildOctree(solidIntervalField, bounds, depth, octreeStats);

    // buildOctree returns null if it bailed out (interval arithmetic wasn't helping)
    if (leaves === null) {
      if (evalStats) {
        octreeStats.bailedOut = true;
        evalStats.octree = octreeStats;
      }
      return cacheAndReturn(meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField));
    }

    const solidGeo = meshOctreeLeaves(leaves, solidField, bounds, depth, solidColorField, octreeStats);

    if (solidGeo.index && solidGeo.index.count > 0) {
      const solidMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide
      });
      const solidMesh = new THREE.Mesh(solidGeo, solidMat);
      stampProvenance(solidMesh, csgField);
      group.add(solidMesh);
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
    return cacheAndReturn(meshCSGNodeUniform(node, res, bounds, csgField, solidField, solidColorField, antiField));
  }

  return cacheAndReturn(group);
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
    const solidMesh = new THREE.Mesh(solidGeo, solidMat);
    stampProvenance(solidMesh, csgField);
    group.add(solidMesh);
  }

  const antiGeo = meshField(antiField, bounds, res);
  if (antiGeo.index && antiGeo.index.count > 0) {
    addAntiMesh(group, antiGeo);
  }

  return group;
}

// ---- Three-component CSG field evaluation ----
// Returns (x, y, z) => { polarity: -1|0|+1, distance: number, color: [r,g,b] }

function evalCSGField(node) {
  if (!node || !Array.isArray(node)) return () => EMPTY;
  const type = node[0];
  const bid = node._blockId || null;

  switch (type) {
    case 'sphere': {
      const r = node[1].radius || 15;
      return (x, y, z) => {
        const d = Math.sqrt(x*x + y*y + z*z) - r;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR, blockId: bid };
      };
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - s, qy = Math.abs(y) - s, qz = Math.abs(z) - s;
        const outside = Math.sqrt(Math.max(qx,0)**2 + Math.max(qy,0)**2 + Math.max(qz,0)**2);
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR, blockId: bid };
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
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR, blockId: bid };
      };
    }
    case 'text': {
      const content = node[1].content || 'Text';
      const fontSize = node[1].size || 20;
      const depth = node[1].depth || 4;
      const fontName = node[1].font || 'helvetiker';
      const font = getFont(fontName);
      const sdfResult = font ? getTextSDF(content, fontSize, depth, font) : null;

      if (sdfResult) {
        const sdfField = sdfResult.field;
        return (x, y, z) => {
          const d = sdfField(x, y, z);
          return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR, blockId: bid };
        };
      }
      // Font not loaded yet — box fallback (re-render will happen on font load)
      const hw = fontSize * content.length * 0.3;
      const hh = fontSize * 0.5;
      const hd = depth / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - hw, qy = Math.abs(y) - hh, qz = Math.abs(z) - hd;
        const outside = Math.sqrt(Math.max(qx,0)**2 + Math.max(qy,0)**2 + Math.max(qz,0)**2);
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR, blockId: bid };
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
        return { polarity: r.polarity, distance: r.distance, color, blockId: r.blockId };
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
        return { polarity: r.polarity, distance: r.distance, color: match ? toColor : r.color, blockId: r.blockId };
      };
    }
    case 'union': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgUnion(fields.map(f => f(x, y, z)));
    }
    case 'intersect': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgIntersect(fields.map(f => f(x, y, z)));
    }
    case 'anti': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        return { polarity: -r.polarity, distance: r.distance, color: r.color, blockId: r.blockId };
      };
    }
    case 'complement': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        const nd = -r.distance;
        return { polarity: nd <= 0 ? 1 : 0, distance: nd, color: r.color, blockId: r.blockId };
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
        // Provenance: pick the highest-weight contributor
        let bestWeight = -1, bestBlockId = null;
        for (let i = 0; i < results.length; i++) {
          if (weights[i] > bestWeight) { bestWeight = weights[i]; bestBlockId = results[i].blockId; }
        }
        return { polarity: Math.sign(pSum), distance: dist, color, blockId: bestBlockId };
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
        return { polarity: result.polarity, distance: result.distance * minScale, color: result.color, blockId: result.blockId };
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
        return { polarity: result.polarity, distance: result.distance * scale, color: result.color, blockId: result.blockId };
      };
    }
    default:
      return () => ({ polarity: 0, distance: 0, color: UNSET_COLOR, blockId: null });
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
  return { polarity: Math.sign(pSum), distance: best.distance, color, blockId: best.blockId };
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
  return { polarity: pProd, distance: best.distance, color, blockId: best.blockId };
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

// ---- Cache benchmark ----

const BENCH_MODELS = {
  '2-branch': `(union
  (intersect (cube 25) (sphere 18))
  (translate 40 0 0 (fuse :k 5 (cube 20) (sphere 12))))`,
  '3-branch': `(union
  (intersect (cube 25) (sphere 18))
  (translate 40 0 0 (fuse :k 5 (cube 20) (sphere 12)))
  (translate -40 0 0 (intersect (sphere 15) (anti (cube 10)))))`,
  '5-branch': `(union
  (intersect (cube 25) (sphere 18))
  (translate 40 0 0 (fuse :k 5 (cube 20) (sphere 12)))
  (translate -40 0 0 (intersect (sphere 15) (anti (cube 10))))
  (translate 0 40 0 (fuse :k 3 (cylinder 10 25) (sphere 14)))
  (translate 0 -40 0 (intersect (cube 20) (anti (cylinder 8 30)))))`,
  'text+csg': `(union
  (twist :axis "y" :rate 0.05
    (text "Hi" :size 20 :depth 4 :font "helvetiker"))
  (translate 40 0 0 (intersect (cube 25) (sphere 18))))`,
  'text-3br': `(union
  (twist :axis "y" :rate 0.05
    (text "Hi" :size 20 :depth 4 :font "helvetiker"))
  (translate 40 0 0 (intersect (cube 25) (sphere 18)))
  (translate -40 0 0 (fuse :k 5 (cube 20) (sphere 12))))`,
  'plaintext': `(union
  (sphere 15)
  (translate 0 0 20
    (text "Hello" :size 20 :depth 4 :font "helvetiker"))
  (translate 15 40 0
    (radial :axis "y" :count 6
      (translate 40 0 10
        (cube 25)))))`,
};

function tweakFirstBranch(sexpr) {
  return sexpr.replace('(cube 25)', '(cube 26)');
}

function disposeResult(result) {
  result.group.traverse(obj => {
    if (result.retained && result.retained.has(obj)) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material && obj.material.dispose) obj.material.dispose();
  });
}

export function benchCache(resOverride) {
  const res = resOverride || csgResolution;
  const savedRes = csgResolution;
  csgResolution = res;

  const results = [];

  for (const [name, sexpr] of Object.entries(BENCH_MODELS)) {
    const ast1 = expandAST(parseSExpr(sexpr));
    const ast2 = expandAST(parseSExpr(tweakFirstBranch(sexpr)));

    // Cold: clear everything, evaluate original
    clearSubtreeCache();
    const t0 = performance.now();
    const r1 = evaluate(ast1);
    const coldMs = performance.now() - t0;
    disposeResult(r1);

    // Warm: cache populated from ast1. Evaluate ast2 (one branch tweaked).
    // This simulates a param edit — notify would mark one branch stale,
    // then evaluate finds sibling branches in memo table.
    const t1 = performance.now();
    const r2 = evaluate(ast2);
    const warmMs = performance.now() - t1;
    const warmHits = r2.stats.cacheHits;
    disposeResult(r2);

    // Undo test: evaluate ast1 again (memo table should have it)
    const t1b = performance.now();
    const r1b = evaluate(ast1);
    const undoMs = performance.now() - t1b;
    const undoHits = r1b.stats.cacheHits;
    disposeResult(r1b);

    // Uncached: clear everything, evaluate ast2 from scratch
    clearSubtreeCache();
    const t2 = performance.now();
    const r3 = evaluate(ast2);
    const uncachedMs = performance.now() - t2;
    disposeResult(r3);

    const speedup = uncachedMs > 0 ? (uncachedMs / warmMs).toFixed(1) : 'n/a';
    const undoSpeedup = uncachedMs > 0 ? (uncachedMs / undoMs).toFixed(1) : 'n/a';

    results.push({
      model: name,
      coldMs: Math.round(coldMs),
      warmMs: Math.round(warmMs),
      warmHits,
      undoMs: Math.round(undoMs),
      undoHits,
      uncachedMs: Math.round(uncachedMs),
      speedup,
      undoSpeedup,
    });
  }

  clearSubtreeCache();
  csgResolution = savedRes;

  const p = (s, n) => String(s).padEnd(n);
  const lines = [`=== Subtree Cache Benchmark (res ${res}) ===`, ''];
  lines.push(p('Model', 12) + p('Cold', 9) + p('Edit', 9) + p('Hits', 6) + p('Undo', 9) + p('Hits', 6) + p('No-cache', 9) + p('Edit-X', 8) + 'Undo-X');
  lines.push('-'.repeat(76));
  for (const r of results) {
    lines.push(
      p(r.model, 12) +
      p(r.coldMs + 'ms', 9) +
      p(r.warmMs + 'ms', 9) +
      p(r.warmHits, 6) +
      p(r.undoMs + 'ms', 9) +
      p(r.undoHits, 6) +
      p(r.uncachedMs + 'ms', 9) +
      p(r.speedup + 'x', 8) +
      r.undoSpeedup + 'x'
    );
  }
  lines.push('');
  lines.push('Cold     = first eval, empty cache');
  lines.push('Edit     = eval after tweaking one branch (siblings cached)');
  lines.push('Undo     = eval original again (memo table should have it)');
  lines.push('No-cache = same edit, all caches cleared');
  lines.push('Edit-X   = No-cache / Edit  (higher = better)');
  lines.push('Undo-X   = No-cache / Undo  (higher = better, BDD-style reuse)');

  const formatted = lines.join('\n');
  console.log(formatted);
  return { results, formatted };
}

// Re-exports from extracted modules
export { evalField } from './eval/sdf-field.js';
export { estimateBounds } from './eval/bounds.js';
export { addAntiMesh, getAntiCheckerSize, setAntiCheckerSize, getAntiWireframeMode, setAntiWireframeMode, cycleAntiWireframeMode } from './eval/anti-mesh.js';
export { setOnFontLoaded } from './eval/font-cache.js';
