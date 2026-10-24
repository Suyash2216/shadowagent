// In-browser backend: the core engine has no Node dependencies, so the dashboard can
// run fully client-side (static hosting such as GitHub Pages). Trained policies are
// kept in localStorage, seeded from the shipped policies/*.json.
import { ShadowAgentEnv, RED_ACTIONS, BLUE_ACTIONS } from '../../core/environment.js';
import { SCENARIOS } from '../../core/topology.js';
import { buildAgents, runBatch, runEpisode, trainSelfPlay } from '../../core/simulation.js';
import { analyse } from '../../core/analysis.js';
import { generatePlaybook } from '../../core/playbook.js';
import shippedRed from '../../policies/red.json';
import shippedBlue from '../../policies/blue.json';

const AGENT_KINDS = ['trained', 'heuristic', 'random'];
const STORE = 'shadowagent.policies';
const scenarioOf = (v) => (SCENARIOS[v] ? v : 'small');
const kindOf = (v) => (AGENT_KINDS.includes(v) ? v : 'trained');
const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(v ?? def, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

function loadPolicies() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved?.red && saved?.blue) return saved;
  } catch { /* fall back to shipped policies */ }
  return { red: shippedRed, blue: shippedBlue };
}

function savePolicies(policies) {
  try { localStorage.setItem(STORE, JSON.stringify(policies)); } catch { /* storage full or disabled */ }
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

export const localApi = {
  async meta() {
    const policies = loadPolicies();
    return {
      scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, name: s.name })),
      agentKinds: AGENT_KINDS,
      redActions: RED_ACTIONS,
      blueActions: BLUE_ACTIONS,
      policies: Object.fromEntries(Object.entries(policies).map(([k, p]) => [k, p.meta ?? {}])),
    };
  },

  async simulate(b = {}) {
    await yieldToUI();
    const env = new ShadowAgentEnv({ scenario: scenarioOf(b.scenario), seed: clampInt(b.seed, 1, 0, 1e9) });
    const red = kindOf(b.red);
    const blue = kindOf(b.blue);
    const agents = buildAgents(env, { red, blue, policies: loadPolicies(), seed: env.config.seed });
    return { red, blue, ...runEpisode(env, agents.red, agents.blue, { seed: env.config.seed }) };
  },

  async batch(b = {}) {
    await yieldToUI();
    const scenario = scenarioOf(b.scenario);
    const red = kindOf(b.red);
    const blue = kindOf(b.blue);
    const { results, topology } = runBatch({
      scenario,
      episodes: clampInt(b.episodes, 50, 1, 2000),
      seed: clampInt(b.seed, 100, 0, 1e9),
      red,
      blue,
      policies: loadPolicies(),
    });
    const analysis = analyse(results, topology);
    const playbook = generatePlaybook(analysis, { scenario, topologyName: topology.name, red, blue });
    return { analysis, playbook, episodes: results.map((r) => r.summary) };
  },

  async train(b = {}) {
    await yieldToUI();
    const { curve, policies } = trainSelfPlay({
      scenario: scenarioOf(b.scenario),
      episodes: clampInt(b.episodes, 1000, 1, 20000),
      seed: clampInt(b.seed, 1, 0, 1e9),
      policies: b.resume !== false ? loadPolicies() : {},
    });
    if (b.save !== false) savePolicies(policies);
    return { curve, saved: b.save !== false };
  },
};
