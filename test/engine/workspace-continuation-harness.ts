// Shared scaffolding for the cell-selection and continuation tests. NOT a test file.
//
// NOTHING HERE CONTACTS A PROVIDER. Matrices run against scripted drivers that stand in for `codex
// exec` and start no process, or against a fake `codex` executable written into a temporary directory
// that posts OTLP only to the loopback collector the test started. Source campaigns are produced two
// ways: by the REAL engine (a scripted matrix whose provider "throttles" part-way, so the source has
// genuine completed, throttled and deferred cells), and by hand, mirroring the exact shape of the
// historical discriminator campaign so its nine-cell continuation can be proved without reading it.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import {
  RECEIPT_REFUNDS_SIGN, TASK_PRIORITY_PROPAGATE, allWorkspaceCases, discriminatorOnePack,
} from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack, workspacePackDigest, WorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest,
} from '../../src/engine/workspace-agent';
import {
  WorkspaceMatrixPlan, WorkspaceMatrixRequest, WorkspaceMatrixRunResult, buildWorkspaceMatrixPlan, runWorkspaceMatrix,
  workspaceMatrixIdentityProvenance,
} from '../../src/engine/workspace-matrix';
import {
  WorkspaceMatrixIdentityAdmission, parseWorkspaceMatrixAdmissionFile, sealWorkspaceMatrixAdmission,
} from '../../src/engine/workspace-matrix-admission';
import { aggregateWorkspaceRuns, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { CODEX_CLI_VERSION_VERIFIED_AGAINST, CODEX_WORKSPACE_DRIVER_ID } from '../../src/engine/workspace-codex-driver';
import { workspaceComparabilityKey } from '../../src/engine/workspace-case';
import { workspaceMatrixRecordName } from '../../src/engine/workspace-cell-selection';
import { provenModel } from './frontier-harness';
import { CODEX_0155_CONVERSATION_STARTS } from './fixtures/codex-otlp-0155-captured';

export const repositoryRoot = path.resolve(__dirname, '..', '..');
export const FIXTURE_ROOT = path.resolve(repositoryRoot, 'fixtures');
export const NODE_DIRECTORY = path.dirname(process.execPath);
export const SOL = 'gpt-5.6-sol';
export const ASTRA = 'gpt-6-astra';
export const A = RECEIPT_REFUNDS_SIGN.id;
export const B = TASK_PRIORITY_PROPAGATE.id;
export const SOURCE_LABEL = 'codex-source-01';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
export function temporary(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

/** SHA-256 of every file under a directory, by relative path: the immutability witness. */
export function treeDigest(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(directory, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(directory);
  return out;
}

export function acceptedCodexRoute(modelID: string, efforts = ['max', 'medium']) {
  const at = new Date().toISOString();
  return { ...provenModel('codexCLI', modelID), availability: 'unproven' as const, verifiedModelID: '', discoveredAt: at,
    desiredEfforts: efforts,
    evidence: `identity smoke test at ${at} (effort max, subscriptionIncluded, identity state `
      + `requestAcceptedIdentityUnverifiable): ${modelID} was accepted and something answered (fixture)` };
}

export const DISCOVERY: DiscoveryEvidence = {
  writtenAt: new Date().toISOString(),
  models: [acceptedCodexRoute(SOL), acceptedCodexRoute(ASTRA),
    { ...provenModel('claudeCLI', 'claude-haiku-4-5'), discoveredAt: new Date().toISOString() }],
};

/** Two one-attempt cases, three repeats: small enough to run, shaped like the real discriminator matrix. */
export const PACK = makeWorkspaceBenchmarkPack({
  id: 'pack.test.continuation', version: '1', caseIDs: [A, B], repeatsPerCase: 3,
});
export const PACK_DIGEST = workspacePackDigest(PACK, allWorkspaceCases());

export const CHANGES_NOTHING: ScriptedAttempt = { steps: [{ do: 'say', text: 'It looks correct to me.' }] };
export const USAGE_LIMIT = 'the CLI reported a failed turn: You’ve hit your usage limit. (fixture)';
export const THROTTLED: ScriptedAttempt = { steps: [{ do: 'fail', kind: 'rateLimited', detail: USAGE_LIMIT }] };

export type CodexScript = (modelID: string, caseID: string, run: number) => ScriptedAttempt;

/**
 * A stand-in for the Codex workspace driver. `script(modelID, caseID, run)` chooses each RUN's attempt,
 * where `run` counts that model's runs of that case from 1 — which, one attempt per run, is the repeat.
 * `calls` records every run actually started: the witness for "nothing else was sent".
 */
export function codexFactory(options: {
  script?: CodexScript;
  calls?: string[];
} = {}): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  const runs = new Map<string, number>();
  return (binding) => {
    if (binding.provider !== 'codexCLI') return undefined;
    const driver: WorkspaceAgentDriver & { cliVersionVerifiedAgainst: string; commandName: string } = {
      driverID: CODEX_WORKSPACE_DRIVER_ID,
      provider: 'codexCLI',
      commandName: 'codex',
      cliVersionVerifiedAgainst: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(request: WorkspaceAgentRequest) {
        const key = `${binding.requestedModelID}|${request.caseID}`;
        if (request.attemptIndex === 0) runs.set(key, (runs.get(key) ?? 0) + 1);
        const run = runs.get(key) ?? 1;
        options.calls?.push(`${binding.requestedModelID}|${request.caseID}|${run}`);
        const attempt = options.script?.(binding.requestedModelID, request.caseID, run) ?? CHANGES_NOTHING;
        const result = await new ScriptedWorkspaceAgent([attempt]).run(request);
        return { ...result, reportedModelID: '' };
      },
    };
    return driver;
  };
}

/** A stand-in for the Claude workspace driver, for the tests that a Claude matrix is unchanged. */
export function claudeFactory(calls?: string[]): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding) => {
    if (binding.provider !== 'claudeCLI') return undefined;
    const driver: WorkspaceAgentDriver = {
      driverID: 'driver.scripted.claude',
      provider: 'claudeCLI',
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(request: WorkspaceAgentRequest) {
        calls?.push(`${binding.requestedModelID}|${request.caseID}`);
        const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(request);
        return { ...result, reportedModelID: binding.requestedModelID };
      },
    };
    return driver;
  };
}

