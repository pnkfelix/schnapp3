// Tests for the GPU tape compiler and CPU-side tape interpreter.
// Verifies that compileTape + evaluateTapeAt produces the same
// results as the reference evalCSGField from csg-field.js.

import { suite, test, assert, assertClose } from './run.js';
import { compileTape, disassembleTape } from '../src/gpu-tape.js';
import { evaluateTapeAt } from '../src/gpu-tape-eval.js';
import { evalCSGField } from '../src/csg-field.js';

// Helper: compare tape eval vs reference at a set of sample points
function compareAtPoints(ast, points, tol = 1e-4, label = '') {
  const compiled = compileTape(ast);
  assert(compiled !== null, `${label}: tape compilation failed`);
  const { tape } = compiled;
  const ref = evalCSGField(ast);

  for (const [x, y, z] of points) {
    const tapeResult = evaluateTapeAt(tape, x, y, z);
    const refResult = ref(x, y, z);

    assertClose(tapeResult.distance, refResult.distance, tol,
      `${label} @ (${x},${y},${z}): distance mismatch: tape=${tapeResult.distance} ref=${refResult.distance}`);
    assert(tapeResult.polarity === (refResult.polarity > 0 ? 1 : refResult.polarity < 0 ? -1 : 0),
      `${label} @ (${x},${y},${z}): polarity mismatch: tape=${tapeResult.polarity} ref=${refResult.polarity}`);
  }
}

// Standard test points covering inside, outside, surface, corners
const STANDARD_POINTS = [
  [0, 0, 0],       // origin
  [5, 0, 0],       // along x
  [0, 5, 0],       // along y
  [0, 0, 5],       // along z
  [10, 10, 10],    // corner direction
  [-5, -5, -5],    // negative corner
  [20, 0, 0],      // far outside
  [0.5, 0.5, 0.5], // near origin
  [15, 15, 15],    // far
  [-10, 5, -3],    // random negative
];

// ---- Primitives ----

suite('gpu-tape: sphere');

test('sphere r=15 — basic SDF', () => {
  const ast = ['sphere', { radius: 15 }];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'sphere(15)');
});

test('sphere r=8 — different radius', () => {
  const ast = ['sphere', { radius: 8 }];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'sphere(8)');
});

test('sphere — origin is inside', () => {
  const ast = ['sphere', { radius: 10 }];
  const compiled = compileTape(ast);
  const result = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(result.distance, -10, 1e-5, 'sphere distance at origin');
  assert(result.polarity === 1, 'sphere polarity at origin should be 1 (inside)');
});

test('sphere — far point is outside', () => {
  const ast = ['sphere', { radius: 10 }];
  const compiled = compileTape(ast);
  const result = evaluateTapeAt(compiled.tape, 20, 0, 0);
  assertClose(result.distance, 10, 1e-5, 'sphere distance at (20,0,0)');
  assert(result.polarity === 0, 'sphere polarity at (20,0,0) should be 0 (outside)');
});

suite('gpu-tape: cube');

test('cube size=20 — basic SDF', () => {
  const ast = ['cube', { size: 20 }];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'cube(20)');
});

test('cube — origin is inside', () => {
  const ast = ['cube', { size: 20 }];
  const compiled = compileTape(ast);
  const result = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(result.distance, -10, 1e-5);
  assert(result.polarity === 1);
});

test('cube — corner distance is exact', () => {
  // Point at (15, 0, 0) from cube half-extent 10: should be distance 5
  const ast = ['cube', { size: 20 }];
  const compiled = compileTape(ast);
  const result = evaluateTapeAt(compiled.tape, 15, 0, 0);
  assertClose(result.distance, 5, 1e-5);
});

suite('gpu-tape: cylinder');

test('cylinder r=10 h=30 — basic SDF', () => {
  const ast = ['cylinder', { radius: 10, height: 30 }];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'cylinder(10,30)');
});

test('cylinder — axis-aligned point', () => {
  const ast = ['cylinder', { radius: 10, height: 30 }];
  const compiled = compileTape(ast);
  const result = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(result.distance, -10, 1e-5);
  assert(result.polarity === 1);
});

// ---- Transforms ----

suite('gpu-tape: translate');

test('translate shifts field correctly', () => {
  const ast = ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]];
  const compiled = compileTape(ast);
  // At (10,0,0) we should be at center of sphere
  const r1 = evaluateTapeAt(compiled.tape, 10, 0, 0);
  assertClose(r1.distance, -5, 1e-5, 'at center of translated sphere');
  assert(r1.polarity === 1);
  // At (0,0,0) we should be 5 units outside
  const r2 = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(r2.distance, 5, 1e-5, 'at origin, outside translated sphere');
  assert(r2.polarity === 0);
});

