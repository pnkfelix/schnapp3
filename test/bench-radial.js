#!/usr/bin/env node
// Focused benchmark: radial cull ratio at various depths

import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { evalCSGField, estimateBounds } from '../src/csg-field.js';
import { classify } from '../src/interval.js';

const node = ['radial', { axis: 'y', count: 6 },
  ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
];

const bounds = estimateBounds(node);
const intervalField = evalCSGFieldInterval(node);

const solidIntervalField = (xIv, yIv, zIv) => {
  const r = intervalField(xIv, yIv, zIv);
  if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
  return r;
};

// Count culling at each depth level
for (let maxDepth = 1; maxDepth <= 6; maxDepth++) {
  let visited = 0, culledOut = 0, culledIn = 0, ambig = 0;

  function recurse(x0, y0, z0, x1, y1, z1, depth) {
    visited++;
    const result = solidIntervalField([x0, x1], [y0, y1], [z0, z1]);
    const cls = classify(result.distance);

    if (cls === 'outside') { culledOut++; return; }
    if (cls === 'inside') { culledIn++; return; }

    if (depth >= maxDepth) { ambig++; return; }

    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
    recurse(x0, y0, z0, mx, my, mz, depth + 1);
    recurse(mx, y0, z0, x1, my, mz, depth + 1);
    recurse(x0, my, z0, mx, y1, mz, depth + 1);
    recurse(mx, my, z0, x1, y1, mz, depth + 1);
    recurse(x0, y0, mz, mx, my, z1, depth + 1);
    recurse(mx, y0, mz, x1, my, z1, depth + 1);
    recurse(x0, my, mz, mx, y1, z1, depth + 1);
    recurse(mx, my, mz, x1, y1, z1, depth + 1);
  }

  recurse(bounds.min[0], bounds.min[1], bounds.min[2],
          bounds.max[0], bounds.max[1], bounds.max[2], 0);

  const total = culledOut + culledIn;
  const pct = visited > 0 ? Math.round(100 * total / visited) : 0;
  console.log(`depth ${maxDepth}: visited=${visited} culled=${total} (${culledOut}out+${culledIn}in) ambig=${ambig} cull%=${pct}%`);
}

// Also check: what does the interval look like for a few representative cells at depth 3?
console.log('\n--- Sample intervals at depth 3 ---');
const n = 8; // 2^3
const sx = (bounds.max[0] - bounds.min[0]) / n;
const sy = (bounds.max[1] - bounds.min[1]) / n;
const sz = (bounds.max[2] - bounds.min[2]) / n;

for (let iz = 0; iz < n; iz += 2) {
  for (let ix = 0; ix < n; ix += 2) {
    const x0 = bounds.min[0] + ix * sx;
    const x1 = x0 + sx;
    const z0 = bounds.min[2] + iz * sz;
    const z1 = z0 + sz;
    const y0 = bounds.min[1];
    const y1 = y0 + sy;
    const r = solidIntervalField([x0, x1], [y0, y1], [z0, z1]);
    const cls = classify(r.distance);
    const dw = r.distance[1] - r.distance[0];
    console.log(`  cell (${ix},0,${iz}) x=[${x0.toFixed(1)},${x1.toFixed(1)}] z=[${z0.toFixed(1)},${z1.toFixed(1)}] → dist=[${r.distance[0].toFixed(1)},${r.distance[1].toFixed(1)}] w=${dw.toFixed(1)} → ${cls}`);
  }
}
