import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam, replaceFromAST, highlightBlock } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate, getResolution, getUseOctree, needsFieldEval, buildProvenanceField, setOnFontLoaded } from './evaluator.js';
import { meshProgressive } from './progressive.js';
import { resToDepth } from './octree-core.js';
import { parseSExpr } from './parser.js';
import { expandAST } from './expand.js';
import { initGPU, gpuEvaluate, gpuEvaluateOctree, gpuEvaluateOctreeProgressive, isGPUAvailable } from './gpu-engine.js';
import { runBenchmark } from './benchmark.js';
import { DEFAULT_MODELS, DEFAULT_MODEL_NAME } from './models/defaults.js';
import { initCommandBar } from './ui/command-bar.js';
import { download3MF } from './export-3mf.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

// Tap 3D view → highlight corresponding block
viewport.onTap((blockId) => {
  highlightBlock(blockId);
});

// GPU mode state
let useGPUMode = false;
let gpuInitialized = false;

// ---- HUD ----
const hudEl = document.getElementById('hud');
const MAX_HUD_ENTRIES = 20;
let hudEntryCount = 0;

function appendHudEntry(stats) {
  if (!hudEl.classList.contains('visible')) return;
  hudEntryCount++;
  const entry = document.createElement('div');
  entry.className = 'hud-entry';
  let text = `#${hudEntryCount} | ${stats.meshTime}ms | res ${stats.resolution} | ${stats.voxels.toLocaleString()} evals | ${stats.nodes} nodes`;
  if (stats.gpu) {
    text += ' | GPU';
  }
  if (stats.octree) {
    const o = stats.octree;
    const pct = o.nodesVisited > 0
      ? Math.round(100 * (o.nodesCulledOutside + o.nodesCulledInside) / o.nodesVisited)
      : 0;
    if (o.bailedOut) {
      text += ` | octree: bailed out (${pct}% cull @ depth 3), fell back to uniform`;
    } else {
      text += ` | octree: ${o.leafCells} leaves, ${pct}% culled (${o.nodesCulledOutside}out+${o.nodesCulledInside}in of ${o.nodesVisited})`;
    }
  } else {
    text += ` | uniform grid`;
  }
  if (stats.cacheHits > 0) {
    text += ` | ${stats.cacheHits} cache hit${stats.cacheHits > 1 ? 's' : ''}`;
  }
  entry.textContent = text;
  hudEl.appendChild(entry);
  // Trim old entries
  while (hudEl.children.length > MAX_HUD_ENTRIES) {
    hudEl.removeChild(hudEl.firstChild);
  }
  hudEl.scrollTop = hudEl.scrollHeight;
}

// Pipeline: block changes → codegen → eval → viewport
const codeOutput = document.getElementById('code-output');
const meshingIndicator = document.getElementById('meshing-indicator');
let pipelinePending = false;

let meshingStartTime = 0;
let meshingTimerId = null;
let meshingLastDepths = [];

