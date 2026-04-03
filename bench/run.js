#!/usr/bin/env node
// Schnapp3 Node.js benchmark harness
//
// Usage:
//   npm run bench                    # run benchmark, compare against reference
//   npm run bench -- --update        # regenerate reference snapshot
//   npm run bench -- --resolution 64 # override resolution (default: 48 for fast, 256 for full)
//   npm run bench -- --model NAME    # use a named model (default: "hello-twist")
//   npm run bench -- --full          # run at resolution 256 (the real target)
//
// The benchmark captures mesh output (vertex positions, face indices) and
// compares against a saved reference snapshot to verify correctness.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { parseSExpr } from '../src/parser.js';
import { expandAST } from '../src/expand.js';
import { evaluate, getResolution, needsFieldEval } from '../src/evaluator.js';
import { setResolution } from '../src/evaluator.js';
import { injectFont } from '../src/eval/font-cache.js';
import { estimateBounds } from '../src/eval/bounds.js';
import { meshFieldRaw } from '../src/surface-nets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');

// ---- Models ----
const MODELS = {
  'hello-twist': `(union
  (mirror :axis "y"
    (translate 0 32 0
      (cylinder 32 3)))
  (twist :axis "y" :rate 0.05
    (stretch :sx 1 :sy 3 :sz 1
      (text "HellO" :size 20 :depth 4 :font "helvetiker"))))`,

  'simple-csg': `(intersect (cube 25) (sphere 18))`,

  'cylinder': `(cylinder 10 30)`,
};

// ---- Font loading ----
// Font JSON ships with the three npm package — no network needed
const FONT_FILES = {
  'helvetiker': path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'fonts', 'helvetiker_regular.typeface.json'),
};

function loadFont(name) {
  const file = FONT_FILES[name];
  if (!file || !fs.existsSync(file)) throw new Error(`Font file not found: ${name}`);
  const fontData = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const font = new Font(fontData);
  injectFont(name, font);
  return font;
}

// ---- Snapshot helpers ----

function extractMeshData(group) {
  // Walk the Three.js Group and extract all mesh geometry data
  const meshes = [];
  group.traverse(child => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry;
      const pos = geo.getAttribute('position');
      const idx = geo.getIndex();
      meshes.push({
        vertexCount: pos ? pos.count : 0,
        faceCount: idx ? idx.count / 3 : 0,
        // Sample some vertex positions for fingerprinting
        positions: pos ? Array.from(pos.array.slice(0, Math.min(300, pos.array.length))) : [],
        // Full position hash for exact comparison
        positionHash: pos ? hashFloat32(pos.array) : '0',
        indexHash: idx ? hashArray(idx.array) : '0',
      });
    }
  });
  return meshes;
}

function hashFloat32(arr) {
  // Simple hash of float array — sum of values with positional weighting
  // Sufficient for detecting regressions (not cryptographic)
  let h = 0;
  for (let i = 0; i < arr.length; i++) {
    // Quantize to avoid floating-point noise
    const v = Math.round(arr[i] * 1e6) / 1e6;
    h = (h * 31 + (v * 1000) | 0) | 0;
  }
  return h.toString(16);
}

function hashArray(arr) {
  let h = 0;
  for (let i = 0; i < arr.length; i++) {
    h = (h * 31 + arr[i]) | 0;
  }
  return h.toString(16);
}

function snapshotPath(modelName, resolution) {
  return path.join(SNAPSHOT_DIR, `${modelName}-res${resolution}.json`);
}