test('translate matches reference', () => {
  const ast = ['translate', { x: 5, y: -3, z: 7 }, ['cube', { size: 10 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'translate cube');
});

suite('gpu-tape: mirror');

test('mirror x — symmetric field', () => {
  const ast = ['mirror', { axis: 'x' }, ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'mirror x');
});

test('mirror — negative x maps to positive', () => {
  const ast = ['mirror', { axis: 'x' }, ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]]];
  const compiled = compileTape(ast);
  const r1 = evaluateTapeAt(compiled.tape, 10, 0, 0);
  const r2 = evaluateTapeAt(compiled.tape, -10, 0, 0);
  assertClose(r1.distance, r2.distance, 1e-5, 'mirror should give same distance');
  assert(r1.polarity === r2.polarity, 'mirror should give same polarity');
});

suite('gpu-tape: rotate');

test('rotate matches reference', () => {
  const ast = ['rotate', { axis: 'y', angle: 45 }, ['cube', { size: 20 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'rotate y 45');
});

test('rotate 90 degrees maps x to z', () => {
  const ast = ['rotate', { axis: 'y', angle: 90 }, ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 3 }]]];
  const compiled = compileTape(ast);
  // After 90° rotation around Y, (0,0,10) should be at the sphere center
  const r = evaluateTapeAt(compiled.tape, 0, 0, 10);
  assertClose(r.distance, -3, 0.1, 'rotated sphere center');
});

suite('gpu-tape: twist');

test('twist matches reference', () => {
  const ast = ['twist', { axis: 'y', rate: 0.1 }, ['cube', { size: 20 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'twist y 0.1');
});

suite('gpu-tape: radial');

test('radial matches reference', () => {
  const ast = ['radial', { axis: 'y', count: 6 }, ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 3 }]]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'radial y 6');
});

suite('gpu-tape: stretch');

