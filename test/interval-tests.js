// Unit tests for interval arithmetic operations.

import { suite, test, assert, assertClose } from './run.js';
import {
  iadd, isub, imul, idiv, ineg, iabs, isqrt, isq,
  imin, imax, imax0, imin0, imax3,
  icos, isin, iatan2, imod, isoftmin, classify
} from '../src/interval.js';

// --- iadd ---
suite('iadd');

test('positive intervals', () => {
  const r = iadd([1, 2], [3, 4]);
  assert(r[0] === 4 && r[1] === 6);
});

test('mixed signs', () => {
  const r = iadd([-1, 2], [-3, 4]);
  assert(r[0] === -4 && r[1] === 6);
});

// --- isub ---
suite('isub');

test('basic subtraction', () => {
  const r = isub([5, 10], [1, 3]);
  assert(r[0] === 2 && r[1] === 9);
});

test('result can be negative', () => {
  const r = isub([1, 2], [3, 5]);
  assert(r[0] === -4 && r[1] === -1);
});

// --- imul ---
suite('imul');

test('positive * positive', () => {
  const r = imul([2, 3], [4, 5]);
  assert(r[0] === 8 && r[1] === 15);
});

test('mixed signs', () => {
  const r = imul([-2, 3], [-1, 4]);
  assert(r[0] === -8 && r[1] === 12);
});

// --- idiv ---
suite('idiv');

test('division not spanning zero', () => {
  const r = idiv([4, 8], [2, 4]);
  assert(r[0] === 1 && r[1] === 4);
});

test('divisor spanning zero gives infinite', () => {
  const r = idiv([1, 2], [-1, 1]);
  assert(r[0] === -Infinity && r[1] === Infinity);
});

// --- ineg ---
suite('ineg');

test('negation flips and swaps', () => {
  const r = ineg([2, 5]);
  assert(r[0] === -5 && r[1] === -2);
});

// --- iabs ---
suite('iabs');

test('all positive', () => {
  const r = iabs([2, 5]);
  assert(r[0] === 2 && r[1] === 5);
});

test('all negative', () => {
  const r = iabs([-5, -2]);
  assert(r[0] === 2 && r[1] === 5);
});

test('spanning zero', () => {
  const r = iabs([-3, 5]);
  assert(r[0] === 0 && r[1] === 5);
});

// --- isqrt ---
suite('isqrt');

test('sqrt of positive', () => {
  const r = isqrt([4, 9]);
  assertClose(r[0], 2, 1e-10);
  assertClose(r[1], 3, 1e-10);
});

test('sqrt clamps negative to zero', () => {
  const r = isqrt([-1, 4]);
  assert(r[0] === 0);
  assertClose(r[1], 2, 1e-10);
});

// --- isq ---
suite('isq');

test('all positive', () => {
  const r = isq([2, 3]);
  assert(r[0] === 4 && r[1] === 9);
});

test('all negative', () => {
  const r = isq([-3, -2]);
  assert(r[0] === 4 && r[1] === 9);
});

test('spanning zero', () => {
  const r = isq([-3, 2]);
  assert(r[0] === 0 && r[1] === 9);
});

// --- imin / imax ---
suite('imin / imax');

test('imin', () => {
  const r = imin([1, 5], [2, 3]);
  assert(r[0] === 1 && r[1] === 3);
});

test('imax', () => {
  const r = imax([1, 5], [2, 3]);
  assert(r[0] === 2 && r[1] === 5);
});

// --- imax0 / imin0 ---
suite('imax0 / imin0');

test('imax0 clamps below at zero', () => {
  const r = imax0([-3, 5]);
  assert(r[0] === 0 && r[1] === 5);
});

test('imin0 clamps above at zero', () => {
  const r = imin0([-3, 5]);
  assert(r[0] === -3 && r[1] === 0);
});

// --- icos ---
suite('icos');

test('narrow interval around 0', () => {
  const r = icos([-0.1, 0.1]);
  assert(r[0] < 1 && r[1] <= 1);
  assertClose(r[1], 1, 0.01); // cos(0)=1 is max
});

test('full period gives [-1, 1]', () => {
  const r = icos([0, 7]);
  assert(r[0] === -1 && r[1] === 1);
});

test('around pi gives -1', () => {
  const r = icos([3, 3.3]);
  assert(r[0] < -0.9 && r[1] < 0);
});

// --- isin ---
suite('isin');

test('sin(0) ≈ 0', () => {
  const r = isin([-0.01, 0.01]);
  assert(r[0] < 0.02 && r[1] > -0.02);
});

// --- classify ---
suite('classify');

test('all negative → inside', () => {
  assert(classify([-5, -1]) === 'inside');
});

test('all positive → outside', () => {
  assert(classify([1, 5]) === 'outside');
});

test('spanning zero → ambiguous', () => {
  assert(classify([-1, 1]) === 'ambiguous');
});

test('touching zero from negative → ambiguous', () => {
  assert(classify([-1, 0]) === 'ambiguous');
});

// --- isoftmin ---
suite('isoftmin');

test('softmin of two equal intervals', () => {
  const r = isoftmin([[5, 5], [5, 5]], 1);
  // softmin(5,5) with k=1 ≈ 5 - ln(2) ≈ 4.31
  assert(r[0] <= 4.31 && r[1] >= 4.31);
});

test('softmin lower bound is below all lows', () => {
  const r = isoftmin([[3, 7], [5, 10]], 2);
  assert(r[0] < 3);
});
