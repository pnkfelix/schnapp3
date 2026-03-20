import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate } from './evaluator.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

// Tab bar: toggle panels, max 2 main panels at a time
const MAX_PANELS = 2;

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const panelName = tab.dataset.tab;
    const panel = document.querySelector(`.panel[data-panel="${panelName}"]`);
    const isActive = tab.classList.contains('tab--active');

    if (isActive) {
      // Don't allow turning off the last panel
      const activeCount = document.querySelectorAll('.tab.tab--active').length;
      if (activeCount <= 1) return;
      tab.classList.remove('tab--active');
      panel.classList.remove('panel--active');
    } else {
      // If at max, turn off the first active one
      const activeTabs = [...document.querySelectorAll('.tab.tab--active')];
      if (activeTabs.length >= MAX_PANELS) {
        const oldest = activeTabs[0];
        oldest.classList.remove('tab--active');
        document.querySelector(`.panel[data-panel="${oldest.dataset.tab}"]`).classList.remove('panel--active');
      }
      tab.classList.add('tab--active');
      panel.classList.add('panel--active');
    }
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
