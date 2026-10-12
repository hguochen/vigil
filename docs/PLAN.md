# Vigil — eCommerce Fraud Detection powered by Jev (v1 Scope)

## Status (2026-10-12): v1 complete

All nine milestones shipped. Results: [benchmark-results.md](benchmark-results.md). Walkthrough: [walkthrough.md](walkthrough.md).

**Where the build departed from this plan, and why:**

- **The benchmark runs in-process, not over HTTP.** Per-request strategy switching would mix four strategies' feature history in one Redis store. The runner uses the service's own scorers on features computed once, which gives identical decisions with no cross-contamination. The HTTP path is exercised separately by `vigil-sim replay`.
- **The headline metric is recall at equal alert rate, not recall at a fixed false-positive rate.** Unreported fraud (about 26% here) contaminates any label-based false-positive measure. Alert rate (review capacity) needs no labels and compares strategies at the same operating cost.
- **XGBoost cutoffs come from alert-rate budgets.** Its probabilities, trained on point-in-time labels, sit far below fixed thresholds. Training also leaves a 21-day label-maturity gap before the cutoff.
- **Simulator realism fixes.** Travel is modeled as multi-day trips (per-purchase random cities produced impossible travel for legitimate customers), and timestamps are whole seconds to match the API payload.
- **Jev answer parsing.** The `score` answer is an expected level (for example 2.95), not an index; the risk level is the most likely level in the distribution. This was found on the first real API call.
- **Not done in v1:**
  - The Docker Compose stack was never run end to end (no Docker on the dev machine; embedded Postgres and a local Redis binary were used instead).
  - Jev's thresholds and question instructions were not calibrated on a separate tuning sample, so Jev is benchmarked as first written.

---

## Context
Vigil is a showcase project for **Jev by TypeSafe**, a "System One" classifier that returns typed decisions (noul, choice, score) with calibrated probabilities. Every eCommerce transaction is enriched with behavioral signals and sent to Jev, which returns a typed fraud verdict. The centerpiece is a **head-to-head benchmark** on labeled simulator traffic, comparing rules only, an XGBoost baseline, Jev, and Jev plus rules. The goal is to show where Jev wins on accuracy, explainability, latency and cost. v1 is a local proof of concept run with Docker Compose. The repo at `~/Documents/Claude/Projects/vigil` has only an initial commit.

**Decisions made:** TypeScript scoring service on the official `@langchain/typesafe` SDK; Python simulator and XGBoost baseline; single merchant; the user has a Jev API key; IEEE-CIS dropped.

**Out of scope for v1:** analyst UI, streaming, multi-tenancy, cloud deployment.

## Architecture
```
simulator (Python) ──HTTP──► scoring-service (TypeScript, Fastify)
                               1. validate + persist (Postgres)
                               2. feature enrichment (Redis velocity, Postgres history)
                               3. Tier 0: hard rules (blocklist, card-testing burst) → instant decision
                               4. Tier 1: Jev typed classification on transaction + signals (PII masked)
                               5. decision policy: confidence thresholds → allow / step_up / review / block
                               → { decision, fraud_probability, pattern, risk_level, reasons, strategy, latency }
ml/ (Python) ── XGBoost baseline ── ONNX ──► onnxruntime-node (used only for the benchmark strategy)
```
**Strategies** can be chosen per request or through configuration: `rules`, `xgboost`, `jev`, `jev_rules` (the default). All four run on the same pipeline, which makes the benchmark a fair comparison.

## Jev question set (one request, evaluated in parallel)
| ID | Type | Purpose |
|---|---|---|
| `is_fraud` | noul | Probability that the transaction is fraudulent |
| `fraud_pattern` | choice | card_testing, account_takeover, stolen_card, friendly_fraud, promo_abuse, none |
| `risk_level` | score | low, elevated, high, critical |
| `action` | choice | allow, step_up_3ds, review, block |

