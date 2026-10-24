"""Linear DQN: Q(s, a) = w . phi(s, a) with experience replay and a target network.

The server supplies phi(s, a) for every legal action, so the policy is
topology-agnostic and its weight vector is directly loadable by the JS agents.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np


@dataclass
class Transition:
    phi: np.ndarray
    reward: float
    next_phis: np.ndarray  # (n_next, dim); empty when terminal
    done: bool


@dataclass
class LinearDQNAgent:
    side: str
    dim: int
    alpha: float = 0.01
    gamma: float = 0.95
    epsilon: float = 0.4
    epsilon_min: float = 0.05
    epsilon_decay: float = 0.99
    buffer_size: int = 20_000
    batch_size: int = 32
    target_sync: int = 200
    td_clip: float = 10.0
    seed: int = 0
    weights: np.ndarray | None = None
    buffer: deque = field(init=False)
    rng: np.random.Generator = field(init=False)
    updates: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.w = np.zeros(self.dim, dtype=np.float64) if self.weights is None else np.asarray(self.weights, dtype=np.float64).copy()
        if self.w.shape != (self.dim,):
            raise ValueError(f"weights must have shape ({self.dim},), got {self.w.shape}")
        self.w_target = self.w.copy()
        self.buffer = deque(maxlen=self.buffer_size)
        self.rng = np.random.default_rng(self.seed)

    def q_values(self, features: np.ndarray, target: bool = False) -> np.ndarray:
        return features @ (self.w_target if target else self.w)

    def act(self, features: np.ndarray, explore: bool = True) -> int:
        """Return the index (row) of the chosen candidate action."""
        n = features.shape[0]
        if explore and self.rng.random() < self.epsilon:
            return int(self.rng.integers(n))
        q = self.q_values(features) + self.rng.random(n) * 1e-6
        return int(np.argmax(q))

    def remember(self, phi: np.ndarray, reward: float, next_phis: np.ndarray, done: bool) -> None:
        self.buffer.append(Transition(np.asarray(phi, dtype=np.float64), float(reward), next_phis, bool(done)))

    def learn(self) -> float:
        if len(self.buffer) < self.batch_size:
            return 0.0
        idx = self.rng.choice(len(self.buffer), size=self.batch_size, replace=False)
        grad = np.zeros_like(self.w)
        td_total = 0.0
        for i in idx:
            t = self.buffer[i]
            target = t.reward
            if not t.done and t.next_phis.shape[0]:
                # Double-DQN style: online net selects, target net evaluates.
                best = int(np.argmax(self.q_values(t.next_phis)))
                target += self.gamma * float(t.next_phis[best] @ self.w_target)
            td = float(np.clip(target - t.phi @ self.w, -self.td_clip, self.td_clip))
            grad += td * t.phi
            td_total += abs(td)
        self.w += self.alpha * grad / self.batch_size
        self.updates += 1
        if self.updates % self.target_sync == 0:
            self.w_target = self.w.copy()
        return td_total / self.batch_size

    def end_episode(self) -> None:
        self.epsilon = max(self.epsilon_min, self.epsilon * self.epsilon_decay)

    def to_policy(self, **meta) -> dict:
        return {
            "side": self.side,
            "kind": "linear-dqn",
            "dim": self.dim,
            "epsilon": round(self.epsilon, 4),
            "weights": [round(float(x), 6) for x in self.w],
            "meta": {"trainedBy": "python-linear-dqn", "updatedAt": datetime.now(timezone.utc).isoformat(), **meta},
        }

    @classmethod
    def from_policy(cls, policy: dict, **kwargs) -> "LinearDQNAgent":
        return cls(side=policy["side"], dim=len(policy["weights"]), weights=np.asarray(policy["weights"]), **kwargs)
