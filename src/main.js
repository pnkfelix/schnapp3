import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate } from './evaluator.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

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
  // Unknown command — flash the input red briefly
  commandInput.style.borderColor = '#e94560';
  setTimeout(() => { commandInput.style.borderColor = ''; }, 500);
}

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

// Pipeline: block changes → codegen → eval → viewport
const codeOutput = document.getElementById('code-output');

function runPipeline() {
  const roots = getRootBlocks();
  const ast = generateAST(roots);

  // Update code preview
  codeOutput.textContent = ast ? formatSExpr(ast) : '(empty)';

  // Update 3D viewport
  const group = evaluate(ast);
  viewport.setContent(group);
}

subscribe(runPipeline);

// Seed default scene: union of translated red cube + blue sphere
const union = addBlockToRoot('union');
const translate = addBlockAsChild('translate', union.id);
updateParam(translate.id, 'x', 15);
const cube = addBlockAsChild('cube', translate.id);
updateParam(cube.id, 'color', 'red');
addBlockAsChild('sphere', union.id);

renderWorkspace();
runPipeline();
