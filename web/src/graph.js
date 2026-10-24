import cytoscape from 'cytoscape';

const ZONE_X = { corporate: 0, server: 430, restricted: 860 };

// Deterministic zone-based layout: departments as rows on the left, servers in
// the middle, restricted crown-jewel assets on the right.
function layout(nodes, edges) {
  const pos = {};
  const depts = [...new Set(nodes.filter((n) => n.zone === 'corporate').map((n) => n.dept))];
  const rowH = 120;
  depts.forEach((dept, row) => {
    const ws = nodes.filter((n) => n.zone === 'corporate' && n.dept === dept);
    ws.forEach((n, i) => (pos[n.id] = { x: ZONE_X.corporate + i * 75, y: row * rowH + (i % 2) * 28 }));
    const fs = nodes.find((n) => n.type === 'file_server' && n.dept === dept);
    if (fs) pos[fs.id] = { x: ZONE_X.server - 40, y: row * rowH + 14 };
  });
  const mid = ((depts.length - 1) * rowH) / 2;
  const others = nodes.filter((n) => n.zone === 'server' && n.type !== 'file_server' && !n.honeypot);
  others.forEach((n, i) => (pos[n.id] = { x: ZONE_X.server + 170, y: mid - 90 + i * 180 }));
  const restricted = nodes.filter((n) => n.zone === 'restricted');
  const spread = Math.max(rowH, ((depts.length) * rowH) / Math.max(1, restricted.length));
  restricted.forEach((n, i) => (pos[n.id] = { x: ZONE_X.restricted - (i % 2) * 60, y: mid - ((restricted.length - 1) * spread) / 2 + i * spread }));
  // Decoys sit next to the host they were deployed beside.
  const hpOffsets = {};
  for (const hp of nodes.filter((n) => n.honeypot)) {
    const anchor = edges.find((e) => e.target === hp.id)?.source;
    const base = pos[anchor] ?? { x: ZONE_X.server, y: mid };
    hpOffsets[anchor] = (hpOffsets[anchor] ?? 0) + 1;
    pos[hp.id] = { x: base.x + 45 * hpOffsets[anchor], y: base.y - 55 };
  }
  return pos;
}

const ICON = {
  workstation: 'WS', admin_ws: 'ADM', file_server: 'FS', app_server: 'APP', mail_server: 'MX',
  database: 'DB', backup: 'BKP', code_repo: 'GIT', domain_controller: 'DC', honeypot: 'HP',
};

