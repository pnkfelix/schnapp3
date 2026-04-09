// Bounding box estimation from AST nodes.
// Pure geometric calculations — no Three.js dependency.

import { nodeChildren } from './ast-utils.js';

// L2 rotation radius: the farthest corner distance in the rotation plane.
// Uses sqrt(max(|lo|,|hi|)² on axis0 + max(|lo|,|hi|)² on axis1)
// instead of the L∞ max which over-estimates for non-square cross-sections.
function rotationRadius(bounds, a0, a1) {
  const ext0 = Math.max(Math.abs(bounds.min[a0]), Math.abs(bounds.max[a0]));
  const ext1 = Math.max(Math.abs(bounds.min[a1]), Math.abs(bounds.max[a1]));
  return Math.sqrt(ext0 * ext0 + ext1 * ext1);
}

export function estimateBounds(node, offset = [0, 0, 0]) {
  const type = node[0];
  const pad = 5;

  switch (type) {
    case 'sphere': {
      const r = (node[1].radius || 15) + pad;
      return {
        min: [offset[0] - r, offset[1] - r, offset[2] - r],
        max: [offset[0] + r, offset[1] + r, offset[2] + r]
      };
    }
    case 'cube': {
      const h = (node[1].size || 20) / 2 + pad;
      return {
        min: [offset[0] - h, offset[1] - h, offset[2] - h],
        max: [offset[0] + h, offset[1] + h, offset[2] + h]
      };
    }
    case 'cylinder': {
      const r = (node[1].radius || 10) + pad;
      const h = (node[1].height || 30) / 2 + pad;
      return {
        min: [offset[0] - r, offset[1] - h, offset[2] - r],
        max: [offset[0] + r, offset[1] + h, offset[2] + r]
      };
    }
    case 'text': {
      const content = node[1].content || 'Text';
      const fontSize = node[1].size || 20;
      const depth = node[1].depth || 4;
      const hw = fontSize * content.length * 0.3 + pad;
      const hh = fontSize * 0.5 + pad;
      const hd = depth / 2 + pad;
      return {
        min: [offset[0] - hw, offset[1] - hh, offset[2] - hd],
        max: [offset[0] + hw, offset[1] + hh, offset[2] + hd]
      };
    }
    case 'translate': {
      const p = node[1];
      const newOff = [offset[0] + (p.x||0), offset[1] + (p.y||0), offset[2] + (p.z||0)];
      const children = node.slice(2);
      return mergeBounds(children.map(c => estimateBounds(c, newOff)));
    }
    case 'paint':
    case 'recolor': {
      const children = node.slice(2);
      return mergeBounds(children.map(c => estimateBounds(c, offset)));
    }
    case 'anti':
    case 'complement': {
      return mergeBounds(nodeChildren(node).map(c => estimateBounds(c, offset)));
    }
    case 'mirror': {
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'x';
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const extent = Math.max(Math.abs(childBounds.min[ai]), Math.abs(childBounds.max[ai]));
      childBounds.min[ai] = offset[ai] - extent;
      childBounds.max[ai] = offset[ai] + extent;
      return childBounds;
    }
    case 'rotate': {
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = rotationRadius(childBounds, a0, a1);
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'twist': {
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = rotationRadius(childBounds, a0, a1);
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'radial': {
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = rotationRadius(childBounds, a0, a1);
      childBounds.min[a0] = offset[a0] - r;
      childBounds.max[a0] = offset[a0] + r;
      childBounds.min[a1] = offset[a1] - r;
      childBounds.max[a1] = offset[a1] + r;
      return childBounds;
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const scales = [sx, sy, sz];
      for (let i = 0; i < 3; i++) {
        const cen = offset[i];
        childBounds.min[i] = cen + (childBounds.min[i] - cen) * scales[i];
        childBounds.max[i] = cen + (childBounds.max[i] - cen) * scales[i];
        if (childBounds.min[i] > childBounds.max[i]) {
          [childBounds.min[i], childBounds.max[i]] = [childBounds.max[i], childBounds.min[i]];
        }
      }
      return childBounds;
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const spacing = node[1].spacing || 30;
      const extent = spacing * 5;
      childBounds.min[ai] = offset[ai] - extent;
      childBounds.max[ai] = offset[ai] + extent;
      return childBounds;
    }
    case 'bend': {
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const maxExtent = Math.max(
        ...childBounds.max.map((v, i) => Math.abs(v - offset[i])),
        ...childBounds.min.map((v, i) => Math.abs(v - offset[i]))
      );
      for (let i = 0; i < 3; i++) {
        childBounds.min[i] = offset[i] - maxExtent;
        childBounds.max[i] = offset[i] + maxExtent;
      }
      return childBounds;
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      const childBounds = mergeBounds(children.map(c => estimateBounds(c, offset)));
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const maxAlong = Math.max(
        Math.abs(childBounds.min[ai] - offset[ai]),
        Math.abs(childBounds.max[ai] - offset[ai])
      );
      const maxScale = Math.max(1, 1 + Math.abs(rate) * maxAlong);
      for (const a of [a0, a1]) {
        const ext = Math.max(
          Math.abs(childBounds.min[a] - offset[a]),
          Math.abs(childBounds.max[a] - offset[a])
        ) * maxScale;
        childBounds.min[a] = offset[a] - ext;
        childBounds.max[a] = offset[a] + ext;
      }
      return childBounds;
    }
    case 'union':
    case 'intersect':
    case 'fuse': {
      const start = type === 'fuse' ? 2 : 1;
      const children = node.slice(start);
      const merged = mergeBounds(children.map(c => estimateBounds(c, offset)));
      if (type === 'fuse') {
        const k = (node[1].k || 5);
        merged.min = merged.min.map(v => v - k);
        merged.max = merged.max.map(v => v + k);
      }
      return merged;
    }
    default:
      return {
        min: [offset[0] - 20, offset[1] - 20, offset[2] - 20],
        max: [offset[0] + 20, offset[1] + 20, offset[2] + 20]
      };
  }
}

export function mergeBounds(boundsList) {
  if (boundsList.length === 0) {
    return { min: [-20, -20, -20], max: [20, 20, 20] };
  }
  const min = [...boundsList[0].min];
  const max = [...boundsList[0].max];
  for (let i = 1; i < boundsList.length; i++) {
    for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], boundsList[i].min[j]);
      max[j] = Math.max(max[j], boundsList[i].max[j]);
    }
  }
  return { min, max };
}
