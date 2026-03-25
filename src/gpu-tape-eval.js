// CPU-side tape interpreter — mirrors the WGSL shader logic exactly.
// Used for testing: we can verify tape compilation correctness
// by comparing tape eval results against the reference csg-field.js evaluator.
//
// This must match gpu-sdf.wgsl instruction for instruction.

import {
  OP_SPHERE, OP_CUBE, OP_CYLINDER, OP_TRANSLATE,
  OP_UNION, OP_INTERSECT, OP_ANTI, OP_COMPLEMENT, OP_FUSE,
  OP_PAINT, OP_MIRROR, OP_ROTATE, OP_TWIST, OP_RADIAL,
  OP_STRETCH, OP_TILE, OP_BEND, OP_TAPER,
  OP_POP_TRANSFORM, OP_POP_TRANSFORM_SCALE, OP_POP_TAPER
} from './gpu-tape.js';

const UNSET_COLOR = -1.0;
const DEFAULT_GRAY = 0.6666667;

// Read a u32 from a Float32Array at position pc
function readU32(tape, pc) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = tape[pc];
  return new Uint32Array(buf)[0];
}

// Evaluate a tape at a single point (x, y, z).
// Returns { polarity, distance, color: [r, g, b] }
export function evaluateTapeAt(tape, x, y, z) {
  // Coordinate stack
  const cx = [], cy = [], cz = [];
  let px = x, py = y, pz = z;

  // Value stack
  const vsPol = [], vsDist = [], vsCr = [], vsCg = [], vsCb = [];

  let pc = 0;
  while (pc < tape.length) {
    const op = readU32(tape, pc);
    pc++;

    switch (op) {
      case OP_SPHERE: {
        const radius = tape[pc++];
        const d = Math.sqrt(px*px + py*py + pz*pz) - radius;
        vsPol.push(d <= 0 ? 1 : 0);
        vsDist.push(d);
        vsCr.push(UNSET_COLOR);
        vsCg.push(UNSET_COLOR);
        vsCb.push(UNSET_COLOR);
        break;
      }
      case OP_CUBE: {
        const half = tape[pc++] * 0.5;
        const qx = Math.abs(px) - half;
        const qy = Math.abs(py) - half;
        const qz = Math.abs(pz) - half;
        const outside = Math.sqrt(
          Math.max(qx, 0)**2 + Math.max(qy, 0)**2 + Math.max(qz, 0)**2
        );
        const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
        const d = outside + inside;
        vsPol.push(d <= 0 ? 1 : 0);
        vsDist.push(d);
        vsCr.push(UNSET_COLOR);
        vsCg.push(UNSET_COLOR);
        vsCb.push(UNSET_COLOR);
        break;
      }
      case OP_CYLINDER: {
        const radius = tape[pc++];
        const height = tape[pc++];
        const dx = Math.sqrt(px*px + pz*pz) - radius;
        const dy = Math.abs(py) - height * 0.5;
        const outside = Math.sqrt(
          Math.max(dx, 0)**2 + Math.max(dy, 0)**2
        );
        const inside = Math.min(Math.max(dx, dy), 0);
        const d = outside + inside;
        vsPol.push(d <= 0 ? 1 : 0);
        vsDist.push(d);
        vsCr.push(UNSET_COLOR);
        vsCg.push(UNSET_COLOR);
        vsCb.push(UNSET_COLOR);
        break;
      }
      case OP_TRANSLATE: {
        const tx = tape[pc++];
        const ty = tape[pc++];
        const tz = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        px -= tx; py -= ty; pz -= tz;
        break;
      }
      case OP_UNION: {
        const n = readU32(tape, pc); pc++;
        if (n >= 2 && vsPol.length >= n) {
          const start = vsPol.length - n;
          let bestIdx = start;
          let pSum = 0;
          for (let i = start; i < vsPol.length; i++) {
            pSum += vsPol[i];
            if (vsDist[i] < vsDist[bestIdx]) bestIdx = i;
          }
          const d = vsDist[bestIdx];
          let cr = vsCr[bestIdx], cg = vsCg[bestIdx], cb = vsCb[bestIdx];
          if (cr === UNSET_COLOR) {
            for (let i = start; i < vsPol.length; i++) {
              if (vsCr[i] !== UNSET_COLOR) {
                cr = vsCr[i]; cg = vsCg[i]; cb = vsCb[i];
                break;
              }
            }
          }
          vsPol.length = start + 1;
          vsDist.length = start + 1;
          vsCr.length = start + 1;
          vsCg.length = start + 1;
          vsCb.length = start + 1;
          vsPol[start] = Math.sign(pSum);
          vsDist[start] = d;
          vsCr[start] = cr;
          vsCg[start] = cg;
          vsCb[start] = cb;
        }
        break;
      }
      case OP_INTERSECT: {
        const n = readU32(tape, pc); pc++;
        if (n >= 2 && vsPol.length >= n) {
          const start = vsPol.length - n;
          let pProd = vsPol[start];
          let bestIdx = start;
          for (let i = start + 1; i < vsPol.length; i++) {
            pProd *= vsPol[i];
            if (vsDist[i] > vsDist[bestIdx]) bestIdx = i;
          }
          const d = vsDist[bestIdx];
          let cr = vsCr[bestIdx], cg = vsCg[bestIdx], cb = vsCb[bestIdx];
          if (cr === UNSET_COLOR) {
            for (let i = start; i < vsPol.length; i++) {
              if (vsCr[i] !== UNSET_COLOR) {
                cr = vsCr[i]; cg = vsCg[i]; cb = vsCb[i];
                break;
              }
            }
          }
          vsPol.length = start + 1;
          vsDist.length = start + 1;
          vsCr.length = start + 1;
          vsCg.length = start + 1;
          vsCb.length = start + 1;
          vsPol[start] = pProd;
          vsDist[start] = d;
          vsCr[start] = cr;
          vsCg[start] = cg;
          vsCb[start] = cb;
        }
        break;
      }
      case OP_ANTI: {
        if (vsPol.length >= 1) {
          vsPol[vsPol.length - 1] = -vsPol[vsPol.length - 1];
        }
        break;
      }
      case OP_COMPLEMENT: {
        if (vsDist.length >= 1) {
          const nd = -vsDist[vsDist.length - 1];
          vsDist[vsDist.length - 1] = nd;
          vsPol[vsPol.length - 1] = nd <= 0 ? 1 : 0;
        }
        break;
      }
      case OP_FUSE: {
        const n = readU32(tape, pc); pc++;
        const k = tape[pc++];
        if (n >= 2 && vsPol.length >= n) {
          const start = vsPol.length - n;
          let pSum = 0;
          let maxNeg = -1e30;
          for (let i = start; i < vsPol.length; i++) {
            pSum += vsPol[i];
            const negVal = -vsDist[i] / k;
            if (negVal > maxNeg) maxNeg = negVal;
          }
          let expSum = 0;
          for (let i = start; i < vsPol.length; i++) {
            expSum += Math.exp(-vsDist[i] / k - maxNeg);
          }
          const dist = -k * (Math.log(expSum) + maxNeg);

          let totalSetW = 0;
          let br = 0, bg = 0, bb = 0;
          for (let i = start; i < vsPol.length; i++) {
            const w = Math.exp(-vsDist[i] / k - maxNeg);
            if (vsCr[i] !== UNSET_COLOR) {
              totalSetW += w;
              br += vsCr[i] * w;
              bg += vsCg[i] * w;
              bb += vsCb[i] * w;
            }
          }
          let cr = UNSET_COLOR, cg = UNSET_COLOR, cb = UNSET_COLOR;
          if (totalSetW > 0) {
            cr = br / totalSetW;
            cg = bg / totalSetW;
            cb = bb / totalSetW;
          }

          vsPol.length = start + 1;
          vsDist.length = start + 1;
          vsCr.length = start + 1;
          vsCg.length = start + 1;
          vsCb.length = start + 1;
          vsPol[start] = Math.sign(pSum);
          vsDist[start] = dist;
          vsCr[start] = cr;
          vsCg[start] = cg;
          vsCb[start] = cb;
        }
        break;
      }
      case OP_PAINT: {
        const r = tape[pc++];
        const g = tape[pc++];
        const b = tape[pc++];
        if (vsPol.length >= 1) {
          vsCr[vsCr.length - 1] = r;
          vsCg[vsCg.length - 1] = g;
          vsCb[vsCb.length - 1] = b;
        }
        break;
      }
      case OP_MIRROR: {
        const axis = readU32(tape, pc); pc++;
        cx.push(px); cy.push(py); cz.push(pz);
        if (axis === 0) px = Math.abs(px);
        else if (axis === 1) py = Math.abs(py);
        else pz = Math.abs(pz);
        break;
      }
      case OP_ROTATE: {
        const axis = readU32(tape, pc); pc++;
        const cosA = tape[pc++];
        const sinA = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        if (axis === 1) {
          const nx = cosA * px - sinA * pz;
          const nz = sinA * px + cosA * pz;
          px = nx; pz = nz;
        } else if (axis === 0) {
          const ny = cosA * py - sinA * pz;
          const nz = sinA * py + cosA * pz;
          py = ny; pz = nz;
        } else {
          const nx = cosA * px - sinA * py;
          const ny = sinA * px + cosA * py;
          px = nx; py = ny;
        }
        break;
      }
      case OP_TWIST: {
        const axis = readU32(tape, pc); pc++;
        const rate = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        let along, u, v;
        if (axis === 1) { along = py; u = px; v = pz; }
        else if (axis === 0) { along = px; u = py; v = pz; }
        else { along = pz; u = px; v = py; }
        const angle = -rate * along;
        const c = Math.cos(angle), s = Math.sin(angle);
        const ru = c * u - s * v, rv = s * u + c * v;
        if (axis === 1) { px = ru; pz = rv; }
        else if (axis === 0) { py = ru; pz = rv; }
        else { px = ru; py = rv; }
        break;
      }
      case OP_RADIAL: {
        const axis = readU32(tape, pc); pc++;
        const sector = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        let u, v, w;
        if (axis === 1) { u = px; v = pz; w = py; }
        else if (axis === 0) { u = py; v = pz; w = px; }
        else { u = px; v = py; w = pz; }
        let ang = Math.atan2(v, u);
        if (ang < 0) ang += 2 * Math.PI;
        ang = ang % sector;
        if (ang > sector * 0.5) ang = sector - ang;
        const r = Math.sqrt(u * u + v * v);
        const nu = r * Math.cos(ang), nv = r * Math.sin(ang);
        if (axis === 1) { px = nu; py = w; pz = nv; }
        else if (axis === 0) { px = w; py = nu; pz = nv; }
        else { px = nu; py = nv; pz = w; }
        break;
      }
      case OP_STRETCH: {
        const sx = tape[pc++];
        const sy = tape[pc++];
        const sz = tape[pc++];
        const minScale = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        px /= sx; py /= sy; pz /= sz;
        break;
      }
      case OP_TILE: {
        const axis = readU32(tape, pc); pc++;
        const spacing = tape[pc++];
        const half = spacing * 0.5;
        cx.push(px); cy.push(py); cz.push(pz);
        if (axis === 0) px = ((px % spacing) + spacing + half) % spacing - half;
        else if (axis === 1) py = ((py % spacing) + spacing + half) % spacing - half;
        else pz = ((pz % spacing) + spacing + half) % spacing - half;
        break;
      }
      case OP_BEND: {
        const axis = readU32(tape, pc); pc++;
        const rate = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        if (rate !== 0) {
          let along, perp, w;
          if (axis === 1) { along = px; perp = py; w = pz; }
          else if (axis === 0) { along = py; perp = px; w = pz; }
          else { along = px; perp = pz; w = py; }
          const bendAngle = along * rate;
          const c = Math.cos(bendAngle), s = Math.sin(bendAngle);
          const r = perp + 1 / rate;
          const na = s * r;
          const np = c * r - 1 / rate;
          if (axis === 1) { px = na; py = np; pz = w; }
          else if (axis === 0) { px = np; py = na; pz = w; }
          else { px = na; py = w; pz = np; }
        }
        break;
      }
      case OP_TAPER: {
        const axis = readU32(tape, pc); pc++;
        const rate = tape[pc++];
        cx.push(px); cy.push(py); cz.push(pz);
        let along;
        if (axis === 1) along = py;
        else if (axis === 0) along = px;
        else along = pz;
        const scale = Math.max(0.01, 1 + rate * along);
        const invScale = 1 / scale;
        if (axis === 1) { px *= invScale; pz *= invScale; }
        else if (axis === 0) { py *= invScale; pz *= invScale; }
        else { px *= invScale; py *= invScale; }
        break;
      }
      case OP_POP_TRANSFORM: {
        if (cx.length > 0) {
          px = cx.pop(); py = cy.pop(); pz = cz.pop();
        }
        break;
      }
      case OP_POP_TRANSFORM_SCALE: {
        const scaleFactor = tape[pc++];
        if (cx.length > 0) {
          px = cx.pop(); py = cy.pop(); pz = cz.pop();
        }
        if (vsDist.length >= 1) {
          vsDist[vsDist.length - 1] *= scaleFactor;
        }
        break;
      }
      case OP_POP_TAPER: {
        // Restore coords and scale distance by taper factor
        const axis = readU32(tape, pc); pc++;
        const rate = tape[pc++];
        // Get the 'along' coordinate from the saved (pre-taper) coords
        if (cx.length > 0) {
          const savedX = cx.pop();
          const savedY = cy.pop();
          const savedZ = cz.pop();
          let along;
          if (axis === 1) along = savedY;
          else if (axis === 0) along = savedX;
          else along = savedZ;
          const scale = Math.max(0.01, 1 + rate * along);
          if (vsDist.length >= 1) {
            vsDist[vsDist.length - 1] *= scale;
          }
          px = savedX; py = savedY; pz = savedZ;
        }
        break;
      }
      default:
        break;
    }
  }

  if (vsPol.length >= 1) {
    let cr = vsCr[0], cg = vsCg[0], cb = vsCb[0];
    if (cr === UNSET_COLOR) {
      cr = DEFAULT_GRAY; cg = DEFAULT_GRAY; cb = DEFAULT_GRAY;
    }
    return {
      polarity: vsPol[0],
      distance: vsDist[0],
      color: [cr, cg, cb]
    };
  }
  return { polarity: 0, distance: 1e10, color: [DEFAULT_GRAY, DEFAULT_GRAY, DEFAULT_GRAY] };
}
