// GPU uniform grid dispatch and meshing.
// Evaluates an AST on the GPU across a regular grid, then meshes via surface nets.

import * as THREE from 'three';
import { compileTape } from '../gpu-tape.js';
import { rawToGeometry } from '../surface-nets.js';
import { addAntiMesh } from '../evaluator.js';
import { getDevice, getGridPipeline } from './device.js';

export async function gpuDispatchTape(tape, bounds, resolution) {
  if (!getDevice() || !getGridPipeline()) return null;
  return _gpuDispatch(tape, bounds, resolution);
}

export async function gpuEvaluateField(ast, resolution) {
  if (!getDevice() || !getGridPipeline()) return null;
  const compiled = compileTape(ast);
  if (!compiled) return null;
  const { tape, bounds } = compiled;
  return _gpuDispatch(tape, bounds, resolution);
}

async function _gpuDispatch(tape, bounds, resolution) {
  const res = resolution;
  const gn = res + 1;
  const totalPoints = gn * gn * gn;

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const stepX = (maxX - minX) / res;
  const stepY = (maxY - minY) / res;
  const stepZ = (maxZ - minZ) / res;

  const device = getDevice();
  const pipeline = getGridPipeline();

  const colorBufSize = totalPoints * 3 * 4;
  const maxBuf = device.limits.maxStorageBufferBindingSize;
  if (colorBufSize > maxBuf) {
    throw new Error(`GPU resolution too high: color buffer ${(colorBufSize / 1e6).toFixed(1)}MB exceeds device limit ${(maxBuf / 1e6).toFixed(1)}MB. Max resolution ~${Math.floor(Math.cbrt(maxBuf / 12)) - 1}`);
  }

  console.log(`GPU eval: res=${res}, grid=${gn}³=${totalPoints} points, tape=${tape.length} f32s`);
  console.log(`GPU eval: bounds min=[${minX.toFixed(1)},${minY.toFixed(1)},${minZ.toFixed(1)}] max=[${maxX.toFixed(1)},${maxY.toFixed(1)},${maxZ.toFixed(1)}]`);

  const paramsData = new ArrayBuffer(48);
  const paramsU32 = new Uint32Array(paramsData);
  const paramsF32 = new Float32Array(paramsData);
  paramsU32[0] = gn; paramsU32[1] = gn; paramsU32[2] = gn;
  paramsF32[3] = minX; paramsF32[4] = minY; paramsF32[5] = minZ;
  paramsF32[6] = stepX; paramsF32[7] = stepY; paramsF32[8] = stepZ;
  paramsU32[9] = tape.length; paramsU32[10] = 0; paramsU32[11] = 0;

  const paramsBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const tapeByteSize = Math.max(4, Math.ceil(tape.byteLength / 4) * 4);
  const tapeBuffer = device.createBuffer({ size: tapeByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(tapeBuffer, 0, tape);

  const distSize = totalPoints * 4;
  const polSize = totalPoints * 4;
  const colorSize = totalPoints * 3 * 4;

  console.log(`GPU eval: buffer sizes dist=${distSize}, pol=${polSize}, color=${colorSize}`);

  const distBuffer = device.createBuffer({ size: distSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const polBuffer = device.createBuffer({ size: polSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const colorBuffer = device.createBuffer({ size: colorSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  const distStaging = device.createBuffer({ size: distSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const polStaging = device.createBuffer({ size: polSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const colorStaging = device.createBuffer({ size: colorSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: tapeBuffer } },
      { binding: 2, resource: { buffer: distBuffer } },
      { binding: 3, resource: { buffer: polBuffer } },
      { binding: 4, resource: { buffer: colorBuffer } },
    ],
  });

  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  const workgroups = Math.ceil(totalPoints / 64);
  console.log(`GPU eval: dispatching ${workgroups} workgroups`);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();

  encoder.copyBufferToBuffer(distBuffer, 0, distStaging, 0, distSize);
  encoder.copyBufferToBuffer(polBuffer, 0, polStaging, 0, polSize);
  encoder.copyBufferToBuffer(colorBuffer, 0, colorStaging, 0, colorSize);

  device.queue.submit([encoder.finish()]);

  const oomError = await device.popErrorScope();
  if (oomError) throw new Error(`GPU OOM: ${oomError.message}`);
  const valError = await device.popErrorScope();
  if (valError) throw new Error(`GPU validation: ${valError.message}`);

  console.log('GPU eval: dispatch succeeded, reading back...');

  await Promise.all([
    distStaging.mapAsync(GPUMapMode.READ),
    polStaging.mapAsync(GPUMapMode.READ),
    colorStaging.mapAsync(GPUMapMode.READ),
  ]);

  const distance = new Float32Array(distStaging.getMappedRange().slice(0));
  const polarity = new Float32Array(polStaging.getMappedRange().slice(0));
  const color = new Float32Array(colorStaging.getMappedRange().slice(0));

  distStaging.unmap(); polStaging.unmap(); colorStaging.unmap();

  paramsBuffer.destroy(); tapeBuffer.destroy();
  distBuffer.destroy(); polBuffer.destroy(); colorBuffer.destroy();
  distStaging.destroy(); polStaging.destroy(); colorStaging.destroy();

  return { distance, polarity, color, bounds, resolution: res };
}

export async function gpuEvaluate(ast, resolution = 48) {
  const t0 = performance.now();
  const field = await gpuEvaluateField(ast, resolution);
  if (!field) return null;

  const { distance, polarity, color, bounds } = field;
  const res = field.resolution;
  const gn = res + 1;

  const group = new THREE.Group();

  const solidGrid = new Float32Array(gn * gn * gn);
  for (let i = 0; i < solidGrid.length; i++) {
    solidGrid[i] = polarity[i] > 0 ? distance[i] : Math.abs(distance[i]) + 0.01;
  }

  const solidRaw = meshFromGrid(solidGrid, color, bounds, res);

  if (solidRaw && solidRaw.faces.length > 0) {
    const geo = rawToGeometry(solidRaw);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(geo, mat));
  }

  const antiGrid = new Float32Array(gn * gn * gn);
  let hasAnti = false;
  for (let i = 0; i < antiGrid.length; i++) {
    if (polarity[i] < 0) { antiGrid[i] = distance[i]; hasAnti = true; }
    else { antiGrid[i] = Math.abs(distance[i]) + 0.01; }
  }

  if (hasAnti) {
    const antiRaw = meshFromGrid(antiGrid, null, bounds, res);
    if (antiRaw && antiRaw.faces.length > 0) {
      const geo = rawToGeometry(antiRaw);
      addAntiMesh(group, geo);
    }
  }

  const elapsed = Math.round(performance.now() - t0);
  const stats = { meshTime: elapsed, resolution: res, voxels: gn * gn * gn, nodes: 0, octree: null, gpu: true };
  return { group, stats };
}

export function meshFromGrid(grid, colorData, bounds, resolution) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const n = resolution;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;
  const gn = n + 1;

  const g = (x, y, z) => grid[x + y * gn + z * gn * gn];

  const cornerOff = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

  const vertIndex = new Int32Array(n * n * n).fill(-1);
  const verts = [];

  for (let cz = 0; cz < n; cz++) {
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const vals = cornerOff.map(([dx,dy,dz]) => g(cx+dx, cy+dy, cz+dz));
        let hasNeg = false, hasPos = false;
        for (const v of vals) { if (v < 0) hasNeg = true; else hasPos = true; }
        if (!hasNeg || !hasPos) continue;

        let px = 0, py = 0, pz = 0, count = 0;
        for (const [a, b] of edges) {
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
    }
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
  for (let i = 0; i < verts.length; i += 3) {
    const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
    const gx = (wx - minX) / sx, gy = (wy - minY) / sy, gz = (wz - minZ) / sz;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const x0 = Math.max(0, ix - 1), x1 = Math.min(gn - 1, ix + 1);
    const y0 = Math.max(0, iy - 1), y1 = Math.min(gn - 1, iy + 1);
    const z0 = Math.max(0, iz - 1), z1 = Math.min(gn - 1, iz + 1);
    let nx = g(x1, Math.min(iy, gn-1), Math.min(iz, gn-1)) - g(x0, Math.min(iy, gn-1), Math.min(iz, gn-1));
    let ny = g(Math.min(ix, gn-1), y1, Math.min(iz, gn-1)) - g(Math.min(ix, gn-1), y0, Math.min(iz, gn-1));
    let nz = g(Math.min(ix, gn-1), Math.min(iy, gn-1), z1) - g(Math.min(ix, gn-1), Math.min(iy, gn-1), z0);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len; normals[i + 1] = ny / len; normals[i + 2] = nz / len;
  }

  let colors = null;
  if (colorData) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
      const gx = (wx - minX) / sx, gy = (wy - minY) / sy, gz = (wz - minZ) / sz;
      const ix = Math.min(Math.max(Math.round(gx), 0), gn - 1);
      const iy = Math.min(Math.max(Math.round(gy), 0), gn - 1);
      const iz = Math.min(Math.max(Math.round(gz), 0), gn - 1);
      const idx = ix + iy * gn + iz * gn * gn;
      colors[i] = colorData[idx * 3]; colors[i + 1] = colorData[idx * 3 + 1]; colors[i + 2] = colorData[idx * 3 + 2];
    }
  }

  return { positions: new Float32Array(verts), normals, faces, colors };
}
