// Enterprise topology generator: departments, zones, role-based privilege
// requirements, stored credentials and network adjacency.
import { RNG } from './rng.js';

export const ACCESS = { NONE: 0, USER: 1, ADMIN: 2, DOMAIN: 3 };
export const ACCESS_NAMES = ['none', 'user', 'admin', 'domain-admin'];

const NODE_TEMPLATES = {
  workstation: { zone: 'corporate', value: 1, privReq: ACCESS.USER, creds: ACCESS.USER, vuln: [0.45, 0.7] },
  admin_ws: { zone: 'corporate', value: 2, privReq: ACCESS.USER, creds: ACCESS.ADMIN, vuln: [0.3, 0.5] },
  file_server: { zone: 'server', value: 4, privReq: ACCESS.USER, creds: ACCESS.USER, vuln: [0.35, 0.55] },
  app_server: { zone: 'server', value: 5, privReq: ACCESS.ADMIN, creds: ACCESS.ADMIN, vuln: [0.3, 0.5] },
  mail_server: { zone: 'server', value: 4, privReq: ACCESS.ADMIN, creds: ACCESS.USER, vuln: [0.3, 0.5] },
  database: { zone: 'restricted', value: 9, privReq: ACCESS.ADMIN, creds: ACCESS.NONE, vuln: [0.2, 0.35], critical: true },
  backup: { zone: 'restricted', value: 7, privReq: ACCESS.ADMIN, creds: ACCESS.ADMIN, vuln: [0.2, 0.35], critical: true },
  code_repo: { zone: 'restricted', value: 8, privReq: ACCESS.ADMIN, creds: ACCESS.NONE, vuln: [0.2, 0.35], critical: true },
  domain_controller: { zone: 'restricted', value: 10, privReq: ACCESS.DOMAIN, creds: ACCESS.DOMAIN, vuln: [0.1, 0.25], critical: true },
  honeypot: { zone: 'server', value: 6, privReq: ACCESS.USER, creds: ACCESS.ADMIN, vuln: [0.6, 0.6] },
};

export const SCENARIOS = {
  small: {
    name: 'Small enterprise (3 departments)',
    departments: { HR: 3, Finance: 3, Engineering: 4 },
  },
  medium: {
    name: 'Mid-size enterprise (5 departments)',
    departments: { HR: 3, Finance: 4, Engineering: 5, Sales: 4, IT: 3 },
  },
};

function makeNode(id, label, type, dept, rng) {
  const t = NODE_TEMPLATES[type];
  const [lo, hi] = t.vuln;
  return {
    id,
    label,
    type,
    dept,
    zone: t.zone,
    value: t.value,
    privReq: t.privReq,
    creds: t.creds,
    vuln: +(lo + rng.next() * (hi - lo)).toFixed(2),
    critical: !!t.critical,
    honeypot: type === 'honeypot',
  };
}

export function generateTopology(scenario = 'small', seed = 1) {
  const spec = SCENARIOS[scenario] ?? SCENARIOS.small;
  const rng = new RNG(seed * 7919 + 13);
  const nodes = [];
  const edges = [];
  const link = (a, b) => edges.push({ source: a, target: b });

  const core = {
    dc: makeNode('dc-01', 'Domain Controller', 'domain_controller', 'IT', rng),
    db: makeNode('db-fin', 'Finance DB', 'database', 'Finance', rng),
    backup: makeNode('bkp-01', 'Backup Server', 'backup', 'IT', rng),
    repo: makeNode('repo-01', 'Source Code Repo', 'code_repo', 'Engineering', rng),
    mail: makeNode('mail-01', 'Mail Server', 'mail_server', 'IT', rng),
    app: makeNode('app-01', 'ERP App Server', 'app_server', 'Finance', rng),
  };
  nodes.push(...Object.values(core));

  const deptServers = {};
  for (const [dept, count] of Object.entries(spec.departments)) {
    const fsId = `fs-${dept.toLowerCase()}`;
    const fs = makeNode(fsId, `${dept} File Share`, 'file_server', dept, rng);
    nodes.push(fs);
    deptServers[dept] = fsId;
    link(fsId, core.mail.id);

    const wsIds = [];
    for (let i = 1; i <= count; i++) {
      const isAdmin = dept === 'IT' || (i === count && dept === 'Engineering');
      const id = `ws-${dept.toLowerCase()}-${i}`;
      const node = makeNode(id, `${dept} WS-${i}${isAdmin ? ' (admin)' : ''}`, isAdmin ? 'admin_ws' : 'workstation', dept, rng);
      nodes.push(node);
      wsIds.push(id);
      link(id, fsId);
      link(id, core.mail.id);
    }
    // Peer links inside a department (flat VLAN).
    for (let i = 0; i < wsIds.length - 1; i++) link(wsIds[i], wsIds[i + 1]);
    if (wsIds.length > 2 && rng.chance(0.5)) link(wsIds[0], wsIds[wsIds.length - 1]);
  }

  // Server zone -> restricted zone paths (deliberate choke points).
  if (deptServers.Finance) link(deptServers.Finance, core.app.id);
  link(core.app.id, core.db.id);
  if (deptServers.Engineering) link(deptServers.Engineering, core.repo.id);
  link(core.mail.id, core.app.id);
  link(core.backup.id, core.db.id);
  link(core.backup.id, core.repo.id);
  link(core.dc.id, core.backup.id);
  link(core.dc.id, core.app.id);

  // Admin workstations have management access to the DC.
  for (const n of nodes) if (n.type === 'admin_ws') link(n.id, core.dc.id);

  // Insider entry points: any regular (non-admin) workstation.
  const entryPoints = nodes.filter((n) => n.type === 'workstation').map((n) => n.id);

  return { scenario, name: spec.name, nodes, edges, entryPoints };
}

export function makeHoneypot(index, nearNode, rng) {
  const hp = makeNode(`hp-${index}`, `Decoy ${nearNode.dept} Server`, 'honeypot', nearNode.dept, rng);
  return hp;
}

export function buildAdjacency(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const { source, target } of edges) {
    adj.get(source)?.add(target);
    adj.get(target)?.add(source);
  }
  return adj;
}
