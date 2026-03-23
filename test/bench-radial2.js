#!/usr/bin/env node
// Debug: what do the raw radial intervals look like (no polarity filter)?

import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { estimateBounds } from '../src/csg-field.js';
import { classify } from '../src/interval.js';

const node = ['radial', { axis: 'y', count: 6 },
  ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
];

const bounds = estimateBounds(node);
const intervalField = evalCSGFieldInterval(node);

// Sample a few cells at depth 3
const n = 8;
const sx = (bounds.max[0] - bounds.min[0]) / n;
const sy = (bounds.max[1] - bounds.min[1]) / n;
const sz = (bounds.max[2] - bounds.min[2]) / n;

console.log(`bounds: [${bounds.min}] → [${bounds.max}]`);
console.log(`cell size: ${sx.toFixed(1)} × ${sy.toFixed(1)} × ${sz.toFixed(1)}\n`);

for (let iy = 0; iy < n; iy += 4) {
  for (let iz = 0; iz < n; iz += 2) {
    for (let ix = 0; ix < n; ix += 2) {
      const x0 = bounds.min[0] + ix * sx, x1 = x0 + sx;
      const y0 = bounds.min[1] + iy * sy, y1 = y0 + sy;
      const z0 = bounds.min[2] + iz * sz, z1 = z0 + sz;
      const r = intervalField([x0, x1], [y0, y1], [z0, z1]);
      const dcls = classify(r.distance);
      console.log(`  (${ix},${iy},${iz}) x=[${x0.toFixed(1)},${x1.toFixed(1)}] z=[${z0.toFixed(1)},${z1.toFixed(1)}] → dist=[${r.distance[0].toFixed(2)},${r.distance[1].toFixed(2)}] pol=[${r.polarity}] → ${dcls}`);
    }
  }
  console.log();
}
