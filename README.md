# ShadowAgent

**A Multi-Agent Reinforcement Learning sandbox for simulating corporate sabotage and autonomous defense.**

Mini project — Dept. of CSE, Siddaganga Institute of Technology (2026–27), Batch B44.
Suyash Pandey · Vishal Kumar Tiwari · Vikas Sharma · Mohit Dhakad — Guide: Mr. Kumar Swamy J.

ShadowAgent simulates an isolated enterprise network in which a **red team** (an insider saboteur) and a
**blue team** (an autonomous SOC defender) learn competing policies through self-play. Every state
transition is audited, attack paths are reconstructed as multi-hop graphs, choke points are computed,
and an incident-response playbook is generated automatically.

**Live demo:** https://suyash2216.github.io/shadowagent/ (runs entirely in the browser)

> Everything is an abstract simulation — no real exploits, scanning or network traffic are involved.

## Architecture

```
            ┌─────────────────────── JavaScript ───────────────────────┐
 web/       │  Dashboard (Vite + Cytoscape.js + Chart.js)               │
            │  topology playback · audit log · attack graph · analytics │
            └──────────────▲────────────────────────────────────────────┘
                           │ REST /api
            ┌──────────────┴──────────── Node.js ───────────────────────┐
 server/    │  Express API: gym-style env sessions, simulate, batch,    │
            │  self-play training, policy registry (policies/*.json)    │
 core/      │  Sandbox engine: topology · environment · agents ·        │
            │  simulation · analysis (choke points, MITRE) · playbook   │
            └──────────────▲────────────────────────────────────────────┘
                           │ HTTP gym API (reset / step / candidates)
            ┌──────────────┴──────────── Python ────────────────────────┐
 ml/        │  Linear DQN trainer (replay + target net, double-Q)       │
            │  matchup evaluation · matplotlib charts · Markdown report │
            └───────────────────────────────────────────────────────────┘
```

| Objective (synopsis) | Where it lives |
|---|---|
| High-fidelity sandbox: departments, zones, directory roles, telemetry | `core/topology.js`, `core/environment.js` |
| Red agents learn sabotage, credential theft, privilege escalation | `RED_ACTIONS` in `core/environment.js`, `LinearQAgent` (`core/agents.js`), `ml/shadowagent_ml/agents.py` |
| Blue agents: anomaly detection, zero-trust isolation, honeypots | `BLUE_ACTIONS` (`monitor`, `investigate`, `isolate`, `restore`, `honeypot`) |
| Strategic equilibria → choke points / blind spots | `trainSelfPlay` (`core/simulation.js`), `structuralChokePoints` + empirical pivots (`core/analysis.js`) |
| End-to-end traceability: transitions, rewards, attack graphs | `auditLog`, `attackGraph`, per-step `frame()` |
| Resilience evaluation + automatic playbooks | `analyse()` (resilience score), `generatePlaybook()`, `ml/shadowagent_ml/evaluate.py` |

## The simulation

- **Topology** — per-department workstations and file shares, a mail relay, ERP app server, and restricted
  crown jewels (Domain Controller, Finance DB, Backup, Source Repo). Each node has a business value,
  vulnerability score, required privilege (`user`/`admin`/`domain-admin`) and cached credentials.
- **Red actions** — `scan`, `exploit` (lateral movement), `harvest` (credential dumping), `escalate`,
  `sabotage`, `wait`. Mapped to MITRE ATT&CK T1046, T1210, T1003, T1068, T1485.
- **Blue actions** — `monitor` (deep telemetry), `investigate` (analyst triage), `isolate` (zero-trust
  quarantine), `restore` (reimage; may fail against persistence), `honeypot` (deploy decoy), `wait`.
- **Partial observability** — blue never sees ground truth, only per-host *suspicion* produced by red
  activity plus benign background anomalies (false positives).
- **Outcomes** — red wins when disrupted business value ≥ `impactTarget` (18); blue wins when every
  foothold is quarantined; otherwise the episode times out (60 steps).
- **Learning** — both teams are independent Q-learners with linear function approximation over
  featurised candidate actions, trained by self-play with opponent mixing (some episodes are played
  against scripted experts). Features are topology-agnostic, so a policy trained on one scenario runs on
  any other, and JS and Python policies share one JSON format.

## Quick start

Requirements: Node.js ≥ 18, Python ≥ 3.9.

```bash
npm install
npm run build        # build the dashboard into dist/
npm start            # API + dashboard on http://localhost:3000
```

Development mode with hot reload: `npm run dev:server` in one terminal and `npm run dev:web` in another
(open http://localhost:5173).

### Static deployment (GitHub Pages)

The core engine has no Node dependencies, so the dashboard also runs fully client-side
(`web/src/local-api.js`; trained policies are kept in `localStorage`). It falls back to this mode
automatically when no API server is reachable.

```bash
VITE_STATIC=1 VITE_BASE=/shadowagent/ npx vite build --outDir site
# publish site/ to the gh-pages branch
```

### Train in JavaScript

```bash
npm run train -- 3000 small          # writes policies/red.json + policies/blue.json
```

or use the **MARL training** tab in the dashboard.

### Train and evaluate in Python

```bash
cd ml
pip install -r requirements.txt
python -m shadowagent_ml.train --episodes 300 --upload   # Linear DQN over the HTTP gym API
python -m shadowagent_ml.evaluate --episodes 100         # matchup matrix, charts, report.md
```

Outputs go to `ml/out/` (`training_curves.png`, `matchup_matrix.png`, `choke_points.png`, `report.md`).
`--upload` publishes the weights to the server, after which the dashboard's **trained (MARL)** agents use them.

Using the gym API from your own code:

```python
from shadowagent_ml import ShadowAgentClient

env = ShadowAgentClient("http://localhost:3000").make_env(scenario="medium", seed=4)
while not env.done:
    reward, done, summary = env.step(env.red.ids[0], env.blue.ids[0])  # candidate actions + feature matrices
print(summary["outcome"])
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meta` | scenarios, agent kinds, action names, policy metadata |
| GET | `/api/topology?scenario=&seed=` | generated enterprise topology |
| POST | `/api/env` | create a gym session `{scenario, seed, maxSteps}` → candidates + features |
| POST | `/api/env/:id/step` | `{red, blue}` action ids → rewards, next candidates, summary when done |
| POST | `/api/env/:id/reset` | reset a session `{seed}` |
| GET | `/api/env/:id/snapshot` | full state, audit log and attack graph |
| POST | `/api/simulate` | run one recorded episode `{scenario, seed, red, blue}` |
| POST | `/api/batch` | evaluate N episodes → analysis + playbook |
| POST | `/api/train` | JS self-play training `{episodes, resume}` |
| GET/PUT | `/api/policies[/:side]` | read / upload policy weights |

Agent kinds: `trained`, `heuristic` (scripted expert), `random`.

## Tests

```bash
npm test                      # node:test — environment, simulation, analysis
cd ml && python -m pytest     # agent unit tests (+ integration tests when the server is running)
```

## Project layout

```
core/       sandbox engine (pure ES modules, no dependencies)
server/     Express API, policy storage, training CLI
web/        dashboard source (index.html, src/)
policies/   shipped pre-trained red/blue weights
ml/         Python package shadowagent_ml + tests
test/       JS tests
```
