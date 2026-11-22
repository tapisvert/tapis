// sfc32: small, fast, and its whole state is four 32-bit words, which lets the
// store carry it as plain JSON. Seeded from a 128-bit seed (hex).
export type RngState = [number, number, number, number];

export function seedState(seedHex: string): RngState {
  if (!/^[0-9a-f]{32}$/.test(seedHex)) throw new Error('seed must be 32 hex digits');
  const s: number[] = [];
  for (let i = 0; i < 4; i++) s.push(parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0);
  const rng = new Rng(s as RngState);
  for (let i = 0; i < 16; i++) rng.next32(); // decorrelate low-entropy seeds
  return rng.state();
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(state: RngState) {
    [this.#a, this.#b, this.#c, this.#d] = state;
  }

  state(): RngState {
    return [this.#a, this.#b, this.#c, this.#d];
  }

  next32(): number {
    const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
    this.#d = (this.#d + 1) >>> 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) >>> 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
    this.#c = (this.#c + t) >>> 0;
    return t;
  }

  // Uniform integer in [0, n), by rejection so every value is equally likely.
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError('int(n) needs 1 <= n <= 2^32');
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const x = this.next32();
      if (x < limit) return x % n;
    }
  }

  // Fisher-Yates, in place.
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
