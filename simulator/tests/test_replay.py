import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from vigil_simulator.replay import Api, build_timeline, label_body, replay


def row(tid, at, fraud=False, reported=None, scenario=None, pattern="none"):
    return {
        "transaction": {"transaction_id": tid, "occurred_at": at},
        "label": {
            "is_fraud": fraud,
            "scenario": scenario or ("stolen_card" if fraud else "legit"),
            "pattern": pattern,
            "reported_at": reported,
            "report_source": "chargeback" if reported else None,
        },
    }


ROWS = [
    row("t1", "2026-09-01T10:00:00Z", True, "2026-09-01T12:00:00Z", pattern="stolen_card"),
    row("t2", "2026-09-01T11:00:00Z"),
    row("t3", "2026-09-01T12:00:00Z"),  # same instant as t1's label
    row("t4", "2026-09-01T13:00:00Z", True, "2026-09-20T00:00:00Z", pattern="card_testing"),
]


def test_timeline_interleaves_labels_in_time_order():
    events = [(e.kind, e.row["transaction"]["transaction_id"]) for e in build_timeline(ROWS)]
    assert events == [("score", "t1"), ("score", "t2"), ("score", "t3"), ("label", "t1"), ("score", "t4")]


def test_late_labels_only_when_flushed():
    kinds = [e.kind for e in build_timeline(ROWS, flush_labels=True)]
    assert kinds.count("label") == 2 and kinds[-1] == "label"


def test_label_body():
    assert label_body(ROWS[0]) == {
        "label": "fraud", "reported_at": "2026-09-01T12:00:00Z", "source": "chargeback", "fraud_pattern": "stolen_card",
    }


@pytest.fixture
def fake_api():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            calls.append((self.path, self.headers["x-api-key"], body))
            if self.path.endswith("/label"):
                self.send_response(204)
                self.end_headers()
                return
            payload = json.dumps({
                "decision": "block" if body["transaction_id"] == "t4" else "allow",
                "fraud_probability": 0.1, "pattern": "none", "risk_level": "low",
                "reasons": [{"code": "X", "message": "x"}], "strategy": "rules", "latency_ms": 0.5,
            }).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}", calls
    server.shutdown()


def test_replay_posts_scores_then_labels(fake_api, tmp_path):
    url, calls = fake_api
    out = tmp_path / "results.jsonl"
    stats = replay(ROWS, Api(url, "k"), out)
    assert [c[0] for c in calls] == [
        "/v1/transactions/score", "/v1/transactions/score", "/v1/transactions/score",
        "/v1/transactions/t1/label", "/v1/transactions/score",
    ]
    assert all(c[1] == "k" for c in calls)
    assert stats.scored == 4 and stats.labels_sent == 1 and not stats.errors
    results = [json.loads(line) for line in out.read_text().splitlines()]
    assert [r["decision"] for r in results] == ["allow", "allow", "allow", "block"]
    assert results[3]["scenario"] == "stolen_card" and results[3]["is_fraud"]
