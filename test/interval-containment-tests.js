// Property tests: for every node type, verify that the interval evaluator's
// output contains the point evaluator's output. This is the fundamental
// soundness property of the interval arithmetic — if it breaks, octree
// culling becomes incorrect.
//
// For each AST node, we:
//   1. Build a point evaluator (from csg-field.js)
//   2. Build an interval evaluator (from interval-eval.js)
//   3. Sample random points in a bounding box
//   4. Evaluate both at each point (interval eval uses tiny [x, x+ε] intervals)
//   5. Assert that the interval result contains the point result

import { suite, test, assert, assertContains } from './run.js';
import { evalCSGField } from '../src/csg-field.js';
import { evalCSGFieldInterval } from '../src/interval-eval.js';

// Seeded PRNG for reproducibility (simple LCG)
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Test the containment property for a given AST node
function testContainment(node, bounds, nSamples = 200) {
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(42);

  const eps = 1e-6; // tiny interval width

  for (let i = 0; i < nSamples; i++) {
    const x = bounds.min[0] + rng() * (bounds.max[0] - bounds.min[0]);
    const y = bounds.min[1] + rng() * (bounds.max[1] - bounds.min[1]);
    const z = bounds.min[2] + rng() * (bounds.max[2] - bounds.min[2]);

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + eps], [y, y + eps], [z, z + eps]);

    // Distance containment: point distance must be within interval distance
    assertContains(
      ivResult.distance,
      pointResult.distance,
      `distance at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}): ` +
      `point=${pointResult.distance.toFixed(6)}, interval=[${ivResult.distance[0].toFixed(6)}, ${ivResult.distance[1].toFixed(6)}]`
    );
  }
}

// Standard bounding box for most tests
const STD_BOUNDS = { min: [-25, -25, -25], max: [25, 25, 25] };
const WIDE_BOUNDS = { min: [-40, -40, -40], max: [40, 40, 40] };

// --- Primitives ---

suite('containment: primitives');

test('sphere', () => {
  testContainment(['sphere', { radius: 15 }], STD_BOUNDS);
});

test('sphere (small)', () => {
  testContainment(['sphere', { radius: 5 }], STD_BOUNDS);
});

test('cube', () => {
  testContainment(['cube', { size: 20 }], STD_BOUNDS);
});

test('cube (large)', () => {
  testContainment(['cube', { size: 40 }], WIDE_BOUNDS);
});

test('cylinder', () => {
  testContainment(['cylinder', { radius: 10, height: 30 }], STD_BOUNDS);
});

// --- Transforms ---

suite('containment: translate');

test('translated sphere', () => {
  testContainment(
    ['translate', { x: 10, y: 5, z: -3 }, ['sphere', { radius: 8 }]],
    WIDE_BOUNDS
  );
});

test('translated cube', () => {
  testContainment(
    ['translate', { x: -5, y: 0, z: 10 }, ['cube', { size: 15 }]],
    WIDE_BOUNDS
  );
});

// --- Paint/Recolor (should not affect distance) ---

suite('containment: paint/recolor');

test('painted sphere', () => {
  testContainment(
    ['paint', { color: 'red' }, ['sphere', { radius: 12 }]],
    STD_BOUNDS
  );
});

test('recolored cube', () => {
  testContainment(
    ['recolor', { from: 'gray', to: 'blue' }, ['cube', { size: 20 }]],
    STD_BOUNDS
  );
});

// --- CSG operations ---

suite('containment: CSG operations');

test('union of sphere and cube', () => {
  testContainment(
    ['union',
      ['sphere', { radius: 10 }],
      ['translate', { x: 15, y: 0, z: 0 }, ['cube', { size: 10 }]]
    ],
    WIDE_BOUNDS
  );
});

test('intersect of sphere and cube', () => {
  testContainment(
    ['intersect',
      ['sphere', { radius: 15 }],
      ['cube', { size: 20 }]
    ],
    STD_BOUNDS
  );
});

test('anti', () => {
  testContainment(
    ['anti', ['sphere', { radius: 10 }]],
    STD_BOUNDS
  );
});

test('complement', () => {
  testContainment(
    ['complement', ['cube', { size: 20 }]],
    STD_BOUNDS
  );
});

test('fuse', () => {
  testContainment(
    ['fuse', { k: 5 },
      ['sphere', { radius: 12 }],
      ['translate', { x: 15, y: 0, z: 0 }, ['cube', { size: 10 }]]
    ],
    WIDE_BOUNDS
  );
});

// --- Mirror ---

