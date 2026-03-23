#!/usr/bin/env node
// Minimal test runner. No dependencies. Runs under Node 18+ with ES modules.
// Usage: node test/run.js
//
// Exit code 0 = all passed, 1 = failures.

let passed = 0;
let failed = 0;
let currentSuite = '';

export function suite(name) {
  currentSuite = name;
  console.log(`\n  ${name}`);
}

export function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`    ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) {
    throw new Error(msg || `expected ${a} ≈ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`);
  }
}

// Interval containment: point value must be within [lo, hi]
export function assertContains(interval, value, msg) {
  const [lo, hi] = interval;
  // Small epsilon for floating point
  const eps = 1e-10;
  if (value < lo - eps || value > hi + eps) {
    throw new Error(msg || `interval [${lo}, ${hi}] does not contain ${value}`);
  }
}

// Run all test modules, then report
async function main() {
  console.log('schnapp3 test suite\n');

  // Import test modules (they register via side effects calling suite/test)
  await import('./interval-tests.js');
  await import('./interval-containment-tests.js');
  await import('./fp-audit.js');

  console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
