// ---- Block type definitions ----

export const BLOCK_DEFS = {
  cube: {
    label: 'Cube',
    category: 'primitive',
    params: [
      { name: 'size', type: 'number', default: 20, min: 1, max: 200 },
      { name: 'color', type: 'color', default: 'green', options: ['red', 'blue', 'green'] }
    ],
    maxChildren: 0
  },
  sphere: {
    label: 'Sphere',
    category: 'primitive',
    params: [
      { name: 'radius', type: 'number', default: 15, min: 1, max: 200 },
      { name: 'color', type: 'color', default: 'red', options: ['red', 'blue', 'green'] }
    ],
    maxChildren: 0
  },
  cylinder: {
    label: 'Cylinder',
    category: 'primitive',
    params: [
      { name: 'radius', type: 'number', default: 10, min: 1, max: 200 },
      { name: 'height', type: 'number', default: 30, min: 1, max: 200 },
      { name: 'color', type: 'color', default: 'blue', options: ['red', 'blue', 'green'] }
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
  union: {
    label: 'Union',
    category: 'combine',
    params: [],
    maxChildren: Infinity
  }
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

export function addBlockAsChild(type, parentId) {
  const parent = allBlocks.get(parentId);
  const def = BLOCK_DEFS[parent.type];
  if (parent.children.length >= def.maxChildren) return null;
  const block = createBlock(type);
  block.parent = parentId;
  parent.children.push(block);
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

export function moveBlock(blockId, newParentId) {
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
    newParent.children.push(block);
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

function renderBlock(block) {
  const def = BLOCK_DEFS[block.type];
  const el = document.createElement('div');
  el.className = `block block--${block.type}`;
  el.dataset.blockId = block.id;

  // Header
  const header = document.createElement('div');
  header.className = 'block__header';
  header.addEventListener('pointerdown', onBlockDragStart);

  const label = document.createElement('span');
  label.className = 'block__label';
  label.textContent = def.label;
  header.appendChild(label);

  const del = document.createElement('button');
  del.className = 'block__delete';
  del.textContent = '\u00d7';
  del.dataset.deleteId = block.id;
  header.appendChild(del);

  el.appendChild(header);

  // Params
  if (def.params.length > 0) {
    const paramsEl = document.createElement('div');
    paramsEl.className = 'block__params';
    for (const p of def.params) {
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
      paramsEl.appendChild(lbl);
    }
    el.appendChild(paramsEl);
  }

  // Children area
  if (def.maxChildren > 0) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'block__children';
    for (const child of block.children) {
      childrenEl.appendChild(renderBlock(child));
    }
    // Show drop zone if there's remaining capacity
    const remaining = def.maxChildren - block.children.length;
    if (remaining > 0) {
      const dropZone = document.createElement('div');
      dropZone.className = 'drop-zone';
      dropZone.dataset.dropTarget = block.id;
      dropZone.textContent = 'Drop here';
      childrenEl.appendChild(dropZone);
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

  // Find drop target
  const target = findDropTarget(e.clientX, e.clientY);

  if (dragState.source === 'palette') {
    if (target === 'root') {
      addBlockToRoot(dragState.blockType);
    } else if (target) {
      addBlockAsChild(dragState.blockType, target);
    }
  } else if (dragState.source === 'workspace') {
    if (target === 'root') {
      moveBlock(dragState.blockId, null);
    } else if (target && target !== dragState.blockId) {
      moveBlock(dragState.blockId, target);
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
