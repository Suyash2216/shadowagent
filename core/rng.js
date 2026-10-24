// Deterministic, seedable PRNG (mulberry32) so every simulation is reproducible.
export class RNG {
  constructor(seed = Date.now()) {
    this.state = (Number(seed) >>> 0) || 0x9e3779b9;
  }

  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(p) {
    return this.next() < p;
  }

  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }

  pick(arr) {
    return arr[this.int(arr.length)];
  }
}
