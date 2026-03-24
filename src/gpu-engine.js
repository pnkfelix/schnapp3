// WebGPU SDF evaluation engine.
// Compiles an AST to a tape, dispatches it on the GPU, reads back
// the distance/polarity/color fields, then meshes via surface nets.

import * as THREE from 'three';
import { compileTape } from './gpu-tape.js';
import { meshFieldRaw, rawToGeometry } from './surface-nets.js';

let gpuDevice = null;
let gpuPipeline = null;
let gpuShaderCode = null;
let gpuAvailable = null; // null = unknown, true/false after probe

// Probe for WebGPU support and cache the device.
export async function initGPU() {
  if (gpuAvailable !== null) return gpuAvailable;
  try {
    if (!navigator.gpu) { gpuAvailable = false; return false; }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) { gpuAvailable = false; return false; }
    gpuDevice = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: 256 * 1024 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
      }
    });
    gpuDevice.lost.then(() => {
      console.warn('WebGPU device lost');
      gpuDevice = null;
      gpuPipeline = null;
      gpuAvailable = null;
    });
    // Load shader
    gpuShaderCode = await fetchShader();
    gpuPipeline = createPipeline(gpuDevice, gpuShaderCode);
    gpuAvailable = true;
    return true;
  } catch (e) {
    console.warn('WebGPU init failed:', e);
    gpuAvailable = false;
    return false;
  }
}

