import * as THREE from 'three';
import { meshField } from './surface-nets.js';

// S-expression AST → Three.js geometry
// Consumes the structured AST from codegen.js, knows nothing about blocks.

const COLOR_MAP = {
  red:   0xff4444,
  blue:  0x4488ff,
  green: 0x44cc44,
  yellow: 0xffcc00,
  orange: 0xff8800
};

export function evaluate(ast) {
  if (!ast) return new THREE.Group();
  const result = evalNode(ast);
  if (!result) return new THREE.Group();
  const group = new THREE.Group();
  group.add(result);
  return group;
}

function evalNode(node) {
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      const s = p.size || 20;
      const geo = new THREE.BoxGeometry(s, s, s);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'sphere': {
      const p = node[1];
      const geo = new THREE.SphereGeometry(p.radius || 15, 32, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'cylinder': {
      const p = node[1];
      const r = p.radius || 10;
      const h = p.height || 30;
      const geo = new THREE.CylinderGeometry(r, r, h, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) return null;
      const group = new THREE.Group();
      group.position.set(p.x || 0, p.y || 0, p.z || 0);
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    case 'union': {
      const children = node.slice(1);
      const group = new THREE.Group();
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    case 'smooth-union': {
      const p = node[1];
      const k = p.k || 5;
      const res = p.resolution || 48;
      const children = node.slice(2);
      if (children.length === 0) return null;

      const fields = children.map(c => evalField(c));
      const combined = softmin(fields, k);
      const bounds = estimateBounds(node);
      const geo = meshField(combined, bounds, res);
      const color = COLOR_MAP[p.color] || 0xffaa22;
      const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
      return new THREE.Mesh(geo, mat);
    }
    default:
      return null;
  }
}

// ---- SDF evaluation: AST → field function (x,y,z) => distance ----

export function evalField(node) {
  const type = node[0];

  switch (type) {
    case 'sphere': {
      const r = node[1].radius || 15;
      return (x, y, z) => Math.sqrt(x*x + y*y + z*z) - r;
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - s, qy = Math.abs(y) - s, qz = Math.abs(z) - s;
        const outside = Math.sqrt(
          Math.max(qx, 0)**2 + Math.max(qy, 0)**2 + Math.max(qz, 0)**2
        );
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        return outside + inside;
      };
    }
    case 'cylinder': {
      const r = node[1].radius || 10;
      const h = node[1].height || 30;
      return (x, y, z) => {
        const dx = Math.sqrt(x*x + z*z) - r;
        const dy = Math.abs(y) - h / 2;
        const outside = Math.sqrt(Math.max(dx, 0)**2 + Math.max(dy, 0)**2);
        const inside = Math.min(Math.max(dx, dy), 0);
        return outside + inside;
      };
    }
    case 'translate': {
      const p = node[1];
      const tx = p.x || 0, ty = p.y || 0, tz = p.z || 0;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      if (children.length === 1) {
        const child = evalField(children[0]);
        return (x, y, z) => child(x - tx, y - ty, z - tz);
      }
      // Multiple children under translate: implicit union
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        let d = fields[0](px, py, pz);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](px, py, pz));
        return d;
      };
    }
    case 'union': {
      const children = node.slice(1);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'smooth-union': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return softmin(fields, k);
    }
    default: {
      console.warn(`evalField: unknown node type "${type}", returning zero field`);
      return () => 0;
    }
  }
}

// Smooth minimum via stable log-sum-exp (softmin)
function softmin(fields, k) {
  if (fields.length === 1) return fields[0];
  return (x, y, z) => {
    // Compute -f_i / k for each child
    const neg = fields.map(f => -f(x, y, z) / k);
    // Shifted log-sum-exp for numerical stability
    const maxNeg = Math.max(...neg);
    let sum = 0;
    for (const v of neg) sum += Math.exp(v - maxNeg);
    return -k * (Math.log(sum) + maxNeg);
  };
}

// ---- Bounding box estimation from AST ----

export function estimateBounds(node, offset = [0, 0, 0]) {
  const type = node[0];
  const pad = 5; // extra padding

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
    case 'translate': {
      const p = node[1];
      const newOff = [offset[0] + (p.x||0), offset[1] + (p.y||0), offset[2] + (p.z||0)];
      const children = node.slice(2);
      return mergeBounds(children.map(c => estimateBounds(c, newOff)));
    }
    case 'union':
    case 'smooth-union': {
      const start = type === 'smooth-union' ? 2 : 1;
      const children = node.slice(start);
      const merged = mergeBounds(children.map(c => estimateBounds(c, offset)));
      if (type === 'smooth-union') {
        // Extra padding for blend radius
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

function mergeBounds(boundsList) {
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
