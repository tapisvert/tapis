export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Canonical JSON: object keys sorted, no whitespace. Two equal values always
// produce the same text, so a hash over it is a commitment to the value.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('non-finite number in JSON value');
    }
    if (value === undefined) throw new TypeError('undefined in JSON value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function isPlainObject(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
