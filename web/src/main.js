import { marked } from 'marked';
import { api } from './api.js';
import { createTopologyGraph, renderAttackGraph } from './graph.js';
import { COLORS, drawChart, movingAverage } from './charts.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const state = { record: null, frame: 0, timer: null, playbook: '', attackCy: null };
const graph = createTopologyGraph($('#cy'));

const OUTCOME = {
  'red-objective': { text: 'Saboteurs win', cls: 'bad' },
  'blue-contained': { text: 'Intrusion contained', cls: 'good' },
  stalemate: { text: 'Stalemate (horizon)', cls: 'warn' },
};

// ---------------- setup ----------------
async function init() {
  const meta = await api.meta();
  $('#scenario').innerHTML = meta.scenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const opts = meta.agentKinds.map((k) => `<option value="${k}">${k === 'trained' ? 'trained (MARL)' : k}</option>`).join('');
  $('#red').innerHTML = opts;
  $('#blue').innerHTML = opts;
  $('#blue').value = 'heuristic';
  await runEpisode();
}

$('#controls').addEventListener('submit', (e) => {
  e.preventDefault();
  runEpisode();
});

function settings() {
  return { scenario: $('#scenario').value, seed: Number($('#seed').value), red: $('#red').value, blue: $('#blue').value };
}

async function runEpisode() {
  stop();
  $('#run').disabled = true;
  try {
    const record = await api.simulate(settings());
    state.record = record;
    state.labels = new Map(record.topology.nodes.map((n) => [n.id, n.label]));
    graph.load(record.topology);
    $('#timeline').max = record.frames.length - 1;
    renderAudit();
    state.attackCy = null;
    if ($('#tab-attack').classList.contains('active')) drawAttackGraph();
    showFrame(0);
    play();
  } catch (err) {
    alert(err.message);
  } finally {
    $('#run').disabled = false;
  }
}

// ---------------- playback ----------------
function showFrame(i) {
  const r = state.record;
  if (!r) return;
  state.frame = Math.max(0, Math.min(i, r.frames.length - 1));
  const f = r.frames[state.frame];
  const attackEdges = r.attackGraph.edges.filter((e) => e.source !== e.target && e.step <= f.step);
  const stepLogs = r.auditLog.filter((l) => l.step === f.step);
  const focus = stepLogs.find((l) => l.side === 'red')?.target;
  graph.render(f, attackEdges, focus);
  $('#timeline').value = state.frame;
  $('#stepLabel').textContent = `step ${f.step} / ${r.frames.at(-1).step}`;
  renderFeed(f);
  renderKpis(f);
}

function play() {
  stop();
  $('#play').textContent = 'Pause';
  state.timer = setInterval(() => {
    if (state.frame >= state.record.frames.length - 1) return stop();
    showFrame(state.frame + 1);
  }, Number($('#speed').value));
}

function stop() {
  clearInterval(state.timer);
  state.timer = null;
  $('#play').textContent = 'Play';
}

$('#play').onclick = () => (state.timer ? stop() : play());
$('#stepBack').onclick = () => { stop(); showFrame(state.frame - 1); };
$('#stepFwd').onclick = () => { stop(); showFrame(state.frame + 1); };
$('#timeline').oninput = (e) => { stop(); showFrame(Number(e.target.value)); };
$('#speed').onchange = () => state.timer && play();

function renderFeed(f) {
  const logs = state.record.auditLog.slice(0, f.logSeq).slice(-14).reverse();
  $('#feedStep').textContent = `t = ${f.step}`;
  $('#feed').innerHTML = logs.map((l) => `
    <li class="${l.side} ${l.success ? 'ok' : 'fail'} ${l.step === f.step ? 'now' : ''}">
      <span class="tag">${l.side}</span>
      <span class="t">t${l.step}</span>
      <span class="msg">${esc(l.detail)}</span>
    </li>`).join('');
}

