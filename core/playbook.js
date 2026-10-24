// Turns aggregate analytics into an actionable incident-response playbook (Markdown).
const pct = (x) => `${Math.round(x * 100)}%`;

const HARDENING = {
  T1046: 'Restrict east-west discovery: host firewalls on workstations, alert on internal port sweeps.',
  T1210: 'Patch exposed internal services, enforce MFA for remote administration, remove flat VLAN peer access.',
  T1003: 'Deploy LSASS protection / Credential Guard, LAPS for local admins, shorten cached-credential lifetime.',
  T1068: 'Remove standing admin rights (JIT/PAM), patch kernel/driver CVEs, monitor token manipulation.',
  T1485: 'Immutable/offline backups, change-control on destructive operations, rapid restore runbooks.',
};

export function generatePlaybook(analysis, { scenario = 'small', topologyName = '', red = 'trained', blue = 'trained' } = {}) {
  const a = analysis;
  const lines = [];
  const top = (arr, k = 3) => arr.slice(0, k);
  const grade = a.resilienceScore >= 75 ? 'STRONG' : a.resilienceScore >= 50 ? 'MODERATE' : 'WEAK';

  lines.push(`# ShadowAgent Incident-Response Playbook`);
  lines.push('');
  lines.push(`**Environment:** ${topologyName || scenario} · **Episodes simulated:** ${a.episodes} · **Red policy:** ${red} · **Blue policy:** ${blue}`);
  lines.push('');
  lines.push(`## 1. Executive summary`);
  lines.push('');
  lines.push(`Organisational resilience score: **${a.resilienceScore}/100 (${grade})**.`);
  lines.push(`Saboteurs met their objective in **${pct(a.winRate.red)}** of runs; defenders fully contained the intrusion in **${pct(a.winRate.blue)}**.`);
  lines.push(`Mean business impact was **${a.meanImpact} / ${a.impactTarget}** value units. Intrusions were detected in ${pct(a.detectionRate)} of runs` +
    (a.meanDetectionStep != null ? `, on average at step ${a.meanDetectionStep}.` : '.'));
  lines.push('');

  lines.push(`## 2. Observed adversary techniques (MITRE ATT&CK)`);
  lines.push('');
  lines.push(`| Technique | Tactic | Attempts / episode | Success rate |`);
  lines.push(`|---|---|---|---|`);
  for (const t of [...a.techniques].sort((x, y) => y.perEpisode - x.perEpisode)) {
    lines.push(`| ${t.id} ${t.name} | ${t.tactic} | ${t.perEpisode} | ${pct(t.successRate)} |`);
  }
  lines.push('');

  lines.push(`## 3. Choke points & architectural blind spots`);
  lines.push('');
  if (a.structuralChokePoints.length) {
    lines.push(`**Structural single points of failure** (removing the node severs entry → crown-jewel paths):`);
    for (const c of top(a.structuralChokePoints, 5)) lines.push(`- ${c.label} — cuts ${pct(c.share)} of insider-to-critical paths`);
  } else {
    lines.push(`- No single node separates insiders from critical assets — the network is highly meshed; prioritise segmentation.`);
  }
  if (a.empiricalChokePoints.length) {
    lines.push('');
    lines.push(`**Empirical pivot hosts** (appear on successful sabotage paths):`);
    for (const c of top(a.empiricalChokePoints, 5)) lines.push(`- ${c.label} — on the kill chain in ${pct(c.rate)} of episodes`);
  }
  if (a.sabotaged.length) {
    lines.push('');
    lines.push(`**Most frequently disrupted assets:** ${top(a.sabotaged, 4).map((s) => `${s.label} (${pct(s.rate)})`).join(', ')}.`);
  }
  lines.push('');

  lines.push(`## 4. Response procedure`);
  lines.push('');
  const pivots = top([...a.empiricalChokePoints, ...a.structuralChokePoints], 3).map((c) => c.label);
  const uniquePivots = [...new Set(pivots)];
  lines.push(`### 4.1 Detect`);
  lines.push(`1. Enable deep telemetry on: ${uniquePivots.length ? uniquePivots.join(', ') : 'all file shares and the mail relay'}.`);
  lines.push(`2. Treat a suspicion score > 0.6 on any server-zone host as a P1 alert; credential-dumping signatures are the earliest reliable indicator.`);
  if (a.honeypotTripRate > 0) lines.push(`3. Decoys were tripped ${a.honeypotTripRate} times per episode — keep deception assets adjacent to the pivot hosts above.`);
  lines.push('');
  lines.push(`### 4.2 Contain`);
  lines.push(`1. Quarantine (zero-trust isolate) the confirmed host **and** its upstream file share within 2 steps of confirmation.`);
  lines.push(`2. False-positive isolations averaged ${a.falseIsolationsPerEpisode} per episode — require an analyst \`investigate\` before isolating critical servers.`);
  lines.push('');
  lines.push(`### 4.3 Eradicate & recover`);
  lines.push(`1. Reimage every quarantined host before the quarantine window expires; restore disrupted assets from immutable backups.`);
  lines.push(`2. Rotate credentials of every tier that was dumped (see T1003 above), starting with admin and domain tiers.`);
  lines.push('');
  lines.push(`### 4.4 Harden (prioritised)`);
  for (const t of [...a.techniques].sort((x, y) => y.successRate * y.perEpisode - x.successRate * x.perEpisode)) {
    if (HARDENING[t.id]) lines.push(`- **${t.id}** — ${HARDENING[t.id]}`);
  }
  lines.push('');
  lines.push(`## 5. Defender action effectiveness`);
  lines.push('');
  lines.push(`| Control | Uses | Effective |`);
  lines.push(`|---|---|---|`);
  for (const d of a.defenses) lines.push(`| ${d.name} | ${d.uses} | ${pct(d.effectiveness)} |`);
  lines.push('');
  lines.push(`_Generated automatically by ShadowAgent from simulated agent state transitions._`);
  return lines.join('\n');
}
