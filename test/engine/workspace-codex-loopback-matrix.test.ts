// A Codex MATRIX run through the REAL installed `codex`, with the applied-effort collector attached,
// against a LOOPBACK provider, with every non-loopback connection refused by the kernel.
//
// OPT-IN: set CERNUM_CODEX_LOOPBACK=1 and run with OPENAI_API_KEY ABSENT (`env -u OPENAI_API_KEY …`).
// macOS only. It needs codex-cli 0.155.0 on PATH and a signed-in ChatGPT session on disk, because the
// driver's preflight reads the local credential store; it is skipped everywhere else.
//
// WHY IT EXISTS. `workspace-matrix-effort-telemetry.test.ts` proves the matrix telemetry path against a
// FAKE `codex` that posts records shaped like the captured ones. It cannot prove that the real binary
// reads the generated `-c otel=…` argument, exports what the observer reads, in the shape it reads, with
// a `conversation.id` equal to the `thread_id` it prints. This does, through `runWorkspaceMatrix` with the
// real collector, the real driver, the real campaign and the real aggregate. The only seams are the two
// the loopback test already uses: a wrapper that inserts a `model_provider` pointing at a fake Responses
// server on 127.0.0.1, and the `readLink` hop from that wrapper to the binary it runs.
//
// WHY THE KERNEL, AND NOT A PROMISE. With a loopback provider the binary still tries to reach
// chatgpt.com — `codex doctor` handshakes with it, and an `exec` without the driver's `--disable` flags
// connects the `codex_apps` MCP server. So "no request leaves the machine" is not left to the provider
// override: the wrapper runs every `codex` invocation (`--version`, `doctor`, `exec`) under a Seatbelt
// profile that denies every outbound connection except loopback, DNS included, and the suite refuses to
// start unless a canary under that same profile fails to resolve and fails to connect to OpenAI's own
// addresses while reaching the loopback provider. Nothing is sent to OpenAI, so nothing is billed and no
// allowance is consumed — whatever credentials are on disk.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { findExecutable } from '../../src/engine/cli-process';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { OTLPObserver, OTLPTurnObservation, codexOTLPConfigArgument } from '../../src/engine/otlp-observer';
import {
  describeProviderSessionStatus, readProviderSessionStatus, sessionPreflightRefusal,
} from '../../src/engine/provider-session-status';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { aggregateWorkspaceRuns, collectWorkspaceRunRows, describeWorkspaceCell } from '../../src/engine/workspace-aggregate';
import { RECEIPT_REFUNDS_SIGN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import {
  CODEX_CLI_VERSION_VERIFIED_AGAINST, CODEX_WORKSPACE_DRIVER_ID, CodexWorkspaceDriver,
} from '../../src/engine/workspace-codex-driver';
import {
  APPLIED_EFFORT_SOURCES, AttemptAppliedEffortEvidence, workspaceAppliedEffortProvenance,
} from '../../src/engine/workspace-effort-evidence';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import {
  parseWorkspaceMatrixAdmissionFile, sealWorkspaceMatrixAdmission,
} from '../../src/engine/workspace-matrix-admission';
import {
  MatrixObserver, WorkspaceMatrixTelemetryCollector, lateAppliedEffortEvidence,
} from '../../src/engine/workspace-matrix-telemetry';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { provenModel } from './frontier-harness';

const ENABLED = process.env.CERNUM_CODEX_LOOPBACK === '1';
const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const NODE_DIRECTORY = path.dirname(process.execPath);
const SOL = 'gpt-5.6-sol';
const ASTRA = 'gpt-6-astra';
const LABEL = 'codex-loopback-matrix';

/** Everything allowed except an outbound connection that is not loopback. DNS is denied with it. */
const EGRESS_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (remote unix-socket))',
  '(deny network-outbound (literal "/private/var/run/mDNSResponder"))',
  '',
].join('\n');

/** Run under the profile: resolve a name, connect to each address, connect to loopback. Prints JSON. */
const CANARY = `
const dns = require('dns'), net = require('net');
const [port, ...addresses] = process.argv.slice(1);
const tcp = (host, p) => new Promise((resolve) => {
  const socket = net.connect({ host, port: Number(p), timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); resolve('connected'); });
  socket.on('error', (error) => resolve('refused:' + error.code));
  socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
});
(async () => {
  const lookup = await new Promise((resolve) => dns.lookup('chatgpt.com', (error) => resolve(error ? 'refused:' + error.code : 'resolved')));
  const internet = {};
  for (const address of addresses) internet[address] = await tcp(address, 443);
  console.log(JSON.stringify({ lookup, internet, loopback: await tcp('127.0.0.1', port) }));
})();
`;

