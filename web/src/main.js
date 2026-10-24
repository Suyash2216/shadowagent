import { marked } from 'marked';
import { api } from './api.js';
import { createTopologyGraph, renderAttackGraph } from './graph.js';
import { COLORS, drawChart, movingAverage } from './charts.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (x) => `${Math.round(x * 100)}%`;

const state = { record: null, frame: 0, timer: null, playbook: '', attackCy: null };
const graph = createTopologyGraph($('#cy'));

const AGENT_NAMES = { trained: 'Smart AI (trained)', heuristic: 'Rule-based expert', random: 'Random (beginner)' };
const SCENARIO_NAMES = { small: 'Small company (3 departments)', medium: 'Medium company (5 departments)' };
const WHO = { red: 'Attacker', blue: 'Defender', system: 'System' };

const OUTCOME = {
  'red-objective': { text: 'Attacker wins', sub: 'Critical systems were damaged', cls: 'bad' },
  'blue-contained': { text: 'Defender wins', sub: 'Every hacked computer was blocked', cls: 'good' },
  stalemate: { text: 'Draw', sub: 'Time ran out before either side won', cls: 'warn' },
};

// ---------------- setup ----------------
async function init() {
  const meta = await api.meta();
  $('#scenario').innerHTML = meta.scenarios.map((s) => `<option value="${s.id}">${esc(SCENARIO_NAMES[s.id] ?? s.name)}</option>`).join('');
  const opts = meta.agentKinds.map((k) => `<option value="${k}">${AGENT_NAMES[k] ?? k}</option>`).join('');
  $('#red').innerHTML = opts;
  $('#blue').innerHTML = opts;
  $('#blue').value = 'heuristic';
  await runEpisode();
}

$('#controls').addEventListener('submit', (e) => {
  e.preventDefault();
  showView('watch');
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
    if ($('#tab-attack').classList.contains('active') && $('#view-advanced').classList.contains('active')) drawAttackGraph();
    showFrame(0);
    play();
  } catch (err) {
    alert(err.message);
  } finally {
    $('#run').disabled = false;
  }
}

// ---------------- navigation ----------------
function showView(view) {
  document.querySelectorAll('.steps button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'watch') { graph.cy.resize(); }
  if (view === 'advanced' && $('#tab-attack').classList.contains('active')) refreshAttackGraph();
}
document.querySelectorAll('.steps button').forEach((btn) => (btn.onclick = () => showView(btn.dataset.view)));

document.querySelectorAll('.subtabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.subtabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'attack') refreshAttackGraph();
  };
});

// ---------------- playback ----------------
function showFrame(i) {
  const r = state.record;
  if (!r) return;
  state.frame = Math.max(0, Math.min(i, r.frames.length - 1));
  const f = r.frames[state.frame];
  const attackEdges = r.attackGraph.edges.filter((e) => e.source !== e.target && e.step <= f.step);
  const focus = r.auditLog.filter((l) => l.step === f.step).find((l) => l.side === 'red')?.target;
  graph.render(f, attackEdges, focus);
  $('#timeline').value = state.frame;
  $('#stepLabel').textContent = `Step ${f.step} of ${r.frames.at(-1).step}`;
  renderFeed(f);
  renderKpis(f);
}

function play() {
  stop();
  if (state.frame >= state.record.frames.length - 1) showFrame(0);
  $('#play').textContent = 'Pause';
  state.timer = setInterval(() => {
    if (state.frame >= state.record.frames.length - 1) return stop();
    showFrame(state.frame + 1);
  }, Number($('#speed').value));
}

function stop() {
  clearInterval(state.timer);
  state.timer = null;
  const atEnd = state.record && state.frame >= state.record.frames.length - 1;
  $('#play').textContent = atEnd ? 'Replay' : 'Play';
}

$('#play').onclick = () => (state.timer ? stop() : play());
$('#stepBack').onclick = () => { stop(); showFrame(state.frame - 1); };
$('#stepFwd').onclick = () => { stop(); showFrame(state.frame + 1); };
$('#timeline').oninput = (e) => { stop(); showFrame(Number(e.target.value)); };
$('#speed').onchange = () => state.timer && play();

function renderFeed(f) {
  const logs = state.record.auditLog.slice(0, f.logSeq).slice(-14).reverse();
  $('#feedStep').textContent = `Step ${f.step}`;
  $('#feed').innerHTML = logs.map((l) => `
    <li class="${l.side} ${l.success ? 'ok' : 'fail'} ${l.step === f.step ? 'now' : ''}">
      <span><span class="tag">${WHO[l.side] ?? l.side}</span><span class="t">step ${l.step}</span></span>
      <span class="msg">${esc(l.detail)}</span>
    </li>`).join('');
}