export function admissionText(options: {
  models?: string[]; effort?: string; pack?: WorkspaceBenchmarkPack; selectionDigest?: string;
  routeOverrides?: Record<string, unknown>;
} = {}): string {
  const pack = options.pack ?? PACK;
  return JSON.stringify({
    admissionScope: 'workspaceMatrix',
    authorizedBy: 'the repository owner, for this test',
    reason: 'measure Codex subscription routes whose tool names no model (fixture)',
    intent: 'test only; nothing is sent',
    pack: { id: pack.id, version: pack.version, digest: workspacePackDigest(pack, allWorkspaceCases()) },
    admitted: (options.models ?? [ASTRA]).map((model) => ({
      provider: 'codexCLI', requestedModelID: model, requestedEffort: options.effort ?? 'medium',
      driverID: CODEX_WORKSPACE_DRIVER_ID, cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      authenticationBasis: 'ChatGPT subscription session (fixture)',
      evidenceDigest: 'sha256:fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z',
      ...options.routeOverrides,
    })),
    ...(options.selectionDigest === undefined ? {} : { selection: { digest: options.selectionDigest } }),
  });
}

export function sealed(label: string, options: Parameters<typeof admissionText>[0] = {}): WorkspaceMatrixIdentityAdmission {
  return sealWorkspaceMatrixAdmission(parseWorkspaceMatrixAdmissionFile(admissionText(options)), {
    matrixLabel: label, authorizedAt: '2026-09-22T12:00:00Z',
  });
}

