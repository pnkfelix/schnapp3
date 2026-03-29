import { initDragDrop, onPaletteDragStart, onBlockDragStart } from './ui/drag-drop.js';

// ---- Block type definitions ----

const ALL_COLORS = ['unset', 'gray', 'red', 'blue', 'green', 'orange', 'yellow'];

export const BLOCK_DEFS = {
  cube: {
    label: 'Cube',
    category: 'primitive',
    params: [
      { name: 'size', type: 'number', default: 20, min: 1, max: 200 }
    ],
    maxChildren: 0
  },
  sphere: {
    label: 'Sphere',
    category: 'primitive',
    params: [
      { name: 'radius', type: 'number', default: 15, min: 1, max: 200 }
    ],
    maxChildren: 0
  },
  cylinder: {
    label: 'Cylinder',
    category: 'primitive',
    params: [
      { name: 'radius', type: 'number', default: 10, min: 1, max: 200 },
      { name: 'height', type: 'number', default: 30, min: 1, max: 200 }
    ],
    maxChildren: 0
  },
  translate: {
    label: 'Translate',
    category: 'transform',
    params: [
      { name: 'x', type: 'number', default: 0, min: -200, max: 200 },
      { name: 'y', type: 'number', default: 0, min: -200, max: 200 },
      { name: 'z', type: 'number', default: 0, min: -200, max: 200 }
    ],
    maxChildren: 1
  },
  rotate: {
    label: 'Rotate',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'y', options: ['x', 'y', 'z'] },
      { name: 'angle', type: 'number', default: 45, min: -360, max: 360 }
    ],
    maxChildren: 1
  },
  paint: {
    label: 'Paint',
    category: 'appearance',
    params: [
      { name: 'color', type: 'color', default: 'red', options: ALL_COLORS }
    ],
    maxChildren: 1
  },
  recolor: {
    label: 'Recolor',
    category: 'appearance',
    params: [
      { name: 'from', type: 'color', default: 'gray', options: ALL_COLORS },
      { name: 'to', type: 'color', default: 'red', options: ALL_COLORS }
    ],
    maxChildren: 1
  },
  union: {
    label: 'Union',
    category: 'combine',
    params: [],
    maxChildren: Infinity
  },
  fuse: {
    label: 'Fuse',
    category: 'combine',
    params: [
      { name: 'k', type: 'number', default: 5, min: 0.1, max: 50 }
    ],
    maxChildren: Infinity
  },
  intersect: {
    label: 'Intersect',
    category: 'combine',
    params: [],
    maxChildren: Infinity
  },
  anti: {
    label: 'Anti',
    category: 'combine',
    params: [],
    maxChildren: 1
  },
  complement: {
    label: 'Complement',
    category: 'combine',
    params: [],
    maxChildren: 1
  },
  mirror: {
    label: 'Mirror',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'x', options: ['x', 'y', 'z'] }
    ],
    maxChildren: 1
  },
  twist: {
    label: 'Twist',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'y', options: ['x', 'y', 'z'] },
      { name: 'rate', type: 'number', default: 0.1, min: -1, max: 1 }
    ],
    maxChildren: 1
  },
  radial: {
    label: 'Radial',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'y', options: ['x', 'y', 'z'] },
      { name: 'count', type: 'number', default: 6, min: 2, max: 36 }
    ],
    maxChildren: 1
  },
  stretch: {
    label: 'Stretch',
    category: 'transform',
    params: [
      { name: 'sx', type: 'number', default: 1, min: 0.1, max: 10 },
      { name: 'sy', type: 'number', default: 1, min: 0.1, max: 10 },
      { name: 'sz', type: 'number', default: 1, min: 0.1, max: 10 }
    ],
    maxChildren: 1
  },
  tile: {
    label: 'Tile',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'x', options: ['x', 'y', 'z'] },
      { name: 'spacing', type: 'number', default: 30, min: 1, max: 200 }
    ],
    maxChildren: 1
  },
  bend: {
    label: 'Bend',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'y', options: ['x', 'y', 'z'] },
      { name: 'rate', type: 'number', default: 0.05, min: -0.5, max: 0.5 }
    ],
    maxChildren: 1
  },
  taper: {
    label: 'Taper',
    category: 'transform',
    params: [
      { name: 'axis', type: 'color', default: 'y', options: ['x', 'y', 'z'] },
      { name: 'rate', type: 'number', default: 0.02, min: -0.1, max: 0.1 }
    ],
    maxChildren: 1
  },
  // ---- PL blocks ----
  let: {
    label: 'Let',
    category: 'binding',
    params: [
      { name: 'name', type: 'text', default: 'x' }
    ],
    maxChildren: 2   // child 0 = value expression, child 1 = body expression
  },
  var: {
    label: 'Var',
    category: 'binding',
    params: [
      { name: 'name', type: 'text', default: 'x' }
    ],
    maxChildren: 0   // leaf node — references a bound name
  },
  grow: {
    label: 'Grow',
    category: 'binding',
    params: [
      { name: 'name', type: 'text', default: 'acc' },
      { name: 'count', type: 'number', default: 4, min: 1, max: 50 }
    ],
    maxChildren: 2   // child 0 = seed, child 1 = step body (may reference 'name')
  },
  stir: {
    label: 'Stir',
    category: 'binding',
    params: [],
    maxChildren: Infinity  // bag — drop lambdas, tagged values, and bare values in
  },
  enzyme: {
    label: 'Enzyme',
    category: 'binding',
    params: [
      { name: 'tags', type: 'text', default: 'x' }    // space-separated tag names to bind from stir
    ],
    maxChildren: 1   // body — may use (var "tagname") to reference matched values
  },
  tag: {
    label: 'Tag',
    category: 'binding',
    params: [
      { name: 'name', type: 'text', default: 'x' }    // single tag name
    ],
    maxChildren: 1   // the value being tagged (use Scalar for numbers)
  },
  fractal: {
    label: 'Fractal',
    category: 'binding',
    params: [
      { name: 'count', type: 'number', default: 3, min: 1, max: 8 }
    ],
    maxChildren: 2   // child 0 = seed, child 1 = self_step as (enzyme "recur" (enzyme "input" body))
  },
  scalar: {
    label: 'Scalar',
    category: 'binding',
    params: [
      { name: 'value', type: 'number', default: 0, min: -1000, max: 1000 }
    ],
    maxChildren: 0   // leaf — produces a bare number
  },
};

