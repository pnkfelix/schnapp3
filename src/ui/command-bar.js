// Command bar: autocomplete, parsing, and execution.

import { getResolution, setResolution, getUseOctree, setUseOctree, getAntiCheckerSize, setAntiCheckerSize, cycleAntiWireframeMode, clearSubtreeCache, getSubtreeCacheStats } from '../evaluator.js';

// Callbacks injected by main.js via initCommandBar()
let ctx = null;

const PANEL_NAMES = ['blocks', 'code', '3d'];
const PANEL_MAP = { blocks: 'workspace', code: 'code', '3d': '3d' };

function showPanels(names) {
  for (const p of document.querySelectorAll('#workspace-panel, #code-panel, #viewport-panel')) {
    p.classList.remove('panel--active');
  }
  for (const name of names.slice(0, 2)) {
    const dataPanel = PANEL_MAP[name];
    if (dataPanel) {
      document.querySelector(`.panel[data-panel="${dataPanel}"]`).classList.add('panel--active');
    }
  }
}

const PREFIX_HINTS = {
  show: 'choose visible panels',
  resolution: 'set mesh resolution',
  reset: 'load a model',
  bench: 'run performance benchmark',
  visual: 'anti-solid visualization',
  export: 'export model to file',
};

let COMMANDS = [];

const commandInput = document.getElementById('command-input');
const autocompleteEl = document.getElementById('autocomplete');
let selectedIndex = -1;

function updateAutocomplete() {
  const val = commandInput.value.trim().toLowerCase();

  if (val.length === 0) {
    const prefixes = [];
    const seen = new Set();
    for (const c of COMMANDS) {
      const first = c.text.split(/\s+/)[0];
      if (!seen.has(first)) {
        seen.add(first);
        prefixes.push(first);
      }
    }
    selectedIndex = -1;
    autocompleteEl.innerHTML = '';
    for (const prefix of prefixes) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      const cmdsWithPrefix = COMMANDS.filter(c => c.text.split(/\s+/)[0] === prefix);
      if (cmdsWithPrefix.length === 1) {
        item.textContent = cmdsWithPrefix[0].text;
        const hint = document.createElement('span');
        hint.className = 'autocomplete-hint';
        hint.textContent = cmdsWithPrefix[0].hint;
        item.appendChild(hint);
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          commandInput.value = cmdsWithPrefix[0].text;
          autocompleteEl.classList.remove('visible');
          executeCommand(cmdsWithPrefix[0].text);
        });
      } else {
        item.textContent = prefix + '…';
        if (PREFIX_HINTS[prefix]) {
          const hint = document.createElement('span');
          hint.className = 'autocomplete-hint';
          hint.textContent = PREFIX_HINTS[prefix];
          item.appendChild(hint);
        }
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          commandInput.value = prefix + ' ';
          updateAutocomplete();
        });
      }
      autocompleteEl.appendChild(item);
    }
    autocompleteEl.classList.add('visible');
    return;
  }

  const matches = COMMANDS.filter(c => c.text.startsWith(val) || c.text.includes(val));

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
      e.preventDefault();
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
    ctx.toggleHud();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'octree') {
    setUseOctree(!getUseOctree());
    ctx.runPipeline();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'progressive') {
    ctx.toggleProgressive();
    ctx.runPipeline();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'gpu') {
    ctx.toggleGPUMode();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'bench') {
    ctx.runBench(parts[1] ? parseInt(parts[1], 10) : null);
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'resolution' && parts[1]) {
    const n = parseInt(parts[1], 10);
    if (!isNaN(n)) {
      setResolution(n);
      ctx.runPipeline();
      commandInput.value = '';
      commandInput.blur();
      return;
    }
  }
  if (parts[0] === 'visual' && parts[1] === 'anti' && parts[2] === 'via' && parts[3] === 'checker' && parts[4]) {
    const n = parseFloat(parts[4]);
    if (!isNaN(n) && n > 0) {
      setAntiCheckerSize(n);
      clearSubtreeCache();
      ctx.runPipeline();
      commandInput.value = '';
      commandInput.blur();
      return;
    }
  }
  if (parts[0] === 'visual' && parts[1] === 'anti' && parts[2] === 'via' && parts[3] === 'wireframe') {
    const mode = cycleAntiWireframeMode();
    console.log('anti wireframe:', mode);
    clearSubtreeCache();
    ctx.runPipeline();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'focus') {
    if (parts[1] === 'reset') {
      ctx.viewport.resetFocus();
    } else {
      const t = ctx.viewport.getFocusTarget();
      console.log(`focus target: (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`);
    }
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'export' && parts[1] === '3mf') {
    ctx.export3MF();
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'reset') {
    ctx.loadDefaultModel(parts[1]);
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  if (parts[0] === 'cache') {
    if (parts[1] === 'clear') {
      clearSubtreeCache();
      console.log('Subtree cache cleared');
    } else {
      const s = getSubtreeCacheStats();
      console.log(`Subtree cache: ${s.entries}/${s.maxEntries} entries`);
    }
    commandInput.value = '';
    commandInput.blur();
    return;
  }
  // Unknown command — flash the input red briefly
  commandInput.style.borderColor = '#e94560';
  setTimeout(() => { commandInput.style.borderColor = ''; }, 500);
}

// Set up event listeners
document.getElementById('command-go').addEventListener('click', () => {
  executeCommand(commandInput.value);
});

commandInput.addEventListener('input', updateAutocomplete);
commandInput.addEventListener('focus', updateAutocomplete);
commandInput.addEventListener('blur', () => {
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
      const cmd = COMMANDS.find(c => items[selectedIndex].textContent.startsWith(c.text));
      if (cmd) commandInput.value = cmd.text;
    }
    autocompleteEl.classList.remove('visible');
    executeCommand(commandInput.value);
  }
});

export function initCommandBar(modelNames, callbacks) {
  ctx = callbacks;

  COMMANDS = [
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
    { text: 'visual anti via checker 1', hint: 'anti-solid checker size: tiny' },
    { text: 'visual anti via checker 3', hint: 'anti-solid checker size: default' },
    { text: 'visual anti via checker 5', hint: 'anti-solid checker size: large' },
    { text: 'visual anti via checker 10', hint: 'anti-solid checker size: very large' },
    { text: 'visual anti via wireframe', hint: 'cycle: off → full → edges' },
    { text: 'export 3mf', hint: 'download 3MF for 3D printing (multi-color)' },
    { text: 'cache', hint: 'show subtree cache stats' },
    { text: 'cache clear', hint: 'clear subtree mesh cache' },
    { text: 'focus reset', hint: 'reset camera focus to origin' },
    { text: 'focus', hint: 'show current camera focus point' },
    ...modelNames.map(name => ({
      text: `reset ${name}`, hint: `load ${name} model`
    })),
  ];
}