/** One recorded provider request. The only header VALUE kept is `thread-id`, held in memory for the join proof. */
interface ProviderRequest {
  url: string;
  model?: string;
  effort?: string;
  authorizationPresent: boolean;
  threadHeader?: string;
  headerNames: string[];
  usage?: { input: number; cached: number; output: number; reasoning: number };
}

/** One wrapper invocation, as the wrapper logged it. Names only, never environment values. */
interface WrapperInvocation {
  subcommand: string;
  environmentNames: string[];
  otelEndpoint?: string;
  outboundHosts: string[];
  exitCode: number | null;
}

let server: http.Server | undefined;
let port = 0;
let providerRequests: ProviderRequest[] = [];
let realCodex = '';
let scratch = '';
let wrapper = '';
let wrapperLog = '';
let canary: { lookup: string; internet: Record<string, string>; loopback: string } | undefined;

/** Distinct, recognisable usage per request, so a figure on a row can be traced to the request it came from. */
const usageFor = (n: number) => ({ input: 1000 + 111 * n, cached: 400 + 11 * n, output: 50 + n, reasoning: 20 + n });

const invocations = (): WrapperInvocation[] => (fs.existsSync(wrapperLog)
  ? fs.readFileSync(wrapperLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as WrapperInvocation) : []);

