// Tests for octree culling correctness at solid/anti-solid boundaries.
//
// The bug: when a solid and anti-solid overlap (polarity cancels to 0),
// the solidField has a zero-crossing (surface) at the boundary. But the
// raw distance interval from the CSG union can be entirely negative (deep
// inside the solid), causing the octree to classify the cell as "inside"
// and cull it — missing the surface entirely.
//
// The fix: solidIntervalField detects polarity-straddling regions and
// forces the distance interval to span zero, ensuring the octree subdivides
// rather than culls.

import { suite, test, assert, assertContains } from './run.js';
import { evalCSGField } from '../src/csg-field.js';
import { evalCSGFieldInterval } from '../src/interval-eval.js';
import { classify } from '../src/interval.js';

// --- Helper: build solidField and solidIntervalField the same way evaluator.js does ---

function makeSolidField(csgField) {
  return (x, y, z) => {
    const { polarity, distance } = csgField(x, y, z);
    if (polarity > 0) return distance;
    return Math.abs(distance) + 0.01;
  };
}

// This mirrors the FIXED solidIntervalField from evaluator.js
function makeSolidIntervalField(intervalField) {
  return (xIv, yIv, zIv) => {
    const r = intervalField(xIv, yIv, zIv);
    if (r.polarity[1] <= 0) {
      return { distance: [0.01, Infinity], polarity: [0, 0] };
    }
    if (r.polarity[0] > 0) {
      return r;
    }
    // Polarity straddles — force ambiguous
    return {
      distance: [Math.min(r.distance[0], -0.01), Math.max(r.distance[1], 0.01)],
      polarity: r.polarity
    };
  };
}

// The BUGGY version (for comparison in tests)
function makeSolidIntervalFieldBuggy(intervalField) {
  return (xIv, yIv, zIv) => {
    const r = intervalField(xIv, yIv, zIv);
    if (r.polarity[1] <= 0) {
      return { distance: [0.01, Infinity], polarity: [0, 0] };
    }
    return r;  // Bug: doesn't account for polarity boundary
  };
}

// --- Test cases ---

suite('octree culling at solid/anti boundaries');

// union(cube(23), translate(25, 0, 0, anti(sphere(15))))
// The sphere at x=25 barely overlaps the cube (cube extends to x=11.5,
// sphere extends from x=10 to x=40). At a point like (11, 0, 0) we're
// inside the cube (polarity +1) but outside the sphere (polarity 0).
// At (11, 0, 0) the solidField should be negative (inside solid).
// At (11.5, 0, 0) right at the cube face but inside the sphere overlap
// zone, the solidField should transition through zero.

const cubeAntiSphere = ['union',
  ['cube', { size: 23 }],
  ['translate', { x: 25, y: 0, z: 0 },
    ['anti',
      ['sphere', { radius: 15 }]]]
];

test('solidField has zero-crossing at sphere scoop boundary', () => {
  const csgField = evalCSGField(cubeAntiSphere);
  const solidField = makeSolidField(csgField);

  // Well inside cube, outside sphere: should be negative (inside solid)
  const v1 = solidField(0, 0, 0);
  assert(v1 < 0, `expected negative inside cube, got ${v1}`);

  // Inside cube AND inside anti-sphere overlap: polarity cancels to 0
  // Sphere center is at x=25, radius 15, so sphere surface at x=10.
  // Point at (10.5, 0, 0) is just inside the sphere and inside the cube.
  const v2 = solidField(10.5, 0, 0);
  assert(v2 > 0, `expected positive in cancelled zone, got ${v2}`);

  // There must be a zero-crossing between x=0 and x=10.5
  // (solidField goes from negative to positive)
  assert(v1 < 0 && v2 > 0, 'zero-crossing exists between solid interior and cancelled zone');
});

test('interval field polarity straddles at boundary region', () => {
  const intervalField = evalCSGFieldInterval(cubeAntiSphere);

  // An interval box that spans the sphere boundary inside the cube:
  // x from 9 to 11 (sphere surface at x=10), y and z near 0
  const r = intervalField([9, 11], [-1, 1], [-1, 1]);

  // Polarity should straddle: some points have polarity +1 (solid),
  // others have polarity 0 (cancelled)
  assert(r.polarity[0] <= 0, `expected polarity low <= 0, got ${r.polarity[0]}`);
  assert(r.polarity[1] >= 1, `expected polarity high >= 1, got ${r.polarity[1]}`);
});

test('BUGGY solidIntervalField wrongly classifies boundary as inside', () => {
  const intervalField = evalCSGFieldInterval(cubeAntiSphere);
  const buggyField = makeSolidIntervalFieldBuggy(intervalField);

  // Same boundary-spanning region
  const r = buggyField([9, 11], [-1, 1], [-1, 1]);

  // The raw distance interval is deeply negative (inside the cube's SDF)
  // so classify sees it as "inside" and would cull it
  const cls = classify(r.distance);

  // This demonstrates the bug: the octree would cull a cell that
  // actually contains a surface
  assert(cls === 'inside',
    `expected buggy field to classify as 'inside' (demonstrating bug), got '${cls}'`);
});

test('FIXED solidIntervalField correctly classifies boundary as ambiguous', () => {
  const intervalField = evalCSGFieldInterval(cubeAntiSphere);
  const fixedField = makeSolidIntervalField(intervalField);

  // Same boundary-spanning region
  const r = fixedField([9, 11], [-1, 1], [-1, 1]);

  // The fixed version should force the distance to span zero
  const cls = classify(r.distance);
  assert(cls === 'ambiguous',
    `expected fixed field to classify as 'ambiguous', got '${cls}'`);
});

test('purely-solid regions still classified as inside (not over-conservative)', () => {
  const intervalField = evalCSGFieldInterval(cubeAntiSphere);
  const fixedField = makeSolidIntervalField(intervalField);

  // A region deep inside the cube, far from any anti-solid
  const r = fixedField([-5, -3], [-1, 1], [-1, 1]);

  // Polarity should be entirely +1 (solid), distance entirely negative
  const cls = classify(r.distance);
  assert(cls === 'inside',
    `expected deep-interior region to classify as 'inside', got '${cls}'`);
});

test('purely-outside regions still classified as outside', () => {
  const intervalField = evalCSGFieldInterval(cubeAntiSphere);
  const fixedField = makeSolidIntervalField(intervalField);

  // A region far outside everything
  const r = fixedField([50, 55], [50, 55], [50, 55]);
  const cls = classify(r.distance);
  assert(cls === 'outside',
    `expected far-away region to classify as 'outside', got '${cls}'`);
});
