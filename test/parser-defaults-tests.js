// Unit tests for parser + codegen round-trip with enzyme defaults.

import { suite, test, assert } from './run.js';
import { parseSExpr } from '../src/parser.js';
import { formatSExpr } from '../src/codegen.js';
import { expandAST } from '../src/expand.js';

suite('parser — enzyme defaults syntax');

test('parse enzyme with no defaults (backward compat)', () => {
  const ast = parseSExpr('(enzyme :tags ("x" "y") (cube 10))');
  assert(Array.isArray(ast), 'should parse to AST');
  assert(ast[0] === 'enzyme', `type should be enzyme, got ${ast[0]}`);
  assert(ast[1].tags === 'x y', `tags should be "x y", got "${ast[1].tags}"`);
  assert(!ast[1].defaults, 'should have no defaults');
});

test('parse enzyme with scalar defaults', () => {
  const ast = parseSExpr('(enzyme :tags ("x" "y") :defaults (("x" 5) ("y" 10)) (cube (var "x")))');
  assert(Array.isArray(ast), 'should parse to AST');
  assert(ast[0] === 'enzyme', `type should be enzyme, got ${ast[0]}`);
  assert(ast[1].tags === 'x y', `tags should be "x y", got "${ast[1].tags}"`);
  assert(ast[1].defaults, 'should have defaults');
  assert(ast[1].defaults.x === 5, `default for x should be 5, got ${ast[1].defaults.x}`);
  assert(ast[1].defaults.y === 10, `default for y should be 10, got ${ast[1].defaults.y}`);
});

test('parse enzyme with expression default', () => {
  const ast = parseSExpr('(enzyme :tags ("x") :defaults (("x" (scalar 42))) (cube (var "x")))');
  assert(Array.isArray(ast), 'should parse to AST');
  assert(ast[1].defaults, 'should have defaults');
  const xDefault = ast[1].defaults.x;
  assert(Array.isArray(xDefault), 'default for x should be an AST expression');
  assert(xDefault[0] === 'scalar', `default should be scalar, got ${xDefault[0]}`);
  assert(xDefault[1].value === 42, `scalar value should be 42, got ${xDefault[1].value}`);
});

suite('parser — enzyme defaults end-to-end');

test('parsed enzyme with defaults → expand → correct result', () => {
  const ast = parseSExpr(`
    (stir
      (enzyme :tags ("r") :defaults (("r" 7))
        (sphere (var "r"))))
  `);
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should produce AST');
  assert(result[0] === 'sphere', `should be sphere, got ${result[0]}`);
  assert(result[1].radius === 7, `radius should be 7, got ${result[1].radius}`);
});

test('parsed enzyme with default overridden by pool', () => {
  const ast = parseSExpr(`
    (stir
      (enzyme :tags ("r") :defaults (("r" 7))
        (sphere (var "r")))
      (tag "r" (scalar 20)))
  `);
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should produce AST');
  assert(result[0] === 'sphere', `should be sphere, got ${result[0]}`);
  assert(result[1].radius === 20, `radius should be 20 (pool override), got ${result[1].radius}`);
});

test('parsed enzyme with partial defaults — pool + default', () => {
  const ast = parseSExpr(`
    (stir
      (enzyme :tags ("x" "y") :defaults (("x" 0))
        (translate (var "x") (var "y") 0
          (cube 20)))
      (tag "y" (scalar 10)))
  `);
  const result = expandAST(ast);
  assert(Array.isArray(result), 'should produce AST');
  assert(result[0] === 'translate', `should be translate, got ${result[0]}`);
  assert(result[1].x === 0, `x should be 0 (default), got ${result[1].x}`);
  assert(result[1].y === 10, `y should be 10 (pool), got ${result[1].y}`);
});

suite('codegen — enzyme defaults formatting');

test('format enzyme without defaults (backward compat)', () => {
  const ast = ['enzyme', { tags: 'x y' }, ['cube', { size: 10 }]];
  const str = formatSExpr(ast);
  assert(str.includes(':tags ("x" "y")'), `should format tags, got: ${str}`);
  assert(!str.includes(':defaults'), `should not include :defaults, got: ${str}`);
});

test('format enzyme with scalar defaults', () => {
  const ast = ['enzyme', { tags: 'x y', defaults: { x: 5, y: 10 } }, ['cube', { size: 10 }]];
  const str = formatSExpr(ast);
  assert(str.includes(':tags ("x" "y")'), `should format tags, got: ${str}`);
  assert(str.includes(':defaults'), `should include :defaults, got: ${str}`);
  assert(str.includes('("x" 5)'), `should include x default, got: ${str}`);
  assert(str.includes('("y" 10)'), `should include y default, got: ${str}`);
});

suite('round-trip — parse then format');

test('enzyme with defaults survives parse → format round-trip', () => {
  const original = '(enzyme :tags ("x") :defaults (("x" 5))\n  (cube (var "x")))';
  const ast = parseSExpr(original);
  const formatted = formatSExpr(ast);
  // Parse again and verify structure matches
  const ast2 = parseSExpr(formatted);
  assert(ast2[0] === 'enzyme', 'should be enzyme');
  assert(ast2[1].tags === 'x', `tags should be "x", got "${ast2[1].tags}"`);
  assert(ast2[1].defaults.x === 5, `default x should be 5, got ${ast2[1].defaults.x}`);
});
