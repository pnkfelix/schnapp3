// WebGPU device initialization, shader loading, and pipeline management.
// Shared state accessed by uniform and octree dispatch modules.

let gpuDevice = null;
let gpuPipeline = null;      // uniform grid pipeline
let gpuSparsePipeline = null; // sparse point pipeline
let gpuShaderCode = null;
let gpuAvailable = null; // null = unknown, true/false after probe

export function getDevice() { return gpuDevice; }
export function getGridPipeline() { return gpuPipeline; }
export function getSparsePipeline() { return gpuSparsePipeline; }
export function isGPUAvailable() { return gpuAvailable === true; }

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

    gpuDevice.addEventListener('uncapturederror', (event) => {
      console.error('WebGPU uncaptured error:', event.error.message);
    });

    gpuDevice.lost.then((info) => {
      console.warn('WebGPU device lost:', info.message, 'reason:', info.reason);
      gpuDevice = null;
      gpuPipeline = null;
      gpuAvailable = null;
    });

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
  // Shaders are in src/, not src/gpu/
  const url = new URL('../' + filename, base);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load shader ${filename}: ${resp.status}`);
  return resp.text();
}

async function createPipeline(device, shaderCode) {
  const module = device.createShaderModule({ code: shaderCode });

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
