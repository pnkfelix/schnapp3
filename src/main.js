import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam, replaceFromAST } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate, getResolution, setResolution } from './evaluator.js';
import { parseSExpr } from './parser.js';

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
          (translate 20 0 0
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
};

const DEFAULT_MODEL_NAME = 'lizard';

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
  { text: 'resolution 128', hint: 'very fine (slow)' },
  { text: 'reset', hint: 'restore default model' },
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
  entry.textContent = `#${hudEntryCount} | ${stats.meshTime}ms | res ${stats.resolution} | ${stats.voxels.toLocaleString()} voxels | ${stats.nodes} nodes`;
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

function runPipeline() {
  if (codeEditedManually) return;
  const roots = getRootBlocks();
  const ast = generateAST(roots);

  const sexpr = ast ? formatSExpr(ast) : '(empty)';
  codeOutput.value = sexpr;
  codeOutput.style.color = '#a0d0a0';

  // Persist to localStorage
  try { localStorage.setItem('schnapp3_model', sexpr); } catch (e) {}

  // Show indicator, yield a frame so the browser paints it, then mesh
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
      const { group, stats } = evaluate(ast);
      viewport.setContent(group);
      appendHudEntry(stats);
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
