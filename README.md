# Vigil

Real-time eCommerce transaction fraud detection powered by **Jev** (TypeSafe's typed-decision classifier).

Each transaction is enriched with behavioral signals (velocity, device and address history, geo distance) and classified by Jev into typed answers: a fraud probability, a fraud pattern, a risk level, and a recommended action. A benchmark compares Jev against a rules-only engine and an XGBoost baseline on labeled synthetic traffic.

See [docs/PLAN.md](docs/PLAN.md) for the full v1 scope.

## Layout

| Path | What |
|---|---|
| `scoring-service/` | TypeScript (Fastify) scoring API |
| `simulator/` | Python synthetic transaction generator with fraud scenarios |
| `ml/` | Python XGBoost baseline training and ONNX export |
| `benchmark/` | Python strategy benchmark and report |
| `docs/` | Plan and design notes |

## Prerequisites

- Node.js 20+
- [uv](https://docs.astral.sh/uv/) (Python 3.12 is pinned and installed automatically)
- Docker (for Postgres, Redis, and the full stack)

## Setup

```bash
cp .env.example .env   # then set TYPESAFE_API_KEY
```

### Scoring service

```bash
cd scoring-service
npm install
npm run dev            # http://localhost:8080/health
npm test
```

### Python packages

```bash
uv sync
uv run pytest
```

### Full stack

```bash
docker compose up --build
```

## Simulated data

```bash
uv run vigil-sim generate                              # data/sim/transactions.parquet
uv run vigil-sim generate --format jsonl --seed 101    # data/sim/transactions.jsonl
```

## Rules and policy

- `scoring-service/config/rules.yaml`: hard rules (`action`) decide immediately, and soft rules (`weight`) combine into a 0–1 score. Rules are validated when the file loads.
- `scoring-service/config/policy.yaml`: score thresholds for step_up_3ds, review and block, plus risk levels.
- `SCORING_STRATEGY=rules|passthrough` picks the scorer (default `rules`).

To evaluate a rules change offline against labeled data:

```bash
cd scoring-service
npm run eval:offline -- ../data/sim/transactions.jsonl
```

## Features

There are 38 behavioral features, defined once in [contracts/feature_spec.md](contracts/feature_spec.md) and implemented in TypeScript (serving) and Python (training). Parity is enforced by [contracts/golden/features.json](contracts/golden/features.json). After an intentional feature change, regenerate it:

```bash
uv run python -m vigil_ml.golden
```
