#!/usr/bin/env node
// Schnapp3 Node.js benchmark harness
//
// Replicates the browser's Web Worker rendering path:
//   parse → expand → evalCSGField → uniform grid (for text models) → surface nets
//
// This is the SAME code path the browser uses (mesh-worker.js + csg-field.js),
// not the main-thread evaluator.js path (which uses octree even for text).
//
// Usage:
//   npm run bench                    # run benchmark, compare against reference
//   npm run bench -- --update        # regenerate reference snapshot
//   npm run bench -- --resolution 64 # override resolution (default: 48 for fast, 256 for full)
//   npm run bench -- --model NAME    # use a named model (default: "hello-twist")
//   npm run bench -- --full          # run at resolution 256 (the real target)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { parseSExpr } from '../src/parser.js';
import { expandAST } from '../src/expand.js';
import { evalCSGField, estimateBounds, UNSET_COLOR, UNSET_RGB, setTextSDFGrids } from '../src/csg-field.js';
import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { buildOctree, meshOctreeLeavesRaw, meshFieldRaw, resToDepth } from '../src/octree-core.js';
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

// ---- Worker-equivalent pipeline ----
// Replicates mesh-worker.js logic exactly

function runWorkerPipeline(ast, depth) {
  const t0 = performance.now();

  const bounds = estimateBounds(ast);
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
    // Uniform fallback at full requested resolution — same as mesh-worker.js
    const fallbackRes = 1 << depth;
    solidRaw = meshFieldRaw(solidField, bounds, fallbackRes, solidColorField);
    stats.pointEvals = (fallbackRes + 1) ** 3;
  }

  // Anti-solid (always uniform, capped at reasonable res) — same as mesh-worker.js
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

// ---- Snapshot helpers ----

function extractMeshData(result) {
  const meshes = [];
  for (const key of ['solid', 'anti']) {
    const raw = result[key];
    if (!raw || !raw.positions || raw.positions.length === 0) continue;
    const vertexCount = raw.positions.length / 3;
    const faceCount = raw.faces.length / 3;
    meshes.push({
      label: key,
      vertexCount,
      faceCount,
      positions: Array.from(raw.positions.slice(0, Math.min(300, raw.positions.length))),
      positionHash: hashFloat32(raw.positions),
      indexHash: hashArray(raw.faces),
    });
  }
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

  const modelSrc = MODELS[modelName];
  if (!modelSrc) {
    console.error(`Unknown model: "${modelName}". Available: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }

  const depth = resToDepth(resolution);
  const effectiveRes = 1 << depth;

  console.log(`Model: ${modelName} | Resolution: ${resolution} (depth ${depth}, effective ${effectiveRes})`);
  console.log(`Mode: ${update ? 'UPDATE' : 'VERIFY'} | Path: worker-equivalent (csg-field.js)`);
  console.log();

  // Load fonts
  loadFont('helvetiker');

  // Parse
  const t0 = performance.now();
  const rawAST = parseSExpr(modelSrc);
  const ast = expandAST(rawAST);
  const tParse = performance.now() - t0;
  console.log(`Parse + expand: ${tParse.toFixed(1)}ms`);

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

  // Bounds estimation
  const t1 = performance.now();
  const bounds = estimateBounds(ast);
  const tBounds = performance.now() - t1;
  console.log(`Bounds: [${bounds.min.map(v => v.toFixed(1))}] to [${bounds.max.map(v => v.toFixed(1))}]`);

  // Run the worker-equivalent pipeline
  console.log();
  console.log(`Running worker-equivalent pipeline...`);
  if (hasText) console.log(`  (text detected → octree DISABLED, using uniform grid)`);

  const result = runWorkerPipeline(ast, depth);

  const s = result.stats;
  console.log(`  Time: ${result.elapsed}ms`);
  console.log(`  Point evals: ${s.pointEvals.toLocaleString()}`);
  console.log(`  Octree: ${s.usedOctree ? 'YES' : 'NO'}${s.bailedOut ? ' (bailed out)' : ''}`);

  // Extract mesh data for comparison
  const meshData = extractMeshData(result);
  console.log();
  console.log(`Output: ${meshData.length} mesh(es)`);
  for (const m of meshData) {
    console.log(`  ${m.label}: ${m.vertexCount} verts, ${m.faceCount} faces`);
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
  console.log(`  Parse:      ${tParse.toFixed(1)}ms`);
  if (tTextSDF > 0) console.log(`  Text SDF:   ${tTextSDF.toFixed(0)}ms`);
  console.log(`  Pipeline:   ${result.elapsed}ms`);
  console.log(`  Total:      ${Math.round(tParse + tTextSDF + result.elapsed)}ms`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
