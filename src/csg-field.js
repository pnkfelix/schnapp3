// Pure-computation CSG field evaluator (no Three.js dependency).
// Extracted from the duplicated code in mesh-worker.js so that both the worker
// and the test suite can import it.
//
// evalCSGField(astNode) => (x, y, z) => { polarity, distance, color }

const COLOR_MAP = {
  unset: 0xaaaaaa, gray: 0xaaaaaa, red: 0xff4444, blue: 0x4488ff,
  green: 0x44cc44, yellow: 0xffcc00, orange: 0xff8800
};
const DEFAULT_COLOR = 'gray';
const UNSET_COLOR = 'unset';

function hexToRgb(hex) {
  return [(hex >> 16 & 0xff) / 255, (hex >> 8 & 0xff) / 255, (hex & 0xff) / 255];
}
const DEFAULT_RGB = hexToRgb(COLOR_MAP[DEFAULT_COLOR]);
const UNSET_RGB = DEFAULT_RGB;
const EMPTY = { polarity: 0, distance: 1e10, color: UNSET_COLOR };

export { COLOR_MAP, DEFAULT_COLOR, UNSET_COLOR, UNSET_RGB, EMPTY };
export { hexToRgb };

export function evalCSGField(node) {
  if (!node || !Array.isArray(node)) return () => EMPTY;
  const type = node[0];
  switch (type) {
    case 'tag':
    case 'tags': {
      return node.length > 2 ? evalCSGField(node[2]) : () => EMPTY;
    }
    case 'sphere': {
      const r = node[1].radius || 15;
      return (x, y, z) => {
        const d = Math.sqrt(x*x + y*y + z*z) - r;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (x, y, z) => {
        const qx = Math.abs(x) - s, qy = Math.abs(y) - s, qz = Math.abs(z) - s;
        const outside = Math.sqrt(Math.max(qx,0)**2 + Math.max(qy,0)**2 + Math.max(qz,0)**2);
        const inside = Math.min(Math.max(qx, qy, qz), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'cylinder': {
      const r = node[1].radius || 10;
      const h = node[1].height || 30;
      return (x, y, z) => {
        const dx = Math.sqrt(x*x + z*z) - r;
        const dy = Math.abs(y) - h / 2;
        const outside = Math.sqrt(Math.max(dx,0)**2 + Math.max(dy,0)**2);
        const inside = Math.min(Math.max(dx, dy), 0);
        const d = outside + inside;
        return { polarity: d <= 0 ? 1 : 0, distance: d, color: UNSET_COLOR };
      };
    }
    case 'translate': {
      const p = node[1];
      const tx = p.x || 0, ty = p.y || 0, tz = p.z || 0;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      if (children.length === 1) {
        const child = evalCSGField(children[0]);
        return (x, y, z) => child(x - tx, y - ty, z - tz);
      }
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => {
        const px = x - tx, py = y - ty, pz = z - tz;
        return csgUnion(fields.map(f => f(px, py, pz)));
      };
    }
    case 'paint': {
      const colorName = node[1].color || DEFAULT_COLOR;
      const color = colorName === UNSET_COLOR
        ? UNSET_COLOR
        : hexToRgb(COLOR_MAP[colorName] || COLOR_MAP[DEFAULT_COLOR]);
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const inner = children.length === 1
        ? evalCSGField(children[0])
        : ((fields) => (x, y, z) => csgUnion(fields.map(f => f(x, y, z))))(children.map(c => evalCSGField(c)));
      return (x, y, z) => {
        const r = inner(x, y, z);
        return { polarity: r.polarity, distance: r.distance, color };
      };
    }
    case 'recolor': {
      const fromName = node[1].from || DEFAULT_COLOR;
      const fromRgb = hexToRgb(COLOR_MAP[fromName] || COLOR_MAP[DEFAULT_COLOR]);
      const toName = node[1].to || DEFAULT_COLOR;
      const toColor = toName === UNSET_COLOR
        ? UNSET_COLOR
        : hexToRgb(COLOR_MAP[toName] || COLOR_MAP[DEFAULT_COLOR]);
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const inner = children.length === 1
        ? evalCSGField(children[0])
        : ((fields) => (x, y, z) => csgUnion(fields.map(f => f(x, y, z))))(children.map(c => evalCSGField(c)));
      return (x, y, z) => {
        const r = inner(x, y, z);
        const match = r.color !== UNSET_COLOR
          ? fromName !== UNSET_COLOR && Math.abs(r.color[0] - fromRgb[0]) + Math.abs(r.color[1] - fromRgb[1]) + Math.abs(r.color[2] - fromRgb[2]) < 0.05
          : fromName === UNSET_COLOR;
        return { polarity: r.polarity, distance: r.distance, color: match ? toColor : r.color };
      };
    }
    case 'union': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgUnion(fields.map(f => f(x, y, z)));
    }
    case 'intersect': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => csgIntersect(fields.map(f => f(x, y, z)));
    }
    case 'anti': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        return { polarity: -r.polarity, distance: r.distance, color: r.color };
      };
    }
    case 'complement': {
      const children = node.slice(1);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        const r = child(x, y, z);
        const nd = -r.distance;
        return { polarity: nd <= 0 ? 1 : 0, distance: nd, color: r.color };
      };
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const fields = children.map(c => evalCSGField(c));
      return (x, y, z) => {
        const results = fields.map(f => f(x, y, z));
        let pSum = 0;
        for (const r of results) pSum += r.polarity;
        const distances = results.map(r => r.distance);
        const neg = distances.map(d => -d / k);
        const maxNeg = Math.max(...neg);
        let sum = 0;
        for (const v of neg) sum += Math.exp(v - maxNeg);
        const dist = -k * (Math.log(sum) + maxNeg);
        const weights = neg.map(v => Math.exp(v - maxNeg));
        let setTotal = 0;
        for (let i = 0; i < results.length; i++) {
          if (results[i].color !== UNSET_COLOR) setTotal += weights[i];
        }
        let color = UNSET_COLOR;
        if (setTotal > 0) {
          color = [0, 0, 0];
          for (let i = 0; i < results.length; i++) {
            if (results[i].color === UNSET_COLOR) continue;
            const w = weights[i] / setTotal;
            color[0] += results[i].color[0] * w;
            color[1] += results[i].color[1] * w;
            color[2] += results[i].color[2] * w;
          }
        }
        return { polarity: Math.sign(pSum), distance: dist, color };
      };
    }
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      const minScale = Math.min(sx, sy, sz);
      return (x, y, z) => {
        const result = child(x / sx, y / sy, z / sz);
        return { polarity: result.polarity, distance: result.distance * minScale, color: result.color };
      };
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
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
      if (children.length === 0) return () => EMPTY;
      const child = evalCSGField(children[0]);
      return (x, y, z) => {
        let along, u, v;
        if (axis === 'y') { along = y; u = x; v = z; }
        else if (axis === 'x') { along = x; u = y; v = z; }
        else { along = z; u = x; v = y; }
        const scale = Math.max(0.01, 1 + rate * along);
        const invScale = 1 / scale;
        const result = (axis === 'y') ? child(u * invScale, y, v * invScale)
                     : (axis === 'x') ? child(x, u * invScale, v * invScale)
                     : child(u * invScale, v * invScale, z);
        return { polarity: result.polarity, distance: result.distance * scale, color: result.color };
      };
    }
    default:
      return () => ({ polarity: 0, distance: 0, color: UNSET_COLOR });
  }
}

