// Unit tests for enzyme currying (partial application in stir).

import { suite, test, assert } from './run.js';
import { expandAST } from '../src/expand.js';

suite('enzyme currying — basic partial application');

test('enzyme with 2 tags + 1 arg → partially applied enzyme', () => {
  // (stir (enzyme :tags "x y" (cube {size: (var "x")})) (tag "x" 10))
  const ast = ['stir',
    ['enzyme', { tags: 'x y' },
      ['cube', { size: ['var', { name: 'x' }] }]],
    ['tag', { name: 'x' }, ['scalar', { value: 10 }]]
  ];
  const result = expandAST(ast);
  // Should be a partially applied enzyme (closure) wanting just "y"
  assert(result && result.__enzyme, 'should return an enzyme closure');
  const remainingTags = result.node[1].tags;
  assert(remainingTags === 'y', `remaining tags should be "y", got "${remainingTags}"`);
  // x should be bound in the captured env — matched tag "x" is stripped
  const xVal = result.env.get('x');
  assert(xVal === 10, `x should be bound to 10 (tag stripped), got ${JSON.stringify(xVal)}`);
});

test('partial enzyme can be fully applied in a second stir', () => {
  // Step 1: partially apply
  // Step 2: use the result in another stir with the remaining tag
  const ast = ['let', { name: 'partial' },
    ['stir',
      ['enzyme', { tags: 'x y' },
        ['sphere', { radius: ['var', { name: 'x' }] }]],
      ['tag', { name: 'x' }, ['scalar', { value: 7 }]]],
    // Second stir: supply "y"
    ['stir',
      ['var', { name: 'partial' }],
      ['tag', { name: 'y' }, ['scalar', { value: 99 }]]]
  ];
  const result = expandAST(ast);
  // Should be a fully evaluated sphere with radius 7
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'sphere', `should be sphere, got ${result[0]}`);
  assert(result[1].radius === 7, `radius should be 7, got ${result[1].radius}`);
});

suite('enzyme currying — bundle unpacking');

test('two enzymes in stir with no matching args → bundle of both', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'x' }, ['cube', { size: 10 }]],
    ['enzyme', { tags: 'y' }, ['sphere', { radius: 5 }]]
  ];
  const result = expandAST(ast);
  // Neither can fire — both should survive as a bundle
  assert(result && result.__bundle, 'should return a bundle');
  assert(result.items.length === 2, `bundle should have 2 items, got ${result.items.length}`);
  assert(result.items[0].__enzyme, 'first item should be an enzyme');
  assert(result.items[1].__enzyme, 'second item should be an enzyme');
});

test('bundle unpacks when entering another stir', () => {
  // Stir 1: two enzymes, no args → bundle
  // Stir 2: bundle + both tags → both fire
  const ast = ['let', { name: 'pair' },
    ['stir',
      ['enzyme', { tags: 'x' }, ['cube', { size: ['var', { name: 'x' }] }]],
      ['enzyme', { tags: 'y' }, ['sphere', { radius: ['var', { name: 'y' }] }]]],
    ['stir',
      ['var', { name: 'pair' }],
      ['tag', { name: 'x' }, ['scalar', { value: 11 }]],
      ['tag', { name: 'y' }, ['scalar', { value: 22 }]]]
  ];
  const result = expandAST(ast);
  // Both enzymes fire → union of cube and sphere
  assert(Array.isArray(result), 'should be an AST array');
  assert(result[0] === 'union', `should be union, got ${result[0]}`);
  const types = result.slice(1).map(c => c[0]).sort();
  assert(types.includes('cube'), 'should contain cube');
  assert(types.includes('sphere'), 'should contain sphere');
});

suite('enzyme currying — chain reaction');

test('B fires, produces tagged X, A consumes it in same stir', () => {
  // A wants "x", B wants "y".
  // B's body is (tag "x" (cube {size: (var "y")}))
  // — when B fires, it produces a cube tagged "x".
  // A's body is (sphere {radius: (var "x")})
  // — but "x" will be the cube, so radius will be the cube node itself.
  //
  // More realistically: A wants "x" (a scalar), B wants "y" and produces
  // a scalar tagged "x".
  //
  // B fires with y=5, body = (tag "x" (scalar 42)) → pool gets 42 tagged "x"
  // A fires with x=42, body = (cube {size: (var "x")}) → cube size 42
  const ast = ['stir',
    // Bundle of A and B
    ['enzyme', { tags: 'x' },
      ['cube', { size: ['var', { name: 'x' }] }]],
    ['enzyme', { tags: 'y' },
      ['tag', { name: 'x' }, ['var', { name: 'y' }]]],
    // Only supply "y"
    ['tag', { name: 'y' }, ['scalar', { value: 42 }]]
  ];
  const result = expandAST(ast);
  // B fires (has "y"), produces 42 tagged "x".
  // A fires (now has "x"=42), produces cube size 42.
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'cube', `should be cube, got ${result[0]}`);
  assert(result[1].size === 42, `size should be 42, got ${result[1].size}`);
});

