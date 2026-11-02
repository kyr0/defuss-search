import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseRankings } from 'defuss-search';
const list = (name, ids, scores = ids.map((_, i) => ids.length - i), weight = 1) => ({
  name,
  hits: ids.map((id, i) => ({ id, score: scores[i] })),
  weight,
});

test('RRF follows one-based formula, sums overlap and treats missing votes as zero', () => {
  const out = fuseRankings([list('lexical', ['a', 'b']), list('vector', ['b', 'c'])]);
  assert.deepEqual(
    out.map((x) => x.id),
    ['b', 'a', 'c'],
  );
  assert.equal(out[0].score, 1 / 62 + 1 / 61);
  assert.equal(out[1].score, 1 / 61);
  assert.equal(out[0].contributions.lexical.rank, 2);
});
test('RRF preserves tier ordering, is score-scale invariant, and ties use document ID', () => {
  const x = [list('lexical', ['z', 'a'], [0, 1000]), list('vector', ['a', 'z'], [900, -900])];
  assert.deepEqual(
    fuseRankings(x).map((x) => x.id),
    ['a', 'z'],
  );
  assert.deepEqual(fuseRankings(x), fuseRankings([...x].reverse()));
  assert.throws(() => fuseRankings(x, { method: 'linear' }), /descending/);
});
test('weighted fusion, k=0, empty lists, zero votes and prototype-like IDs', () => {
  const result = fuseRankings(
    [list('__proto__', ['__proto__'], [0], 2), list('other', ['a'], [1], 0)],
    { k: 0 },
  );
  assert.equal(result[0].score, 2);
  assert.equal(result[1].score, 0);
  assert.equal(result[0].contributions.__proto__.rank, 1);
  assert.deepEqual(fuseRankings([list('x', [])]), []);
});
test('linear normalization: negatives, constant lists, missing hits and extreme values', () => {
  const out = fuseRankings([list('a', ['x', 'y'], [-1, -3], 3), list('b', ['z'], [20], 1)], {
    method: 'linear',
  });
  assert.deepEqual(
    out.map((x) => [x.id, x.score]),
    [
      ['x', 0.75],
      ['z', 0.25],
      ['y', 0],
    ],
  );
  const huge = fuseRankings([list('huge', ['a', 'b', 'c'], [1e308, 0, -1e308])], {
    method: 'linear',
  });
  assert.deepEqual(
    huge.map((x) => x.score),
    [1, 0.5, 0],
  );
});
test('reject malformed rankings rather than silently double-count or propagate NaN', () => {
  for (const lists of [
    [],
    [list('x', ['a', 'a'])],
    [list('x', ['a'], [NaN])],
    [list('x', ['a'], [Infinity])],
    [list('x', ['a'], [1], -1)],
    [list('x', [], [], 0)],
    [list('x', []), list('x', [])],
  ])
    assert.throws(() => fuseRankings(lists));
  assert.throws(() => fuseRankings([list('a', [])], { k: -1 }));
  assert.throws(() => fuseRankings([list('a', [])], { method: 'unknown' }));
});
test('RRF agrees with an independent rank-map oracle across deterministic corpora', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const ids = Array.from({ length: 13 }, (_, i) => String(i));
    const a = ids
      .filter((_, i) => (i + seed) % 3)
      .sort((x, y) => ((Number(x) * 7 + seed) % 13) - ((Number(y) * 7 + seed) % 13));
    const b = ids.filter((_, i) => (i + seed) % 4).reverse();
    const expected = [...new Set([...a, ...b])]
      .map((id) => ({
        id,
        score:
          (a.includes(id) ? 2 / (5 + a.indexOf(id) + 1) : 0) +
          (b.includes(id) ? 0.5 / (5 + b.indexOf(id) + 1) : 0),
      }))
      .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
    const actual = fuseRankings([list('a', a, undefined, 2), list('b', b, undefined, 0.5)], {
      k: 5,
    });
    assert.deepEqual(
      actual.map(({ id, score }) => ({ id, score })),
      expected,
    );
  }
});
