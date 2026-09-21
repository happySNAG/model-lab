// The Codex workspace driver against the REAL installed `codex`, with a LOOPBACK provider.
//
// OPT-IN: set CERNUM_CODEX_LOOPBACK=1. It needs codex-cli 0.155.0 on PATH and a signed-in ChatGPT
// session (the driver's preflight runs the real `codex --version` and `codex doctor --json`), and it
// is skipped everywhere else.
//
// WHY IT EXISTS. The parity tests prove what the driver SENDS and how it READS; they cannot prove that
// the installed binary accepts the argument vector, that the permission profile actually confines a
// model command, or that the stream the driver parses is the stream the binary writes. This proves all
// three, and it costs nothing: the only difference from a live run is a wrapper that inserts a
// `model_provider` pointing at a fake Responses server on 127.0.0.1, so no request leaves the machine
// and nothing is billed. The fake plays a scripted "model": run the tests, try three escapes, patch
// the bug, run the tests again, answer.
//
// The wrapper is a TEST SEAM, not a driver option. Nothing in the driver can point the CLI anywhere
// but its own provider.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { findExecutable } from '../../src/engine/cli-process';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { CODEX_CLI_VERSION_VERIFIED_AGAINST, CodexWorkspaceDriver } from '../../src/engine/workspace-codex-driver';

const ENABLED = process.env.CERNUM_CODEX_LOOPBACK === '1';
const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const PROBE_NAME = `cernum-loopback-escape-${process.pid}.txt`;

// The WHOLE defect, comment included: the case's invariant forbids `values.length + 1` anywhere in
// the file, and the fixture's own doc comment names it. A patch that fixed only the code line fails.
const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/stats.js',
  '@@',
  ' /**',
  '  * The arithmetic mean.',
  '- *',
  '- * THIS IS THE BUG THE FIXTURE CARRIES: the divisor is `values.length + 1`, so every mean is too',
  '- * small and an empty list returns 0 instead of throwing. `test/stats.test.js` fails because of it.',
  '  */',
  ' function mean(values) {',
  '-  return sum(values) / (values.length + 1);',
  "+  if (values.length === 0) throw new RangeError('the mean of an empty list is undefined');",
  '+  return sum(values) / values.length;',
  ' }',
  '*** End Patch',
  '',
].join('\n');

/** One output list per model request, in order. */
const SCRIPT: unknown[][] = [
  [{ type: 'function_call', id: 'fc_1', call_id: 'call_run', name: 'exec_command', arguments: JSON.stringify({ cmd: 'node test/stats.test.js' }) }],
  [{
    type: 'function_call', id: 'fc_2', call_id: 'call_escape', name: 'exec_command',
    arguments: JSON.stringify({
      cmd: `echo x > ~/${PROBE_NAME}; echo y > /tmp/${PROBE_NAME}; head -c 5 ~/.codex/auth.json; curl -sS -m 3 https://example.com -o /dev/null; echo probes-done`,
    }),
  }],
  [{ type: 'custom_tool_call', id: 'ct_1', call_id: 'call_patch', name: 'apply_patch', input: PATCH }],
  [{ type: 'function_call', id: 'fc_3', call_id: 'call_rerun', name: 'exec_command', arguments: JSON.stringify({ cmd: 'node test/stats.test.js' }) }],
  [{ type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'Fixed the divisor in mean.' }] }],
];

let server: http.Server | undefined;
let port = 0;
let requestBodies: Record<string, unknown>[] = [];
let wrapper = '';
let realCodex: string | undefined;
let scratch = '';