- **State** sent to Jev is a structured JSON object: masked transaction fields and computed signals (velocity over 1h/24h for card, device, IP and email; account age; new device; billing/shipping mismatch; geo distance; amount compared with the customer's average; name/email consistency flag; cart summary).
- **Decision policy:** if `is_fraud` ≥ the block threshold *and* `action=block` has confidence ≥ c, block. If the probability falls in the gray zone or confidence is low, send to review. Thresholds live in `policy.yaml`.
- The question instructions and criteria are versioned in `jev/questions.ts`, so tuning shows up in git history.

## Repo layout (monorepo)
- `scoring-service/` — Node 20, TypeScript, Fastify, Vitest
  - `src/api/` — `POST /v1/transactions/score`, `POST /v1/transactions/:id/label`, `GET /v1/transactions/:id`; API-key authentication; zod validation
  - `src/features/` — `FeatureExtractor` (Redis sliding-window counters, Postgres history)
  - `src/rules/` — Tier 0 rules loaded from `rules.yaml`, each with a reason code
  - `src/jev/` — `questions.ts` and `JevClassifier`, a wrapper around `TypeSafeClassifier` with timeout, retry and fallback (Jev unavailable → rules plus review); `mask.ts` for personal-data masking (hashed card/email/IP; derived flags only)
  - `src/baseline/` — `XgbScorer` using onnxruntime-node
  - `src/decision/` — policy that maps answers to a decision with reasons
  - `src/db/` — Postgres migrations: transactions, decisions (stores the raw Jev answers, `requestId` and usage), labels
- `simulator/` — Python
  - Entities: customers, cards, devices, IPs, addresses, catalog
  - Normal shopping behavior, plus fraud scenarios: card testing, stolen card with high-value purchase, account takeover, velocity burst, impossible travel, promo abuse, friendly fraud
  - `generate` mode: labeled Parquet output, used to train the XGBoost baseline
  - `replay` mode: streams transactions to the API at a set TPS with a chosen strategy, holds labels back, and posts chargebacks later
- `ml/` — Python: `train.py` (XGBoost with a time-based split), `export.py` (ONNX plus `feature_schema.json`)
- `benchmark/` — Python: replays a fixed seeded dataset through each strategy and writes `report.html` (precision/recall overall and per pattern, recall at 1% FPR, p50/p99 latency, Jev cost per 1,000 transactions from `usage`, sample explanations)
- `contracts/` — OpenAPI spec, `feature_spec.md`, golden vectors shared by the TypeScript and Python feature code
- `docker-compose.yml` — scoring-service, Postgres, Redis; `.env.example` with `TYPESAFE_API_KEY`. The real `.env` is gitignored.

## Milestones (each one is a series of small commits)
1. **Scaffold:** monorepo, TypeScript service skeleton, Python projects, Compose with Postgres and Redis, `.gitignore` covering `.env`, README
2. **API contract:** OpenAPI spec, zod schemas, API-key authentication, transaction persistence
3. **Simulator:** entities, normal traffic and fraud scenarios, `generate` mode
4. **Features:** TypeScript extractor with Redis counters, Python equivalent, golden-vector parity tests
5. **Tier 0 rules and decision policy:** the `rules` strategy works end to end
6. **Jev integration:** question set, masking, classifier wrapper with fallback; the `jev` and `jev_rules` strategies work
7. **XGBoost baseline:** train, export to ONNX, `XgbScorer`; the `xgboost` strategy works
8. **Feedback and benchmark:** label endpoint, replay with delayed chargebacks, benchmark report
9. **Showcase polish:** README with an architecture diagram, benchmark results, and a typed decision walkthrough for one transaction

## Verification
- Unit tests: Vitest for rules, policy, masking (no raw PII reaches the Jev payload) and features; pytest for the simulator and training.
- The Jev client is tested with a stubbed transport. One live smoke test runs against the real API and is gated by `TYPESAFE_API_KEY`.
- Parity: TypeScript and Python features match on the golden vectors.
- End to end: `docker compose up`, then `simulator replay --strategy jev_rules --tps 20 --duration 5m`, then `benchmark run` produces a report comparing all four strategies.
- Success means `jev_rules` matches or beats `xgboost` on recall at a fixed review rate, with an explanation (pattern and reasons) for every flagged transaction. Latency and cost are reported, not assumed.
