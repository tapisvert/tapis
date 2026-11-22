import { type Clock, type Game, GameError, type Json } from '../src/index.ts';

// A guessing game exercising every engine piece: a committed secret, turn
// order, a per-turn deadline, private local scenes and an outcome.
export interface GuessState {
  turn: number;
  guesses: { seat: number; n: number; hint: string }[];
  winner: number | null;
  notes: string[][];
}

export const guess: Game<GuessState> = {
  id: 'guess',
  version: '1',
  minSeats: 2,
  maxSeats: 3,
  setup(ctx) {
    ctx.commit('secret', ctx.rng.int(100));
    ctx.setDeadline('turn', 1000);
    return { turn: 0, guesses: [], winner: null, notes: Array.from({ length: ctx.seats }, () => []) };
  },
  act(s, { seat, action, args }, ctx) {
    if (action === 'note') {
      s.notes[seat].push(String(args));
      return s;
    }
    if (action === 'scribble') {
      // Mutates, then rejects: the engine must discard the half-applied copy.
      s.notes[seat].push('half');
      ctx.setDeadline('scribble', 5);
      throw new GameError('scribble is never allowed');
    }
    if (action !== 'guess') throw new GameError(`unknown action ${action}`);
    if (seat !== s.turn) throw new GameError('not your turn');
    const n = args as number;
    if (!Number.isInteger(n) || n < 0 || n > 99) throw new GameError('guess 0-99');
    const secret = ctx.secret('secret') as number;
    const hint = n === secret ? 'hit' : n < secret ? 'higher' : 'lower';
    s.guesses.push({ seat, n, hint });
    if (hint === 'hit') {
      s.winner = seat;
      ctx.reveal('secret');
    } else {
      s.turn = (s.turn + 1) % ctx.seats;
      ctx.setDeadline('turn', 1000);
    }
    return s;
  },
  expire(s, id, ctx) {
    if (id === 'turn') {
      s.turn = (s.turn + 1) % ctx.seats;
      ctx.setDeadline('turn', 1000);
    }
    return s;
  },
  globalScene: (s) => ({ turn: s.turn, guesses: s.guesses, winner: s.winner }) as unknown as Json,
  localScene: (s, seat) => ({ notes: s.notes[seat] }),
  outcome: (s) => (s.winner === null ? null : { winners: [s.winner], draw: false }),
};

export class FakeClock implements Clock {
  t = 1_000_000;
  #timers: { at: number; fn: () => void; h: number }[] = [];
  #next = 1;
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const h = this.#next++;
    this.#timers.push({ at: this.t + ms, fn, h });
    return h;
  }
  clearTimer(h: unknown): void {
    this.#timers = this.#timers.filter((x) => x.h !== h);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.#timers.sort((a, b) => a.at - b.at);
      const due = this.#timers[0];
      if (!due || due.at > end) break;
      this.#timers.shift();
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

// Deterministic entropy: a counter, hex-encoded.
export function counterEntropy(): (n: number) => string {
  let i = 0;
  return (n) => (i++).toString(16).padStart(n * 2, '0');
}
