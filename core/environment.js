// ShadowAgent environment: a turn-based, gym-style multi-agent sandbox where a
// red (saboteur) policy and a blue (defender) policy act on the same enterprise
// topology. Every transition is appended to an audit log and an attack graph.
import { RNG } from './rng.js';
import { ACCESS, ACCESS_NAMES, buildAdjacency, generateTopology, makeHoneypot } from './topology.js';

export const RED_ACTIONS = ['scan', 'exploit', 'harvest', 'escalate', 'sabotage'];
export const BLUE_ACTIONS = ['monitor', 'investigate', 'isolate', 'restore', 'honeypot'];

export const DEFAULTS = {
  scenario: 'small',
  seed: 1,
  maxSteps: 60,
  detectionDecay: 0.85, // per-step decay of accumulated suspicion
  isolationTurns: 6,
  honeypotBudget: 2,
  benignNoise: 0.08, // per-node, per-step chance of a benign telemetry anomaly
  impactTarget: 18, // cumulative business value the red team must disrupt to "win"
};

const NODE_FEATS = 10;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export class ShadowAgentEnv {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.reset(this.config.seed);
  }

  // ---------- lifecycle ----------

  reset(seed = this.config.seed) {
    this.config.seed = seed;
    this.rng = new RNG(seed);
    const topo = generateTopology(this.config.scenario, seed);
    this.nodes = topo.nodes.map((n) => ({ ...n }));
    this.edges = topo.edges.map((e) => ({ ...e }));
    this.topologyName = topo.name;
    this.entryPoints = topo.entryPoints;
    this.adj = buildAdjacency(this.nodes, this.edges);
    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.distToCritical = this.computeDistToCritical();

    const foothold = this.rng.pick(this.entryPoints);
    this.state = {
      step: 0,
      done: false,
      foothold,
      compromised: new Set([foothold]),
      discovered: new Set([foothold, ...this.adj.get(foothold)]),
      access: new Map([[foothold, ACCESS.USER]]),
      credentials: new Set(),      // access levels looted so far
      sabotaged: new Set(),
      isolated: new Map(),         // nodeId -> turns remaining
      suspicion: new Map(),        // nodeId -> 0..1 defender suspicion
      alerts: [],
      honeypots: [],
      honeypotsLeft: this.config.honeypotBudget,
      redCaught: false,
      detectionStep: null,
      monitored: new Set(),
    };
    this.auditLog = [];
    this.attackGraph = { nodes: [{ id: foothold, stage: 'foothold', step: 0 }], edges: [] };
    this.rewards = { red: 0, blue: 0 };
    this.log('system', 'init', foothold, true, `Insider foothold established on ${this.label(foothold)}`);
    return this.observations();
  }

  label(id) {
    return this.nodes[this.index.get(id)]?.label ?? id;
  }

  node(id) {
    return this.nodes[this.index.get(id)];
  }

  // ---------- action space ----------

  // Flat discrete action space so tabular/NN policies (JS or Python) can index it.
  actionSpace(side) {
    const verbs = side === 'red' ? RED_ACTIONS : BLUE_ACTIONS;
    return verbs.length * this.nodes.length + 1; // +1 = no-op / wait
  }

  decodeAction(side, actionId) {
    const verbs = side === 'red' ? RED_ACTIONS : BLUE_ACTIONS;
    if (actionId == null || actionId >= verbs.length * this.nodes.length) return { verb: 'wait', target: null };
    return { verb: verbs[Math.floor(actionId / this.nodes.length)], target: this.nodes[actionId % this.nodes.length].id };
  }

  encodeAction(side, verb, target) {
    const verbs = side === 'red' ? RED_ACTIONS : BLUE_ACTIONS;
    if (verb === 'wait' || target == null) return verbs.length * this.nodes.length;
    return verbs.indexOf(verb) * this.nodes.length + this.index.get(target);
  }

  legalRedActions() {
    const s = this.state;
    const out = [this.encodeAction('red', 'wait', null)];
    const reachable = new Set();
    for (const id of s.compromised) for (const nb of this.adj.get(id)) reachable.add(nb);
    for (const n of this.nodes) {
      const owned = s.compromised.has(n.id);
      const adjacent = reachable.has(n.id);
      const blocked = (s.isolated.get(n.id) ?? 0) > 0;
      if (blocked) continue;
      if (adjacent && !owned) out.push(this.encodeAction('red', 'scan', n.id));
      if (adjacent && !owned && s.discovered.has(n.id)) out.push(this.encodeAction('red', 'exploit', n.id));
      if (owned) {
        out.push(this.encodeAction('red', 'harvest', n.id));
        if ((s.access.get(n.id) ?? 0) < ACCESS.DOMAIN) out.push(this.encodeAction('red', 'escalate', n.id));
        if (!s.sabotaged.has(n.id)) out.push(this.encodeAction('red', 'sabotage', n.id));
      }
    }
    return out;
  }

  legalBlueActions() {
    const s = this.state;
    const out = [this.encodeAction('blue', 'wait', null)];
    for (const n of this.nodes) {
      if (n.honeypot) continue;
      out.push(this.encodeAction('blue', 'monitor', n.id));
      out.push(this.encodeAction('blue', 'investigate', n.id));
      if (!(s.isolated.get(n.id) > 0)) out.push(this.encodeAction('blue', 'isolate', n.id));
      if ((s.suspicion.get(n.id) ?? 0) > 0.3 || s.sabotaged.has(n.id)) out.push(this.encodeAction('blue', 'restore', n.id));
      if (s.honeypotsLeft > 0) out.push(this.encodeAction('blue', 'honeypot', n.id));
    }
    return out;
  }

  // ---------- observations ----------

  // Red sees what it has touched; blue sees telemetry (suspicion), never ground truth.
  observations() {
    const s = this.state;
    const red = [];
    const blue = [];
    for (const n of this.nodes) {
      const owned = s.compromised.has(n.id) ? 1 : 0;
      const seen = s.discovered.has(n.id) ? 1 : 0;
      red.push(
        owned,
        seen,
        (s.access.get(n.id) ?? 0) / 3,
        s.sabotaged.has(n.id) ? 1 : 0,
        (s.isolated.get(n.id) ?? 0) > 0 ? 1 : 0,
        seen ? n.value / 10 : 0,
        seen ? n.vuln : 0,
      );
      const susp = s.suspicion.get(n.id) ?? 0;
      blue.push(
        susp,
        s.monitored.has(n.id) ? 1 : 0,
        (s.isolated.get(n.id) ?? 0) > 0 ? 1 : 0,
        s.sabotaged.has(n.id) ? 1 : 0,
        n.critical ? 1 : 0,
        n.value / 10,
      );
    }
    const progress = s.step / this.config.maxSteps;
    red.push(progress, Math.max(...[...s.access.values(), 0]) / 3, this.impact() / this.config.impactTarget);
    blue.push(progress, s.alerts.length / 20, s.honeypotsLeft / Math.max(1, this.config.honeypotBudget));
    return { red, blue, step: s.step, done: s.done };
  }

  observationSize(side) {
    return this.observations()[side].length;
  }

  // ---------- audit + graph ----------

  log(side, verb, target, success, detail, extra = {}) {
    this.auditLog.push({
      seq: this.auditLog.length,
      step: this.state.step,
      side,
      action: verb,
      target,
      targetLabel: target ? this.label(target) : null,
      success,
      detail,
      ...extra,
    });
  }

  graphEdge(from, to, stage) {
    if (!this.attackGraph.nodes.some((n) => n.id === to)) {
      this.attackGraph.nodes.push({ id: to, stage, step: this.state.step });
    }
    if (from && !this.attackGraph.edges.some((e) => e.source === from && e.target === to && e.stage === stage)) {
      this.attackGraph.edges.push({ source: from, target: to, stage, step: this.state.step });
    }
  }

  raise(nodeId, amount, reason) {
    const s = this.state;
    const n = this.node(nodeId);
    const monitorBoost = s.monitored.has(nodeId) ? 1.8 : 1;
    const honeypotBoost = n?.honeypot ? 3 : 1;
    const next = clamp01((s.suspicion.get(nodeId) ?? 0) + amount * monitorBoost * honeypotBoost);
    s.suspicion.set(nodeId, next);
    if (next > 0.6) {
      s.alerts.push({ step: s.step, node: nodeId, label: this.label(nodeId), score: +next.toFixed(2), reason });
    }
    return next;
  }

  // ---------- step ----------

  step(redAction, blueAction) {
    if (this.state.done) return { ...this.observations(), reward: { red: 0, blue: 0 }, done: true };
    const s = this.state;
    s.step += 1;
    let redReward = -0.1; // time cost: encourages efficient sabotage paths
    let blueReward = 0.1; // survival bonus

    const red = this.decodeAction('red', redAction);
    const blue = this.decodeAction('blue', blueAction);

    this.bluePenalty = 0;
    redReward += this.applyRed(red);
    blueReward += this.applyBlue(blue) - this.bluePenalty;

    // Benign background anomalies (users, patching, backups) create false positives.
    for (const n of this.nodes) {
      if (!n.honeypot && this.rng.chance(this.config.benignNoise)) {
        const prev = s.suspicion.get(n.id) ?? 0;
        s.suspicion.set(n.id, clamp01(prev + 0.05 + this.rng.next() * 0.3));
      }
    }

    // Suspicion decay and isolation timers.
    for (const [id, v] of s.suspicion) s.suspicion.set(id, v * this.config.detectionDecay);
    for (const [id, turns] of [...s.isolated]) {
      if (turns <= 1) {
        s.isolated.delete(id);
        this.log('blue', 'isolation-expired', id, true, `Quarantine lifted on ${this.label(id)}`);
      } else s.isolated.set(id, turns - 1);
    }

    // Containment check: blue wins outright if every compromised host is quarantined/restored.
    const activeFoothold = [...s.compromised].filter((id) => !(s.isolated.get(id) > 0));
    if (activeFoothold.length === 0) {
      s.done = true;
      s.redCaught = true;
      s.detectionStep ??= s.step;
      blueReward += 15;
      redReward -= 10;
      this.log('blue', 'containment', null, true, 'All red footholds quarantined — intrusion contained');
    }

    if (this.impact() >= this.config.impactTarget) {
      s.done = true;
      redReward += 15;
      blueReward -= 15;
      this.log('red', 'objective', null, true, `Sabotage objective met (impact ${this.impact()} ≥ ${this.config.impactTarget})`);
    }

    if (s.step >= this.config.maxSteps) {
      s.done = true;
      this.log('system', 'timeout', null, true, `Episode horizon reached at step ${s.step}`);
    }

    this.rewards.red += redReward;
    this.rewards.blue += blueReward;
    const obs = this.observations();
    return { ...obs, reward: { red: +redReward.toFixed(3), blue: +blueReward.toFixed(3) }, done: s.done };
  }

  applyRed({ verb, target }) {
    const s = this.state;
    if (verb === 'wait' || !target) {
      this.log('red', 'wait', null, true, 'Dwelling to cool down telemetry');
      return 0;
    }
    const n = this.node(target);
    if (!n) return -1;
    if ((s.isolated.get(target) ?? 0) > 0) {
      this.log('red', verb, target, false, `${this.label(target)} unreachable (quarantined)`);
      return -1;
    }
    const reachable = [...s.compromised].some((id) => this.adj.get(id)?.has(target));
    const owned = s.compromised.has(target);
    const source = [...s.compromised].find((id) => this.adj.get(id)?.has(target)) ?? s.foothold;

    switch (verb) {
      case 'scan': {
        if (!reachable) return -1;
        s.discovered.add(target);
        for (const nb of this.adj.get(target)) s.discovered.add(nb);
        this.raise(target, 0.05, 'port/service enumeration');
        this.log('red', 'scan', target, true, `Enumerated services on ${this.label(target)} (vuln ${n.vuln})`);
        return 0.2;
      }
      case 'exploit': {
        if (!reachable || owned) return -1;
        const credLevel = Math.max(...[...s.credentials, 0]);
        const needsCreds = n.privReq > ACCESS.USER;
        const credBonus = credLevel >= n.privReq ? 0.35 : 0;
        const p = clamp01(n.vuln + credBonus - (needsCreds && !credBonus ? 0.25 : 0));
        const success = this.rng.chance(p);
        this.raise(target, success ? 0.22 : 0.3, success ? 'anomalous authentication' : 'failed exploit attempt');
        if (success) {
          s.compromised.add(target);
          s.access.set(target, Math.max(ACCESS.USER, Math.min(n.privReq, credLevel)));
          this.graphEdge(source, target, 'lateral-movement');
          if (n.honeypot) {
            s.redCaught = true;
            s.detectionStep ??= s.step;
            this.raise(target, 1, 'deception asset triggered');
            this.log('red', 'exploit', target, true, `Compromised ${this.label(target)} — DECOY, red team exposed`, { honeypot: true });
            return -6;
          }
          this.bluePenalty += 0.5 + n.value * 0.1;
          this.log('red', 'exploit', target, true, `Compromised ${this.label(target)} (p=${p.toFixed(2)})`);
          return 1.5 + n.value * 0.3;
        }
        this.log('red', 'exploit', target, false, `Exploit failed against ${this.label(target)} (p=${p.toFixed(2)})`);
        return -0.5;
      }
      case 'harvest': {
        if (!owned) return -1;
        const got = n.creds;
        this.raise(target, 0.12, 'credential dumping signature');
        if (got > 0) {
          s.credentials.add(got);
          this.graphEdge(target, target, 'credential-access');
          this.log('red', 'harvest', target, true, `Harvested ${ACCESS_NAMES[got]} credentials from ${this.label(target)}`);
          return 0.8 + got * 0.5;
        }
        this.log('red', 'harvest', target, false, `No cached credentials on ${this.label(target)}`);
        return -0.2;
      }
      case 'escalate': {
        if (!owned) return -1;
        const credLevel = Math.max(...[...s.credentials, 0]);
        const current = s.access.get(target) ?? ACCESS.USER;
        const p = clamp01(0.3 + 0.25 * credLevel - 0.15 * current);
        this.raise(target, 0.2, 'privilege escalation attempt');
        if (this.rng.chance(p)) {
          const next = Math.min(ACCESS.DOMAIN, current + 1);
          s.access.set(target, next);
          s.credentials.add(next);
          this.graphEdge(target, target, 'privilege-escalation');
          this.log('red', 'escalate', target, true, `Escalated to ${ACCESS_NAMES[next]} on ${this.label(target)}`);
          return 1 + next;
        }
        this.log('red', 'escalate', target, false, `Escalation failed on ${this.label(target)}`);
        return -0.4;
      }
      case 'sabotage': {
        if (!owned || s.sabotaged.has(target)) return -1;
        const needed = n.privReq;
        if ((s.access.get(target) ?? 0) < needed) {
          this.log('red', 'sabotage', target, false, `Insufficient privilege to disrupt ${this.label(target)} (needs ${ACCESS_NAMES[needed]})`);
          this.raise(target, 0.25, 'unauthorized destructive command');
          return -0.6;
        }
        s.sabotaged.add(target);
        this.bluePenalty += n.value * (n.critical ? 1 : 0.4);
        this.raise(target, 0.5, 'service disruption / integrity loss');
        this.graphEdge(target, target, 'impact');
        this.log('red', 'sabotage', target, true, `Disrupted ${this.label(target)} (value ${n.value})`, { critical: n.critical });
        return n.value * (n.critical ? 1.5 : 0.4) - 0.5;
      }
      default:
        return -1;
    }
  }

  applyBlue({ verb, target }) {
    const s = this.state;
    if (verb === 'wait' || !target) {
      this.log('blue', 'wait', null, true, 'Passive telemetry collection');
      return 0;
    }
    const n = this.node(target);
    if (!n) return -1;

    switch (verb) {
      case 'monitor': {
        s.monitored.add(target);
        this.log('blue', 'monitor', target, true, `Enabled deep telemetry on ${this.label(target)}`);
        return -0.05;
      }
      case 'investigate': {
        const susp = s.suspicion.get(target) ?? 0;
        const hit = s.compromised.has(target) && this.rng.chance(clamp01(0.35 + susp));
        if (hit) {
          s.detectionStep ??= s.step;
          this.log('blue', 'investigate', target, true, `Confirmed intrusion on ${this.label(target)} (suspicion ${susp.toFixed(2)})`, { confirmed: true });
          this.raise(target, 0.3, 'analyst confirmation');
          return 2;
        }
        this.log('blue', 'investigate', target, false, `No indicators found on ${this.label(target)}`);
        return -0.3;
      }
      case 'isolate': {
        s.isolated.set(target, this.config.isolationTurns);
        const correct = s.compromised.has(target);
        this.log('blue', 'isolate', target, correct, `Zero-trust quarantine applied to ${this.label(target)}${correct ? ' (contained a foothold)' : ''}`);
        return correct ? 3 : -1.2; // isolating clean hosts costs business availability
      }
      case 'restore': {
        // Persistence: higher red privilege on the host makes eviction less reliable.
        const persist = 0.15 + 0.15 * (s.access.get(target) ?? 0) + (target === s.foothold ? 0.25 : 0);
        if (s.compromised.has(target) && this.rng.chance(persist)) {
          s.suspicion.set(target, 0.2);
          this.log('blue', 'restore', target, false, `Reimaged ${this.label(target)} but the adversary re-established persistence`);
          return -0.3;
        }
        const wasCompromised = s.compromised.delete(target);
        const wasSabotaged = s.sabotaged.delete(target);
        s.access.delete(target);
        s.suspicion.set(target, 0);
        this.log('blue', 'restore', target, wasCompromised || wasSabotaged, `Reimaged ${this.label(target)}${wasCompromised ? ' — foothold evicted' : ''}`);
        return (wasCompromised ? 2.5 : 0) + (wasSabotaged ? 1.5 : -0.8);
      }
      case 'honeypot': {
        if (s.honeypotsLeft <= 0) return -0.5;
        s.honeypotsLeft -= 1;
        const hp = makeHoneypot(this.state.honeypots.length + 1, n, this.rng);
        this.nodes.push(hp);
        this.index.set(hp.id, this.nodes.length - 1);
        this.adj.set(hp.id, new Set([target]));
        this.adj.get(target).add(hp.id);
        this.edges.push({ source: target, target: hp.id });
        s.honeypots.push(hp.id);
        this.log('blue', 'honeypot', hp.id, true, `Deployed decoy ${hp.label} adjacent to ${this.label(target)}`);
        return 0.5;
      }
      default:
        return -1;
    }
  }

  // ---------- per-action features (shared by JS + Python learners) ----------

  computeDistToCritical() {
    const dist = new Map();
    const queue = this.nodes.filter((n) => n.critical).map((n) => n.id);
    for (const id of queue) dist.set(id, 0);
    while (queue.length) {
      const id = queue.shift();
      for (const nb of this.adj.get(id)) {
        if (!dist.has(nb)) {
          dist.set(nb, dist.get(id) + 1);
          queue.push(nb);
        }
      }
    }
    return dist;
  }

  impact() {
    let total = 0;
    for (const id of this.state.sabotaged) total += this.node(id)?.value ?? 0;
    return total;
  }

  featureSize(side) {
    return (side === 'red' ? RED_ACTIONS : BLUE_ACTIONS).length * NODE_FEATS + NODE_FEATS;
  }

  // One block of NODE_FEATS per verb (block-sparse), so a linear Q-function can
  // learn a separate valuation of node properties for every action type.
  actionFeatures(side, actionId) {
    const verbs = side === 'red' ? RED_ACTIONS : BLUE_ACTIONS;
    const { verb, target } = this.decodeAction(side, actionId);
    const block = verb === 'wait' ? verbs.length : verbs.indexOf(verb);
    const phi = new Array(this.featureSize(side)).fill(0);
    const f = side === 'red' ? this.redNodeFeatures(target) : this.blueNodeFeatures(target);
    for (let i = 0; i < NODE_FEATS; i++) phi[block * NODE_FEATS + i] = f[i];
    return phi;
  }

  redNodeFeatures(id) {
    const s = this.state;
    const progress = s.step / this.config.maxSteps;
    const credLevel = Math.max(...[...s.credentials, 0]);
    if (!id) return [1, 0, 0, 0, 0, 0, 0, 0, 0, progress];
    const n = this.node(id);
    const access = s.access.get(id) ?? 0;
    const dist = this.distToCritical.get(id) ?? 6;
    return [
      1,
      n.value / 10,
      n.vuln,
      n.critical ? 1 : 0,
      n.creds > credLevel ? 1 : 0,
      Math.max(access, credLevel) >= n.privReq ? 1 : 0,
      access / 3,
      s.suspicion.get(id) ?? 0,
      1 / (1 + dist),
      progress,
    ];
  }

  blueNodeFeatures(id) {
    const s = this.state;
    const progress = s.step / this.config.maxSteps;
    if (!id) return [1, 0, 0, 0, 0, 0, 0, 0, 0, progress];
    const n = this.node(id);
    let nbMax = 0;
    for (const nb of this.adj.get(id)) nbMax = Math.max(nbMax, s.suspicion.get(nb) ?? 0);
    const recent = s.alerts.some((a) => a.node === id && s.step - a.step <= 3) ? 1 : 0;
    return [
      1,
      s.suspicion.get(id) ?? 0,
      s.monitored.has(id) ? 1 : 0,
      (s.isolated.get(id) ?? 0) > 0 ? 1 : 0,
      s.sabotaged.has(id) ? 1 : 0,
      n.critical ? 1 : 0,
      n.value / 10,
      nbMax,
      recent,
      s.honeypotsLeft / Math.max(1, this.config.honeypotBudget),
    ];
  }

  // Candidate list consumed by agents: [{id, verb, target, features}]
  candidates(side) {
    const legal = side === 'red' ? this.legalRedActions() : this.legalBlueActions();
    return legal.map((id) => ({ id, ...this.decodeAction(side, id), features: this.actionFeatures(side, id) }));
  }

  frame() {
    const s = this.state;
    return {
      step: s.step,
      compromised: [...s.compromised],
      access: [...s.access],
      sabotaged: [...s.sabotaged],
      isolated: [...s.isolated.keys()],
      monitored: [...s.monitored],
      honeypots: [...s.honeypots],
      suspicion: Object.fromEntries([...s.suspicion].filter(([, v]) => v > 0.01).map(([k, v]) => [k, +v.toFixed(3)])),
      impact: this.impact(),
      logSeq: this.auditLog.length,
    };
  }

  // ---------- summary ----------

  summary() {
    const s = this.state;
    const criticalHit = [...s.sabotaged].filter((id) => this.node(id)?.critical);
    return {
      scenario: this.config.scenario,
      topology: this.topologyName,
      seed: this.config.seed,
      steps: s.step,
      done: s.done,
      foothold: s.foothold,
      compromised: [...s.compromised],
      sabotaged: [...s.sabotaged],
      criticalSabotaged: criticalHit,
      honeypots: s.honeypots,
      redCaught: s.redCaught,
      detectionStep: s.detectionStep,
      alerts: s.alerts,
      maxAccess: ACCESS_NAMES[Math.max(...[...s.access.values(), 0])],
      rewards: { red: +this.rewards.red.toFixed(2), blue: +this.rewards.blue.toFixed(2) },
      impact: this.impact(),
      impactTarget: this.config.impactTarget,
      outcome: this.impact() >= this.config.impactTarget
        ? 'red-objective'
        : s.redCaught
          ? 'blue-contained'
          : 'stalemate',
    };
  }

  snapshot() {
    return {
      nodes: this.nodes,
      edges: this.edges,
      state: {
        step: this.state.step,
        compromised: [...this.state.compromised],
        sabotaged: [...this.state.sabotaged],
        isolated: [...this.state.isolated],
        suspicion: [...this.state.suspicion].map(([k, v]) => [k, +v.toFixed(3)]),
        honeypots: this.state.honeypots,
        alerts: this.state.alerts,
      },
      attackGraph: this.attackGraph,
      auditLog: this.auditLog,
      summary: this.summary(),
    };
  }
}
