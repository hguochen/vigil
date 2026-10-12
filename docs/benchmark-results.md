# Benchmark results

_Generated 2026-10-12 by `uv run vigil-bench-report --markdown`. Jev model jev-1.13.0 (question set 2026-10-12.1); XGBoost xgb-20261012-37c2075e._

Holdout: 44,097 simulated transactions (seed 101), never used for training or tuning. Scored sample: 2,882 (all 882 fraud plus a seeded random sample of legitimate orders, weighted back to full traffic). Every strategy sees identical features.

## Recall at equal alert rate

Share of fraud caught when each strategy flags the same share of all orders (its highest-scored ones). Fraud is ~2% of orders, so 2% is the smallest budget that could catch all of it.

| Strategy | Flag top 2.0% | Flag top 3.0% | Flag top 5.0% |
|---|---|---|---|
| Rules | 83.3% | 83.3% | 84.6% |
| XGBoost | **92.6%** | **93.7%** | **95.0%** |
| Jev | 75.3% | 81.3% | 89.9% |
| Jev + rules | 80.4% | 87.9% | 90.4% |
| _Best possible_ | _100.0%_ | _100.0%_ | _100.0%_ |

## Each strategy's own decisions

Flagged = review or block. Legit friction = legitimate orders not allowed straight through (mostly 3-D Secure step-ups).

| Strategy | Flagged recall | Flagged precision | Block recall | Block precision | Legit friction |
|---|---|---|---|---|---|
| Rules | 72.2% | 93.6% | 46.7% | 100.0% | 0.20% |
| XGBoost | 81.3% | 100.0% | 42.3% | 100.0% | 1.05% |
| Jev | 71.2% | 87.9% | 6.1% | 100.0% | 2.30% |
| Jev + rules | 82.9% | 80.9% | 26.4% | 100.0% | 3.15% |

## By fraud scenario

Flagged recall, then pattern accuracy (share of flagged fraud given the right pattern; – where a strategy does not predict patterns). Friendly fraud is designed to look legitimate at checkout.

| Scenario | n | Rules | XGBoost | Jev | Jev + rules | Pattern: Rules | Pattern: XGBoost | Pattern: Jev | Pattern: Jev + rules |
|---|---|---|---|---|---|---|---|---|---|
| account_takeover | 91 | 50.5% | 94.5% | 60.4% | 75.8% | 96% | – | 85% | 88% |
| card_testing | 227 | 94.7% | 63.9% | 95.6% | 98.2% | 82% | – | 100% | 98% |
| friendly_fraud | 66 | 0.0% | 0.0% | 0.0% | 0.0% | – | – | – | – |
| impossible_travel | 43 | 100.0% | 97.7% | 100.0% | 100.0% | 100% | – | 100% | 100% |
| promo_abuse | 202 | 62.9% | 94.6% | 44.1% | 75.2% | 100% | – | 100% | 100% |
| stolen_card | 115 | 86.1% | 100.0% | 96.5% | 100.0% | 100% | – | 100% | 100% |
| velocity_burst | 138 | 77.5% | 100.0% | 81.9% | 93.5% | 100% | – | 100% | 100% |

## Jev operations

| Strategy | Jev calls / 1k orders | p50 | p95 | p99 | Input tokens / call | Hard-rule skips (sample) | Fallbacks |
|---|---|---|---|---|---|---|---|
| Jev | 1000 | 127 ms | 210 ms | 248 ms | 1,624 | 0 | 0 |
| Jev + rules | 997 | 126 ms | 207 ms | 240 ms | 1,658 | 142 | 0 |

## Caveats

- The simulator, features and rules share an author, and XGBoost is trained on data from the same generator. Results show relative behavior on synthetic data, not production performance.
- Jev's decision thresholds were set before measurement and not calibrated; XGBoost's cutoffs are calibrated by alert rate.
- Rates are weighted estimates from a stratified sample; legit-side rates carry sampling noise.

## Reproduce

```bash
uv run vigil-sim generate --format jsonl --seed 101 --out data/sim/holdout.jsonl
uv run vigil-sim generate --format jsonl --seed 7 --days 120 --out data/sim/train.jsonl && uv run vigil-train
cd scoring-service && npm run bench -- ../data/sim/holdout.jsonl --legit-sample 2000 --max-calls N
cd .. && uv run vigil-bench-report --markdown docs/benchmark-results.md --readme README.md
```
