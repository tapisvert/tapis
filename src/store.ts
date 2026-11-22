import { createHash } from 'node:crypto';
import { commitmentHash } from './commit.ts';
import { type Context, type Game, GameError, type Outcome } from './game.ts';
import type { Json } from './json.ts';
import { Rng, type RngState, seedState } from './rng.ts';

export const SEED_ID = 'tapis.seed';

export interface Secret {
  value: Json;
  salt: string;
  revealed: boolean;
}

// The whole table state. Plain JSON, so it can be persisted and replayed.
export interface Store<S = Json> {
  version: number;
  finished: boolean;
  now: number;
  seats: number;
  game: S;
  rng: RngState;
  deadlines: Record<string, number>;
  secrets: Record<string, Secret>;
  outcome: Outcome | null;
}

export type Event =
  | { type: 'act'; at: number; seat: number; action: string; args: Json }
  | { type: 'expire'; at: number; id: string };

// Salts for game commitments come from the seed, so they are unguessable
// while the seed is secret and checkable once it is revealed.
function derivedSalt(seedHex: string, id: string): string {
  return createHash('sha256').update('tapis-salt\0').update(seedHex).update('\0').update(id).digest('hex').slice(0, 32);
}

function makeContext(store: Store<unknown>, rng: Rng): Context {
  const seed = store.secrets[SEED_ID].value as string;
  return {
    seats: store.seats,
    now: store.now,
    rng,
    setDeadline(id, inMs) {
      if (!(inMs >= 0)) throw new RangeError('deadline must not be in the past');
      store.deadlines[id] = store.now + inMs;
    },
    clearDeadline(id) {
      delete store.deadlines[id];
    },
    commit(id, value) {
      if (id.startsWith('tapis.')) throw new Error('the tapis. prefix is reserved');
      if (id in store.secrets) throw new Error(`secret ${id} already committed`);
      store.secrets[id] = { value, salt: derivedSalt(seed, id), revealed: false };
    },
    reveal(id) {
      const s = store.secrets[id];
      if (!s || id === SEED_ID) throw new Error(`no secret ${id} to reveal`);
      s.revealed = true;
    },
    secret(id) {
      const s = store.secrets[id];
      if (!s || id === SEED_ID) throw new Error(`no secret ${id}`);
      return s.value;
    },
  };
}

function settle<S>(game: Game<S>, store: Store<S>): Store<S> {
  const outcome = game.outcome(store.game);
  if (outcome) {
    store.finished = true;
    store.outcome = outcome;
    store.deadlines = {};
    store.secrets[SEED_ID].revealed = true;
  }
  return store;
}

export function createStore<S>(game: Game<S>, seats: number, seedHex: string, seedSalt: string, at: number): Store<S> {
  if (seats < game.minSeats || seats > game.maxSeats) throw new RangeError(`${game.id} seats ${game.minSeats}-${game.maxSeats}`);
  const store: Store<unknown> = {
    version: 1,
    finished: false,
    now: at,
    seats,
    game: null,
    rng: seedState(seedHex),
    deadlines: {},
    secrets: { [SEED_ID]: { value: seedHex, salt: seedSalt, revealed: false } },
    outcome: null,
  };
  const rng = new Rng(store.rng);
  store.game = game.setup(makeContext(store, rng));
  store.rng = rng.state();
  return settle(game, store as Store<S>);
}

// The reducer. Returns a new store, never touches the old one, and throws
// GameError when the event is rejected.
export function reduce<S>(game: Game<S>, prev: Store<S>, event: Event): Store<S> {
  if (prev.finished) throw new GameError('game is over');
  const store = structuredClone(prev);
  store.now = Math.max(prev.now, event.at);
  const rng = new Rng(store.rng);
  const ctx = makeContext(store as Store<unknown>, rng);
  if (event.type === 'act') {
    if (!Number.isInteger(event.seat) || event.seat < 0 || event.seat >= store.seats) throw new GameError('no such seat');
    store.game = game.act(store.game, { seat: event.seat, action: event.action, args: event.args }, ctx);
  } else {
    if (!(event.id in store.deadlines)) throw new GameError(`no deadline ${event.id}`);
    if (store.deadlines[event.id] > event.at) throw new GameError(`deadline ${event.id} not due`);
    delete store.deadlines[event.id];
    if (!game.expire) throw new GameError(`${game.id} has no expire handler`);
    store.game = game.expire(store.game, event.id, ctx);
  }
  store.rng = rng.state();
  store.version = prev.version + 1;
  return settle(game, store);
}

export function commitmentsOf(store: Store<unknown>): { id: string; hash: string }[] {
  return Object.entries(store.secrets).map(([id, s]) => ({ id, hash: commitmentHash(s.salt, s.value) }));
}