async function fetchShader() {
  // Resolve relative to the module's own URL
  const base = new URL('.', import.meta.url);
  const url = new URL('gpu-sdf.wgsl', base);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load shader: ${resp.status}`);
  return resp.text();
}

function createPipeline(device, shaderCode) {
  const module = device.createShaderModule({ code: shaderCode });
  return device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });
}

// Evaluate an AST on the GPU at the given resolution.
// Returns { distance: Float32Array, polarity: Float32Array, color: Float32Array, bounds, resolution }
// or null if GPU is unavailable.
export async function gpuEvaluateField(ast, resolution) {
  if (!gpuDevice || !gpuPipeline) return null;

  const compiled = compileTape(ast);
  if (!compiled) return null;

  const { tape, bounds } = compiled;
  const res = resolution;
  const gn = res + 1; // grid points per axis
  const totalPoints = gn * gn * gn;

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const stepX = (maxX - minX) / res;
  const stepY = (maxY - minY) / res;
  const stepZ = (maxZ - minZ) / res;

  const device = gpuDevice;

  // Create uniform buffer (Params struct)
  const paramsData = new ArrayBuffer(48); // 12 fields * 4 bytes
  const paramsU32 = new Uint32Array(paramsData);
  const paramsF32 = new Float32Array(paramsData);
  paramsU32[0] = gn;           // grid_x
  paramsU32[1] = gn;           // grid_y
  paramsU32[2] = gn;           // grid_z
  paramsF32[3] = minX;         // min_x
  paramsF32[4] = minY;         // min_y
  paramsF32[5] = minZ;         // min_z
  paramsF32[6] = stepX;        // step_x
  paramsF32[7] = stepY;        // step_y
  paramsF32[8] = stepZ;        // step_z
  paramsU32[9] = tape.length;  // tape_len
  paramsU32[10] = 0;           // pad
  paramsU32[11] = 0;           // pad

  const paramsBuffer = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  // Tape buffer
  const tapeSize = Math.max(4, tape.byteLength); // min 4 bytes
  const tapeBuffer = device.createBuffer({
    size: tapeSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(tapeBuffer, 0, tape);

  // Output buffers
  const distSize = totalPoints * 4;
  const polSize = totalPoints * 4;
  const colorSize = totalPoints * 3 * 4;

  const distBuffer = device.createBuffer({
    size: distSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const polBuffer = device.createBuffer({
    size: polSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const colorBuffer = device.createBuffer({
    size: colorSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Staging buffers for readback
  const distStaging = device.createBuffer({
    size: distSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const polStaging = device.createBuffer({
    size: polSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const colorStaging = device.createBuffer({
    size: colorSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Bind group
  const bindGroup = device.createBindGroup({
    layout: gpuPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: tapeBuffer } },
      { binding: 2, resource: { buffer: distBuffer } },
      { binding: 3, resource: { buffer: polBuffer } },
      { binding: 4, resource: { buffer: colorBuffer } },
    ],
  });

  // Dispatch
  const workgroups = Math.ceil(totalPoints / 64);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(gpuPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();

  // Copy to staging
  encoder.copyBufferToBuffer(distBuffer, 0, distStaging, 0, distSize);
  encoder.copyBufferToBuffer(polBuffer, 0, polStaging, 0, polSize);
  encoder.copyBufferToBuffer(colorBuffer, 0, colorStaging, 0, colorSize);

  device.queue.submit([encoder.finish()]);

  // Read back
  await Promise.all([
    distStaging.mapAsync(GPUMapMode.READ),
    polStaging.mapAsync(GPUMapMode.READ),
    colorStaging.mapAsync(GPUMapMode.READ),
  ]);

  const distance = new Float32Array(distStaging.getMappedRange().slice(0));
  const polarity = new Float32Array(polStaging.getMappedRange().slice(0));
  const color = new Float32Array(colorStaging.getMappedRange().slice(0));

  distStaging.unmap();
  polStaging.unmap();
  colorStaging.unmap();

  // Clean up GPU buffers
  paramsBuffer.destroy();
  tapeBuffer.destroy();
  distBuffer.destroy();
  polBuffer.destroy();
  colorBuffer.destroy();
  distStaging.destroy();
  polStaging.destroy();
  colorStaging.destroy();

  return { distance, polarity, color, bounds, resolution: res };
}

// Full GPU pipeline: AST → GPU field → surface nets → Three.js Group
export async function gpuEvaluate(ast, resolution = 48) {
  const t0 = performance.now();
  const field = await gpuEvaluateField(ast, resolution);
  if (!field) return null;

  const { distance, polarity, color, bounds } = field;
  const res = field.resolution;
  const gn = res + 1;

  const group = new THREE.Group();

  // Solid field: polarity > 0 → distance, else push outside
  const solidGrid = new Float32Array(gn * gn * gn);
  for (let i = 0; i < solidGrid.length; i++) {
    solidGrid[i] = polarity[i] > 0 ? distance[i] : Math.abs(distance[i]) + 0.01;
  }

  // Mesh the solid field using surface nets
  // We provide a grid-based field function that reads from the precomputed array
  const solidFieldFn = (x, y, z) => {
    // Map world coords to grid index
    const ix = Math.round((x - bounds.min[0]) / ((bounds.max[0] - bounds.min[0]) / res));
    const iy = Math.round((y - bounds.min[1]) / ((bounds.max[1] - bounds.min[1]) / res));
    const iz = Math.round((z - bounds.min[2]) / ((bounds.max[2] - bounds.min[2]) / res));
    if (ix < 0 || ix >= gn || iy < 0 || iy >= gn || iz < 0 || iz >= gn) return 1e10;
    return solidGrid[ix + iy * gn + iz * gn * gn];
  };

  const colorFieldFn = (x, y, z) => {
    const ix = Math.round((x - bounds.min[0]) / ((bounds.max[0] - bounds.min[0]) / res));
    const iy = Math.round((y - bounds.min[1]) / ((bounds.max[1] - bounds.min[1]) / res));
    const iz = Math.round((z - bounds.min[2]) / ((bounds.max[2] - bounds.min[2]) / res));
    if (ix < 0 || ix >= gn || iy < 0 || iy >= gn || iz < 0 || iz >= gn) return [0.667, 0.667, 0.667];
    const idx = ix + iy * gn + iz * gn * gn;
    return [color[idx * 3], color[idx * 3 + 1], color[idx * 3 + 2]];
  };

  // Use meshFieldRaw directly with the precomputed grid
  // We build the grid data inline rather than calling the field function per-point
  const solidRaw = meshFromGrid(solidGrid, color, bounds, res);

  if (solidRaw && solidRaw.faces.length > 0) {
    const geo = rawToGeometry(solidRaw);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });
    group.add(new THREE.Mesh(geo, mat));
  }

  // Anti-solid mesh
  const antiGrid = new Float32Array(gn * gn * gn);
  let hasAnti = false;
  for (let i = 0; i < antiGrid.length; i++) {
    if (polarity[i] < 0) {
      antiGrid[i] = distance[i];
      hasAnti = true;
    } else {
      antiGrid[i] = Math.abs(distance[i]) + 0.01;
    }
  }

  if (hasAnti) {
    const antiRaw = meshFromGrid(antiGrid, null, bounds, res);
    if (antiRaw && antiRaw.faces.length > 0) {
      const geo = rawToGeometry(antiRaw);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xcc4444,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
        depthWrite: false
      });
      group.add(new THREE.Mesh(geo, mat));
    }
  }

  const elapsed = Math.round(performance.now() - t0);

  const stats = {
    meshTime: elapsed,
    resolution: res,
    voxels: gn * gn * gn,
    nodes: 0,
    octree: null,
    gpu: true
  };

  return { group, stats };
}

// Surface nets directly on a precomputed grid (avoids re-evaluating the field per point)
function meshFromGrid(grid, colorData, bounds, resolution) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const n = resolution;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;
  const gn = n + 1;

  const g = (x, y, z) => grid[x + y * gn + z * gn * gn];

  const cornerOff = [
    [0,0,0],[1,0,0],[0,1,0],[1,1,0],
    [0,0,1],[1,0,1],[0,1,1],[1,1,1]
  ];
  const edges = [
    [0,1],[2,3],[4,5],[6,7],
    [0,2],[1,3],[4,6],[5,7],
    [0,4],[1,5],[2,6],[3,7]
  ];

  const vertIndex = new Int32Array(n * n * n).fill(-1);
  const verts = [];

  for (let cz = 0; cz < n; cz++) {
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const vals = cornerOff.map(([dx,dy,dz]) => g(cx+dx, cy+dy, cz+dz));
        let hasNeg = false, hasPos = false;
        for (const v of vals) {
          if (v < 0) hasNeg = true; else hasPos = true;
        }
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
    if (flip) {
      faces.push(i0, i2, i1, i0, i3, i2);
    } else {
      faces.push(i0, i1, i2, i0, i2, i3);
    }
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

  // Compute normals from grid gradient
  const normals = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
    // Map to grid coords for gradient
    const gx = (wx - minX) / sx;
    const gy = (wy - minY) / sy;
    const gz = (wz - minZ) / sz;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    // Central difference using grid values
    const x0 = Math.max(0, ix - 1), x1 = Math.min(gn - 1, ix + 1);
    const y0 = Math.max(0, iy - 1), y1 = Math.min(gn - 1, iy + 1);
    const z0 = Math.max(0, iz - 1), z1 = Math.min(gn - 1, iz + 1);
    let nx = g(x1, Math.min(iy, gn-1), Math.min(iz, gn-1)) - g(x0, Math.min(iy, gn-1), Math.min(iz, gn-1));
    let ny = g(Math.min(ix, gn-1), y1, Math.min(iz, gn-1)) - g(Math.min(ix, gn-1), y0, Math.min(iz, gn-1));
    let nz = g(Math.min(ix, gn-1), Math.min(iy, gn-1), z1) - g(Math.min(ix, gn-1), Math.min(iy, gn-1), z0);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len;
    normals[i + 1] = ny / len;
    normals[i + 2] = nz / len;
  }

  // Colors from the GPU color buffer
  let colors = null;
  if (colorData) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
      const gx = (wx - minX) / sx;
      const gy = (wy - minY) / sy;
      const gz = (wz - minZ) / sz;
      const ix = Math.min(Math.max(Math.round(gx), 0), gn - 1);
      const iy = Math.min(Math.max(Math.round(gy), 0), gn - 1);
      const iz = Math.min(Math.max(Math.round(gz), 0), gn - 1);
      const idx = ix + iy * gn + iz * gn * gn;
      colors[i] = colorData[idx * 3];
      colors[i + 1] = colorData[idx * 3 + 1];
      colors[i + 2] = colorData[idx * 3 + 2];
    }
  }

  return { positions: new Float32Array(verts), normals, faces, colors };
}

export function isGPUAvailable() {
  return gpuAvailable === true;
}