// ---- State ----

let rootBlocks = [];
const allBlocks = new Map();
const subscribers = [];
let nextId = 1;

function notify() {
  for (const fn of subscribers) fn();
}

export function subscribe(fn) {
  subscribers.push(fn);
}

export function getRootBlocks() {
  return rootBlocks;
}

export function getBlock(id) {
  return allBlocks.get(id);
}

function createBlock(type) {
  const def = BLOCK_DEFS[type];
  const params = {};
  for (const p of def.params) {
    params[p.name] = p.default;
  }
  const block = {
    id: 'block_' + (nextId++),
    type,
    params,
    exprSlots: {},  // paramName → child block (for number params with dropped blocks)
    children: [],
    parent: null
  };
  allBlocks.set(block.id, block);
  return block;
}

function removeBlockFromParent(block) {
  if (block.parent) {
    const parent = allBlocks.get(block.parent);
    if (parent) {
      parent.children = parent.children.filter(c => c.id !== block.id);
      // Also check exprSlots
      for (const [key, child] of Object.entries(parent.exprSlots)) {
        if (child && child.id === block.id) {
          delete parent.exprSlots[key];
        }
      }
    }
    block.parent = null;
  } else {
    rootBlocks = rootBlocks.filter(b => b.id !== block.id);
  }
}

function removeBlockRecursive(block) {
  for (const child of block.children) {
    removeBlockRecursive(child);
  }
  for (const child of Object.values(block.exprSlots)) {
    if (child) removeBlockRecursive(child);
  }
  allBlocks.delete(block.id);
}