export function createTopologyGraph(container) {
  const cy = cytoscape({
    container,
    wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
        'background-color': '#ffffff', 'border-color': '#98a2b3', 'border-width': 2,
        label: 'data(short)', color: '#1b2333', 'font-size': 10, 'font-weight': 600, 'text-valign': 'center', 'text-halign': 'center',
        width: 'mapData(value, 1, 10, 34, 58)', height: 'mapData(value, 1, 10, 34, 58)',
        'text-outline-color': '#ffffff', 'text-outline-width': 2,
      } },
      { selector: 'node[?critical]', style: { shape: 'diamond', 'border-color': '#d99a00', 'border-width': 3 } },
      { selector: 'node.compromised', style: { 'background-color': '#e5484d', 'border-color': '#b42318' } },
      { selector: 'node.admin', style: { 'background-color': '#b42318' } },
      { selector: 'node.sabotaged', style: { 'background-color': '#7c4dff', 'border-color': '#4b1fbf', 'border-width': 4 } },
      { selector: 'node.isolated', style: { 'border-style': 'dashed', 'border-color': '#475467', 'border-width': 3, opacity: 0.5 } },
      { selector: 'node.monitored', style: { 'overlay-color': '#2f80ed', 'overlay-opacity': 0.12, 'overlay-padding': 6 } },
      { selector: 'node.honeypot', style: { 'background-color': '#f5b300', 'border-color': '#a86f00', shape: 'hexagon' } },
      { selector: 'node.hidden, edge.hidden', style: { display: 'none' } },
      { selector: 'node.hot', style: { 'underlay-color': '#ff9f43', 'underlay-padding': 'mapData(susp, 0, 1, 0, 14)', 'underlay-opacity': 0.45, 'underlay-shape': 'ellipse' } },
      { selector: 'node.focus', style: { 'border-color': '#111827', 'border-width': 5 } },
      { selector: 'edge', style: { width: 1.2, 'line-color': '#d5dce6', 'curve-style': 'bezier' } },
      { selector: 'edge.attack', style: { width: 3.5, 'line-color': '#e5484d', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#e5484d' } },
      { selector: 'edge.cut', style: { 'line-style': 'dashed', 'line-color': '#98a2b3' } },
    ],
  });

  let tooltip;
  cy.on('mouseover', 'node', (evt) => {
    const d = evt.target.data();
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.innerHTML = `<b>${d.label}</b><br>${d.type.replace('_', ' ')} · ${d.dept} department · ${d.zone} zone<br>Importance ${d.value}/10 · weakness ${Math.round(d.vuln * 100)}% · access needed: ${['none', 'user', 'admin', 'domain admin'][d.privReq]}<br>Defender suspicion: ${Math.round((d.susp ?? 0) * 100)}%`;
    document.body.appendChild(tooltip);
    const { x, y } = evt.renderedPosition;
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${rect.left + x + 14 + window.scrollX}px`;
    tooltip.style.top = `${rect.top + y + 14 + window.scrollY}px`;
  });
  cy.on('mouseout', 'node', () => tooltip?.remove());

  return {
    cy,
    load(topology) {
      const pos = layout(topology.nodes, topology.edges);
      cy.elements().remove();
      cy.add(topology.nodes.map((n) => ({ data: { ...n, short: ICON[n.type] ?? n.type, susp: 0 }, position: pos[n.id] })));
      cy.add(topology.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target } })));
      cy.fit(undefined, 30);
    },
    render(frame, attackEdges, focusTarget) {
      const set = (arr) => new Set(arr);
      const comp = set(frame.compromised);
      const sab = set(frame.sabotaged);
      const iso = set(frame.isolated);
      const mon = set(frame.monitored);
      const hps = set(frame.honeypots);
      const access = new Map(frame.access);
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const id = n.id();
          const susp = frame.suspicion[id] ?? 0;
          n.data('susp', susp);
          n.toggleClass('compromised', comp.has(id));
          n.toggleClass('admin', (access.get(id) ?? 0) >= 2);
          n.toggleClass('sabotaged', sab.has(id));
          n.toggleClass('isolated', iso.has(id));
          n.toggleClass('monitored', mon.has(id));
          n.toggleClass('hot', susp > 0.15);
          n.toggleClass('focus', id === focusTarget);
          if (n.data('honeypot')) n.toggleClass('hidden', !hps.has(id));
        });
        cy.edges().forEach((e) => {
          const s = e.data('source');
          const t = e.data('target');
          const hidden = (cy.getElementById(s).data('honeypot') && !hps.has(s)) || (cy.getElementById(t).data('honeypot') && !hps.has(t));
          e.toggleClass('hidden', hidden);
          e.toggleClass('cut', iso.has(s) || iso.has(t));
          const isAttack = attackEdges.some((a) => (a.source === s && a.target === t) || (a.source === t && a.target === s));
          e.toggleClass('attack', isAttack);
          if (isAttack) {
            const a = attackEdges.find((x) => x.source === s || x.source === t);
            // orient arrow along the attack direction
            if (a && a.source === t) e.style({ 'source-arrow-shape': 'triangle', 'source-arrow-color': '#e5484d', 'target-arrow-shape': 'none' });
          } else e.removeStyle('source-arrow-shape target-arrow-shape');
        });
      });
    },
  };
}

export function renderAttackGraph(container, record, labelOf) {
  const g = record.attackGraph;
  const stageColor = {
    foothold: '#ff9f43', 'lateral-movement': '#c0392b', 'credential-access': '#e67e22', 'privilege-escalation': '#f1c40f', impact: '#6c2bd9',
  };
  const nodes = new Map();
  for (const n of g.nodes) nodes.set(n.id, { id: n.id, label: labelOf(n.id), stage: n.stage, step: n.step });
  const sabotaged = new Set(record.summary.sabotaged);
  const elements = [...nodes.values()].map((n) => ({
    data: { ...n, color: sabotaged.has(n.id) ? stageColor.impact : n.stage === 'foothold' ? stageColor.foothold : stageColor['lateral-movement'] },
  }));
  const tags = {};
  for (const e of g.edges) {
    if (e.source === e.target) (tags[e.source] ??= []).push(`${e.stage.split('-')[0]}@${e.step}`);
    else elements.push({ data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target, label: `t${e.step}` } });
  }
  for (const el of elements) if (!el.data.source && tags[el.data.id]) el.data.label = `${el.data.label}\n[${tags[el.data.id].join(', ')}]`;
  const cy = cytoscape({
    container,
    elements,
    layout: { name: 'breadthfirst', directed: true, roots: [record.summary.foothold], spacingFactor: 1.15 },
    style: [
      { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', color: '#1b2333', 'font-size': 11, 'text-wrap': 'wrap', 'text-valign': 'bottom', 'text-margin-y': 6, width: 26, height: 26 } },
      { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#e5484d', 'target-arrow-color': '#e5484d', width: 2, label: 'data(label)', color: '#475467', 'font-size': 10, 'text-background-color': '#fafbfd', 'text-background-opacity': 1 } },
    ],
  });
  return cy;
}