function saveSnapshot(modelName, resolution, data) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = snapshotPath(modelName, resolution);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  Snapshot saved: ${file}`);
}

function loadSnapshot(modelName, resolution) {
  const file = snapshotPath(modelName, resolution);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function compareSnapshots(current, reference) {
  const errors = [];

  if (current.length !== reference.length) {
    errors.push(`Mesh count: ${current.length} vs reference ${reference.length}`);
    return errors;
  }

  for (let i = 0; i < current.length; i++) {
    const c = current[i], r = reference[i];
    if (c.vertexCount !== r.vertexCount) {
      errors.push(`Mesh ${i}: vertex count ${c.vertexCount} vs reference ${r.vertexCount}`);
    }
    if (c.faceCount !== r.faceCount) {
      errors.push(`Mesh ${i}: face count ${c.faceCount} vs reference ${r.faceCount}`);
    }

    // Compare sampled positions within tolerance
    const tol = 1e-4;
    const len = Math.min(c.positions.length, r.positions.length);
    let maxDiff = 0;
    for (let j = 0; j < len; j++) {
      const diff = Math.abs(c.positions[j] - r.positions[j]);
      if (diff > maxDiff) maxDiff = diff;
    }
    if (maxDiff > tol) {
      errors.push(`Mesh ${i}: max position diff ${maxDiff.toExponential(3)} exceeds tolerance ${tol}`);
    }
  }

  return errors;
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const full = args.includes('--full');

  let resolution = full ? 256 : 48;
  const resIdx = args.indexOf('--resolution');
  if (resIdx >= 0 && args[resIdx + 1]) resolution = parseInt(args[resIdx + 1], 10);

  let modelName = 'hello-twist';
  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0 && args[modelIdx + 1]) modelName = args[modelIdx + 1];

  const modelSrc = MODELS[modelName];
  if (!modelSrc) {
    console.error(`Unknown model: "${modelName}". Available: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Model: ${modelName} | Resolution: ${resolution} | Mode: ${update ? 'UPDATE' : 'VERIFY'}`);
  console.log();

  // Load fonts
  loadFont('helvetiker');

  // Parse
  const t0 = performance.now();
  const rawAST = parseSExpr(modelSrc);
  const ast = expandAST(rawAST);
  const tParse = performance.now() - t0;
  console.log(`Parse + expand: ${tParse.toFixed(1)}ms`);

  // Set resolution
  setResolution(resolution);

  // Bounds estimation
  const t1 = performance.now();
  const bounds = estimateBounds(ast);
  const tBounds = performance.now() - t1;
  console.log(`Bounds estimation: ${tBounds.toFixed(1)}ms`);
  console.log(`  bounds: [${bounds.min.map(v => v.toFixed(1))}] to [${bounds.max.map(v => v.toFixed(1))}]`);

  // Full pipeline (evaluate → Three.js meshes)
  console.log();
  console.log(`Running full pipeline (evaluate)...`);
  const t2 = performance.now();
  const { group, stats } = evaluate(ast);
  const tEval = performance.now() - t2;

  console.log(`  Total: ${tEval.toFixed(0)}ms`);
  console.log(`  Stats: ${stats.nodes} nodes, ${stats.voxels.toLocaleString()} voxel evals, resolution=${stats.resolution}`);
  if (stats.octree) {
    const o = stats.octree;
    const pct = o.nodesVisited > 0
      ? Math.round(100 * (o.nodesCulledOutside + o.nodesCulledInside) / o.nodesVisited)
      : 0;
    console.log(`  Octree: ${o.leafCells} leaves, ${pct}% culled`);
  }

  // Extract mesh data for comparison
  const meshData = extractMeshData(group);
  console.log();
  console.log(`Output: ${meshData.length} mesh(es)`);
  for (let i = 0; i < meshData.length; i++) {
    const m = meshData[i];
    console.log(`  mesh ${i}: ${m.vertexCount} verts, ${m.faceCount} faces`);
  }

  // Snapshot comparison
  console.log();
  if (update) {
    saveSnapshot(modelName, resolution, meshData);
    console.log('Reference snapshot updated.');
  } else {
    const reference = loadSnapshot(modelName, resolution);
    if (!reference) {
      console.log('No reference snapshot found. Run with --update to create one.');
      saveSnapshot(modelName, resolution, meshData);
    } else {
      const errors = compareSnapshots(meshData, reference);
      if (errors.length === 0) {
        console.log('PASS: Output matches reference snapshot.');
      } else {
        console.log('FAIL: Output differs from reference:');
        for (const e of errors) console.log(`  - ${e}`);
        process.exit(1);
      }
    }
  }

  // Summary
  console.log();
  console.log('--- Timing Summary ---');
  console.log(`  Parse:    ${tParse.toFixed(1)}ms`);
  console.log(`  Bounds:   ${tBounds.toFixed(1)}ms`);
  console.log(`  Evaluate: ${tEval.toFixed(0)}ms`);
  console.log(`  Total:    ${(tParse + tBounds + tEval).toFixed(0)}ms`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