beforeAll(async () => {
  if (!ENABLED) return;
  // REFUSALS FIRST: nothing below spawns `codex` until every one of these holds.
  if (process.platform !== 'darwin') throw new Error('the egress block is a macOS Seatbelt profile; nothing was run');
  if (process.env.OPENAI_API_KEY !== undefined) {
    throw new Error('OPENAI_API_KEY is set in the test process. Run with `env -u OPENAI_API_KEY`; nothing was run.');
  }
  const found = findExecutable('codex');
  if (found === undefined) throw new Error('CERNUM_CODEX_LOOPBACK=1 but no codex on PATH');
  realCodex = fs.realpathSync(found);
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-codex-loopback-matrix-')));
  const profile = path.join(scratch, 'egress-loopback-only.sb');
  fs.writeFileSync(profile, EGRESS_PROFILE);

  let turn = 0;
  let models = '';
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const threadHeader = request.headers['thread-id'];
      const record: ProviderRequest = {
        url: request.url ?? '', authorizationPresent: request.headers.authorization !== undefined,
        threadHeader: typeof threadHeader === 'string' ? threadHeader : undefined,
        headerNames: Object.keys(request.headers).sort(),
      };
      providerRequests.push(record);
      if (request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(models);
        return;
      }
      if (!request.url?.startsWith('/v1/responses')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const parsed = JSON.parse(body) as { model?: string; reasoning?: { effort?: string } };
      record.model = parsed.model;
      record.effort = parsed.reasoning?.effort;
      const usage = usageFor(turn);
      record.usage = usage;
      turn += 1;
      // The header echoes the request, so no reroute is reported: identity is not what this test is about.
      response.writeHead(200, { 'content-type': 'text/event-stream', 'openai-model': parsed.model ?? '' });
      const id = `resp_${turn}`;
      const send = (event: Record<string, unknown>) => response.write(`event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id } });
      send({ type: 'response.output_item.done', item: {
        type: 'message', role: 'assistant', id: `msg_${turn}`, content: [{ type: 'output_text', text: 'Loopback: no change made.' }],
      } });
      send({ type: 'response.completed', response: { id, usage: {
        input_tokens: usage.input, input_tokens_details: { cached_tokens: usage.cached },
        output_tokens: usage.output, output_tokens_details: { reasoning_tokens: usage.reasoning },
        total_tokens: usage.input + usage.output,
      } } });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;

  // THE CANARY. OpenAI's own addresses are resolved OUT here (a DNS answer contacts no OpenAI server) and
  // then connected to IN the profile, beside a public resolver and the loopback provider.
  const openAIAddresses: string[] = [];
  for (const host of ['api.openai.com', 'chatgpt.com']) {
    try { openAIAddresses.push((await dns.promises.lookup(host)).address); } catch { /* offline: the others still bind */ }
  }
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', CANARY, String(port),
    '1.1.1.1', ...openAIAddresses], { encoding: 'utf8', timeout: 30_000 });
  canary = JSON.parse(probe.stdout.trim()) as typeof canary;
  const held = canary!.lookup.startsWith('refused') && canary!.loopback === 'connected'
    && Object.values(canary!.internet).every((state) => state.startsWith('refused'));
  if (!held) throw new Error(`the egress block is NOT in force (${probe.stdout.trim()}); no codex was started`);

  // Only now: the real binary, under the profile, for its version and its model catalogue.
  const version = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, realCodex, '--version'], { encoding: 'utf8' }).stdout.trim();
  if (version !== `codex-cli ${CODEX_CLI_VERSION_VERIFIED_AGAINST}`) throw new Error(`installed codex reports ${version}`);
  models = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, realCodex, 'debug', 'models'], { encoding: 'utf8' }).stdout;

  // THE SEAM: every invocation runs the real binary under the profile; `exec` also gets the loopback provider.
  // Logged: the subcommand, environment NAMES, the collector endpoint, and the HOSTS of any URL on stderr.
  wrapper = path.join(scratch, 'bin', 'codex');
  wrapperLog = path.join(scratch, 'wrapper.jsonl');
  fs.mkdirSync(path.dirname(wrapper));
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('child_process');",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'exec') args.splice(1, 0,",
    "  '-c', 'model_provider=\"cernum_loopback\"',",
    `  '-c', 'model_providers.cernum_loopback={name="cernum-loopback", base_url="http://127.0.0.1:${port}/v1", wire_api="responses", requires_openai_auth=false, request_max_retries=0, stream_max_retries=0}',`,
    "  '-c', 'project_doc_max_bytes=0');",
    `const result = spawnSync('/usr/bin/sandbox-exec', ['-f', ${JSON.stringify(profile)}, ${JSON.stringify(realCodex)}, ...args],`,
    "  { stdio: ['inherit', 'inherit', 'pipe'], maxBuffer: 64 * 1024 * 1024 });",
    "const stderr = result.stderr ? result.stderr.toString('utf8') : '';",
    'process.stderr.write(stderr);',
    "const otel = args.find((a) => a.startsWith('otel='));",
    `fs.appendFileSync(${JSON.stringify(wrapperLog)}, JSON.stringify({`,
    "  subcommand: args[0], environmentNames: Object.keys(process.env).sort(),",
    '  otelEndpoint: otel === undefined ? undefined : (/endpoint = "([^"]+)"/.exec(otel) || [])[1],',
    "  outboundHosts: [...new Set([...stderr.matchAll(/(?:https?|wss?):\\/\\/([^/\\s\"')]+)/g)].map((m) => m[1]))].sort(),",
    '  exitCode: result.status,',
    ...(process.env.CERNUM_CODEX_LOOPBACK_DEBUG === '1' ? ['  stderrTail: stderr.slice(-2000),'] : []),
    "}) + '\\n');",
    'process.exit(result.status === null ? 1 : result.status);',
    '',
  ].join('\n'), { mode: 0o755 });
}, 120_000);

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

// MARK: - The matrix

function acceptedCodexRoute(modelID: string) {
  const at = new Date().toISOString();
  return { ...provenModel('codexCLI', modelID), availability: 'unproven' as const, verifiedModelID: '', discoveredAt: at,
    desiredEfforts: ['medium'],
    evidence: `identity smoke test at ${at} (effort medium, subscriptionIncluded, identity state `
      + `requestAcceptedIdentityUnverifiable): ${modelID} was accepted and something answered (loopback fixture)` };
}

const PACK = makeWorkspaceBenchmarkPack({
  id: 'pack.test.codex-loopback-matrix', version: '1', caseIDs: [RECEIPT_REFUNDS_SIGN.id], repeatsPerCase: 2,
});

/**
 * A matrix observer that records which conversation id each run ASKED for, and what came back, so the
 * test can show the join from the outside. It forwards everything and changes nothing.
 */
function spying(observer: OTLPObserver, asked: { threadID: string; observation?: OTLPTurnObservation }[]): MatrixObserver {
  return {
    get endpoint() { return observer.endpoint; },
    get failure() { return observer.failure; },
    get unreadablePayloadCount() { return observer.unreadablePayloadCount; },
    snapshot: () => observer.snapshot(),
    stop: () => observer.stop(),
    observe: async (threadID: string) => {
      const observation = await observer.observe(threadID);
      asked.push({ threadID, observation: observation === undefined ? undefined : JSON.parse(JSON.stringify(observation)) });
      return observation;
    },
  };
}

interface LoopbackMatrix {
  rows: ReturnType<typeof collectWorkspaceRunRows>;
  result: Awaited<ReturnType<typeof runWorkspaceMatrix>>;
  plan: ReturnType<typeof buildWorkspaceMatrixPlan>;
  asked: { threadID: string; observation?: OTLPTurnObservation }[];
  stopped: Awaited<ReturnType<WorkspaceMatrixTelemetryCollector['stop']>>;
  evidenceFile: string;
  requests: ProviderRequest[];
  execs: WrapperInvocation[];
  root: string;
}

async function runLoopbackMatrix(): Promise<LoopbackMatrix> {
  providerRequests = [];
  fs.rmSync(wrapperLog, { force: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-loopback-matrix-root-')));
  const sandboxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-loopback-matrix-sandbox-')));
  const models = [SOL, ASTRA];
  const discovery: DiscoveryEvidence = { writtenAt: new Date().toISOString(), models: models.map(acceptedCodexRoute) };
  const admission = sealWorkspaceMatrixAdmission(parseWorkspaceMatrixAdmissionFile(JSON.stringify({
    admissionScope: 'workspaceMatrix',
    authorizedBy: 'the repository owner, for this loopback test',
    reason: 'exercise the real codex telemetry path without a provider', intent: 'test only',
    pack: { id: PACK.id, version: PACK.version, digest: workspacePackDigest(PACK, allWorkspaceCases()) },
    admitted: models.map((model) => ({
      provider: 'codexCLI', requestedModelID: model, requestedEffort: 'medium',
      driverID: CODEX_WORKSPACE_DRIVER_ID, cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      authenticationBasis: 'ChatGPT subscription session (loopback: never contacted)',
      evidenceDigest: 'sha256:loopback-fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z',
    })),
  })), { matrixLabel: LABEL, authorizedAt: new Date().toISOString() });

  // THE PRODUCTION COLLECTOR SETTINGS, apart from a short shutdown grace, and the production start path.
  const directory = path.join(root, 'otlp');
  const started = await WorkspaceMatrixTelemetryCollector.start({ directory, runLabel: LABEL, shutdownGraceMilliseconds: 3_000 });
  const asked: LoopbackMatrix['asked'] = [];
  // Re-wrapped around the same observer, so the join can be watched. The capture block is the real one.
  const collector = new WorkspaceMatrixTelemetryCollector(
    spying((started as unknown as { observer: OTLPObserver }).observer, asked), started.capture);

  const request: WorkspaceMatrixRequest = {
    pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: models, effort: 'medium',
    discovery, campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot, runLabel: LABEL,
    repeatsPerCase: 2, attemptCeiling: 1, identityAdmission: admission,
    effortTelemetry: { endpoint: collector.endpoint, observerAvailable: true, availabilityDetail: 'loopback collector', collector },
    // The REAL driver. Its executable is the wrapper; the one hop from the wrapper to the binary is supplied.
    driverFactory: (binding, context) => (binding.provider !== 'codexCLI' ? undefined : new CodexWorkspaceDriver({
      requestedModelID: binding.requestedModelID, effort: binding.effort, executablePath: wrapper, otlp: context?.otlp,
      readLink: (file) => {
        if (file === wrapper) return realCodex;
        try { return fs.readlinkSync(file); } catch { return undefined; }
      },
    })),
    // A decoy key: it must reach neither the CLI nor its telemetry. Not a key; nothing could use it.
    environmentSource: {
      PATH: `${path.dirname(wrapper)}:${NODE_DIRECTORY}:/usr/bin:/bin`, HOME: os.homedir(), USER: os.userInfo().username,
      OPENAI_API_KEY: 'sk-cernum-loopback-decoy-not-a-key',
    } as NodeJS.ProcessEnv,
  };
  try {
    const plan = buildWorkspaceMatrixPlan(request);
    const result = await runWorkspaceMatrix(plan, request, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'cernum loopback test', environmentSource: request.environmentSource,
    });
    const stopped = await collector.stop();
    const rows = collectWorkspaceRunRows(root).filter((run) => result.completed.some((entry) => entry.recordRoot === run.recordRoot));
    const execs = invocations().filter((entry) => entry.subcommand === 'exec');
    if (process.env.CERNUM_CODEX_LOOPBACK_DEBUG === '1') {
      console.log(JSON.stringify({ skipped: result.skipped.map((entry) => entry.reasons), invocations: invocations(),
        requests: providerRequests, asked, rows: rows.map(({ row }) => ({ status: row.status, verdict: row.appliedEffortVerdict,
          detail: row.appliedEffortDetail, attempts: row.appliedEffortAttempts })) }, null, 1));
    }
    if (process.env.CERNUM_CODEX_LOOPBACK_DEBUG_DIR !== undefined) {
      fs.copyFileSync(stopped.summary.evidenceFile, path.join(process.env.CERNUM_CODEX_LOOPBACK_DEBUG_DIR, 'evidence.jsonl'));
      fs.writeFileSync(path.join(process.env.CERNUM_CODEX_LOOPBACK_DEBUG_DIR, 'threads.json'), JSON.stringify(asked.map((entry) => entry.threadID)));
    }
    return { rows, result, plan, asked, stopped, evidenceFile: stopped.summary.evidenceFile, requests: [...providerRequests],
      execs, root };
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

const responses = (run: LoopbackMatrix) => run.requests.filter((entry) => entry.url.startsWith('/v1/responses'));
const attemptOf = (row: Record<string, unknown>) => (row.appliedEffortAttempts as AttemptAppliedEffortEvidence[])[0];

describe.skipIf(!ENABLED)('the real codex CLI in a workspace-benchmark matrix, telemetry attached, loopback only', () => {
  let run: LoopbackMatrix;
  beforeAll(async () => { run = await runLoopbackMatrix(); }, 600_000);
  afterAll(() => { if (run?.root) fs.rmSync(run.root, { recursive: true, force: true }); });

  it('stayed on loopback: the egress block held, every provider request was local and carried no credential', () => {
    expect(canary!.lookup).toMatch(/^refused/);
    expect(Object.keys(canary!.internet).length).toBeGreaterThanOrEqual(1);
    for (const state of Object.values(canary!.internet)) expect(state).toMatch(/^refused/);
    expect(canary!.loopback).toBe('connected');
    // Every `codex` the driver ran went through the wrapper, so through the profile — preflight included.
    const all = invocations();
    expect(all.map((entry) => entry.subcommand)).toEqual(expect.arrayContaining(['--version', 'doctor', 'exec']));
    for (const entry of all) {
      expect(entry.environmentNames.filter((name) => /^(OPENAI_|CODEX_)/.test(name))).toEqual([]);
    }
    expect(run.requests.length).toBeGreaterThan(0);
    for (const entry of run.requests) expect(entry.authorizationPresent).toBe(false);
  });

  it('A-C, N: the observer started, the real CLI took the generated argument, telemetry arrived, and it closed cleanly', () => {
    expect(run.plan.appliedEffortTelemetry.measuredRunCount).toBe(4);
    expect(run.result.executedRunCount).toBe(4);
    expect(run.result.skipped).toEqual([]);
    expect(run.execs).toHaveLength(4);
    for (const exec of run.execs) {
      expect(exec.otelEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(exec.exitCode).toBe(0);
    }
    expect(new Set(run.execs.map((exec) => exec.otelEndpoint)).size).toBe(1);
    expect(codexOTLPConfigArgument(run.execs[0].otelEndpoint!)).toContain(run.execs[0].otelEndpoint!);
    const summary = run.stopped.summary;
    expect(summary.payloadCount).toBeGreaterThan(0);
    expect(summary.unreadablePayloadCount).toBe(0);
    expect(summary.conversationCount).toBe(4);
    expect(summary.correlatedCount).toBe(4);
    expect(summary.failure).toBeUndefined();
    expect(summary.leakAuditClean).toBe(true);
    expect(summary.collisions).toEqual([]);
    expect(run.result.measurementFailure).toBeUndefined();
  });

  it('D, L: each run joined exactly the telemetry carrying the thread id it printed, and no other', () => {
    expect(run.asked).toHaveLength(4);
    const threads = run.asked.map((entry) => entry.threadID);
    expect(new Set(threads).size).toBe(4);
    for (const thread of threads) expect(thread).toMatch(/^[0-9a-f-]{36}$/);
    // The provider saw the same id on each request's `thread-id` header: CLI stdout = wire = telemetry.
    expect(responses(run).map((entry) => entry.threadHeader)).toEqual(threads);
    const keys = new Set<string>();
    for (const [index, entry] of run.asked.entries()) {
      expect(entry.observation?.recordCount ?? 0).toBeGreaterThan(0);
      expect(entry.observation?.attributionRefused).toBeUndefined();
      // The client-sent model on this run's records is this run's request, and only it.
      expect(entry.observation?.clientSentModels).toEqual([responses(run)[index].model]);
      keys.add(entry.observation!.correlationKey);
    }
    expect(keys.size).toBe(4);
    const rowKeys = run.rows.map(({ row }) => attemptOf(row).correlationKey);
    expect(new Set(rowKeys)).toEqual(keys);
    for (const { row } of run.rows) expect(row.telemetryCorrelation).toBe('correlatedByConversationID');
    // The conversation id itself reached no file.
    const evidence = fs.readFileSync(run.evidenceFile, 'utf8');
    for (const thread of threads) expect(evidence).not.toContain(thread);
    for (const { recordRoot } of run.rows) {
      for (const file of fs.readdirSync(recordRoot, { recursive: true }) as string[]) {
        const full = path.join(recordRoot, file);
        if (fs.statSync(full).isFile()) for (const thread of threads) expect(fs.readFileSync(full, 'utf8')).not.toContain(thread);
      }
    }
  });

  it('E-H: medium requested, medium on the wire, medium on both real records, appliedEffortVerified', () => {
    for (const entry of responses(run)) expect(entry.effort).toBe('medium');
    for (const { row } of run.rows) {
      expect(row.requestedEffort).toBe('medium');
      expect(row.appliedEffort).toBe('medium');
      expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
      expect(row.appliedEffortQualifiesRequestedRoute).toBe(true);
      const attempt = attemptOf(row);
      expect(attempt.observedEfforts).toEqual(['medium']);
      expect(attempt.appliedEffortSources).toEqual(
        [APPLIED_EFFORT_SOURCES.conversationStart, APPLIED_EFFORT_SOURCES.requestEvent].sort());
    }
    for (const entry of run.asked) {
      expect(entry.observation?.turnReasoningEffort).toBe('medium');
      expect(entry.observation?.turnReasoningEffortSource).toBe(APPLIED_EFFORT_SOURCES.conversationStart);
      expect(entry.observation?.requestReasoningEfforts).toEqual(['medium']);
    }
  });

  it('I-J: the telemetry names a ChatGPT session and says no API key was in its environment', () => {
    for (const { row } of run.rows) {
      const attempt = attemptOf(row);
      expect(attempt.telemetryAuthMode).toBe('Chatgpt');
      expect(attempt.telemetryAPIKeyEnvironmentPresent).toBe(false);
    }
  });

  it('K, L: each run carries exactly its own request\'s token figures, from the real sse_event record', () => {
    for (const [index, entry] of run.asked.entries()) {
      const usage = responses(run)[index].usage!;
      const row = run.rows.find(({ row: candidate }) => attemptOf(candidate).correlationKey === entry.observation!.correlationKey)!.row;
      const recorded = attemptOf(row).telemetryRequestUsage as unknown as Record<string, unknown>[];
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        effort: 'medium', inputTokens: usage.input, cachedInputTokens: usage.cached, cacheWriteInputTokens: 0,
        outputTokens: usage.output, reasoningTokens: usage.reasoning, toolTokens: usage.input + usage.output,
      });
      // And the stream's own usage block agrees, so the two sources describe the same request.
      expect((row.usage as Record<string, unknown> | undefined)?.inputTokens ?? usage.input).toBe(usage.input);
    }
    const figures = run.rows.map(({ row }) => (attemptOf(row).telemetryRequestUsage as unknown as { inputTokens: number }[])[0].inputTokens);
    expect(new Set(figures).size).toBe(4);
  });

  it('M, O: the aggregate qualifies both candidates at medium, with nothing late and nothing ambiguous', () => {
    const late = lateAppliedEffortEvidence(run.rows, run.stopped.observations, run.stopped.summary.collisions);
    expect(late).toEqual([]);
    const provenance = workspaceAppliedEffortProvenance(run.rows, late);
    expect(provenance.candidates).toHaveLength(2);
    for (const candidate of provenance.candidates) {
      expect(candidate).toMatchObject({
        requestedEffort: 'medium', runCount: 2, verifiedRunCount: 2, mismatchRunCount: 0, ambiguousRunCount: 0,
        unavailableRunCount: 0, appliedEffortDistribution: { medium: 2 }, qualifiedForRequestedEffort: true, lateEvidence: [],
      });
    }
    const cells = aggregateWorkspaceRuns(run.rows);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.effortProvenance).toMatchObject({ verifiedRunCount: 2, qualifiedForRequestedEffort: true });
      expect(describeWorkspaceCell(cell)).toContain('[applied effort medium verified 2/2]');
    }
    expect(run.result.appliedEffortVerdicts.map((entry) => entry.verdict)).toEqual(Array(4).fill('appliedEffortVerified'));
  });
});

// MARK: - The session preflight, through the real binary

describe.skipIf(!ENABLED)('the codex session preflight through the real `codex doctor --json`, no inference', () => {
  const probeEnvironment = (home: string) => ({
    PATH: `${path.dirname(wrapper)}:${NODE_DIRECTORY}:/usr/bin:/bin`, HOME: home, USER: os.userInfo().username,
    OPENAI_API_KEY: 'sk-cernum-loopback-decoy-not-a-key', CODEX_HOME: '/nonexistent-cernum-decoy',
  } as NodeJS.ProcessEnv);

  it('reads a ChatGPT session, withholds OPENAI_*/CODEX_*, and nothing leaves the machine', async () => {
    providerRequests = [];
    fs.rmSync(wrapperLog, { force: true });
    const status = await readProviderSessionStatus({ provider: 'codexCLI', environmentSource: probeEnvironment(os.homedir()) });
    expect(status.probe).toBe('codex doctor --json');
    expect(status.environmentWithheld).toEqual(['CODEX_HOME', 'OPENAI_API_KEY']);
    expect(status.probeSucceeded).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.authMethod).toBe('chatgpt');
    expect(status.sessionUsable).toBe(true);
    expect(sessionPreflightRefusal(status)).toBeUndefined();
    // The handshake the doctor attempts was refused by the kernel: it never reached chatgpt.com.
    expect(status.transportHandshake).toMatch(/lookup failed|failed to lookup|network error/i);
    expect(JSON.stringify(status)).not.toContain(os.homedir());
    const doctor = invocations().filter((entry) => entry.subcommand === 'doctor');
    expect(doctor).toHaveLength(1);
    expect(doctor[0].environmentNames.filter((name) => /^(OPENAI_|CODEX_)/.test(name))).toEqual([]);
    expect(providerRequests).toEqual([]);
    if (process.env.CERNUM_CODEX_LOOPBACK_DEBUG === '1') console.log(describeProviderSessionStatus(status).join('\n'));
  }, 120_000);

  it('refuses an API-key session, read from the real doctor over a throwaway HOME holding a decoy key', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-loopback-apikey-home-')));
    try {
      // Written by the real CLI, under the profile, into the throwaway HOME. The "key" is not one.
      const login = spawnSync(wrapper, ['login', '--with-api-key'], {
        input: 'sk-cernum-loopback-decoy-not-a-key\n', encoding: 'utf8',
        env: { PATH: `${NODE_DIRECTORY}:/usr/bin:/bin`, HOME: home },
      });
      expect(login.status).toBe(0);
      const status = await readProviderSessionStatus({ provider: 'codexCLI', environmentSource: probeEnvironment(home) });
      expect(status.probeSucceeded).toBe(true);
      expect(status.authMethod).toBe('api_key');
      expect(status.sessionUsable).toBe(false);
      expect(sessionPreflightRefusal(status)).toMatch(/not with a session this matrix may bill as subscription-included/);
      expect(JSON.stringify(status)).not.toContain('sk-cernum-loopback-decoy');
      expect(providerRequests).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
