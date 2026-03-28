// Web Worker for off-thread mesh computation.
// Receives an AST + bounds + depth, runs the full octree+surface-nets pipeline,
// returns raw typed arrays for the main thread to wrap in Three.js geometry.

import { evalCSGFieldInterval } from './interval-eval.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth } from './octree-core.js';
import { evalCSGField, estimateBounds, UNSET_COLOR, UNSET_RGB } from './csg-field.js';

// --- Worker message handler ---

self.onmessage = function(e) {
  const { id, ast, depth, useOctree } = e.data;
  const t0 = performance.now();

  try {
    const bounds = estimateBounds(ast);
    const csgField = evalCSGField(ast);

    const solidField = (x, y, z) => {
      const { polarity, distance } = csgField(x, y, z);
      if (polarity > 0) return distance;
      return Math.abs(distance) + 0.01;
    };
    const solidColorField = (x, y, z) => {
      const c = csgField(x, y, z).color;
      return c === UNSET_COLOR ? UNSET_RGB : c;
    };
    const antiField = (x, y, z) => {
      const { polarity, distance } = csgField(x, y, z);
      if (polarity < 0) return distance;
      return Math.abs(distance) + 0.01;
    };

    const stats = {
      nodesVisited: 0, nodesCulledOutside: 0, nodesCulledInside: 0,
      leafCells: 0, activeCells: 0, surfaceVerts: 0, pointEvals: 0, faces: 0
    };

    let solidRaw;
    let usedOctree = false;
    let bailedOut = false;

    if (useOctree) {
      try {
        const intervalField = evalCSGFieldInterval(ast);
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

        const leaves = buildOctree(solidIntervalField, bounds, depth, stats);
        if (leaves !== null) {
          solidRaw = meshOctreeLeavesRaw(leaves, solidField, bounds, depth, solidColorField, stats);
          usedOctree = true;
        } else {
          bailedOut = true;
        }
      } catch (err) {
        // Interval eval failed — fall through to uniform
      }
    }

    if (!usedOctree) {
      // Uniform fallback at full requested resolution
      const fallbackRes = 1 << depth;
      solidRaw = meshFieldRaw(solidField, bounds, fallbackRes, solidColorField);
      stats.pointEvals = (fallbackRes + 1) ** 3;
    }

    // Anti-solid (always uniform, capped at reasonable res)
    const antiRes = Math.min(1 << depth, 48);
    const antiRaw = meshFieldRaw(antiField, bounds, antiRes, null);
    stats.pointEvals += (antiRes + 1) ** 3;

    const elapsed = Math.round(performance.now() - t0);

    // Transfer typed arrays for zero-copy
    const transferables = [solidRaw.positions.buffer, solidRaw.normals.buffer];
    if (solidRaw.colors) transferables.push(solidRaw.colors.buffer);
    if (antiRaw.positions.length > 0) {
      transferables.push(antiRaw.positions.buffer, antiRaw.normals.buffer);
    }

    self.postMessage({
      id, depth,
      solid: solidRaw,
      anti: antiRaw,
      stats: { ...stats, usedOctree, bailedOut },
      elapsed,
      bounds
    }, transferables);
  } catch (err) {
    self.postMessage({ id, depth, error: err.message });
  }
};