export function addBlockToRoot(type, index) {
  const block = createBlock(type);
  if (index != null && index >= 0 && index <= rootBlocks.length) {
    rootBlocks.splice(index, 0, block);
  } else {
    rootBlocks.push(block);
  }
  notify();
  return block;
}

export function addBlockAsChild(type, parentId, index) {
  const parent = allBlocks.get(parentId);
  const def = BLOCK_DEFS[parent.type];
  if (parent.children.length >= def.maxChildren) return null;
  const block = createBlock(type);
  block.parent = parentId;
  if (index != null && index >= 0 && index <= parent.children.length) {
    parent.children.splice(index, 0, block);
  } else {
    parent.children.push(block);
  }
  notify();
  return block;
}

export function deleteBlock(blockId) {
  const block = allBlocks.get(blockId);
  if (!block) return;
  removeBlockFromParent(block);
  removeBlockRecursive(block);
  notify();
}

export function updateParam(blockId, paramName, value) {
  const block = allBlocks.get(blockId);
  if (!block) return;
  block.params[paramName] = value;
  notify();
}

// Set a block into an expression-capable param slot.
// If the slot already has a block, remove it first.
export function setExprSlot(parentId, paramName, blockType) {
  const parent = allBlocks.get(parentId);
  if (!parent) return null;
  // Remove existing block in this slot
  const existing = parent.exprSlots[paramName];
  if (existing) {
    existing.parent = null;
    removeBlockRecursive(existing);
  }
  const block = createBlock(blockType);
  block.parent = parentId;
  parent.exprSlots[paramName] = block;
  notify();
  return block;
}

// Move an existing block into an expression-capable param slot.
export function moveToExprSlot(blockId, parentId, paramName) {
  const block = allBlocks.get(blockId);
  const parent = allBlocks.get(parentId);
  if (!block || !parent) return;
  // Prevent dropping into own subtree
  let ancestor = parent;
  while (ancestor) {
    if (ancestor.id === blockId) return;
    ancestor = ancestor.parent ? allBlocks.get(ancestor.parent) : null;
  }
  // Remove existing block in this slot
  const existing = parent.exprSlots[paramName];
  if (existing && existing.id !== blockId) {
    existing.parent = null;
    removeBlockRecursive(existing);
  }
  removeBlockFromParent(block);
  block.parent = parentId;
  parent.exprSlots[paramName] = block;
  notify();
}

// Clear a block from an expression param slot (restores to literal).
export function clearExprSlot(parentId, paramName) {
  const parent = allBlocks.get(parentId);
  if (!parent) return;
  const existing = parent.exprSlots[paramName];
  if (existing) {
    existing.parent = null;
    removeBlockRecursive(existing);
    delete parent.exprSlots[paramName];
    notify();
  }
}

// Replace entire block state from a parsed AST (used by code editor round-trip).
// Does NOT notify subscribers to avoid circular updates.
export function replaceFromAST(ast) {
  // Clear existing state
  allBlocks.clear();
  rootBlocks = [];

  if (!ast) return;

  function buildBlock(node, parentId) {
    const type = node[0];
    const def = BLOCK_DEFS[type];
    if (!def) return null;

    const block = {
      id: 'block_' + (nextId++),
      type,
      params: {},
      exprSlots: {},
      children: [],
      parent: parentId
    };

    // Fill params with defaults first
    for (const p of def.params) {
      block.params[p.name] = p.default;
    }

    // Override from AST — copy matching param values from node[1] if present
    if (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) {
      const p = node[1];
      for (const param of def.params) {
        if (p[param.name] != null) {
          // If the param value is an AST array (expression), build it as an expr-slot block
          if (Array.isArray(p[param.name]) && param.type === 'number') {
            const exprChild = buildBlock(p[param.name], block.id);
            if (exprChild) {
              block.exprSlots[param.name] = exprChild;
            }
          } else {
            block.params[param.name] = p[param.name];
          }
        }
      }
    }

    allBlocks.set(block.id, block);

    // Build children — parameterless containers have children starting at index 1
    const noParamTypes = ['union', 'intersect', 'anti', 'complement', 'stir'];
    const childNodes = noParamTypes.includes(type) ? node.slice(1) : node.slice(2);
    for (const childNode of childNodes) {
      if (Array.isArray(childNode)) {
        const child = buildBlock(childNode, block.id);
        if (child) block.children.push(child);
      }
    }

    return block;
  }

  // Only implicit union is flattened into root blocks
  if (ast[0] === 'union') {
    for (const child of ast.slice(1)) {
      if (Array.isArray(child)) {
        const block = buildBlock(child, null);
        if (block) rootBlocks.push(block);
      }
    }
  } else {
    const block = buildBlock(ast, null);
    if (block) rootBlocks.push(block);
  }
}

