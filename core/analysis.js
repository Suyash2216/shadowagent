// Post-hoc analytics: resilience metrics, empirical + structural choke points,
// and technique frequencies mapped to MITRE ATT&CK.
import { buildAdjacency, generateTopology } from './topology.js';

export const MITRE = {
  scan: { id: 'T1046', name: 'Network Service Discovery', tactic: 'Discovery' },
  exploit: { id: 'T1210', name: 'Exploitation of Remote Services', tactic: 'Lateral Movement' },
  harvest: { id: 'T1003', name: 'OS Credential Dumping', tactic: 'Credential Access' },
  escalate: { id: 'T1068', name: 'Exploitation for Privilege Escalation', tactic: 'Privilege Escalation' },
  sabotage: { id: 'T1485', name: 'Data Destruction / Service Disruption', tactic: 'Impact' },
};

export const DEFENSES = {
  monitor: 'Enhanced endpoint/network telemetry',
  investigate: 'Analyst triage & threat hunting',
  isolate: 'Zero-trust micro-segmentation (quarantine)',
  restore: 'Reimage / restore from known-good backup',
  honeypot: 'Deception (decoy assets)',
};

// Reconstruct the lateral-movement tree and return the hop chain that reached `target`.
export function attackPath(attackGraph, target) {
  const parent = new Map();
  for (const e of attackGraph.edges) {
    if (e.stage === 'lateral-movement' && !parent.has(e.target)) parent.set(e.target, e.source);
  }
  const path = [target];
  const seen = new Set(path);
  let cur = target;
  while (parent.has(cur) && !seen.has(parent.get(cur))) {
    cur = parent.get(cur);
    path.unshift(cur);
    seen.add(cur);
  }
  return path;
}

// Structural single points of failure: nodes whose removal disconnects the
// most (entry point, critical asset) pairs.
export function structuralChokePoints(topology) {
  const { nodes, edges, entryPoints } = topology;
  const critical = nodes.filter((n) => n.critical).map((n) => n.id);
  const adj = buildAdjacency(nodes, edges);
  const reachableFrom = (start, removed) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const id = q.shift();
      for (const nb of adj.get(id) ?? []) {
        if (nb === removed || seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    return seen;
  };
  const baseline = new Map(entryPoints.map((e) => [e, reachableFrom(e, null)]));
  let totalPairs = 0;
  for (const e of entryPoints) for (const c of critical) if (baseline.get(e).has(c)) totalPairs++;

  const out = [];
  for (const n of nodes) {
    if (n.critical || entryPoints.includes(n.id) || n.honeypot) continue;
    let cut = 0;
    for (const e of entryPoints) {
      const r = reachableFrom(e, n.id);
      for (const c of critical) if (baseline.get(e).has(c) && !r.has(c)) cut++;
    }
    if (cut > 0) out.push({ id: n.id, label: n.label, pairsCut: cut, share: +(cut / Math.max(1, totalPairs)).toFixed(3) });
  }
  return out.sort((a, b) => b.pairsCut - a.pairsCut);
}

export function analyse(results, topology, { maxSteps = 60 } = {}) {
  const n = results.length || 1;
  const labelOf = new Map(topology.nodes.map((x) => [x.id, x.label]));
  const outcomes = { 'red-objective': 0, 'blue-contained': 0, stalemate: 0 };
  const compromiseFreq = {};
  const sabotageFreq = {};
  const pathFreq = {};
  const techniques = {};
  const defenses = {};
  const honeypotTrips = { count: 0 };
  let impact = 0;
  let steps = 0;
  let detectSum = 0;
  let detected = 0;
  let falseIsolations = 0;

  for (const r of results) {
    const s = r.summary;
    outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    impact += s.impact;
    steps += s.steps;
    if (s.detectionStep != null) {
      detected++;
      detectSum += s.detectionStep;
    }
    for (const id of s.compromised) compromiseFreq[id] = (compromiseFreq[id] ?? 0) + 1;
    for (const id of s.sabotaged) {
      sabotageFreq[id] = (sabotageFreq[id] ?? 0) + 1;
      const path = attackPath(r.attackGraph, id);
      for (const hop of path.slice(1, -1)) pathFreq[hop] = (pathFreq[hop] ?? 0) + 1;
    }
    for (const entry of r.auditLog ?? []) {
      if (entry.side === 'red' && MITRE[entry.action]) {
        const t = (techniques[entry.action] ??= { attempts: 0, successes: 0 });
        t.attempts++;
        if (entry.success) t.successes++;
        if (entry.honeypot) honeypotTrips.count++;
      }
      if (entry.side === 'blue' && DEFENSES[entry.action]) {
        const d = (defenses[entry.action] ??= { uses: 0, effective: 0 });
        d.uses++;
        if (entry.success) d.effective++;
        if (entry.action === 'isolate' && !entry.success) falseIsolations++;
      }
    }
  }

  const rank = (freq) => Object.entries(freq)
    .map(([id, c]) => ({ id, label: labelOf.get(id) ?? id, rate: +(c / n).toFixed(3) }))
    .sort((a, b) => b.rate - a.rate);

  const meanImpact = impact / n;
  const impactTarget = results[0]?.summary.impactTarget ?? 18;
  const containRate = outcomes['blue-contained'] / n;
  const meanDetection = detected ? detectSum / detected : null;
  const timeliness = 1 - ((meanDetection ?? maxSteps) / maxSteps) * (detected / n) - (1 - detected / n);
  const resilience = Math.round(100 * (0.4 * containRate + 0.4 * (1 - Math.min(1, meanImpact / impactTarget)) + 0.2 * Math.max(0, timeliness)));

  return {
    episodes: results.length,
    outcomes,
    winRate: {
      red: +(outcomes['red-objective'] / n).toFixed(3),
      blue: +(containRate).toFixed(3),
      stalemate: +(outcomes.stalemate / n).toFixed(3),
    },
    meanImpact: +meanImpact.toFixed(2),
    impactTarget,
    meanSteps: +(steps / n).toFixed(1),
    detectionRate: +(detected / n).toFixed(3),
    meanDetectionStep: meanDetection == null ? null : +meanDetection.toFixed(1),
    falseIsolationsPerEpisode: +(falseIsolations / n).toFixed(2),
    honeypotTripRate: +(honeypotTrips.count / n).toFixed(3),
    resilienceScore: resilience,
    compromised: rank(compromiseFreq),
    sabotaged: rank(sabotageFreq),
    empiricalChokePoints: rank(pathFreq),
    structuralChokePoints: structuralChokePoints(topology),
    techniques: Object.entries(techniques).map(([verb, t]) => ({
      verb,
      ...MITRE[verb],
      attempts: t.attempts,
      successRate: +(t.successes / Math.max(1, t.attempts)).toFixed(3),
      perEpisode: +(t.attempts / n).toFixed(2),
    })),
    defenses: Object.entries(defenses).map(([verb, d]) => ({
      verb,
      name: DEFENSES[verb],
      uses: d.uses,
      effectiveness: +(d.effective / Math.max(1, d.uses)).toFixed(3),
    })),
  };
}

export function staticTopology(scenario, seed) {
  return generateTopology(scenario, seed);
}
