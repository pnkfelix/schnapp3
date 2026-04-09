// Octree core — pure computation, no Three.js dependency.
// Shared between main thread and Web Workers.

import { classify } from './interval.js';

// Bail-out threshold: if shallow octree culls fewer than this fraction of
// nodes, fall back to uniform grid (the interval-eval overhead isn't worth it).
const BAILOUT_CHECK_DEPTH = 3;
const BAILOUT_MIN_CULL_RATIO = 0.3;

export function buildOctree(intervalField, bounds, maxDepth, stats) {
  const minX = bounds.min[0], minY = bounds.min[1], minZ = bounds.min[2];
  const maxX = bounds.max[0], maxY = bounds.max[1], maxZ = bounds.max[2];

  // Phase 1: shallow pass to BAILOUT_CHECK_DEPTH to decide if octree is useful.
  // This avoids the DFS pollution problem where deeper exploration dilutes the
  // cull ratio before all shallow nodes have been checked.
  if (maxDepth > BAILOUT_CHECK_DEPTH && stats) {
    let shallowVisited = 0, shallowCulled = 0;
    function shallowCheck(x0, y0, z0, x1, y1, z1, depth) {
      shallowVisited++;
      const result = intervalField([x0, x1], [y0, y1], [z0, z1]);
      const cls = classify(result.distance);
      if (cls === 'outside' || cls === 'inside') { shallowCulled++; return; }
      if (depth >= BAILOUT_CHECK_DEPTH) return;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
      shallowCheck(x0, y0, z0, mx, my, mz, depth + 1);
      shallowCheck(mx, y0, z0, x1, my, mz, depth + 1);
      shallowCheck(x0, my, z0, mx, y1, mz, depth + 1);
      shallowCheck(mx, my, z0, x1, y1, mz, depth + 1);
      shallowCheck(x0, y0, mz, mx, my, z1, depth + 1);
      shallowCheck(mx, y0, mz, x1, my, z1, depth + 1);
      shallowCheck(x0, my, mz, mx, y1, z1, depth + 1);
      shallowCheck(mx, my, mz, x1, y1, z1, depth + 1);
    }
    shallowCheck(minX, minY, minZ, maxX, maxY, maxZ, 0);
    const shallowRatio = shallowVisited > 0 ? shallowCulled / shallowVisited : 0;
    if (stats) stats.shallowCullRatio = shallowRatio;
    if (shallowVisited > 8 && shallowRatio < BAILOUT_MIN_CULL_RATIO) {
      stats.bailedOut = true;
      return null;
    }
  }

  // Phase 2: full octree build (no bail-out check needed, already passed)
  const leaves = [];

  function recurse(x0, y0, z0, x1, y1, z1, depth) {
    if (stats) stats.nodesVisited++;

    const result = intervalField([x0, x1], [y0, y1], [z0, z1]);
    const cls = classify(result.distance);

    if (cls === 'outside') { if (stats) stats.nodesCulledOutside++; return; }
    if (cls === 'inside') { if (stats) stats.nodesCulledInside++; return; }

    if (depth >= maxDepth) {
      leaves.push({ x0, y0, z0, x1, y1, z1 });
      if (stats) stats.leafCells++;
      return;
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

  recurse(minX, minY, minZ, maxX, maxY, maxZ, 0);
  return leaves;
}

export function meshOctreeLeavesRaw(leaves, pointField, bounds, maxDepth, colorField, stats) {
  if (leaves.length === 0) {
    return { positions: new Float32Array(0), normals: new Float32Array(0), faces: [], colors: null };
  }

  const n = 1 << maxDepth;
  const minX = bounds.min[0], minY = bounds.min[1], minZ = bounds.min[2];
  const maxX = bounds.max[0], maxY = bounds.max[1], maxZ = bounds.max[2];
  const sx = (maxX - minX) / n, sy = (maxY - minY) / n, sz = (maxZ - minZ) / n;

  const activeCells = new Set();
  for (const leaf of leaves) {
    const ix = Math.round((leaf.x0 - minX) / sx);
    const iy = Math.round((leaf.y0 - minY) / sy);
    const iz = Math.round((leaf.z0 - minZ) / sz);
    if (ix >= 0 && ix < n && iy >= 0 && iy < n && iz >= 0 && iz < n)
      activeCells.add(ix + iy * n + iz * n * n);
  }
  if (stats) stats.activeCells = activeCells.size;

  const extendedCells = new Set(activeCells);
  for (const key of activeCells) {
    const iz = Math.floor(key / (n * n));
    const iy = Math.floor((key - iz * n * n) / n);
    const ix = key - iz * n * n - iy * n;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx2 = ix + dx, ny2 = iy + dy, nz2 = iz + dz;
          if (nx2 >= 0 && nx2 < n && ny2 >= 0 && ny2 < n && nz2 >= 0 && nz2 < n)
            extendedCells.add(nx2 + ny2 * n + nz2 * n * n);
        }
  }

  const gn = n + 1;
  const sampledPoints = new Map();
  function samplePoint(gx, gy, gz) {
    const key = gx + gy * gn + gz * gn * gn;
    if (sampledPoints.has(key)) return sampledPoints.get(key);
    const val = pointField(minX + gx * sx, minY + gy * sy, minZ + gz * sz);
    sampledPoints.set(key, val);
    return val;
  }

  const cornerOff = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

  const vertIndex = new Map();
  const verts = [];

  for (const cellKey of activeCells) {
    const iz = Math.floor(cellKey / (n * n));
    const iy = Math.floor((cellKey - iz * n * n) / n);
    const ix = cellKey - iz * n * n - iy * n;
    const vals = cornerOff.map(([dx,dy,dz]) => samplePoint(ix+dx, iy+dy, iz+dz));

    let hasNeg = false, hasPos = false;
    for (const v of vals) { if (v < 0) hasNeg = true; else hasPos = true; }
    if (!hasNeg || !hasPos) continue;

    let px = 0, py = 0, pz = 0, count = 0;
    for (const [a, b] of edges) {
      if ((vals[a] < 0) !== (vals[b] < 0)) {
        const t = vals[a] / (vals[a] - vals[b]);
        const ca = cornerOff[a], cb = cornerOff[b];
        px += minX + (ix + ca[0] + t * (cb[0] - ca[0])) * sx;
        py += minY + (iy + ca[1] + t * (cb[1] - ca[1])) * sy;
        pz += minZ + (iz + ca[2] + t * (cb[2] - ca[2])) * sz;
        count++;
      }
    }
    vertIndex.set(cellKey, verts.length / 3);
    verts.push(px / count, py / count, pz / count);
  }
  if (stats) stats.surfaceVerts = verts.length / 3;

  const faces = [];
  function ci(x, y, z) {
    if (x < 0 || x >= n || y < 0 || y >= n || z < 0 || z >= n) return -1;
    return vertIndex.get(x + y * n + z * n * n) ?? -1;
  }
  function quad(c0, c1, c2, c3, flip) {
    const i0 = ci(...c0), i1 = ci(...c1), i2 = ci(...c2), i3 = ci(...c3);
    if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0) return;
    if (flip) faces.push(i0, i2, i1, i0, i3, i2);
    else faces.push(i0, i1, i2, i0, i2, i3);
  }

  for (const cellKey of extendedCells) {
    const iz = Math.floor(cellKey / (n * n));
    const iy = Math.floor((cellKey - iz * n * n) / n);
    const ix = cellKey - iz * n * n - iy * n;

    if (ix < n && iy > 0 && iz > 0) {
      const v0 = samplePoint(ix, iy, iz), v1 = samplePoint(ix + 1, iy, iz);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix, iy-1, iz-1], [ix, iy, iz-1], [ix, iy, iz], [ix, iy-1, iz], v0 >= 0);
    }
    if (iy < n && ix > 0 && iz > 0) {
      const v0 = samplePoint(ix, iy, iz), v1 = samplePoint(ix, iy + 1, iz);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix-1, iy, iz-1], [ix, iy, iz-1], [ix, iy, iz], [ix-1, iy, iz], v0 >= 0);
    }
    if (iz < n && ix > 0 && iy > 0) {
      const v0 = samplePoint(ix, iy, iz), v1 = samplePoint(ix, iy, iz + 1);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix-1, iy-1, iz], [ix, iy-1, iz], [ix, iy, iz], [ix-1, iy, iz], v0 >= 0);
    }
  }

  const eps = Math.min(sx, sy, sz) * 0.5;
  const normals = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i+1], z = verts[i+2];
    let nx = pointField(x + eps, y, z) - pointField(x - eps, y, z);
    let ny = pointField(x, y + eps, z) - pointField(x, y - eps, z);
    let nz = pointField(x, y, z + eps) - pointField(x, y, z - eps);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len; normals[i+1] = ny / len; normals[i+2] = nz / len;
  }

  const positions = new Float32Array(verts);
  let colors = null;
  if (colorField) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const [r, g, b] = colorField(verts[i], verts[i+1], verts[i+2]);
      colors[i] = r; colors[i+1] = g; colors[i+2] = b;
    }
  }

  if (stats) { stats.pointEvals = sampledPoints.size; stats.faces = faces.length / 3; }
  return { positions, normals, faces, colors };
}

