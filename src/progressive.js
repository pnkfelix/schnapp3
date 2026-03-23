import * as THREE from 'three';

// Progressive refinement manager.
// Spawns parallel Web Workers at multiple octree depths, updating the display
// as each level completes. Lower depths finish first (blocky preview), higher
// depths refine the result.

const WORKER_URL = new URL('./mesh-worker.js', import.meta.url);

// Pool of reusable workers (one per hardware thread, capped)
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 6);
let workerPool = [];

function getWorker() {
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

// Build a Three.js Group from worker results
function buildGroup(solid, anti) {
  const group = new THREE.Group();

  const solidGeo = rawToGeometry(solid);
  if (solidGeo && solidGeo.index && solidGeo.index.count > 0) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });
    group.add(new THREE.Mesh(solidGeo, mat));
  }

  const antiGeo = rawToGeometry(anti);
  if (antiGeo && antiGeo.index && antiGeo.index.count > 0) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xcc4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    });
    group.add(new THREE.Mesh(antiGeo, mat));
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
export function meshProgressive(ast, targetDepth, useOctree, onResult, onStatus) {
  const generation = ++currentGeneration;

  // Choose refinement levels: preview → every 2 depths → target
  // e.g., target=6  → [4, 6]
  // e.g., target=8  → [4, 6, 8]
  // e.g., target=11 → [4, 6, 8, 10, 11]
  // Each depth doubles resolution, so each step is ~8× work (uniform) or ~4×
  // (octree). Intermediate levels are cheap relative to the final one — all
  // levels below the target combined cost <15% of the target level.
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

  function reportStatus() {
    if (onStatus && !cancelled && generation === currentGeneration) {
      onStatus([...inFlight].sort((a, b) => a - b));
    }
  }

  reportStatus(); // initial: all depths in flight

  for (const depth of depths) {
    const worker = getWorker();
    workers.push(worker);

    worker.onmessage = (e) => {
      returnWorker(worker);
      activeWorkers--;
      inFlight.delete(depth);
      reportStatus();

      // Ignore results from cancelled or superseded generations
      if (cancelled || generation !== currentGeneration) return;

      const data = e.data;
      if (data.error) {
        console.warn(`Worker error at depth ${depth}:`, data.error);
        // If this was the final depth and nothing better has arrived, report it
        if (depth === targetDepth && bestDepthSoFar < 0) {
          onResult(new THREE.Group(), depth, null, true);
        }
        return;
      }

      // Only accept results that improve on what we've already shown
      if (data.depth <= bestDepthSoFar) return;
      bestDepthSoFar = data.depth;

      const group = buildGroup(data.solid, data.anti);
      const isFinal = (data.depth === targetDepth) || (activeWorkers === 0);

      onResult(group, data.depth, {
        meshTime: data.elapsed,
        octree: data.stats,
        depth: data.depth,
        resolution: 1 << data.depth
      }, isFinal);
    };

    worker.onerror = (err) => {
      console.warn(`Worker crashed at depth ${depth}:`, err);
      returnWorker(worker);
      activeWorkers--;
      inFlight.delete(depth);
      reportStatus();
    };

    // Send the AST (it's plain JSON-serializable arrays)
    worker.postMessage({
      id: generation,
      ast,
      depth,
      useOctree
    });
  }

  // Return cancel function
  return () => {
    cancelled = true;
    for (const w of workers) {
      // Don't terminate — just let them finish and ignore results
      // (terminating prevents reuse and the worker might be almost done)
    }
  };
}

// Clean up all workers on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const w of workerPool) w.terminate();
    workerPool = [];
  });
}
