// Interval arithmetic for octree-based SDF evaluation.
// An interval is [lo, hi] representing all values in that range.
// Every operation produces a conservative (possibly over-wide) output interval
// that is guaranteed to contain the true result for any inputs in the input ranges.
//
// Inspired by Matt Keeter's libfive/Fidget approach:
// evaluate SDFs over spatial regions instead of points,
// classifying whole octants as inside/outside/ambiguous.

// --- Core interval operations ---

export function iadd(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

export function isub(a, b) {
  return [a[0] - b[1], a[1] - b[0]];
}

export function imul(a, b) {
  const p1 = a[0] * b[0], p2 = a[0] * b[1];
  const p3 = a[1] * b[0], p4 = a[1] * b[1];
  return [Math.min(p1, p2, p3, p4), Math.max(p1, p2, p3, p4)];
}

export function idiv(a, b) {
  // If b contains zero, return [-Inf, Inf]
  if (b[0] <= 0 && b[1] >= 0) return [-Infinity, Infinity];
  return imul(a, [1 / b[1], 1 / b[0]]);
}

export function ineg(a) {
  return [-a[1], -a[0]];
}

export function iabs(a) {
  if (a[0] >= 0) return a;
  if (a[1] <= 0) return [-a[1], -a[0]];
  return [0, Math.max(-a[0], a[1])];
}

export function isqrt(a) {
  return [Math.sqrt(Math.max(0, a[0])), Math.sqrt(Math.max(0, a[1]))];
}

export function isq(a) {
  // a*a but tighter than imul(a, a) when interval spans zero
  if (a[0] >= 0) return [a[0] * a[0], a[1] * a[1]];
  if (a[1] <= 0) return [a[1] * a[1], a[0] * a[0]];
  return [0, Math.max(a[0] * a[0], a[1] * a[1])];
}

export function imin(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
}

export function imax(a, b) {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// max(a, 0) — clamp below at zero
export function imax0(a) {
  return [Math.max(a[0], 0), Math.max(a[1], 0)];
}

// min(a, 0) — clamp above at zero
export function imin0(a) {
  return [Math.min(a[0], 0), Math.min(a[1], 0)];
}

// max(a, b, c) for three intervals
export function imax3(a, b, c) {
  return imax(imax(a, b), c);
}

// Interval cosine — conservative bound
export function icos(a) {
  const lo = a[0], hi = a[1];
  const span = hi - lo;
  if (span >= 2 * Math.PI) return [-1, 1];
  // Normalize to [0, 2pi]
  const nlo = ((lo % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const nhi = nlo + (hi - lo);
  const clo = Math.cos(nlo), chi = Math.cos(nhi);
  let rlo = Math.min(clo, chi), rhi = Math.max(clo, chi);
  // Check if a maximum (cos=1 at 0, 2pi, ...) falls in range
  // Maximum at k*2*pi
  const kStart = Math.ceil(nlo / (2 * Math.PI));
  if (kStart * 2 * Math.PI <= nhi) rhi = 1;
  // Minimum at pi + k*2*pi
  const kMinStart = Math.ceil((nlo - Math.PI) / (2 * Math.PI));
  if (kMinStart * 2 * Math.PI + Math.PI <= nhi) rlo = -1;
  return [rlo, rhi];
}

// Interval sine
export function isin(a) {
  // sin(x) = cos(x - pi/2)
  return icos([a[0] - Math.PI / 2, a[1] - Math.PI / 2]);
}

// Interval atan2(y, x) — conservative bound
export function iatan2(y, x) {
  // If x interval contains 0 and y interval contains 0, full range
  if (x[0] <= 0 && x[1] >= 0 && y[0] <= 0 && y[1] >= 0) {
    return [-Math.PI, Math.PI];
  }
  // Conservative: sample corners and add margin
  const a1 = Math.atan2(y[0], x[0]);
  const a2 = Math.atan2(y[0], x[1]);
  const a3 = Math.atan2(y[1], x[0]);
  const a4 = Math.atan2(y[1], x[1]);
  let lo = Math.min(a1, a2, a3, a4);
  let hi = Math.max(a1, a2, a3, a4);
  // If the interval crosses the -pi/pi boundary, return full range
  if (x[0] < 0 && y[0] < 0 && y[1] > 0) {
    return [-Math.PI, Math.PI];
  }
  return [lo, hi];
}

// Interval modulo: a % b (b is a scalar > 0)
export function imod(a, b) {
  const span = a[1] - a[0];
  if (span >= b) return [0, b]; // wide interval wraps fully
  const lo = ((a[0] % b) + b) % b;
  const hi = lo + span;
  if (hi > b) return [0, b]; // wraps
  return [lo, hi];
}

// Interval for smooth min (log-sum-exp softmin)
// Conservative: result is between min of all lows and min of all lows + k*ln(n)
export function isoftmin(intervals, k) {
  let lo = Infinity, hi = Infinity;
  for (const iv of intervals) {
    lo = Math.min(lo, iv[0]);
    hi = Math.min(hi, iv[1]);
  }
  // softmin is always <= min, and >= min - k*ln(n)
  return [lo - k * Math.log(intervals.length), hi];
}

// --- Classification ---

// Returns 'inside' if interval is entirely negative (surface is outside this region)
// Returns 'outside' if interval is entirely positive
// Returns 'ambiguous' if interval spans zero
export function classify(interval) {
  if (interval[1] < 0) return 'inside';
  if (interval[0] > 0) return 'outside';
  return 'ambiguous';
}