beforeAll(async () => {
  if (!ENABLED) return;
  realCodex = findExecutable('codex');
  if (realCodex === undefined) throw new Error('CERNUM_CODEX_LOOPBACK=1 but no codex on PATH');
  // Realpath'd, so no `/var` → `/private/var` hop sits between the driver and the one link this test supplies.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-codex-loopback-')));
  const models = spawnSync(realCodex, ['debug', 'models'], { encoding: 'utf8' }).stdout;
  let turn = 0;
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(models);
        return;
      }
      try { requestBodies.push(JSON.parse(body) as Record<string, unknown>); } catch { /* recorded as nothing */ }
      const items = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
      turn += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'openai-model': 'gpt-5.5' });
      const id = `resp_${turn}`;
      const send = (event: Record<string, unknown>) => response.write(`event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id } });
      for (const item of items) send({ type: 'response.output_item.done', item });
      send({ type: 'response.completed', response: { id, usage: {
        input_tokens: 1000, input_tokens_details: { cached_tokens: 400 },
        output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1050,
      } } });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;

  // THE SEAM: insert a loopback provider after `exec`, and pass everything else straight through.
  wrapper = path.join(scratch, 'codex');
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'exec') args.splice(1, 0,",
    "  '-c', 'model_provider=\"cernum_loopback\"',",
    `  '-c', 'model_providers.cernum_loopback={name="cernum-loopback", base_url="http://127.0.0.1:${port}/v1", wire_api="responses", requires_openai_auth=false, request_max_retries=0, stream_max_retries=0}');`,
    `const result = spawnSync(${JSON.stringify(realCodex)}, args, { stdio: 'inherit' });`,
    'process.exit(result.status === null ? 1 : result.status);',
    '',
  ].join('\n'), { mode: 0o755 });
}, 60_000);

afterAll(async () => {
  for (const probe of [path.join(os.homedir(), PROBE_NAME), path.join('/tmp', PROBE_NAME)]) fs.rmSync(probe, { force: true });
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('the real codex CLI, the exact driver argv, a loopback provider', () => {
  it('fixes the fixture inside the sandbox, and every escape it tries is refused', async () => {
    requestBodies = [];
    const driver = new CodexWorkspaceDriver({
      requestedModelID: 'gpt-5.5', effort: 'medium', executablePath: wrapper,
      // The sandbox has to re-allow the REAL binary's install, which the wrapper hides: the one hop
      // from the wrapper to the binary it runs is supplied here, and every further hop is read.
      readLink: (file) => {
        if (file === wrapper) return realCodex;
        try { return fs.readlinkSync(file); } catch { return undefined; }
      },
    });
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-codex-loopback-ws-'));
    try {
      const run = await runWorkspaceCase({
        case: { ...BROKEN_SUM_MEAN, execution: { ...BROKEN_SUM_MEAN.execution, maximumAttempts: 1 } },
        driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot,
      });
      const card = scoreWorkspaceRun(BROKEN_SUM_MEAN, run);
      const attempt = run.attempts[0];
      if (process.env.CERNUM_CODEX_LOOPBACK_DEBUG === '1') {
        console.log(JSON.stringify({ status: card.status, detail: card.detail, failure: attempt.agent.failure,
          diff: attempt.diff.changedPaths, verification: attempt.verificationOutcomes, termination: attempt.terminationReason,
          events: attempt.transcript.events.map((event) => `${event.kind}:${event.detail.slice(0, 160)}`) }, null, 1));
      }

      // The preflight really ran, against the real binary, and passed.
      expect(attempt.agent.activeIsolation.join(' ')).toContain(`version ${CODEX_CLI_VERSION_VERIFIED_AGAINST}`);
      expect(attempt.agent.failure).toBeUndefined();

      // The effort and the model reached the wire exactly as frozen.
      expect(requestBodies.length).toBeGreaterThanOrEqual(SCRIPT.length);
      expect(requestBodies[0].model).toBe('gpt-5.5');
      expect((requestBodies[0].reasoning as Record<string, unknown>).effort).toBe('medium');

      // No skills catalogue and no plugin instructions reached the model.
      const developerText = JSON.stringify(requestBodies[0].input);
      expect(developerText).not.toContain('<skills_instructions>');
      expect(developerText).not.toContain('<plugins_instructions>');

      // THE ESCAPES, observed as the tool reported them and as this process can see.
      const probe = attempt.transcript.events.find((event) => event.kind === 'toolResult' && event.detail.includes('probes-done'));
      expect(probe?.detail).toMatch(/operation not permitted.*cernum-loopback-escape/i);
      expect(probe?.detail).toMatch(/auth\.json: Operation not permitted/);
      expect(probe?.detail).toMatch(/Could not resolve host/);
      expect(fs.existsSync(path.join(os.homedir(), PROBE_NAME))).toBe(false);
      expect(fs.existsSync(path.join('/tmp', PROBE_NAME))).toBe(false);

      // The work, read off the tree by the engine.
      expect(attempt.diff.changedPaths).toEqual(['src/stats.js']);
      expect(attempt.verificationOutcomes[0].passed).toBe(true);
      expect(card.status).toBe('pass');
      expect(attempt.agent.finalMessage).toBe('Fixed the divisor in mean.');
      expect(attempt.agent.reportedModelID).toBe('');

      // The stream was parsed from the real binary's own shapes.
      expect(attempt.transcript.events.some((event) => event.kind === 'fileWrite' && event.workspaceRelativePath === 'src/stats.js')).toBe(true);
      expect(attempt.transcript.events.some((event) => event.kind === 'commandExecuted' && event.executable === 'node')).toBe(true);
      const usage = attempt.agent.usage as Record<string, unknown>;
      expect(usage.inputTokens).toBe(1000 * requestBodies.length);
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