// Pure computation version of meshFieldRaw (uniform grid, no Three.js)
export function meshFieldRaw(field, bounds, resolution, colorField) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const n = resolution;
  const sx = (maxX - minX) / n, sy = (maxY - minY) / n, sz = (maxZ - minZ) / n;

  const gn = n + 1;
  const grid = new Float32Array(gn * gn * gn);
  for (let z = 0; z < gn; z++)
    for (let y = 0; y < gn; y++)
      for (let x = 0; x < gn; x++)
        grid[x + y * gn + z * gn * gn] = field(minX + x * sx, minY + y * sy, minZ + z * sz);

  const g = (x, y, z) => grid[x + y * gn + z * gn * gn];
  const vertIndex = new Int32Array(n * n * n).fill(-1);
  const verts = [];
  const cornerOff = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edgeList = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

  for (let cz = 0; cz < n; cz++)
    for (let cy = 0; cy < n; cy++)
      for (let cx = 0; cx < n; cx++) {
        const vals = cornerOff.map(([dx,dy,dz]) => g(cx+dx, cy+dy, cz+dz));
        let hasNeg = false, hasPos = false;
        for (const v of vals) { if (v < 0) hasNeg = true; else hasPos = true; }
        if (!hasNeg || !hasPos) continue;

        let px = 0, py = 0, pz = 0, count = 0;
        for (const [a, b] of edgeList) {
          if ((vals[a] < 0) !== (vals[b] < 0)) {
            const t = vals[a] / (vals[a] - vals[b]);
            const ca = cornerOff[a], cb = cornerOff[b];
            px += minX + (cx + ca[0] + t * (cb[0] - ca[0])) * sx;
            py += minY + (cy + ca[1] + t * (cb[1] - ca[1])) * sy;
            pz += minZ + (cz + ca[2] + t * (cb[2] - ca[2])) * sz;
            count++;
          }
        }
        vertIndex[cx + cy * n + cz * n * n] = verts.length / 3;
        verts.push(px / count, py / count, pz / count);
      }

  const ci = (x, y, z) => vertIndex[x + y * n + z * n * n];
  const faces = [];
  function quad(c0, c1, c2, c3, flip) {
    const i0 = ci(...c0), i1 = ci(...c1), i2 = ci(...c2), i3 = ci(...c3);
    if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0) return;
    if (flip) faces.push(i0, i2, i1, i0, i3, i2);
    else faces.push(i0, i1, i2, i0, i2, i3);
  }

  for (let iz = 1; iz < n; iz++)
    for (let iy = 1; iy < n; iy++)
      for (let ix = 0; ix < n; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix+1,iy,iz) < 0))
          quad([ix,iy-1,iz-1],[ix,iy,iz-1],[ix,iy,iz],[ix,iy-1,iz], g(ix,iy,iz) >= 0);

  for (let iz = 1; iz < n; iz++)
    for (let iy = 0; iy < n; iy++)
      for (let ix = 1; ix < n; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix,iy+1,iz) < 0))
          quad([ix-1,iy,iz-1],[ix,iy,iz-1],[ix,iy,iz],[ix-1,iy,iz], g(ix,iy,iz) >= 0);

  for (let iz = 0; iz < n; iz++)
    for (let iy = 1; iy < n; iy++)
      for (let ix = 1; ix < n; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix,iy,iz+1) < 0))
          quad([ix-1,iy-1,iz],[ix,iy-1,iz],[ix,iy,iz],[ix-1,iy,iz], g(ix,iy,iz) >= 0);

  const normals = new Float32Array(verts.length);
  const eps = Math.min(sx, sy, sz) * 0.5;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i+1], z = verts[i+2];
    let nx = field(x + eps, y, z) - field(x - eps, y, z);
    let ny = field(x, y + eps, z) - field(x, y - eps, z);
    let nz = field(x, y, z + eps) - field(x, y, z - eps);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len; normals[i+1] = ny / len; normals[i+2] = nz / len;
  }

  const positions = new Float32Array(verts);
  let colors = null;
  if (colorField) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const [r, g, b] = colorField(verts[i], verts[i+1], verts[i+2]);
      colors[i] = r; colors[i+1] = g; colors[i+2] = b;
    }
  }

  return { positions, normals, faces, colors };
}

export function resToDepth(resolution) {
  return Math.max(3, Math.ceil(Math.log2(resolution)));
}

// Absolute voxel size: resolution controls detail per world unit.
// At resolution R, voxelSize = UNIT_SIZE / R.
// A 20-unit cube at res 48 gets ~20 voxels across (voxelSize ≈ 1.0).
const UNIT_SIZE = 48;  // so that res 48 → voxelSize = 1.0
const MAX_DEPTH = 10;  // cap at 1024 cells per axis

// Compute a fixed voxel size from the resolution setting.
// This size never changes regardless of the bounding box.
export function resToVoxelSize(resolution) {
  return UNIT_SIZE / resolution;
}

// Compute the octree depth needed for a given bounding box at a fixed voxel size.
// The depth is whatever it takes to achieve the target voxel size — no artificial caps.
export function depthForBounds(bounds, resolution) {
  const voxelSize = resToVoxelSize(resolution);
  const maxExtent = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  return Math.min(MAX_DEPTH, Math.max(3, Math.ceil(Math.log2(maxExtent / voxelSize))));
}