suite('containment: mirror');

test('mirror x', () => {
  testContainment(
    ['mirror', { axis: 'x' },
      ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
    ],
    STD_BOUNDS
  );
});

test('mirror y', () => {
  testContainment(
    ['mirror', { axis: 'y' },
      ['translate', { x: 0, y: 8, z: 0 }, ['cube', { size: 10 }]]
    ],
    STD_BOUNDS
  );
});

// --- Stretch ---

suite('containment: stretch');

test('stretch sphere', () => {
  testContainment(
    ['stretch', { sx: 2, sy: 0.5, sz: 1 }, ['sphere', { radius: 10 }]],
    WIDE_BOUNDS
  );
});

// --- Taper ---

suite('containment: taper');

test('taper cylinder', () => {
  testContainment(
    ['taper', { axis: 'y', rate: 0.03 },
      ['cylinder', { radius: 10, height: 40 }]
    ],
    WIDE_BOUNDS
  );
});

// --- Tile ---

suite('containment: tile');

test('tile cube along x', () => {
  testContainment(
    ['tile', { axis: 'x', spacing: 30 }, ['cube', { size: 10 }]],
    WIDE_BOUNDS
  );
});

// --- Twist ---

suite('containment: twist');

test('twist cube along y', () => {
  testContainment(
    ['twist', { axis: 'y', rate: 0.15 }, ['cube', { size: 20 }]],
    WIDE_BOUNDS
  );
});

test('twist with slow rate', () => {
  testContainment(
    ['twist', { axis: 'y', rate: 0.02 }, ['cube', { size: 20 }]],
    WIDE_BOUNDS
  );
});

// --- Radial ---

suite('containment: radial');

test('radial 6-way', () => {
  testContainment(
    ['radial', { axis: 'y', count: 6 },
      ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
    ],
    WIDE_BOUNDS
  );
});

test('radial 3-way', () => {
  testContainment(
    ['radial', { axis: 'y', count: 3 },
      ['translate', { x: 10, y: 0, z: 0 }, ['cube', { size: 6 }]]
    ],
    WIDE_BOUNDS
  );
});

// --- Bend ---

suite('containment: bend');

test('bend cube along y', () => {
  testContainment(
    ['bend', { axis: 'y', rate: 0.04 },
      ['cube', { size: 25 }]
    ],
    WIDE_BOUNDS
  );
});

test('bend with slow rate', () => {
  testContainment(
    ['bend', { axis: 'y', rate: 0.01 },
      ['cube', { size: 20 }]
    ],
    WIDE_BOUNDS
  );
});

// --- Composite models (from the default set) ---

suite('containment: composite models');

test('lizard model', () => {
  testContainment(
    ['union',
      ['paint', { color: 'orange' },
        ['union',
          ['translate', { x: 5, y: 15, z: 5 }, ['sphere', { radius: 5 }]],
          ['translate', { x: 5, y: 15, z: -5 }, ['sphere', { radius: 5 }]]
        ]
      ],
      ['intersect',
        ['union',
          ['paint', { color: 'green' },
            ['fuse', { k: 5 },
              ['translate', { x: 18, y: 0, z: 0 }, ['cube', { size: 10 }]],
              ['sphere', { radius: 15 }]
            ]
          ],
          ['anti', ['cylinder', { radius: 8, height: 30 }]]
        ]
      ]
    ],
    { min: [-30, -30, -30], max: [40, 30, 30] },
    500
  );
});

test('warps model', () => {
  testContainment(
    ['union',
      ['mirror', { axis: 'x' },
        ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 8 }]]
      ],
      ['translate', { x: 40, y: 0, z: 0 },
        ['twist', { axis: 'y', rate: 0.15 }, ['cube', { size: 20 }]]
      ],
      ['translate', { x: -40, y: 0, z: 0 },
        ['radial', { axis: 'y', count: 6 },
          ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
        ]
      ],
      ['translate', { x: 0, y: 30, z: 0 },
        ['stretch', { sx: 2, sy: 0.5, sz: 1 }, ['sphere', { radius: 12 }]]
      ],
      ['translate', { x: 0, y: -30, z: 0 },
        ['bend', { axis: 'y', rate: 0.04 },
          ['paint', { color: 'green' }, ['cube', { size: 25 }]]
        ]
      ],
      ['translate', { x: 0, y: 0, z: 40 },
        ['taper', { axis: 'y', rate: 0.03 },
          ['paint', { color: 'orange' }, ['cylinder', { radius: 10, height: 40 }]]
        ]
      ]
    ],
    { min: [-60, -60, -60], max: [70, 60, 60] },
    1000
  );
});

