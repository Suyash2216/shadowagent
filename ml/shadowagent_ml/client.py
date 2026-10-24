"""Thin HTTP client for the ShadowAgent Node.js server (gym-style API)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import requests


@dataclass
class Candidates:
    """Legal actions for one side: ids plus a feature matrix (n_actions x dim)."""

    ids: list[int]
    verbs: list[str]
    targets: list[str | None]
    features: np.ndarray

    @classmethod
    def parse(cls, raw: list[dict[str, Any]], dim: int) -> "Candidates":
        if not raw:
            return cls([], [], [], np.zeros((0, dim), dtype=np.float32))
        return cls(
            ids=[c["id"] for c in raw],
            verbs=[c["verb"] for c in raw],
            targets=[c["target"] for c in raw],
            features=np.asarray([c["features"] for c in raw], dtype=np.float32),
        )


class ShadowAgentClient:
    def __init__(self, base_url: str = "http://localhost:3000", timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.http = requests.Session()
        self.timeout = timeout

    def _get(self, path: str) -> Any:
        r = self.http.get(f"{self.base_url}/api{path}", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict | None = None) -> Any:
        r = self.http.post(f"{self.base_url}/api{path}", json=body or {}, timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def health(self) -> bool:
        try:
            return bool(self._get("/health").get("ok"))
        except requests.RequestException:
            return False

    def meta(self) -> dict:
        return self._get("/meta")

    def make_env(self, scenario: str = "small", seed: int = 1, max_steps: int = 60) -> "RemoteEnv":
        return RemoteEnv(self, scenario=scenario, seed=seed, max_steps=max_steps)

    def simulate(self, **opts) -> dict:
        return self._post("/simulate", opts)

    def batch(self, **opts) -> dict:
        return self._post("/batch", opts)

    def policies(self) -> dict:
        return self._get("/policies")

    def upload_policy(self, side: str, policy: dict) -> None:
        r = self.http.put(f"{self.base_url}/api/policies/{side}", json=policy, timeout=self.timeout)
        r.raise_for_status()


class RemoteEnv:
    """Two-player environment backed by a server-side ShadowAgentEnv session."""

    def __init__(self, client: ShadowAgentClient, scenario: str, seed: int, max_steps: int):
        self.client = client
        data = client._post("/env", {"scenario": scenario, "seed": seed, "maxSteps": max_steps})
        self.session_id: str = data["sessionId"]
        self.feature_size: dict[str, int] = data["featureSize"]
        self.topology: dict = data["topology"]
        self._ingest(data)

    def _ingest(self, data: dict) -> None:
        self.done: bool = data["done"]
        self.frame: dict = data["frame"]
        self.red = Candidates.parse(data["candidates"]["red"], self.feature_size["red"])
        self.blue = Candidates.parse(data["candidates"]["blue"], self.feature_size["blue"])

    def reset(self, seed: int | None = None) -> "RemoteEnv":
        body = {} if seed is None else {"seed": seed}
        self._ingest(self.client._post(f"/env/{self.session_id}/reset", body))
        return self

    def step(self, red_action: int, blue_action: int) -> tuple[dict[str, float], bool, dict | None]:
        data = self.client._post(f"/env/{self.session_id}/step", {"red": red_action, "blue": blue_action})
        self._ingest(data)
        return data["reward"], data["done"], data.get("summary")

    def snapshot(self) -> dict:
        return self.client._get(f"/env/{self.session_id}/snapshot")

    def close(self) -> None:
        try:
            self.client.http.delete(f"{self.client.base_url}/api/env/{self.session_id}", timeout=5)
        except requests.RequestException:
            pass