test('chain reaction with curried bundle from prior stir', () => {
  // Stir 1: two enzymes, no args → bundle [A(wants x), B(wants y)]
  // Stir 2: bundle + "y" value → B fires, tags result as "x", A fires
  const ast = ['let', { name: 'pair' },
    ['stir',
      ['enzyme', { tags: 'x' },
        ['sphere', { radius: ['var', { name: 'x' }] }]],
      ['enzyme', { tags: 'y' },
        ['tag', { name: 'x' }, ['var', { name: 'y' }]]]],
    ['stir',
      ['var', { name: 'pair' }],
      ['tag', { name: 'y' }, ['scalar', { value: 7 }]]]
  ];
  const result = expandAST(ast);
  // B fires with y=7, produces 7 tagged "x"
  // A fires with x=7, produces sphere radius 7
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'sphere', `should be sphere, got ${result[0]}`);
  assert(result[1].radius === 7, `radius should be 7, got ${result[1].radius}`);
});

suite('enzyme currying — backward compatibility');

test('fully matched enzyme still fires normally', () => {
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

test('enzyme with no matching args at all is preserved', () => {
  const ast = ['stir',
    ['enzyme', { tags: 'x' }, ['cube', { size: 10 }]],
    ['sphere', { radius: 5 }]
  ];
  const result = expandAST(ast);
  // Enzyme can't match (sphere has implicit "shape" tag, not "x").
  // Result should be a bundle of the enzyme + the sphere.
  assert(result && result.__bundle, 'should return a bundle');
  assert(result.items.length === 2, 'bundle should have 2 items');
});

suite('enzyme currying — tag stripping on match');

test('matched tag is stripped, other tags preserved', () => {
  // Value has tags "x" and "y". Enzyme wants "x".
  // After match, the bound value should carry "y" but not "x".
  const ast = ['stir',
    ['enzyme', { tags: 'x' },
      ['var', { name: 'x' }]],  // body just returns the bound value
    ['tag', { name: 'x' }, ['tag', { name: 'y' }, ['scalar', { value: 99 }]]]
  ];
  const result = expandAST(ast);
  // Tags are _tags on the value: ['scalar', {value: 99, _tags: ['y']}]
  // ("x" stripped, "y" preserved)
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'scalar', `should be scalar, got ${result[0]}`);
  assert(result[1].value === 99, `inner value should be 99, got ${result[1].value}`);
  const tags = result[1]._tags || [];
  assert(tags.includes('y'), `should preserve tag "y", got ${JSON.stringify(tags)}`);
  assert(!tags.includes('x'), `should NOT contain tag "x", got ${JSON.stringify(tags)}`);
});

test('matched tag stripped from tags (plural) wrapper', () => {
  // (tags "x y" 42) matched on "x" → scalar with _tags: ['y']
  const ast = ['stir',
    ['enzyme', { tags: 'x' },
      ['var', { name: 'x' }]],
    ['tags', { names: 'x y' }, ['scalar', { value: 42 }]]
  ];
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should be an AST node');
  assert(result[0] === 'scalar', `should be scalar, got ${result[0]}`);
  assert(result[1].value === 42, `inner value should be 42, got ${result[1].value}`);
  const tags = result[1]._tags || [];
  assert(tags.includes('y'), `should preserve tag "y", got ${JSON.stringify(tags)}`);
  assert(!tags.includes('x'), `should NOT contain tag "x", got ${JSON.stringify(tags)}`);
});

test('all tags stripped when only tag is the matched one', () => {
  // (tag "x" 42) matched on "x" → bare 42 (promoted scalar reverts)
  const ast = ['stir',
    ['enzyme', { tags: 'x' },
      ['var', { name: 'x' }]],
    ['tag', { name: 'x' }, ['scalar', { value: 42 }]]
  ];
  const result = expandAST(ast);
  assert(result === 42, `should be bare 42, got ${JSON.stringify(result)}`);
});
