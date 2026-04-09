// Web Worker for off-thread mesh computation.
// Receives an AST + resolution + depth, runs the full octree+surface-nets pipeline,
// returns raw typed arrays for the main thread to wrap in Three.js geometry.

import { evalCSGFieldInterval, setTextBoundsProvider } from './interval-eval.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth, depthForBounds, resToVoxelSize, perAxisResolution } from './octree-core.js';
import { evalCSGField, estimateBounds, UNSET_COLOR, UNSET_RGB, setTextSDFGrids, getTextGridBounds } from './csg-field.js';

// Wire up the text bounds provider so the interval evaluator can use
// the actual SDF grid bounds (set via setTextSDFGrids) for text nodes.
setTextBoundsProvider(getTextGridBounds);

// --- Worker message handler ---

self.onmessage = function(e) {
  const { id, ast, depth: legacyDepth, resolution, useOctree, textSDFGrids } = e.data;

  // Install text SDF grids so evalCSGField can use them
  if (textSDFGrids) setTextSDFGrids(textSDFGrids);
  const t0 = performance.now();

  try {
    const bounds = estimateBounds(ast);
    // Use absolute voxel sizing: compute depth from bounds so that
    // detail is consistent regardless of bounding box size.
    // Fall back to legacy depth for backwards compatibility.
    const depth = resolution ? depthForBounds(bounds, resolution) : legacyDepth;
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
      // Uniform fallback with per-axis resolution for non-cubic bounds
      const voxelSize = resToVoxelSize(resolution);
      const fallbackRes = perAxisResolution(bounds, voxelSize, 256 * 256 * 256);
      solidRaw = meshFieldRaw(solidField, bounds, fallbackRes, solidColorField);
      stats.pointEvals = (fallbackRes[0] + 1) * (fallbackRes[1] + 1) * (fallbackRes[2] + 1);
    }

    // Anti-solid (always uniform, per-axis, capped)
    const antiVoxelSize = resToVoxelSize(resolution);
    const antiRes = perAxisResolution(bounds, antiVoxelSize, 48 * 48 * 48);
    const antiRaw = meshFieldRaw(antiField, bounds, antiRes, null);
    stats.pointEvals += (antiRes[0] + 1) * (antiRes[1] + 1) * (antiRes[2] + 1);

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
