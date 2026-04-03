// Interval evaluator for the S-expression AST.
// Mirrors evalCSGField in evaluator.js but operates on interval ranges
// instead of point values. Used by the octree to classify spatial regions
// as entirely inside, entirely outside, or ambiguous (needs subdivision).
//
// Each primitive/combinator returns a function:
//   (xIv, yIv, zIv) => { distance: [lo, hi], polarity: [loP, hiP] }
// where xIv = [xlo, xhi], etc.

import {
  iadd, isub, imul, ineg, iabs, isqrt, isq,
  imin, imax, imax0, imin0, imax3,
  icos, isin, iatan2, imod, isoftmin, classify
} from './interval.js';
// Text bounds provider — set by the caller before building the interval evaluator.
// Main-thread sets this to getTextSDFBounds (from text-sdf.js).
// Worker sets this to getTextGridBounds (from csg-field.js).
// Returns { hw, hh, hd } or null.
let textBoundsProvider = null;
export function setTextBoundsProvider(fn) { textBoundsProvider = fn; }

// Result when there's nothing
const EMPTY_IV = { distance: [1e10, 1e10], polarity: [0, 0] };

// Build an interval evaluator from an AST node.
// Returns: (xIv, yIv, zIv) => { distance: [lo, hi], polarity: [loP, hiP] }
// polarity interval: if both bounds > 0 → definitely solid
//                    if both bounds < 0 → definitely anti-solid
//                    if both bounds == 0 → definitely empty
// For culling we mostly care about the distance interval.
function nodeChildren(node) {
  if (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) return node.slice(2);
  return node.slice(1);
}

