// WebGPU SDF evaluation engine — thin re-export layer.
// Implementation split across src/gpu/device.js, src/gpu/uniform.js, src/gpu/octree.js.

export { initGPU, isGPUAvailable } from './gpu/device.js';
export { gpuDispatchTape, gpuEvaluateField, gpuEvaluate } from './gpu/uniform.js';
export { gpuEvaluateOctree, gpuEvaluateOctreeProgressive } from './gpu/octree.js';
