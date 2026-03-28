// AST → flat instruction tape for the GPU SDF interpreter.
//
// The tape is a Float32Array of opcodes and operands.
// The GPU shader interprets it as a stack machine:
//   - Primitives push (polarity, distance, color) onto the value stack
//   - Transforms push/pop from the coordinate stack
//   - CSG ops merge the top N value-stack entries
//
// Opcodes are stored as bitcast<u32>(f32) — we use f32 arrays
// throughout since the GPU storage buffer is typed as array<f32>.

import { estimateBounds } from './csg-field.js';

// Must match gpu-sdf.wgsl
const OP_SPHERE           = 1;
const OP_CUBE             = 2;
const OP_CYLINDER         = 3;
const OP_TRANSLATE        = 4;
const OP_UNION            = 5;
const OP_INTERSECT        = 6;
const OP_ANTI             = 7;
const OP_COMPLEMENT       = 8;
const OP_FUSE             = 9;
const OP_PAINT            = 10;
const OP_MIRROR           = 11;
const OP_ROTATE           = 12;
const OP_TWIST            = 13;
const OP_RADIAL           = 14;
const OP_STRETCH          = 15;
const OP_TILE             = 16;
const OP_BEND             = 17;
const OP_TAPER            = 18;
const OP_POP_TRANSFORM    = 19;
const OP_POP_TRANSFORM_SCALE = 20;
const OP_POP_TAPER          = 21;

export {
  OP_SPHERE, OP_CUBE, OP_CYLINDER, OP_TRANSLATE,
  OP_UNION, OP_INTERSECT, OP_ANTI, OP_COMPLEMENT, OP_FUSE,
  OP_PAINT, OP_MIRROR, OP_ROTATE, OP_TWIST, OP_RADIAL,
  OP_STRETCH, OP_TILE, OP_BEND, OP_TAPER,
  OP_POP_TRANSFORM, OP_POP_TRANSFORM_SCALE, OP_POP_TAPER
};

const COLOR_MAP = {
  unset: 0xaaaaaa, gray: 0xaaaaaa, red: 0xff4444, blue: 0x4488ff,
  green: 0x44cc44, yellow: 0xffcc00, orange: 0xff8800
};

function hexToRgb(hex) {
  return [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255];
}

// Helper: push a u32 opcode as f32 bits
function pushOp(tape, op) {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = op;
  tape.push(new Float32Array(buf)[0]);
}

// Helper: push a u32 value as f32 bits
function pushU32(tape, val) {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = val;
  tape.push(new Float32Array(buf)[0]);
}

