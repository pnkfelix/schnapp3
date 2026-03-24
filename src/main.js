import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam, replaceFromAST } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate, getResolution, setResolution, getUseOctree, setUseOctree, needsFieldEval } from './evaluator.js';
import { meshProgressive } from './progressive.js';
import { resToDepth } from './octree-core.js';
import { parseSExpr } from './parser.js';
import { initGPU, gpuEvaluate, gpuEvaluateOctree, isGPUAvailable } from './gpu-engine.js';
import { runBenchmark } from './benchmark.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

// Named default models (S-expr strings)
const DEFAULT_MODELS = {
  lizard: `(union
  (paint :color "orange"
    (union
      (translate 5 15 5
        (sphere 5))
      (translate 5 15 -5
        (sphere 5))))
  (intersect
    (union
      (paint :color "green"
        (fuse :k 5
          (translate 18 0 0
            (cube 10))
          (sphere 15)))
      (anti
        (cylinder 8 30)))))`,

  csg: `(union
  (intersect
    (cube 25)
    (sphere 18))
  (translate 40 0 0
    (union
      (cube 20)
      (anti
        (sphere 12))))
  (translate -40 0 0
    (fuse :k 5
      (cube 20)
      (anti
        (sphere 12)))))`,

  cube: `(cube 20)`,

  warps: `(union
  (mirror :axis "x"
    (translate 12 0 0
      (sphere 8)))
  (translate 40 0 0
    (twist :axis "y" :rate 0.15
      (cube 20)))
  (translate -40 0 0
    (radial :axis "y" :count 6
      (translate 12 0 0
        (sphere 5))))
  (translate 0 30 0
    (stretch :sx 2 :sy 0.5 :sz 1
      (sphere 12)))
  (translate 0 -30 0
    (bend :axis "y" :rate 0.04
      (paint :color "green"
        (cube 25))))
  (translate 0 0 40
    (taper :axis "y" :rate 0.03
      (paint :color "orange"
        (cylinder 10 40)))))`,
};

const DEFAULT_MODEL_NAME = 'lizard';

// GPU mode state
let useGPUMode = false;
let gpuInitialized = false;

// ---- Command bar ----

const PANEL_NAMES = ['blocks', 'code', '3d'];
const PANEL_MAP = { blocks: 'workspace', code: 'code', '3d': '3d' };

function showPanels(names) {
  // Deactivate all main panels
  for (const p of document.querySelectorAll('#workspace-panel, #code-panel, #viewport-panel')) {
    p.classList.remove('panel--active');
  }
  // Activate requested (max 2)
  for (const name of names.slice(0, 2)) {
    const dataPanel = PANEL_MAP[name];
    if (dataPanel) {
      document.querySelector(`.panel[data-panel="${dataPanel}"]`).classList.add('panel--active');
    }
  }
}

const COMMANDS = [
  { text: 'show blocks 3d', hint: 'blocks + 3D preview' },
  { text: 'show blocks code', hint: 'blocks + code preview' },
  { text: 'show blocks', hint: 'blocks only' },
  { text: 'show 3d', hint: '3D preview only' },
  { text: 'show code', hint: 'code preview only' },
  { text: 'show code 3d', hint: 'code + 3D preview' },
  { text: 'hud', hint: 'toggle meshing stats overlay' },
  { text: 'resolution 48', hint: 'default (fast)' },
  { text: 'resolution 72', hint: 'medium' },
  { text: 'resolution 96', hint: 'fine' },
  { text: 'resolution 128', hint: 'very fine' },
  { text: 'resolution 256', hint: 'ultra (octree recommended)' },
  { text: 'resolution 512', hint: 'extreme (octree only)' },
  { text: 'reset', hint: 'restore default model' },
  { text: 'octree', hint: 'toggle octree acceleration on/off' },
  { text: 'progressive', hint: 'toggle progressive refinement on/off' },
  { text: 'gpu', hint: 'toggle WebGPU SDF evaluation on/off' },
  { text: 'bench', hint: 'run GPU vs CPU performance benchmark' },
  { text: 'bench 48', hint: 'benchmark at resolution 48 only' },
  { text: 'bench 96', hint: 'benchmark at resolution 96 only' },
  ...Object.keys(DEFAULT_MODELS).map(name => ({
    text: `reset ${name}`, hint: `load ${name} model`
  })),
];

const commandInput = document.getElementById('command-input');
const autocompleteEl = document.getElementById('autocomplete');
let selectedIndex = -1;

function updateAutocomplete() {
  const val = commandInput.value.trim().toLowerCase();
  const matches = val.length === 0
    ? COMMANDS
    : COMMANDS.filter(c => c.text.startsWith(val) || c.text.includes(val));

  if (matches.length === 0 || (matches.length === 1 && matches[0].text === val)) {
    autocompleteEl.classList.remove('visible');
    return;
  }

  selectedIndex = -1;
  autocompleteEl.innerHTML = '';
  for (let i = 0; i < matches.length; i++) {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.textContent = matches[i].text;
    const hint = document.createElement('span');
    hint.className = 'autocomplete-hint';
    hint.textContent = matches[i].hint;
    item.appendChild(hint);
    item.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // keep focus on input
      commandInput.value = matches[i].text;
      autocompleteEl.classList.remove('visible');
      executeCommand(matches[i].text);
    });
    autocompleteEl.appendChild(item);
  }
  autocompleteEl.classList.add('visible');
}