function formatElapsed(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderMeshingIndicator() {
  const elapsed = formatElapsed(performance.now() - meshingStartTime);
  const resolutions = meshingLastDepths.map(d => 1 << d);
  meshingIndicator.textContent = `Meshing ${resolutions.join(', ')}... ${elapsed}`;
}

function updateMeshingStatus(inFlightDepths) {
  meshingLastDepths = inFlightDepths;
  if (inFlightDepths.length === 0) {
    if (meshingTimerId) { clearInterval(meshingTimerId); meshingTimerId = null; }
  } else {
    if (!meshingTimerId) {
      meshingStartTime = performance.now();
      meshingTimerId = setInterval(renderMeshingIndicator, 100);
    }
    renderMeshingIndicator();
  }
}

function stopMeshingTimer() {
  if (meshingTimerId) { clearInterval(meshingTimerId); meshingTimerId = null; }
  meshingIndicator.textContent = 'Meshing...';
}

let cancelProgressive = null;
let useProgressiveMode = true;

async function toggleGPUMode() {
  if (!gpuInitialized) {
    gpuInitialized = true;
    meshingIndicator.classList.add('visible');
    meshingIndicator.textContent = 'Initializing WebGPU...';
    const ok = await initGPU();
    meshingIndicator.classList.remove('visible');
    if (!ok) {
      commandInput.style.borderColor = '#e94560';
      setTimeout(() => { commandInput.style.borderColor = ''; }, 1000);
      console.warn('WebGPU not available');
      return;
    }
  }
  useGPUMode = !useGPUMode;
  console.log('GPU mode:', useGPUMode ? 'ON' : 'OFF');
  runPipeline();
}

async function runBench(singleRes) {
  // Ensure GPU is initialized
  if (!gpuInitialized) {
    gpuInitialized = true;
    meshingIndicator.classList.add('visible');
    meshingIndicator.textContent = 'Initializing WebGPU for benchmark...';
    await initGPU();
    meshingIndicator.classList.remove('visible');
  }

  // Show HUD if hidden
  if (!hudEl.classList.contains('visible')) {
    hudEl.classList.add('visible');
  }

  meshingIndicator.classList.add('visible');
  meshingIndicator.textContent = 'Running benchmark...';

  // Use requestAnimationFrame to let UI update before blocking
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const resolutions = singleRes ? [singleRes] : [24, 48, 72, 96];
  const { results, formatted } = await runBenchmark(resolutions);

  // Display results in HUD
  const entry = document.createElement('div');
  entry.className = 'hud-entry';
  entry.style.whiteSpace = 'pre';
  entry.style.fontFamily = 'monospace';
  entry.style.fontSize = '10px';
  entry.textContent = formatted;
  hudEl.appendChild(entry);
  hudEl.scrollTop = hudEl.scrollHeight;

  // Also log to console
  console.log(formatted);

  meshingIndicator.classList.remove('visible');
}

async function runGPUPipeline(ast) {
  meshingIndicator.classList.add('visible');
  meshingIndicator.textContent = 'GPU meshing...';
  pipelinePending = true;

  // Progressive GPU: serial refinement through increasing depths
  if (useProgressiveMode && getUseOctree()) {
    const targetDepth = resToDepth(getResolution());
    cancelProgressive = gpuEvaluateOctreeProgressive(ast, targetDepth, (group, depth, stats, isFinal) => {
      if (group) viewport.setContent(group);
      if (stats) {
        appendHudEntry({
          meshTime: stats.meshTime,
          resolution: stats.resolution,
          voxels: stats.octree ? (stats.octree.pointEvals || 0) : 0,
          nodes: stats.octree ? (stats.octree.leafCells || 0) : 0,
          octree: stats.octree,
          gpu: true
        });
      }
      if (isFinal) {
        meshingIndicator.classList.remove('visible');
        stopMeshingTimer();
        pipelinePending = false;
        cancelProgressive = null;
      }
    }, updateMeshingStatus);
    return;
  }

  // Non-progressive GPU
  try {
    let result = null;
    if (getUseOctree()) {
      result = await gpuEvaluateOctree(ast, getResolution());
    }
    if (!result) {
      result = await gpuEvaluate(ast, getResolution());
    }
    if (result) {
      viewport.setContent(result.group);
      appendHudEntry(result.stats);
    }
  } catch (e) {
    console.error('GPU pipeline failed:', e);
    // Fall back to CPU
    const { group, stats, retained } = evaluate(ast);
    viewport.setContent(group, retained);
    appendHudEntry(stats);
  }
  meshingIndicator.classList.remove('visible');
  pipelinePending = false;
}

function runPipeline(changedBlockId) {
  if (codeEditedManually) return;
  const roots = getRootBlocks();
  const rawAST = generateAST(roots);

  const sexpr = rawAST ? formatSExpr(rawAST) : '(empty)';
  codeOutput.value = sexpr;
  codeOutput.style.color = '#a0d0a0';

  // Persist to localStorage
  try { localStorage.setItem('schnapp3_model', sexpr); } catch (e) {}

  // Expand PL constructs (let/var/grow/stir/enzyme/tag) before evaluation
  const ast = rawAST ? expandAST(rawAST) : null;

  // Cancel any in-flight progressive mesh from previous edit
  if (cancelProgressive) {
    cancelProgressive();
    cancelProgressive = null;
    stopMeshingTimer();
  }

  // GPU path: send to WebGPU compute shader
  if (useGPUMode && isGPUAvailable() && ast) {
    runGPUPipeline(ast);
    return;
  }

  // Decide: use progressive workers for CSG models, sync for simple ones
  const useProgressive = useProgressiveMode && ast && needsFieldEval(ast);

  if (useProgressive) {
    meshingIndicator.classList.add('visible');
    pipelinePending = true;

    const currentRes = getResolution();
    const targetDepth = resToDepth(currentRes);
    const provField = buildProvenanceField(ast);
    cancelProgressive = meshProgressive(ast, targetDepth, getUseOctree(), (group, depth, stats, isFinal) => {
      viewport.setContent(group);
      if (stats) {
        appendHudEntry({
          meshTime: stats.meshTime,
          resolution: stats.resolution,
          voxels: stats.octree ? (stats.octree.pointEvals || 0) : 0,
          nodes: stats.octree ? (stats.octree.leafCells || 0) : 0,
          octree: stats.octree
        });
      }
      if (isFinal) {
        meshingIndicator.classList.remove('visible');
        stopMeshingTimer();
        pipelinePending = false;
        cancelProgressive = null;
      }
    }, updateMeshingStatus, provField, currentRes);
  } else {
    // Simple model — sync eval (instant)
    if (pipelinePending) return;
    pipelinePending = true;
    meshingIndicator.classList.add('visible');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const { group, stats, retained } = evaluate(ast, changedBlockId);
        viewport.setContent(group, retained);
        appendHudEntry(stats);
        meshingIndicator.classList.remove('visible');
        pipelinePending = false;
      });
    });
  }
}