// Wrap an existing block with a new block created from the palette.
// The new wrapper replaces the target in its parent, and the target becomes the wrapper's first child.
export function wrapBlockWithNew(targetId, wrapperType) {
  const target = allBlocks.get(targetId);
  if (!target) return null;
  const wrapperDef = BLOCK_DEFS[wrapperType];
  if (!wrapperDef || wrapperDef.maxChildren === 0) return null;

  const wrapper = createBlock(wrapperType);

  // Replace target in its parent (or root list) with the wrapper
  if (target.parent) {
    const parent = allBlocks.get(target.parent);
    const idx = parent.children.indexOf(target);
    if (idx >= 0) {
      parent.children[idx] = wrapper;
      wrapper.parent = target.parent;
    }
  } else {
    const idx = rootBlocks.indexOf(target);
    if (idx >= 0) {
      rootBlocks[idx] = wrapper;
    }
  }

  // Make target the wrapper's first child
  target.parent = wrapper.id;
  wrapper.children.push(target);

  notify();
  return wrapper;
}

// Wrap an existing block with another existing block (workspace drag).
// The wrapper is removed from its current position, replaces the target, and the target becomes its child.
export function wrapBlockWithExisting(targetId, wrapperId) {
  const target = allBlocks.get(targetId);
  const wrapper = allBlocks.get(wrapperId);
  if (!target || !wrapper || target.id === wrapper.id) return;
  const wrapperDef = BLOCK_DEFS[wrapper.type];
  if (!wrapperDef || wrapperDef.maxChildren === 0) return;

  // Prevent wrapping an ancestor with its descendant (would create cycle)
  let ancestor = target;
  while (ancestor) {
    if (ancestor.id === wrapperId) return;
    ancestor = ancestor.parent ? allBlocks.get(ancestor.parent) : null;
  }

  // Remove wrapper from its current position
  removeBlockFromParent(wrapper);

  // Replace target in its parent (or root list) with the wrapper
  if (target.parent) {
    const parent = allBlocks.get(target.parent);
    const idx = parent.children.indexOf(target);
    if (idx >= 0) {
      parent.children[idx] = wrapper;
      wrapper.parent = target.parent;
    }
  } else {
    const idx = rootBlocks.indexOf(target);
    if (idx >= 0) {
      rootBlocks[idx] = wrapper;
      wrapper.parent = null;
    }
  }

  // Make target the wrapper's first child (appended after any existing children)
  target.parent = wrapper.id;
  wrapper.children.push(target);

  notify();
}

export function moveBlock(blockId, newParentId, index) {
  const block = allBlocks.get(blockId);
  if (!block) return;
  if (newParentId) {
    const newParent = allBlocks.get(newParentId);
    const def = BLOCK_DEFS[newParent.type];
    if (newParent.children.length >= def.maxChildren) return;
    // Prevent dropping a block into its own subtree
    let ancestor = newParent;
    while (ancestor) {
      if (ancestor.id === blockId) return;
      ancestor = ancestor.parent ? allBlocks.get(ancestor.parent) : null;
    }
    removeBlockFromParent(block);
    block.parent = newParentId;
    if (index != null && index >= 0 && index <= newParent.children.length) {
      newParent.children.splice(index, 0, block);
    } else {
      newParent.children.push(block);
    }
  } else {
    removeBlockFromParent(block);
    if (index != null && index >= 0 && index <= rootBlocks.length) {
      rootBlocks.splice(index, 0, block);
    } else {
      rootBlocks.push(block);
    }
  }
  notify();
}

