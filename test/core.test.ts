import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitmentHash, verifyReveal } from '../src/commit.ts';
import { applyPatch, diff } from '../src/diff.ts';
import { canonicalJson, type Json } from '../src/json.ts';
import { Rng, seedState } from '../src/rng.ts';

function randomJson(r: Rng, depth: number): Json {
  const k = r.int(depth > 3 ? 4 : 6);
  if (k === 0) return null;
  if (k === 1) return r.int(2) === 1;
  if (k === 2) return r.int(1000) - 500;
  if (k === 3) return ['a', 'b/c', 'd~e', ''][r.int(4)];
  if (k === 4) return Array.from({ length: r.int(5) }, () => randomJson(r, depth + 1));
  const o: Record<string, Json> = {};
  for (let i = r.int(5); i > 0; i--) o[['x', 'y', 'z/w', '~', 'q'][r.int(5)]] = randomJson(r, depth + 1);
  return o;
}

test('diff then applyPatch reproduces the target, over 5000 random pairs', () => {
  const r = new Rng(seedState('0123456789abcdef0123456789abcdef'));
  let nonEmpty = 0;
  for (let i = 0; i < 5000; i++) {
    const a = randomJson(r, 0);
    const b = randomJson(r, 0);
    const ops = diff(a, b);
    if (ops.length) nonEmpty++;
    assert.deepEqual(applyPatch(a, ops), b);
  }
  assert.ok(nonEmpty > 4000, `only ${nonEmpty} non-empty patches; generator is too tame`);
});

test('diff of equal documents is empty, and applyPatch leaves its input alone', () => {
  const a = { x: [1, { y: 2 }], z: 'q' };
  assert.deepEqual(diff(a, structuredClone(a)), []);
  const before = canonicalJson(a);
  applyPatch(a, diff(a, { x: [] }));
  assert.equal(canonicalJson(a), before);
});

test('canonicalJson sorts keys at every level', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test('rng is deterministic from its state and int(n) stays in range and covers it', () => {
  const s = seedState('00000000000000000000000000000001');
  const a = new Rng(s);
  const b = new Rng(s);
  const seen = new Array(7).fill(0);
  for (let i = 0; i < 7000; i++) {
    const x = a.int(7);
    assert.equal(x, b.int(7));
    seen[x]++;
  }
  for (const c of seen) assert.ok(c > 850 && c < 1150, `bucket ${c} out of 1000 +/- 150`);
  assert.deepEqual(a.state(), b.state());
  assert.deepEqual(new Rng([1, 2, 3, 4]).shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
});

test('a reveal verifies against its commitment and nothing else', () => {
  const salt = 'aa'.repeat(16);
  const h = commitmentHash(salt, { deck: [3, 1, 2] });
  assert.ok(verifyReveal(h, salt, { deck: [3, 1, 2] }));
  assert.ok(!verifyReveal(h, salt, { deck: [3, 2, 1] }));
  assert.ok(!verifyReveal(h, 'bb'.repeat(16), { deck: [3, 1, 2] }));
});
