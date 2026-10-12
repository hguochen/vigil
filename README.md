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
