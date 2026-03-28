// Drag and drop system for block editor.
// Handles palette drags (creating new blocks) and workspace drags (moving blocks).

const DRAG_THRESHOLD = 8;
let dragState = null;

// Block operations — set via initDragDrop()
let ops = null;

export function initDragDrop(blockOps) {
  ops = blockOps;
}

export function onPaletteDragStart(e) {
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

export function onBlockDragStart(e) {
  // Don't drag if interacting with inputs
  if (e.target.closest('input, select, button')) return;
  e.preventDefault();
  const blockEl = e.currentTarget.closest('.block');
  const blockId = blockEl.dataset.blockId;
  dragState = {
    source: 'workspace',
    blockId,
    blockType: ops.getBlock(blockId).type,
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
    ghost.textContent = ops.getBlockLabel(dragState.blockType);
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

  // Find drop target — may be "root", "root:index", "blockId", "blockId:index",
  // or "expr:blockId:paramName" for expression param slots
  const raw = findDropTarget(e.clientX, e.clientY);

  // Handle expression-param slot drops
  if (raw && raw.startsWith('expr:')) {
    const rest = raw.slice(5); // strip "expr:"
    const colonIdx = rest.indexOf(':');
    const parentId = rest.slice(0, colonIdx);
    const paramName = rest.slice(colonIdx + 1);
    if (dragState.source === 'palette') {
      ops.setExprSlot(parentId, paramName, dragState.blockType);
    } else if (dragState.source === 'workspace') {
      ops.moveToExprSlot(dragState.blockId, parentId, paramName);
    }
  } else {
    let target = raw;
    let insertIndex;
    if (raw && raw.includes(':')) {
      const parts = raw.split(':');
      target = parts[0];
      insertIndex = parseInt(parts[1], 10);
    }

    if (dragState.source === 'palette') {
      if (target === 'root') {
        ops.addBlockToRoot(dragState.blockType, insertIndex);
      } else if (target) {
        ops.addBlockAsChild(dragState.blockType, target, insertIndex);
      }
    } else if (dragState.source === 'workspace') {
      if (target === 'root') {
        ops.moveBlock(dragState.blockId, null, insertIndex);
      } else if (target && target !== dragState.blockId) {
        ops.moveBlock(dragState.blockId, target, insertIndex);
      }
    }
  }

  // Update MRU representative for palette drags that landed on a valid target
  if (dragState.source === 'palette' && raw) {
    ops.markBlockUsed(dragState.blockType);
  }

  cleanupGhost();
  clearDropHighlights();
  ops.renderWorkspace();
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

export function highlightDropTargets(x, y) {
  clearDropHighlights();
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList.contains('drop-zone')) {
      el.classList.add('drop-zone--active');
      break;
    }
    if (el.classList.contains('expr-slot')) {
      el.classList.add('expr-slot--active');
      break;
    }
  }
}

export function clearDropHighlights() {
  for (const el of document.querySelectorAll('.drop-zone--active')) {
    el.classList.remove('drop-zone--active');
  }
  for (const el of document.querySelectorAll('.expr-slot--active')) {
    el.classList.remove('expr-slot--active');
  }
}

export function findDropTarget(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList.contains('drop-zone') && el.dataset.dropTarget) {
      return el.dataset.dropTarget;
    }
    // Expression-capable param slots: "expr:blockId:paramName"
    if (el.classList.contains('expr-slot') && el.dataset.exprTarget) {
      return 'expr:' + el.dataset.exprTarget;
    }
  }
  return null;
}
