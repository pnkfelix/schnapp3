import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate } from './evaluator.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

// Tab bar: switch between panels (one at a time)
const tabs = document.querySelectorAll('.tab');
const mainPanels = document.querySelectorAll('.panel[data-panel="workspace"], .panel[data-panel="code"], .panel[data-panel="3d"]');

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const panelName = tab.dataset.tab;
    // Deactivate all main panels and tabs
    for (const t of tabs) t.classList.remove('tab--active');
    for (const p of mainPanels) p.classList.remove('panel--active');
    // Activate selected
    tab.classList.add('tab--active');
    document.querySelector(`.panel[data-panel="${panelName}"]`).classList.add('panel--active');
  });
}

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
