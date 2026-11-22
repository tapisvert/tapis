import { randomBytes } from 'node:crypto';
import { type PatchOp, diff } from './diff.ts';
import { type Game, GameError, type Outcome } from './game.ts';
import type { Json } from './json.ts';
import { type Event, type Store, commitmentsOf, createStore, reduce } from './store.ts';

export type Phase = 'waiting' | 'playing' | 'finished';
export type Scene = { snapshot: Json } | { patch: PatchOp[] };

export interface SeatInfo {
  seat: number;
  name: string;
  connected: boolean;
}

export interface Update {
  version: number;
  phase: Phase;
  global?: Scene;
  local?: Scene;
  commitments: { id: string; hash: string }[];
  reveals: { id: string; salt: string; value: Json }[];
  deadlines: { id: string; at: number }[];
  outcome: Outcome | null;
  seats: SeatInfo[];
}

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface TableOptions {
  id?: string;
  seats?: number;               // start automatically when this many have joined
  clock?: Clock;
  entropy?: (bytes: number) => string; // hex; tests inject a fixed one
}

export interface ActResult {
  accepted: boolean;
  error?: string;
  version: number;
}

interface Seat {
  name: string;
  token: string;
  watchers: number;
}

interface Watcher {
  seat: number | null;
  send: (u: Update) => void;
  global?: Json;
  local?: Json;
  commitments: Set<string>;
  reveals: Set<string>;
}

export const START_ACTION = 'tapis.start';

// Everything needed to re-run a finished game and check the server played it
// straight: the seed (revealed at the end), its salt, the start time and the
// event log.
export interface Record_ {
  gameId: string;
  gameVersion: string;
  seats: number;
  seed: string;
  seedSalt: string;
  startedAt: number;
  events: Event[];
}

export class Table<S = Json> {
  readonly id: string;
  readonly game: Game<S>;
  readonly target: number;
  #clock: Clock;
  #entropy: (bytes: number) => string;
  #seats: Seat[] = [];
  #store: Store<S> | null = null;
  #seed = '';
  #seedSalt = '';
  #startedAt = 0;
  #events: Event[] = [];
  #watchers = new Set<Watcher>();
  #timers: unknown[] = [];

  constructor(game: Game<S>, opts: TableOptions = {}) {
    this.game = game;
    this.#clock = opts.clock ?? systemClock;
    this.#entropy = opts.entropy ?? ((n) => randomBytes(n).toString('hex'));
    this.id = opts.id ?? this.#entropy(8);
    this.target = opts.seats ?? game.maxSeats;
    if (this.target < game.minSeats || this.target > game.maxSeats) {
      throw new RangeError(`${game.id} takes ${game.minSeats}-${game.maxSeats} seats`);
    }
  }

