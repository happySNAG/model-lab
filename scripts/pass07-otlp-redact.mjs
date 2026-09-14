#!/usr/bin/env node
// Cernum Pass 7 · scrub the identifiers the Codex CLI puts in its own telemetry, at the boundary.
//
// THE FINDING THIS SCRIPT EXISTS BECAUSE OF. Every log record `codex` exports carries `user.email`
// and `user.account_id`. The prompt it redacts itself — `log_user_prompt` defaults off and the
// attribute arrives as the literal `[REDACTED]` — but the account identifiers it does not. So a
// collector that keeps what it receives keeps the operator's email address in every record, and an
// evidence file built from it could not be attached to a report.
//
// This runs over the collector's output, replaces each identifier with a STABLE placeholder so two
// records from one session can still be correlated, and writes a new file. The unredacted original
// is then deleted by the caller: a redacted copy sitting beside the original redacts nothing.

import * as fs from 'node:fs';

const SENSITIVE = new Set([
  'user.email', 'user.account_id', 'conversation.id', 'host.name',
  // Not an identifier of a person, but it is this machine's name and no finding needs it.
  'service.instance.id',
]);

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  process.stderr.write('usage: pass07-otlp-redact.mjs <payloads.jsonl> <redacted.jsonl>\n');
  process.exit(2);
}

const placeholders = new Map();
let redactions = 0;
function placeholderFor(key, value) {
  const cacheKey = `${key} ${value}`;
  if (!placeholders.has(cacheKey)) {
    // Stable per distinct value, so "the same conversation" stays visible without the id itself.
    placeholders.set(cacheKey, `[REDACTED:${key}:${placeholders.size + 1}]`);
  }
  redactions += 1;
  return placeholders.get(cacheKey);
}

function scrub(node) {
  if (Array.isArray(node)) return node.map(scrub);
  if (node === null || typeof node !== 'object') return node;
  // An OTLP attribute is `{ key, value: { stringValue: ... } }`, so the key and the value it governs
  // are siblings. Rewriting has to happen at the pair, not at the leaf.
  if (typeof node.key === 'string' && SENSITIVE.has(node.key) && node.value && typeof node.value === 'object') {
    const value = node.value;
    const field = ['stringValue', 'intValue', 'doubleValue'].find((name) => name in value);
    if (field !== undefined) {
      return { ...node, value: { ...value, [field]: placeholderFor(node.key, String(value[field])) } };
    }
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, scrub(value)]));
}

const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean);
const out = lines.map((line) => JSON.stringify(scrub(JSON.parse(line))));
fs.writeFileSync(output, `${out.join('\n')}\n`, 'utf8');

// Proof rather than assertion: the redacted file is re-read and searched for the shape an email
// address that survived would have.
const written = fs.readFileSync(output, 'utf8');
const emailShape = new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}', 'g');
const leaks = [...written.matchAll(emailShape)].map((match) => match[0]);
process.stdout.write(`${lines.length} payload(s) scrubbed · ${redactions} attribute value(s) replaced · `
  + `${placeholders.size} distinct identifier(s)\n`);
process.stdout.write(leaks.length === 0
  ? 'leak audit: clean — no email-shaped string survived\n'
  : `leak audit: FAILED — ${leaks.length} email-shaped string(s) remain\n`);
process.exit(leaks.length === 0 ? 0 : 1);