// ---- Category definitions ----

// Each category's "representative" is the block shown in the bottom selector row.
// It doubles as a draggable block AND a tap target to expand that category.
// The representative updates to the most recently used block from that category.
const CATEGORY_IDS = ['primitive', 'transform', 'appearance', 'combine', 'binding'];
const categoryRepresentative = {
  primitive: 'cube',
  transform: 'translate',
  appearance: 'paint',
  combine: 'union',
  binding: 'let',
};

// ---- Palette rendering ----

let paletteEl, workspaceEl;
let activeCategory = CATEGORY_IDS[0];

export function initPalette(el) {
  paletteEl = el;

  // Wire up drag/drop with block operations
  initDragDrop({
    getBlock,
    getBlockDef: (type) => BLOCK_DEFS[type],
    getBlockLabel: (type) => BLOCK_DEFS[type].label,
    addBlockToRoot,
    addBlockAsChild,
    moveBlock,
    wrapBlockWithNew,
    wrapBlockWithExisting,
    setExprSlot,
    moveToExprSlot,
    markBlockUsed,
    renderWorkspace,
  });

  // Top row: all blocks in the active category (expanded view)
  const itemsRow = document.createElement('div');
  itemsRow.id = 'palette-items';
  paletteEl.appendChild(itemsRow);

  // Bottom row: one draggable representative block per category
  const selectorRow = document.createElement('div');
  selectorRow.id = 'palette-selector';
  paletteEl.appendChild(selectorRow);

  renderSelectorRow();
  renderPaletteItems();
}

// Selector row items: drag → create block, tap → switch category
function onSelectorPointerDown(e) {
  const catId = e.currentTarget.dataset.categoryId;
  const startX = e.clientX;
  const startY = e.clientY;
  const target = e.currentTarget;

  // Track whether this becomes a drag or stays a tap
  let moved = false;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD) {
      moved = true;
      // Hand off to the normal palette drag system
      cleanup();
      // Synthesize a palette drag from this element
      dragState = {
        source: 'palette',
        blockType: target.dataset.blockType,
        startX,
        startY,
        ghost: null,
        dragging: false,
        pointerId: e.pointerId
      };
      document.addEventListener('pointermove', onDragMove);
      document.addEventListener('pointerup', onDragEnd);
      document.addEventListener('pointercancel', onDragCancel);
      // Trigger the first move to create the ghost
      onDragMove(ev);
    }
  }

  function onUp() {
    cleanup();
    if (!moved) {
      // It was a tap — switch category
      activeCategory = catId;
      renderPaletteItems();
      renderSelectorRow();
    }
  }

  function cleanup() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', cleanup);
  }

  e.preventDefault();
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', cleanup);
}

function renderSelectorRow() {
  const row = document.getElementById('palette-selector');
  if (!row) return;
  row.innerHTML = '';
  for (const catId of CATEGORY_IDS) {
    const repType = categoryRepresentative[catId];
    const rep = BLOCK_DEFS[repType];
    const item = document.createElement('div');
    item.className = `palette-item palette-item--${repType}`;
    if (catId === activeCategory) item.classList.add('palette-item--selected');
    item.textContent = rep.label;
    item.dataset.blockType = repType;
    item.dataset.categoryId = catId;
    item.addEventListener('pointerdown', onSelectorPointerDown);
    row.appendChild(item);
  }
}

// Update the representative for a category to the most recently used block type.
function markBlockUsed(blockType) {
  const def = BLOCK_DEFS[blockType];
  if (!def) return;
  const catId = def.category;
  if (categoryRepresentative[catId] === blockType) return; // already the rep
  categoryRepresentative[catId] = blockType;
  renderSelectorRow();
}

function renderPaletteItems() {
  const itemsRow = document.getElementById('palette-items');
  itemsRow.innerHTML = '';
  for (const [type, def] of Object.entries(BLOCK_DEFS)) {
    if (def.category !== activeCategory) continue;
    const item = document.createElement('div');
    item.className = `palette-item palette-item--${type}`;
    item.textContent = def.label;
    item.dataset.blockType = type;
    item.addEventListener('pointerdown', onPaletteDragStart);
    itemsRow.appendChild(item);
  }
}