subscribe((changedBlockId) => {
  codeEditedManually = false;
  runPipeline(changedBlockId);
});

// Re-render when a text font finishes loading from CDN
setOnFontLoaded(() => runPipeline());

// Manual code editing → parse → eval → 3D
let codeEditedManually = false;

codeOutput.addEventListener('input', () => {
  codeEditedManually = true;
  try {
    const rawAST = parseSExpr(codeOutput.value);
    const ast = rawAST ? expandAST(rawAST) : null;
    if (ast) {
      replaceFromAST(rawAST);  // blocks reflect the unexpanded AST
      renderWorkspace();

      // Cancel previous progressive
      if (cancelProgressive) { cancelProgressive(); cancelProgressive = null; stopMeshingTimer(); }

      if (useGPUMode && isGPUAvailable()) {
        runGPUPipeline(ast);
      } else if (useProgressiveMode && needsFieldEval(ast)) {
        const currentRes2 = getResolution();
        const targetDepth = resToDepth(currentRes2);
        const provField = buildProvenanceField(ast);
        meshingIndicator.classList.add('visible');
        cancelProgressive = meshProgressive(ast, targetDepth, getUseOctree(), (group, depth, stats, isFinal) => {
          viewport.setContent(group);
          if (stats) {
            appendHudEntry({
              meshTime: stats.meshTime, resolution: stats.resolution,
              voxels: stats.octree ? (stats.octree.pointEvals || 0) : 0,
              nodes: stats.octree ? (stats.octree.leafCells || 0) : 0, octree: stats.octree
            });
          }
          if (isFinal) {
            meshingIndicator.classList.remove('visible');
            stopMeshingTimer();
            cancelProgressive = null;
          }
        }, updateMeshingStatus, provField, currentRes2);
      } else {
        const { group, stats, retained } = evaluate(ast);
        viewport.setContent(group, retained);
        appendHudEntry(stats);
      }
      try { localStorage.setItem('schnapp3_model', codeOutput.value); } catch (e) {}
    }
    codeOutput.style.color = '#a0d0a0';
  } catch (e) {
    codeOutput.style.color = '#e94560';
  }
});

function loadModel(sexpr) {
  codeEditedManually = false;
  const ast = parseSExpr(sexpr);
  if (ast) {
    replaceFromAST(ast);
    renderWorkspace();
    runPipeline();
  }
}

function loadDefaultModel(name) {
  const modelName = name && DEFAULT_MODELS[name] ? name : DEFAULT_MODEL_NAME;
  try { localStorage.removeItem('schnapp3_model'); } catch (e) {}
  loadModel(DEFAULT_MODELS[modelName]);
}

// Initialize command bar with callbacks into main module
initCommandBar(Object.keys(DEFAULT_MODELS), {
  viewport,
  runPipeline,
  toggleGPUMode,
  runBench,
  loadDefaultModel,
  toggleHud() {
    hudEl.classList.toggle('visible');
    if (hudEl.classList.contains('visible')) {
      hudEl.innerHTML = '';
      hudEntryCount = 0;
      codeEditedManually = false;
      runPipeline();
    }
  },
  toggleProgressive() {
    useProgressiveMode = !useProgressiveMode;
  },
  export3MF() {
    const content = viewport.getContent();
    if (!download3MF(content)) {
      console.warn('export 3mf: scene is empty, nothing to export');
    }
  },
});

// Load saved model or default
// ?reset in the URL bypasses localStorage (escape hatch for crash loops)
// Crash guard: if previous load crashed (flag still set), skip saved model
const params = new URLSearchParams(window.location.search);
const safeMode = params.has('reset');
if (safeMode) {
  try { localStorage.removeItem('schnapp3_model'); } catch (e) {}
}
const previousCrash = (() => { try { return localStorage.getItem('schnapp3_loading') === 'true'; } catch (e) { return false; } })();
if (previousCrash) {
  try { localStorage.removeItem('schnapp3_loading'); } catch (e) {}
  try { localStorage.removeItem('schnapp3_model'); } catch (e) {}
  console.warn('Schnapp3: previous load crashed, loading default model');
}
const saved = (safeMode || previousCrash) ? null : (() => { try { return localStorage.getItem('schnapp3_model'); } catch (e) { return null; } })();
try { localStorage.setItem('schnapp3_loading', 'true'); } catch (e) {}
loadModel(saved || DEFAULT_MODELS[DEFAULT_MODEL_NAME]);
try { localStorage.removeItem('schnapp3_loading'); } catch (e) {}
