import json

from vigil_ml.golden import GOLDEN_PATH, build, render


def test_golden_file_is_up_to_date():
    """If this fails after an intentional feature change, run: uv run python -m vigil_ml.golden"""
    assert GOLDEN_PATH.read_text() == render(build())


def test_golden_covers_every_fraud_scenario():
    golden = json.loads(GOLDEN_PATH.read_text())
    sim = next(s for s in golden["streams"] if s["name"] == "simulated")
    assert len(sim["transactions"]) == len(sim["features"]) > 40