// ---- Workspace rendering ----

export function initWorkspace(el) {
  workspaceEl = el;
  // Delegate param input events
  workspaceEl.addEventListener('input', onParamInput);
  workspaceEl.addEventListener('change', onParamChange);
  workspaceEl.addEventListener('click', onWorkspaceClick);
}

export function renderWorkspace() {
  if (!workspaceEl) return;
  workspaceEl.innerHTML = '';
  for (let i = 0; i < rootBlocks.length; i++) {
    const gap = document.createElement('div');
    gap.className = 'drop-zone drop-zone--gap';
    gap.dataset.dropTarget = 'root:' + i;
    workspaceEl.appendChild(gap);
    workspaceEl.appendChild(renderBlock(rootBlocks[i]));
  }
  // Trailing root drop zone
  const rootDrop = document.createElement('div');
  rootDrop.className = 'drop-zone';
  rootDrop.dataset.dropTarget = 'root:' + rootBlocks.length;
  rootDrop.textContent = rootBlocks.length === 0 ? 'Drag blocks here' : '+';
  workspaceEl.appendChild(rootDrop);
}

let highlightTimer = null;
export function highlightBlock(blockId) {
  // Clear any existing highlight
  if (workspaceEl) {
    for (const el of workspaceEl.querySelectorAll('.block--highlight')) {
      el.classList.remove('block--highlight');
    }
  }
  if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
  if (!blockId || !workspaceEl) return;
  const el = workspaceEl.querySelector(`.block[data-block-id="${blockId}"]`);
  if (!el) return;
  el.classList.add('block--highlight');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  highlightTimer = setTimeout(() => {
    el.classList.remove('block--highlight');
    highlightTimer = null;
  }, 2000);
}

function createParamInput(p, block) {
  const lbl = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = p.name;
  lbl.appendChild(span);

  if (p.type === 'number') {
    // Check if there's a block in the expr slot for this param
    const exprBlock = block.exprSlots[p.name];
    if (exprBlock) {
      // Render the expression block inline instead of a number input
      const exprEl = renderBlock(exprBlock);
      exprEl.classList.add('expr-slot__block');
      lbl.appendChild(exprEl);
    } else {
      // Literal number input — also a drop target for blocks
      const wrapper = document.createElement('span');
      wrapper.className = 'expr-slot';
      wrapper.dataset.exprTarget = block.id + ':' + p.name;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = block.params[p.name];
      input.min = p.min;
      input.max = p.max;
      input.dataset.blockId = block.id;
      input.dataset.paramName = p.name;
      wrapper.appendChild(input);
      lbl.appendChild(wrapper);
    }
  } else if (p.type === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = block.params[p.name];
    input.dataset.blockId = block.id;
    input.dataset.paramName = p.name;
    input.placeholder = p.name;
    lbl.appendChild(input);
  } else if (p.type === 'color') {
    const select = document.createElement('select');
    select.dataset.blockId = block.id;
    select.dataset.paramName = p.name;
    for (const opt of p.options) {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      if (opt === block.params[p.name]) option.selected = true;
      select.appendChild(option);
    }
    lbl.appendChild(select);
  }
  return lbl;
}

