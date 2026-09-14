#!/usr/bin/env node
// Cernum Pass 7 · a local OTLP receiver, bound to loopback, that keeps everything and sends nothing.
//
// WHY THIS EXISTS. Pass 5C decision 1(c) and Pass 6 decision 4 both ended at the same question:
// `codex exec --json` reports no model identity, no reasoning-effort echo, no cost and no rate-limit
// figure, so effort and allowance are unmeasurable on that provider. The Codex CLI does, separately,
// carry an OpenTelemetry exporter. If its telemetry names the effort it applied or the allowance it
// spent, the two figures Cernum cannot currently obtain would become obtainable without one extra
// request beyond the benchmark's own.
//
// WHAT THIS IS NOT ALLOWED TO BE. It is not a proxy, not a man-in-the-middle and not a way to read
// anything the CLI does not choose to export. It binds 127.0.0.1 only, it makes no outbound
// connection of any kind, and it writes what it receives to one file under a directory the caller
// names. The Codex CLI is pointed at it by a PER-INVOCATION `-c` override, so the user's own
// `~/.codex/config.toml` is never edited and no other Codex session on this machine is affected.
//
// WHAT IT MAY NEVER ESTABLISH. Nothing arriving here is evidence of which model answered. Codex
// identity remains `requestAcceptedIdentityUnverifiable`, and a telemetry attribute is a claim the
// client made about itself rather than a model naming itself in a reply. That distinction is the
// whole of Pass 5B and this collector does not touch it.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const outDirectory = process.argv[2];
const port = Number(process.argv[3] ?? 4318);
if (!outDirectory) {
  process.stderr.write('usage: pass07-otlp-collector.mjs <output-directory> [port]\n');
  process.exit(2);
}
fs.mkdirSync(outDirectory, { recursive: true });
const payloadFile = path.join(outDirectory, 'otlp-payloads.jsonl');
const summaryFile = path.join(outDirectory, 'otlp-collector-summary.txt');

let received = 0;
const byPath = new Map();

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    received += 1;
    byPath.set(request.url, (byPath.get(request.url) ?? 0) + 1);
    // Kept verbatim. A collector that parsed and reshaped what it received would be a collector
    // whose findings could not be checked against what the tool actually sent.
    const record = {
      at: new Date().toISOString(),
      method: request.method,
      url: request.url,
      contentType: request.headers['content-type'] ?? '',
      contentLength: body.length,
      // JSON when the exporter is configured for it; base64 otherwise, so a protobuf payload is
      // still recorded rather than silently dropped.
      json: tryJSON(body),
      base64: tryJSON(body) === undefined ? body.toString('base64') : undefined,
    };
    fs.appendFileSync(payloadFile, `${JSON.stringify(record)}\n`, 'utf8');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});

function tryJSON(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value === null || typeof value !== 'object' ? undefined : value;
  } catch { return undefined; }
}

// Loopback only, and stated in the log so the binding is part of the evidence rather than a claim.
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`OTLP collector listening on http://127.0.0.1:${port} (loopback only)\n`);
  process.stdout.write(`payloads: ${payloadFile}\n`);
});

const finish = () => {
  const lines = [
    `collector stopped at ${new Date().toISOString()}`,
    `bound to 127.0.0.1:${port} — loopback only, no outbound connection was made`,
    `payloads received: ${received}`,
    ...[...byPath.entries()].sort().map(([url, count]) => `  ${url}  ${count}`),
  ];
  fs.writeFileSync(summaryFile, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${lines.join('\n')}\n`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
