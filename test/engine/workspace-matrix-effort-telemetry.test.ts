// Applied-effort telemetry for a Codex MATRIX: every run's applied effort measured from the CLI's own
// OTLP export, joined to that run alone, and kept apart from the effort that was requested.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED. Each run is the REAL `CodexWorkspaceDriver` spawning a
// FAKE `codex` — a node script on disk — that does what the real 0.155.0 binary does with the two things
// this pass is about: it prints the `thread.started` / `turn.completed` stream on stdout, and it POSTs
// `codex.conversation_starts` and `codex.sse_event` records to whatever collector its `-c otel=…` argument
// names. The conversation-start record is the REAL captured payload with its conversation id, effort and
// model rewritten per scenario. The collector is the real `OTLPObserver`, bound to 127.0.0.1.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIResult } from '../../src/engine/cli-process';
import { DiscoveryEvidence, discoveryStorePath } from '../../src/engine/discovery-store';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';
import { OTLPObserver, OTLPTurnObservation, codexOTLPConfigArgument } from '../../src/engine/otlp-observer';
import {
  NON_MODEL_SESSION_PROBES, assertNonModelProbe, deferredProviderSessionStatus, describeProviderSessionStatus,
  readProviderSessionStatus, sessionPreflightRefusal,
} from '../../src/engine/provider-session-status';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { ScriptedWorkspaceAgent } from '../../src/engine/workspace-agent';
import { aggregateWorkspaceRuns, collectWorkspaceRunRows, describeWorkspaceCell } from '../../src/engine/workspace-aggregate';
import {
  RECEIPT_REFUNDS_SIGN, TASK_PRIORITY_PROPAGATE, allWorkspaceCases, foundationFourPack,
} from '../../src/engine/workspace-catalog';
import { registeredWorkspacePacks } from '../../src/engine/workspace-catalog';
import {
  CODEX_CLI_VERSION_VERIFIED_AGAINST, CODEX_WORKSPACE_DRIVER_ID, CodexPreflight, CodexWorkspaceDriver,
} from '../../src/engine/workspace-codex-driver';
import {
  AttemptAppliedEffortEvidence, attemptAppliedEffortEvidence, runAppliedEffortEvidence,
  workspaceAppliedEffortProvenance,
} from '../../src/engine/workspace-effort-evidence';
import {
  WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan, describeWorkspaceMatrixRunResult,
  runWorkspaceMatrix,
} from '../../src/engine/workspace-matrix';
import {
  WorkspaceMatrixIdentityAdmission, parseWorkspaceMatrixAdmissionFile, sealWorkspaceMatrixAdmission,
} from '../../src/engine/workspace-matrix-admission';
import {
  MatrixObserver, WorkspaceMatrixTelemetryCollector, WorkspaceMatrixTelemetryError, lateAppliedEffortEvidence,
} from '../../src/engine/workspace-matrix-telemetry';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { provenModel } from './frontier-harness';
import { CODEX_0155_CONVERSATION_STARTS, CODEX_0155_MODEL_MANAGER_SPAN } from './fixtures/codex-otlp-0155-captured';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.resolve(repositoryRoot, 'fixtures');
const NODE_DIRECTORY = path.dirname(process.execPath);
const SOL = 'gpt-5.6-sol';
const ASTRA = 'gpt-6-astra';
const LABEL = 'codex-effort-telemetry';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

const SUBSCRIPTION: CodexPreflight = {
  version: CODEX_CLI_VERSION_VERIFIED_AGAINST,
  auth: { storedAuthMode: 'chatgpt', apiKeyStored: false, chatgptTokensStored: true, status: 'ok' },
};
const API_KEY_SESSION: CodexPreflight = {
  version: CODEX_CLI_VERSION_VERIFIED_AGAINST,
  auth: { storedAuthMode: 'apikey', apiKeyStored: true, chatgptTokensStored: false, status: 'ok' },
};

// MARK: - The fake `codex`

/** What one `codex exec` invocation should do. Everything defaults to an honest, fully-reported run. */
interface Scenario {
  /** The thread id printed on stdout. `null` prints none. Defaults to a fresh id per invocation. */
  thread?: string | null;
  /** `full`: start + sse records. `startOnly`: start only. `none`: nothing. `noConversationID`: records with no id. */
  telemetry?: 'full' | 'startOnly' | 'none' | 'noConversationID';
  /** The effort the telemetry reports. Defaults to the requested one. */
  effort?: string;
  /** The per-request effort on the sse record. Defaults to `effort`. */
  requestEffort?: string;
  /** The client-sent model in the telemetry. Defaults to the requested one. */
  telemetryModel?: string;
  /** Post an extra conversation-start record for this OTHER conversation id. */
  foreignConversation?: string;
  /** Emit `model rerouted: <requested> -> <this>`. */
  reroute?: string;
  turnFailed?: { status: number; message: string };
  /** Post an unparseable payload first. */
  malformed?: boolean;
}

interface Invocation { n: number; argv: string[]; environmentNames: string[]; endpoint?: string }