function axisToU32(axis) {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

function nodeChildren(node) {
  if (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) return node.slice(2);
  return node.slice(1);
}

// Compile an AST node into tape instructions.
// Returns the number of value-stack entries this subtree produces (always 1 for valid nodes).
function compileNode(node, tape) {
  const type = node[0];

  switch (type) {
    case 'sphere': {
      pushOp(tape, OP_SPHERE);
      tape.push(node[1].radius || 15);
      return 1;
    }
    case 'cube': {
      pushOp(tape, OP_CUBE);
      tape.push(node[1].size || 20);
      return 1;
    }
    case 'cylinder': {
      pushOp(tape, OP_CYLINDER);
      tape.push(node[1].radius || 10);
      tape.push(node[1].height || 30);
      return 1;
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) return 0;

      pushOp(tape, OP_TRANSLATE);
      tape.push(p.x || 0);
      tape.push(p.y || 0);
      tape.push(p.z || 0);

      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }

      pushOp(tape, OP_POP_TRANSFORM);

      // If multiple children under translate, union them
      if (count > 1) {
        pushOp(tape, OP_UNION);
        pushU32(tape, count);
      }
      return count > 0 ? 1 : 0;
    }
    case 'paint': {
      const colorName = node[1].color || 'gray';
      const children = node.slice(2);
      if (children.length === 0) return 0;

      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }
      if (count > 1) {
        pushOp(tape, OP_UNION);
        pushU32(tape, count);
      }
      if (count > 0 && colorName !== 'unset') {
        const [r, g, b] = hexToRgb(COLOR_MAP[colorName] || COLOR_MAP.gray);
        pushOp(tape, OP_PAINT);
        tape.push(r);
        tape.push(g);
        tape.push(b);
      }
      return count > 0 ? 1 : 0;
    }
    case 'recolor': {
      // Recolor requires per-point color matching — too complex for tape.
      // Fall back to treating it like paint with the 'to' color.
      const toName = node[1].to || 'gray';
      const children = node.slice(2);
      if (children.length === 0) return 0;
      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }
      if (count > 1) {
        pushOp(tape, OP_UNION);
        pushU32(tape, count);
      }
      if (count > 0 && toName !== 'unset') {
        const [r, g, b] = hexToRgb(COLOR_MAP[toName] || COLOR_MAP.gray);
        pushOp(tape, OP_PAINT);
        tape.push(r);
        tape.push(g);
        tape.push(b);
      }
      return count > 0 ? 1 : 0;
    }
    case 'union': {
      const children = nodeChildren(node);
      if (children.length === 0) return 0;
      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }
      if (count > 1) {
        pushOp(tape, OP_UNION);
        pushU32(tape, count);
      }
      return count > 0 ? 1 : 0;
    }
    case 'intersect': {
      const children = nodeChildren(node);
      if (children.length === 0) return 0;
      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }
      if (count > 1) {
        pushOp(tape, OP_INTERSECT);
        pushU32(tape, count);
      }
      return count > 0 ? 1 : 0;
    }
    case 'anti': {
      const children = nodeChildren(node);
      if (children.length === 0) return 0;
      const count = compileNode(children[0], tape);
      if (count > 0) {
        pushOp(tape, OP_ANTI);
      }
      return count;
    }
    case 'complement': {
      const children = nodeChildren(node);
      if (children.length === 0) return 0;
      const count = compileNode(children[0], tape);
      if (count > 0) {
        pushOp(tape, OP_COMPLEMENT);
      }
      return count;
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      let count = 0;
      for (const child of children) {
        count += compileNode(child, tape);
      }
      if (count > 1) {
        pushOp(tape, OP_FUSE);
        pushU32(tape, count);
        tape.push(k);
      }
      return count > 0 ? 1 : 0;
    }
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_MIRROR);
      pushU32(tape, axisToU32(axis));
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const angleDeg = node[1].angle != null ? node[1].angle : 45;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      const rad = -angleDeg * Math.PI / 180;
      pushOp(tape, OP_ROTATE);
      pushU32(tape, axisToU32(axis));
      tape.push(Math.cos(rad));
      tape.push(Math.sin(rad));
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'twist': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.1;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_TWIST);
      pushU32(tape, axisToU32(axis));
      tape.push(rate);
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'radial': {
      const axis = node[1].axis || 'y';
      const n = Math.max(2, Math.round(node[1].count || 6));
      const sector = 2 * Math.PI / n;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_RADIAL);
      pushU32(tape, axisToU32(axis));
      tape.push(sector);
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const minScale = Math.min(sx, sy, sz);
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_STRETCH);
      tape.push(sx);
      tape.push(sy);
      tape.push(sz);
      tape.push(minScale);
      const count = compileNode(children[0], tape);
      // Pop transform and scale distance
      pushOp(tape, OP_POP_TRANSFORM_SCALE);
      tape.push(minScale);
      return count;
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_TILE);
      pushU32(tape, axisToU32(axis));
      tape.push(spacing);
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'bend': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.05;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_BEND);
      pushU32(tape, axisToU32(axis));
      tape.push(rate);
      const count = compileNode(children[0], tape);
      pushOp(tape, OP_POP_TRANSFORM);
      return count;
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      if (children.length === 0) return 0;
      pushOp(tape, OP_TAPER);
      pushU32(tape, axisToU32(axis));
      tape.push(rate);
      const count = compileNode(children[0], tape);
      // Pop transform and scale distance by the taper factor.
      // OP_POP_TAPER restores coords and multiplies distance by
      // max(0.01, 1 + rate * along), where 'along' comes from the saved coords.
      pushOp(tape, OP_POP_TAPER);
      pushU32(tape, axisToU32(axis));
      tape.push(rate);
      return count;
    }
    default:
      return 0;
  }
}

