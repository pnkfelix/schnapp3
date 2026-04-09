#!/usr/bin/env node
// Schnapp3 Node.js benchmark harness
//
// Benchmarks two rendering paths that match the browser's modes:
//
//   --mode worker      (default) Replicates the Web Worker progressive path
//                      (mesh-worker.js + csg-field.js). Disables octree for
//                      text models, uses uniform grid. This is what the browser
//                      runs by default.
//
//   --mode main-thread Replicates the sync main-thread path (evaluator.js).
//                      Uses octree even for text models. In the browser, this
//                      is what runs when progressive mode is toggled off
//                      (command: "progressive").
//
// Usage:
//   npm run bench                              # worker mode, res 48, verify snapshot
//   npm run bench -- --full                    # worker mode, res 256
//   npm run bench -- --mode main-thread        # main-thread mode, res 48
//   npm run bench -- --mode main-thread --full # main-thread mode, res 256
//   npm run bench -- --update                  # regenerate reference snapshot
//   npm run bench -- --resolution 128          # custom resolution
//   npm run bench -- --model simple-csg        # different model
//   npm run bench -- --cache                   # subtree cache benchmark
//   npm run bench -- --cache --resolution 96   # cache benchmark at res 96

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { parseSExpr } from '../src/parser.js';
import { expandAST } from '../src/expand.js';
// Worker path imports
import { evalCSGField, estimateBounds as estimateBoundsCSG, UNSET_COLOR, UNSET_RGB, setTextSDFGrids, getTextGridBounds } from '../src/csg-field.js';
import { evalCSGFieldInterval, setTextBoundsProvider } from '../src/interval-eval.js';
import { classify } from '../src/interval.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth, depthForBounds } from '../src/octree-core.js';
// Main-thread path imports
import { evaluate, setResolution, setUseOctree, benchCache } from '../src/evaluator.js';
import { evalField } from '../src/eval/sdf-field.js';
// Shared
import { injectFont } from '../src/eval/font-cache.js';
import { getTextSDFGrid } from '../src/eval/text-sdf.js';

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
const FONT_FILES = {
  'helvetiker': path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'fonts', 'helvetiker_regular.typeface.json'),
};

let loadedFonts = {};

function loadFont(name) {
  const file = FONT_FILES[name];
  if (!file || !fs.existsSync(file)) throw new Error(`Font file not found: ${name}`);
  const fontData = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const font = new Font(fontData);
  injectFont(name, font);
  loadedFonts[name] = font;
  return font;
}

// ---- AST helpers (same as mesh-worker.js) ----

function astHasText(node) {
  if (!node || !Array.isArray(node)) return false;
  if (node[0] === 'text') return true;
  const start = (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) ? 2 : 1;
  for (let i = start; i < node.length; i++) {
    if (astHasText(node[i])) return true;
  }
  return false;
}

// Collect text SDF grids from the AST, same as progressive.js does
// before sending work to the worker
function collectTextSDFGrids(node, font, resolution) {
  const grids = {};
  function walk(n) {
    if (!n || !Array.isArray(n)) return;
    if (n[0] === 'text') {
      const p = n[1];
      const content = p.content || 'Text';
      const fontSize = p.size || 20;
      const depth = p.depth || 4;
      const fontName = p.font || 'helvetiker';
      const key = `${fontName}|${fontSize}|${depth}|${content}`;
      if (!grids[key]) {
        const grid = getTextSDFGrid(content, fontSize, depth, font, resolution);
        if (grid) grids[key] = grid;
      }
      return;
    }
    const start = (n[1] && typeof n[1] === 'object' && !Array.isArray(n[1])) ? 2 : 1;
    for (let i = start; i < n.length; i++) walk(n[i]);
  }
  walk(node);
  return grids;
}

// ============================================================
// Octree validation: walk the tree and check culled cells
// against the actual point field to find incorrect culls
// ============================================================

