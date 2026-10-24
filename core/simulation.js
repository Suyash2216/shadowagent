// Episode runner and MARL self-play training loop (independent learners).
import { ShadowAgentEnv } from './environment.js';
import { HeuristicBlueAgent, HeuristicRedAgent, LinearQAgent, makeAgent } from './agents.js';
import { RNG } from './rng.js';

export function runEpisode(env, red, blue, { learn = false, record = true, seed } = {}) {
  env.reset(seed ?? env.config.seed);
  const frames = record ? [env.frame()] : [];
  let redCands = env.candidates('red');
  let blueCands = env.candidates('blue');
  const tdErrors = [];

  while (!env.state.done) {
    const ra = red.act(redCands, { explore: learn });
    const ba = blue.act(blueCands, { explore: learn });
    const res = env.step(ra.id, ba.id);
    const nextRed = res.done ? [] : env.candidates('red');
    const nextBlue = res.done ? [] : env.candidates('blue');
    if (learn) {
      tdErrors.push(Math.abs(red.update(ra.features, res.reward.red, nextRed, res.done) ?? 0));
      blue.update(ba.features, res.reward.blue, nextBlue, res.done);
    }
    redCands = nextRed;
    blueCands = nextBlue;
    if (record) frames.push(env.frame());
  }
  if (learn) {
    red.endEpisode();
    blue.endEpisode();
  }

  const result = { summary: env.summary() };
  if (record) {
    result.frames = frames;
    result.auditLog = env.auditLog;
    result.attackGraph = env.attackGraph;
    result.topology = { nodes: env.nodes, edges: env.edges, entryPoints: env.entryPoints, name: env.topologyName };
  } else {
    result.attackGraph = env.attackGraph;
    result.auditLog = env.auditLog;
  }
  result.meanTd = tdErrors.length ? tdErrors.reduce((a, b) => a + b, 0) / tdErrors.length : 0;
  return result;
}

export function buildAgents(env, { red = 'trained', blue = 'trained', policies = {}, seed = 1 } = {}) {
  const mk = (side, kind) => {
    if (kind === 'trained' && policies[side]?.weights?.length === env.featureSize(side)) {
      return makeAgent(side, 'linear', { dim: env.featureSize(side), weights: policies[side].weights, seed });
    }
    if (kind === 'trained' || kind === 'learning') {
      return makeAgent(side, 'linear', { dim: env.featureSize(side), seed });
    }
    return makeAgent(side, kind, { seed });
  };
  return { red: mk('red', red), blue: mk('blue', blue) };
}

// Independent-learner self-play: both policies are updated every step against
// each other, approximating the competitive Markov game between the teams.
export function trainSelfPlay({ scenario = 'small', episodes = 2000, seed = 1, policies = {}, maxSteps, opponentMix = 0.5, hyper = {}, onProgress } = {}) {
  const env = new ShadowAgentEnv({ scenario, seed, ...(maxSteps ? { maxSteps } : {}) });
  // Blue learns with a smaller step size: its reward is noisier (false positives,
  // delayed impact), and larger steps made the defender policy oscillate.
  const red = new LinearQAgent({ side: 'red', dim: env.featureSize('red'), weights: policies.red?.weights, seed: seed + 11, epsilon: 0.4, ...hyper.red });
  const blue = new LinearQAgent({ side: 'blue', dim: env.featureSize('blue'), weights: policies.blue?.weights, seed: seed + 23, epsilon: 0.4, alpha: 0.003, ...hyper.blue });
  // Opponent mixing (a light form of population-based self-play): some episodes
  // pit each learner against a scripted expert so neither collapses onto the
  // weaknesses of a single co-evolving opponent.
  const mixRng = new RNG(seed + 97);
  const scriptedRed = new HeuristicRedAgent({ seed: seed + 31 });
  const scriptedBlue = new HeuristicBlueAgent({ seed: seed + 37 });
  const curve = [];
  for (let ep = 0; ep < episodes; ep++) {
    const roll = mixRng.next();
    const r = roll < opponentMix / 2 ? scriptedRed : red;
    const b = roll >= opponentMix / 2 && roll < opponentMix ? scriptedBlue : blue;
    const { summary, meanTd } = runEpisode(env, r, b, { learn: true, record: false, seed: seed + ep });
    const point = {
      episode: ep + 1,
      redReturn: summary.rewards.red,
      blueReturn: summary.rewards.blue,
      impact: summary.impact,
      steps: summary.steps,
      outcome: summary.outcome,
      opponent: r !== red ? 'heuristic-red' : b !== blue ? 'heuristic-blue' : 'self-play',
      epsilon: +red.epsilon.toFixed(3),
      meanTd: +meanTd.toFixed(3),
    };
    curve.push(point);
    onProgress?.(point);
  }
  const meta = { trainedBy: 'js-selfplay', scenario, episodes, updatedAt: new Date().toISOString() };
  return {
    curve,
    policies: {
      red: { ...red.toJSON(), meta },
      blue: { ...blue.toJSON(), meta },
    },
  };
}

export function runBatch({ scenario = 'small', episodes = 50, seed = 100, red = 'trained', blue = 'trained', policies = {} } = {}) {
  const env = new ShadowAgentEnv({ scenario, seed });
  const agents = buildAgents(env, { red, blue, policies, seed });
  const results = [];
  for (let ep = 0; ep < episodes; ep++) {
    const r = runEpisode(env, agents.red, agents.blue, { learn: false, record: false, seed: seed + ep });
    results.push(r);
  }
  return { results, topology: { nodes: env.nodes, edges: env.edges, entryPoints: env.entryPoints, name: env.topologyName } };
}