// --- Wider interval tests ---
// Test with larger intervals (not just tiny epsilon) to ensure intervals
// are truly conservative even when spanning larger regions.

suite('containment: wider intervals');

test('sphere with wide intervals', () => {
  const node = ['sphere', { radius: 15 }];
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(99);

  for (let i = 0; i < 100; i++) {
    // Random point
    const x = -30 + rng() * 60;
    const y = -30 + rng() * 60;
    const z = -30 + rng() * 60;
    // Random interval width (up to 5 units)
    const w = rng() * 5;

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + w], [y, y + w], [z, z + w]);

    assertContains(
      ivResult.distance,
      pointResult.distance,
      `wide-interval sphere at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), w=${w.toFixed(2)}`
    );
  }
});

test('twisted cube with wide intervals', () => {
  const node = ['twist', { axis: 'y', rate: 0.15 }, ['cube', { size: 20 }]];
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(77);

  for (let i = 0; i < 100; i++) {
    const x = -30 + rng() * 60;
    const y = -30 + rng() * 60;
    const z = -30 + rng() * 60;
    const w = rng() * 5;

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + w], [y, y + w], [z, z + w]);

    assertContains(
      ivResult.distance,
      pointResult.distance,
      `wide-interval twist at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), w=${w.toFixed(2)}`
    );
  }
});

test('bent cube with wide intervals', () => {
  const node = ['bend', { axis: 'y', rate: 0.04 }, ['cube', { size: 25 }]];
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(55);

  for (let i = 0; i < 100; i++) {
    const x = -40 + rng() * 80;
    const y = -40 + rng() * 80;
    const z = -40 + rng() * 80;
    const w = rng() * 5;

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + w], [y, y + w], [z, z + w]);

    assertContains(
      ivResult.distance,
      pointResult.distance,
      `wide-interval bend at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), w=${w.toFixed(2)}`
    );
  }
});

test('radial with wide intervals', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(33);

  for (let i = 0; i < 100; i++) {
    const x = -25 + rng() * 50;
    const y = -25 + rng() * 50;
    const z = -25 + rng() * 50;
    const w = rng() * 5;

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + w], [y, y + w], [z, z + w]);

    assertContains(
      ivResult.distance,
      pointResult.distance,
      `wide-interval radial at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), w=${w.toFixed(2)}`
    );
  }
});

// --- Stress tests for warp-aware bounding ---
// These specifically target the geometric bound code paths (wide angles,
// boxes far from the axis, etc.)

suite('containment: warp-aware stress tests');

test('twist with extreme rate (many wraps)', () => {
  // rate=0.5 over y∈[-20,20] = angle span of 20 radians — many full rotations
  const node = ['twist', { axis: 'y', rate: 0.5 }, ['cube', { size: 15 }]];
  testContainment(node, { min: [-20, -20, -20], max: [20, 20, 20] }, 500);
});

test('twist with box far from axis', () => {
  // Translated so the box is away from the twist axis
  const node = ['twist', { axis: 'y', rate: 0.15 },
    ['translate', { x: 30, y: 0, z: 0 }, ['cube', { size: 10 }]]
  ];
  testContainment(node, { min: [15, -25, -25], max: [50, 25, 25] }, 300);
});

test('twist all three axes', () => {
  for (const axis of ['x', 'y', 'z']) {
    const node = ['twist', { axis, rate: 0.1 }, ['cube', { size: 20 }]];
    testContainment(node, WIDE_BOUNDS, 200);
  }
});

test('bend with extreme rate', () => {
  const node = ['bend', { axis: 'y', rate: 0.2 }, ['cube', { size: 15 }]];
  testContainment(node, WIDE_BOUNDS, 500);
});

test('bend all three axes', () => {
  for (const axis of ['x', 'y', 'z']) {
    const node = ['bend', { axis, rate: 0.04 }, ['cube', { size: 25 }]];
    testContainment(node, WIDE_BOUNDS, 200);
  }
});

test('bend with box spanning large along range', () => {
  const node = ['bend', { axis: 'y', rate: 0.04 }, ['cube', { size: 25 }]];
  // Wide box in the along direction (x for axis=y bend)
  testContainment(node, { min: [-50, -30, -30], max: [50, 30, 30] }, 300);
});