function validateOctree(solidIntervalField, solidField, bounds, maxDepth) {
  const minX = bounds.min[0], minY = bounds.min[1], minZ = bounds.min[2];
  const maxX = bounds.max[0], maxY = bounds.max[1], maxZ = bounds.max[2];

  let wrongInside = 0, wrongOutside = 0;
  let correctInside = 0, correctOutside = 0;
  const wrongCells = [];

  function recurse(x0, y0, z0, x1, y1, z1, depth) {
    const result = solidIntervalField([x0, x1], [y0, y1], [z0, z1]);
    const cls = classify(result.distance);

    if (cls === 'outside' || cls === 'inside') {
      // This cell was culled — validate at the leaf level
      if (depth < maxDepth) {
        // Recurse to leaf level to check each leaf-sized sub-cell
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
        recurse(x0, y0, z0, mx, my, mz, depth + 1);
        recurse(mx, y0, z0, x1, my, mz, depth + 1);
        recurse(x0, my, z0, mx, y1, mz, depth + 1);
        recurse(mx, my, z0, x1, y1, mz, depth + 1);
        recurse(x0, y0, mz, mx, my, z1, depth + 1);
        recurse(mx, y0, mz, x1, my, z1, depth + 1);
        recurse(x0, my, mz, mx, y1, z1, depth + 1);
        recurse(mx, my, mz, x1, y1, z1, depth + 1);
        return;
      }
      // At leaf level: sample corners to check for sign change
      const corners = [
        [x0,y0,z0],[x1,y0,z0],[x0,y1,z0],[x1,y1,z0],
        [x0,y0,z1],[x1,y0,z1],[x0,y1,z1],[x1,y1,z1]
      ];
      const vals = corners.map(([x,y,z]) => solidField(x,y,z));
      let hasNeg = false, hasPos = false;
      for (const v of vals) { if (v < 0) hasNeg = true; else hasPos = true; }
      const hasSignChange = hasNeg && hasPos;

      if (hasSignChange) {
        if (cls === 'inside') { wrongInside++; }
        else { wrongOutside++; }
        if (wrongCells.length < 5) {
          wrongCells.push({
            cls, depth,
            cell: [x0.toFixed(2), y0.toFixed(2), z0.toFixed(2), x1.toFixed(2), y1.toFixed(2), z1.toFixed(2)],
            vals: vals.map(v => v.toFixed(4)),
            intervalDist: result.distance.map(v => v.toFixed(4)),
            intervalPol: result.polarity
          });
        }
      } else {
        if (cls === 'inside') correctInside++;
        else correctOutside++;
      }
      return;
    }

    // Ambiguous — subdivide
    if (depth >= maxDepth) return; // leaf, not culled
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

  return { wrongInside, wrongOutside, correctInside, correctOutside, wrongCells };
}

// ============================================================
// Mode: worker — replicates mesh-worker.js logic exactly
// ============================================================

function runWorkerPipeline(ast, depth, resolution) {
  const t0 = performance.now();

  const bounds = estimateBoundsCSG(ast);
  // Use absolute voxel sizing when resolution is provided
  if (resolution) depth = depthForBounds(bounds, resolution);
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

  // Enable octree for all models (text bounds now use actual SDF grid extents)
  {
    try {
      const intervalField = evalCSGFieldInterval(ast);
      const solidIntervalField = (xIv, yIv, zIv) => {
        const r = intervalField(xIv, yIv, zIv);
        if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
        if (r.polarity[0] > 0) return r;
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
    const fallbackRes = 1 << depth;
    solidRaw = meshFieldRaw(solidField, bounds, fallbackRes, solidColorField);
    stats.pointEvals = (fallbackRes + 1) ** 3;
  }

  const antiRes = Math.min(1 << depth, 48);
  const antiRaw = meshFieldRaw(antiField, bounds, antiRes, null);
  stats.pointEvals += (antiRes + 1) ** 3;

  const elapsed = Math.round(performance.now() - t0);

  return {
    solid: solidRaw,
    anti: antiRaw,
    stats: { ...stats, usedOctree, bailedOut },
    elapsed,
    bounds,
  };
}

// ============================================================
// Mode: main-thread — replicates evaluator.js sync path
// ============================================================

function runMainThreadPipeline(ast, resolution, octree = true) {
  setResolution(resolution);
  setUseOctree(octree);

  const t0 = performance.now();
  const { group, stats } = evaluate(ast);
  const elapsed = Math.round(performance.now() - t0);

  return { group, stats, elapsed };
}

// ---- Snapshot helpers ----

function extractWorkerMeshData(result) {
  const meshes = [];
  for (const key of ['solid', 'anti']) {
    const raw = result[key];
    if (!raw || !raw.positions || raw.positions.length === 0) continue;
    meshes.push({
      label: key,
      vertexCount: raw.positions.length / 3,
      faceCount: raw.faces.length / 3,
      positions: Array.from(raw.positions.slice(0, Math.min(300, raw.positions.length))),
      positionHash: hashFloat32(raw.positions),
      indexHash: hashArray(raw.faces),
    });
  }
  return meshes;
}

function extractMainThreadMeshData(group) {
  const meshes = [];
  group.traverse(child => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry;
      const pos = geo.getAttribute('position');
      const idx = geo.getIndex();
      if (!pos || pos.count === 0) return;
      meshes.push({
        label: 'mesh',
        vertexCount: pos.count,
        faceCount: idx ? idx.count / 3 : 0,
        positions: Array.from(pos.array.slice(0, Math.min(300, pos.array.length))),
        positionHash: hashFloat32(pos.array),
        indexHash: idx ? hashArray(idx.array) : '0',
      });
    }
  });
  return meshes;
}

function hashFloat32(arr) {
  let h = 0;
  for (let i = 0; i < arr.length; i++) {
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

function snapshotPath(modelName, resolution, mode) {
  return path.join(SNAPSHOT_DIR, `${modelName}-res${resolution}-${mode}.json`);
}

function saveSnapshot(modelName, resolution, mode, data) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = snapshotPath(modelName, resolution, mode);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  Snapshot saved: ${file}`);
}

function loadSnapshot(modelName, resolution, mode) {
  const file = snapshotPath(modelName, resolution, mode);
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
      errors.push(`Mesh ${i} (${c.label}): vertex count ${c.vertexCount} vs reference ${r.vertexCount}`);
    }
    if (c.faceCount !== r.faceCount) {
      errors.push(`Mesh ${i} (${c.label}): face count ${c.faceCount} vs reference ${r.faceCount}`);
    }

    const tol = 1e-4;
    const len = Math.min(c.positions.length, r.positions.length);
    let maxDiff = 0;
    for (let j = 0; j < len; j++) {
      const diff = Math.abs(c.positions[j] - r.positions[j]);
      if (diff > maxDiff) maxDiff = diff;
    }
    if (maxDiff > tol) {
      errors.push(`Mesh ${i} (${c.label}): max position diff ${maxDiff.toExponential(3)} exceeds tolerance ${tol}`);
    }
  }

  return errors;
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const full = args.includes('--full');
  const noOctree = args.includes('--no-octree');
  const diagnose = args.includes('--diagnose');

  let resolution = full ? 256 : 48;
  const resIdx = args.indexOf('--resolution');
  if (resIdx >= 0 && args[resIdx + 1]) resolution = parseInt(args[resIdx + 1], 10);

  let modelName = 'hello-twist';
  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0 && args[modelIdx + 1]) modelName = args[modelIdx + 1];

  const cacheMode = args.includes('--cache');

  let mode = 'worker';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx >= 0 && args[modeIdx + 1]) mode = args[modeIdx + 1];
  if (!cacheMode && mode !== 'worker' && mode !== 'main-thread') {
    console.error(`Unknown mode: "${mode}". Available: worker, main-thread`);
    process.exit(1);
  }

  // Cache benchmark mode: runs benchCache from evaluator.js
  if (cacheMode) {
    loadFont('helvetiker');
    console.log(`Running subtree cache benchmark at resolution ${resolution}...`);
    console.log();
    benchCache(resolution);
    return;
  }

  const modelSrc = MODELS[modelName];
  if (!modelSrc) {
    console.error(`Unknown model: "${modelName}". Available: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }

  const depth = resToDepth(resolution);
  const effectiveRes = 1 << depth;

  console.log(`Model: ${modelName} | Resolution: ${resolution} (depth ${depth}, effective ${effectiveRes})`);
  console.log(`Mode: ${mode} | Snapshot: ${update ? 'UPDATE' : 'VERIFY'}`);
  console.log();

  // Load fonts
  loadFont('helvetiker');

  // Parse
  const t0 = performance.now();
  const rawAST = parseSExpr(modelSrc);
  const ast = expandAST(rawAST);
  const tParse = performance.now() - t0;
  console.log(`Parse + expand: ${tParse.toFixed(1)}ms`);

  let meshData;
  let pipelineMs;

  if (mode === 'worker') {
    // Pre-compute text SDF grids (browser does this on main thread before sending to worker)
    const hasText = astHasText(ast);
    let tTextSDF = 0;
    if (hasText) {
      const t = performance.now();
      const textGrids = collectTextSDFGrids(ast, loadedFonts['helvetiker'], 50);
      setTextSDFGrids(textGrids);
      // Wire up the bounds provider so interval evaluator uses actual grid extents
      setTextBoundsProvider(getTextGridBounds);
      tTextSDF = performance.now() - t;
      console.log(`Text SDF grids: ${tTextSDF.toFixed(0)}ms (${Object.keys(textGrids).length} grids)`);
    }

    console.log();
    console.log(`Running worker-equivalent pipeline...`);

    const result = runWorkerPipeline(ast, depth, resolution);
    pipelineMs = result.elapsed;

    const s = result.stats;
    console.log(`  Time: ${result.elapsed}ms`);
    console.log(`  Point evals: ${s.pointEvals.toLocaleString()}`);
    console.log(`  Octree: ${s.usedOctree ? 'YES' : 'NO'}${s.bailedOut ? ' (bailed out)' : ''}`);

    meshData = extractWorkerMeshData(result);
    console.log();
    console.log(`Output: ${meshData.length} mesh(es)`);
    for (const m of meshData) {
      console.log(`  ${m.label}: ${m.vertexCount} verts, ${m.faceCount} faces`);
    }

    // Summary
    console.log();
    console.log('--- Timing Summary ---');
    console.log(`  Parse:      ${tParse.toFixed(1)}ms`);
    if (tTextSDF > 0) console.log(`  Text SDF:   ${tTextSDF.toFixed(0)}ms`);
    console.log(`  Pipeline:   ${result.elapsed}ms`);
    console.log(`  Total:      ${Math.round(tParse + tTextSDF + result.elapsed)}ms`);

  } else {
    // main-thread mode
    const useOctreeFlag = !noOctree;
    console.log();
    console.log(`Running main-thread pipeline (evaluator.js, octree ${useOctreeFlag ? 'enabled' : 'DISABLED'})...`);

    const result = runMainThreadPipeline(ast, resolution, useOctreeFlag);
    pipelineMs = result.elapsed;

    console.log(`  Time: ${result.elapsed}ms`);
    console.log(`  Stats: ${result.stats.nodes} nodes, ${result.stats.voxels.toLocaleString()} voxel evals`);
    if (result.stats.octree) {
      const o = result.stats.octree;
      const pct = o.nodesVisited > 0
        ? Math.round(100 * (o.nodesCulledOutside + o.nodesCulledInside) / o.nodesVisited)
        : 0;
      console.log(`  Octree: ${o.leafCells} leaves, ${pct}% culled${o.shallowCullRatio != null ? ` (shallow: ${(o.shallowCullRatio*100).toFixed(0)}%)` : ''}`);
    }

    meshData = extractMainThreadMeshData(result.group);
    console.log();
    console.log(`Output: ${meshData.length} mesh(es)`);
    for (const m of meshData) {
      console.log(`  ${m.label}: ${m.vertexCount} verts, ${m.faceCount} faces`);
    }

    console.log();
    console.log('--- Timing Summary ---');
    console.log(`  Parse:      ${tParse.toFixed(1)}ms`);
    console.log(`  Pipeline:   ${result.elapsed}ms`);
    console.log(`  Total:      ${Math.round(tParse + result.elapsed)}ms`);
  }

  // Diagnostic mode: compare main-thread with/without octree AND against worker
  if (diagnose) {
    console.log();
    console.log('=== DIAGNOSTIC MODE ===');
    console.log();

    // Run main-thread without octree
    console.log('Running main-thread WITHOUT octree...');
    const noOctreeResult = runMainThreadPipeline(ast, resolution, false);
    const noOctreeMesh = extractMainThreadMeshData(noOctreeResult.group);
    console.log(`  main-thread (no octree): ${noOctreeMesh.map(m => `${m.vertexCount} verts, ${m.faceCount} faces`).join('; ')}`);

    // Run main-thread with octree
    console.log('Running main-thread WITH octree...');
    const octreeResult = runMainThreadPipeline(ast, resolution, true);
    const octreeMesh = extractMainThreadMeshData(octreeResult.group);
    console.log(`  main-thread (octree):    ${octreeMesh.map(m => `${m.vertexCount} verts, ${m.faceCount} faces`).join('; ')}`);

    // Run worker path
    const hasText = astHasText(ast);
    if (hasText) {
      const textGrids = collectTextSDFGrids(ast, loadedFonts['helvetiker'], 50);
      setTextSDFGrids(textGrids);
    }
    const workerResult = runWorkerPipeline(ast, depth, resolution);
    const workerMesh = extractWorkerMeshData(workerResult);
    console.log(`  worker (uniform):        ${workerMesh.map(m => `${m.vertexCount} verts, ${m.faceCount} faces`).join('; ')}`);

    console.log();

    // Compare main-thread no-octree vs worker
    const noOctreeTotal = noOctreeMesh.reduce((s, m) => s + m.vertexCount, 0);
    const workerTotal = workerMesh.reduce((s, m) => s + m.vertexCount, 0);
    const octreeTotal = octreeMesh.reduce((s, m) => s + m.vertexCount, 0);

    if (noOctreeTotal === workerTotal) {
      console.log('RESULT: main-thread (no octree) == worker → Bug is in OCTREE path');
    } else {
      console.log(`RESULT: main-thread (no octree) != worker (${noOctreeTotal} vs ${workerTotal})`);
      console.log('  → Bug is in SDF FIELD EVALUATION (different text SDF implementations)');

      // Sample both SDF fields at the same points to find divergence
      console.log();
      console.log('Comparing SDF field values...');
      const mainField = evalField(ast);
      const workerField = evalCSGField(ast);

      let maxDiff = 0, maxDiffPoint = null;
      let samples = 0;
      const bounds = workerResult.bounds;
      const step = (bounds.max[0] - bounds.min[0]) / 20;
      for (let x = bounds.min[0]; x <= bounds.max[0]; x += step) {
        for (let y = bounds.min[1]; y <= bounds.max[1]; y += step) {
          for (let z = bounds.min[2]; z <= bounds.max[2]; z += step) {
            const mainD = mainField(x, y, z);
            const workerD = workerField(x, y, z).distance;
            const diff = Math.abs(mainD - workerD);
            if (diff > maxDiff) {
              maxDiff = diff;
              maxDiffPoint = { x, y, z, mainD, workerD };
            }
            samples++;
          }
        }
      }
      console.log(`  Sampled ${samples} points, max SDF difference: ${maxDiff.toExponential(3)}`);
      if (maxDiffPoint) {
        console.log(`  Worst point: (${maxDiffPoint.x.toFixed(2)}, ${maxDiffPoint.y.toFixed(2)}, ${maxDiffPoint.z.toFixed(2)})`);
        console.log(`    main-thread: ${maxDiffPoint.mainD.toFixed(6)}, worker: ${maxDiffPoint.workerD.toFixed(6)}`);
      }
    }

    if (octreeTotal !== noOctreeTotal) {
      console.log();
      console.log(`Octree culling impact: ${octreeTotal} verts (octree) vs ${noOctreeTotal} verts (no octree)`);
      console.log(`  Difference: ${noOctreeTotal - octreeTotal} verts (${((1 - octreeTotal/noOctreeTotal) * 100).toFixed(1)}% lost)`);

      if (octreeResult.stats.octree) {
        const o = octreeResult.stats.octree;
        console.log(`  Octree stats: ${o.nodesVisited} visited, ${o.nodesCulledOutside} culled-outside, ${o.nodesCulledInside} culled-inside`);
      }

      // Validate octree culling against the actual point field
      console.log();
      console.log('Validating octree culling decisions...');
      const bounds = estimateBoundsCSG(ast);
      const csgField = evalCSGField(ast);
      const solidField = (x, y, z) => {
        const { polarity, distance } = csgField(x, y, z);
        if (polarity > 0) return distance;
        return Math.abs(distance) + 0.01;
      };
      const intervalField = evalCSGFieldInterval(ast);
      const solidIntervalField = (xIv, yIv, zIv) => {
        const r = intervalField(xIv, yIv, zIv);
        if (r.polarity[1] <= 0) return { distance: [0.01, Infinity], polarity: [0, 0] };
        if (r.polarity[0] > 0) return r;
        return {
          distance: [Math.min(r.distance[0], -0.01), Math.max(r.distance[1], 0.01)],
          polarity: r.polarity
        };
      };

      const validation = validateOctree(solidIntervalField, solidField, bounds, resToDepth(resolution));
      console.log(`  Correct: ${validation.correctInside} inside, ${validation.correctOutside} outside`);
      console.log(`  WRONG:   ${validation.wrongInside} inside, ${validation.wrongOutside} outside`);
      if (validation.wrongCells.length > 0) {
        console.log('  Sample wrong cells:');
        for (const c of validation.wrongCells) {
          console.log(`    ${c.cls} at [${c.cell}]`);
          console.log(`      interval dist: [${c.intervalDist}], pol: [${c.intervalPol}]`);
          console.log(`      point vals: [${c.vals}]`);
        }
      }
    }

    console.log();
    console.log('=== END DIAGNOSTIC ===');
  }

  // Snapshot comparison
  console.log();
  if (update) {
    saveSnapshot(modelName, resolution, mode, meshData);
    console.log('Reference snapshot updated.');
  } else {
    const reference = loadSnapshot(modelName, resolution, mode);
    if (!reference) {
      console.log('No reference snapshot found. Run with --update to create one.');
      saveSnapshot(modelName, resolution, mode, meshData);
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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
