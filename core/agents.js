// Agents operate on featurised candidate actions supplied by the environment,
// which keeps them topology-agnostic and identical across JS and Python.
import { RNG } from './rng.js';

const dot = (w, x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += w[i] * x[i];
  return s;
};

export class LinearQAgent {
  constructor({ side, dim, alpha = 0.01, gamma = 0.95, epsilon = 0.3, epsilonMin = 0.05, epsilonDecay = 0.995, seed = 7, weights } = {}) {
    this.side = side;
    this.dim = dim;
    this.alpha = alpha;
    this.gamma = gamma;
    this.epsilon = epsilon;
    this.epsilonMin = epsilonMin;
    this.epsilonDecay = epsilonDecay;
    this.rng = new RNG(seed);
    this.w = weights ? [...weights] : new Array(dim).fill(0);
    this.kind = 'linear-q';
  }

  q(features) {
    return dot(this.w, features);
  }

  act(candidates, { explore = true } = {}) {
    if (explore && this.rng.chance(this.epsilon)) return this.rng.pick(candidates);
    let best = candidates[0];
    let bestQ = -Infinity;
    for (const c of candidates) {
      const v = this.q(c.features) + this.rng.next() * 1e-6; // random tie-break
      if (v > bestQ) {
        bestQ = v;
        best = c;
      }
    }
    return best;
  }

  // Semi-gradient Q-learning (Sutton & Barto, ch. 10) with TD-error clipping.
  update(features, reward, nextCandidates, done) {
    let target = reward;
    if (!done && nextCandidates?.length) {
      target += this.gamma * Math.max(...nextCandidates.map((c) => this.q(c.features)));
    }
    const td = Math.max(-10, Math.min(10, target - this.q(features)));
    for (let i = 0; i < this.w.length; i++) this.w[i] += this.alpha * td * features[i];
    return td;
  }

  endEpisode() {
    this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
  }

  toJSON() {
    return { side: this.side, kind: this.kind, dim: this.dim, epsilon: this.epsilon, weights: this.w };
  }
}

export class RandomAgent {
  constructor({ side, seed = 3 } = {}) {
    this.side = side;
    this.rng = new RNG(seed);
    this.kind = 'random';
  }

  act(candidates) {
    return this.rng.pick(candidates);
  }

  update() {}

  endEpisode() {}
}

// Scripted baselines used for comparison and as sparring partners.
export class HeuristicRedAgent {
  constructor({ seed = 5 } = {}) {
    this.side = 'red';
    this.rng = new RNG(seed);
    this.kind = 'heuristic';
  }

  act(candidates) {
    const score = (c) => {
      const [, value, vuln, critical, newCreds, privMet, , heat, closeness] = c.features.slice(this.offset(c), this.offset(c) + 10);
      switch (c.verb) {
        case 'sabotage': return privMet && (critical || value >= 0.4) ? 5 + value * 10 + critical * 5 : -5;
        case 'harvest': return newCreds ? 4 : -2;
        case 'escalate': return privMet ? -1 : 1.5 + critical * 2;
        case 'exploit': return 1 + vuln * 2 + closeness * 3 + value * 2 - heat * 2;
        case 'scan': return 0.5 + closeness;
        default: return heat > 0.5 ? 1 : -1;
      }
    };
    let best = candidates[0];
    let bestS = -Infinity;
    for (const c of candidates) {
      const s = score(c) + this.rng.next() * 0.5;
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    return best;
  }

  offset(c) {
    const firstNonZero = c.features.findIndex((v) => v !== 0);
    return firstNonZero - (firstNonZero % 10);
  }

  update() {}

  endEpisode() {}
}

export class HeuristicBlueAgent {
  constructor({ seed = 9 } = {}) {
    this.side = 'blue';
    this.rng = new RNG(seed);
    this.kind = 'heuristic';
  }

  act(candidates) {
    const score = (c) => {
      const off = c.features.findIndex((v) => v !== 0);
      const f = c.features.slice(off - (off % 10), off - (off % 10) + 10);
      const [, susp, monitored, isolated, sabotaged, critical, value, nbMax, recent, hpLeft] = f;
      switch (c.verb) {
        case 'isolate': return susp > 0.55 && !isolated ? 4 + susp * 4 : -3;
        case 'restore': return sabotaged ? 5 + value * 3 : susp > 0.45 ? 3 : -2;
        case 'investigate': return susp > 0.25 ? 2 + susp * 3 + recent : -1;
        case 'monitor': return monitored ? -2 : critical * 1.5 + nbMax * 2 + value;
        case 'honeypot': return hpLeft > 0 ? critical * 2 + nbMax * 3 : -3;
        default: return 0.2;
      }
    };
    let best = candidates[0];
    let bestS = -Infinity;
    for (const c of candidates) {
      const s = score(c) + this.rng.next() * 0.3;
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    return best;
  }

  update() {}

  endEpisode() {}
}

export function makeAgent(side, kind, { dim, weights, seed } = {}) {
  if (kind === 'random') return new RandomAgent({ side, seed });
  if (kind === 'heuristic') return side === 'red' ? new HeuristicRedAgent({ seed }) : new HeuristicBlueAgent({ seed });
  return new LinearQAgent({ side, dim, weights, seed, epsilon: weights ? 0 : 0.3 });
}
