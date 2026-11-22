import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Host, Table, TapisClient, type View } from '../src/index.ts';
import { guess } from './fixtures.ts';

function until(get: () => View | undefined, pred: (v: View) => boolean): Promise<View> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v && pred(v)) return resolve(v);
      if (Date.now() - started > 5000) return reject(new Error('timed out waiting for view'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('two clients play over gRPC and both see the same global scene', async () => {
  const host = new Host();
  const table = new Table(guess, { id: 'g1', seats: 2 });
  host.add(table);
  const port = await host.listen('127.0.0.1:0');
  const a = new TapisClient(`127.0.0.1:${port}`, 'g1');
  const b = new TapisClient(`127.0.0.1:${port}`, 'g1');
  const spec = new TapisClient(`127.0.0.1:${port}`, 'g1');
  try {
    assert.equal((await a.describe()).phase, 'waiting');
    await a.join('alice');
    await b.join('bob');
    let va: View | undefined;
    let vb: View | undefined;
    let vs: View | undefined;
    const errors: Error[] = [];
    const stops = [
      a.watch((v) => (va = v), (e) => errors.push(e)),
      b.watch((v) => (vb = v), (e) => errors.push(e)),
      spec.watch((v) => (vs = v), (e) => errors.push(e), true),
    ];
    await until(() => va, (v) => v.phase === 'playing');
    const r = await b.act('guess', 3);
    assert.equal(r.accepted, false);
    assert.equal(r.error, 'not your turn');
    assert.equal((await a.act('note', 'private')).accepted, true);
    await until(() => va, (v) => (v.local as any)?.notes?.length === 1);
    let lo = 0;
    let hi = 99;
    let turn = 0;
    for (let i = 0; i < 20 && table.phase === 'playing'; i++) {
      const n = Math.floor((lo + hi) / 2);
      const res = await (turn === 0 ? a : b).act('guess', n);
      assert.ok(res.accepted, res.error);
      const v = await until(() => va, (x) => x.version === res.version);
      const g = (v.global as any).guesses.at(-1);
      if (g.hint === 'higher') lo = n + 1;
      if (g.hint === 'lower') hi = n - 1;
      turn = 1 - turn;
    }
    const fa = await until(() => va, (v) => v.phase === 'finished');
    const fb = await until(() => vb, (v) => v.phase === 'finished');
    const fs = await until(() => vs, (v) => v.phase === 'finished');
    assert.deepEqual(fa.global, fb.global);
    assert.deepEqual(fa.global, fs.global);
    assert.deepEqual(fb.local, { notes: [] });
    assert.equal(fs.local, null);
    assert.ok(fs.revealed.has('secret'));
    assert.deepEqual(errors, []);
    stops.forEach((s) => s());
    const back = new TapisClient(`127.0.0.1:${port}`, 'g1');
    assert.equal((await back.join('', a.token)).seat, 0, 'the token reclaims seat 0');
    back.close();
  } finally {
    a.close();
    b.close();
    spec.close();
    await host.close();
  }
});