function executeCommand(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts[0] === 'show' && parts.length >= 2) {
    const panels = parts.slice(1).filter(p => PANEL_NAMES.includes(p));
    if (panels.length > 0) {
      showPanels(panels);
      commandInput.value = '';
      commandInput.blur();
      return;
    }
  }
  if (parts[0] === 'hud') {
    hudEl.classList.toggle('visible');
    if (hudEl.classList.contains('visible')) {
      hudEl.innerHTML = '';
      hudEntryCount = 0;
      codeEditedManually = false;
      runPipeline();
    }
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'octree') {
    setUseOctree(!getUseOctree());
    runPipeline();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'progressive') {
    useProgressiveMode = !useProgressiveMode;
    runPipeline();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'gpu') {
    toggleGPUMode();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'bench') {
    runBench(parts[1] ? parseInt(parts[1], 10) : null);
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'resolution' && parts[1]) {
    const n = parseInt(parts[1], 10);
    if (!isNaN(n)) {
      setResolution(n);
      runPipeline();
      commandInput.value = '';
      commandInput.blur();
      return;
    }
  }
  if (parts[0] === 'reset') {
    loadDefaultModel(parts[1]);
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  // Unknown command — flash the input red briefly
  commandInput.style.borderColor = '#e94560';
  setTimeout(() => { commandInput.style.borderColor = ''; }, 500);
}

document.getElementById('command-go').addEventListener('click', () => {
  executeCommand(commandInput.value);
});

commandInput.addEventListener('input', updateAutocomplete);
commandInput.addEventListener('focus', updateAutocomplete);
commandInput.addEventListener('blur', () => {
  // Delay to allow pointerdown on autocomplete items
  setTimeout(() => autocompleteEl.classList.remove('visible'), 150);
});
commandInput.addEventListener('keydown', (e) => {
  const items = autocompleteEl.querySelectorAll('.autocomplete-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (e.key === 'ArrowDown') selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    else selectedIndex = Math.max(selectedIndex - 1, -1);
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('autocomplete-item--selected', i === selectedIndex);
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedIndex >= 0 && items[selectedIndex]) {
      commandInput.value = items[selectedIndex].textContent.replace(/\s+[a-z+ ]+$/, '');
      // Extract just the command text (before the hint)
      const cmd = COMMANDS.find(c => items[selectedIndex].textContent.startsWith(c.text));
      if (cmd) commandInput.value = cmd.text;
    }
    autocompleteEl.classList.remove('visible');
    executeCommand(commandInput.value);
  }
});

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
  try {
    // Use octree+GPU when octree is enabled, uniform GPU otherwise
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
    const { group, stats } = evaluate(ast);
    viewport.setContent(group);
    appendHudEntry(stats);
  }
  meshingIndicator.classList.remove('visible');
  pipelinePending = false;
}

function runPipeline() {
  if (codeEditedManually) return;
  const roots = getRootBlocks();
  const ast = generateAST(roots);

  const sexpr = ast ? formatSExpr(ast) : '(empty)';
  codeOutput.value = sexpr;
  codeOutput.style.color = '#a0d0a0';

  // Persist to localStorage
  try { localStorage.setItem('schnapp3_model', sexpr); } catch (e) {}

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

    const targetDepth = resToDepth(getResolution());
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
    }, updateMeshingStatus);
  } else {
    // Simple model — sync eval (instant)
    if (pipelinePending) return;
    pipelinePending = true;
    meshingIndicator.classList.add('visible');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const { group, stats } = evaluate(ast);
        viewport.setContent(group);
        appendHudEntry(stats);
        meshingIndicator.classList.remove('visible');
        pipelinePending = false;
      });
    });
  }
}

subscribe(() => {
  codeEditedManually = false;
  runPipeline();
});

// Manual code editing → parse → eval → 3D
let codeEditedManually = false;

codeOutput.addEventListener('input', () => {
  codeEditedManually = true;
  try {
    const ast = parseSExpr(codeOutput.value);
    if (ast) {
      replaceFromAST(ast);
      renderWorkspace();

      // Cancel previous progressive
      if (cancelProgressive) { cancelProgressive(); cancelProgressive = null; stopMeshingTimer(); }

      if (useGPUMode && isGPUAvailable()) {
        runGPUPipeline(ast);
      } else if (useProgressiveMode && needsFieldEval(ast)) {
        const targetDepth = resToDepth(getResolution());
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
        }, updateMeshingStatus);
      } else {
        const { group, stats } = evaluate(ast);
        viewport.setContent(group);
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

// Load saved model or default
const saved = (() => { try { return localStorage.getItem('schnapp3_model'); } catch (e) { return null; } })();
loadModel(saved || DEFAULT_MODELS[DEFAULT_MODEL_NAME]);
