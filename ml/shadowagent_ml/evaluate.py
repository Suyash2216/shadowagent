"""Resilience evaluation: red-vs-blue matchup matrix, charts and a Markdown report.

    python -m shadowagent_ml.evaluate --episodes 100 --scenario small
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .client import ShadowAgentClient

OUT_DIR = Path(__file__).resolve().parent.parent / "out"
KINDS = ["random", "heuristic", "trained"]


def matchup_matrix(client: ShadowAgentClient, scenario: str, episodes: int, seed: int = 5000) -> dict:
    results: dict[str, dict[str, dict]] = {}
    for red in KINDS:
        results[red] = {}
        for blue in KINDS:
            res = client.batch(scenario=scenario, episodes=episodes, seed=seed, red=red, blue=blue)
            results[red][blue] = res
            a = res["analysis"]
            print(f"red={red:9s} blue={blue:9s}  red win {a['winRate']['red']:5.0%}  "
                  f"contain {a['winRate']['blue']:5.0%}  impact {a['meanImpact']:5.1f}  resilience {a['resilienceScore']:3d}")
    return results


def plot_matrix(results: dict, out: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def grid(metric):
        return np.array([[metric(results[r][b]["analysis"]) for b in KINDS] for r in KINDS], dtype=float)

    panels = [
        ("Red objective rate", grid(lambda a: a["winRate"]["red"]), "Reds", (0, 1)),
        ("Blue containment rate", grid(lambda a: a["winRate"]["blue"]), "Blues", (0, 1)),
        ("Resilience score", grid(lambda a: a["resilienceScore"]), "RdYlGn", (0, 100)),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.4))
    for ax, (title, m, cmap, (lo, hi)) in zip(axes, panels):
        im = ax.imshow(m, cmap=cmap, vmin=lo, vmax=hi)
        ax.set_xticks(range(len(KINDS)), [f"blue:{k}" for k in KINDS])
        ax.set_yticks(range(len(KINDS)), [f"red:{k}" for k in KINDS])
        for i in range(len(KINDS)):
            for j in range(len(KINDS)):
                v = m[i, j]
                ax.text(j, i, f"{v:.0%}" if hi == 1 else f"{v:.0f}", ha="center", va="center", fontsize=11)
        ax.set_title(title)
        fig.colorbar(im, ax=ax, fraction=0.046)
    fig.tight_layout()
    fig.savefig(out / "matchup_matrix.png", dpi=130)
    plt.close(fig)


def plot_chokepoints(analysis: dict, out: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(13, 4.2))
    for ax, key, title, field, color in (
        (axes[0], "structuralChokePoints", "Structural choke points (share of paths cut)", "share", "#e0a800"),
        (axes[1], "empiricalChokePoints", "Empirical pivot hosts (episode rate)", "rate", "#d63c2f"),
    ):
        items = analysis[key][:8][::-1]
        ax.barh([i["label"] for i in items], [i[field] for i in items], color=color)
        ax.set_xlim(0, 1)
        ax.set_title(title)
    fig.tight_layout()
    fig.savefig(out / "choke_points.png", dpi=130)
    plt.close(fig)


def write_report(results: dict, scenario: str, episodes: int, out: Path) -> Path:
    lines = [f"# ShadowAgent resilience evaluation — `{scenario}`", "",
             f"{episodes} seeded episodes per matchup.", "",
             "| Red \\ Blue | " + " | ".join(KINDS) + " |", "|---|" + "---|" * len(KINDS)]
    for r in KINDS:
        cells = []
        for b in KINDS:
            a = results[r][b]["analysis"]
            cells.append(f"red {a['winRate']['red']:.0%} · contain {a['winRate']['blue']:.0%} · R={a['resilienceScore']}")
        lines.append(f"| **{r}** | " + " | ".join(cells) + " |")
    lines += ["", "![matchup matrix](matchup_matrix.png)", "", "![choke points](choke_points.png)", "", "---", "",
              results["trained"]["trained"]["playbook"]]
    path = out / "report.md"
    path.write_text("\n".join(lines))
    return path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:3000")
    p.add_argument("--episodes", type=int, default=100)
    p.add_argument("--scenario", default="small", choices=["small", "medium"])
    p.add_argument("--out", type=Path, default=OUT_DIR)
    args = p.parse_args()

    client = ShadowAgentClient(args.url)
    if not client.health():
        raise SystemExit(f"ShadowAgent server not reachable at {args.url} — run `npm start` first.")
    args.out.mkdir(parents=True, exist_ok=True)
    results = matchup_matrix(client, args.scenario, args.episodes)
    plot_matrix(results, args.out)
    plot_chokepoints(results["trained"]["trained"]["analysis"], args.out)
    summary = {r: {b: results[r][b]["analysis"] for b in KINDS} for r in KINDS}
    (args.out / "evaluation.json").write_text(json.dumps(summary, indent=1))
    print(f"Report written to {write_report(results, args.scenario, args.episodes, args.out)}")


if __name__ == "__main__":
    main()