function renderKpis(f) {
  const r = state.record;
  const final = state.frame === r.frames.length - 1;
  const s = r.summary;
  const outcome = final ? OUTCOME[s.outcome] : { text: 'Simulation running…', cls: 'neutral' };
  const impactPct = Math.min(100, (f.impact / s.impactTarget) * 100);
  const maxSusp = Math.max(0, ...Object.values(f.suspicion));
  $('#kpis').innerHTML = `
    <div class="outcome ${outcome.cls}">${outcome.text}</div>
    <div class="kpi-grid">
      <div><b>${f.compromised.length}</b><span>hosts compromised</span></div>
      <div><b>${f.sabotaged.length}</b><span>assets sabotaged</span></div>
      <div><b>${f.isolated.length}</b><span>quarantined</span></div>
      <div><b>${f.honeypots.length}</b><span>decoys deployed</span></div>
      <div><b>${maxSusp.toFixed(2)}</b><span>peak suspicion</span></div>
      <div><b>${final ? (s.detectionStep ?? '—') : '…'}</b><span>detected at step</span></div>
    </div>
    <div class="impact">
      <div class="impact-label"><span>Business impact</span><span>${f.impact} / ${s.impactTarget}</span></div>
      <div class="bar"><div style="width:${impactPct}%"></div></div>
    </div>
    ${final ? `<div class="returns"><span class="red">red return ${s.rewards.red}</span><span class="blue">blue return ${s.rewards.blue}</span></div>` : ''}`;
}

// ---------------- audit + attack graph ----------------
function renderAudit() {
  const filter = $('#auditFilter').value;
  const onlyOk = $('#auditSuccess').checked;
  const rows = state.record.auditLog.filter((l) => (filter === 'all' || l.side === filter) && (!onlyOk || l.success));
  $('#auditTable tbody').innerHTML = rows.map((l) => `
    <tr class="${l.side}" data-step="${l.step}">
      <td>${l.step}</td><td><span class="tag">${l.side}</span></td><td>${esc(l.action)}</td>
      <td>${esc(l.targetLabel ?? '—')}</td><td class="${l.success ? 'ok' : 'fail'}">${l.success ? '✔' : '✖'}</td><td>${esc(l.detail)}</td>
    </tr>`).join('');
}
$('#auditFilter').onchange = renderAudit;
$('#auditSuccess').onchange = renderAudit;
$('#auditTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  stop();
  const step = Number(tr.dataset.step);
  showFrame(state.record.frames.findIndex((f) => f.step === step));
});

function drawAttackGraph() {
  if (!state.record || state.attackCy) return;
  state.attackCy = renderAttackGraph($('#attackCy'), state.record, (id) => state.labels.get(id) ?? id);
}

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'attack') {
      drawAttackGraph();
      state.attackCy?.resize();
      state.attackCy?.fit(undefined, 30);
    }
  };
});