function renderBlock(block) {
  const def = BLOCK_DEFS[block.type];
  const el = document.createElement('div');
  el.className = `block block--${block.type}`;
  el.dataset.blockId = block.id;

  // Inline single scalar param into header to save vertical space.
  // Revisit when params can accept reporter blocks — a nested block
  // won't fit inline and the slot will need to expand to a full row.
  const inlineParam = def.params.length === 1;

  // Header
  const header = document.createElement('div');
  header.className = 'block__header';
  header.addEventListener('pointerdown', onBlockDragStart);

  const label = document.createElement('span');
  label.className = 'block__label';
  label.textContent = def.label;
  header.appendChild(label);

  // Inline single param into header
  if (inlineParam) {
    const p = def.params[0];
    const inlineEl = createParamInput(p, block);
    inlineEl.classList.add('block__inline-param');
    header.appendChild(inlineEl);
  }

  const del = document.createElement('button');
  del.className = 'block__delete';
  del.textContent = '\u00d7';
  del.dataset.deleteId = block.id;
  header.appendChild(del);

  el.appendChild(header);

  // Params (skip if already inlined)
  if (def.params.length > 0 && !inlineParam) {
    const paramsEl = document.createElement('div');
    paramsEl.className = 'block__params';
    for (const p of def.params) {
      paramsEl.appendChild(createParamInput(p, block));
    }
    el.appendChild(paramsEl);
  }

  // Children area
  if (def.maxChildren > 0) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'block__children';
    const isBag = def.maxChildren === Infinity;
    const isLabeledSlots = block.type === 'let' || block.type === 'grow';

    if (isLabeledSlots) {
      // Two labeled slots: value/seed + body
      const slotLabels = block.type === 'let'
        ? ['value', 'body']
        : ['seed', 'body'];

      for (let i = 0; i < def.maxChildren; i++) {
        const slotLabel = document.createElement('div');
        slotLabel.className = 'block__slot-label';
        slotLabel.textContent = slotLabels[i] + ':';
        childrenEl.appendChild(slotLabel);

        if (block.children[i]) {
          childrenEl.appendChild(renderBlock(block.children[i]));
        } else {
          const dropZone = document.createElement('div');
          dropZone.className = 'drop-zone';
          dropZone.dataset.dropTarget = block.id + ':' + i;
          dropZone.textContent = 'Drop ' + slotLabels[i] + ' here';
          childrenEl.appendChild(dropZone);
        }
      }
    } else if (isBag) {
      // Bag container: inter-child drop zones for reordering
      for (let i = 0; i < block.children.length; i++) {
        const gap = document.createElement('div');
        gap.className = 'drop-zone drop-zone--gap';
        gap.dataset.dropTarget = block.id + ':' + i;
        childrenEl.appendChild(gap);
        childrenEl.appendChild(renderBlock(block.children[i]));
      }
      // Trailing drop zone (always visible)
      const trailing = document.createElement('div');
      trailing.className = 'drop-zone';
      trailing.dataset.dropTarget = block.id + ':' + block.children.length;
      trailing.textContent = block.children.length === 0 ? 'Drop here' : '+';
      childrenEl.appendChild(trailing);
    } else {
      // Fixed-arity container (translate, paint, anti, etc.)
      for (const child of block.children) {
        childrenEl.appendChild(renderBlock(child));
      }
      const remaining = def.maxChildren - block.children.length;
      if (remaining > 0) {
        const dropZone = document.createElement('div');
        dropZone.className = 'drop-zone';
        dropZone.dataset.dropTarget = block.id;
        dropZone.textContent = 'Drop here';
        childrenEl.appendChild(dropZone);
      }
    }
    el.appendChild(childrenEl);
  }

  return el;
}

// ---- Event handlers ----

function onParamInput(e) {
  const target = e.target;
  if (target.tagName === 'INPUT' && target.dataset.blockId) {
    if (target.type === 'text') {
      updateParam(target.dataset.blockId, target.dataset.paramName, target.value);
    } else {
      const val = parseFloat(target.value);
      if (!isNaN(val)) {
        updateParam(target.dataset.blockId, target.dataset.paramName, val);
      }
    }
  }
}

function onParamChange(e) {
  const target = e.target;
  if (target.tagName === 'SELECT' && target.dataset.blockId) {
    updateParam(target.dataset.blockId, target.dataset.paramName, target.value);
  }
}

function onWorkspaceClick(e) {
  const delBtn = e.target.closest('.block__delete');
  if (delBtn && delBtn.dataset.deleteId) {
    e.stopPropagation();
    deleteBlock(delBtn.dataset.deleteId);
    renderWorkspace();
  }
}

// Drag and drop system extracted to ./ui/drag-drop.js
