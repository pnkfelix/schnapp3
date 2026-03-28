#!/usr/bin/env node
// Diagnostic: measure interval width at different octree depths
// for each model type. This shows where intervals blow up.
// Run standalone: node test/fp-width-report.js

import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { evalCSGField, estimateBounds } from '../src/csg-field.js';
import { classify } from '../src/interval.js';

const models = {
  'sphere': ['sphere', { radius: 15 }],
  'cube': ['cube', { size: 20 }],
  'cylinder': ['cylinder', { radius: 10, height: 30 }],
  'translated sphere': ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 8 }]],
  'twisted cube': ['twist', { axis: 'y', rate: 0.15 }, ['cube', { size: 20 }]],
  'bent cube': ['bend', { axis: 'y', rate: 0.04 }, ['cube', { size: 25 }]],
  'radial 6-way': ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ],
  'tapered cyl': ['taper', { axis: 'y', rate: 0.03 },
    ['cylinder', { radius: 10, height: 40 }]
  ],
  'stretched sphere': ['stretch', { sx: 2, sy: 0.5, sz: 1 }, ['sphere', { radius: 12 }]],
};

console.log('=== Interval Width Analysis ===\n');

for (const [name, node] of Object.entries(models)) {
  const bounds = estimateBounds(node);
  const ivf = evalCSGFieldInterval(node);
  const pf = evalCSGField(node);

  const bx = bounds.max[0] - bounds.min[0];
  const by = bounds.max[1] - bounds.min[1];
  const bz = bounds.max[2] - bounds.min[2];

  console.log(`--- ${name} ---`);
  console.log(`  bounds: [${bounds.min}] → [${bounds.max}]  size: ${bx.toFixed(1)} × ${by.toFixed(1)} × ${bz.toFixed(1)}`);

  // At each depth, sample many cells and report statistics
  for (let depth = 1; depth <= 8; depth++) {
    const nx = 1 << depth;
    const sx = bx / nx, sy = by / nx, sz = bz / nx;

    let totalCells = 0, culledCells = 0, ambigCells = 0;
    let totalWidth = 0, maxWidth = 0, minWidth = Infinity;
    let containmentFailures = 0;

    // Sample a grid of cells (skip some at higher depths for speed)
    const step = depth <= 5 ? 1 : Math.max(1, Math.round(nx / 32));

    for (let iz = 0; iz < nx; iz += step) {
      for (let iy = 0; iy < nx; iy += step) {
        for (let ix = 0; ix < nx; ix += step) {
          const x0 = bounds.min[0] + ix * sx;
          const y0 = bounds.min[1] + iy * sy;
          const z0 = bounds.min[2] + iz * sz;
          const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;

          const r = ivf([x0, x1], [y0, y1], [z0, z1]);
          const cls = classify(r.distance);
          totalCells++;

          if (cls === 'outside' || cls === 'inside') {
            culledCells++;
          } else {
            ambigCells++;
            const w = r.distance[1] - r.distance[0];
            totalWidth += w;
            maxWidth = Math.max(maxWidth, w);
            minWidth = Math.min(minWidth, w);
          }

          // Spot-check containment at cell center
          if (totalCells % 17 === 0) {
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
            const pd = pf(cx, cy, cz);
            if (pd < r.distance[0] - 1e-10 || pd > r.distance[1] + 1e-10) {
              containmentFailures++;
            }
          }
        }
      }
    }

    const cullPct = totalCells > 0 ? (100 * culledCells / totalCells).toFixed(1) : '?';
    const avgWidth = ambigCells > 0 ? (totalWidth / ambigCells).toFixed(3) : '-';
    const maxW = maxWidth === 0 ? '-' : maxWidth.toFixed(3);
    const minW = minWidth === Infinity ? '-' : minWidth.toFixed(3);
    const cellDiag = Math.sqrt(sx*sx + sy*sy + sz*sz);
    const maxRatio = maxWidth > 0 ? (maxWidth / cellDiag).toFixed(1) : '-';

    console.log(`  depth ${depth}: cells=${totalCells} cull=${cullPct}% ambig=${ambigCells} ` +
      `width=[${minW}, ${avgWidth}, ${maxW}] cellDiag=${cellDiag.toFixed(2)} ratio=${maxRatio}` +
      (containmentFailures > 0 ? ` ⚠ ${containmentFailures} CONTAINMENT FAILURES` : ''));

    if (depth >= 7) break; // depth 8 uniform is too many cells to sample fully
  }
  console.log();
}

// Special analysis: where exactly does the radial interval blow up?
console.log('=== Radial Interval Deep Dive ===\n');
{
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  const bounds = estimateBounds(node);
  const ivf = evalCSGFieldInterval(node);
  const pf = evalCSGField(node);

  // At depth 7, sample cells near the expected object location (r≈12)
  const nx = 128;
  const bx = bounds.max[0] - bounds.min[0];
  const by = bounds.max[1] - bounds.min[1];
  const bz = bounds.max[2] - bounds.min[2];
  const sx = bx / nx, sy = by / nx, sz = bz / nx;

  console.log('Cells near r=12 (where spheres should be):');
  for (let iz = 0; iz < nx; iz += 16) {
    for (let ix = 0; ix < nx; ix += 16) {
      const x0 = bounds.min[0] + ix * sx;
      const z0 = bounds.min[2] + iz * sz;
      const y0 = -1, y1 = 1; // thin y slice
      const x1 = x0 + sx, z1 = z0 + sz;

      const r = Math.sqrt((x0 + sx/2)**2 + (z0 + sz/2)**2);
      if (r < 8 || r > 16) continue; // only near the ring

      const iv = ivf([x0, x1], [y0, y1], [z0, z1]);
      const cls = classify(iv.distance);
      const w = iv.distance[1] - iv.distance[0];

      console.log(`  cell (${ix},${iz}) center=(${(x0+sx/2).toFixed(1)}, ${(z0+sz/2).toFixed(1)}) r=${r.toFixed(1)} → dist=[${iv.distance[0].toFixed(2)}, ${iv.distance[1].toFixed(2)}] w=${w.toFixed(2)} → ${cls}`);
    }
  }
}