function fakeCodex(scenarios: Scenario[]): { executable: string; invocations: () => Invocation[]; directory: string } {
  const directory = temporary('cernum-fake-codex-otlp-');
  const files = {
    scenarios: path.join(directory, 'scenarios.json'),
    counter: path.join(directory, 'counter'),
    log: path.join(directory, 'invocations.jsonl'),
    template: path.join(directory, 'conversation-start.json'),
    doctor: path.join(directory, 'doctor.json'),
  };
  fs.writeFileSync(files.scenarios, JSON.stringify(scenarios));
  fs.writeFileSync(files.template, JSON.stringify(CODEX_0155_CONVERSATION_STARTS[0].payload));
  fs.writeFileSync(files.doctor, JSON.stringify(DOCTOR_CHATGPT));
  const executable = path.join(directory, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const F = ${JSON.stringify(files)};
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('codex-cli ${CODEX_CLI_VERSION_VERIFIED_AGAINST}\\n'); process.exit(0); }
if (argv[0] === 'doctor') {
  fs.appendFileSync(F.log, JSON.stringify({ n: -1, argv, environmentNames: Object.keys(process.env).sort() }) + '\\n');
  process.stdout.write(fs.readFileSync(F.doctor, 'utf8')); process.exit(0);
}
const rewrite = (node, values) => {
  if (Array.isArray(node)) return node.map((entry) => rewrite(entry, values)).filter((entry) => entry !== undefined);
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.key === 'string' && node.value && Object.prototype.hasOwnProperty.call(values, node.key)) {
    return values[node.key] === undefined ? undefined : { ...node, value: { stringValue: values[node.key] } };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v, values)]));
};
const sse = (id, effort, model, n) => ({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex_exec' } }] },
  scopeLogs: [{ logRecords: [{ attributes: [
    { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
    { key: 'event.kind', value: { stringValue: 'response.completed' } },
    { key: 'event.timestamp', value: { stringValue: '2026-09-21T00:00:0' + (n % 10) + '.000Z' } },
    ...(id === undefined ? [] : [{ key: 'conversation.id', value: { stringValue: id } }]),
    { key: 'model', value: { stringValue: model } }, { key: 'slug', value: { stringValue: model } },
    { key: 'model_reasoning_effort', value: { stringValue: effort } },
    { key: 'input_token_count', value: { stringValue: '8506' } }, { key: 'output_token_count', value: { stringValue: '211' } },
    { key: 'reasoning_token_count', value: { stringValue: '7' } }, { key: 'cached_token_count', value: { stringValue: '8064' } },
  ] }] }] }] });
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', async () => {
  const n = fs.existsSync(F.counter) ? Number(fs.readFileSync(F.counter, 'utf8')) : 0;
  fs.writeFileSync(F.counter, String(n + 1));
  const sc = JSON.parse(fs.readFileSync(F.scenarios, 'utf8'))[n] || {};
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const model = value('-m');
  const effortArgument = argv.find((a) => a.startsWith('model_reasoning_effort='));
  const requested = effortArgument === undefined ? undefined : JSON.parse(effortArgument.split('=')[1]);
  const otel = argv.find((a) => a.startsWith('otel='));
  const endpoint = otel === undefined ? undefined : /endpoint = "([^"]+)"/.exec(otel)[1];
  fs.appendFileSync(F.log, JSON.stringify({ n, argv, environmentNames: Object.keys(process.env).sort(), endpoint }) + '\\n');
  const thread = sc.thread === null ? undefined : (sc.thread || ('00000000-0000-4000-8000-' + String(n).padStart(12, '0')));
  const effort = sc.effort || requested;
  const tmodel = sc.telemetryModel || model;
  const post = (payload) => new Promise((resolve) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const u = new URL(endpoint + '/v1/logs');
    const request = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json' } }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', resolve);
    request.end(body);
  });
  const start = (id, e, m) => rewrite(JSON.parse(fs.readFileSync(F.template, 'utf8')),
    { 'conversation.id': id, reasoning_effort: e, model: m, slug: m });
  const telemetry = sc.telemetry || 'full';
  if (endpoint !== undefined && telemetry !== 'none') {
    if (sc.malformed) await post('{this is not json');
    const id = telemetry === 'noConversationID' ? undefined : thread;
    await post(start(id, effort, tmodel));
    if (telemetry === 'full' || telemetry === 'noConversationID') await post(sse(id, sc.requestEffort || effort, tmodel, n));
    if (sc.foreignConversation) await post(start(sc.foreignConversation, 'max', tmodel));
  }
  const out = [];
  if (thread !== undefined) out.push({ type: 'thread.started', thread_id: thread });
  out.push({ type: 'turn.started' });
  if (sc.reroute) out.push({ type: 'item.completed', item: { id: 'item_r', type: 'error',
    message: 'model rerouted: ' + model + ' -> ' + sc.reroute + ' (HighRiskCyberActivity)' } });
  out.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I looked; nothing changed.' } });
  if (sc.turnFailed) {
    out.push({ type: 'turn.failed', error: { message: JSON.stringify({ status: sc.turnFailed.status, error: { message: sc.turnFailed.message } }) } });
  } else {
    out.push({ type: 'turn.completed', usage: { input_tokens: 67791, cached_input_tokens: 56832, cache_write_input_tokens: 0,
      output_tokens: 1413, reasoning_output_tokens: 117 } });
  }
  for (const line of out) process.stdout.write(JSON.stringify(line) + '\\n');
  process.exit(sc.turnFailed ? 1 : 0);
});
`, { mode: 0o755 });
  const invocations = (): Invocation[] => (fs.existsSync(files.log)
    ? fs.readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation) : []);
  return { executable, invocations, directory };
}

/** `codex doctor --json`, reduced to what the probe reads, for a signed-in ChatGPT session. No account data. */
const DOCTOR_CHATGPT = {
  schemaVersion: 1, overallStatus: 'ok', codexVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST,
  checks: {
    'auth.credentials': { id: 'auth.credentials', status: 'ok', summary: 'auth is configured', details: {
      'auth env vars present': 'none', 'auth file': '/Users/<redacted>/.codex/auth.json', 'auth storage mode': 'File',
      'stored API key': 'false', 'stored ChatGPT tokens': 'true', 'stored agent identity': 'false', 'stored auth mode': 'chatgpt',
    } },
    'network.websocket_reachability': { id: 'network.websocket_reachability', status: 'ok',
      summary: 'Responses WebSocket handshake succeeded', details: { 'handshake result': 'HTTP 101 Switching Protocols', 'auth mode': 'chatgpt' } },
  },
};

// MARK: - The matrix under test

function acceptedCodexRoute(modelID: string, efforts = ['max', 'medium']) {
  const at = new Date().toISOString();
  return { ...provenModel('codexCLI', modelID), availability: 'unproven' as const, verifiedModelID: '', discoveredAt: at,
    desiredEfforts: efforts,
    evidence: `identity smoke test at ${at} (effort max, subscriptionIncluded, identity state `
      + `requestAcceptedIdentityUnverifiable): ${modelID} was accepted and something answered (fixture)` };
}
const DISCOVERY: DiscoveryEvidence = {
  writtenAt: new Date().toISOString(),
  models: [acceptedCodexRoute(SOL), acceptedCodexRoute(ASTRA),
    { ...provenModel('claudeCLI', 'claude-haiku-4-5'), discoveredAt: new Date().toISOString() }],
};

const PACK = makeWorkspaceBenchmarkPack({
  id: 'pack.test.effort-telemetry', version: '1',
  caseIDs: [RECEIPT_REFUNDS_SIGN.id, TASK_PRIORITY_PROPAGATE.id], repeatsPerCase: 1,
});
const PACK_DIGEST = workspacePackDigest(PACK, allWorkspaceCases());

function sealed(models: string[], effort: string): WorkspaceMatrixIdentityAdmission {
  return sealWorkspaceMatrixAdmission(parseWorkspaceMatrixAdmissionFile(JSON.stringify({
    admissionScope: 'workspaceMatrix',
    authorizedBy: 'the repository owner, for this test',
    reason: 'measure applied effort without a provider', intent: 'test only',
    pack: { id: PACK.id, version: PACK.version, digest: PACK_DIGEST },
    admitted: models.map((model) => ({
      provider: 'codexCLI', requestedModelID: model, requestedEffort: effort,
      driverID: CODEX_WORKSPACE_DRIVER_ID, cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      authenticationBasis: 'ChatGPT subscription session (fixture)',
      evidenceDigest: 'sha256:fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z',
    })),
  })), { matrixLabel: LABEL, authorizedAt: '2026-09-21T23:00:00Z' });
}

/** The REAL driver, spawning the fake, with the telemetry source the matrix scoped to this run. */
function codexFactory(executable: string, preflight: CodexPreflight = SUBSCRIPTION): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding, context) => (binding.provider !== 'codexCLI' ? undefined : new CodexWorkspaceDriver({
    requestedModelID: binding.requestedModelID, effort: binding.effort, executablePath: executable,
    preflight: async () => preflight, otlp: context?.otlp,
  }));
}

async function collectorIn(directory: string): Promise<WorkspaceMatrixTelemetryCollector> {
  return WorkspaceMatrixTelemetryCollector.start({
    directory, runLabel: LABEL, observeTimeoutMilliseconds: 300, shutdownGraceMilliseconds: 0,
  });
}

const RUN_OPTIONS = {
  hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'cernum test',
  // OPENAI_API_KEY IS HERE ON PURPOSE: it must reach neither the driver's children nor the telemetry.
  environmentSource: {
    PATH: `${NODE_DIRECTORY}:/usr/bin:/bin`, HOME: os.homedir(), USER: 'somebody', OPENAI_API_KEY: 'sk-cernum-test-not-a-key',
  } as NodeJS.ProcessEnv,
};

interface MatrixRun {
  result: Awaited<ReturnType<typeof runWorkspaceMatrix>>;
  plan: ReturnType<typeof buildWorkspaceMatrixPlan>;
  rows: ReturnType<typeof collectWorkspaceRunRows>;
  collector: WorkspaceMatrixTelemetryCollector;
  fake: ReturnType<typeof fakeCodex>;
  root: string;
}

async function runMatrix(options: {
  scenarios: Scenario[]; models?: string[]; effort?: 'medium' | 'max'; repeats?: number;
  preflight?: CodexPreflight; stopCollector?: boolean;
}): Promise<MatrixRun> {
  const models = options.models ?? [SOL];
  const effort = options.effort ?? 'medium';
  const fake = fakeCodex(options.scenarios);
  const root = temporary('cernum-effort-root-');
  const collector = await collectorIn(path.join(root, 'otlp'));
  const request: WorkspaceMatrixRequest = {
    pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: models, effort,
    discovery: DISCOVERY, campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-effort-sandbox-'),
    runLabel: LABEL, repeatsPerCase: options.repeats ?? 1, attemptCeiling: 1,
    identityAdmission: sealed(models, effort),
    effortTelemetry: { endpoint: collector.endpoint, observerAvailable: true, availabilityDetail: 'test collector', collector },
    driverFactory: codexFactory(fake.executable, options.preflight),
    environmentSource: RUN_OPTIONS.environmentSource,
  };
  const plan = buildWorkspaceMatrixPlan(request);
  const result = await runWorkspaceMatrix(plan, request, RUN_OPTIONS);
  if (options.stopCollector !== false) await collector.stop();
  return { result, plan, rows: collectWorkspaceRunRows(root), collector, fake, root };
}

const rowFor = (run: MatrixRun, model: string, caseID: string, repeat = 1) => {
  const found = run.rows.find(({ row }) => row.requestedModelID === model && row.caseID === caseID && row.repeatIndex === repeat);
  if (found === undefined) throw new Error(`no row for ${model} ${caseID} r${repeat}`);
  return found.row;
};

const A = RECEIPT_REFUNDS_SIGN.id;
const B = TASK_PRIORITY_PROPAGATE.id;

// MARK: - 1 · the observer is attached

describe('a Codex matrix attaches the telemetry collector to every run', () => {
  it('points every `codex exec` at the ONE loopback collector, and names its evidence file on every row', async () => {
    const run = await runMatrix({ scenarios: [{}, {}] });
    const execs = run.fake.invocations().filter((entry) => entry.n >= 0);
    expect(execs).toHaveLength(2);
    for (const exec of execs) {
      expect(exec.endpoint).toBe(run.collector.endpoint);
      expect(exec.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(exec.argv).toContain(codexOTLPConfigArgument(run.collector.endpoint));
    }
    for (const { row } of run.rows) {
      expect((row.telemetryCapture as Record<string, unknown>).evidenceFile)
        .toBe(path.resolve(run.root, 'otlp', `${LABEL}-otlp-payloads.redacted.jsonl`));
      expect(row.telemetryCorrelation).toBe('correlatedByConversationID');
    }
    expect(run.plan.appliedEffortTelemetry.measuredRunCount).toBe(2);
  }, 60_000);
});

// MARK: - 2-4, Mission 12 cases 1-3 · verified, verified, mismatch

describe('requested and applied effort are separate fields, and the verdict compares them', () => {
  it('medium requested, medium applied: appliedEffortVerified on both fields, from the tool\'s own records', async () => {
    const run = await runMatrix({ scenarios: [{}, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.requestedEffort).toBe('medium');
    expect(row.appliedEffort).toBe('medium');
    expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(row.appliedEffortEvidenceSource).toBe(
      'otlp:codex.conversation_starts.reasoning_effort, otlp:codex.sse_event.model_reasoning_effort');
    expect(row.appliedEffortQualifiesRequestedRoute).toBe(true);
    const provenance = workspaceAppliedEffortProvenance(run.rows);
    expect(provenance.candidates[0]).toMatchObject({
      verifiedRunCount: 2, mismatchRunCount: 0, qualifiedForRequestedEffort: true, appliedEffortDistribution: { medium: 2 },
    });
  }, 60_000);

  it('max requested, max applied: appliedEffortVerified', async () => {
    const run = await runMatrix({ scenarios: [{}, {}], effort: 'max' });
    for (const { row } of run.rows) {
      expect(row.requestedEffort).toBe('max');
      expect(row.appliedEffort).toBe('max');
      expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
    }
  }, 60_000);

  it('medium requested, max applied: a MISMATCH, recorded distinctly, evidence kept, candidate not qualified', async () => {
    const run = await runMatrix({ scenarios: [{ effort: 'max' }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.requestedEffort).toBe('medium');
    expect(row.appliedEffort).toBe('max');
    expect(row.appliedEffortVerdict).toBe('appliedEffortMismatch');
    expect(row.appliedEffortQualifiesRequestedRoute).toBe(false);
    // THE WORKSPACE EVIDENCE AND THE SCORE ARE KEPT, exactly as verification produced them.
    expect(row.patchDigest).toBeDefined();
    expect(row.transcriptDigest).toBeDefined();
    expect(typeof row.status).toBe('string');
    expect(run.result.appliedEffortVerdicts.map((entry) => entry.verdict))
      .toEqual(['appliedEffortMismatch', 'appliedEffortVerified']);
    // …and the matrix did not stop for it.
    expect(run.result.executedRunCount).toBe(2);
    const provenance = workspaceAppliedEffortProvenance(run.rows);
    expect(provenance.candidates[0]).toMatchObject({
      mismatchRunCount: 1, verifiedRunCount: 1, qualifiedForRequestedEffort: false,
      appliedEffortDistribution: { max: 1, medium: 1 },
    });
    expect(provenance.candidates[0].mismatchedRuns[0]).toMatchObject({ caseID: A, appliedEffort: 'max' });
    const cells = aggregateWorkspaceRuns(run.rows);
    const cellA = cells.find((cell) => cell.caseID === A)!;
    expect(cellA.effortProvenance).toMatchObject({ mismatchRunCount: 1, qualifiedForRequestedEffort: false });
    expect(describeWorkspaceCell(cellA)).toContain('[EFFORT MISMATCH 1/1 — not evidence for @medium]');
    // The quality figures are NOT adjusted by the effort verdict: the run is still counted where it landed.
    expect(cellA.quality.scoredRunCount + cellA.quality.notMeasuredRunCount).toBe(1);
    expect(describeWorkspaceMatrixRunResult(run.result).join('\n')).toContain('NOT evidence for @medium');
  }, 60_000);

  it('a request-level effort that disagrees with the session\'s is a mismatch, never averaged away', async () => {
    const run = await runMatrix({ scenarios: [{ requestEffort: 'max' }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortMismatch');
    expect(row.appliedEffort).toBeUndefined();
    const attempts = row.appliedEffortAttempts as AttemptAppliedEffortEvidence[];
    expect(attempts[0].observedEfforts).toEqual(['max', 'medium']);
    expect(workspaceAppliedEffortProvenance(run.rows).candidates[0].appliedEffortDistribution).toMatchObject({ mixed: 1 });
  }, 60_000);
});

// MARK: - 5-9, Mission 12 cases 4-5 · missing, ambiguous, and no crossing

describe('absent or ambiguous telemetry is never guessed, and never crosses a boundary', () => {
  it('telemetry missing: appliedEffortUnavailable, with the correlation key kept and nothing borrowed', async () => {
    const run = await runMatrix({ scenarios: [{ telemetry: 'none' }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.requestedEffort).toBe('medium');
    expect(row.appliedEffort).toBeUndefined();
    expect(row.appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(row.telemetryCorrelation).toBe('noTelemetryForConversation');
    expect(workspaceAppliedEffortProvenance(run.rows).candidates[0]).toMatchObject({
      unavailableRunCount: 1, qualifiedForRequestedEffort: false,
    });
  }, 60_000);

  it('no thread id on stdout: nothing to join on, so NOTHING is joined — not even the only record there is', async () => {
    const run = await runMatrix({ scenarios: [{ thread: null }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(row.telemetryCorrelation).toBe('noConversationID');
  }, 60_000);

  it('records without a conversation id (startup spans, the model-manager trace) join no run', async () => {
    const run = await runMatrix({ scenarios: [{ telemetry: 'noConversationID' }, {}], stopCollector: false });
    await fetch(run.collector.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CODEX_0155_MODEL_MANAGER_SPAN) });
    const { observations } = await run.collector.stop();
    expect(rowFor(run, SOL, A).appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(rowFor(run, SOL, B).appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(Object.values(observations).every((entry) => !(entry.clientSentModels ?? []).includes('gpt-5.6-luna'))).toBe(true);
  }, 60_000);

  it('ambiguous: telemetry naming a different client-sent model is refused, not attributed', async () => {
    const run = await runMatrix({ scenarios: [{ telemetryModel: 'gpt-5.5' }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortAmbiguous');
    expect(row.telemetryCorrelation).toBe('attributionRefused');
    expect(String(row.appliedEffortDetail)).toContain('gpt-5.5');
  }, 60_000);

  it('ambiguous: one conversation id reported by two runs is attributed to NEITHER, the first flagged late', async () => {
    const shared = '11111111-2222-4333-8444-555555555555';
    const run = await runMatrix({ scenarios: [{ thread: shared }, { thread: shared }], stopCollector: false });
    expect(rowFor(run, SOL, A).appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(rowFor(run, SOL, B).appliedEffortVerdict).toBe('appliedEffortAmbiguous');
    expect(String(rowFor(run, SOL, B).appliedEffortDetail)).toContain('already claimed');
    const { summary, observations } = await run.collector.stop();
    expect(summary.collisions).toHaveLength(1);
    const late = lateAppliedEffortEvidence(run.rows, observations, summary.collisions);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ sealedVerdict: 'appliedEffortVerified', lateVerdict: 'appliedEffortAmbiguous' });
    // THE SEALED ROW IS NOT REWRITTEN; the late finding withdraws the qualification beside it.
    const provenance = workspaceAppliedEffortProvenance(run.rows, late);
    expect(provenance.candidates[0].qualifiedForRequestedEffort).toBe(false);
    expect(rowFor(run, SOL, A).appliedEffortVerdict).toBe('appliedEffortVerified');
  }, 60_000);

  it('cannot cross RUNS: one run\'s records never answer for the next run, which reported none', async () => {
    const run = await runMatrix({ scenarios: [{ effort: 'max', foreignConversation: 'not-any-run' }, { telemetry: 'none' }] });
    expect(rowFor(run, SOL, A).appliedEffort).toBe('max');
    const next = rowFor(run, SOL, B);
    expect(next.appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(next.appliedEffort).toBeUndefined();
    expect(next.telemetryCorrelation).toBe('noTelemetryForConversation');
  }, 60_000);

  it('cannot cross CANDIDATES: sol\'s max telemetry is not astra\'s, and astra\'s absence stays an absence', async () => {
    const run = await runMatrix({ models: [SOL, ASTRA], scenarios: [{ effort: 'max' }, { effort: 'max' }, { telemetry: 'none' }, {}] });
    expect(rowFor(run, SOL, A).appliedEffort).toBe('max');
    expect(rowFor(run, ASTRA, A).appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(rowFor(run, ASTRA, B).appliedEffortVerdict).toBe('appliedEffortVerified');
    const byCandidate = Object.fromEntries(workspaceAppliedEffortProvenance(run.rows).candidates
      .map((entry) => [entry.candidate, entry]));
    expect(byCandidate[`codexCLI:${SOL}@medium`]).toMatchObject({ mismatchRunCount: 2, appliedEffortDistribution: { max: 2 } });
    expect(byCandidate[`codexCLI:${ASTRA}@medium`]).toMatchObject({ unavailableRunCount: 1, verifiedRunCount: 1 });
  }, 90_000);

  it('cannot cross REPEATS: repeat 1\'s telemetry does not stand in for repeat 2\'s', async () => {
    const run = await runMatrix({ repeats: 2, scenarios: [{}, {}, { telemetry: 'none' }, {}] });
    expect(rowFor(run, SOL, A, 1).appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(rowFor(run, SOL, A, 2).appliedEffortVerdict).toBe('appliedEffortUnavailable');
    const keys = run.rows.map(({ row }) => (row.appliedEffortAttempts as AttemptAppliedEffortEvidence[])[0].correlationKey);
    expect(new Set(keys.filter(Boolean)).size).toBe(keys.filter(Boolean).length);
  }, 90_000);

  it('late telemetry is REPORTED and never upgrades a sealed verdict', async () => {
    const thread = '99999999-8888-4777-8666-555555555555';
    const run = await runMatrix({ scenarios: [{ thread, telemetry: 'none' }, {}], stopCollector: false });
    const late = CODEX_0155_CONVERSATION_STARTS.find((entry) => entry.requestedModel === SOL && entry.appliedEffort === 'medium')!;
    const payload = JSON.parse(JSON.stringify(late.payload).split(late.conversationID).join(thread));
    await fetch(run.collector.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const { summary, observations } = await run.collector.stop();
    const found = lateAppliedEffortEvidence(run.rows, observations, summary.collisions);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sealedVerdict: 'appliedEffortUnavailable', lateVerdict: 'appliedEffortVerified', lateAppliedEffort: 'medium' });
    const provenance = workspaceAppliedEffortProvenance(run.rows, found);
    expect(provenance.candidates[0].qualifiedForRequestedEffort).toBe(false);
    expect(rowFor(run, SOL, A).appliedEffortVerdict).toBe('appliedEffortUnavailable');
  }, 60_000);

  it('a malformed payload is counted, its bytes are not kept, and it is attributed to nobody', async () => {
    const run = await runMatrix({ scenarios: [{ malformed: true }, {}], stopCollector: false });
    const { summary } = await run.collector.stop();
    expect(summary.unreadablePayloadCount).toBe(1);
    expect(rowFor(run, SOL, A).appliedEffortVerdict).toBe('appliedEffortVerified');
    const evidence = fs.readFileSync(summary.evidenceFile, 'utf8');
    expect(evidence).not.toContain('this is not json');
    expect(evidence).toContain('"unreadable":true');
  }, 60_000);
});

// MARK: - 10 · observer failure is a measurement fact

describe('an observer failure has measurement semantics, never provider or model semantics', () => {
  it('a collector that cannot bind refuses with a harness error before anything is sent', async () => {
    const blocker = http.createServer();
    const port = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () =>
      resolve((blocker.address() as { port: number }).port)));
    try {
      await expect(WorkspaceMatrixTelemetryCollector.start({ directory: temporary('cernum-blocked-'), runLabel: LABEL, port }))
        .rejects.toThrow(WorkspaceMatrixTelemetryError);
      await expect(WorkspaceMatrixTelemetryCollector.start({ directory: temporary('cernum-blocked-'), runLabel: LABEL, port }))
        .rejects.toMatchObject({ code: 'observerUnavailable' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('an unavailable observer REFUSES the measured routes in the plan, and says why', () => {
    const plan = buildWorkspaceMatrixPlan({
      pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: [SOL], effort: 'medium', discovery: DISCOVERY,
      campaignRoot: temporary('cernum-effort-root-'), fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-effort-sb-'),
      runLabel: LABEL, identityAdmission: sealed([SOL], 'medium'),
      effortTelemetry: { endpoint: 'http://127.0.0.1:<port>', observerAvailable: false, availabilityDetail: 'EADDRNOTAVAIL (test)' },
      driverFactory: codexFactory('/nonexistent/codex'),
    });
    expect(plan.runnableRunCount).toBe(0);
    expect(plan.models[0].refusals.join(' ')).toContain('measurementUnavailable');
    expect(plan.models[0].refusals.join(' ')).not.toMatch(/rateLimited|notAuthenticated|providerThrottled/);
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).toContain('REQUIRED and UNAVAILABLE');
  });

  it('a collector that dies mid-matrix stops the Codex runs after it, as NOT EXECUTED, never as model failures', async () => {
    const fake = fakeCodex([{}, {}]);
    const root = temporary('cernum-effort-root-');
    const real = await OTLPObserver.start({ evidenceFile: path.join(root, 'otlp.jsonl'), observeTimeoutMilliseconds: 300,
      shutdownGraceMilliseconds: 0 });
    let dead: string | undefined;
    // THE SEAM: the real observer, whose health flips once the first run has asked for its telemetry.
    const dying: MatrixObserver = {
      get endpoint() { return real.endpoint; },
      get failure() { return dead; },
      get unreadablePayloadCount() { return real.unreadablePayloadCount; },
      observe: async (threadID: string) => {
        const observation = await real.observe(threadID);
        dead = 'the collector\'s socket closed before it was stopped (simulated)';
        return observation;
      },
      snapshot: () => real.snapshot(),
      stop: () => real.stop(),
    };
    const collector = new WorkspaceMatrixTelemetryCollector(dying, {
      collector: 'test', correlationBoundary: 'test', evidenceFile: path.join(root, 'otlp.jsonl'),
    });
    const request: WorkspaceMatrixRequest = {
      pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: [SOL], effort: 'medium', discovery: DISCOVERY,
      campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-effort-sb-'), runLabel: LABEL,
      attemptCeiling: 1, identityAdmission: sealed([SOL], 'medium'),
      effortTelemetry: { endpoint: collector.endpoint, observerAvailable: true, availabilityDetail: 'test', collector },
      driverFactory: codexFactory(fake.executable),
    };
    const plan = buildWorkspaceMatrixPlan(request);
    const result = await runWorkspaceMatrix(plan, request, RUN_OPTIONS);
    await collector.stop();
    expect(result.executedRunCount).toBe(1);
    expect(result.notExecutedBecauseMeasurementUnavailableCount).toBe(1);
    expect(result.notExecutedBecauseThrottledCount).toBe(0);
    expect(result.throttle).toBeUndefined();
    expect(result.skipped[0].disposition).toBe('measurementUnavailableBeforeExecution');
    expect(result.measurementFailure).toContain('simulated');
    // The run that did execute is sealed with the provider's own outcome, untouched by the collector's death.
    const rows = collectWorkspaceRunRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].row.providerThrottled).toBe(false);
    expect(describeWorkspaceMatrixRunResult(result).join('\n')).toContain('not a finding about the provider or the models');
    // Only one exec was ever started.
    expect(fake.invocations().filter((entry) => entry.n >= 0)).toHaveLength(1);
  }, 60_000);

  it('an attempt that asked a dead collector is recorded observerFailed, not as a missing record', () => {
    const evidence = attemptAppliedEffortEvidence({
      requestedEffort: 'medium', requestedModelID: SOL, collectorAttached: true, requestSent: true, threadID: 't',
      observation: { correlated: false, recordCount: 0, correlationKey: '', observerFailure: 'socket closed' },
    });
    expect(evidence).toMatchObject({ verdict: 'appliedEffortUnavailable', correlation: 'observerFailed' });
    expect(evidence.detail).toContain('not a provider or model failure');
  });
});

// MARK: - Mission 12 cases 6-8 · reroute, provider failure, auth failure

describe('effort telemetry beside the failures the driver already reports', () => {
  it('reroute + effort telemetry: the reroute still fails the run and is listed; the effort verdict is its own fact', async () => {
    const run = await runMatrix({ scenarios: [{ reroute: 'gpt-5.5' }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.executionIdentityVerdict).toBe('substituted');
    expect(row.reportedModelID).toBe('gpt-5.5');
    expect(run.result.identitySubstitutions).toHaveLength(1);
    expect(run.result.identitySubstitutions[0]).toMatchObject({ requestedModelID: SOL, reportedModelID: 'gpt-5.5' });
    expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(row.appliedEffort).toBe('medium');
    // The run is still a failure: a verified effort does not rescue a substituted model.
    expect(row.status).not.toBe('pass');
  }, 60_000);

  it('provider failure with telemetry: a transport failure is recorded as one, the effort beside it', async () => {
    const run = await runMatrix({ scenarios: [{ turnFailed: { status: 500, message: 'upstream error' } }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
    expect(row.providerThrottled).toBe(false);
    expect(run.result.throttle).toBeUndefined();
    expect(run.result.executedRunCount).toBe(2);
  }, 60_000);

  it('auth failure before usable telemetry: nothing is sent, the effort is unavailable as noRequestSent, the breaker trips', async () => {
    const run = await runMatrix({ scenarios: [{}, {}], preflight: API_KEY_SESSION });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(row.telemetryCorrelation).toBe('noRequestSent');
    expect(String(row.appliedEffortDetail)).toContain('not an effort finding');
    expect(run.result.throttle).toBeDefined();
    expect(run.fake.invocations().filter((entry) => entry.n >= 0)).toHaveLength(0);
  }, 60_000);

  it('auth failure reported by the CLI with no telemetry: unavailable, and the provider decline is the provider\'s', async () => {
    const run = await runMatrix({ scenarios: [{ telemetry: 'none', turnFailed: { status: 401, message: 'token expired' } }, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.appliedEffortVerdict).toBe('appliedEffortUnavailable');
    expect(row.providerThrottled).toBe(true);
    expect(run.result.throttle).toBeDefined();
  }, 60_000);
});

// MARK: - 12-19 · what must not change

describe('admission, identity, billing and token accounting are unchanged by telemetry', () => {
  it('matrix admission semantics are identical with and without telemetry', () => {
    const base = (telemetry?: WorkspaceMatrixRequest['effortTelemetry']) => buildWorkspaceMatrixPlan({
      pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: [SOL, ASTRA], effort: 'medium',
      discovery: DISCOVERY, campaignRoot: '/tmp/cernum-fixed-root', fixtureRoot: FIXTURE_ROOT, sandboxRoot: '/tmp/cernum-fixed-sb',
      runLabel: LABEL, identityAdmission: sealed([SOL, ASTRA], 'medium'), effortTelemetry: telemetry,
      driverFactory: (binding) => (binding.provider === 'codexCLI' ? new ScriptedWorkspaceAgent([]) : undefined),
      now: () => new Date('2026-09-21T23:00:00Z'),
    });
    const without = base();
    const withTelemetry = base({ endpoint: 'http://127.0.0.1:<port>', observerAvailable: true, availabilityDetail: 'x' });
    expect(withTelemetry.models.map((model) => model.admission)).toEqual(without.models.map((model) => model.admission));
    expect(withTelemetry.cells.map((cell) => [cell.recordLabel, cell.identityAdmission?.admissionDigest]))
      .toEqual(without.cells.map((cell) => [cell.recordLabel, cell.identityAdmission?.admissionDigest]));
    expect(withTelemetry.admittedUnverifiableRunCount).toBe(without.admittedUnverifiableRunCount);
    expect(withTelemetry.runnableRunCount).toBe(without.runnableRunCount);
  });

  it('exact model identity stays requestAcceptedIdentityUnverifiable however complete the telemetry', async () => {
    const run = await runMatrix({ scenarios: [{}, {}] });
    for (const { row } of run.rows) {
      expect(row.appliedEffortVerdict).toBe('appliedEffortVerified');
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(row.reportedModelID).toBe('');
      expect(row.executionIdentityVerdict).toBe('unverifiable');
      // The client-sent model is recorded where it is labelled as such, and nowhere that means identity.
      const attempt = (row.appliedEffortAttempts as AttemptAppliedEffortEvidence[])[0];
      expect(attempt.telemetryClientSentModels).toEqual([SOL]);
    }
  }, 60_000);

  it('ChatGPT auth stays forced, OPENAI_API_KEY reaches no child, and the telemetry itself confirms both', async () => {
    const run = await runMatrix({ scenarios: [{}, {}] });
    for (const exec of run.fake.invocations().filter((entry) => entry.n >= 0)) {
      const forced = exec.argv.indexOf('forced_login_method="chatgpt"');
      expect(forced).toBeGreaterThan(0);
      expect(exec.argv[forced - 1]).toBe('-c');
      // The collector argument touches no auth or billing key.
      const otel = exec.argv.find((argument) => argument.startsWith('otel='))!;
      expect(otel).not.toMatch(/login|auth|api_key|model_provider|base_url/);
      expect(exec.environmentNames.filter((name) => /^(OPENAI_|CODEX_)/.test(name))).toEqual([]);
    }
    const attempt = (rowFor(run, SOL, A).appliedEffortAttempts as AttemptAppliedEffortEvidence[])[0];
    expect(attempt.telemetryAuthMode).toBe('Chatgpt');
    expect(attempt.telemetryAPIKeyEnvironmentPresent).toBe(false);
  }, 60_000);

  it('an API-key session is still refused before anything is sent', async () => {
    const run = await runMatrix({ scenarios: [{}], preflight: API_KEY_SESSION });
    const row = rowFor(run, SOL, A);
    expect(String(row.detail)).toMatch(/API key/);
    expect(run.fake.invocations().filter((entry) => entry.n >= 0)).toHaveLength(0);
  }, 60_000);

  it('token accounting: total = input + output, reasoning is a subset of output, telemetry figures kept raw', async () => {
    const run = await runMatrix({ scenarios: [{}, {}] });
    const row = rowFor(run, SOL, A);
    expect(row.inputTokens).toBe(67791);
    expect(row.reasoningTokens).toBe(117);
    expect(row.visibleOutputTokens).toBe(1413 - 117);
    expect(row.totalTokens).toBe(67791 + 1413);
    expect(row.totalTokens).not.toBe(67791 + 1413 + 117);
    const attempt = (row.appliedEffortAttempts as AttemptAppliedEffortEvidence[])[0];
    expect(attempt.telemetryRequestUsage).toEqual([{
      at: '2026-09-21T00:00:00.000Z', effort: 'medium', inputTokens: 8506, cachedInputTokens: 8064,
      outputTokens: 211, reasoningTokens: 7,
    }]);
  }, 60_000);
});

// MARK: - 14 · a dry run never claims an applied effort

describe('the plan states the telemetry requirement and never an applied effort', () => {
  const plan = (telemetry: WorkspaceMatrixRequest['effortTelemetry']) => buildWorkspaceMatrixPlan({
    pack: PACK, cases: allWorkspaceCases(), provider: 'codexCLI', modelIDs: [SOL, ASTRA], effort: 'max', discovery: DISCOVERY,
    campaignRoot: '/tmp/cernum-fixed-root', fixtureRoot: FIXTURE_ROOT, sandboxRoot: '/tmp/cernum-fixed-sb',
    runLabel: LABEL, identityAdmission: sealed([SOL, ASTRA], 'max'), effortTelemetry: telemetry,
    driverFactory: codexFactory('/nonexistent/codex'),
  });

  it('says TO BE MEASURED LIVE, names every consequence, and prints the collector argument with a placeholder port', () => {
    const built = plan({ endpoint: 'http://127.0.0.1:<ephemeral port chosen when the run starts>', observerAvailable: true,
      availabilityDetail: 'probe' });
    const printed = describeWorkspaceMatrixPlan(built).join('\n');
    expect(built.models.every((model) => model.effortTelemetry.appliedEffort === 'toBeMeasuredLive')).toBe(true);
    expect(printed).toContain('TO BE MEASURED LIVE — this dry run has verified no applied effort');
    expect(printed).toContain('effort telem.   REQUIRED and ARMED — 4 runnable run(s)');
    expect(printed).toContain('if missing');
    expect(printed).toContain('if mismatched');
    expect(printed).toContain('if ambiguous');
    expect(printed).toContain('<ephemeral port chosen when the run starts>');
    expect(printed).not.toMatch(/appliedEffortVerified|applied effort verified|effort verified/i);
  });

  it('a Codex plan with no collector arranged says NOT MEASURED; a Claude plan prints no telemetry at all', () => {
    expect(describeWorkspaceMatrixPlan(plan(undefined)).join('\n')).toContain('NOT ARRANGED');
    const claude = buildWorkspaceMatrixPlan({
      pack: PACK, cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: ['claude-haiku-4-5'], effort: 'none',
      discovery: DISCOVERY, campaignRoot: '/tmp/cernum-fixed-root', fixtureRoot: FIXTURE_ROOT, sandboxRoot: '/tmp/cernum-fixed-sb',
      runLabel: LABEL, driverFactory: () => new ScriptedWorkspaceAgent([]),
    });
    const printed = describeWorkspaceMatrixPlan(claude).join('\n');
    expect(printed).not.toContain('effort telem.');
    expect(printed).not.toContain('applied       ');
    expect(claude.models[0].effortTelemetry.measurable).toBe(false);
  });
});

// MARK: - 20 · the Claude path

describe('a Claude matrix is unchanged', () => {
  it('writes no applied-effort field, no effort block, and no stamp', async () => {
    const root = temporary('cernum-claude-root-');
    const request: WorkspaceMatrixRequest = {
      pack: PACK, cases: allWorkspaceCases(), provider: 'claudeCLI', modelIDs: ['claude-haiku-4-5'], effort: 'none',
      discovery: DISCOVERY, campaignRoot: root, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-claude-sb-'),
      runLabel: 'claude-unchanged', attemptCeiling: 1,
      driverFactory: (binding) => (binding.provider === 'claudeCLI'
        ? new ScriptedWorkspaceAgent([{ steps: [{ do: 'say', text: 'nothing to change' }] }, { steps: [{ do: 'say', text: 'still nothing' }] }])
        : undefined),
      environmentSource: RUN_OPTIONS.environmentSource,
    };
    const plan = buildWorkspaceMatrixPlan(request);
    const result = await runWorkspaceMatrix(plan, request, RUN_OPTIONS);
    expect(result.appliedEffortVerdicts).toEqual([]);
    const rows = collectWorkspaceRunRows(root);
    expect(rows.length).toBe(2);
    for (const { row } of rows) {
      for (const key of ['requestedEffort', 'appliedEffort', 'appliedEffortVerdict', 'appliedEffortAttempts', 'telemetryCapture',
        'telemetryCorrelation']) {
        expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(false);
      }
    }
    for (const cell of aggregateWorkspaceRuns(rows)) {
      expect(cell.effortProvenance).toBeUndefined();
      expect(describeWorkspaceCell(cell)).not.toMatch(/effort/i);
    }
    expect(workspaceAppliedEffortProvenance(rows).candidates).toEqual([]);
  }, 60_000);
});

// MARK: - 21 · historical pack identities

describe('historical pack identities are unchanged', () => {
  it('every registered pack digests exactly as the sealed records say', () => {
    const PINNED: Record<string, string> = {
      'pack.cernum.workspace.foundation-four': 'cwp1:c6bf8ba27e409eaefc8841110e8de44f9e3205602e8a810971f4ecd484d03f2d',
      'pack.cernum.workspace.tier-two': 'cwp1:e7e675e4ed02ddfea659d606bc747818de21a8ef23b46a757aa07eea3592d381',
      'pack.cernum.workspace.tier-three': 'cwp1:ea6becd1873d95c8d30f45d7ffd9ff6c073594f1e22e2e319a11a541de9bf7e2',
      'pack.cernum.workspace.discriminator-one': 'cwp1:03afd8f384dfe800245beb3e3f7ccf1eef1667c37a04672d0f3c1f91bd388edf',
    };
    for (const [id, digest] of Object.entries(PINNED)) {
      const pack = registeredWorkspacePacks.find((entry) => entry.id === id);
      expect(pack, id).toBeDefined();
      expect(workspacePackDigest(pack!, allWorkspaceCases())).toBe(digest);
    }
    expect(workspacePackDigest(foundationFourPack, allWorkspaceCases())).toBe(PINNED['pack.cernum.workspace.foundation-four']);
  });
});

// MARK: - The pure verdict

describe('the verdict, attempt by attempt and run by run', () => {
  const observation = (overrides: Partial<OTLPTurnObservation> = {}): OTLPTurnObservation => ({
    correlated: true, recordCount: 3, correlationKey: '[REDACTED:conversation.id:1]', turnReasoningEffort: 'medium',
    turnReasoningEffortSource: 'otlp:codex.conversation_starts.reasoning_effort', clientSentModels: [SOL], ...overrides,
  });
  const judge = (overrides: Partial<Parameters<typeof attemptAppliedEffortEvidence>[0]> = {}) => attemptAppliedEffortEvidence({
    requestedEffort: 'medium', requestedModelID: SOL, collectorAttached: true, requestSent: true, threadID: 't',
    observation: observation(), ...overrides,
  });

  it('never converts request acceptance into applied-effort proof', () => {
    expect(judge({ collectorAttached: false })).toMatchObject({ verdict: 'appliedEffortUnavailable', correlation: 'noCollector' });
    expect(judge({ collectorAttached: false }).appliedEffort).toBeUndefined();
    expect(judge({ observation: observation({ turnReasoningEffort: undefined, recordCount: 2 }) }))
      .toMatchObject({ verdict: 'appliedEffortUnavailable', correlation: 'correlatedByConversationID' });
  });

  it('two different efforts on the start records are ambiguous, and neither is taken', () => {
    const evidence = judge({ observation: observation({ turnReasoningEffort: undefined, effortAmbiguous: true }) });
    expect(evidence).toMatchObject({ verdict: 'appliedEffortAmbiguous' });
    expect(evidence.appliedEffort).toBeUndefined();
  });

  it('a run is as verified as its least-verified sent attempt; refused attempts do not count against it', () => {
    const verified = judge();
    const mismatch = judge({ observation: observation({ turnReasoningEffort: 'max' }) });
    const refused = judge({ requestSent: false });
    expect(runAppliedEffortEvidence([verified, mismatch])!.verdict).toBe('appliedEffortMismatch');
    expect(runAppliedEffortEvidence([verified, mismatch])!.appliedEffort).toBeUndefined();
    expect(runAppliedEffortEvidence([refused, verified])!.verdict).toBe('appliedEffortVerified');
    expect(runAppliedEffortEvidence([refused])!.verdict).toBe('appliedEffortUnavailable');
    expect(runAppliedEffortEvidence([undefined, undefined])).toBeUndefined();
  });
});

// MARK: - The observer's additions

describe('the observer reads the per-request records and nothing it cannot attribute', () => {
  it('reads request efforts, client-sent models, the API-key flag and per-request usage — de-duplicated', async () => {
    const directory = temporary('cernum-otlp-');
    const observer = await OTLPObserver.start({ evidenceFile: path.join(directory, 'e.jsonl'), observeTimeoutMilliseconds: 100,
      shutdownGraceMilliseconds: 0 });
    const start = CODEX_0155_CONVERSATION_STARTS.find((entry) => entry.requestedModel === ASTRA && entry.appliedEffort === 'max')!;
    const post = (payload: unknown) => fetch(observer.endpoint, { method: 'POST', body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' } });
    const sse = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [
      { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
      { key: 'event.kind', value: { stringValue: 'response.completed' } },
      { key: 'event.timestamp', value: { stringValue: '2026-09-21T21:47:01.534Z' } },
      { key: 'conversation.id', value: { stringValue: start.conversationID } },
      { key: 'model', value: { stringValue: ASTRA } },
      { key: 'model_reasoning_effort', value: { stringValue: 'max' } },
      { key: 'input_token_count', value: { stringValue: '8506' } },
      { key: 'output_token_count', value: { stringValue: '211' } },
      { key: 'reasoning_token_count', value: { stringValue: '7' } },
    ] }] }] }] };
    await post(start.payload);
    await post(sse);
    await post(sse); // the exporter re-delivers
    const turn = await observer.observe(start.conversationID);
    expect(turn?.turnReasoningEffort).toBe('max');
    expect(turn?.turnReasoningEffortSource).toBe('otlp:codex.conversation_starts.reasoning_effort');
    expect(turn?.requestReasoningEfforts).toEqual(['max']);
    expect(turn?.clientSentModels).toEqual([ASTRA]);
    expect(turn?.apiKeyEnvironmentPresent).toBe(false);
    expect(turn?.requestUsage).toHaveLength(1);
    expect(turn?.requestUsage?.[0]).toMatchObject({ inputTokens: 8506, outputTokens: 211, reasoningTokens: 7 });
    const stopped = await observer.stop();
    expect(stopped.leakAuditClean).toBe(true);
    expect(stopped.failure).toBeUndefined();
  });

  it('a loopback probe binds and releases, writing nothing', async () => {
    const probe = await OTLPObserver.probeLoopback();
    expect(probe.available).toBe(true);
    expect(probe.detail).toMatch(/127\.0\.0\.1:\d+/);
  });
});

// MARK: - Mission 8 · the Codex session probe

describe('the Codex session preflight asks `codex doctor --json` and nothing that can reach a model', () => {
  const doctor = (report: unknown, exitCode = 0) => async (): Promise<CLIResult> => ({
    stdout: JSON.stringify(report), stderr: '', exitCode, signal: null, elapsedMilliseconds: 900,
    failure: exitCode === 0 ? undefined : { kind: 'exitFailure', detail: `exit ${exitCode}` },
  } as CLIResult);

  it('declares one frozen argv with no prompt-bearing flag', () => {
    const probe = NON_MODEL_SESSION_PROBES.codexCLI!;
    expect(probe.executableName).toBe('codex');
    expect(probe.args).toEqual(['doctor', '--json']);
    expect(() => assertNonModelProbe(probe)).not.toThrow();
    expect(() => assertNonModelProbe({ ...probe, args: ['exec', '--json'] })).toThrow(/not the frozen probe/);
  });

  it('runs exactly that argv, withholding every OPENAI_* and CODEX_* name, and reads a usable ChatGPT session', async () => {
    const seen: { args: string[]; environment?: Record<string, string> }[] = [];
    const status = await readProviderSessionStatus({
      provider: 'codexCLI',
      environmentSource: { PATH: process.env.PATH, HOME: '/tmp/h', OPENAI_API_KEY: 'sk-cernum-test', CODEX_HOME: '/tmp/x' },
      runCommand: async (request) => {
        seen.push({ args: [...request.args], environment: request.replaceEnvironment });
        return doctor(DOCTOR_CHATGPT)();
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual(['doctor', '--json']);
    expect(Object.keys(seen[0].environment ?? {}).filter((name) => /^(OPENAI_|CODEX_)/.test(name))).toEqual([]);
    expect(status.environmentWithheld).toEqual(['CODEX_HOME', 'OPENAI_API_KEY']);
    expect(status).toMatchObject({ probeSucceeded: true, signedIn: true, sessionUsable: true, authMethod: 'chatgpt' });
    expect(status.transportHandshake).toContain('HTTP 101');
    expect(status.remainingAllowance.provenance).toBe('unavailable');
    expect(sessionPreflightRefusal(status)).toBeUndefined();
    const printed = describeProviderSessionStatus(status).join('\n');
    expect(printed).toContain('usable        yes');
    expect(printed).toContain('NOT proof a model request would be served');
    expect(JSON.stringify(status)).not.toContain('/Users/');
  });

  it('refuses an API-key session: signed in, and still not billable as subscription-included', async () => {
    const report = JSON.parse(JSON.stringify(DOCTOR_CHATGPT));
    Object.assign(report.checks['auth.credentials'].details, { 'stored API key': 'true', 'stored ChatGPT tokens': 'false',
      'stored auth mode': 'apikey' });
    const status = await readProviderSessionStatus({ provider: 'codexCLI', runCommand: doctor(report) });
    expect(status).toMatchObject({ signedIn: true, sessionUsable: false });
    expect(sessionPreflightRefusal(status)).toMatch(/API key/);
  });

  it('reads "no credentials" from a doctor that exits 1, and refuses on that fact', async () => {
    const report = { overallStatus: 'fail', checks: { 'auth.credentials': { status: 'fail',
      summary: 'no Codex credentials were found', details: { 'auth storage mode': 'File' } } } };
    const status = await readProviderSessionStatus({ provider: 'codexCLI', runCommand: doctor(report, 1) });
    expect(status).toMatchObject({ probeSucceeded: true, signedIn: false, sessionUsable: false });
    expect(sessionPreflightRefusal(status)).toContain('no signed-in session');
  });

  it('a dry run DEFERS the probe: named, not run, and never a refusal', () => {
    const status = deferredProviderSessionStatus('codexCLI')!;
    expect(status.deferredToLiveRun).toBe(true);
    expect(sessionPreflightRefusal(status)).toBeUndefined();
    expect(describeProviderSessionStatus(status).join('\n')).toContain('NOT YET RUN');
    expect(deferredProviderSessionStatus('claudeCLI')).toBeUndefined();
  });
});

// MARK: - The real command, end to end, with nothing reachable

describe('cernum workspace-benchmark with a Codex route and the telemetry collector', () => {
  let campaigns: string;
  let fakeBin: string;
  beforeEach(() => {
    campaigns = temporary('cernum-effort-cli-');
    fakeBin = temporary('cernum-effort-bin-');
    const file = discoveryStorePath(campaigns);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ writtenAt: new Date().toISOString(), models: [acceptedCodexRoute(SOL)] }), 'utf8');
  });
  const f4Digest = workspacePackDigest(foundationFourPack, allWorkspaceCases());
  const admission = (label: string) => {
    const file = path.join(campaigns, 'admission.json');
    fs.writeFileSync(file, JSON.stringify({
      admissionScope: 'workspaceMatrix', authorizedBy: 'the repository owner, for this test', reason: 'test', intent: 'test',
      pack: { id: foundationFourPack.id, version: foundationFourPack.version, digest: f4Digest },
      admitted: [{ provider: 'codexCLI', requestedModelID: SOL, requestedEffort: 'medium', driverID: CODEX_WORKSPACE_DRIVER_ID,
        cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST, executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
        authenticationBasis: 'fixture', evidenceDigest: 'sha256:fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z' }],
    }));
    void label;
    return file;
  };
  const cernum = (fake: string, ...args: string[]) => {
    fs.copyFileSync(fake, path.join(fakeBin, 'codex'));
    fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
    const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
      cwd: repositoryRoot, encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin`, OPENAI_API_KEY: 'sk-cernum-test-not-a-key' },
    });
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  it('a dry run shows the requirement, runs no codex at all, and claims no applied effort', () => {
    const fake = fakeCodex([]);
    const dry = cernum(fake.executable, 'workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--label', 'f4-effort', '--admit-identity-unverifiable', admission('f4-effort'), '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.output).toContain('TO BE MEASURED LIVE — this dry run has verified no applied effort');
    expect(dry.output).toContain('effort telem.   REQUIRED and ARMED');
    expect(dry.output).toContain('NOT YET RUN');
    expect(dry.output).not.toMatch(/appliedEffortVerified|applied effort verified/i);
    expect(fake.invocations()).toEqual([]);
  }, 120_000);

  it('a live run (against the fake) starts the collector, measures every run, and writes it all down', () => {
    const fake = fakeCodex([]);
    const aggregate = path.join(campaigns, 'aggregate.json');
    const live = cernum(fake.executable, 'workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--label', 'f4-effort', '--repeats', '1', '--max-attempts', '1',
      '--admit-identity-unverifiable', admission('f4-effort'), '--aggregate', aggregate, '--yes');
    expect(live.status, live.output).toBe(0);
    expect(live.output).toMatch(/OTLP collector on http:\/\/127\.0\.0\.1:\d+ — loopback only/);
    expect(live.output).toContain('usable        yes');
    expect(live.output).toContain('applied effort  4 verified · 0 MISMATCH · 0 ambiguous · 0 unavailable');
    expect(live.output).toContain('QUALIFIED — every one of 4 executed run(s) measured medium');
    const invocations = fake.invocations();
    // THE MATRIX PREFLIGHT RUNS FIRST, before any exec; each run's driver then repeats the same frozen probe.
    expect(invocations[0]).toMatchObject({ n: -1, argv: ['doctor', '--json'] });
    const doctors = invocations.filter((entry) => entry.n === -1);
    expect(doctors).toHaveLength(1 + 4);
    expect(doctors.every((entry) => entry.argv.join(' ') === 'doctor --json')).toBe(true);
    const execs = invocations.filter((entry) => entry.n >= 0);
    expect(execs).toHaveLength(4);
    expect(new Set(execs.map((entry) => entry.endpoint)).size).toBe(1);
    for (const exec of [...execs, ...invocations.filter((entry) => entry.n === -1)]) {
      expect(exec.environmentNames).not.toContain('OPENAI_API_KEY');
    }
    const written = JSON.parse(fs.readFileSync(aggregate, 'utf8'));
    expect(written.appliedEffort.candidates[0]).toMatchObject({
      candidate: `codexCLI:${SOL}@medium`, verifiedRunCount: 4, qualifiedForRequestedEffort: true,
    });
    expect(written.effortTelemetry.leakAuditClean).toBe(true);
    expect(written.identity.candidates[0].identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(fs.existsSync(path.join(campaigns, 'workspace', 'f4-effort.otlp', 'f4-effort-otlp-payloads.redacted.jsonl'))).toBe(true);
  }, 180_000);
});
