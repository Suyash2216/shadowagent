"""Runs only when a ShadowAgent server is reachable (npm start)."""

import os

import pytest

from shadowagent_ml.client import ShadowAgentClient
from shadowagent_ml.train import train

URL = os.environ.get("SHADOWAGENT_URL", "http://localhost:3000")
client = ShadowAgentClient(URL)
pytestmark = pytest.mark.skipif(not client.health(), reason="ShadowAgent server not running")


def test_remote_env_episode_terminates():
    env = client.make_env(seed=3, max_steps=20)
    steps = 0
    while not env.done:
        _, done, summary = env.step(env.red.ids[0], env.blue.ids[0])
        steps += 1
    assert steps <= 20 and summary["steps"] == steps
    env.close()


def test_short_training_run():
    red, blue, history = train(client, episodes=3, max_steps=15, log_every=0)
    assert len(history) == 3
    assert red.dim == len(red.to_policy()["weights"])
