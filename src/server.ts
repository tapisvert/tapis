import * as grpc from '@grpc/grpc-js';
import type { Json } from './json.ts';
import { loadTapis } from './proto.ts';
import type { Table } from './table.ts';
import { phaseToWire, updateToWire } from './wire.ts';

type Any = Record<string, any>;

// A host: a set of tables served over one gRPC port. Lobby, discovery and
// transport choices sit above this; the host only needs a listening address.
export class Host {
  readonly server = new grpc.Server();
  #tables = new Map<string, Table<any>>();

  constructor() {
    const v1 = loadTapis();
    const service = (v1.Table as grpc.ServiceClientConstructor).service;
    this.server.addService(service, {
      Describe: (call: grpc.ServerUnaryCall<Any, Any>, cb: grpc.sendUnaryData<Any>) =>
        this.#unary(call, cb, (t) => ({
          table_id: t.id,
          game_id: t.game.id,
          game_version: t.game.version,
          min_seats: t.game.minSeats,
          max_seats: t.target,
          seats: t.seats(),
          phase: phaseToWire(t.phase),
        })),
      Join: (call: grpc.ServerUnaryCall<Any, Any>, cb: grpc.sendUnaryData<Any>) =>
        this.#unary(call, cb, (t, req) => {
          const r = t.join(req.name, req.seat_token);
          return { seat: r.seat, seat_token: r.token };
        }),
      Act: (call: grpc.ServerUnaryCall<Any, Any>, cb: grpc.sendUnaryData<Any>) =>
        this.#unary(call, cb, (t, req) => {
          let args: Json = null;
          if (req.args_json) args = JSON.parse(req.args_json) as Json;
          const r = t.act(req.seat_token, req.action, args, req.expected_version);
          return { accepted: r.accepted, error: r.error ?? '', version: r.version };
        }),
      Watch: (call: grpc.ServerWritableStream<Any, Any>) => {
        const t = this.#tables.get(call.request.table_id);
        if (!t) {
          call.destroy(Object.assign(new Error('no such table'), { code: grpc.status.NOT_FOUND }));
          return;
        }
        let stop: (() => void) | undefined;
        try {
          stop = t.watch(call.request.seat_token, (u) => call.write(updateToWire(u)));
        } catch (e) {
          call.destroy(Object.assign(new Error((e as Error).message), { code: grpc.status.PERMISSION_DENIED }));
          return;
        }
        const end = () => stop?.();
        call.on('cancelled', end);
        call.on('close', end);
        call.on('error', end);
      },
    });
  }

  #unary(call: grpc.ServerUnaryCall<Any, Any>, cb: grpc.sendUnaryData<Any>, fn: (t: Table<any>, req: Any) => Any): void {
    const t = this.#tables.get(call.request.table_id);
    if (!t) {
      cb({ code: grpc.status.NOT_FOUND, details: 'no such table' });
      return;
    }
    try {
      cb(null, fn(t, call.request));
    } catch (e) {
      cb({ code: grpc.status.FAILED_PRECONDITION, details: (e as Error).message });
    }
  }

  add(table: Table<any>): void {
    this.#tables.set(table.id, table);
  }

  // Resolves to the bound port (useful with port 0).
  listen(address: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.tryShutdown(() => resolve()));
  }
}
