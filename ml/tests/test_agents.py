import numpy as np
import pytest

from shadowagent_ml.agents import LinearDQNAgent
from shadowagent_ml.train import moving_average


def test_greedy_picks_highest_q():
    agent = LinearDQNAgent(side="red", dim=3, weights=np.array([0.0, 1.0, 0.0]), epsilon=0.0)
    feats = np.array([[1, 0, 0], [0, 5, 0], [0, 1, 0]], dtype=float)
    assert agent.act(feats) == 1


def test_learning_moves_q_towards_reward():
    agent = LinearDQNAgent(side="blue", dim=2, batch_size=4, alpha=0.1, seed=0)
    phi = np.array([1.0, 0.0])
    for _ in range(50):
        agent.remember(phi, 1.0, np.zeros((0, 2)), True)
        agent.learn()
    assert agent.q_values(phi[None])[0] == pytest.approx(1.0, abs=0.05)


def test_policy_roundtrip():
    agent = LinearDQNAgent(side="red", dim=4, weights=np.arange(4.0))
    pol = agent.to_policy(scenario="small")
    clone = LinearDQNAgent.from_policy(pol)
    assert pol["meta"]["scenario"] == "small"
    np.testing.assert_allclose(clone.w, agent.w)


def test_rejects_wrong_weight_shape():
    with pytest.raises(ValueError):
        LinearDQNAgent(side="red", dim=3, weights=np.zeros(5))


def test_epsilon_decays_to_floor():
    agent = LinearDQNAgent(side="red", dim=1, epsilon=0.5, epsilon_decay=0.5, epsilon_min=0.1)
    for _ in range(10):
        agent.end_episode()
    assert agent.epsilon == pytest.approx(0.1)


def test_moving_average_shape():
    assert moving_average([1, 2, 3, 4], 2).tolist() == [1.0, 1.5, 2.5, 3.5]
