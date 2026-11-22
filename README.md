# tapis

A server-authoritative board-game engine. A host runs each table; players and
spectators talk to it over a small gRPC service
([`proto/tapis.proto`](proto/tapis.proto)), so a client can be a web page, a
phone app, a terminal or a script.

A game is a handful of pure functions: `setup`, `act`, an optional `expire`
for deadlines, a global scene, an optional per-seat local scene, and
`outcome`. The engine adds seat tokens, deadlines, a seeded RNG,
commit-reveal for secrets the host holds, JSON Patch deltas, and a replayable
record of every finished game.

Design notes: [`docs/design.md`](docs/design.md). Games live in their own
repositories under [tapisvert](https://github.com/tapisvert), starting with
connect4.

```
npm install
npm test
```

Requires Node 22.18 or later. MIT licensed.
