#!/usr/bin/env python3
"""Regenerate fixtures/parity/engine/canonical-vectors.json.

The engine's TypeScript encoder (src/engine/canonical.ts) is pinned against this file. It is
regenerated, never hand-edited: a hand-written expectation proves nothing about the encoding it
claims parity with. Needs only a Python 3 interpreter — no harness checkout.

    python3 scripts/regenerate-canonical-vectors.py > fixtures/parity/engine/canonical-vectors.json
"""
import hashlib
import hmac
import json
import sys

VECTORS = [
    {"name": "empty object", "value": {}},
    {"name": "empty array", "value": []},
    {"name": "key order", "value": {"b": 1, "a": 2, "A": 3, "_": 4, "0": 5}},
    {"name": "nested", "value": {"z": [1, {"y": None, "x": True}], "a": {"b": {"c": []}}}},
    {"name": "solidus is not escaped",
     "value": {"path": "a/b/c", "url": "https://example.invalid/x"}},
    {"name": "quotes and backslashes", "value": "he said \"no\" \\ then left"},
    {"name": "control characters", "value": "tab\there nl\n cr\r bs\b ff\f unit\x1f"},
    {"name": "non-ascii is literal",
     "value": {"model": "gemma3:4b", "note": "café — naïve — 日本語"}},
    {"name": "negative and zero", "value": [0, -1, 2147483647, -2147483648]},
    {"name": "booleans and null", "value": {"t": True, "f": False, "n": None}},
    {"name": "slot key shape",
     "value": "gemma3:4b|model-lab-foundation|1|foundation.echo-instruction"},
    {"name": "unicode key sort", "value": {"é": 1, "e": 2, "Z": 3, "z": 4}},
]

out = []
for v in VECTORS:
    text = json.dumps(v["value"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    out.append({
        "name": v["name"],
        "value": v["value"],
        "canonicalJSON": text,
        "digest": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    })

hmac_vectors = []
for secret, message in [("s3cret", "gemma3:4b|foundation|1|echo"), ("", ""),
                        ("café", "日本語")]:
    hmac_vectors.append({
        "secret": secret, "message": message,
        "hex": hmac.new(secret.encode("utf-8"), message.encode("utf-8"),
                        hashlib.sha256).hexdigest(),
    })

texts = ["", "a", "gemma3:4b", "café — naïve", "line\nbreak"]

print(json.dumps({
    "producedBy": "json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)"
                  " + hashlib.sha256 + hmac.new(..., sha256)",
    "pythonVersion": sys.version.split()[0],
    "vectors": out,
    "hmacVectors": hmac_vectors,
    "textDigests": [{"text": t, "sha256": hashlib.sha256(t.encode("utf-8")).hexdigest()}
                    for t in texts],
}, indent=2, ensure_ascii=False))