export const RUN_OPTIONS = { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'cernum test' };
export const ENVIRONMENT = { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' } as NodeJS.ProcessEnv;

export function request(overrides: Partial<WorkspaceMatrixRequest> & { campaignRoot: string }): WorkspaceMatrixRequest {
  return {
    pack: PACK,
    cases: allWorkspaceCases(),
    provider: 'codexCLI',
    modelIDs: [ASTRA],
    effort: 'medium',
    discovery: DISCOVERY,
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-sel-sandbox-'),
    runLabel: 'selection-test',
    driverFactory: codexFactory(),
    environmentSource: ENVIRONMENT,
    ...overrides,
  };
}

/** What the CLI writes as the aggregate, reduced to the fields a continuation reads. Same sources, same shapes. */
export function writeAggregate(root: string, label: string, plan: WorkspaceMatrixPlan, result: WorkspaceMatrixRunResult): string {
  const rows = collectWorkspaceRunRows(root).filter((run) => result.completed.some((entry) => entry.recordRoot === run.recordRoot));
  const file = path.join(root, 'aggregates', `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    packID: plan.packID, packVersion: plan.packVersion, packDigest: plan.packDigest,
    identity: workspaceMatrixIdentityProvenance(plan, rows),
    execution: {
      plannedRunCount: result.plannedRunCount,
      executedRunCount: result.executedRunCount,
      notExecutedCells: result.skipped.filter((entry) => entry.disposition === 'providerThrottledBeforeExecution')
        .map((entry) => ({ candidate: entry.cell.candidate, caseID: entry.cell.caseID,
          repeatIndex: entry.cell.repeat.repeatIndex, disposition: entry.disposition, reasons: entry.reasons })),
    },
    cells: aggregateWorkspaceRuns(rows),
  }, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * THE REAL ENGINE, producing a source like the historical one: sol completes all six cells; astra
 * completes repeat 1, passes A at repeat 2, is THROTTLED on B at repeat 2 (a sealed record of the
 * decline), and repeat 3 of both cases is DEFERRED by the breaker. 12 planned, 10 records.
 */
export async function runSourceMatrix(): Promise<{ root: string; plan: WorkspaceMatrixPlan; result: WorkspaceMatrixRunResult; calls: string[] }> {
  const root = temporary('cernum-source-');
  const calls: string[] = [];
  const matrix = request({
    campaignRoot: root, runLabel: SOURCE_LABEL, modelIDs: [SOL, ASTRA],
    identityAdmission: sealed(SOURCE_LABEL, { models: [SOL, ASTRA] }),
    driverFactory: codexFactory({ calls, script: (model, caseID, run) =>
      (model === ASTRA && caseID === B && run === 2 ? THROTTLED : CHANGES_NOTHING) }),
  });
  const plan = buildWorkspaceMatrixPlan(matrix);
  const result = await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
  writeAggregate(root, SOURCE_LABEL, plan, result);
  return { root, plan, result, calls };
}

// MARK: - The historical discriminator campaign's SHAPE, by hand

export const DISCRIMINATOR_LABEL = 'codex-discriminator-medium-v1-01';
export const DISCRIMINATOR_CASES = discriminatorOnePack.caseIDs;
/** Astra's executed runs in the historical campaign: all six at repeat 1, three at repeat 2. */
export const ASTRA_EXECUTED: { caseID: string; repeatIndex: number; status: string; throttled?: boolean }[] = [
  ...DISCRIMINATOR_CASES.map((caseID) => ({ caseID, repeatIndex: 1,
    status: caseID === 'ws.d1.asset-container.retitle' ? 'behavioralFailure' : 'pass' })),
  { caseID: 'ws.d1.asset-container.retitle', repeatIndex: 2, status: 'behavioralFailure' },
  { caseID: 'ws.d1.catalog-paging.walk', repeatIndex: 2, status: 'pass' },
  { caseID: 'ws.d1.config-migrate.upgrade', repeatIndex: 2, status: 'runtimeError', throttled: true },
];
/** The nine cells the brief names, exactly. */
export const EXPECTED_ASTRA_CONTINUATION = [
  'ws.d1.log-redact.mask@2', 'ws.d1.query-codec.nest@2', 'ws.d1.task-board.reassign@2',
  'ws.d1.asset-container.retitle@3', 'ws.d1.catalog-paging.walk@3', 'ws.d1.config-migrate.upgrade@3',
  'ws.d1.log-redact.mask@3', 'ws.d1.query-codec.nest@3', 'ws.d1.task-board.reassign@3',
];

/**
 * Write a source with the historical campaign's exact structure — 36 planned, sol 18/18, astra 9
 * executed (8 scored, 6 passes, 1 provider-throttled), 9 astra cells deferred — as sealed rows,
 * manifests and an aggregate, in the formats the engine writes them. No model output is fabricated
 * as evidence: these rows exist only to be classified.
 */
export function writeDiscriminatorShapedSource(): string {
  const root = temporary('cernum-disc-source-');
  const cases = allWorkspaceCases();
  const digest = workspacePackDigest(discriminatorOnePack, cases);
  const write = (modelID: string, caseID: string, repeatIndex: number, status: string, throttled = false): void => {
    const candidate = `codexCLI:${modelID}@medium`;
    const directory = path.join(root, 'workspace', workspaceMatrixRecordName(DISCRIMINATOR_LABEL, modelID, caseID, repeatIndex));
    fs.mkdirSync(path.join(directory, 'ledger'), { recursive: true });
    const workspaceCase = cases.find((entry) => entry.id === caseID)!;
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      label: `${discriminatorOnePack.id}@1 · ${caseID}@1 · ${candidate} · repeat ${repeatIndex}/3`,
      operationalEnvelope: { bindings: [{ candidate, requestedModelID: modelID, effort: 'medium', timeoutMilliseconds: 900000 }] },
    }));
    fs.writeFileSync(path.join(directory, 'ledger', 'plan.json'), '{}\n');
    fs.writeFileSync(path.join(directory, 'ledger', 'results.jsonl'), JSON.stringify({
      slotKey: `${candidate}|suite|1|${caseID}`, status, candidate, caseID, caseVersion: '1',
      comparabilityKey: workspaceComparabilityKey(workspaceCase), provider: 'codexCLI', requestedModelID: modelID,
      effort: 'medium', repeatIndex, repeatsPlanned: 3, packID: discriminatorOnePack.id, packVersion: '1', packDigest: digest,
      driverID: CODEX_WORKSPACE_DRIVER_ID, providerThrottled: throttled,
      ...(throttled ? { terminationReason: 'providerDeclined' } : {}),
      recordedAt: `2026-09-22T0${repeatIndex}:00:00Z`,
    }) + '\n');
  };
  for (let repeatIndex = 1; repeatIndex <= 3; repeatIndex++) for (const caseID of DISCRIMINATOR_CASES) write(SOL, caseID, repeatIndex, 'pass');
  for (const run of ASTRA_EXECUTED) write(ASTRA, run.caseID, run.repeatIndex, run.status, run.throttled === true);
  const deferred = [2, 3].flatMap((repeatIndex) => DISCRIMINATOR_CASES
    .filter((caseID) => !ASTRA_EXECUTED.some((run) => run.caseID === caseID && run.repeatIndex === repeatIndex))
    .map((caseID) => ({ candidate: `codexCLI:${ASTRA}@medium`, caseID, repeatIndex, disposition: 'providerThrottledBeforeExecution' })));
  fs.mkdirSync(path.join(root, 'aggregates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aggregates', `${DISCRIMINATOR_LABEL}.json`), JSON.stringify({
    packID: discriminatorOnePack.id, packVersion: '1', packDigest: digest,
    identity: {
      matrixAdmission: { matrixLabel: DISCRIMINATOR_LABEL },
      candidates: [SOL, ASTRA].map((modelID) => ({ provider: 'codexCLI', requestedModelID: modelID, effort: 'medium' })),
    },
    execution: { plannedRunCount: 36, executedRunCount: 27, notExecutedCells: deferred },
    cells: [{ repeatsPlanned: 3 }],
  }, null, 2));
  return root;
}

// MARK: - A fake `codex` that emits real-shaped OTLP, for the telemetry test

/**
 * A `codex exec` that reads the collector endpoint from its own `-c otel=…` argument and posts a
 * conversation-start and an sse record carrying the effort it was sent, then prints a thread id and a
 * completed turn. Loopback only: it can reach nothing but the collector the test started.
 */
export function fakeCodexWithTelemetry(): { executable: string; invocations: () => string[][] } {
  const directory = temporary('cernum-fake-codex-');
  const log = path.join(directory, 'invocations.jsonl');
  const template = path.join(directory, 'conversation-start.json');
  const counter = path.join(directory, 'counter');
  fs.writeFileSync(template, JSON.stringify(CODEX_0155_CONVERSATION_STARTS[0].payload));
  const executable = path.join(directory, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('codex-cli ${CODEX_CLI_VERSION_VERIFIED_AGAINST}\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const rewrite = (node, values) => {
  if (Array.isArray(node)) return node.map((entry) => rewrite(entry, values));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.key === 'string' && node.value && Object.prototype.hasOwnProperty.call(values, node.key)) {
    return { ...node, value: { stringValue: values[node.key] } };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v, values)]));
};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', async () => {
  const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const model = value('-m');
  const effort = JSON.parse(argv.find((a) => a.startsWith('model_reasoning_effort=')).split('=')[1]);
  const otel = argv.find((a) => a.startsWith('otel='));
  const endpoint = /endpoint = "([^"]+)"/.exec(otel)[1];
  const thread = '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const post = (payload) => new Promise((resolve) => {
    const u = new URL(endpoint + '/v1/logs');
    const request = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json' } }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', resolve);
    request.end(JSON.stringify(payload));
  });
  await post(rewrite(JSON.parse(fs.readFileSync(${JSON.stringify(template)}, 'utf8')),
    { 'conversation.id': thread, reasoning_effort: effort, model, slug: model }));
  await post({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex_exec' } }] },
    scopeLogs: [{ logRecords: [{ attributes: [
      { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
      { key: 'event.kind', value: { stringValue: 'response.completed' } },
      { key: 'event.timestamp', value: { stringValue: '2026-09-22T00:00:00.000Z' } },
      { key: 'conversation.id', value: { stringValue: thread } },
      { key: 'model', value: { stringValue: model } }, { key: 'slug', value: { stringValue: model } },
      { key: 'model_reasoning_effort', value: { stringValue: effort } },
      { key: 'input_token_count', value: { stringValue: '8506' } }, { key: 'output_token_count', value: { stringValue: '211' } },
      { key: 'reasoning_token_count', value: { stringValue: '7' } }, { key: 'cached_token_count', value: { stringValue: '8064' } },
    ] }] }] }] });
  for (const line of [{ type: 'thread.started', thread_id: thread }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I looked; nothing changed.' } },
    { type: 'turn.completed', usage: { input_tokens: 67791, cached_input_tokens: 56832, cache_write_input_tokens: 0,
      output_tokens: 1413, reasoning_output_tokens: 117 } }]) process.stdout.write(JSON.stringify(line) + '\\n');
  process.exit(0);
});
`, { mode: 0o755 });
  return {
    executable,
    invocations: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]) : []),
  };
}
