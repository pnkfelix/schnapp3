import * as THREE from 'three';
import { addAntiMesh } from './evaluator.js';
import { getTextSDFGrid } from './eval/text-sdf.js';
import { getFont } from './eval/font-cache.js';

// Progressive refinement manager.
// Spawns parallel Web Workers at multiple octree depths, updating the display
// as each level completes. Lower depths finish first (blocky preview), higher
// depths refine the result.

// Cache-bust: force browser to re-fetch worker module (and its imports)
// when code changes. Bump this version string after editing worker-side files.
const WORKER_VERSION = '10';
const WORKER_URL = new URL(`./mesh-worker.js?v=${WORKER_VERSION}`, import.meta.url);

// Pool of reusable workers (one per hardware thread, capped)
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 6);
let workerPool = [];

// Track which version pooled workers were created with
let poolVersion = WORKER_VERSION;

function getWorker() {
  // If version changed (e.g. hot reload), discard stale pooled workers
  if (poolVersion !== WORKER_VERSION) {
    for (const w of workerPool) w.terminate();
    workerPool = [];
    poolVersion = WORKER_VERSION;
  }
  if (workerPool.length > 0) return workerPool.pop();
  return new Worker(WORKER_URL, { type: 'module' });
}

function returnWorker(w) {
  if (workerPool.length < MAX_WORKERS) {
    w.onmessage = null;
    w.onerror = null;
    workerPool.push(w);
  } else {
    w.terminate();
  }
}

// Generation counter — incremented on each new request. Workers from
// previous generations are ignored when their results arrive.
let currentGeneration = 0;

// Wrap raw mesh data into Three.js BufferGeometry
function rawToGeometry(raw) {
  if (!raw || !raw.positions || raw.positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(raw.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(raw.normals, 3));
  if (raw.colors) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(raw.colors, 3));
  }
  geo.setIndex(raw.faces);
  return geo;
}

// Build a Three.js Group from worker results, optionally stamping provenance
function buildGroup(solid, anti, provenanceField) {
  const group = new THREE.Group();

  const solidGeo = rawToGeometry(solid);
  if (solidGeo && solidGeo.index && solidGeo.index.count > 0) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(solidGeo, mat);
    if (provenanceField) {
      const pos = solidGeo.getAttribute('position');
      const blockIds = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        blockIds[i] = provenanceField(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
      mesh.userData.vertexBlockIds = blockIds;
    }
    group.add(mesh);
  }

  const antiGeo = rawToGeometry(anti);
  if (antiGeo && antiGeo.index && antiGeo.index.count > 0) {
    addAntiMesh(group, antiGeo);
  }

  return group;
}

// Main entry point. Fires off parallel workers at multiple depths.
// Calls onResult(group, depth, stats, isFinal) as each level completes,
// always in increasing-depth order (so later results are better quality).
// Calls onStatus(inFlightDepths) whenever a worker starts or finishes,
// so the caller can display which resolutions are being computed.
//
// Returns a cancel function.

// Collect all text nodes in an AST, returning their unique param sets.
function findTextNodes(node, found = new Map()) {
  if (!node || !Array.isArray(node)) return found;
  if (node[0] === 'text') {
    const p = node[1];
    const content = p.content || 'Text';
    const fontSize = p.size || 20;
    const depth = p.depth || 4;
    const fontName = p.font || 'helvetiker';
    const key = `${fontName}|${fontSize}|${depth}|${content}`;
    if (!found.has(key)) {
      found.set(key, { content, fontSize, depth, fontName });
    }
    return found;
  }
  // Recurse into children (skip params object at [1] if present)
  const start = (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) ? 2 : 1;
  for (let i = start; i < node.length; i++) {
    findTextNodes(node[i], found);
  }
  return found;
}