test('stretch matches reference', () => {
  const ast = ['stretch', { sx: 2, sy: 0.5, sz: 1 }, ['sphere', { radius: 10 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'stretch');
});

suite('gpu-tape: tile');

test('tile matches reference', () => {
  const ast = ['tile', { axis: 'x', spacing: 20 }, ['sphere', { radius: 5 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'tile x 20');
});

suite('gpu-tape: bend');

test('bend matches reference', () => {
  const ast = ['bend', { axis: 'y', rate: 0.05 }, ['cube', { size: 20 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'bend y 0.05');
});

suite('gpu-tape: taper');

test('taper matches reference', () => {
  const ast = ['taper', { axis: 'y', rate: 0.03 }, ['cylinder', { radius: 10, height: 30 }]];
  // Note: taper has approximate distance scaling; use wider tolerance
  compareAtPoints(ast, STANDARD_POINTS, 0.5, 'taper y 0.03');
});

// ---- CSG operations ----

suite('gpu-tape: union');

test('union of two spheres', () => {
  const ast = ['union',
    ['translate', { x: -8, y: 0, z: 0 }, ['sphere', { radius: 10 }]],
    ['translate', { x: 8, y: 0, z: 0 }, ['sphere', { radius: 10 }]]
  ];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'union 2 spheres');
});

suite('gpu-tape: intersect');

test('intersect cube and sphere', () => {
  const ast = ['intersect',
    ['cube', { size: 25 }],
    ['sphere', { radius: 18 }]
  ];
  compareAtPoints(ast, STANDARD_POINTS, 1e-4, 'intersect cube sphere');
});

test('intersect — point inside both is inside result', () => {
  const ast = ['intersect',
    ['cube', { size: 20 }],
    ['sphere', { radius: 15 }]
  ];
  const compiled = compileTape(ast);
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assert(r.polarity === 1, 'origin should be inside intersection');
  assert(r.distance < 0, 'distance at origin should be negative');
});

test('intersect — point inside one but outside other is outside result', () => {
  const ast = ['intersect',
    ['cube', { size: 20 }],
    ['sphere', { radius: 8 }]
  ];
  const compiled = compileTape(ast);
  // (9,0,0) is inside cube (half-extent 10) but outside sphere (radius 8)
  const r = evaluateTapeAt(compiled.tape, 9, 0, 0);
  assert(r.polarity === 0, 'should be outside intersection');
});

suite('gpu-tape: anti');

test('anti flips polarity', () => {
  const ast = ['anti', ['sphere', { radius: 10 }]];
  const compiled = compileTape(ast);
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assert(r.polarity === -1, 'anti should give negative polarity at origin');
  assertClose(r.distance, -10, 1e-5, 'distance should be preserved');
});

test('anti matches reference', () => {
  const ast = ['anti', ['cube', { size: 20 }]];
  compareAtPoints(ast, STANDARD_POINTS, 1e-5, 'anti cube');
});

suite('gpu-tape: complement');

test('complement flips distance sign', () => {
  const ast = ['complement', ['sphere', { radius: 10 }]];
  const compiled = compileTape(ast);
  const ref = evalCSGField(ast);
  for (const [x, y, z] of [[0,0,0], [15,0,0], [5,5,5]]) {
    const tapeR = evaluateTapeAt(compiled.tape, x, y, z);
    const refR = ref(x, y, z);
    assertClose(tapeR.distance, refR.distance, 1e-5,
      `complement @ (${x},${y},${z})`);
  }
});

suite('gpu-tape: fuse');

test('fuse smooth union', () => {
  const ast = ['fuse', { k: 5 },
    ['translate', { x: -5, y: 0, z: 0 }, ['sphere', { radius: 8 }]],
    ['translate', { x: 5, y: 0, z: 0 }, ['sphere', { radius: 8 }]]
  ];
  compareAtPoints(ast, STANDARD_POINTS, 1e-3, 'fuse k=5');
});

test('fuse at boundary produces smooth min', () => {
  const ast = ['fuse', { k: 5 },
    ['sphere', { radius: 10 }],
    ['translate', { x: 15, y: 0, z: 0 }, ['sphere', { radius: 10 }]]
  ];
  const compiled = compileTape(ast);
  const ref = evalCSGField(ast);
  // Test along the x-axis where both spheres contribute
  for (let x = 0; x <= 15; x += 1) {
    const tapeR = evaluateTapeAt(compiled.tape, x, 0, 0);
    const refR = ref(x, 0, 0);
    assertClose(tapeR.distance, refR.distance, 1e-3,
      `fuse blend @ x=${x}`);
  }
});

// ---- Paint ----

suite('gpu-tape: paint');

test('paint sets color', () => {
  const ast = ['paint', { color: 'red' }, ['sphere', { radius: 10 }]];
  const compiled = compileTape(ast);
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  // red = 0xff4444 = (1.0, 0.267, 0.267)
  assertClose(r.color[0], 1.0, 0.01, 'red R');
  assertClose(r.color[1], 0.267, 0.01, 'red G');
  assertClose(r.color[2], 0.267, 0.01, 'red B');
});

test('unpainted uses default gray', () => {
  const ast = ['sphere', { radius: 10 }];
  const compiled = compileTape(ast);
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(r.color[0], 0.667, 0.01, 'default gray R');
  assertClose(r.color[1], 0.667, 0.01, 'default gray G');
  assertClose(r.color[2], 0.667, 0.01, 'default gray B');
});

// ---- Complex models ----

suite('gpu-tape: complex models');

test('CSG default model (intersect + anti + fuse)', () => {
  const ast = ['union',
    ['intersect', ['cube', { size: 25 }], ['sphere', { radius: 18 }]],
    ['translate', { x: 40, y: 0, z: 0 },
      ['union', ['cube', { size: 20 }], ['anti', ['sphere', { radius: 12 }]]]],
    ['translate', { x: -40, y: 0, z: 0 },
      ['fuse', { k: 5 }, ['cube', { size: 20 }], ['anti', ['sphere', { radius: 12 }]]]]
  ];
  compareAtPoints(ast, [
    [0, 0, 0], [5, 5, 5], [-5, -5, -5],
    [40, 0, 0], [40, 5, 5],
    [-40, 0, 0], [-40, 5, 5],
    [12, 12, 12], [-12, -12, -12],
  ], 1e-3, 'csg model');
});

test('lizard model (paint + fuse + intersect + anti)', () => {
  const ast = ['union',
    ['paint', { color: 'orange' },
      ['union',
        ['translate', { x: 5, y: 15, z: 5 }, ['sphere', { radius: 5 }]],
        ['translate', { x: 5, y: 15, z: -5 }, ['sphere', { radius: 5 }]]]],
    ['intersect',
      ['union',
        ['paint', { color: 'green' },
          ['fuse', { k: 5 },
            ['translate', { x: 18, y: 0, z: 0 }, ['cube', { size: 10 }]],
            ['sphere', { radius: 15 }]]],
        ['anti', ['cylinder', { radius: 8, height: 30 }]]]]
  ];
  compareAtPoints(ast, [
    [0, 0, 0], [5, 15, 5], [5, 15, -5],
    [10, 0, 0], [18, 0, 0],
    [0, 10, 0], [0, -10, 0],
  ], 1e-3, 'lizard model');
});

// ---- Tape structure tests ----

suite('gpu-tape: tape structure');

test('tape is compilable for all primitive types', () => {
  const prims = [
    ['sphere', { radius: 10 }],
    ['cube', { size: 20 }],
    ['cylinder', { radius: 5, height: 20 }],
  ];
  for (const ast of prims) {
    const compiled = compileTape(ast);
    assert(compiled !== null, `${ast[0]} should compile`);
    assert(compiled.tape.length > 0, `${ast[0]} tape should not be empty`);
  }
});

test('tape disassembly is readable', () => {
  const ast = ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]];
  const compiled = compileTape(ast);
  const dis = disassembleTape(compiled.tape);
  assert(dis.includes('TRANSLATE'), 'disassembly should show TRANSLATE');
  assert(dis.includes('SPHERE'), 'disassembly should show SPHERE');
  assert(dis.includes('POP_TRANSFORM'), 'disassembly should show POP_TRANSFORM');
});

test('empty children produce empty tape', () => {
  const ast = ['translate', { x: 5, y: 0, z: 0 }];
  const compiled = compileTape(ast);
  assert(compiled.tape.length === 0, 'empty translate should produce empty tape');
});

// ---- Mathematical accuracy ----

suite('gpu-tape: mathematical accuracy');

test('sphere SDF is exact Euclidean distance minus radius', () => {
  const ast = ['sphere', { radius: 10 }];
  const compiled = compileTape(ast);
  // Test at specific distances
  const testPoints = [
    { pt: [10, 0, 0], expected: 0 },    // on surface
    { pt: [0, 0, 0], expected: -10 },   // at center
    { pt: [20, 0, 0], expected: 10 },   // 10 units outside
    { pt: [3, 4, 0], expected: -5 },    // 5 units from center, inside (r=10)
  ];
  for (const { pt, expected } of testPoints) {
    const r = evaluateTapeAt(compiled.tape, ...pt);
    assertClose(r.distance, expected, 1e-5,
      `sphere SDF at (${pt}): expected ${expected}, got ${r.distance}`);
  }
});

test('cube SDF is exact for axis-aligned points', () => {
  const ast = ['cube', { size: 20 }]; // half-extent = 10
  const compiled = compileTape(ast);
  const testPoints = [
    { pt: [0, 0, 0], expected: -10 },   // center
    { pt: [10, 0, 0], expected: 0 },    // face
    { pt: [15, 0, 0], expected: 5 },    // 5 outside face
    { pt: [5, 0, 0], expected: -5 },    // 5 inside face
  ];
  for (const { pt, expected } of testPoints) {
    const r = evaluateTapeAt(compiled.tape, ...pt);
    assertClose(r.distance, expected, 1e-5,
      `cube SDF at (${pt}): expected ${expected}, got ${r.distance}`);
  }
});

test('union picks minimum distance', () => {
  const ast = ['union',
    ['sphere', { radius: 5 }],
    ['translate', { x: 20, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  const compiled = compileTape(ast);
  // At origin: first sphere distance = -5, second = 15 → min = -5
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(r.distance, -5, 1e-5, 'union should pick min distance');
});

test('intersect picks maximum distance', () => {
  const ast = ['intersect',
    ['cube', { size: 30 }],  // half=15
    ['sphere', { radius: 10 }]
  ];
  const compiled = compileTape(ast);
  // At origin: cube dist = -15, sphere dist = -10 → max = -10
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assertClose(r.distance, -10, 1e-5, 'intersect should pick max distance');
});

test('fuse smooth-min is between min and min-k*ln(n)', () => {
  const k = 5;
  const ast = ['fuse', { k },
    ['sphere', { radius: 10 }],
    ['translate', { x: 15, y: 0, z: 0 }, ['sphere', { radius: 10 }]]
  ];
  const compiled = compileTape(ast);
  // At origin: sphere1 = -10, sphere2 = 5 → hard min = -10
  // softmin should be <= -10 and >= -10 - k*ln(2)
  const r = evaluateTapeAt(compiled.tape, 0, 0, 0);
  assert(r.distance <= -10 + 0.01, `fuse should be <= min: got ${r.distance}`);
  assert(r.distance >= -10 - k * Math.log(2) - 0.01,
    `fuse should be >= min - k*ln(n): got ${r.distance}`);
});