export function evalCSGFieldInterval(node) {
  if (!node || !Array.isArray(node)) return () => ({ polarity: [0, 0], distance: [-Infinity, Infinity] });
  const type = node[0];

  switch (type) {
    case 'sphere': {
      const r = node[1].radius || 15;
      return (xIv, yIv, zIv) => {
        // d = sqrt(x² + y² + z²) - r
        const r2 = iadd(iadd(isq(xIv), isq(yIv)), isq(zIv));
        const dist = isub(isqrt(r2), [r, r]);
        return {
          distance: dist,
          polarity: dist[1] <= 0 ? [1, 1] : dist[0] > 0 ? [0, 0] : [0, 1]
        };
      };
    }
    case 'cube': {
      const s = (node[1].size || 20) / 2;
      return (xIv, yIv, zIv) => {
        // q = abs(p) - s; outside = sqrt(max(q,0)²); inside = min(max(qx,qy,qz), 0)
        const qx = isub(iabs(xIv), [s, s]);
        const qy = isub(iabs(yIv), [s, s]);
        const qz = isub(iabs(zIv), [s, s]);
        const outside = isqrt(iadd(iadd(isq(imax0(qx)), isq(imax0(qy))), isq(imax0(qz))));
        const inside = imin0(imax3(qx, qy, qz));
        const dist = iadd(outside, inside);
        return {
          distance: dist,
          polarity: dist[1] <= 0 ? [1, 1] : dist[0] > 0 ? [0, 0] : [0, 1]
        };
      };
    }
    case 'cylinder': {
      const r = node[1].radius || 10;
      const h = node[1].height || 30;
      return (xIv, yIv, zIv) => {
        // dx = sqrt(x² + z²) - r; dy = abs(y) - h/2
        const dx = isub(isqrt(iadd(isq(xIv), isq(zIv))), [r, r]);
        const dy = isub(iabs(yIv), [h / 2, h / 2]);
        const outside = isqrt(iadd(isq(imax0(dx)), isq(imax0(dy))));
        const inside = imin0(imax(dx, dy));
        const dist = iadd(outside, inside);
        return {
          distance: dist,
          polarity: dist[1] <= 0 ? [1, 1] : dist[0] > 0 ? [0, 0] : [0, 1]
        };
      };
    }
    case 'text': {
      // Approximate text as a box SDF for interval evaluation.
      // The box is an outer bound — we can safely say "definitely outside" when
      // the box SDF is positive, but we must NOT claim "definitely inside" because
      // the actual text shape has gaps between/inside letters. We mark any region
      // that the box says is inside as ambiguous so the octree doesn't cull it.
      const content = node[1].content || 'Text';
      const fontSize = node[1].size || 20;
      const depth = node[1].depth || 4;
      const fontName = node[1].font || 'helvetiker';
      // Use the actual text SDF grid bounds if available (computed from real geometry).
      // Fall back to conservative approximation if the SDF hasn't been built yet.
      const cachedBounds = textBoundsProvider && textBoundsProvider(content, fontSize, depth, fontName);
      let hw, hh, hd;
      if (cachedBounds) {
        hw = cachedBounds.hw;
        hh = cachedBounds.hh;
        hd = cachedBounds.hd;
      } else {
        // Conservative fallback: wide factor + bevel padding
        const bevelThickness = Math.min(depth * 0.1, 1);
        const bevelSize = Math.min(fontSize * 0.03, 0.5);
        hw = fontSize * content.length * 0.35 + bevelSize;
        hh = fontSize * 0.55 + bevelSize;
        hd = depth / 2 + bevelThickness;
      }
      return (xIv, yIv, zIv) => {
        const qx = isub(iabs(xIv), [hw, hw]);
        const qy = isub(iabs(yIv), [hh, hh]);
        const qz = isub(iabs(zIv), [hd, hd]);
        const outside = isqrt(iadd(iadd(isq(imax0(qx)), isq(imax0(qy))), isq(imax0(qz))));
        const inside = imin0(imax3(qx, qy, qz));
        const dist = iadd(outside, inside);
        // Outside the box → definitely outside (polarity [0,0])
        // Inside or straddling → ambiguous (polarity [0,1]) since text
        // has complex interior geometry the box can't represent
        return {
          distance: dist,
          polarity: dist[0] > 0 ? [0, 0] : [0, 1]
        };
      };
    }
    case 'translate': {
      const p = node[1];
      const tx = p.x || 0, ty = p.y || 0, tz = p.z || 0;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      if (children.length === 1) {
        const child = evalCSGFieldInterval(children[0]);
        return (xIv, yIv, zIv) => child(
          isub(xIv, [tx, tx]),
          isub(yIv, [ty, ty]),
          isub(zIv, [tz, tz])
        );
      }
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => {
        const px = isub(xIv, [tx, tx]);
        const py = isub(yIv, [ty, ty]);
        const pz = isub(zIv, [tz, tz]);
        return ivUnion(fields.map(f => f(px, py, pz)));
      };
    }
    case 'paint': {
      // Paint doesn't affect distance — pass through
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      if (children.length === 1) return evalCSGFieldInterval(children[0]);
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => ivUnion(fields.map(f => f(xIv, yIv, zIv)));
    }
    case 'recolor': {
      // Recolor doesn't affect distance — pass through
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      if (children.length === 1) return evalCSGFieldInterval(children[0]);
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => ivUnion(fields.map(f => f(xIv, yIv, zIv)));
    }
    case 'union': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY_IV;
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => ivUnion(fields.map(f => f(xIv, yIv, zIv)));
    }
    case 'intersect': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY_IV;
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => ivIntersect(fields.map(f => f(xIv, yIv, zIv)));
    }
    case 'anti': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      return (xIv, yIv, zIv) => {
        const r = child(xIv, yIv, zIv);
        return { distance: r.distance, polarity: ineg(r.polarity) };
      };
    }
    case 'complement': {
      const children = nodeChildren(node);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      return (xIv, yIv, zIv) => {
        const r = child(xIv, yIv, zIv);
        const nd = ineg(r.distance);
        const polarity = nd[1] <= 0 ? [1, 1] : nd[0] > 0 ? [0, 0] : [0, 1];
        return { distance: nd, polarity };
      };
    }
    case 'fuse': {
      const p = node[1];
      const k = p.k || 5;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const fields = children.map(c => evalCSGFieldInterval(c));
      return (xIv, yIv, zIv) => {
        const results = fields.map(f => f(xIv, yIv, zIv));
        // Polarity: sum of polarities
        let pLo = 0, pHi = 0;
        for (const r of results) {
          pLo += r.polarity[0];
          pHi += r.polarity[1];
        }
        // Smooth min of distances
        const dists = results.map(r => r.distance);
        const dist = isoftmin(dists, k);
        return { distance: dist, polarity: [Math.sign(pLo), Math.sign(pHi)] };
      };
    }
    case 'mirror': {
      const axis = node[1].axis || 'x';
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      return (xIv, yIv, zIv) => {
        if (axis === 'x') return child(iabs(xIv), yIv, zIv);
        if (axis === 'y') return child(xIv, iabs(yIv), zIv);
        return child(xIv, yIv, iabs(zIv));
      };
    }
    case 'rotate': {
      const axis = node[1].axis || 'y';
      const angleDeg = node[1].angle != null ? node[1].angle : 45;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      // Fixed-angle rotation: apply inverse rotation to query intervals
      const rad = -angleDeg * Math.PI / 180;
      const cosIv = [Math.cos(rad), Math.cos(rad)];
      const sinIv = [Math.sin(rad), Math.sin(rad)];
      return (xIv, yIv, zIv) => {
        let uIv, vIv;
        if (axis === 'y') {
          uIv = isub(imul(cosIv, xIv), imul(sinIv, zIv));
          vIv = iadd(imul(sinIv, xIv), imul(cosIv, zIv));
          return child(uIv, yIv, vIv);
        }
        if (axis === 'x') {
          uIv = isub(imul(cosIv, yIv), imul(sinIv, zIv));
          vIv = iadd(imul(sinIv, yIv), imul(cosIv, zIv));
          return child(xIv, uIv, vIv);
        }
        // axis === 'z'
        uIv = isub(imul(cosIv, xIv), imul(sinIv, yIv));
        vIv = iadd(imul(sinIv, xIv), imul(cosIv, yIv));
        return child(uIv, vIv, zIv);
      };
    }
    case 'twist': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.1;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      // Warp-aware bounding: twist preserves distance from the twist axis.
      // When the angle interval is narrow (<π/2), use standard interval trig.
      // When wide, use the geometric bound: output (u,v) is bounded by [-r, r]
      // where r is the max radius from the axis.
      return (xIv, yIv, zIv) => {
        let alongIv, uIv, vIv;
        if (axis === 'y') { alongIv = yIv; uIv = xIv; vIv = zIv; }
        else if (axis === 'x') { alongIv = xIv; uIv = yIv; vIv = zIv; }
        else { alongIv = zIv; uIv = xIv; vIv = yIv; }
        const angleIv = imul([-rate, -rate], alongIv);
        const angleSpan = angleIv[1] - angleIv[0];

        let ruIv, rvIv;
        if (angleSpan < Math.PI / 2) {
          // Narrow angle — standard interval trig is tight enough
          const cosIv = icos(angleIv);
          const sinIv = isin(angleIv);
          ruIv = isub(imul(cosIv, uIv), imul(sinIv, vIv));
          rvIv = iadd(imul(sinIv, uIv), imul(cosIv, vIv));
        } else {
          // Wide angle — use radius-preserving geometric bound
          const rmax = Math.sqrt(
            Math.max(uIv[0] * uIv[0], uIv[1] * uIv[1]) +
            Math.max(vIv[0] * vIv[0], vIv[1] * vIv[1])
          );
          ruIv = [-rmax, rmax];
          rvIv = [-rmax, rmax];
        }
        if (axis === 'y') return child(ruIv, yIv, rvIv);
        if (axis === 'x') return child(xIv, ruIv, rvIv);
        return child(ruIv, rvIv, zIv);
      };
    }
    case 'radial': {
      // Polar-aware culling: instead of mapping the entire Cartesian cell to
      // full-sector-width output bounds, compute the cell's angular interval
      // via iatan2, fold it into the fundamental sector [0, halfSector], and
      // produce tight output intervals. This lets the child evaluator
      // distinguish "on the object" from "between copies" at the same radius.
      //
      // Falls back to full-sector bounds when the cell straddles the axis
      // (angular interval is [-π, π]) or spans more than one sector.
      const axis = node[1].axis || 'y';
      const count = Math.max(2, Math.round(node[1].count || 6));
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      const sector = 2 * Math.PI / count;
      const halfSector = sector / 2;
      const cosHalf = Math.cos(halfSector);
      const sinHalf = Math.sin(halfSector);
      return (xIv, yIv, zIv) => {
        let uIv, vIv, wIv;
        if (axis === 'y') { uIv = xIv; vIv = zIv; wIv = yIv; }
        else if (axis === 'x') { uIv = yIv; vIv = zIv; wIv = xIv; }
        else { uIv = xIv; vIv = yIv; wIv = zIv; }
        // Compute radius interval [rmin, rmax]
        const rmax = Math.sqrt(
          Math.max(uIv[0] * uIv[0], uIv[1] * uIv[1]) +
          Math.max(vIv[0] * vIv[0], vIv[1] * vIv[1])
        );
        let rmin;
        if (uIv[0] <= 0 && uIv[1] >= 0 && vIv[0] <= 0 && vIv[1] >= 0) {
          rmin = 0;
        } else {
          const cu = Math.max(uIv[0], Math.min(0, uIv[1]));
          const cv = Math.max(vIv[0], Math.min(0, vIv[1]));
          rmin = Math.sqrt(cu * cu + cv * cv);
        }

        // Try polar-aware path: compute angular interval of the box
        const angleIv = iatan2(vIv, uIv);
        const angleSpan = angleIv[1] - angleIv[0];

        // If angle span > sector, the cell spans multiple copies —
        // fall back to full-sector bounds
        if (angleSpan >= sector) {
          const nuIv = [rmin * cosHalf, rmax];
          const nvIv = [0, rmax * sinHalf];
          if (axis === 'y') return child(nuIv, wIv, nvIv);
          if (axis === 'x') return child(wIv, nuIv, nvIv);
          return child(nuIv, nvIv, wIv);
        }

        // Fold the angular interval into the fundamental sector [0, halfSector].
        // The point evaluator does:
        //   1. angle = atan2(v, u), normalize to [0, 2π)
        //   2. angle = angle % sector → [0, sector)
        //   3. if angle > halfSector: angle = sector - angle → mirror into [0, halfSector]
        //
        // For intervals, we fold into pieces and take the UNION of folded
        // angle ranges, then evaluate the child once on the bounding box.
        // (We can't evaluate pieces separately and union distances, because
        // different parts of the Cartesian box map to different pieces —
        // the child must see one interval that covers all possible folded angles.)

        // Normalize to [0, 2π): shift by the smallest multiple of 2π
        // that puts lo >= 0
        const twoPi = 2 * Math.PI;
        const shift = Math.floor(angleIv[0] / twoPi) * twoPi;
        let aLo = angleIv[0] - shift;
        let aHi = angleIv[1] - shift;
        if (aLo < 0) { aLo = 0; }

        // Fold into [0, sector): check if the interval straddles a sector boundary
        const sectorLo = Math.floor(aLo / sector);
        const sectorHi = Math.floor(aHi / sector);

        let foldedIntervals;
        if (sectorLo === sectorHi) {
          foldedIntervals = [foldAngleInterval(aLo - sectorLo * sector, aHi - sectorLo * sector, halfSector)];
        } else if (sectorHi - sectorLo === 1) {
          const boundary = sectorHi * sector;
          foldedIntervals = [
            foldAngleInterval(aLo - sectorLo * sector, sector, halfSector),
            foldAngleInterval(0, aHi - boundary, halfSector)
          ];
        } else {
          foldedIntervals = [[0, halfSector]];
        }

        // Union of folded angle intervals → single bounding interval
        let fLo = foldedIntervals[0][0], fHi = foldedIntervals[0][1];
        for (let i = 1; i < foldedIntervals.length; i++) {
          fLo = Math.min(fLo, foldedIntervals[i][0]);
          fHi = Math.max(fHi, foldedIntervals[i][1]);
        }

        // Convert (r, θ_folded) to Cartesian intervals for child
        // θ_folded ∈ [fLo, fHi] ⊆ [0, halfSector]
        // cos is decreasing on [0, halfSector], sin is increasing
        const cosLo = Math.cos(fHi), cosHi = Math.cos(fLo);
        const sinLo = Math.sin(fLo), sinHi = Math.sin(fHi);
        const nuIv = [rmin * cosLo, rmax * cosHi];
        const nvIv = [rmin * sinLo, rmax * sinHi];

        if (axis === 'y') return child(nuIv, wIv, nvIv);
        if (axis === 'x') return child(wIv, nuIv, nvIv);
        return child(nuIv, nvIv, wIv);
      };
    }
    case 'stretch': {
      const sx = node[1].sx != null ? node[1].sx : 1;
      const sy = node[1].sy != null ? node[1].sy : 1;
      const sz = node[1].sz != null ? node[1].sz : 1;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      const minScale = Math.min(sx, sy, sz);
      return (xIv, yIv, zIv) => {
        const r = child(
          imul(xIv, [1/sx, 1/sx]),
          imul(yIv, [1/sy, 1/sy]),
          imul(zIv, [1/sz, 1/sz])
        );
        return {
          distance: imul(r.distance, [minScale, minScale]),
          polarity: r.polarity
        };
      };
    }
    case 'tile': {
      const axis = node[1].axis || 'x';
      const spacing = node[1].spacing || 30;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      const half = spacing / 2;
      return (xIv, yIv, zIv) => {
        // Tiling wraps coordinates — if the interval spans more than one period,
        // the wrapped interval is the full [-half, half]
        let txIv = xIv, tyIv = yIv, tzIv = zIv;
        if (axis === 'x') {
          txIv = (xIv[1] - xIv[0] >= spacing) ? [-half, half] : wrapInterval(xIv, spacing);
        } else if (axis === 'y') {
          tyIv = (yIv[1] - yIv[0] >= spacing) ? [-half, half] : wrapInterval(yIv, spacing);
        } else {
          tzIv = (zIv[1] - zIv[0] >= spacing) ? [-half, half] : wrapInterval(zIv, spacing);
        }
        return child(txIv, tyIv, tzIv);
      };
    }
    case 'bend': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.05;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      if (rate === 0) return child;
      // Warp-aware bounding: bend rotates each point around a circle of
      // radius R = perp + 1/rate centered at (0, 1/rate). The rotation
      // preserves R. When the angle interval is narrow, standard interval
      // trig is fine. When wide, use the geometric bound.
      const invRate = 1 / rate;
      return (xIv, yIv, zIv) => {
        let alongIv, perpIv, wIv;
        if (axis === 'y') { alongIv = xIv; perpIv = yIv; wIv = zIv; }
        else if (axis === 'x') { alongIv = yIv; perpIv = xIv; wIv = zIv; }
        else { alongIv = xIv; perpIv = zIv; wIv = yIv; }
        const angleIv = imul(alongIv, [rate, rate]);
        const angleSpan = angleIv[1] - angleIv[0];

        let naIv, npIv;
        if (angleSpan < Math.PI / 2) {
          // Narrow angle — standard interval trig
          const cosIv = icos(angleIv);
          const sinIv = isin(angleIv);
          const rIv = iadd(perpIv, [invRate, invRate]);
          naIv = imul(sinIv, rIv);
          npIv = isub(imul(cosIv, rIv), [invRate, invRate]);
        } else {
          // Wide angle — geometric bound using radius preservation
          // R = perp + 1/rate; after rotation, na ∈ [-Rmax, Rmax],
          // np + 1/rate ∈ [-Rmax, Rmax] → np ∈ [-Rmax - 1/rate, Rmax - 1/rate]
          const rIv = iadd(perpIv, [invRate, invRate]);
          const rmax = Math.max(Math.abs(rIv[0]), Math.abs(rIv[1]));
          naIv = [-rmax, rmax];
          npIv = [-rmax - invRate, rmax - invRate];
        }
        if (axis === 'y') return child(naIv, npIv, wIv);
        if (axis === 'x') return child(npIv, naIv, wIv);
        return child(naIv, wIv, npIv);
      };
    }
    case 'taper': {
      const axis = node[1].axis || 'y';
      const rate = node[1].rate != null ? node[1].rate : 0.02;
      const children = node.slice(2);
      if (children.length === 0) return () => EMPTY_IV;
      const child = evalCSGFieldInterval(children[0]);
      return (xIv, yIv, zIv) => {
        let alongIv, uIv, vIv;
        if (axis === 'y') { alongIv = yIv; uIv = xIv; vIv = zIv; }
        else if (axis === 'x') { alongIv = xIv; uIv = yIv; vIv = zIv; }
        else { alongIv = zIv; uIv = xIv; vIv = yIv; }
        // scale = max(0.01, 1 + rate * along)
        const rawScale = iadd([1, 1], imul([rate, rate], alongIv));
        const scaleIv = [Math.max(0.01, rawScale[0]), Math.max(0.01, rawScale[1])];
        const invScaleIv = [1 / scaleIv[1], 1 / scaleIv[0]];
        const suIv = imul(uIv, invScaleIv);
        const svIv = imul(vIv, invScaleIv);
        let result;
        if (axis === 'y') result = child(suIv, yIv, svIv);
        else if (axis === 'x') result = child(xIv, suIv, svIv);
        else result = child(suIv, svIv, zIv);
        return {
          distance: imul(result.distance, scaleIv),
          polarity: result.polarity
        };
      };
    }
    default:
      return () => ({ distance: [0, 0], polarity: [0, 0] });
  }
}

