"""Renders the benchmark as a self-contained HTML report.

    uv run vigil-bench-report [--in reports/bench]
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any

from .metrics import ALERT_BUDGETS, DECISIONS, compute, explanation_samples, load

LABELS = {"rules": "Rules", "xgboost": "XGBoost", "jev": "Jev", "jev_rules": "Jev + rules"}
ORDER = ["rules", "xgboost", "jev", "jev_rules"]


def pct(x: float | None, digits: int = 1) -> str:
    return "–" if x is None else f"{x * 100:.{digits}f}%"


def esc(x: Any) -> str:
    return html.escape(str(x))


def bar(value: float | None, best: bool) -> str:
    if value is None:
        return "<td class='num'>–</td>"
    width = max(0.0, min(1.0, value)) * 100
    cls = " best" if best else ""
    return (f"<td class='num{cls}'><div class='bar'><span style='width:{width:.1f}%'></span></div>"
            f"{pct(value)}</td>")


def table(headers: list[str], rows: list[str], cls: str = "") -> str:
    head = "".join(f"<th>{esc(h)}</th>" for h in headers)
    return f"<table class='{cls}'><thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table>"


def render(metrics: dict[str, dict[str, Any]], samples: list[dict[str, Any]], meta: dict[str, Any]) -> str:
    strategies = [s for s in ORDER if s in metrics]

    def best_of(get, higher=True):
        vals = {s: get(metrics[s]) for s in strategies}
        vals = {s: v for s, v in vals.items() if v is not None}
        if not vals:
            return set()
        target = max(vals.values()) if higher else min(vals.values())
        return {s for s, v in vals.items() if abs(v - target) < 1e-12}

    # Headline: recall at equal alert rate.
    headline_rows = []
    best = {b: best_of(lambda m, b=b: m["recall_at_alert_rate"][f"{b:.1%}"]) for b in ALERT_BUDGETS}
    for s in strategies:
        m = metrics[s]
        cells = "".join(bar(m["recall_at_alert_rate"][f"{b:.1%}"], s in best[b]) for b in ALERT_BUDGETS)
        headline_rows.append(f"<tr><th>{LABELS[s]}</th>{cells}</tr>")
    ceiling = metrics[strategies[0]]["max_recall_at_alert_rate"] if strategies else {}
    headline_rows.append("<tr class='ceiling'><th>Best possible</th>"
                         + "".join(f"<td class='num'>{pct(ceiling.get(f'{b:.1%}'))}</td>" for b in ALERT_BUDGETS) + "</tr>")

    # Operating point (the strategy's own decisions).
    op_rows = []
    b_recall = best_of(lambda m: m["flagged_recall"])
    b_prec = best_of(lambda m: m["flagged_precision"])
    b_fric = best_of(lambda m: m["legit_friction"], higher=False)
    for s in strategies:
        m = metrics[s]
        op_rows.append(
            f"<tr><th>{LABELS[s]}</th>{bar(m['flagged_recall'], s in b_recall)}{bar(m['flagged_precision'], s in b_prec)}"
            f"<td class='num'>{pct(m['blocked_recall'])}</td><td class='num'>{pct(m['blocked_precision'])}</td>"
            f"<td class='num{' best' if s in b_fric else ''}'>{pct(m['legit_friction'], 2)}</td>"
            f"<td class='num'>{pct(m['alert_rate'], 2)}</td></tr>"
        )

    mix_rows = []
    for s in strategies:
        for kind in ("legit", "fraud"):
            mix = metrics[s]["decision_mix"][kind]
            mix_rows.append(f"<tr><th>{LABELS[s]}</th><td>{kind}</td>"
                            + "".join(f"<td class='num'>{pct(mix[d], 2)}</td>" for d in DECISIONS) + "</tr>")

    scenarios = sorted({sc for s in strategies for sc in metrics[s]["by_scenario"]})
    sc_rows = []
    for sc in scenarios:
        n = next(metrics[s]["by_scenario"][sc]["n"] for s in strategies if sc in metrics[s]["by_scenario"])
        b = best_of(lambda m, sc=sc: m["by_scenario"].get(sc, {}).get("flagged"))
        cells = "".join(bar(metrics[s]["by_scenario"].get(sc, {}).get("flagged"), s in b) for s in strategies)
        pat = "".join(f"<td class='num'>{pct(metrics[s]['by_scenario'].get(sc, {}).get('pattern_accuracy'), 0)}</td>"
                      for s in strategies)
        sc_rows.append(f"<tr><th>{esc(sc)}</th><td class='num'>{n}</td>{cells}{pat}</tr>")

    ops_rows = []
    for s in strategies:
        j = metrics[s]["jev"]
        if not j or not s.startswith("jev"):
            continue
        lat = j["latency_ms"]
        ops_rows.append(
            f"<tr><th>{LABELS[s]}</th><td class='num'>{j['calls_per_1k_txns']:.0f}</td>"
            + "".join(f"<td class='num'>{'–' if lat[q] is None else f'{lat[q]:.0f} ms'}</td>" for q in ("p50", "p95", "p99"))
            + f"<td class='num'>{'–' if j['mean_input_tokens'] is None else f'{j['mean_input_tokens']:,.0f}'}</td>"
            f"<td class='num'>{j['hard_rule_skips']}</td><td class='num'>{j['fallbacks']}</td></tr>"
        )

    sample_blocks = []
    for smp in samples:
        lines = []
        for s in strategies:
            r = smp["strategies"].get(s)
            if not r:
                continue
            reasons = "".join(f"<li><code>{esc(x['code'])}</code> {esc(x['message'])}</li>" for x in r["reasons"][:4])
            pattern = f" · pattern <b>{esc(r['pattern'])}</b>" if r["pattern"] else ""
            lines.append(f"<div class='expl'><div class='who'>{LABELS[s]}: <span class='d d-{esc(r['decision'])}'>"
                         f"{esc(r['decision'])}</span>{pattern}</div><ul>{reasons or '<li>(no reasons)</li>'}</ul></div>")
        sample_blocks.append(f"<details><summary><b>{esc(smp['scenario'])}</b> <code>{esc(smp['transaction_id'])}</code>"
                             f"</summary><div class='grid'>{''.join(lines)}</div></details>")

    pilot = (f"<p class='warn'>Pilot run: limited to {meta['limit']:,} sampled transactions. Rates are indicative only.</p>"
             if meta.get("limit") else "")
    jev_note = ""
    if meta.get("jev_errors"):
        jev_note = f"<p class='warn'>Jev errors during the run (fell back to rules): {esc(json.dumps(meta['jev_errors']))}</p>"

    css = """
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e3df;--card:#fff;--accent:#2f6f5e;--accentbg:#e3efe9;--warn:#8a5a00;--warnbg:#fff4dc}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9c9b94;--line:#33332f;--card:#1e1e1c;--accent:#7cc4ad;--accentbg:#21352e;--warn:#f0c46a;--warnbg:#3a2f15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 8px}
.sub{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 14px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
thead th{color:var(--muted);font-weight:600;font-size:13px}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}tr.ceiling th,tr.ceiling td{color:var(--muted);font-weight:400}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.best{font-weight:700;color:var(--accent)}
.bar{display:inline-block;width:70px;height:6px;background:var(--line);border-radius:3px;margin-right:8px;vertical-align:middle}
.bar span{display:block;height:100%;background:var(--accent);border-radius:3px}
.warn{background:var(--warnbg);color:var(--warn);padding:8px 12px;border-radius:8px}
p.note{color:var(--muted);font-size:13px}details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}
summary{cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:10px}
.expl ul{margin:6px 0 0;padding-left:18px;font-size:13px}.who{font-size:14px}.d{padding:1px 6px;border-radius:4px;background:var(--accentbg)}
code{font-size:12px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:14px}dt{color:var(--muted)}dd{margin:0}
"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vigil Benchmark</title><style>{css}</style></head><body><main>
<h1>Vigil fraud detection benchmark</h1>
<p class="sub">Rules vs XGBoost vs Jev on simulated eCommerce traffic, with ground-truth labels.</p>
{pilot}{jev_note}
<h2>Recall at equal alert rate</h2>
<p class="note">Share of fraud caught when each strategy flags the same share of all orders (its highest-scored ones). This is the fair comparison: same review capacity.</p>
<div class="card">{table(["Strategy"] + [f"flag top {b:.1%}" for b in ALERT_BUDGETS], headline_rows)}</div>
<h2>Each strategy's own decisions</h2>
<p class="note">Using each strategy's policy as configured. "Flagged" = review or block. Friction = legitimate orders not allowed straight through.</p>
<div class="card">{table(["Strategy", "Flagged recall", "Flagged precision", "Block recall", "Block precision", "Legit friction", "Alert rate"], op_rows)}</div>
<h2>Fraud caught by scenario</h2>
<p class="note">Flagged recall per scenario, then pattern accuracy (share of flagged fraud labelled with the right pattern; – where a strategy does not predict patterns). Friendly fraud looks legitimate by design.</p>
<div class="card">{table(["Scenario", "n"] + [LABELS[s] for s in strategies] + [f"pattern · {LABELS[s]}" for s in strategies], sc_rows)}</div>
<h2>Decision mix</h2>
<div class="card">{table(["Strategy", "Traffic"] + DECISIONS, mix_rows)}</div>
{"<h2>Jev operations</h2><div class='card'>" + table(["Strategy", "Jev calls / 1k orders", "Latency p50", "p95", "p99", "Input tokens / call", "Hard-rule skips", "Fallbacks"], ops_rows) + "</div>" if ops_rows else ""}
<h2>How each strategy explains a fraud case</h2>
{''.join(sample_blocks)}
<h2>Method</h2>
<dl>
<dt>Dataset</dt><dd>{meta['dataset_rows']:,} simulated transactions ({esc(Path(meta['dataset']).name)}), never used for training or tuning</dd>
<dt>Sample</dt><dd>{meta['sample_rows']:,} scored: all {meta['sample_fraud']:,} fraud + a seeded random legit sample, weighted back to full traffic</dd>
<dt>Features</dt><dd>38 behavioral features computed once over the full time-ordered stream; identical inputs for every strategy</dd>
<dt>Jev</dt><dd>model {esc(meta.get('jev_model_requested'))}, question set {esc(meta.get('question_set_version'))}; personal data masked before every call</dd>
<dt>XGBoost</dt><dd>{esc(meta.get('xgb_model_version'))}, trained on a different simulated dataset with point-in-time labels</dd>
<dt>Caveat</dt><dd>Features, rules and simulator were written by the same author; results show relative behavior on this synthetic data, not production performance.</dd>
<dt>Generated</dt><dd>{esc(meta['generated_at'])}</dd>
</dl>
</main></body></html>
"""


def render_markdown(metrics: dict[str, dict[str, Any]], meta: dict[str, Any]) -> str:
    strategies = [s for s in ORDER if s in metrics]
    names = [LABELS[s] for s in strategies]

    def md_table(headers: list[str], rows: list[list[str]]) -> str:
        lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
        lines += ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join(lines)

    budgets = [f"{b:.1%}" for b in ALERT_BUDGETS]
    best = {b: max(metrics[s]["recall_at_alert_rate"][b] for s in strategies) for b in budgets}

    def cell(v: float, b: str) -> str:
        return f"**{pct(v)}**" if abs(v - best[b]) < 1e-12 else pct(v)

    headline = [[LABELS[s]] + [cell(metrics[s]["recall_at_alert_rate"][b], b) for b in budgets] for s in strategies]
    headline.append(["_Best possible_"] + [f"_{pct(metrics[strategies[0]]['max_recall_at_alert_rate'][b])}_" for b in budgets])
    own = [[LABELS[s], pct(m["flagged_recall"]), pct(m["flagged_precision"]), pct(m["blocked_recall"]),
            pct(m["blocked_precision"]), pct(m["legit_friction"], 2)]
           for s in strategies for m in [metrics[s]]]
    scenarios = sorted({sc for s in strategies for sc in metrics[s]["by_scenario"]})
    sc_rows = []
    for sc in scenarios:
        n = next(metrics[s]["by_scenario"][sc]["n"] for s in strategies if sc in metrics[s]["by_scenario"])
        sc_rows.append([sc, str(n)] + [pct(metrics[s]["by_scenario"].get(sc, {}).get("flagged")) for s in strategies]
                       + [pct(metrics[s]["by_scenario"].get(sc, {}).get("pattern_accuracy"), 0) for s in strategies])
    ops = []
    for s in strategies:
        j = metrics[s]["jev"]
        if j and s.startswith("jev"):
            lat = j["latency_ms"]
            ops.append([LABELS[s], f"{j['calls_per_1k_txns']:.0f}", *(f"{lat[q]:.0f} ms" for q in ("p50", "p95", "p99")),
                        f"{j['mean_input_tokens']:,.0f}", str(j["hard_rule_skips"]), str(j["fallbacks"])])

    parts = [
        "# Benchmark results",
        "",
        (
            f"_Generated {meta['generated_at'][:10]} by `uv run vigil-bench-report --markdown`. "
            f"Jev model {', '.join(meta.get('jev_models_seen') or [str(meta.get('jev_model_requested'))])} "
            f"(question set {meta.get('question_set_version')}); XGBoost {meta.get('xgb_model_version')}._"
        ),
        "",
        (
            f"Holdout: {meta['dataset_rows']:,} simulated transactions (seed 101), never used for training or tuning. "
            f"Scored sample: {meta['sample_rows']:,} (all {meta['sample_fraud']:,} fraud plus a seeded random sample "
            "of legitimate orders, weighted back to full traffic). Every strategy sees identical features."
        ),
        "",
        "## Recall at equal alert rate",
        "",
        (
            "Share of fraud caught when each strategy flags the same share of all orders (its highest-scored ones). "
            "Fraud is ~2% of orders, so 2% is the smallest budget that could catch all of it."
        ),
        "",
        md_table(["Strategy"] + [f"Flag top {b}" for b in budgets], headline),
        "",
        "## Each strategy's own decisions",
        "",
        "Flagged = review or block. Legit friction = legitimate orders not allowed straight through (mostly 3-D Secure step-ups).",
        "",
        md_table(["Strategy", "Flagged recall", "Flagged precision", "Block recall", "Block precision", "Legit friction"], own),
        "",
        "## By fraud scenario",
        "",
        (
            "Flagged recall, then pattern accuracy (share of flagged fraud given the right pattern; – where a "
            "strategy does not predict patterns). Friendly fraud is designed to look legitimate at checkout."
        ),
        "",
        md_table(["Scenario", "n"] + names + [f"Pattern: {n}" for n in names], sc_rows),
    ]
    if ops:
        parts += ["", "## Jev operations", "",
                  md_table(["Strategy", "Jev calls / 1k orders", "p50", "p95", "p99", "Input tokens / call",
                            "Hard-rule skips (sample)", "Fallbacks"], ops)]
    parts += [
        "",
        "## Caveats",
        "",
        (
            "- The simulator, features and rules share an author, and XGBoost is trained on data from the same "
            "generator. Results show relative behavior on synthetic data, not production performance."
        ),
        "- Jev's decision thresholds were set before measurement and not calibrated; XGBoost's cutoffs are calibrated by alert rate.",
        "- Rates are weighted estimates from a stratified sample; legit-side rates carry sampling noise.",
        "",
        "## Reproduce",
        "",
        "```bash",
        "uv run vigil-sim generate --format jsonl --seed 101 --out data/sim/holdout.jsonl",
        "uv run vigil-sim generate --format jsonl --seed 7 --days 120 --out data/sim/train.jsonl && uv run vigil-train",
        f"cd scoring-service && npm run bench -- ../data/sim/holdout.jsonl --legit-sample {meta['legit_sample']} --max-calls N",
        "cd .. && uv run vigil-bench-report --markdown docs/benchmark-results.md",
        "```",
        "",
    ]
    return "\n".join(parts)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="vigil-bench-report")
    parser.add_argument("--in", dest="results_dir", type=Path, default=Path("reports/bench"))
    parser.add_argument("--markdown", type=Path, help="also write a Markdown summary (e.g. docs/benchmark-results.md)")
    args = parser.parse_args(argv)
    rows, meta = load(args.results_dir)
    meta["jev_models_seen"] = sorted({r.jev_model for r in rows if r.jev_model})
    metrics = compute(rows)
    samples = explanation_samples(rows)
    (args.results_dir / "summary.json").write_text(json.dumps({"meta": meta, "metrics": metrics}, indent=2) + "\n")
    (args.results_dir / "report.html").write_text(render(metrics, samples, meta))
    if args.markdown:
        args.markdown.write_text(render_markdown(metrics, meta))
        print(f"wrote {args.markdown}")
    for s in [s for s in ORDER if s in metrics]:
        m = metrics[s]
        r = m["recall_at_alert_rate"]
        at = " / ".join(pct(r[f"{b:.1%}"]) for b in ALERT_BUDGETS)
        print(f"{LABELS[s]:<12} recall @{'/'.join(f'{b:.0%}' for b in ALERT_BUDGETS)} alerts {at}"
              f"   flagged recall {pct(m['flagged_recall'])} precision {pct(m['flagged_precision'])}"
              f"   legit friction {pct(m['legit_friction'], 2)}")
    print(f"wrote {args.results_dir / 'report.html'}")


if __name__ == "__main__":
    main()