  get phase(): Phase {
    if (!this.#store) return 'waiting';
    return this.#store.finished ? 'finished' : 'playing';
  }

  get version(): number {
    return this.#store?.version ?? 0;
  }

  get store(): Readonly<Store<S>> | null {
    return this.#store;
  }

  seats(): SeatInfo[] {
    return this.#seats.map((s, seat) => ({ seat, name: s.name, connected: s.watchers > 0 }));
  }

  // Only meaningful once finished: before that the seed is still secret.
  record(): Record_ | null {
    if (this.phase !== 'finished') return null;
    return {
      gameId: this.game.id,
      gameVersion: this.game.version,
      seats: this.#seats.length,
      seed: this.#seed,
      seedSalt: this.#seedSalt,
      startedAt: this.#startedAt,
      events: structuredClone(this.#events),
    };
  }

  #seatOf(token: string): number {
    if (!token) return -1;
    return this.#seats.findIndex((s) => s.token === token);
  }

  join(name: string, token = ''): { seat: number; token: string } {
    if (token) {
      const seat = this.#seatOf(token);
      if (seat < 0) throw new GameError('unknown seat token');
      if (name) this.#seats[seat].name = name;
      this.#broadcast();
      return { seat, token };
    }
    if (this.phase !== 'waiting') throw new GameError('game already started; watch as a spectator');
    if (this.#seats.length >= this.target) throw new GameError('table is full');
    const seat = this.#seats.length;
    const fresh = this.#entropy(16);
    this.#seats.push({ name: name || `seat ${seat}`, token: fresh, watchers: 0 });
    if (this.#seats.length === this.target) this.#start();
    else this.#broadcast();
    return { seat, token: fresh };
  }

  #start(): void {
    this.#seed = this.#entropy(16);
    this.#seedSalt = this.#entropy(16);
    this.#startedAt = this.#clock.now();
    this.#store = createStore(this.game, this.#seats.length, this.#seed, this.#seedSalt, this.#startedAt);
    this.#afterChange();
  }

  act(token: string, action: string, args: Json, expectedVersion = 0): ActResult {
    const seat = this.#seatOf(token);
    if (seat < 0) return { accepted: false, error: 'unknown seat token', version: this.version };
    if (action === START_ACTION) {
      if (this.phase !== 'waiting') return { accepted: false, error: 'already started', version: this.version };
      if (this.#seats.length < this.game.minSeats) return { accepted: false, error: 'not enough players', version: this.version };
      this.#start();
      return { accepted: true, version: this.version };
    }
    if (!this.#store) return { accepted: false, error: 'game has not started', version: 0 };
    if (expectedVersion && expectedVersion !== this.#store.version) {
      return { accepted: false, error: `stale: table is at version ${this.#store.version}`, version: this.#store.version };
    }
    return this.#dispatch({ type: 'act', at: this.#clock.now(), seat, action, args });
  }

  #dispatch(event: Event): ActResult {
    const store = this.#store as Store<S>;
    try {
      this.#store = reduce(this.game, store, event);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { accepted: false, error, version: store.version };
    }
    this.#events.push(event);
    this.#afterChange();
    return { accepted: true, version: (this.#store as Store<S>).version };
  }

  #afterChange(): void {
    for (const t of this.#timers) this.#clock.clearTimer(t);
    this.#timers = [];
    const store = this.#store;
    if (store && !store.finished) {
      for (const [id, at] of Object.entries(store.deadlines)) {
        const delay = Math.max(0, at - this.#clock.now());
        this.#timers.push(this.#clock.setTimer(() => this.#fire(id), delay));
      }
    }
    this.#broadcast();
  }

  #fire(id: string): void {
    const store = this.#store;
    if (!store || !(id in store.deadlines)) return;
    // A timer may wake a little early; the reducer refuses, so re-arm.
    const at = Math.max(this.#clock.now(), store.deadlines[id]);
    const r = this.#dispatch({ type: 'expire', at, id });
    if (!r.accepted) this.#afterChange();
  }

  watch(token: string, send: (u: Update) => void): () => void {
    let seat: number | null = null;
    if (token) {
      seat = this.#seatOf(token);
      if (seat < 0) throw new GameError('unknown seat token');
    }
    const w: Watcher = { seat, send, commitments: new Set(), reveals: new Set() };
    this.#watchers.add(w);
    if (seat !== null) this.#seats[seat].watchers++;
    this.#broadcast();
    return () => {
      if (!this.#watchers.delete(w)) return;
      if (seat !== null) this.#seats[seat].watchers--;
      this.#broadcast();
    };
  }

  #broadcast(): void {
    for (const w of this.#watchers) w.send(this.#updateFor(w));
  }

  #updateFor(w: Watcher): Update {
    const store = this.#store;
    const u: Update = {
      version: this.version,
      phase: this.phase,
      commitments: [],
      reveals: [],
      deadlines: [],
      outcome: store?.outcome ?? null,
      seats: this.seats(),
    };
    if (!store) return u;
    const scene = (prev: Json | undefined, next: Json): [Scene | undefined, Json] => {
      if (prev === undefined) return [{ snapshot: next }, next];
      const ops = diff(prev, next);
      return [ops.length ? { patch: ops } : undefined, next];
    };
    [u.global, w.global] = scene(w.global, this.game.globalScene(store.game));
    if (w.seat !== null && this.game.localScene) {
      [u.local, w.local] = scene(w.local, this.game.localScene(store.game, w.seat));
    }
    for (const c of commitmentsOf(store as Store<unknown>)) {
      if (!w.commitments.has(c.id)) {
        w.commitments.add(c.id);
        u.commitments.push(c);
      }
    }
    for (const [id, s] of Object.entries(store.secrets)) {
      if (s.revealed && !w.reveals.has(id)) {
        w.reveals.add(id);
        u.reveals.push({ id, salt: s.salt, value: s.value });
      }
    }
    u.deadlines = Object.entries(store.deadlines).map(([id, at]) => ({ id, at }));
    return u;
  }
}

// Re-runs a finished game from its record. Throws if any recorded event is
// rejected, which is what a cheating server would produce.
export function replay<S>(game: Game<S>, rec: Record_): Store<S> {
  let store = createStore(game, rec.seats, rec.seed, rec.seedSalt, rec.startedAt);
  for (const e of rec.events) store = reduce(game, store, e);
  return store;
}
