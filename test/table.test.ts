import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay, START_ACTION, Table, type Update, ViewTracker } from '../src/index.ts';
import { counterEntropy, FakeClock, guess } from './fixtures.ts';

function setup(seats = 2) {
  const clock = new FakeClock();
  const t = new Table(guess, { id: 't', seats, clock, entropy: counterEntropy() });
  return { clock, t };
}

test('the game starts when the target seat count joins, not before', () => {
  const { t } = setup(3);
  t.join('a');
  t.join('b');
  assert.equal(t.phase, 'waiting');
  t.join('c');
  assert.equal(t.phase, 'playing');
  assert.throws(() => t.join('d'), /already started/);
});

test('tapis.start starts a table early once minSeats have joined', () => {
  const { t } = setup(3);
  const a = t.join('a');
  assert.equal(t.act(a.token, START_ACTION, null).accepted, false);
  t.join('b');
  assert.equal(t.act(a.token, START_ACTION, null).accepted, true);
  assert.equal(t.phase, 'playing');
  assert.equal(t.store?.seats, 2);
});

test('a seat token is the only way to act for a seat, and rejoining returns the seat', () => {
  const { t } = setup();
  const a = t.join('a');
  const b = t.join('b');
  assert.equal(t.act('', 'guess', 1).error, 'unknown seat token');
  assert.equal(t.act('f'.repeat(32), 'guess', 1).error, 'unknown seat token');
  assert.equal(t.act(b.token, 'guess', 1).error, 'not your turn');
  assert.deepEqual(t.join('', a.token), a);
  assert.throws(() => t.join('', 'nope'), /unknown seat token/);
});

test('rejected actions change nothing; stale expected_version is refused', () => {
  const { t } = setup();
  const a = t.join('a');
  t.join('b');
  const v = t.version;
  const before = structuredClone(t.store);
  assert.equal(t.act(a.token, 'guess', 500).accepted, false);
  assert.equal(t.act(a.token, 'scribble', null).error, 'scribble is never allowed');
  assert.deepEqual(t.store, before);
  assert.equal(t.act(a.token, 'note', 'x', v + 1).accepted, false);
  assert.equal(t.act(a.token, 'note', 'x', v).accepted, true);
  assert.equal(t.version, v + 1);
});

test('watchers get a snapshot then patches; locals are private; spectators get none', () => {
  const { t } = setup();
  const a = t.join('a');
  const b = t.join('b');
  const got: Record<string, Update[]> = { a: [], b: [], spec: [] };
  const views = { a: new ViewTracker(), b: new ViewTracker(), spec: new ViewTracker() };
  for (const [k, tok] of [['a', a.token], ['b', b.token], ['spec', '']] as const) {
    t.watch(tok, (u) => {
      got[k].push(u);
      views[k].apply(u);
    });
  }
  assert.ok(got.a[0].global && 'snapshot' in got.a[0].global);
  t.act(a.token, 'note', 'mine');
  const last = got.a.at(-1) as Update;
  assert.ok(last.local && 'patch' in last.local);
  assert.equal(last.global, undefined, 'global did not change, so no global scene is sent');
  assert.deepEqual(views.a.view.local, { notes: ['mine'] });
  assert.deepEqual(views.b.view.local, { notes: [] });
  assert.equal(views.spec.view.local, null);
  assert.ok(got.spec.every((u) => u.local === undefined));
  assert.deepEqual(views.spec.view.global, views.a.view.global);
});

test('a deadline in the store fires as an expire event and moves the turn', () => {
  const { clock, t } = setup();
  t.join('a');
  t.join('b');
  assert.equal((t.store?.game as any).turn, 0);
  clock.advance(999);
  assert.equal((t.store?.game as any).turn, 0);
  clock.advance(1);
  assert.equal((t.store?.game as any).turn, 1);
  clock.advance(1000);
  assert.equal((t.store?.game as any).turn, 0);
  assert.equal(t.record(), null, 'no record before the end: the seed is secret');
});

test('the secret is committed at start, revealed at the end, and the game replays', () => {
  const { clock, t } = setup();
  const a = t.join('a');
  const b = t.join('b');
  const view = new ViewTracker();
  t.watch('', (u) => view.apply(u));
  assert.ok(view.view.commitments.has('secret'));
  assert.ok(view.view.commitments.has('tapis.seed'));
  assert.equal(view.view.revealed.size, 0);
  // Binary search with both players; the opponent's turns are skipped by timeout.
  let lo = 0;
  let hi = 99;
  clock.advance(10);
  while (t.phase === 'playing') {
    const turn = (t.store?.game as any).turn as number;
    const n = Math.floor((lo + hi) / 2);
    const r = t.act(turn === 0 ? a.token : b.token, 'guess', n);
    assert.ok(r.accepted, r.error);
    const hint = (t.store?.game as any).guesses.at(-1).hint;
    if (hint === 'higher') lo = n + 1;
    if (hint === 'lower') hi = n - 1;
    clock.advance(1500);
  }
  assert.equal(view.view.phase, 'finished');
  assert.ok(view.view.revealed.has('secret'));
  assert.ok(view.view.revealed.has('tapis.seed'));
  const rec = t.record();
  assert.ok(rec && rec.events.some((e) => e.type === 'expire'), 'the log carries expire events');
  assert.deepEqual(replay(guess, rec), t.store);
  // A server that lies about the log is caught by the replay.
  const forged = structuredClone(rec);
  const g = forged.events.find((e) => e.type === 'act' && e.action === 'guess');
  if (g && g.type === 'act') g.seat = 1 - g.seat;
  assert.throws(() => replay(guess, forged), /not your turn/);
});

test('a forged reveal fails the client-side check', () => {
  const v = new ViewTracker();
  const base = { version: 1, phase: 'playing' as const, deadlines: [], outcome: null, seats: [] };
  v.apply({ ...base, commitments: [{ id: 's', hash: '00'.repeat(32) }], reveals: [] });
  assert.throws(() => v.apply({ ...base, commitments: [], reveals: [{ id: 's', salt: '00', value: 1 }] }), /does not match/);
});
