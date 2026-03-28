// Performance benchmark: compares GPU dispatch vs CPU tree-walk eval.
// Separates timings for: tape compilation, GPU dispatch+readback,
// and CPU tree-walk eval (the existing evaluator path).

import { compileTape } from './gpu-tape.js';
import { evalCSGField } from './csg-field.js';
import { gpuDispatchTape, initGPU, isGPUAvailable } from './gpu-engine.js';
import { parseSExpr } from './parser.js';

// Default test models (S-expr strings)
const BENCH_MODELS = {
  cube: '(cube 20)',
  sphere: '(sphere 15)',
  lizard: `(union
  (paint :color "orange"
    (union
      (translate 5 15 5 (sphere 5))
      (translate 5 15 -5 (sphere 5))))
  (intersect
    (union
      (paint :color "green"
        (fuse :k 5
          (translate 18 0 0 (cube 10))
          (sphere 15)))
      (anti (cylinder 8 30)))))`,
  csg: `(union
  (intersect (cube 25) (sphere 18))
  (translate 40 0 0 (union (cube 20) (anti (sphere 12))))
  (translate -40 0 0 (fuse :k 5 (cube 20) (anti (sphere 12)))))`,
  warps: `(union
  (mirror :axis "x" (translate 12 0 0 (sphere 8)))
  (translate 40 0 0 (twist :axis "y" :rate 0.15 (cube 20)))
  (translate -40 0 0 (radial :axis "y" :count 6 (translate 12 0 0 (sphere 5))))
  (translate 0 30 0 (stretch :sx 2 :sy 0.5 :sz 1 (sphere 12)))
  (translate 0 -30 0 (bend :axis "y" :rate 0.04 (paint :color "green" (cube 25))))
  (translate 0 0 40 (taper :axis "y" :rate 0.03 (paint :color "orange" (cylinder 10 40)))))`,
};

// Evaluate the CPU tree-walk evaluator (evalCSGField) over a uniform grid.
function benchCPUTree(ast, bounds, resolution) {
  const field = evalCSGField(ast);
  const res = resolution;
  const gn = res + 1;
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const stepX = (maxX - minX) / res;
  const stepY = (maxY - minY) / res;
  const stepZ = (maxZ - minZ) / res;
  const totalPoints = gn * gn * gn;

  const t0 = performance.now();
  for (let iz = 0; iz < gn; iz++) {
    for (let iy = 0; iy < gn; iy++) {
      for (let ix = 0; ix < gn; ix++) {
        const x = minX + ix * stepX;
        const y = minY + iy * stepY;
        const z = minZ + iz * stepZ;
        field(x, y, z);
      }
    }
  }
  return { ms: performance.now() - t0, points: totalPoints };
}

// Run benchmark for a single model at a single resolution.
async function benchOne(modelName, ast, resolution) {
  const gn = resolution + 1;
  const totalPoints = gn * gn * gn;

  // 1. Tape compilation
  const tc0 = performance.now();
  const compiled = compileTape(ast);
  const tapeCompileMs = performance.now() - tc0;

  if (!compiled) {
    return { model: modelName, resolution, points: totalPoints,
             tapeCompileMs: null, gpuDispatchMs: null, cpuTreeMs: null,
             tapeLen: 0, error: 'tape compilation failed' };
  }

  const { tape, bounds } = compiled;

  // 2. GPU dispatch + readback (if available) — uses pre-compiled tape
  let gpuDispatchMs = null;
  if (isGPUAvailable()) {
    const tg0 = performance.now();
    await gpuDispatchTape(tape, bounds, resolution);
    gpuDispatchMs = performance.now() - tg0;
  }

  // 3. CPU tree-walk evaluation over grid
  const cpuTreeResult = benchCPUTree(ast, bounds, resolution);

  return {
    model: modelName,
    resolution,
    points: totalPoints,
    tapeLen: tape.length,
    tapeCompileMs: round2(tapeCompileMs),
    gpuDispatchMs: gpuDispatchMs !== null ? round2(gpuDispatchMs) : null,
    cpuTreeMs: round2(cpuTreeResult.ms),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

// Run the full benchmark suite.
// Returns array of result objects + a formatted string for display.
export async function runBenchmark(resolutions = [24, 48, 72, 96], modelNames = null) {
  const models = modelNames || Object.keys(BENCH_MODELS);
  const results = [];

  // Ensure GPU is initialized
  if (!isGPUAvailable()) {
    await initGPU();
  }

  for (const name of models) {
    const sexpr = BENCH_MODELS[name];
    if (!sexpr) { console.warn(`Unknown model: ${name}`); continue; }
    const ast = parseSExpr(sexpr);
    if (!ast) { console.warn(`Failed to parse model: ${name}`); continue; }

    for (const res of resolutions) {
      console.log(`Benchmarking ${name} @ res ${res}...`);
      const r = await benchOne(name, ast, res);
      results.push(r);
      console.log(`  compile: ${r.tapeCompileMs}ms, GPU: ${r.gpuDispatchMs}ms, CPU tree: ${r.cpuTreeMs}ms`);
    }
  }

  return { results, formatted: formatResults(results) };
}

function formatResults(results) {
  const lines = [];
  lines.push('=== Schnapp3 GPU vs CPU Benchmark ===');
  lines.push('');

  // Group by model
  const byModel = {};
  for (const r of results) {
    if (!byModel[r.model]) byModel[r.model] = [];
    byModel[r.model].push(r);
  }

  // Header
  lines.push(pad('Model', 10) + pad('Res', 5) + pad('Points', 10) +
             pad('Tape#', 7) + pad('Compile', 10) +
             pad('GPU', 10) + pad('CPU-Tree', 10) +
             pad('GPU/Tree', 10));
  lines.push('-'.repeat(72));

  for (const [model, runs] of Object.entries(byModel)) {
    for (const r of runs) {
      const gpuTotal = (r.gpuDispatchMs !== null && r.tapeCompileMs !== null)
        ? r.tapeCompileMs + r.gpuDispatchMs : null;
      const ratio = (gpuTotal !== null && r.cpuTreeMs > 0)
        ? round2(gpuTotal / r.cpuTreeMs) + 'x'
        : 'n/a';
      lines.push(
        pad(r.model, 10) +
        pad(String(r.resolution), 5) +
        pad(r.points.toLocaleString(), 10) +
        pad(String(r.tapeLen), 7) +
        pad(fmt(r.tapeCompileMs), 10) +
        pad(fmt(r.gpuDispatchMs), 10) +
        pad(fmt(r.cpuTreeMs), 10) +
        pad(ratio, 10)
      );
    }
    lines.push('');
  }

  // Summary
  lines.push('Compile  = AST→tape compilation (needed for GPU path)');
  lines.push('GPU      = GPU dispatch + buffer readback (excludes compile)');
  lines.push('CPU-Tree = existing tree-walk evaluator over uniform grid');
  lines.push('GPU/Tree = ratio of (Compile+GPU) vs CPU-Tree (< 1.0 means GPU wins)');

  return lines.join('\n');
}

function pad(s, n) { return s.padEnd(n); }
function fmt(v) { return v !== null ? v.toFixed(1) + 'ms' : 'n/a'; }
