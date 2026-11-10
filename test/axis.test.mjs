import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareAxis } from '../website/axis.mjs';

// The requirement (the user, 2026-11-09): the recall axis of the scatter charts spans the values plus 5 points.
test('the axis spans the values with at least 5 points to spare, on whole ticks', () => {
  // Belebele R@5 in docs/data/strategies.json: 96.7% to 97.3%.
  assert.deepEqual(shareAxis([0.967, 0.973, 0.97]), { min: 0.9, max: 1, interval: 0.02 });
  // Belebele R@1: 90.3% to 91.2%.
  assert.deepEqual(shareAxis([0.903, 0.912]), { min: 0.84, max: 0.98, interval: 0.02 });
});

test('the axis stays within 0% and 100%', () => {
  assert.deepEqual(shareAxis([1, 1]), { min: 0.95, max: 1, interval: 0.01 });
  assert.deepEqual(shareAxis([0.02, 0.5]), { min: 0, max: 0.6, interval: 0.1 });
});

test('a wide spread takes a coarser step, at most 7 of them', () => {
  // The holdout frontier's R@1: 40.2% to 92.4%.
  assert.deepEqual(shareAxis([0.402, 0.924]), { min: 0.3, max: 1, interval: 0.1 });
  // Notes found by translation: BM25 alone at 22.0%, the vector factories at 97.8%.
  assert.deepEqual(shareAxis([0.21978, 0.978022]), { min: 0, max: 1, interval: 0.2 });
});
