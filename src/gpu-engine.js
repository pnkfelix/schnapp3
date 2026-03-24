// WebGPU SDF evaluation engine.
// Compiles an AST to a tape, dispatches it on the GPU, reads back
// the distance/polarity/color fields, then meshes via surface nets.
// Supports both uniform grid dispatch and sparse (octree) dispatch.

import * as THREE from 'three';
import { compileTape } from './gpu-tape.js';
import { meshFieldRaw, rawToGeometry } from './surface-nets.js';
import { buildOctree, resToDepth } from './octree-core.js';
import { evalCSGFieldInterval } from './interval-eval.js';
import { estimateBounds } from './csg-field.js';

let gpuDevice = null;
let gpuPipeline = null;      // uniform grid pipeline
let gpuSparsePipeline = null; // sparse point pipeline
let gpuShaderCode = null;
let gpuAvailable = null; // null = unknown, true/false after probe

// Probe for WebGPU support and cache the device.
export async function initGPU() {
  if (gpuAvailable !== null) return gpuAvailable;
  try {
    if (!navigator.gpu) {
      console.warn('WebGPU: navigator.gpu not present');
      gpuAvailable = false;
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.warn('WebGPU: requestAdapter returned null');
      gpuAvailable = false;
      return false;
    }
    console.log('WebGPU adapter:', adapter.info || 'info unavailable');
    console.log('WebGPU adapter limits:', {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    });

    // Request device with conservative limits — don't exceed adapter capabilities
    const wantedStorageSize = 128 * 1024 * 1024;
    const actualStorageSize = Math.min(wantedStorageSize,
      adapter.limits.maxStorageBufferBindingSize || wantedStorageSize);
    const actualBufferSize = Math.min(wantedStorageSize,
      adapter.limits.maxBufferSize || wantedStorageSize);

    gpuDevice = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: actualStorageSize,
        maxBufferSize: actualBufferSize,
      }
    });
    console.log('WebGPU device acquired');

    // Listen for uncaptured errors (shader compilation failures, validation errors)
    gpuDevice.addEventListener('uncapturederror', (event) => {
      console.error('WebGPU uncaptured error:', event.error.message);
    });

    gpuDevice.lost.then((info) => {
      console.warn('WebGPU device lost:', info.message, 'reason:', info.reason);
      gpuDevice = null;
      gpuPipeline = null;
      gpuAvailable = null;
    });

    // Load shaders
    gpuShaderCode = await fetchShader('gpu-sdf.wgsl');
    console.log('WebGPU grid shader loaded, length:', gpuShaderCode.length);
    gpuPipeline = await createPipeline(gpuDevice, gpuShaderCode);
    console.log('WebGPU grid pipeline created');

    const sparseCode = await fetchShader('gpu-sdf-sparse.wgsl');
    console.log('WebGPU sparse shader loaded, length:', sparseCode.length);
    gpuSparsePipeline = await createPipeline(gpuDevice, sparseCode);
    console.log('WebGPU sparse pipeline created');
    gpuAvailable = true;
    return true;
  } catch (e) {
    console.warn('WebGPU init failed:', e);
    gpuAvailable = false;
    return false;
  }
}