// ---------------- batch analytics ----------------
$('#batchBtn').onclick = async () => {
  const btn = $('#batchBtn');
  btn.disabled = true;
  $('#batchStatus').textContent = 'simulating…';
  try {
    const { scenario, red, blue } = settings();
    const t0 = performance.now();
    const res = await api.batch({ scenario, red, blue, episodes: Number($('#batchN').value), seed: 1000 });
    $('#batchStatus').textContent = `${res.analysis.episodes} episodes in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    renderAnalytics(res);
    state.playbook = res.playbook;
    $('#playbook').innerHTML = marked.parse(res.playbook);
  } catch (err) {
    $('#batchStatus').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

function rankList(title, items, fmt) {
  if (!items.length) return `<div class="rank"><h4>${title}</h4><p class="muted">none observed</p></div>`;
  return `<div class="rank"><h4>${title}</h4><ol>${items.slice(0, 6).map((x) => `<li><span>${esc(x.label)}</span><b>${fmt(x)}</b></li>`).join('')}</ol></div>`;
}

function renderAnalytics({ analysis: a }) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const grade = a.resilienceScore >= 75 ? 'good' : a.resilienceScore >= 50 ? 'warn' : 'bad';
  $('#analyticsBody').innerHTML = `
    <div class="score-row">
      <div class="score ${grade}"><b>${a.resilienceScore}</b><span>resilience / 100</span></div>
      <div class="mini"><b>${pct(a.winRate.red)}</b><span>red objective rate</span></div>
      <div class="mini"><b>${pct(a.winRate.blue)}</b><span>blue containment rate</span></div>
      <div class="mini"><b>${a.meanImpact}</b><span>mean impact (target ${a.impactTarget})</span></div>
      <div class="mini"><b>${a.meanDetectionStep ?? '—'}</b><span>mean detection step</span></div>
      <div class="mini"><b>${a.falseIsolationsPerEpisode}</b><span>false quarantines / ep</span></div>
    </div>
    <div class="charts-row">
      <div class="chart-box"><canvas id="outcomeChart"></canvas></div>
      <div class="chart-box"><canvas id="techniqueChart"></canvas></div>
    </div>
    <div class="ranks">
      ${rankList('Structural choke points', a.structuralChokePoints, (x) => pct(x.share))}
      ${rankList('Empirical pivot hosts', a.empiricalChokePoints, (x) => pct(x.rate))}
      ${rankList('Most compromised', a.compromised, (x) => pct(x.rate))}
      ${rankList('Most sabotaged', a.sabotaged, (x) => pct(x.rate))}
    </div>`;
  drawChart($('#outcomeChart'), {
    type: 'doughnut',
    data: {
      labels: ['Red objective', 'Blue contained', 'Stalemate'],
      datasets: [{ data: [a.outcomes['red-objective'], a.outcomes['blue-contained'], a.outcomes.stalemate], backgroundColor: [COLORS.red, COLORS.blue, COLORS.grey], borderWidth: 0 }],
    },
    options: { plugins: { title: { display: true, text: 'Episode outcomes' } } },
  });
  drawChart($('#techniqueChart'), {
    type: 'bar',
    data: {
      labels: a.techniques.map((t) => `${t.id} ${t.verb}`),
      datasets: [
        { label: 'attempts / episode', data: a.techniques.map((t) => t.perEpisode), backgroundColor: COLORS.purple },
        { label: 'success rate', data: a.techniques.map((t) => t.successRate), backgroundColor: COLORS.gold, yAxisID: 'y2' },
      ],
    },
    options: {
      plugins: { title: { display: true, text: 'Adversary techniques (MITRE ATT&CK)' } },
      scales: { y: { beginAtZero: true }, y2: { position: 'right', min: 0, max: 1, grid: { drawOnChartArea: false } } },
    },
  });
}

// ---------------- training ----------------
$('#trainBtn').onclick = async () => {
  const btn = $('#trainBtn');
  btn.disabled = true;
  $('#trainStatus').textContent = 'training (runs on the server)…';
  try {
    const t0 = performance.now();
    const { curve } = await api.train({ scenario: $('#scenario').value, episodes: Number($('#trainN').value), resume: $('#trainResume').checked });
    $('#trainStatus').textContent = `${curve.length} episodes in ${((performance.now() - t0) / 1000).toFixed(1)}s — policies saved; select "trained (MARL)" to use them`;
    renderTraining(curve);
  } catch (err) {
    $('#trainStatus').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

function renderTraining(curve) {
  const w = Math.max(10, Math.round(curve.length / 25));
  const labels = curve.map((p) => p.episode);
  drawChart($('#trainReturns'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'red return (moving avg)', data: movingAverage(curve.map((p) => p.redReturn), w), borderColor: COLORS.red, pointRadius: 0, borderWidth: 2 },
        { label: 'blue return (moving avg)', data: movingAverage(curve.map((p) => p.blueReturn), w), borderColor: COLORS.blue, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: { plugins: { title: { display: true, text: 'Episode returns during self-play' } }, scales: { x: { ticks: { maxTicksLimit: 10 } } } },
  });
  const rate = (o) => movingAverage(curve.map((p) => (p.outcome === o ? 1 : 0)), w);
  drawChart($('#trainOutcomes'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'red objective', data: rate('red-objective'), borderColor: COLORS.red, backgroundColor: 'rgba(255,91,74,.25)', fill: 'origin', pointRadius: 0 },
        { label: 'blue contained', data: rate('blue-contained'), borderColor: COLORS.blue, backgroundColor: 'rgba(78,161,255,.25)', fill: 'origin', pointRadius: 0 },
      ],
    },
    options: { plugins: { title: { display: true, text: 'Outcome rates (moving window)' } }, scales: { y: { min: 0, max: 1 }, x: { ticks: { maxTicksLimit: 10 } } } },
  });
}

$('#downloadPlaybook').onclick = () => {
  if (!state.playbook) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([state.playbook], { type: 'text/markdown' }));
  a.download = 'shadowagent-playbook.md';
  a.click();
};

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="error-banner">Cannot reach the ShadowAgent API: ${esc(err.message)}. Start it with <code>npm start</code>.</div>`);
});
