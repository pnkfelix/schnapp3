// Shared AST utility functions and constants used across evaluator modules.

// Extract child AST nodes from a node, skipping the params object if present.
// Bare containers (union, intersect, anti, complement) may or may not have a
// params object at node[1] — tagged ones do, plain ones don't.
export function nodeChildren(node) {
  if (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) {
    return node.slice(2);
  }
  return node.slice(1);
}

export const COLOR_MAP = {
  unset:  0xaaaaaa,
  gray:   0xaaaaaa,
  red:    0xff4444,
  blue:   0x4488ff,
  green:  0x44cc44,
  yellow: 0xffcc00,
  orange: 0xff8800
};

export const DEFAULT_COLOR = 'gray';
export const UNSET_COLOR = 'unset';

export function hexToRgb(hex) {
  return [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255];
}

export const DEFAULT_RGB = hexToRgb(COLOR_MAP[DEFAULT_COLOR]);
// Unset renders as gray but yields to any explicit color in CSG operations
export const UNSET_RGB = DEFAULT_RGB;

export const EMPTY = { polarity: 0, distance: 1e10, color: UNSET_COLOR };