async function fetchShader(filename = 'gpu-sdf.wgsl') {
  const base = new URL('.', import.meta.url);
  const url = new URL(filename, base);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load shader ${filename}: ${resp.status}`);
  return resp.text();
}

async function createPipeline(device, shaderCode) {
  const module = device.createShaderModule({ code: shaderCode });

  // Check for shader compilation errors
  if (module.getCompilationInfo) {
    const info = await module.getCompilationInfo();
    for (const msg of info.messages) {
      const prefix = msg.type === 'error' ? 'ERROR' : msg.type === 'warning' ? 'WARN' : 'INFO';
      console.log(`WebGPU shader ${prefix} [${msg.lineNum}:${msg.linePos}]: ${msg.message}`);
    }
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(`WGSL compilation failed: ${errors[0].message}`);
    }
  }

  return device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });
}

// Dispatch a pre-compiled tape on the GPU. Separated from gpuEvaluateField
// so benchmarks can time tape compilation and GPU dispatch independently.
// Returns same shape as gpuEvaluateField.
export async function gpuDispatchTape(tape, bounds, resolution) {
  if (!gpuDevice || !gpuPipeline) return null;
  return _gpuDispatch(tape, bounds, resolution);
}

// Evaluate an AST on the GPU at the given resolution.
// Returns { distance: Float32Array, polarity: Float32Array, color: Float32Array, bounds, resolution }
// or null if GPU is unavailable.
export async function gpuEvaluateField(ast, resolution) {
  if (!gpuDevice || !gpuPipeline) return null;

  const compiled = compileTape(ast);
  if (!compiled) return null;

  const { tape, bounds } = compiled;
  return _gpuDispatch(tape, bounds, resolution);
}

async function _gpuDispatch(tape, bounds, resolution) {
  const res = resolution;
  const gn = res + 1; // grid points per axis
  const totalPoints = gn * gn * gn;

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const stepX = (maxX - minX) / res;
  const stepY = (maxY - minY) / res;
  const stepZ = (maxZ - minZ) / res;

  const device = gpuDevice;

  // Check if buffers would exceed device limits
  const colorBufSize = totalPoints * 3 * 4; // largest buffer (RGB per point)
  const maxBuf = device.limits.maxStorageBufferBindingSize;
  if (colorBufSize > maxBuf) {
    throw new Error(`GPU resolution too high: color buffer ${(colorBufSize / 1e6).toFixed(1)}MB exceeds device limit ${(maxBuf / 1e6).toFixed(1)}MB. Max resolution ~${Math.floor(Math.cbrt(maxBuf / 12)) - 1}`);
  }

  console.log(`GPU eval: res=${res}, grid=${gn}³=${totalPoints} points, tape=${tape.length} f32s`);
  console.log(`GPU eval: bounds min=[${minX.toFixed(1)},${minY.toFixed(1)},${minZ.toFixed(1)}] max=[${maxX.toFixed(1)},${maxY.toFixed(1)},${maxZ.toFixed(1)}]`);

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

  // Tape buffer — size must be multiple of 4 and at least 4
  const tapeByteSize = Math.max(4, Math.ceil(tape.byteLength / 4) * 4);
  const tapeBuffer = device.createBuffer({
    size: tapeByteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(tapeBuffer, 0, tape);

  // Output buffers — sizes must be multiples of 4 (they already are since each is N*4 bytes)
  const distSize = totalPoints * 4;
  const polSize = totalPoints * 4;
  const colorSize = totalPoints * 3 * 4;

  console.log(`GPU eval: buffer sizes dist=${distSize}, pol=${polSize}, color=${colorSize}`);

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

  // Push error scope to capture validation errors during dispatch
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  // Dispatch
  const workgroups = Math.ceil(totalPoints / 64);
  console.log(`GPU eval: dispatching ${workgroups} workgroups`);
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

  // Check for errors
  const oomError = await device.popErrorScope();
  if (oomError) {
    console.error('WebGPU out-of-memory error:', oomError.message);
    throw new Error(`GPU OOM: ${oomError.message}`);
  }
  const valError = await device.popErrorScope();
  if (valError) {
    console.error('WebGPU validation error:', valError.message);
    throw new Error(`GPU validation: ${valError.message}`);
  }

  console.log('GPU eval: dispatch succeeded, reading back...');

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

// --- Sparse dispatch: evaluate tape at arbitrary coordinates ---

// Dispatch the tape on a set of sparse coordinates.
// coords: Float32Array of [x,y,z, x,y,z, ...] (numPoints * 3 floats)
// Returns { distance, polarity, color } Float32Arrays indexed by point.
async function gpuDispatchSparsePoints(tape, coords, numPoints) {
  if (!gpuDevice || !gpuSparsePipeline) return null;

  const device = gpuDevice;

  // Check buffer limits
  const colorBufSize = numPoints * 3 * 4;
  const maxBuf = device.limits.maxStorageBufferBindingSize;
  if (colorBufSize > maxBuf) {
    throw new Error(`Sparse dispatch: color buffer ${(colorBufSize / 1e6).toFixed(1)}MB exceeds limit ${(maxBuf / 1e6).toFixed(1)}MB`);
  }

  console.log(`GPU sparse: ${numPoints} points, tape=${tape.length} f32s`);

  // Params uniform (SparseParams struct: num_points, tape_len, pad, pad)
  const paramsData = new ArrayBuffer(16);
  const paramsU32 = new Uint32Array(paramsData);
  paramsU32[0] = numPoints;
  paramsU32[1] = tape.length;
  paramsU32[2] = 0;
  paramsU32[3] = 0;

  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  // Tape buffer
  const tapeByteSize = Math.max(4, Math.ceil(tape.byteLength / 4) * 4);
  const tapeBuffer = device.createBuffer({
    size: tapeByteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(tapeBuffer, 0, tape);

  // Coords input buffer
  const coordsByteSize = Math.max(4, numPoints * 3 * 4);
  const coordsBuffer = device.createBuffer({
    size: coordsByteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(coordsBuffer, 0, coords);

  // Output buffers
  const distSize = numPoints * 4;
  const polSize = numPoints * 4;

  const distBuffer = device.createBuffer({ size: distSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const polBuffer = device.createBuffer({ size: polSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const colorBuffer = device.createBuffer({ size: colorBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  // Staging buffers for readback
  const distStaging = device.createBuffer({ size: distSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const polStaging = device.createBuffer({ size: polSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const colorStaging = device.createBuffer({ size: colorBufSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Bind group (6 bindings for sparse shader)
  const bindGroup = device.createBindGroup({
    layout: gpuSparsePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: tapeBuffer } },
      { binding: 2, resource: { buffer: coordsBuffer } },
      { binding: 3, resource: { buffer: distBuffer } },
      { binding: 4, resource: { buffer: polBuffer } },
      { binding: 5, resource: { buffer: colorBuffer } },
    ],
  });

  // Error scopes
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  // Dispatch
  const workgroups = Math.ceil(numPoints / 64);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(gpuSparsePipeline);
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

  // Cleanup
  paramsBuffer.destroy();
  tapeBuffer.destroy();
  coordsBuffer.destroy();
  distBuffer.destroy();
  polBuffer.destroy();
  colorBuffer.destroy();
  distStaging.destroy();
  polStaging.destroy();
  colorStaging.destroy();

  return { distance, polarity, color };
}

// --- Octree + GPU pipeline ---
// CPU interval arithmetic builds octree → collect sparse points → GPU eval → surface nets

export async function gpuEvaluateOctree(ast, resolution = 48) {
  if (!gpuDevice || !gpuSparsePipeline) return null;
  const t0 = performance.now();

  // Compile tape
  const compiled = compileTape(ast);
  if (!compiled) return null;
  const { tape, bounds } = compiled;

  const depth = resToDepth(resolution);
  const n = 1 << depth;
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;
  const gn = n + 1;

  // Build octree via CPU interval arithmetic
  let intervalField;
  try {
    intervalField = evalCSGFieldInterval(ast);
  } catch (e) {
    console.warn('GPU octree: interval eval failed, falling back to uniform GPU:', e);
    return null; // caller will fall back
  }

  const solidIntervalField = (xIv, yIv, zIv) => {
    const r = intervalField(xIv, yIv, zIv);
    if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
    return r;
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
    // Fall back to uniform GPU
    return gpuEvaluate(ast, resolution);
  }

  if (leaves.length === 0) {
    const group = new THREE.Group();
    const elapsed = Math.round(performance.now() - t0);
    return { group, stats: { meshTime: elapsed, resolution: n, voxels: 0, nodes: 0, gpu: true, octree: octreeStats } };
  }

  // Collect grid cells and points using typed arrays for speed.
  // cellFlags: 1 = active, 2 = extended (includes active)
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

  // Extend with neighbors
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

  // Collect unique grid corner points using a flat Int32Array (-1 = not needed)
  const totalGridPts = gn * gn * gn;
  const pointKeyToIdx = new Int32Array(totalGridPts).fill(-1);
  let numPoints = 0;

  for (let ci = 0; ci < extendedCellList.length; ci++) {
    const key = extendedCellList[ci];
    const iz = (key / (n * n)) | 0;
    const iy = ((key - iz * n * n) / n) | 0;
    const ix = key - iz * n * n - iy * n;
    // 8 corners
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const gx = ix + dx, gy = iy + dy, gz = iz + dz;
          const pk = gx + gy * gn + gz * gn * gn;
          if (pointKeyToIdx[pk] < 0) { pointKeyToIdx[pk] = numPoints++; }
        }
  }

  // Build coordinate buffer
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

  // Dispatch to GPU
  const tDispatch = performance.now();
  const gpuResult = await gpuDispatchSparsePoints(tape, coords, numPoints);
  const dispatchMs = performance.now() - tDispatch;
  if (!gpuResult) return null;

  octreeStats.pointEvals = numPoints;
  console.log(`GPU octree timing: GPU dispatch ${dispatchMs.toFixed(1)}ms`);

  // Build precomputed solid/anti grids from GPU results (flat array indexed by grid-point key)
  // This avoids per-lookup Map.get overhead during meshing.
  const solidGrid = new Float32Array(totalGridPts).fill(1e10);
  const antiGrid = new Float32Array(totalGridPts).fill(1e10);
  const colorGrid = new Float32Array(totalGridPts * 3);
  // Default gray
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

  // Surface nets on active cells using GPU-computed values
  const tMesh = performance.now();
  const group = new THREE.Group();
  const solidRaw = meshOctreeCellsFromGPU(activeCellList, extendedCellList, solidVal, colorVal, bounds, n);

  if (solidRaw && solidRaw.faces.length > 0) {
    const geo = rawToGeometry(solidRaw);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(geo, mat));
  }

  // Anti-solid
  const antiRaw = meshOctreeCellsFromGPU(activeCellList, extendedCellList, antiVal, null, bounds, n);

  if (antiRaw && antiRaw.faces.length > 0) {
    const geo = rawToGeometry(antiRaw);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xcc4444, side: THREE.DoubleSide,
      transparent: true, opacity: 0.35, depthWrite: false
    });
    group.add(new THREE.Mesh(geo, mat));
  }

  const meshMs = performance.now() - tMesh;
  const elapsed = Math.round(performance.now() - t0);
  octreeStats.activeCells = activeCellList.length;
  console.log(`GPU octree timing: meshing ${meshMs.toFixed(1)}ms, total ${elapsed}ms`);

  return {
    group,
    stats: {
      meshTime: elapsed,
      resolution: n,
      voxels: numPoints,
      nodes: leaves.length,
      gpu: true,
      octree: octreeStats
    }
  };
}

// Surface nets on octree cells using precomputed grid-point values
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

  // Normals from grid gradient
  const gn = n + 1;
  const normals = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
    const gx = (wx - minX) / sx;
    const gy = (wy - minY) / sy;
    const gz = (wz - minZ) / sz;
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

  // Colors
  let colors = null;
  if (colorGridVal) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const wx = verts[i], wy = verts[i+1], wz = verts[i+2];
      const gx = (wx - minX) / sx;
      const gy = (wy - minY) / sy;
      const gz = (wz - minZ) / sz;
      const gix = Math.min(Math.max(Math.round(gx), 0), gn - 1);
      const giy = Math.min(Math.max(Math.round(gy), 0), gn - 1);
      const giz = Math.min(Math.max(Math.round(gz), 0), gn - 1);
      const [r, g, b] = colorGridVal(gix, giy, giz);
      colors[i] = r; colors[i + 1] = g; colors[i + 2] = b;
    }
  }

  return { positions: new Float32Array(verts), normals, faces, colors };
}

export function isGPUAvailable() {
  return gpuAvailable === true;
}
