import * as grpc from '@grpc/grpc-js';
import { verifyReveal } from './commit.ts';
import { applyPatch } from './diff.ts';
import type { Json } from './json.ts';
import { loadTapis } from './proto.ts';
import type { ActResult, Phase, Scene, SeatInfo, Update } from './table.ts';
import { phaseFromWire, updateFromWire } from './wire.ts';

type Any = Record<string, any>;

export interface View {
  version: number;
  phase: Phase;
  global: Json;
  local: Json;
  seats: SeatInfo[];
  deadlines: { id: string; at: number }[];
  outcome: Update['outcome'];
  commitments: Map<string, string>;
  revealed: Map<string, Json>;
}

// Folds a stream of Updates into the current view, checking every reveal
// against the commitment received for it. Usable by any client, native or not.
export class ViewTracker {
  view: View = {
    version: 0,
    phase: 'waiting',
    global: null,
    local: null,
    seats: [],
    deadlines: [],
    outcome: null,
    commitments: new Map(),
    revealed: new Map(),
  };

  apply(u: Update): View {
    const v = this.view;
    const fold = (prev: Json, s: Scene | undefined) => (!s ? prev : 'snapshot' in s ? s.snapshot : applyPatch(prev, s.patch));
    v.global = fold(v.global, u.global);
    v.local = fold(v.local, u.local);
    v.version = u.version;
    v.phase = u.phase;
    v.seats = u.seats;
    v.deadlines = u.deadlines;
    v.outcome = u.outcome;
    for (const c of u.commitments) v.commitments.set(c.id, c.hash);
    for (const r of u.reveals) {
      const hash = v.commitments.get(r.id);
      if (!hash || !verifyReveal(hash, r.salt, r.value)) throw new Error(`reveal ${r.id} does not match its commitment`);
      v.revealed.set(r.id, r.value);
    }
    return v;
  }
}

function promisify<T>(fn: (cb: (err: grpc.ServiceError | null, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));
}

export class TapisClient {
  #stub: Any;
  readonly tableId: string;
  token = '';
  seat = -1;

  constructor(address: string, tableId: string) {
    const v1 = loadTapis();
    const Ctor = v1.Table as grpc.ServiceClientConstructor;
    this.#stub = new Ctor(address, grpc.credentials.createInsecure());
    this.tableId = tableId;
  }

  async describe(): Promise<Any & { phase: Phase }> {
    const r = await promisify<Any>((cb) => this.#stub.Describe({ table_id: this.tableId }, cb));
    return { ...r, phase: phaseFromWire(r.phase) };
  }

  async join(name: string, token = ''): Promise<{ seat: number; token: string }> {
    const r = await promisify<Any>((cb) => this.#stub.Join({ table_id: this.tableId, name, seat_token: token }, cb));
    this.token = r.seat_token;
    this.seat = r.seat;
    return { seat: r.seat, token: r.seat_token };
  }

  async act(action: string, args: Json = null, expectedVersion = 0): Promise<ActResult> {
    const r = await promisify<Any>((cb) =>
      this.#stub.Act(
        { table_id: this.tableId, seat_token: this.token, action, args_json: JSON.stringify(args), expected_version: expectedVersion },
        cb,
      ),
    );
    return { accepted: r.accepted, error: r.error || undefined, version: r.version };
  }

  // Calls onView for every update until the returned function is called.
  watch(onView: (v: View) => void, onError?: (e: Error) => void, spectator = false): () => void {
    const tracker = new ViewTracker();
    const call = this.#stub.Watch({ table_id: this.tableId, seat_token: spectator ? '' : this.token });
    call.on('data', (w: Any) => {
      try {
        onView(tracker.apply(updateFromWire(w as any)));
      } catch (e) {
        onError?.(e as Error);
        call.cancel();
      }
    });
    call.on('error', (e: grpc.ServiceError) => {
      if (e.code !== grpc.status.CANCELLED) onError?.(e);
    });
    return () => call.cancel();
  }

  close(): void {
    this.#stub.close();
  }
}
