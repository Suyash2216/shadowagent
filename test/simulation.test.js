import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, trainSelfPlay } from '../core/simulation.js';
import { analyse, attackPath, structuralChokePoints } from '../core/analysis.js';
import { generatePlaybook } from '../core/playbook.js';
import { generateTopology } from '../core/topology.js';

test('batch analysis produces bounded metrics and a playbook', () => {
  const { results, topology } = runBatch({ episodes: 20, red: 'heuristic', blue: 'heuristic' });
  const a = analyse(results, topology);
  assert.equal(a.episodes, 20);
  assert.ok(a.resilienceScore >= 0 && a.resilienceScore <= 100);
  const total = a.winRate.red + a.winRate.blue + a.winRate.stalemate;
  assert.ok(Math.abs(total - 1) < 1e-6);
  const md = generatePlaybook(a);
  assert.match(md, /Incident-Response Playbook/);
  assert.match(md, /MITRE ATT&CK/);
});

test('self-play training improves red over a random policy', () => {
  const { policies } = trainSelfPlay({ episodes: 600, seed: 3 });
  const evalRed = (red) => analyse(...Object.values(runBatch({ episodes: 60, red, blue: 'random', policies }))).winRate.red;
  assert.ok(evalRed('trained') > evalRed('random'));
});

test('attack path reconstructs hop chain', () => {
  const g = { edges: [
    { source: 'a', target: 'b', stage: 'lateral-movement' },
    { source: 'b', target: 'c', stage: 'lateral-movement' },
    { source: 'c', target: 'c', stage: 'impact' },
  ] };
  assert.deepEqual(attackPath(g, 'c'), ['a', 'b', 'c']);
});

test('structural choke points identify gateway servers', () => {
  const chokes = structuralChokePoints(generateTopology('small', 1));
  assert.ok(chokes.length > 0);
  assert.ok(chokes.every((c) => c.share > 0 && c.share <= 1));
});
