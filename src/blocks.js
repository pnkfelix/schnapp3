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
  allBlocks.delete(block.id);
}

export function addBlockToRoot(type) {
  const block = createBlock(type);
  rootBlocks.push(block);
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
        if (p[param.name] != null) block.params[param.name] = p[param.name];
      }
    }

    allBlocks.set(block.id, block);

    // Build children — union/intersect/anti/complement have no params object, others do
    const noParamTypes = ['union', 'intersect', 'anti', 'complement'];
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
    rootBlocks.push(block);
  }
  notify();
}

// ---- Palette rendering ----

let paletteEl, workspaceEl;

export function initPalette(el) {
  paletteEl = el;
  for (const [type, def] of Object.entries(BLOCK_DEFS)) {
    const item = document.createElement('div');
    item.className = `palette-item palette-item--${type}`;
    item.textContent = def.label;
    item.dataset.blockType = type;
    item.addEventListener('pointerdown', onPaletteDragStart);
    paletteEl.appendChild(item);
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
  for (const block of rootBlocks) {
    workspaceEl.appendChild(renderBlock(block));
  }
  // Root drop zone
  const rootDrop = document.createElement('div');
  rootDrop.className = 'drop-zone';
  rootDrop.dataset.dropTarget = 'root';
  rootDrop.textContent = rootBlocks.length === 0 ? 'Drag blocks here' : '+';
  workspaceEl.appendChild(rootDrop);
}

function createParamInput(p, block) {
  const lbl = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = p.name;
  lbl.appendChild(span);

  if (p.type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = block.params[p.name];
    input.min = p.min;
    input.max = p.max;
    input.dataset.blockId = block.id;
    input.dataset.paramName = p.name;
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

    if (isBag) {
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
    const val = parseFloat(target.value);
    if (!isNaN(val)) {
      updateParam(target.dataset.blockId, target.dataset.paramName, val);
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

// ---- Drag and drop ----

const DRAG_THRESHOLD = 8;
let dragState = null;

function onPaletteDragStart(e) {
  e.preventDefault();
  const type = e.currentTarget.dataset.blockType;
  dragState = {
    source: 'palette',
    blockType: type,
    startX: e.clientX,
    startY: e.clientY,
    ghost: null,
    dragging: false,
    pointerId: e.pointerId
  };
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
}

function onBlockDragStart(e) {
  // Don't drag if interacting with inputs
  if (e.target.closest('input, select, button')) return;
  e.preventDefault();
  const blockEl = e.currentTarget.closest('.block');
  const blockId = blockEl.dataset.blockId;
  dragState = {
    source: 'workspace',
    blockId,
    blockType: getBlock(blockId).type,
    startX: e.clientX,
    startY: e.clientY,
    ghost: null,
    dragging: false,
    pointerId: e.pointerId
  };
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
}

function onDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if (!dragState.dragging) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragState.dragging = true;
    // Create ghost
    const ghost = document.createElement('div');
    ghost.className = `drag-ghost palette-item--${dragState.blockType}`;
    ghost.textContent = BLOCK_DEFS[dragState.blockType].label;
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
  }

  dragState.ghost.style.left = e.clientX - 30 + 'px';
  dragState.ghost.style.top = e.clientY - 20 + 'px';

  // Highlight drop targets
  highlightDropTargets(e.clientX, e.clientY);
}

function onDragEnd(e) {
  if (!dragState) return;
  cleanupDragListeners();

  if (!dragState.dragging) {
    dragState = null;
    return;
  }

  // Find drop target — may be "root", "blockId", or "blockId:index"
  const raw = findDropTarget(e.clientX, e.clientY);
  let target = raw;
  let insertIndex;
  if (raw && raw !== 'root' && raw.includes(':')) {
    const parts = raw.split(':');
    target = parts[0];
    insertIndex = parseInt(parts[1], 10);
  }

  if (dragState.source === 'palette') {
    if (target === 'root') {
      addBlockToRoot(dragState.blockType);
    } else if (target) {
      addBlockAsChild(dragState.blockType, target, insertIndex);
    }
  } else if (dragState.source === 'workspace') {
    if (target === 'root') {
      moveBlock(dragState.blockId, null);
    } else if (target && target !== dragState.blockId) {
      moveBlock(dragState.blockId, target, insertIndex);
    }
  }

  cleanupGhost();
  clearDropHighlights();
  renderWorkspace();
  dragState = null;
}

function onDragCancel() {
  cleanupDragListeners();
  cleanupGhost();
  clearDropHighlights();
  dragState = null;
}

function cleanupDragListeners() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
}

function cleanupGhost() {
  if (dragState && dragState.ghost) {
    dragState.ghost.remove();
  }
}

function highlightDropTargets(x, y) {
  clearDropHighlights();
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList.contains('drop-zone')) {
      el.classList.add('drop-zone--active');
      break;
    }
  }
}

function clearDropHighlights() {
  for (const el of document.querySelectorAll('.drop-zone--active')) {
    el.classList.remove('drop-zone--active');
  }
}

function findDropTarget(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList.contains('drop-zone') && el.dataset.dropTarget) {
      return el.dataset.dropTarget;
    }
  }
  return null;
}
