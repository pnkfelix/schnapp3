// SDF evaluation: AST → field function (x,y,z) => distance
// (Legacy, used by fuse for backward compat; also usable standalone)
// Color nodes (paint, recolor) are transparent to field evaluation.

import { nodeChildren } from './ast-utils.js';

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
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        let d = fields[0](px, py, pz);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](px, py, pz));
        return d;
      };
    }
    case 'paint':
    case 'recolor': {
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      if (children.length === 1) return evalField(children[0]);
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'union': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.min(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'intersect': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return (x, y, z) => {
        let d = fields[0](x, y, z);
        for (let i = 1; i < fields.length; i++) d = Math.max(d, fields[i](x, y, z));
        return d;
      };
    }
    case 'anti': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => 1e10;
      return evalField(children[0]); // anti doesn't change the distance
    }
    case 'complement': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => -child(x, y, z); // negate distance
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const fields = children.map(c => evalField(c));
      return softmin(fields, k);
    }
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        if (axis === 'x') return child(Math.abs(x), y, z);
        if (axis === 'y') return child(x, Math.abs(y), z);
        return child(x, y, Math.abs(z));
      };
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const angleDeg = node[1].angle != null ? node[1].angle : 45;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const rad = -angleDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      return (x, y, z) => {
        if (axis === 'y') return child(c * x - s * z, y, s * x + c * z);
        if (axis === 'x') return child(x, c * y - s * z, s * y + c * z);
        return child(c * x - s * y, s * x + c * y, z);
      };
    }
    case 'twist': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.1;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const angle = -rate * along;
        const c = Math.cos(angle), s = Math.sin(angle);
        const ru = c * u - s * v, rv = s * u + c * v;
        if (axis === 'y') return child(ru, y, rv);
        if (axis === 'x') return child(x, ru, rv);
        return child(ru, rv, z);
      };
    }
    case 'radial': {
      const axis = node[1].axis || 'y';
      const count = Math.max(2, Math.round(node[1].count || 6));
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const sector = 2 * Math.PI / count;
      return (x, y, z) => {
        let u, v, w;
        if (axis === 'y') { u = x; v = z; w = y; }
        else if (axis === 'x') { u = y; v = z; w = x; }
        else { u = x; v = y; w = z; }
        let angle = Math.atan2(v, u);
        if (angle < 0) angle += 2 * Math.PI;
        angle = angle % sector;
        if (angle > sector / 2) angle = sector - angle;
        const r = Math.sqrt(u * u + v * v);
        const nu = r * Math.cos(angle), nv = r * Math.sin(angle);
        if (axis === 'y') return child(nu, w, nv);
        if (axis === 'x') return child(w, nu, nv);
        return child(nu, nv, w);
      };
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const minScale = Math.min(sx, sy, sz);
      return (x, y, z) => child(x / sx, y / sy, z / sz) * minScale;
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      const half = spacing / 2;
      return (x, y, z) => {
        let tx = x, ty = y, tz = z;
        if (axis === 'x') tx = ((x % spacing) + spacing + half) % spacing - half;
        else if (axis === 'y') ty = ((y % spacing) + spacing + half) % spacing - half;
        else tz = ((z % spacing) + spacing + half) % spacing - half;
        return child(tx, ty, tz);
      };
    }
    case 'bend': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.05;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        if (rate === 0) return child(x, y, z);
        let along, perp, w;
        if (axis === 'y') { along = x; perp = y; w = z; }
        else if (axis === 'x') { along = y; perp = x; w = z; }
        else { along = x; perp = z; w = y; }
        const angle = along * rate;
        const c = Math.cos(angle), s = Math.sin(angle);
        const r = perp + 1 / rate;
        const na = s * r;
        const np = c * r - 1 / rate;
        if (axis === 'y') return child(na, np, w);
        if (axis === 'x') return child(np, na, w);
        return child(na, w, np);
      };
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      if (children.length === 0) return () => 1e10;
      const child = evalField(children[0]);
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const scale = Math.max(0.01, 1 + rate * along);
        const invScale = 1 / scale;
        const d = (axis === 'y') ? child(u * invScale, y, v * invScale)
                : (axis === 'x') ? child(x, u * invScale, v * invScale)
                : child(u * invScale, v * invScale, z);
        return d * scale;
      };
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
    const neg = fields.map(f => -f(x, y, z) / k);
    const maxNeg = Math.max(...neg);
    let sum = 0;
    for (const v of neg) sum += Math.exp(v - maxNeg);
    return -k * (Math.log(sum) + maxNeg);
  };
}
