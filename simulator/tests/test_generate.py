import json
from datetime import UTC, datetime
from pathlib import Path

import pyarrow.parquet as pq
import pytest
import yaml
from jsonschema import Draft202012Validator
from vigil_simulator.cli import main
from vigil_simulator.generate import GenerateConfig, generate, write_parquet
from vigil_simulator.geo import CONTRACTS_DIR
from vigil_simulator.scenarios import SCENARIOS

CONFIG = GenerateConfig(seed=3, customers=800, days=30, fraud_rate=0.03,
                        start=datetime(2026, 8, 1, tzinfo=UTC))


@pytest.fixture(scope="module")
def records():
    return generate(CONFIG)


@pytest.fixture(scope="module")
def transaction_validator():
    spec = yaml.safe_load((CONTRACTS_DIR / "openapi.yaml").read_text())
    schema = {"$ref": "#/components/schemas/Transaction", "components": spec["components"]}
    return Draft202012Validator(schema)


def test_fraud_rate_near_target(records):
    rate = sum(r.label.is_fraud for r in records) / len(records)
    assert 0.025 < rate < 0.045  # episodes overshoot slightly


def test_all_scenarios_appear(records):
    assert {r.label.scenario for r in records if r.label.is_fraud} == set(SCENARIOS)


def test_time_ordered_with_unique_ids(records):
    times = [r.occurred_at for r in records]
    assert times == sorted(times)
    ids = [r.transaction["transaction_id"] for r in records]
    assert len(set(ids)) == len(ids)
    assert all(ids)


def test_every_transaction_matches_the_api_contract(records, transaction_validator):
    for r in records:
        errors = list(transaction_validator.iter_errors(r.transaction))
        assert not errors, (r.label.scenario, errors[0].message)


def test_deterministic():
    a = [r.transaction for r in generate(CONFIG)][:200]
    b = [r.transaction for r in generate(CONFIG)][:200]
    assert a == b


def test_parquet_round_trip(records, tmp_path: Path):
    out = tmp_path / "sim.parquet"
    write_parquet(records, out, CONFIG)
    table = pq.read_table(out)
    assert table.num_rows == len(records)
    assert json.loads(table.schema.metadata[b"vigil.generate"])["seed"] == 3
    first = table.slice(0, 1).to_pylist()[0]
    assert json.loads(first["payload"]) == records[0].transaction
    assert sum(table.column("is_fraud").to_pylist()) == sum(r.label.is_fraud for r in records)


def test_cli_generate(tmp_path: Path, capsys):
    out = tmp_path / "cli.parquet"
    main(["generate", "--customers", "100", "--days", "5", "--seed", "1", "--out", str(out)])
    assert out.exists()
    assert "transactions:" in capsys.readouterr().out


def test_cli_generate_jsonl(tmp_path: Path):
    out = tmp_path / "cli.jsonl"
    main(["generate", "--customers", "100", "--days", "5", "--seed", "1", "--format", "jsonl",
          "--out", str(out)])
    lines = [json.loads(line) for line in out.read_text().splitlines()]
    assert lines and set(lines[0]) == {"transaction", "label"}
    assert {"is_fraud", "scenario", "pattern", "reported_at", "report_source"} == set(lines[0]["label"])
    assert any(line["label"]["is_fraud"] for line in lines)
