#!/usr/bin/env node
// Debug: simulate buildOctree DFS for radial and track cull ratio at each depth-3 check

import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { estimateBounds } from '../src/csg-field.js';
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

let nodesVisited = 0, nodesCulledOutside = 0, nodesCulledInside = 0;
let bailedOut = false;

function recurse(x0, y0, z0, x1, y1, z1, depth) {
  if (bailedOut) return;
  nodesVisited++;

  const result = solidIntervalField([x0, x1], [y0, y1], [z0, z1]);
  const cls = classify(result.distance);

  if (cls === 'outside') { nodesCulledOutside++; return; }
  if (cls === 'inside') { nodesCulledInside++; return; }

  if (depth === 3) {
    const totalCulled = nodesCulledOutside + nodesCulledInside;
    const ratio = nodesVisited > 0 ? totalCulled / nodesVisited : 0;
    const pct = Math.round(100 * ratio);
    console.log(`  depth-3 check #${nodesVisited}: visited=${nodesVisited} culled=${totalCulled} ratio=${pct}% ${nodesVisited > 8 && ratio < 0.1 ? '→ WOULD BAIL' : '→ OK'}`);
    if (nodesVisited > 8 && ratio < 0.1) {
      bailedOut = true;
      return;
    }
    return; // don't recurse further
  }

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

console.log(`\nFinal: visited=${nodesVisited} bailedOut=${bailedOut}`);
