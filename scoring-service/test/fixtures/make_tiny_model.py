"""Builds test/fixtures/xgb-tiny: a one-tree ONNX classifier over the 38 features.

Same operator (ai.onnx.ml TreeEnsembleClassifier) and I/O layout as the real
XGBoost export, so the TypeScript scorer is tested on the real runtime path.

    uv run python scoring-service/test/fixtures/make_tiny_model.py
"""

import json
from pathlib import Path

import onnx
from onnx import TensorProto, helper
from vigil_ml.features import FEATURE_NAMES

OUT = Path(__file__).parent / "xgb-tiny"

# amount_usd < 100 -> P(fraud)=0.1, else 0.95; missing amount -> the "< 100" branch.
tree = helper.make_node(
    "TreeEnsembleClassifier",
    inputs=["input"],
    outputs=["label", "probabilities"],
    domain="ai.onnx.ml",
    classlabels_int64s=[0, 1],
    nodes_treeids=[0, 0, 0],
    nodes_nodeids=[0, 1, 2],
    nodes_featureids=[FEATURE_NAMES.index("amount_usd"), 0, 0],
    nodes_values=[100.0, 0.0, 0.0],
    nodes_modes=["BRANCH_LT", "LEAF", "LEAF"],
    nodes_truenodeids=[1, 0, 0],
    nodes_falsenodeids=[2, 0, 0],
    nodes_missing_value_tracks_true=[1, 0, 0],
    class_treeids=[0, 0, 0, 0],
    class_nodeids=[1, 1, 2, 2],
    class_ids=[0, 1, 0, 1],
    class_weights=[0.9, 0.1, 0.05, 0.95],
    post_transform="NONE",
)
graph = helper.make_graph(
    [tree],
    "xgb_tiny",
    [helper.make_tensor_value_info("input", TensorProto.FLOAT, [None, len(FEATURE_NAMES)])],
    [
        helper.make_tensor_value_info("label", TensorProto.INT64, [None]),
        helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [None, 2]),
    ],
)
model = helper.make_model(
    graph, opset_imports=[helper.make_opsetid("", 17), helper.make_opsetid("ai.onnx.ml", 3)]
)
model.ir_version = 9
onnx.checker.check_model(model)

OUT.mkdir(exist_ok=True)
onnx.save(model, OUT / "model.onnx")
(OUT / "feature_schema.json").write_text(
    json.dumps(
        {
            "model_version": "tiny-fixture",
            "feature_names": FEATURE_NAMES,
            "input_name": "input",
            "probability_output": "probabilities",
            "positive_class_index": 1,
        },
        indent=2,
    )
    + "\n"
)
print(f"wrote {OUT}")