function renderKpis(f) {
  const r = state.record;
  const final = state.frame === r.frames.length - 1;
  const s = r.summary;
  const o = final ? OUTCOME[s.outcome] : { text: 'Attack in progress…', sub: `${AGENT_NAMES[r.red]} vs ${AGENT_NAMES[r.blue]}`, cls: 'neutral' };
  const impactPct = Math.min(100, (f.impact / s.impactTarget) * 100);
  $('#kpis').innerHTML = `
    <div class="outcome ${o.cls}">${o.text}<small>${esc(o.sub)}</small></div>
    <div class="kpi-grid">
      <div class="r"><b>${f.compromised.length}</b><span>computers hacked</span></div>
      <div class="p"><b>${f.sabotaged.length}</b><span>systems damaged</span></div>
      <div class="bl"><b>${f.isolated.length}</b><span>computers blocked</span></div>
    </div>
    <div class="impact">
      <div class="impact-label"><span>Damage to the company</span><b>${f.impact} / ${s.impactTarget}</b></div>
      <div class="bar"><div style="width:${impactPct}%"></div></div>
    </div>
    <div class="kpi-foot">The attacker wins if damage reaches ${s.impactTarget}. Traps placed: ${f.honeypots.length}.${final && s.detectionStep != null ? ` First detected at step ${s.detectionStep}.` : ''}</div>`;
}

// ---------------- advanced: audit + attack path ----------------
function renderAudit() {
  const filter = $('#auditFilter').value;
  const onlyOk = $('#auditSuccess').checked;
  const rows = state.record.auditLog.filter((l) => (filter === 'all' || l.side === filter) && (!onlyOk || l.success));
  $('#auditTable tbody').innerHTML = rows.map((l) => `
    <tr class="${l.side}" data-step="${l.step}">
      <td>${l.step}</td><td><span class="tag">${WHO[l.side] ?? l.side}</span></td><td>${esc(l.action)}</td>
      <td>${esc(l.targetLabel ?? '—')}</td><td class="${l.success ? 'ok' : 'fail'}">${l.success ? 'yes' : 'no'}</td><td>${esc(l.detail)}</td>
    </tr>`).join('');
}
$('#auditFilter').onchange = renderAudit;
$('#auditSuccess').onchange = renderAudit;
$('#auditTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  stop();
  showView('watch');
  const step = Number(tr.dataset.step);
  showFrame(state.record.frames.findIndex((f) => f.step === step));
});

function drawAttackGraph() {
  if (!state.record || state.attackCy) return;
  state.attackCy = renderAttackGraph($('#attackCy'), state.record, (id) => state.labels.get(id) ?? id);
}
function refreshAttackGraph() {
  drawAttackGraph();
  state.attackCy?.resize();
  state.attackCy?.fit(undefined, 30);
}

// ---------------- step 2 & 3: test attacks + response plan ----------------
async function runTests(episodes, statusEl) {
  const { scenario, red, blue } = settings();
  statusEl.textContent = `Running ${episodes} attacks…`;
  const t0 = performance.now();
  const res = await api.batch({ scenario, red, blue, episodes, seed: 1000 });
  statusEl.textContent = `${res.analysis.episodes} attacks simulated in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${AGENT_NAMES[red]} vs ${AGENT_NAMES[blue]}`;
  renderAnalytics(res);
  state.playbook = res.playbook;
  $('#playbook').innerHTML = marked.parse(res.playbook);
  return res;
}

async function withButton(btn, statusEl, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { statusEl.textContent = err.message; } finally { btn.disabled = false; }
}

$('#batchBtn').onclick = () => withButton($('#batchBtn'), $('#batchStatus'), () => runTests(Number($('#batchN').value), $('#batchStatus')));
$('#planBtn').onclick = () => withButton($('#planBtn'), $('#planStatus'), () => runTests(100, $('#planStatus')));

function rankList(title, items, fmt) {
  if (!items.length) return `<div class="rank"><h4>${title}</h4><p class="muted">none observed</p></div>`;
  return `<div class="rank"><h4>${title}</h4><ol>${items.slice(0, 6).map((x) => `<li><span>${esc(x.label)}</span><b>${fmt(x)}</b></li>`).join('')}</ol></div>`;
}

