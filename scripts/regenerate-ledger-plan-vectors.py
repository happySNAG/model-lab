#!/usr/bin/env python3
"""Regenerate fixtures/parity/engine/ledger-plan-vectors.json from the reference Python harness.

The TypeScript planner in src/engine/ledger.ts is pinned against this file. It is regenerated,
never hand-edited: a hand-written expectation proves nothing about the harness it claims parity
with.

No campaign evidence is read or written. The catalogue below is synthetic and the candidate names
are invented.

    MODEL_LAB_HARNESS=/path/to/harness python3 scripts/regenerate-ledger-plan-vectors.py \
        > fixtures/parity/engine/ledger-plan-vectors.json
"""
import hashlib
import json
import os
import sys

# The reference harness is not part of this repository. Point MODEL_LAB_HARNESS at a checkout of it
# to regenerate; without it, the committed fixture stands and the parity tests still run against it.
HARNESS = os.environ.get("MODEL_LAB_HARNESS", "")
if not HARNESS or not os.path.isdir(HARNESS):
    sys.stderr.write(
        "set MODEL_LAB_HARNESS to a checkout of the reference Python harness to regenerate "
        "this fixture; the committed fixture is used otherwise\n")
    raise SystemExit(2)
sys.path.insert(0, HARNESS)

import ledger_v2  # noqa: E402


class Candidate(object):
    def __init__(self, name, model_id):
        self.name = name
        self.model_id = model_id


CATALOG = {
    "catalogDigest": "catalog-digest-for-parity-fixture",
    "caseCount": 4,
    "repeatsPerCase": 2,
    "suites": [
        {
            "slug": "reasoning", "block": "B", "executionOrdinal": 2,
            "cases": [
                {"caseID": "reasoning.chain", "caseDigest": "d3", "comparabilityKey": "k3",
                 "scoringMode": "rubric", "maxOutputTokens": 512, "inputBudgetTokens": 900,
                 "executionOrdinal": 1},
                {"caseID": "reasoning.arith", "caseDigest": "d4", "comparabilityKey": "k4",
                 "scoringMode": "exact", "maxOutputTokens": 128, "inputBudgetTokens": 300,
                 "executionOrdinal": 0},
            ],
        },
        {
            "slug": "foundation", "block": "A", "executionOrdinal": 1,
            "cases": [
                {"caseID": "foundation.echo", "caseDigest": "d1", "comparabilityKey": "k1",
                 "scoringMode": "exact", "maxOutputTokens": 256, "inputBudgetTokens": 400,
                 "executionOrdinal": 0},
                {"caseID": "foundation.json", "caseDigest": "d2", "comparabilityKey": "k2",
                 "scoringMode": "structured", "maxOutputTokens": 384, "inputBudgetTokens": 500,
                 "executionOrdinal": 1},
            ],
        },
    ],
}

CANDIDATES = [Candidate("alpha:1b", "alpha:1b"), Candidate("beta:2b", "beta-2b-id")]

plan = ledger_v2.build_plan(CATALOG, CANDIDATES)
plan_digest = hashlib.sha256(
    json.dumps([s["slotKey"] for s in plan], separators=(",", ":")).encode()).hexdigest()

print(json.dumps({
    "producedBy": "ledger_v2.build_plan from %s" % os.path.basename(HARNESS),
    "ledgerFormatVersion": ledger_v2.LEDGER_FORMAT_VERSION,
    "terminalStatuses": sorted(ledger_v2.TERMINAL_STATUSES),
    "catalog": CATALOG,
    "candidates": [{"name": c.name, "modelID": c.model_id} for c in CANDIDATES],
    "slotKeys": [s["slotKey"] for s in plan],
    "slots": plan,
    "planDigest": plan_digest,
    "slotKeyExamples": [
        {"candidate": "gemma3:4b", "suite": "foundation", "pass": 1, "caseID": "echo",
         "slotKey": ledger_v2.slot_key("gemma3:4b", "foundation", 1, "echo")},
        {"candidate": "qwen3.8:27b", "suite": "safety-boundaries", "pass": 3,
         "caseID": "safety.refusal-shape",
         "slotKey": ledger_v2.slot_key("qwen3.8:27b", "safety-boundaries", 3,
                                       "safety.refusal-shape")},
    ],
}, indent=2, ensure_ascii=False))