// Build SDF grids for all text nodes at a given resolution.
// Returns a plain object { key → { sdf, ox, oy, oz, nx, ny, nz, voxelSize } }
function buildTextSDFGrids(textNodes, resolution) {
  const grids = {};
  for (const [key, { content, fontSize, depth, fontName }] of textNodes) {
    const font = getFont(fontName);
    if (!font) continue; // font not loaded yet — will use box fallback in worker
    const grid = getTextSDFGrid(content, fontSize, depth, font, resolution);
    if (grid) grids[key] = grid;
  }
  return grids;
}

export function meshProgressive(ast, targetDepth, useOctree, onResult, onStatus, provenanceField) {
  const generation = ++currentGeneration;

  // Choose refinement levels: preview → every 2 depths → target
  const depths = [];
  const previewDepth = Math.max(3, Math.min(targetDepth - 2, 4));
  for (let d = previewDepth; d < targetDepth; d += 2) {
    depths.push(d);
  }
  if (depths[depths.length - 1] !== targetDepth) depths.push(targetDepth);

  const inFlight = new Set(depths);
  let bestDepthSoFar = -1;
  let activeWorkers = depths.length;
  let cancelled = false;
  const workers = [];

  // Collect text nodes that need SDF precomputation for workers
  const textNodes = findTextNodes(ast);

  function reportStatus() {
    if (onStatus && !cancelled && generation === currentGeneration) {
      onStatus([...inFlight].sort((a, b) => a - b));
    }
  }

  function handleResult(worker, depth) {
    return (e) => {
      returnWorker(worker);
      activeWorkers--;
      inFlight.delete(depth);
      reportStatus();

      if (cancelled || generation !== currentGeneration) return;

      const data = e.data;
      if (data.error) {
        console.warn(`Worker error at depth ${depth}:`, data.error);
        if (depth === targetDepth && bestDepthSoFar < 0) {
          onResult(new THREE.Group(), depth, null, true);
        }
        return;
      }

      if (data.depth <= bestDepthSoFar) return;
      bestDepthSoFar = data.depth;

      const group = buildGroup(data.solid, data.anti, provenanceField);
      const isFinal = (data.depth === targetDepth) || (activeWorkers === 0);

      onResult(group, data.depth, {
        meshTime: data.elapsed,
        octree: data.stats,
        depth: data.depth,
        resolution: 1 << data.depth
      }, isFinal);
    };
  }

  function handleError(worker, depth) {
    return (err) => {
      console.warn(`Worker crashed at depth ${depth}:`, err);
      returnWorker(worker);
      activeWorkers--;
      inFlight.delete(depth);
      reportStatus();
    };
  }

  function dispatchWorker(depth, textSDFGrids) {
    if (cancelled || generation !== currentGeneration) return;
    const worker = getWorker();
    workers.push(worker);
    worker.onmessage = handleResult(worker, depth);
    worker.onerror = handleError(worker, depth);

    const msg = { id: generation, ast, depth, useOctree };
    if (textSDFGrids && Object.keys(textSDFGrids).length > 0) {
      msg.textSDFGrids = textSDFGrids;
    }
    worker.postMessage(msg);
  }

  reportStatus();

  // Sequential dispatch: for each depth, precompute text SDF grids at matching
  // resolution (if any text nodes exist), then dispatch the worker.
  // setTimeout(0) between depths yields to the event loop so the UI stays
  // responsive during SDF computation. When there are no text nodes,
  // buildTextSDFGrids returns {} and the overhead is negligible.
  let depthIdx = 0;
  function dispatchNext() {
    if (cancelled || generation !== currentGeneration) return;
    if (depthIdx >= depths.length) return;
    const depth = depths[depthIdx++];
    // SDF grid must be higher-res than the octree to give smooth field values.
    // At equal resolution, the grid and octree cells align and produce noise.
    const sdfRes = Math.max(16, (1 << depth) * 2);
    const grids = buildTextSDFGrids(textNodes, sdfRes);
    dispatchWorker(depth, grids);
    if (depthIdx < depths.length) setTimeout(dispatchNext, 0);
  }
  dispatchNext();

  return () => {
    cancelled = true;
  };
}

// Clean up all workers on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const w of workerPool) w.terminate();
    workerPool = [];
  });
}