// Compile a full AST into a tape + bounds.
// Returns { tape: Float32Array, bounds: { min, max } }
export function compileTape(ast) {
  if (!ast) return null;
  const tape = [];
  compileNode(ast, tape);
  const bounds = estimateBounds(ast);
  return {
    tape: new Float32Array(tape),
    bounds
  };
}

// For testing: decode tape to human-readable form
const OP_NAMES = {
  [OP_SPHERE]: 'SPHERE', [OP_CUBE]: 'CUBE', [OP_CYLINDER]: 'CYLINDER',
  [OP_TRANSLATE]: 'TRANSLATE', [OP_UNION]: 'UNION', [OP_INTERSECT]: 'INTERSECT',
  [OP_ANTI]: 'ANTI', [OP_COMPLEMENT]: 'COMPLEMENT', [OP_FUSE]: 'FUSE',
  [OP_PAINT]: 'PAINT', [OP_MIRROR]: 'MIRROR', [OP_ROTATE]: 'ROTATE',
  [OP_TWIST]: 'TWIST', [OP_RADIAL]: 'RADIAL', [OP_STRETCH]: 'STRETCH',
  [OP_TILE]: 'TILE', [OP_BEND]: 'BEND', [OP_TAPER]: 'TAPER',
  [OP_POP_TRANSFORM]: 'POP_TRANSFORM', [OP_POP_TRANSFORM_SCALE]: 'POP_TRANSFORM_SCALE',
  [OP_POP_TAPER]: 'POP_TAPER'
};

export function disassembleTape(tapeF32) {
  const lines = [];
  let pc = 0;
  const view = new DataView(tapeF32.buffer, tapeF32.byteOffset, tapeF32.byteLength);
  while (pc < tapeF32.length) {
    const op = view.getUint32(pc * 4, true);
    const name = OP_NAMES[op] || `UNKNOWN(${op})`;
    pc++;
    let args = '';
    // Decode operands based on opcode
    switch (op) {
      case OP_SPHERE: args = `r=${tapeF32[pc++]}`; break;
      case OP_CUBE: args = `size=${tapeF32[pc++]}`; break;
      case OP_CYLINDER: args = `r=${tapeF32[pc++]} h=${tapeF32[pc++]}`; break;
      case OP_TRANSLATE: args = `x=${tapeF32[pc++]} y=${tapeF32[pc++]} z=${tapeF32[pc++]}`; break;
      case OP_UNION:
      case OP_INTERSECT: {
        const n = view.getUint32(pc * 4, true); pc++;
        args = `n=${n}`;
        break;
      }
      case OP_FUSE: {
        const n = view.getUint32(pc * 4, true); pc++;
        args = `n=${n} k=${tapeF32[pc++]}`;
        break;
      }
      case OP_PAINT: args = `r=${tapeF32[pc++].toFixed(3)} g=${tapeF32[pc++].toFixed(3)} b=${tapeF32[pc++].toFixed(3)}`; break;
      case OP_MIRROR: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]}`;
        break;
      }
      case OP_ROTATE: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} cos=${tapeF32[pc++].toFixed(4)} sin=${tapeF32[pc++].toFixed(4)}`;
        break;
      }
      case OP_TWIST: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} rate=${tapeF32[pc++]}`;
        break;
      }
      case OP_RADIAL: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} sector=${tapeF32[pc++].toFixed(4)}`;
        break;
      }
      case OP_STRETCH: args = `sx=${tapeF32[pc++]} sy=${tapeF32[pc++]} sz=${tapeF32[pc++]} minScale=${tapeF32[pc++]}`; break;
      case OP_TILE: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} spacing=${tapeF32[pc++]}`;
        break;
      }
      case OP_BEND: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} rate=${tapeF32[pc++]}`;
        break;
      }
      case OP_TAPER: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} rate=${tapeF32[pc++]}`;
        break;
      }
      case OP_POP_TRANSFORM_SCALE: args = `scale=${tapeF32[pc++]}`; break;
      case OP_POP_TAPER: {
        const ax = view.getUint32(pc * 4, true); pc++;
        args = `axis=${['x','y','z'][ax]} rate=${tapeF32[pc++]}`;
        break;
      }
      case OP_POP_TRANSFORM: break;
      case OP_ANTI: break;
      case OP_COMPLEMENT: break;
    }
    lines.push(`  ${name} ${args}`);
  }
  return lines.join('\n');
}
