// Conversion between the engine's Update and the protobuf messages.
import type { PatchOp } from './diff.ts';
import type { Json } from './json.ts';
import type { Phase, Scene, SeatInfo, Update } from './table.ts';

const PHASES: Record<Phase, string> = {
  waiting: 'PHASE_WAITING',
  playing: 'PHASE_PLAYING',
  finished: 'PHASE_FINISHED',
};

export function phaseToWire(p: Phase): string {
  return PHASES[p];
}

export function phaseFromWire(p: string): Phase {
  const hit = (Object.keys(PHASES) as Phase[]).find((k) => PHASES[k] === p);
  if (!hit) throw new Error(`unknown phase ${p}`);
  return hit;
}

type WireScene = { snapshot_json?: string; patch?: { ops: { op: string; path: string; value_json: string }[] }; body?: string };

function sceneToWire(s: Scene | undefined): WireScene | null {
  if (!s) return null;
  if ('snapshot' in s) return { snapshot_json: JSON.stringify(s.snapshot) };
  return {
    patch: {
      ops: s.patch.map((o) => ({ op: o.op, path: o.path, value_json: o.op === 'remove' ? '' : JSON.stringify(o.value) })),
    },
  };
}

function sceneFromWire(s: WireScene | null | undefined): Scene | undefined {
  if (!s || !s.body) return undefined;
  if (s.body === 'snapshot_json') return { snapshot: JSON.parse(s.snapshot_json as string) as Json };
  return {
    patch: (s.patch?.ops ?? []).map((o) => {
      const op: PatchOp = { op: o.op as PatchOp['op'], path: o.path };
      if (o.op !== 'remove') op.value = JSON.parse(o.value_json) as Json;
      return op;
    }),
  };
}

export function updateToWire(u: Update): object {
  return {
    version: u.version,
    phase: phaseToWire(u.phase),
    global: sceneToWire(u.global),
    local: sceneToWire(u.local),
    commitments: u.commitments.map((c) => ({ id: c.id, hash_hex: c.hash })),
    reveals: u.reveals.map((r) => ({ id: r.id, salt_hex: r.salt, value_json: JSON.stringify(r.value) })),
    deadlines: u.deadlines.map((d) => ({ id: d.id, at_unix_ms: d.at })),
    outcome: u.outcome,
    seats: u.seats,
  };
}

interface WireUpdate {
  version: number;
  phase: string;
  global?: WireScene | null;
  local?: WireScene | null;
  commitments: { id: string; hash_hex: string }[];
  reveals: { id: string; salt_hex: string; value_json: string }[];
  deadlines: { id: string; at_unix_ms: number }[];
  outcome?: { winners: number[]; draw: boolean } | null;
  seats: SeatInfo[];
}

export function updateFromWire(w: WireUpdate): Update {
  return {
    version: w.version,
    phase: phaseFromWire(w.phase),
    global: sceneFromWire(w.global),
    local: sceneFromWire(w.local),
    commitments: w.commitments.map((c) => ({ id: c.id, hash: c.hash_hex })),
    reveals: w.reveals.map((r) => ({ id: r.id, salt: r.salt_hex, value: JSON.parse(r.value_json) as Json })),
    deadlines: w.deadlines.map((d) => ({ id: d.id, at: d.at_unix_ms })),
    outcome: w.outcome ?? null,
    seats: w.seats,
  };
}
