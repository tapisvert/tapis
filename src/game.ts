import type { Json } from './json.ts';
import type { Rng } from './rng.ts';

export interface Outcome {
  winners: number[];
  draw: boolean;
}

// What a game's reducer may ask of the engine. Everything here is recorded in
// the store, so a game replays exactly from its seed and its event log.
export interface Context {
  readonly seats: number;
  readonly now: number;      // ms, the time of the event being reduced
  readonly rng: Rng;
  setDeadline(id: string, inMs: number): void;
  clearDeadline(id: string): void;
  // Hold a value the players may not see yet; its hash goes out at once.
  commit(id: string, value: Json): void;
  reveal(id: string): void;
  secret(id: string): Json;
}

export interface ActInput {
  seat: number;
  action: string;
  args: Json;
}

// A game is a set of pure functions over its own state S. act() and expire()
// receive a private copy of the state and may mutate it or return a new one.
// Rejecting an action means throwing a GameError.
export interface Game<S = Json> {
  id: string;
  version: string;
  minSeats: number;
  maxSeats: number;
  setup(ctx: Context): S;
  act(state: S, input: ActInput, ctx: Context): S;
  expire?(state: S, deadlineId: string, ctx: Context): S;
  globalScene(state: S): Json;
  localScene?(state: S, seat: number): Json;
  outcome(state: S): Outcome | null;
}

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}
