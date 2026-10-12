"""vigil-sim command line."""

from __future__ import annotations

import argparse
import time
from datetime import UTC, datetime
from pathlib import Path

from .generate import GenerateConfig, generate, summarize, write_jsonl, write_parquet


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

    args = parser.parse_args(argv)
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
