// REST API: gym-style environment sessions (used by the Python trainer),
// full-episode simulation, batch evaluation, JS self-play training and policy storage.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ShadowAgentEnv, RED_ACTIONS, BLUE_ACTIONS } from '../core/environment.js';
import { SCENARIOS, generateTopology } from '../core/topology.js';
import { buildAgents, runBatch, runEpisode, trainSelfPlay } from '../core/simulation.js';
import { analyse } from '../core/analysis.js';
import { generatePlaybook } from '../core/playbook.js';
import { loadPolicies, savePolicy } from './policies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_KINDS = ['trained', 'heuristic', 'random'];
const MAX_SESSIONS = 64;

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const sessions = new Map();

  const int = (v, def, min, max) => {
    const n = Number.parseInt(v ?? def, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  const scenarioOf = (v) => (SCENARIOS[v] ? v : 'small');
  const kindOf = (v) => (AGENT_KINDS.includes(v) ? v : 'trained');
  const envPayload = (env) => ({
    step: env.state.step,
    done: env.state.done,
    frame: env.frame(),
    candidates: env.state.done ? { red: [], blue: [] } : { red: env.candidates('red'), blue: env.candidates('blue') },
  });
  const getSession = (req, res) => {
    const env = sessions.get(req.params.id);
    if (!env) res.status(404).json({ error: 'unknown session' });
    return env;
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/meta', (_req, res) => {
    const policies = loadPolicies();
    res.json({
      scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, name: s.name })),
      agentKinds: AGENT_KINDS,
      redActions: RED_ACTIONS,
      blueActions: BLUE_ACTIONS,
      policies: Object.fromEntries(Object.entries(policies).map(([k, p]) => [k, p.meta ?? {}])),
    });
  });

  app.get('/api/topology', (req, res) => {
    res.json(generateTopology(scenarioOf(req.query.scenario), int(req.query.seed, 1, 0, 1e9)));
  });

  // ---- gym-style sessions ----
  app.post('/api/env', (req, res) => {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const { scenario, seed, maxSteps } = req.body ?? {};
    const env = new ShadowAgentEnv({
      scenario: scenarioOf(scenario),
      seed: int(seed, 1, 0, 1e9),
      maxSteps: int(maxSteps, 60, 5, 500),
    });
    const id = crypto.randomUUID();
    sessions.set(id, env);
    res.json({
      sessionId: id,
      featureSize: { red: env.featureSize('red'), blue: env.featureSize('blue') },
      topology: { nodes: env.nodes, edges: env.edges, name: env.topologyName },
      ...envPayload(env),
    });
  });

  app.post('/api/env/:id/reset', (req, res) => {
    const env = getSession(req, res);
    if (!env) return;
    env.reset(int(req.body?.seed, env.config.seed, 0, 1e9));
    res.json(envPayload(env));
  });

  app.post('/api/env/:id/step', (req, res) => {
    const env = getSession(req, res);
    if (!env) return;
    const { red, blue } = req.body ?? {};
    const legalRed = env.legalRedActions();
    const legalBlue = env.legalBlueActions();
    if (!legalRed.includes(red) || !legalBlue.includes(blue)) {
      return res.status(400).json({ error: 'illegal action', legalRed, legalBlue });
    }
    const out = env.step(red, blue);
    res.json({ reward: out.reward, ...envPayload(env), summary: out.done ? env.summary() : undefined });
  });

  app.get('/api/env/:id/snapshot', (req, res) => {
    const env = getSession(req, res);
    if (env) res.json(env.snapshot());
  });

  app.delete('/api/env/:id', (req, res) => {
    sessions.delete(req.params.id);
    res.json({ ok: true });
  });

  // ---- simulation & analytics ----
  app.post('/api/simulate', (req, res) => {
    const b = req.body ?? {};
    const env = new ShadowAgentEnv({ scenario: scenarioOf(b.scenario), seed: int(b.seed, 1, 0, 1e9) });
    const red = kindOf(b.red);
    const blue = kindOf(b.blue);
    const agents = buildAgents(env, { red, blue, policies: loadPolicies(), seed: env.config.seed });
    res.json({ red, blue, ...runEpisode(env, agents.red, agents.blue, { seed: env.config.seed }) });
  });

  app.post('/api/batch', (req, res) => {
    const b = req.body ?? {};
    const scenario = scenarioOf(b.scenario);
    const red = kindOf(b.red);
    const blue = kindOf(b.blue);
    const { results, topology } = runBatch({
      scenario,
      episodes: int(b.episodes, 50, 1, 2000),
      seed: int(b.seed, 100, 0, 1e9),
      red,
      blue,
      policies: loadPolicies(),
    });
    const analysis = analyse(results, topology);
    const playbook = generatePlaybook(analysis, { scenario, topologyName: topology.name, red, blue });
    res.json({ analysis, playbook, episodes: results.map((r) => r.summary) });
  });

  app.post('/api/train', (req, res) => {
    const b = req.body ?? {};
    const scenario = scenarioOf(b.scenario);
    const resume = b.resume !== false;
    const { curve, policies } = trainSelfPlay({
      scenario,
      episodes: int(b.episodes, 1000, 1, 20000),
      seed: int(b.seed, 1, 0, 1e9),
      policies: resume ? loadPolicies() : {},
    });
    if (b.save !== false) {
      savePolicy('red', policies.red);
      savePolicy('blue', policies.blue);
    }
    res.json({ curve, saved: b.save !== false });
  });

  // ---- policy registry (Python trainer uploads here) ----
  app.get('/api/policies', (_req, res) => res.json(loadPolicies()));

  app.put('/api/policies/:side', (req, res) => {
    try {
      savePolicy(req.params.side, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return app;
}