// --- Interval CSG combinators ---

// Union: distance = min of all distances
function ivUnion(results) {
  let dist = results[0].distance;
  let pLo = 0, pHi = 0;
  for (const r of results) {
    dist = imin(dist, r.distance);
    pLo += r.polarity[0];
    pHi += r.polarity[1];
  }
  return { distance: dist, polarity: [Math.sign(pLo), Math.sign(pHi)] };
}

// Intersect: distance = max of all distances
function ivIntersect(results) {
  let dist = results[0].distance;
  let pLo = 1, pHi = 1;
  for (const r of results) {
    dist = imax(dist, r.distance);
    pLo *= r.polarity[0];
    pHi *= r.polarity[1];
  }
  // Sort polarity bounds
  const pMin = Math.min(pLo, pHi);
  const pMax = Math.max(pLo, pHi);
  return { distance: dist, polarity: [pMin, pMax] };
}

// --- Helper ---

// Fold an angle interval [lo, hi] within [0, sector] into [0, halfSector].
// The point evaluator mirrors angles > halfSector: angle = sector - angle.
// For intervals, if the interval straddles the mirror line at halfSector,
// the folded interval covers [0, halfSector] (or close to it).
// Returns [foldedLo, foldedHi] ⊆ [0, halfSector].
function foldAngleInterval(lo, hi, halfSector) {
  // Small epsilon to ensure conservative coverage at boundaries
  const eps = 1e-12;
  // Clamp inputs to valid range with padding
  lo = Math.max(0, lo - eps);
  hi = Math.min(2 * halfSector + eps, hi + eps);

  if (hi <= halfSector) {
    // Entirely in the non-mirrored half [0, halfSector]
    return [Math.max(0, lo), Math.min(halfSector, hi)];
  }
  if (lo >= halfSector) {
    // Entirely in the mirrored half [halfSector, sector]
    // Mirror: angle → sector - angle = 2*halfSector - angle
    // lo maps to 2*halfSector - lo (smaller after mirror)
    // hi maps to 2*halfSector - hi (larger after mirror, since hi > lo → mirror(hi) < mirror(lo))
    const mHi = 2 * halfSector - lo;  // mirror of lo → upper bound
    const mLo = 2 * halfSector - hi;  // mirror of hi → lower bound
    return [Math.max(0, mLo), Math.min(halfSector, mHi)];
  }
  // Straddles the mirror line: lo < halfSector < hi
  // The non-mirrored part covers [lo, halfSector]
  // The mirrored part covers [2*halfSector - hi, halfSector]
  // Union: [min(lo, 2*halfSector - hi), halfSector]
  const mirroredLo = 2 * halfSector - hi;
  return [Math.max(0, Math.min(lo, mirroredLo)), halfSector];
}

// Wrap an interval into [-half, half] for tiling
function wrapInterval(iv, spacing) {
  const half = spacing / 2;
  // If the interval is narrow enough, we can wrap it
  const lo = ((iv[0] % spacing) + spacing + half) % spacing - half;
  const hi = lo + (iv[1] - iv[0]);
  if (hi > half) {
    // Wraps around — return full range
    return [-half, half];
  }
  return [lo, hi];
}
