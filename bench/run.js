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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { parseSExpr } from '../src/parser.js';
import { expandAST } from '../src/expand.js';
// Worker path imports
import { evalCSGField, estimateBounds as estimateBoundsCSG, UNSET_COLOR, UNSET_RGB, setTextSDFGrids } from '../src/csg-field.js';
import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth } from '../src/octree-core.js';
// Main-thread path imports
import { evaluate, setResolution, setUseOctree } from '../src/evaluator.js';
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
// Mode: worker — replicates mesh-worker.js logic exactly
// ============================================================

function runWorkerPipeline(ast, depth) {
  const t0 = performance.now();

  const bounds = estimateBoundsCSG(ast);
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

  // Disable octree for ASTs containing text nodes — same as mesh-worker.js
  const hasText = astHasText(ast);
  if (!hasText) {
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
    hasText,
  };
}

// ============================================================
// Mode: main-thread — replicates evaluator.js sync path
// ============================================================

function runMainThreadPipeline(ast, resolution) {
  setResolution(resolution);
  setUseOctree(true);

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

  let resolution = full ? 256 : 48;
  const resIdx = args.indexOf('--resolution');
  if (resIdx >= 0 && args[resIdx + 1]) resolution = parseInt(args[resIdx + 1], 10);

  let modelName = 'hello-twist';
  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0 && args[modelIdx + 1]) modelName = args[modelIdx + 1];

  let mode = 'worker';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx >= 0 && args[modeIdx + 1]) mode = args[modeIdx + 1];
  if (mode !== 'worker' && mode !== 'main-thread') {
    console.error(`Unknown mode: "${mode}". Available: worker, main-thread`);
    process.exit(1);
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
      tTextSDF = performance.now() - t;
      console.log(`Text SDF grids: ${tTextSDF.toFixed(0)}ms (${Object.keys(textGrids).length} grids)`);
    }

    console.log();
    console.log(`Running worker-equivalent pipeline...`);
    if (hasText) console.log(`  (text detected → octree DISABLED, using uniform grid)`);

    const result = runWorkerPipeline(ast, depth);
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
    console.log();
    console.log(`Running main-thread pipeline (evaluator.js, octree enabled)...`);

    const result = runMainThreadPipeline(ast, resolution);
    pipelineMs = result.elapsed;

    console.log(`  Time: ${result.elapsed}ms`);
    console.log(`  Stats: ${result.stats.nodes} nodes, ${result.stats.voxels.toLocaleString()} voxel evals`);
    if (result.stats.octree) {
      const o = result.stats.octree;
      const pct = o.nodesVisited > 0
        ? Math.round(100 * (o.nodesCulledOutside + o.nodesCulledInside) / o.nodesVisited)
        : 0;
      console.log(`  Octree: ${o.leafCells} leaves, ${pct}% culled`);
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
