#!/usr/bin/env node
// Benchmark: interval evaluator tightness and octree performance.
// Usage: node test/bench.js

import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { evalCSGField, estimateBounds } from '../src/csg-field.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth } from '../src/octree-core.js';

function bench(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const elapsed = performance.now() - t0;
  return { label, elapsed, ...result };
}

// Measure interval width at the top level (full bounding box)
function measureIntervalWidth(node) {
  const bounds = estimateBounds(node);
  const intervalField = evalCSGFieldInterval(node);
  const xIv = [bounds.min[0], bounds.max[0]];
  const yIv = [bounds.min[1], bounds.max[1]];
  const zIv = [bounds.min[2], bounds.max[2]];
  const result = intervalField(xIv, yIv, zIv);
  const dw = result.distance[1] - result.distance[0];
  return { distanceInterval: result.distance, width: dw };
}

// Run octree and report stats
function runOctree(node, depth) {
  const bounds = estimateBounds(node);
  const intervalField = evalCSGFieldInterval(node);
  const pointField = evalCSGField(node);

  const solidField = (x, y, z) => {
    const { polarity, distance } = pointField(x, y, z);
    if (polarity > 0) return distance;
    return Math.abs(distance) + 0.01;
  };
  const solidIntervalField = (xIv, yIv, zIv) => {
    const r = intervalField(xIv, yIv, zIv);
    if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
    return r;
  };

  const stats = {
    nodesVisited: 0, nodesCulledOutside: 0, nodesCulledInside: 0,
    leafCells: 0, activeCells: 0, surfaceVerts: 0, pointEvals: 0, faces: 0
  };

  const t0 = performance.now();
  const leaves = buildOctree(solidIntervalField, bounds, depth, stats);
  const octreeTime = performance.now() - t0;

  let meshTime = 0;
  let totalTime = 0;

  if (leaves !== null) {
    const t1 = performance.now();
    const raw = meshOctreeLeavesRaw(leaves, solidField, bounds, depth, null, stats);
    meshTime = performance.now() - t1;
    totalTime = octreeTime + meshTime;
  }

  // Also time uniform for comparison
  const res = 1 << depth;
  const t2 = performance.now();
  meshFieldRaw(solidField, bounds, res, null);
  const uniformTime = performance.now() - t2;

  const cullPct = stats.nodesVisited > 0
    ? Math.round(100 * (stats.nodesCulledOutside + stats.nodesCulledInside) / stats.nodesVisited)
    : 0;

  return {
    bailedOut: leaves === null,
    octreeTime: Math.round(octreeTime),
    meshTime: Math.round(meshTime),
    totalOctree: Math.round(totalTime),
    uniformTime: Math.round(uniformTime),
    speedup: totalTime > 0 ? (uniformTime / totalTime).toFixed(1) + 'x' : 'N/A (bail)',
    cullPct,
    nodesVisited: stats.nodesVisited,
    culled: stats.nodesCulledOutside + stats.nodesCulledInside,
    leafCells: stats.leafCells,
    pointEvals: stats.pointEvals
  };
}

// --- Test models ---

const models = {
  'sphere (simple)': ['sphere', { radius: 15 }],

  'cube (simple)': ['cube', { size: 20 }],

  'lizard (fused)': ['fuse', { k: 5 },
    ['translate', { x: 18, y: 0, z: 0 }, ['cube', { size: 10 }]],
    ['sphere', { radius: 15 }]
  ],

  'twisted cube': ['twist', { axis: 'y', rate: 0.15 }, ['cube', { size: 20 }]],

  'bent cube': ['bend', { axis: 'y', rate: 0.04 },
    ['cube', { size: 25 }]
  ],

  'radial spheres': ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ],

  'tapered cylinder': ['taper', { axis: 'y', rate: 0.03 },
    ['cylinder', { radius: 10, height: 40 }]
  ],

  'stretched sphere': ['stretch', { sx: 2, sy: 0.5, sz: 1 }, ['sphere', { radius: 12 }]],

  'tiled cube': ['tile', { axis: 'x', spacing: 30 }, ['cube', { size: 10 }]],

  'mirrored sphere': ['mirror', { axis: 'x' },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 8 }]]
  ],
};

console.log('=== Interval Width at Full Bounding Box ===\n');
for (const [name, node] of Object.entries(models)) {
  const { distanceInterval, width } = measureIntervalWidth(node);
  const status = width > 1000 ? ' ← BLOWN' : width > 100 ? ' ← wide' : '';
  console.log(`  ${name.padEnd(25)} dist=[${distanceInterval[0].toFixed(1)}, ${distanceInterval[1].toFixed(1)}]  width=${width.toFixed(1)}${status}`);
}

console.log('\n=== Octree Performance (depth 7 = res 128) ===\n');
const depth = 7;
for (const [name, node] of Object.entries(models)) {
  const r = runOctree(node, depth);
  const status = r.bailedOut ? 'BAIL' : 'OK';
  console.log(`  ${name.padEnd(25)} [${status}] cull=${r.cullPct}% octree=${r.octreeTime}ms mesh=${r.meshTime}ms total=${r.totalOctree}ms | uniform=${r.uniformTime}ms | speedup=${r.speedup} | leaves=${r.leafCells} evals=${r.pointEvals}`);
}

console.log('\n=== Octree Performance (depth 8 = res 256) ===\n');
const depth2 = 8;
for (const [name, node] of Object.entries(models)) {
  const r = runOctree(node, depth2);
  const status = r.bailedOut ? 'BAIL' : 'OK';
  console.log(`  ${name.padEnd(25)} [${status}] cull=${r.cullPct}% octree=${r.octreeTime}ms mesh=${r.meshTime}ms total=${r.totalOctree}ms | uniform=${r.uniformTime}ms | speedup=${r.speedup} | leaves=${r.leafCells} evals=${r.pointEvals}`);
}
