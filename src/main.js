import { createViewport } from './viewport.js';
import { initPalette, initWorkspace, renderWorkspace, subscribe, getRootBlocks, addBlockToRoot, addBlockAsChild, updateParam } from './blocks.js';
import { generateAST, formatSExpr } from './codegen.js';
import { evaluate } from './evaluator.js';

// Boot viewport
const viewport = createViewport(document.getElementById('viewport-panel'));

// Boot block editor
initPalette(document.getElementById('palette'));
initWorkspace(document.getElementById('workspace'));

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
