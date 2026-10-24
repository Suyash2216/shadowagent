import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowAgentEnv } from '../core/environment.js';
import { generateTopology } from '../core/topology.js';

test('topology is deterministic and connected', () => {
  const a = generateTopology('small', 4);
  const b = generateTopology('small', 4);
  assert.deepEqual(a, b);
  assert.ok(a.nodes.some((n) => n.critical));
  const ids = new Set(a.nodes.map((n) => n.id));
  for (const e of a.edges) assert.ok(ids.has(e.source) && ids.has(e.target));
});

test('same seed + same actions => identical trajectory', () => {
  const run = () => {
    const env = new ShadowAgentEnv({ seed: 11 });
    while (!env.state.done) {
      const r = env.legalRedActions();
      const b = env.legalBlueActions();
      env.step(r[env.state.step % r.length], b[(env.state.step * 3) % b.length]);
    }
    return env.summary();
  };
  assert.deepEqual(run(), run());
});

test('action encoding round-trips', () => {
  const env = new ShadowAgentEnv({ seed: 2 });
  for (const side of ['red', 'blue']) {
    for (let id = 0; id < env.actionSpace(side); id++) {
      const { verb, target } = env.decodeAction(side, id);
      assert.equal(env.encodeAction(side, verb, target), id);
    }
  }
});

test('red can only exploit nodes adjacent to its footholds', () => {
  const env = new ShadowAgentEnv({ seed: 5 });
  for (const id of env.legalRedActions()) {
    const { verb, target } = env.decodeAction('red', id);
    if (verb !== 'exploit') continue;
    assert.ok([...env.state.compromised].some((c) => env.adj.get(c).has(target)));
  }
});

test('candidate features match declared feature size', () => {
  const env = new ShadowAgentEnv({ seed: 3 });
  for (const side of ['red', 'blue']) {
    for (const c of env.candidates(side)) assert.equal(c.features.length, env.featureSize(side));
  }
});

test('isolating every foothold contains the intrusion', () => {
  const env = new ShadowAgentEnv({ seed: 9 });
  const wait = env.encodeAction('red', 'wait', null);
  const res = env.step(wait, env.encodeAction('blue', 'isolate', env.state.foothold));
  assert.equal(res.done, true);
  assert.equal(env.summary().outcome, 'blue-contained');
  assert.ok(env.auditLog.some((l) => l.action === 'containment'));
});

test('honeypot deployment adds a decoy node and edge', () => {
  const env = new ShadowAgentEnv({ seed: 9 });
  const before = env.nodes.length;
  const target = env.nodes.find((n) => n.type === 'file_server').id;
  env.step(env.encodeAction('red', 'wait', null), env.encodeAction('blue', 'honeypot', target));
  assert.equal(env.nodes.length, before + 1);
  assert.ok(env.adj.get(target).has(env.state.honeypots[0]));
});