function csgUnion(results) {
  let pSum = 0, best = results[0];
  for (const r of results) { pSum += r.polarity; if (r.distance < best.distance) best = r; }
  let color = best.color;
  if (color === UNSET_COLOR) {
    for (const r of results) { if (r.color !== UNSET_COLOR) { color = r.color; break; } }
  }
  return { polarity: Math.sign(pSum), distance: best.distance, color };
}

function csgIntersect(results) {
  let pProd = results[0].polarity, best = results[0];
  for (let i = 1; i < results.length; i++) {
    pProd *= results[i].polarity;
    if (results[i].distance > best.distance) best = results[i];
  }
  let color = best.color;
  if (color === UNSET_COLOR) {
    for (const r of results) { if (r.color !== UNSET_COLOR) { color = r.color; break; } }
  }
  return { polarity: pProd, distance: best.distance, color };
}

export function estimateBounds(node, offset = [0, 0, 0]) {
  if (!node || !Array.isArray(node)) return { min: [offset[0]-20,offset[1]-20,offset[2]-20], max: [offset[0]+20,offset[1]+20,offset[2]+20] };
  const type = node[0];
  const pad = 5;
  switch (type) {
    case 'tag': case 'tags': return node.length > 2 ? estimateBounds(node[2], offset) : { min: [offset[0]-20,offset[1]-20,offset[2]-20], max: [offset[0]+20,offset[1]+20,offset[2]+20] };
    case 'sphere': { const r = (node[1].radius || 15) + pad; return { min: [offset[0]-r,offset[1]-r,offset[2]-r], max: [offset[0]+r,offset[1]+r,offset[2]+r] }; }
    case 'cube': { const h = (node[1].size || 20) / 2 + pad; return { min: [offset[0]-h,offset[1]-h,offset[2]-h], max: [offset[0]+h,offset[1]+h,offset[2]+h] }; }
    case 'cylinder': { const r = (node[1].radius || 10) + pad; const h = (node[1].height || 30) / 2 + pad; return { min: [offset[0]-r,offset[1]-h,offset[2]-r], max: [offset[0]+r,offset[1]+h,offset[2]+r] }; }
    case 'translate': { const p = node[1]; const no = [offset[0]+(p.x||0), offset[1]+(p.y||0), offset[2]+(p.z||0)]; return mergeBounds(node.slice(2).map(c => estimateBounds(c, no))); }
    case 'paint': case 'recolor': return mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
    case 'anti': case 'complement': return mergeBounds(node.slice(1).map(c => estimateBounds(c, offset)));
    case 'mirror': {
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const ai = (node[1].axis || 'x') === 'x' ? 0 : (node[1].axis || 'x') === 'y' ? 1 : 2;
      const ext = Math.max(Math.abs(cb.min[ai]), Math.abs(cb.max[ai]));
      cb.min[ai] = offset[ai] - ext; cb.max[ai] = offset[ai] + ext;
      return cb;
    }
    case 'twist': case 'radial': {
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const axis = node[1].axis || 'y';
      const [a0, a1] = axis === 'x' ? [1,2] : axis === 'y' ? [0,2] : [0,1];
      const r = Math.max(Math.abs(cb.min[a0]),Math.abs(cb.max[a0]),Math.abs(cb.min[a1]),Math.abs(cb.max[a1]));
      cb.min[a0] = offset[a0]-r; cb.max[a0] = offset[a0]+r;
      cb.min[a1] = offset[a1]-r; cb.max[a1] = offset[a1]+r;
      return cb;
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1, sy = node[1].sy != null ? node[1].sy : 1, sz = node[1].sz != null ? node[1].sz : 1;
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const scales = [sx, sy, sz];
      for (let i = 0; i < 3; i++) {
        const cen = offset[i];
        cb.min[i] = cen + (cb.min[i] - cen) * scales[i];
        cb.max[i] = cen + (cb.max[i] - cen) * scales[i];
        if (cb.min[i] > cb.max[i]) [cb.min[i], cb.max[i]] = [cb.max[i], cb.min[i]];
      }
      return cb;
    }
    case 'tile': {
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const ai = (node[1].axis||'x') === 'x' ? 0 : (node[1].axis||'x') === 'y' ? 1 : 2;
      const ext = (node[1].spacing || 30) * 5;
      cb.min[ai] = offset[ai] - ext; cb.max[ai] = offset[ai] + ext;
      return cb;
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const [a0, a1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
      const r = Math.max(
        Math.abs(cb.min[a0]), Math.abs(cb.max[a0]),
        Math.abs(cb.min[a1]), Math.abs(cb.max[a1])
      );
      cb.min[a0] = offset[a0] - r; cb.max[a0] = offset[a0] + r;
      cb.min[a1] = offset[a1] - r; cb.max[a1] = offset[a1] + r;
      return cb;
    }
    case 'bend': {
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const me = Math.max(...cb.max.map((v,i) => Math.abs(v - offset[i])), ...cb.min.map((v,i) => Math.abs(v - offset[i])));
      for (let i = 0; i < 3; i++) { cb.min[i] = offset[i] - me; cb.max[i] = offset[i] + me; }
      return cb;
    }
    case 'taper': {
      const axis = node[1].axis || 'y'; const rate = node[1].rate != null ? node[1].rate : 0.02;
      const cb = mergeBounds(node.slice(2).map(c => estimateBounds(c, offset)));
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const [a0, a1] = axis === 'x' ? [1,2] : axis === 'y' ? [0,2] : [0,1];
      const maxAlong = Math.max(Math.abs(cb.min[ai]-offset[ai]), Math.abs(cb.max[ai]-offset[ai]));
      const maxScale = Math.max(1, 1 + Math.abs(rate) * maxAlong);
      for (const a of [a0, a1]) {
        const ext = Math.max(Math.abs(cb.min[a]-offset[a]), Math.abs(cb.max[a]-offset[a])) * maxScale;
        cb.min[a] = offset[a] - ext; cb.max[a] = offset[a] + ext;
      }
      return cb;
    }
    case 'union': case 'intersect': case 'fuse': {
      const start = type === 'fuse' ? 2 : 1;
      const merged = mergeBounds(node.slice(start).map(c => estimateBounds(c, offset)));
      if (type === 'fuse') { const k = node[1].k || 5; merged.min = merged.min.map(v => v - k); merged.max = merged.max.map(v => v + k); }
      return merged;
    }
    default: return { min: [offset[0]-20,offset[1]-20,offset[2]-20], max: [offset[0]+20,offset[1]+20,offset[2]+20] };
  }
}

function mergeBounds(list) {
  if (list.length === 0) return { min: [-20,-20,-20], max: [20,20,20] };
  const min = [...list[0].min], max = [...list[0].max];
  for (let i = 1; i < list.length; i++) {
    for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], list[i].min[j]); max[j] = Math.max(max[j], list[i].max[j]); }
  }
  return { min, max };
}