test('radial with low count (2-way)', () => {
  const node = ['radial', { axis: 'y', count: 2 },
    ['translate', { x: 10, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 300);
});

test('radial with high count (12-way)', () => {
  const node = ['radial', { axis: 'y', count: 12 },
    ['translate', { x: 15, y: 0, z: 0 }, ['sphere', { radius: 3 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 300);
});

test('radial all three axes', () => {
  for (const axis of ['x', 'y', 'z']) {
    const node = ['radial', { axis, count: 6 },
      ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
    ];
    testContainment(node, WIDE_BOUNDS, 200);
  }
});

test('radial with box near axis (rmin ≈ 0)', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  // Box centered on axis
  testContainment(node, { min: [-3, -20, -3], max: [3, 20, 3] }, 200);
});

test('radial with box far from axis', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  // Box in one quadrant, far from axis
  testContainment(node, { min: [8, -10, 8], max: [20, 10, 20] }, 300);
});

test('nested warps: twist inside radial', () => {
  const node = ['radial', { axis: 'y', count: 4 },
    ['translate', { x: 20, y: 0, z: 0 },
      ['twist', { axis: 'y', rate: 0.1 }, ['cube', { size: 10 }]]
    ]
  ];
  testContainment(node, { min: [-35, -25, -35], max: [35, 25, 35] }, 500);
});

test('nested warps: bend inside twist', () => {
  const node = ['twist', { axis: 'y', rate: 0.1 },
    ['bend', { axis: 'y', rate: 0.03 }, ['cube', { size: 20 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});

// --- Polar-aware radial culling stress tests ---
// These target the angular folding logic: sector boundaries, mirror line,
// cells in every quadrant, cells near the atan2 discontinuity.

suite('containment: polar-aware radial stress tests');

test('radial: cells in all four quadrants', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  // Sample from all quadrants to test atan2 in all angle ranges
  for (const [xOff, zOff] of [[10,10], [-10,10], [-10,-10], [10,-10]]) {
    testContainment(node, {
      min: [xOff - 5, -5, zOff - 5],
      max: [xOff + 5, 5, zOff + 5]
    }, 200);
  }
});

test('radial: cell straddling sector boundary', () => {
  // With count=6, sector = π/3 ≈ 1.047. A cell near θ = π/3 straddles boundary.
  // At θ=π/3: x=r*cos(π/3)=r/2, z=r*sin(π/3)=r*√3/2
  // For r=12: x=6, z=10.39
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, { min: [4, -5, 9], max: [8, 5, 12] }, 300);
});

test('radial: cell near atan2 discontinuity (negative x, z≈0)', () => {
  // atan2 jumps from π to -π at x<0, z=0
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, { min: [-15, -5, -2], max: [-8, 5, 2] }, 300);
});

test('radial: cell on x-axis (z=0, x>0) — angle=0', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, { min: [8, -5, -1], max: [16, 5, 1] }, 300);
});

test('radial: wide intervals spanning multiple sectors', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  const pointField = evalCSGField(node);
  const intervalField = evalCSGFieldInterval(node);
  const rng = makeRng(123);

  for (let i = 0; i < 200; i++) {
    const x = -20 + rng() * 40;
    const y = -10 + rng() * 20;
    const z = -20 + rng() * 40;
    const w = 2 + rng() * 8; // wide intervals (2-10 units)

    const pointResult = pointField(x, y, z);
    const ivResult = intervalField([x, x + w], [y, y + w], [z, z + w]);

    assertContains(
      ivResult.distance,
      pointResult.distance,
      `wide radial at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), w=${w.toFixed(2)}`
    );
  }
});

test('radial count=3: wide sectors', () => {
  // sector = 2π/3 ≈ 2.09, halfSector ≈ 1.047
  const node = ['radial', { axis: 'y', count: 3 },
    ['translate', { x: 10, y: 0, z: 0 }, ['cube', { size: 6 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});

test('radial count=8: narrow sectors', () => {
  // sector = π/4 ≈ 0.785, halfSector ≈ 0.393
  const node = ['radial', { axis: 'y', count: 8 },
    ['translate', { x: 15, y: 0, z: 0 }, ['sphere', { radius: 4 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});

test('radial with cube child (non-spherical)', () => {
  const node = ['radial', { axis: 'y', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['cube', { size: 8 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});

test('radial z-axis', () => {
  const node = ['radial', { axis: 'z', count: 6 },
    ['translate', { x: 12, y: 0, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});

test('radial x-axis', () => {
  const node = ['radial', { axis: 'x', count: 6 },
    ['translate', { x: 0, y: 12, z: 0 }, ['sphere', { radius: 5 }]]
  ];
  testContainment(node, WIDE_BOUNDS, 500);
});
