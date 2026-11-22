import { type Json, isPlainObject } from './json.ts';

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: Json;
}

function escape(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => equal(v, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && equal(a[k], b[k]));
  }
  return false;
}

// JSON Patch (RFC 6902) turning `from` into `to`. Arrays are patched by
// index: common prefix in place, tail appended or removed from the end.
export function diff(from: Json, to: Json, path = ''): PatchOp[] {
  if (equal(from, to)) return [];
  if (isPlainObject(from) && isPlainObject(to)) {
    const ops: PatchOp[] = [];
    for (const k of Object.keys(from)) {
      if (!(k in to)) ops.push({ op: 'remove', path: path + '/' + escape(k) });
    }
    for (const k of Object.keys(to)) {
      const p = path + '/' + escape(k);
      if (k in from) ops.push(...diff(from[k], to[k], p));
      else ops.push({ op: 'add', path: p, value: to[k] });
    }
    return ops;
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const ops: PatchOp[] = [];
    const common = Math.min(from.length, to.length);
    for (let i = 0; i < common; i++) ops.push(...diff(from[i], to[i], path + '/' + i));
    for (let i = from.length - 1; i >= to.length; i--) ops.push({ op: 'remove', path: path + '/' + i });
    for (let i = from.length; i < to.length; i++) ops.push({ op: 'add', path: path + '/' + i, value: to[i] });
    return ops;
  }
  return [{ op: 'replace', path, value: to }];
}

// Applies a patch produced by diff(). Returns the new document; the input is
// not modified.
export function applyPatch(doc: Json, ops: readonly PatchOp[]): Json {
  let root: Json = structuredClone(doc);
  for (const op of ops) {
    if (op.path === '') {
      if (op.op === 'remove') throw new Error('cannot remove the document root');
      root = structuredClone(op.value as Json);
      continue;
    }
    const tokens = op.path.split('/').slice(1).map(unescape);
    const last = tokens.pop() as string;
    let parent: Json = root;
    for (const t of tokens) {
      parent = Array.isArray(parent) ? parent[Number(t)] : (parent as Record<string, Json>)[t];
      if (parent === undefined || parent === null || typeof parent !== 'object') {
        throw new Error(`patch path ${op.path} does not resolve`);
      }
    }
    const value = structuredClone(op.value as Json);
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last);
      if (op.op === 'add') parent.splice(i, 0, value);
      else if (op.op === 'remove') parent.splice(i, 1);
      else parent[i] = value;
    } else {
      const obj = parent as Record<string, Json>;
      if (op.op === 'remove') delete obj[last];
      else obj[last] = value;
    }
  }
  return root;
}
