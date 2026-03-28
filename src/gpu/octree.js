// GPU octree evaluation: CPU interval arithmetic builds octree,
// sparse GPU dispatch evaluates surface points, surface nets meshes.

import * as THREE from 'three';
import { compileTape } from '../gpu-tape.js';
import { rawToGeometry } from '../surface-nets.js';
import { buildOctree, resToDepth } from '../octree-core.js';
import { evalCSGFieldInterval } from '../interval-eval.js';
import { addAntiMesh } from '../evaluator.js';
import { getDevice, getSparsePipeline } from './device.js';
import { gpuEvaluate } from './uniform.js';

// --- Sparse dispatch: evaluate tape at arbitrary coordinates ---

async function gpuDispatchSparsePoints(tape, coords, numPoints) {
  const device = getDevice();
  const sparsePipeline = getSparsePipeline();
  if (!device || !sparsePipeline) return null;

  const colorBufSize = numPoints * 3 * 4;
  const maxBuf = device.limits.maxStorageBufferBindingSize;
  if (colorBufSize > maxBuf) {
    throw new Error(`Sparse dispatch: color buffer ${(colorBufSize / 1e6).toFixed(1)}MB exceeds limit ${(maxBuf / 1e6).toFixed(1)}MB`);
  }

  console.log(`GPU sparse: ${numPoints} points, tape=${tape.length} f32s`);

  const paramsData = new ArrayBuffer(16);
  const paramsU32 = new Uint32Array(paramsData);
  paramsU32[0] = numPoints; paramsU32[1] = tape.length; paramsU32[2] = 0; paramsU32[3] = 0;

  const paramsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const tapeByteSize = Math.max(4, Math.ceil(tape.byteLength / 4) * 4);
  const tapeBuffer = device.createBuffer({ size: tapeByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(tapeBuffer, 0, tape);

  const coordsByteSize = Math.max(4, numPoints * 3 * 4);
  const coordsBuffer = device.createBuffer({ size: coordsByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(coordsBuffer, 0, coords);

  const distSize = numPoints * 4;
  const polSize = numPoints * 4;

  const distBuffer = device.createBuffer({ size: distSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const polBuffer = device.createBuffer({ size: polSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const colorBuffer = device.createBuffer({ size: colorBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  const distStaging = device.createBuffer({ size: distSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const polStaging = device.createBuffer({ size: polSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const colorStaging = device.createBuffer({ size: colorBufSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const bindGroup = device.createBindGroup({
    layout: sparsePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: tapeBuffer } },
      { binding: 2, resource: { buffer: coordsBuffer } },
      { binding: 3, resource: { buffer: distBuffer } },
      { binding: 4, resource: { buffer: polBuffer } },
      { binding: 5, resource: { buffer: colorBuffer } },
    ],
  });

  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  const workgroups = Math.ceil(numPoints / 64);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(sparsePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();

  encoder.copyBufferToBuffer(distBuffer, 0, distStaging, 0, distSize);
  encoder.copyBufferToBuffer(polBuffer, 0, polStaging, 0, polSize);
  encoder.copyBufferToBuffer(colorBuffer, 0, colorStaging, 0, colorBufSize);

  device.queue.submit([encoder.finish()]);

  const oomError = await device.popErrorScope();
  if (oomError) throw new Error(`GPU sparse OOM: ${oomError.message}`);
  const valError = await device.popErrorScope();
  if (valError) throw new Error(`GPU sparse validation: ${valError.message}`);

  await Promise.all([
    distStaging.mapAsync(GPUMapMode.READ),
    polStaging.mapAsync(GPUMapMode.READ),
    colorStaging.mapAsync(GPUMapMode.READ),
  ]);

  const distance = new Float32Array(distStaging.getMappedRange().slice(0));
  const polarity = new Float32Array(polStaging.getMappedRange().slice(0));
  const color = new Float32Array(colorStaging.getMappedRange().slice(0));

  distStaging.unmap(); polStaging.unmap(); colorStaging.unmap();

  paramsBuffer.destroy(); tapeBuffer.destroy(); coordsBuffer.destroy();
  distBuffer.destroy(); polBuffer.destroy(); colorBuffer.destroy();
  distStaging.destroy(); polStaging.destroy(); colorStaging.destroy();

  return { distance, polarity, color };
}

// --- Octree + GPU pipeline ---

export async function gpuEvaluateOctree(ast, resolution = 48) {
  if (!getDevice() || !getSparsePipeline()) return null;

  const compiled = compileTape(ast);
  if (!compiled) return null;
  const { tape, bounds } = compiled;

  const depth = resToDepth(resolution);
  return _gpuOctreeAtDepth(ast, tape, bounds, depth);
}

export function gpuEvaluateOctreeProgressive(ast, targetDepth, onResult, onStatus) {
  if (!getDevice() || !getSparsePipeline()) return () => {};

  let cancelled = false;

  const depths = [];
  const previewDepth = Math.max(3, Math.min(targetDepth - 2, 4));
  for (let d = previewDepth; d < targetDepth; d += 2) depths.push(d);
  if (depths[depths.length - 1] !== targetDepth) depths.push(targetDepth);

  (async () => {
    const compiled = compileTape(ast);
    if (!compiled) {
      onResult(new THREE.Group(), targetDepth, null, true);
      return;
    }
    const { tape, bounds } = compiled;

    if (onStatus) onStatus(depths.slice());

    for (let i = 0; i < depths.length; i++) {
      if (cancelled) return;

      const depth = depths[i];
      const isFinal = (i === depths.length - 1);

      try {
        const result = await _gpuOctreeAtDepth(ast, tape, bounds, depth);
        if (cancelled) return;

        if (result) {
          onResult(result.group, depth, {
            meshTime: result.stats.meshTime,
            octree: result.stats.octree,
            depth,
            resolution: 1 << depth
          }, isFinal);
        } else if (isFinal) {
          onResult(new THREE.Group(), depth, null, true);
        }
      } catch (e) {
        console.warn(`GPU progressive: depth ${depth} (res ${1 << depth}) failed:`, e.message);
        if (onStatus) onStatus([]);
        onResult(null, depth, null, true);
        return;
      }

      if (onStatus) {
        const remaining = depths.slice(i + 1);
        onStatus(remaining);
      }

      if (!isFinal && !cancelled) {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    }
  })();

  return () => { cancelled = true; };
}

async function _gpuOctreeAtDepth(ast, tape, bounds, depth) {
  const t0 = performance.now();
  const n = 1 << depth;
  const gn = n + 1;

  const totalGridPts = gn * gn * gn;
  const estimatedBytes = totalGridPts * 4;
  if (estimatedBytes > 1e9) {
    throw new Error(`Octree depth ${depth} (res ${n}) requires ~${(estimatedBytes / 1e9).toFixed(1)}GB for grid arrays — too large`);
  }

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;

  let intervalField;
  try {
    intervalField = evalCSGFieldInterval(ast);
  } catch (e) {
    console.warn('GPU octree: interval eval failed, falling back to uniform GPU:', e);
    return null;
  }

  const solidIntervalField = (xIv, yIv, zIv) => {
    const r = intervalField(xIv, yIv, zIv);
    if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
    if (r.polarity[0] > 0) return r;
    return {
      distance: [Math.min(r.distance[0], -0.01), Math.max(r.distance[1], 0.01)],
      polarity: r.polarity
    };
  };

  const octreeStats = {
    nodesVisited: 0, nodesCulledOutside: 0, nodesCulledInside: 0,
    leafCells: 0, activeCells: 0, surfaceVerts: 0, pointEvals: 0, faces: 0
  };

  const tOctree = performance.now();
  const leaves = buildOctree(solidIntervalField, bounds, depth, octreeStats);
  const octreeBuildMs = performance.now() - tOctree;

  if (leaves === null) {
    console.log('GPU octree: octree bailed out, falling back to uniform GPU');
    octreeStats.bailedOut = true;
    return gpuEvaluate(ast, n);
  }

  if (leaves.length === 0) {
    const group = new THREE.Group();
    const elapsed = Math.round(performance.now() - t0);
    return { group, stats: { meshTime: elapsed, resolution: n, voxels: 0, nodes: 0, gpu: true, octree: octreeStats } };
  }

  const totalCells = n * n * n;
  const cellFlags = new Uint8Array(totalCells);
  const activeCellList = [];

  for (const leaf of leaves) {
    const ix = Math.round((leaf.x0 - minX) / sx);
    const iy = Math.round((leaf.y0 - minY) / sy);
    const iz = Math.round((leaf.z0 - minZ) / sz);
    if (ix >= 0 && ix < n && iy >= 0 && iy < n && iz >= 0 && iz < n) {
      const key = ix + iy * n + iz * n * n;
      if (!cellFlags[key]) { cellFlags[key] = 1; activeCellList.push(key); }
    }
  }

  const extendedCellList = [...activeCellList];
  for (let ai = 0; ai < activeCellList.length; ai++) {
    const key = activeCellList[ai];
    const iz = (key / (n * n)) | 0;
    const iy = ((key - iz * n * n) / n) | 0;
    const ix = key - iz * n * n - iy * n;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx2 = ix + dx, ny2 = iy + dy, nz2 = iz + dz;
          if (nx2 >= 0 && nx2 < n && ny2 >= 0 && ny2 < n && nz2 >= 0 && nz2 < n) {
            const nk = nx2 + ny2 * n + nz2 * n * n;
            if (!cellFlags[nk]) { cellFlags[nk] = 2; extendedCellList.push(nk); }
          }
        }
  }

  const pointKeyToIdx = new Int32Array(totalGridPts).fill(-1);
  let numPoints = 0;

  for (let ci = 0; ci < extendedCellList.length; ci++) {
    const key = extendedCellList[ci];
    const iz = (key / (n * n)) | 0;
    const iy = ((key - iz * n * n) / n) | 0;
    const ix = key - iz * n * n - iy * n;
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const gx = ix + dx, gy = iy + dy, gz = iz + dz;
          const pk = gx + gy * gn + gz * gn * gn;
          if (pointKeyToIdx[pk] < 0) { pointKeyToIdx[pk] = numPoints++; }
        }
  }

  const coords = new Float32Array(numPoints * 3);
  for (let pk = 0; pk < totalGridPts; pk++) {
    const idx = pointKeyToIdx[pk];
    if (idx < 0) continue;
    const gz = (pk / (gn * gn)) | 0;
    const gy = ((pk - gz * gn * gn) / gn) | 0;
    const gx = pk - gz * gn * gn - gy * gn;
    coords[idx * 3] = minX + gx * sx;
    coords[idx * 3 + 1] = minY + gy * sy;
    coords[idx * 3 + 2] = minZ + gz * sz;
  }

  const tAfterCollect = performance.now();
  const collectMs = tAfterCollect - tOctree - octreeBuildMs;
  console.log(`GPU octree: ${leaves.length} leaves, ${activeCellList.length} active cells, ${numPoints} points to evaluate (vs ${gn*gn*gn} uniform)`);
  console.log(`GPU octree timing: octree build ${octreeBuildMs.toFixed(1)}ms, point collect ${collectMs.toFixed(1)}ms`);

  const tDispatch = performance.now();
  const gpuResult = await gpuDispatchSparsePoints(tape, coords, numPoints);
  const dispatchMs = performance.now() - tDispatch;
  if (!gpuResult) return null;

  octreeStats.pointEvals = numPoints;
  console.log(`GPU octree timing: GPU dispatch ${dispatchMs.toFixed(1)}ms`);

  const solidGrid = new Float32Array(totalGridPts).fill(1e10);
  const antiGrid = new Float32Array(totalGridPts).fill(1e10);
  const colorGrid = new Float32Array(totalGridPts * 3);
  for (let i = 0; i < totalGridPts; i++) {
    colorGrid[i * 3] = 0.667; colorGrid[i * 3 + 1] = 0.667; colorGrid[i * 3 + 2] = 0.667;
  }

  for (let pk = 0; pk < totalGridPts; pk++) {
    const idx = pointKeyToIdx[pk];
    if (idx < 0) continue;
    const pol = gpuResult.polarity[idx];
    const dist = gpuResult.distance[idx];
    solidGrid[pk] = pol > 0 ? dist : Math.abs(dist) + 0.01;
    antiGrid[pk] = pol < 0 ? dist : Math.abs(dist) + 0.01;
    colorGrid[pk * 3] = gpuResult.color[idx * 3];
    colorGrid[pk * 3 + 1] = gpuResult.color[idx * 3 + 1];
    colorGrid[pk * 3 + 2] = gpuResult.color[idx * 3 + 2];
  }

  const solidVal = (gx, gy, gz) => solidGrid[gx + gy * gn + gz * gn * gn];
  const colorVal = (gx, gy, gz) => {
    const pk = gx + gy * gn + gz * gn * gn;
    return [colorGrid[pk * 3], colorGrid[pk * 3 + 1], colorGrid[pk * 3 + 2]];
  };
  const antiVal = (gx, gy, gz) => antiGrid[gx + gy * gn + gz * gn * gn];

  const tMesh = performance.now();
  const group = new THREE.Group();
  const solidRaw = meshOctreeCellsFromGPU(activeCellList, extendedCellList, solidVal, colorVal, bounds, n);

  if (solidRaw && solidRaw.faces.length > 0) {
    const geo = rawToGeometry(solidRaw);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(geo, mat));
  }

  const antiRaw = meshOctreeCellsFromGPU(activeCellList, extendedCellList, antiVal, null, bounds, n);

  if (antiRaw && antiRaw.faces.length > 0) {
    const geo = rawToGeometry(antiRaw);
    addAntiMesh(group, geo);
  }

  const meshMs = performance.now() - tMesh;
  const elapsed = Math.round(performance.now() - t0);
  octreeStats.activeCells = activeCellList.length;
  console.log(`GPU octree timing: meshing ${meshMs.toFixed(1)}ms, total ${elapsed}ms`);

  return {
    group,
    stats: { meshTime: elapsed, resolution: n, voxels: numPoints, nodes: leaves.length, gpu: true, octree: octreeStats }
  };
}

function meshOctreeCellsFromGPU(activeCells, extendedCells, gridVal, colorGridVal, bounds, n) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;

  const cornerOff = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

  const totalCells = n * n * n;
  const vertIndex = new Int32Array(totalCells).fill(-1);
  const verts = [];

  for (let ci2 = 0; ci2 < activeCells.length; ci2++) {
    const cellKey = activeCells[ci2];
    const iz = (cellKey / (n * n)) | 0;
    const iy = ((cellKey - iz * n * n) / n) | 0;
    const ix = cellKey - iz * n * n - iy * n;

    const vals = cornerOff.map(([dx,dy,dz]) => gridVal(ix+dx, iy+dy, iz+dz));
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
    vertIndex[cellKey] = verts.length / 3;
    verts.push(px / count, py / count, pz / count);
  }

  const ci = (x, y, z) => {
    if (x < 0 || x >= n || y < 0 || y >= n || z < 0 || z >= n) return -1;
    return vertIndex[x + y * n + z * n * n];
  };
  const faces = [];
  function quad(c0, c1, c2, c3, flip) {
    const i0 = ci(...c0), i1 = ci(...c1), i2 = ci(...c2), i3 = ci(...c3);
    if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0) return;
    if (flip) faces.push(i0, i2, i1, i0, i3, i2);
    else faces.push(i0, i1, i2, i0, i2, i3);
  }

  for (let ei = 0; ei < extendedCells.length; ei++) {
    const cellKey = extendedCells[ei];
    const iz = (cellKey / (n * n)) | 0;
    const iy = ((cellKey - iz * n * n) / n) | 0;
    const ix = cellKey - iz * n * n - iy * n;

    if (ix < n && iy > 0 && iz > 0) {
      const v0 = gridVal(ix, iy, iz), v1 = gridVal(ix + 1, iy, iz);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix, iy-1, iz-1], [ix, iy, iz-1], [ix, iy, iz], [ix, iy-1, iz], v0 >= 0);
    }
    if (iy < n && ix > 0 && iz > 0) {
      const v0 = gridVal(ix, iy, iz), v1 = gridVal(ix, iy + 1, iz);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix-1, iy, iz-1], [ix, iy, iz-1], [ix, iy, iz], [ix-1, iy, iz], v0 >= 0);
    }
    if (iz < n && ix > 0 && iy > 0) {
      const v0 = gridVal(ix, iy, iz), v1 = gridVal(ix, iy, iz + 1);
      if ((v0 < 0) !== (v1 < 0))
        quad([ix-1, iy-1, iz], [ix, iy-1, iz], [ix, iy, iz], [ix-1, iy, iz], v0 >= 0);
    }
  }

  const gn = n + 1;
  const normals = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
    const gx = (wx - minX) / sx, gy = (wy - minY) / sy, gz = (wz - minZ) / sz;
    const gix = Math.floor(gx), giy = Math.floor(gy), giz = Math.floor(gz);
    const x0 = Math.max(0, gix - 1), x1 = Math.min(gn - 1, gix + 1);
    const y0 = Math.max(0, giy - 1), y1 = Math.min(gn - 1, giy + 1);
    const z0 = Math.max(0, giz - 1), z1 = Math.min(gn - 1, giz + 1);
    let nx = gridVal(x1, Math.min(giy, gn-1), Math.min(giz, gn-1)) - gridVal(x0, Math.min(giy, gn-1), Math.min(giz, gn-1));
    let ny = gridVal(Math.min(gix, gn-1), y1, Math.min(giz, gn-1)) - gridVal(Math.min(gix, gn-1), y0, Math.min(giz, gn-1));
    let nz = gridVal(Math.min(gix, gn-1), Math.min(giy, gn-1), z1) - gridVal(Math.min(gix, gn-1), Math.min(giy, gn-1), z0);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len; normals[i + 1] = ny / len; normals[i + 2] = nz / len;
  }

  let colors = null;
  if (colorGridVal) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
      const gx = (wx - minX) / sx, gy = (wy - minY) / sy, gz = (wz - minZ) / sz;
      const gix = Math.min(Math.max(Math.round(gx), 0), gn - 1);
      const giy = Math.min(Math.max(Math.round(gy), 0), gn - 1);
      const giz = Math.min(Math.max(Math.round(gz), 0), gn - 1);
      const [r, g, b] = colorGridVal(gix, giy, giz);
      colors[i] = r; colors[i + 1] = g; colors[i + 2] = b;
    }
  }

  return { positions: new Float32Array(verts), normals, faces, colors };
}
