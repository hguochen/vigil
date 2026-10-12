"""vigil-sim command line."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

from .generate import GenerateConfig, generate, summarize, write_jsonl, write_parquet
from .replay import Api, replay
from .replay import summarize as summarize_replay


def parse_date(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="vigil-sim", description="Vigil transaction simulator")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="write a labeled transaction dataset")
    gen.add_argument("--customers", type=int, default=5_000)
    gen.add_argument("--days", type=int, default=60)
    gen.add_argument("--fraud-rate", type=float, default=0.02)
    gen.add_argument("--seed", type=int, default=7)
    gen.add_argument("--start", type=parse_date, default=parse_date("2026-08-01"))
    gen.add_argument("--out", type=Path, default=None,
                     help="output path (default data/sim/transactions.<format>)")
    gen.add_argument("--format", choices=["parquet", "jsonl"], default="parquet")

    rep = sub.add_parser("replay", help="stream a JSONL dataset into the scoring API, with late labels")
    rep.add_argument("--data", type=Path, required=True)
    rep.add_argument("--url", default="http://localhost:8080")
    rep.add_argument("--api-key", default=os.environ.get("VIGIL_API_KEY") or "dev-local-key",
                     help="defaults to $VIGIL_API_KEY, then the public development key")
    rep.add_argument("--limit", type=int, help="replay only the first N transactions")
    rep.add_argument("--tps", type=float, help="max transactions per second (default: as fast as possible)")
    rep.add_argument("--flush-labels", action="store_true",
                     help="also deliver labels reported after the last replayed transaction")
    rep.add_argument("--out", type=Path, help="write one JSON line per scored transaction")

    args = parser.parse_args(argv)
    if args.command == "replay":
        rows = []
        with args.data.open() as f:
            for line in f:
                if args.limit is not None and len(rows) >= args.limit:
                    break
                if line.strip():
                    rows.append(json.loads(line))
        began = time.perf_counter()
        stats = replay(rows, Api(args.url, args.api_key), args.out, args.tps, args.flush_labels)
        print(summarize_replay(stats))
        print(f"replayed {len(rows):,} in {time.perf_counter() - began:.1f}s" + (f" -> {args.out}" if args.out else ""))
        return
    if args.command == "generate":
        if not 0 < args.fraud_rate < 1:
            parser.error("--fraud-rate must be between 0 and 1")
        config = GenerateConfig(args.seed, args.customers, args.days, args.fraud_rate, args.start)
        began = time.perf_counter()
        records = generate(config)
        out = args.out or Path(f"data/sim/transactions.{args.format}")
        if args.format == "jsonl":
            write_jsonl(records, out)
        else:
            write_parquet(records, out, config)
        print(summarize(records))
        print(f"wrote {out} in {time.perf_counter() - began:.1f}s")


if __name__ == "__main__":
    main()
