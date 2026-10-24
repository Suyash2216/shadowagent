"""MARL self-play training over the ShadowAgent HTTP gym API.

    python -m shadowagent_ml.train --episodes 300 --scenario small --upload

Both teams are independent Linear-DQN learners (experience replay + target
weights). Learned weight vectors are saved as JSON in the same format the JS
agents use, and can be uploaded to the server's policy registry.
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np

from .agents import LinearDQNAgent
from .client import ShadowAgentClient

OUT_DIR = Path(__file__).resolve().parent.parent / "out"


def train(
    client: ShadowAgentClient,
    episodes: int = 300,
    scenario: str = "small",
    seed: int = 1,
    max_steps: int = 60,
    warm_start: bool = False,
    log_every: int = 25,
) -> tuple[LinearDQNAgent, LinearDQNAgent, list[dict]]:
    env = client.make_env(scenario=scenario, seed=seed, max_steps=max_steps)
    dims = env.feature_size
    red = LinearDQNAgent(side="red", dim=dims["red"], seed=seed + 1)
    blue = LinearDQNAgent(side="blue", dim=dims["blue"], seed=seed + 2)
    if warm_start:
        pol = client.policies()
        for agent in (red, blue):
            w = pol.get(agent.side, {}).get("weights")
            if w and len(w) == agent.dim:
                agent.w = np.asarray(w, dtype=np.float64)
                agent.w_target = agent.w.copy()

    history: list[dict] = []
    t0 = time.time()
    try:
        for ep in range(episodes):
            env.reset(seed=seed + ep)
            ret = {"red": 0.0, "blue": 0.0}
            summary = None
            while not env.done:
                r_idx = red.act(env.red.features)
                b_idx = blue.act(env.blue.features)
                r_phi = env.red.features[r_idx]
                b_phi = env.blue.features[b_idx]
                reward, done, summary = env.step(env.red.ids[r_idx], env.blue.ids[b_idx])
                red.remember(r_phi, reward["red"], env.red.features, done)
                blue.remember(b_phi, reward["blue"], env.blue.features, done)
                red.learn()
                blue.learn()
                ret["red"] += reward["red"]
                ret["blue"] += reward["blue"]
            red.end_episode()
            blue.end_episode()
            row = {
                "episode": ep + 1,
                "red_return": round(ret["red"], 3),
                "blue_return": round(ret["blue"], 3),
                "outcome": summary["outcome"],
                "impact": summary["impact"],
                "steps": summary["steps"],
                "epsilon": round(red.epsilon, 4),
            }
            history.append(row)
            if log_every and (ep + 1) % log_every == 0:
                window = history[-log_every:]
                red_wins = sum(r["outcome"] == "red-objective" for r in window) / len(window)
                blue_wins = sum(r["outcome"] == "blue-contained" for r in window) / len(window)
                print(
                    f"ep {ep + 1:5d}/{episodes}  eps={red.epsilon:.3f}  "
                    f"red win {red_wins:4.0%}  blue contain {blue_wins:4.0%}  "
                    f"mean impact {np.mean([r['impact'] for r in window]):5.1f}  ({time.time() - t0:.0f}s)"
                )
    finally:
        env.close()
    return red, blue, history


def save_outputs(red: LinearDQNAgent, blue: LinearDQNAgent, history: list[dict], out_dir: Path, scenario: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"scenario": scenario, "episodes": len(history)}
    for agent in (red, blue):
        (out_dir / f"{agent.side}_policy.json").write_text(json.dumps(agent.to_policy(**meta), indent=1))
    with open(out_dir / "training_history.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(history[0].keys()))
        writer.writeheader()
        writer.writerows(history)
    plot_history(history, out_dir / "training_curves.png")


def moving_average(x: list[float], w: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if len(x) < w:
        w = max(1, len(x))
    c = np.cumsum(np.insert(x, 0, 0.0))
    head = c[1:w] / np.arange(1, w)
    return np.concatenate([head, (c[w:] - c[:-w]) / w])


def plot_history(history: list[dict], path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ep = [h["episode"] for h in history]
    w = max(5, len(history) // 20)
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.2))
    axes[0].plot(ep, moving_average([h["red_return"] for h in history], w), color="#d63c2f", label="red return")
    axes[0].plot(ep, moving_average([h["blue_return"] for h in history], w), color="#2f7fd6", label="blue return")
    axes[0].set_title("Self-play episode returns (moving average)")
    axes[0].set_xlabel("episode")
    axes[0].legend()
    for outcome, color in (("red-objective", "#d63c2f"), ("blue-contained", "#2f7fd6"), ("stalemate", "#888888")):
        axes[1].plot(ep, moving_average([h["outcome"] == outcome for h in history], w), color=color, label=outcome)
    axes[1].set_ylim(0, 1)
    axes[1].set_title("Outcome rates (moving average)")
    axes[1].set_xlabel("episode")
    axes[1].legend()
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:3000")
    p.add_argument("--episodes", type=int, default=300)
    p.add_argument("--scenario", default="small", choices=["small", "medium"])
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--warm-start", action="store_true", help="initialise from the server's current policies")
    p.add_argument("--upload", action="store_true", help="publish trained weights to the server policy registry")
    p.add_argument("--out", type=Path, default=OUT_DIR)
    args = p.parse_args()

    client = ShadowAgentClient(args.url)
    if not client.health():
        raise SystemExit(f"ShadowAgent server not reachable at {args.url} — run `npm start` first.")
    red, blue, history = train(client, args.episodes, args.scenario, args.seed, args.max_steps, args.warm_start)
    save_outputs(red, blue, history, args.out, args.scenario)
    print(f"Saved policies, CSV and training_curves.png to {args.out}")
    if args.upload:
        client.upload_policy("red", red.to_policy(scenario=args.scenario, episodes=len(history)))
        client.upload_policy("blue", blue.to_policy(scenario=args.scenario, episodes=len(history)))
        print("Uploaded policies to server — select 'trained (MARL)' in the dashboard to use them.")


if __name__ == "__main__":
    main()
