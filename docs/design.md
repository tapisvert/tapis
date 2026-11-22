# tapis design

tapis runs board games. A host keeps the authoritative state of each table,
players act through a small gRPC service, and every client, a browser page, a
phone, a terminal or a program, sees the same stream of scene updates.

It is a rewrite of [papan](https://github.com/grumpycoders/papan). It keeps the
game model and drops the framework around it.

## Kept from papan

- **Server-authoritative.** Clients do not compute game state. They send an
  action; the host runs the game's reducer and publishes the result.
- **Reducers over a store.** papan wrapped each game in a redux store whose
  reducer called the game's `transition()`. tapis keeps that shape without
  redux: `reduce(game, store, event)` is a pure function returning a new store
  or throwing `GameError`. The store is plain JSON.
- **Scenes.** A game exposes a global scene everyone sees, spectators
  included, and a local scene per seat. papan's code only ever built the
  public scene (`getPublicScene`, plus an unused `getTemporaryScene`); the
  per-player scene was in its design notes. tapis implements both.
- **The PRNG lives in the store.** papan stored the seedrandom state in the
  store and advanced it on each step, so a game replays from its seed. tapis
  does the same with sfc32 (four 32-bit words, plain JSON).
- **Deadlines are data.** A reducer calls `ctx.setDeadline(id, ms)`; the
  absolute time is written to `store.deadlines`. When it falls due the host
  dispatches an `expire` event, which goes through the reducer like any other.
  Timers are not game logic, so a replay needs no clock.
- **Deltas.** papan sent deep-diff output wrapped in its own protobuf. tapis
  sends JSON Patch (RFC 6902), which every language already has a library for.
  The first update to a watcher is a snapshot; later ones patch the previous
  scene, and a scene that did not change is omitted.

Dropped: Polymer, the IRC-style lobby mesh, the auth
providers, the WebTorrent client layer. papan's game-server `Action` message
was empty ("To be defined") and its `PRNG.range()` throws on every call (the
argument check tests `typeof max === 'number'` where it means `!==`), so dice
and shuffles did not work there; those parts are designed fresh.

## What is new

### Seat tokens

`Join` returns a seat number and a 128-bit seat token. Acting for a seat and
reading its local scene both require the token. Joining again with the token
returns the same seat. A phone that slept reconnects that way. papan's
design accepted a username, so anyone typing the same name took the seat.

### Commit-reveal for server-held secrets

The host is often run by one of the players (the tablet owner, a laptop at the
table), so a secret only the server knows, a deck order or a hidden code, needs
to be checkable afterwards.

- `ctx.commit(id, value)` stores a secret. Every watcher immediately receives
  `sha256(salt || canonical_json(value))`.
- `ctx.reveal(id)` publishes the salt and value; clients check them against
  the commitment and reject a mismatch.
- At start the engine commits to the game seed itself (`tapis.seed`). Game
  salts are derived from the seed, so they are unguessable while it is secret.
- At the end the seed is revealed and `Table.record()` returns the seed, the
  start time and the event log. `replay(game, record)` re-runs the game and
  throws if any recorded event is rejected, which is what a log edited after
  the fact produces.

Open question for hold'em: revealing the seed at the end also reveals mucked
hands. A game that must keep those private will need a per-secret "never
reveal" flag and salts that do not come from the seed.

### gRPC is the interface

[`proto/tapis.proto`](../proto/tapis.proto) is the contract. It has four calls:

| RPC | Does |
| --- | --- |
| `Describe` | game id and version, seat range, who sits where, phase |
| `Join` | takes or reclaims a seat, returns the seat token |
| `Watch` | server stream of `Update`: version, phase, global and local scene, new commitments and reveals, current deadlines, outcome, seats |
| `Act` | runs an action for a seat; optional `expected_version` rejects a stale move |

Game data crosses the wire as JSON text inside the protobuf messages. The
engine does not know any game's schema, and JSON is what every client reads.
Actions are unary calls, so a client can be `grpcurl` and a shell loop.

## The game interface

```ts
interface Game<S> {
  id: string; version: string; minSeats: number; maxSeats: number;
  setup(ctx: Context): S;
  act(state: S, input: { seat; action; args }, ctx: Context): S;  // throw GameError to reject
  expire?(state: S, deadlineId: string, ctx: Context): S;
  globalScene(state: S): Json;
  localScene?(state: S, seat: number): Json;
  outcome(state: S): Outcome | null;
}
```

`Context` gives the seat count, the event time, the seeded `Rng`, deadlines and
secrets. A reducer receives its own copy of the state, so mutating it is safe:
a rejected action leaves the store exactly as it was.

A table starts when its target seat count has joined, or earlier when a seated
player sends `tapis.start` with at least `minSeats` present.

## Layers

```
 game package        pure reducers: setup / act / expire / scenes / outcome
 ------------------------------------------------------------------------
 engine (Table)      store, seats and tokens, deadlines, commit-reveal, diffs
 ------------------------------------------------------------------------
 host (gRPC)         tapis.v1.Table service over one listening port
 ------------------------------------------------------------------------
 lobby / discovery   finding a host, listing its tables, creating one
 transport           TCP on a LAN today; any HTTP/2 transport later
```

The engine stops at the host: give it an address and it serves. Everything
below the host line is left out of this document, and discovery is an open
question. papan never got past a typed URL: its proof of concept played a full
game of tic-tac-toe across two laptops that way, and the SSDP and UPnP
discovery it planned was never built. So a bare `host:port`, with a QR code of
it on the global scene, is the floor tapis keeps; multicast discovery (mDNS or
SSDP), lobbies, and getting game packages to a phone are new work with their
own interface.

## Out of scope

The lobby, discovery and transport layer gets its own design. Its first piece
is LAN discovery: a host advertising its `tapis.v1.Table` endpoint and a client
finding it, with the engine and connect4 as the test bed.

## Ladder

Each game forces one engine piece:

1. connect 4: the core loop, a native terminal client
2. bulls and cows: a server-held secret under commit-reveal
3. dots-and-boxes: a player moving again, turn order owned by the reducer
4. Texas hold'em: three or more seats, phones beside a tablet, timers,
   reconnecting by seat token
5. a deck-building co-op: cards no player has seen, coordination between local
   scenes mid-turn, an effect stack

## Running

```
npm install
npm test
```

Tests run TypeScript directly under Node's type stripping (Node 22.18 or
later). `npm run build` emits `dist/` for packages that depend on tapis.
