// Unit tests for enzyme lazy defaults (thunks).

import { suite, test, assert } from './run.js';
import { expandAST } from '../src/expand.js';

suite('enzyme defaults — basic forcing');

test('enzyme with one defaulted want, no pool supply → forced at boundary', () => {
  // (stir (enzyme :tags "x" :defaults {x: 5} (cube {size: (var "x")})))
  const ast = ['stir',
    ['enzyme', { tags: 'x', defaults: { x: 5 } },
      ['cube', { size: ['var', { name: 'x' }] }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'cube', `should be cube, got ${result[0]}`);
  assert(result[1].size === 5, `size should be 5, got ${result[1].size}`);
});

test('defaulted want overridden by pool value', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'x', defaults: { x: 5 } },
      ['cube', { size: ['var', { name: 'x' }] }]],
    ['tag', { name: 'x' }, ['scalar', { value: 10 }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'cube', `should be cube, got ${result[0]}`);
  assert(result[1].size === 10, `size should be 10 (pool override), got ${result[1].size}`);
});

suite('enzyme defaults — lazy: not eagerly fired');

test('pool value used over default when available', () => {
  // Enzyme wants x(default=0) and y(default=0). Pool supplies x=10.
  // Should curry x=10, keep y defaulted, then force y=0 at boundary.
  const ast = ['stir',
    ['enzyme', { tags: 'x y', defaults: { x: 0, y: 0 } },
      ['translate', { x: ['var', { name: 'x' }], y: ['var', { name: 'y' }], z: 0 },
        ['cube', { size: 20 }]]],
    ['tag', { name: 'x' }, ['scalar', { value: 10 }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'translate', `should be translate, got ${result[0]}`);
  assert(result[1].x === 10, `x should be 10 (from pool), got ${result[1].x}`);
  assert(result[1].y === 0, `y should be 0 (from default), got ${result[1].y}`);
});

test('partial satisfaction: required + defaulted wants', () => {
  // Enzyme wants x(default=5) and y (no default). Pool supplies y=10 but not x.
  // After currying y, enzyme has only defaulted want x → thunk → forced.
  const ast = ['stir',
    ['enzyme', { tags: 'x y', defaults: { x: 5 } },
      ['translate', { x: ['var', { name: 'x' }], y: ['var', { name: 'y' }], z: 0 },
        ['cube', { size: 20 }]]],
    ['tag', { name: 'y' }, ['scalar', { value: 10 }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'translate', `should be translate, got ${result[0]}`);
  assert(result[1].x === 5, `x should be 5 (from default), got ${result[1].x}`);
  assert(result[1].y === 10, `y should be 10 (from pool), got ${result[1].y}`);
});

suite('enzyme defaults — all wants defaulted');

test('all-defaulted enzyme with no pool items → forced at boundary', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'x y z', defaults: { x: 1, y: 2, z: 3 } },
      ['translate', { x: ['var', { name: 'x' }], y: ['var', { name: 'y' }], z: ['var', { name: 'z' }] },
        ['sphere', { radius: 10 }]]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'translate', `should be translate, got ${result[0]}`);
  assert(result[1].x === 1, `x should be 1, got ${result[1].x}`);
  assert(result[1].y === 2, `y should be 2, got ${result[1].y}`);
  assert(result[1].z === 3, `z should be 3, got ${result[1].z}`);
});

suite('enzyme defaults — thunk in non-forcing context');

test('thunk passes through let binding, forced at boundary', () => {
  const ast = ['let', { name: 'shape' },
    ['stir',
      ['enzyme', { tags: 'x', defaults: { x: 5 } },
        ['cube', { size: ['var', { name: 'x' }] }]]],
    ['var', { name: 'shape' }]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'cube', `should be cube, got ${result[0]}`);
  assert(result[1].size === 5, `size should be 5, got ${result[1].size}`);
});

test('thunk passes through union, forced at boundary', () => {
  const ast = ['union',
    ['stir',
      ['enzyme', { tags: 'r', defaults: { r: 7 } },
        ['sphere', { radius: ['var', { name: 'r' }] }]]],
    ['cube', { size: 10 }]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'union', `should be union, got ${result[0]}`);
});

suite('enzyme defaults — thunk consumed by outer stir');

test('thunk in outer stir consumed by enzyme via tag', () => {
  // Inner stir produces thunk (enzyme with default); outer stir's enzyme consumes it
  const ast = ['stir',
    ['enzyme', { tags: 'shape' },
      ['paint', { color: 'red' }, ['var', { name: 'shape' }]]],
    ['tag', { name: 'shape' },
      ['stir',
        ['enzyme', { tags: 'x', defaults: { x: 5 } },
          ['cube', { size: ['var', { name: 'x' }] }]]]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'paint', `should be paint, got ${result[0]}`);
});

suite('enzyme defaults — expression defaults');

test('default can be an AST expression', () => {
  // Default for x is (scalar {value: 42}) — a full expression, not a bare number
  const ast = ['stir',
    ['enzyme', { tags: 'x', defaults: { x: ['scalar', { value: 42 }] } },
      ['cube', { size: ['var', { name: 'x' }] }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'cube', `should be cube, got ${result[0]}`);
  assert(result[1].size === 42, `size should be 42, got ${result[1].size}`);
});

suite('enzyme defaults — backward compatibility');

test('enzyme without defaults behaves exactly as before', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'r' },
      ['sphere', { radius: ['var', { name: 'r' }] }]],
    ['tag', { name: 'r' }, ['scalar', { value: 15 }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'sphere', `should be sphere, got ${result[0]}`);
  assert(result[1].radius === 15, `radius should be 15, got ${result[1].radius}`);
});

test('enzyme without defaults and no match survives as enzyme', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'x' }, ['cube', { size: 10 }]]
  ];
  const result = expandAST(ast);
  assert(result && result.__enzyme, 'should return enzyme closure (no defaults, unforceable)');
});