function renderAnalytics({ analysis: a }) {
  const grade = a.resilienceScore >= 75 ? ['good', 'Strong'] : a.resilienceScore >= 50 ? ['warn', 'Moderate'] : ['bad', 'Weak'];
  const n = a.episodes;
  const weak = a.empiricalChokePoints.slice(0, 5);
  $('#analyticsBody').innerHTML = `
    <p class="summary-line">Out of <b>${n}</b> simulated attacks, the defender stopped <b class="blue-text">${a.outcomes['blue-contained']}</b>, the attacker succeeded in <b class="red-text">${a.outcomes['red-objective']}</b>, and <b>${a.outcomes.stalemate}</b> ended in a draw.</p>
    <div class="score-row">
      <div class="score ${grade[0]}"><b>${a.resilienceScore}</b><span>security score (out of 100)</span><em>${grade[1]}</em></div>
      <div class="mini g"><b>${pct(a.winRate.blue)}</b><span>attacks stopped</span></div>
      <div class="mini r"><b>${pct(a.winRate.red)}</b><span>attacks succeeded</span></div>
      <div class="mini"><b>${a.meanDetectionStep ?? '—'}</b><span>average steps until the attack was noticed</span></div>
    </div>
    <div class="two-col">
      <div class="chart-box"><canvas id="outcomeChart"></canvas></div>
      <div class="weak">
        <h3>Weak spots to protect first</h3>
        <p>Computers the attacker passed through most often on successful attacks.</p>
        ${weak.length ? `<ol>${weak.map((x) => `<li>${esc(x.label)}<b>${pct(x.rate)}</b></li>`).join('')}</ol>` : '<p>No successful attacks, so no weak spots found.</p>'}
      </div>
    </div>
    <details class="tech">
      <summary>Show technical details</summary>
      <div class="charts-row"><div class="chart-box"><canvas id="techniqueChart"></canvas></div>
        <div class="rank"><h4>Other numbers</h4><ol>
          <li><span>Average damage (attacker wins at ${a.impactTarget})</span><b>${a.meanImpact}</b></li>
          <li><span>Healthy computers blocked by mistake / attack</span><b>${a.falseIsolationsPerEpisode}</b></li>
          <li><span>Attacks detected at all</span><b>${pct(a.detectionRate)}</b></li>
          <li><span>Traps triggered per attack</span><b>${a.honeypotTripRate}</b></li></ol></div></div>
      <div class="ranks">
        ${rankList('Structural choke points', a.structuralChokePoints, (x) => pct(x.share))}
        ${rankList('Empirical pivot hosts', a.empiricalChokePoints, (x) => pct(x.rate))}
        ${rankList('Most often hacked', a.compromised, (x) => pct(x.rate))}
        ${rankList('Most often damaged', a.sabotaged, (x) => pct(x.rate))}
      </div>
    </details>`;
  drawChart($('#outcomeChart'), {
    type: 'doughnut',
    data: {
      labels: ['Attacker won', 'Defender won', 'Draw'],
      datasets: [{ data: [a.outcomes['red-objective'], a.outcomes['blue-contained'], a.outcomes.stalemate], backgroundColor: [COLORS.red, COLORS.blue, COLORS.grey], borderWidth: 0 }],
    },
    options: { plugins: { title: { display: true, text: 'Who won the test attacks' }, legend: { position: 'right' } } },
  });
  drawChart($('#techniqueChart'), {
    type: 'bar',
    data: {
      labels: a.techniques.map((t) => `${t.id} ${t.verb}`),
      datasets: [
        { label: 'attempts per attack', data: a.techniques.map((t) => t.perEpisode), backgroundColor: COLORS.purple },
        { label: 'success rate', data: a.techniques.map((t) => t.successRate), backgroundColor: COLORS.gold, yAxisID: 'y2' },
      ],
    },
    options: {
      plugins: { title: { display: true, text: 'Attacker techniques (MITRE ATT&CK)' } },
      scales: { y: { beginAtZero: true }, y2: { position: 'right', min: 0, max: 1, grid: { drawOnChartArea: false } } },
    },
  });
}

// ---------------- advanced: training ----------------
$('#trainBtn').onclick = () => withButton($('#trainBtn'), $('#trainStatus'), async () => {
  $('#trainStatus').textContent = 'Training…';
  const t0 = performance.now();
  const { curve } = await api.train({ scenario: $('#scenario').value, episodes: Number($('#trainN').value), resume: $('#trainResume').checked });
  $('#trainStatus').textContent = `${curve.length} practice games in ${((performance.now() - t0) / 1000).toFixed(1)}s. The Smart AI now uses the new version.`;
  renderTraining(curve);
});

function renderTraining(curve) {
  const w = Math.max(10, Math.round(curve.length / 25));
  const labels = curve.map((p) => p.episode);
  drawChart($('#trainReturns'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'attacker score', data: movingAverage(curve.map((p) => p.redReturn), w), borderColor: COLORS.red, pointRadius: 0, borderWidth: 2 },
        { label: 'defender score', data: movingAverage(curve.map((p) => p.blueReturn), w), borderColor: COLORS.blue, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: { plugins: { title: { display: true, text: 'Reward per game while learning (average)' } }, scales: { x: { ticks: { maxTicksLimit: 10 } } } },
  });
  const rate = (o) => movingAverage(curve.map((p) => (p.outcome === o ? 1 : 0)), w);
  drawChart($('#trainOutcomes'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'attacker wins', data: rate('red-objective'), borderColor: COLORS.red, backgroundColor: 'rgba(229,72,77,.15)', fill: 'origin', pointRadius: 0 },
        { label: 'defender wins', data: rate('blue-contained'), borderColor: COLORS.blue, backgroundColor: 'rgba(47,111,237,.15)', fill: 'origin', pointRadius: 0 },
      ],
    },
    options: { plugins: { title: { display: true, text: 'Win rate while learning' } }, scales: { y: { min: 0, max: 1 }, x: { ticks: { maxTicksLimit: 10 } } } },
  });
}

$('#downloadPlaybook').onclick = () => {
  if (!state.playbook) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([state.playbook], { type: 'text/markdown' }));
  a.download = 'shadowagent-response-plan.md';
  a.click();
};

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="error-banner">Could not start ShadowAgent: ${esc(err.message)}</div>`);
});
