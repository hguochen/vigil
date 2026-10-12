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
cp .env.example .env                    # then set TYPESAFE_API_KEY (never commit .env)
git config core.hooksPath .githooks     # once per clone: enable the secret-scanning hooks
```

### Secrets

Secrets live only in the untracked `.env`. The git hooks in `.githooks/` scan every commit (`pre-commit`) and everything being pushed (`pre-push`, which also catches `--no-verify` commits). They block:

- `.env` and key files;
- known token formats (TypeSafe, AWS, GitHub, OpenAI/Anthropic, Slack, Google, private keys);
- secret-named variables with literal values;
- any line containing a secret value from your local `.env`, whatever its format.

Findings name the file, never the secret. Deliberately public values go in `.githooks/secrets-allowlist`. To scan the whole history at any time:

```bash
.githooks/check-secrets range "$(git rev-list --max-parents=0 HEAD)..HEAD"
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

## XGBoost baseline

```bash
uv run vigil-sim generate --format jsonl --seed 7 --days 120 --out data/sim/train.jsonl
uv run vigil-train          # writes models/xgb/{model.onnx,feature_schema.json,parity.json}
SCORING_STRATEGY=xgboost npm --prefix scoring-service run dev
```

- **Point-in-time labels.** Training uses only fraud that had been *reported* at the training cutoff (`--labels truth` turns this off), and evaluation uses ground truth.
- **Maturity gap.** The 21 days before the cutoff are left out of fitting, because most of their fraud hasn't been reported yet.
- **Alert-rate cutoffs.** Cutoffs come from alert-rate budgets in `policy.yaml` (`xgboost.alert_rates`), applied to calibration-window scores, so they need no labels. The service refuses a model calibrated for different rates, or one trained on a different feature list.
- **Checked export.** The export fails if ONNX and XGBoost disagree by more than 1e-5, and a Node test checks the ONNX runtime against Python's probabilities.

Compare strategies offline on a held-out dataset:

```bash
cd scoring-service
npm run eval:offline -- ../data/sim/holdout.jsonl --strategy xgboost
```

## Jev strategies

With `SCORING_STRATEGY=jev` or `jev_rules` (both need `TYPESAFE_API_KEY`), each transaction gets one Jev request that answers four typed questions (see `scoring-service/src/jev/questions.ts`):

| Question | Type | Answer |
|---|---|---|
| `is_fraud` | noul | Fraud probability |
| `fraud_pattern` | choice | card_testing, account_takeover, stolen_card, friendly_fraud, promo_abuse, none |
| `risk_level` | score | low, elevated, high, critical |
| `action` | choice | allow, step_up_3ds, review, block |

- **Masking:** Jev receives only derived signals and city-level locations: no names, emails, card data, IPs, device ids or street addresses (`src/jev/mask.ts`).
- **Blocking needs agreement:** a block requires both a high probability and a confident `action=block`. Disagreement goes to review (`config/policy.yaml`, `jev:` section).
- **`jev_rules`:** hard rules decide without calling Jev. Otherwise fired rules are sent to Jev as evidence, and can raise the decision to review but never to block.
- **Fallback:** if Jev fails or times out, the rules decide and the response includes a `JEV_UNAVAILABLE` reason.

```bash
cd scoring-service
npm run test:live      # opt-in: calls the real Jev API using ../.env
```

## Features

There are 38 behavioral features, defined once in [contracts/feature_spec.md](contracts/feature_spec.md) and implemented in TypeScript (serving) and Python (training). Parity is enforced by [contracts/golden/features.json](contracts/golden/features.json). After an intentional feature change, regenerate it:

```bash
uv run python -m vigil_ml.golden
```
