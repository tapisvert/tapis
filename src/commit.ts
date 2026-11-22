import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, type Json } from './json.ts';

export function commitmentHash(saltHex: string, value: Json): string {
  return createHash('sha256').update(Buffer.from(saltHex, 'hex')).update(canonicalJson(value)).digest('hex');
}

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

// What a client runs on a Reveal against the Commitment it received earlier.
export function verifyReveal(hashHex: string, saltHex: string, value: Json): boolean {
  return commitmentHash(saltHex, value) === hashHex;
}
