// Cernum development runner · Pass D — the terminal surface, and the text benchmark it must not move.
//
// Every command here is the REAL program, spawned as a subprocess, with three tripwires armed:
//
//   · recording `claude`, `codex` and `opencode` stubs first on PATH, so any provider process that
//     starts leaves a line behind
//   · a preload that refuses and records every TCP, TLS, UDP, DNS, HTTP and fetch attempt
//   · a campaign root in a fresh temp directory, so "nothing was written" is a directory listing
//
// Nothing here is allowed to reach a model, and the assertions are that nothing did.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMAND_SPECS, acceptedOptions, spendingCommands } from '../../src/cli/command-spec';
import { DEVELOPMENT_ANSWER_PATH } from '../../src/core/development-benchmark';
import { developmentSuites } from '../../src/core/development-catalog';
import { allGovernedSuites, canonicalPolicies, registeredSuites } from '../../src/core/catalog';
import {
  DevelopmentEligibilityError, SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, SyntheticDevelopmentAdapter, assertDevelopmentExecutable, parseSyntheticDevelopmentScript,
} from '../../src/engine/development-synthetic';
import { buildDevelopmentPlan } from '../../src/engine/development-plan';
import { writeDiscoveryStore } from '../../src/engine/discovery-store';
import { rankCandidates } from '../../src/engine/ranking';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { CORRECT_ANSWERS, REFERENCE_SOLUTIONS, apply, baseline } from './fixtures/ledgerlite-solutions';

const repository = path.resolve(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const NODE_DIRECTORY = path.dirname(process.execPath);
const TOTAL_TASKS = developmentSuites.reduce((sum, suite) => sum + suite.tasks.length, 0);

let scratch: string;
let campaigns: string;
let fakeBin: string;
let networkLog: string;

function installRecordingCLI(name: string): void {
  const log = path.join(fakeBin, `${name}.invocations`);
  fs.writeFileSync(path.join(fakeBin, name), [
    '#!/bin/sh', `echo "$@" >> ${JSON.stringify(log)}`, 'cat > /dev/null',
    `printf '{"result":"THIS SHOULD NEVER BE REACHED","modelUsage":{},"usage":{},"is_error":false}\\n'`, '',
  ].join('\n'), { mode: 0o755 });
}

function providerInvocations(): string[] {
  return ['claude', 'codex', 'opencode'].flatMap((name) => {
    const log = path.join(fakeBin, `${name}.invocations`);
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) : [];
  });
}

/** Network attempts other than the TypeScript loader's own local pipe. */
function networkAttempts(): string[] {
  if (!fs.existsSync(networkLog)) return [];
  return fs.readFileSync(networkLog, 'utf8').split('\n').filter((line) => line.length > 0 && !/ ipc /.test(line));
}

function cernum(...args: string[]) {
  const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
    cwd: repository, encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin`,
      NODE_OPTIONS: `--require ${PRELOAD}`,
      CERNUM_NETWORK_LOG: networkLog,
    },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function nothingReachedAnything(): void {
  expect(providerInvocations()).toEqual([]);
  expect(networkAttempts()).toEqual([]);
}

/** Every file under the campaign root except the discovery store a test may have planted. */
function campaignFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(path.relative(campaigns, full));
    }
  };
  walk(campaigns);
  return out.filter((file) => !file.startsWith('.providers'));
}

/** A script that answers every question correctly and applies every reference edit — built from test material only. */
function referenceScript(): string {
  const tasks: Record<string, unknown> = {};
  for (const suite of developmentSuites) {
    for (const task of suite.tasks) {
      if (task.kind === 'repositoryQuestion') {
        tasks[task.id] = { answerFile: JSON.stringify(CORRECT_ANSWERS[task.id]) };
        continue;
      }
      const solved = apply(REFERENCE_SOLUTIONS[task.id]);
      const files: Record<string, string | null> = {};
      for (const [relative, contents] of solved) if (baseline.get(relative) !== contents) files[relative] = contents;
      for (const relative of baseline.keys()) if (!solved.has(relative)) files[relative] = null;
      tasks[task.id] = { files };
    }
  }
  const file = path.join(scratch, 'reference-script.json');
  fs.writeFileSync(file, JSON.stringify({ format: SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, tasks }));
  return file;
}

function proveInStore(provider: string, modelID: string): void {
  writeDiscoveryStore(campaigns, [{
    provider: provider as never, modelID, displayName: modelID, availability: 'proven',
    evidence: `the provider returned ${modelID} (test fixture)`, verifiedModelID: modelID, desiredEfforts: [],
    discoveredAt: '2026-09-21T00:00:00Z',
  }]);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-develop-cli-'));
  campaigns = path.join(scratch, 'campaigns');
  fakeBin = path.join(scratch, 'bin');
  networkLog = path.join(scratch, 'network.log');
  fs.mkdirSync(campaigns);
  fs.mkdirSync(fakeBin);
  for (const name of ['claude', 'codex', 'opencode']) installRecordingCLI(name);
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('develop --dry-run: the plan, and nothing else', () => {
  it('prints candidates, tasks, repeats, attempts, commit, machine and eligibility, and writes and sends nothing', () => {
    const result = cernum('develop', 'preview', '--synthetic', '--repeats', '2', '--dry-run');
    expect(result.status, result.output).toBe(0);
    for (const expected of ['DRY RUN', 'plan digest', 'synthetic:scripted', `attempts          ${TOTAL_TASKS * 2}`,
      'repeats           2', 'machine', 'benchmark         0.2.4 at', 'cost      local', 'identity  verified',
      'EXECUTION ELIGIBILITY', 'NOTHING WAS SENT']) {
      expect(result.output).toContain(expected);
    }
    for (const suite of developmentSuites) for (const task of suite.tasks) expect(result.output).toContain(task.id);
    expect(campaignFiles()).toEqual([]);
    expect(fs.readdirSync(campaigns)).toEqual([]);
    nothingReachedAnything();
  }, 120_000);

  it('names every refusal a real run would hit, and still writes and sends nothing', () => {
    const result = cernum('develop', 'preview', '--candidates', 'claudeCLI:claude-opus-5:high,codexCLI:gpt-6-astra:max', '--dry-run');
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('A RUN WOULD BE REFUSED');
    expect(result.output).toMatch(/codexCLI has no verified development\s+workspace/);
    expect(result.output).toMatch(/claudeCLI:claude-opus-5@high: identity is unverifiable/);
    expect(result.output).toContain('subscription_included');
    expect(fs.readdirSync(campaigns)).toEqual([]);
    nothingReachedAnything();
  }, 120_000);
});

describe('develop: refuses unsafe or unapproved execution before anything exists', () => {
  it('refuses an unproven candidate, creating nothing', () => {
    const result = cernum('develop', 'real', '--candidates', 'claudeCLI:claude-opus-5:high', '--yes');
    expect(result.status).toBe(2);
    expect(result.output).toContain('identity is unverifiable');
    expect(fs.existsSync(path.join(campaigns, 'real'))).toBe(false);
    nothingReachedAnything();
  }, 120_000);

  it('refuses a provider with no verified workspace shape even when its model is proven', () => {
    proveInStore('codexCLI', 'gpt-6-astra');
    const result = cernum('develop', 'real', '--candidates', 'codexCLI:gpt-6-astra:max', '--yes');
    expect(result.status).toBe(2);
    expect(result.output).toContain('codexCLI has no verified development workspace argument shape');
    expect(fs.existsSync(path.join(campaigns, 'real'))).toBe(false);
    nothingReachedAnything();
  }, 120_000);

  it('refuses a metered candidate at plan time under the cost policy', () => {
    const result = cernum('develop', 'real', '--candidates', 'anthropicAPI:claude-opus-5', '--yes');
    expect(result.status).toBe(2);
    expect(result.output).toMatch(/metered/);
    expect(fs.existsSync(path.join(campaigns, 'real'))).toBe(false);
    nothingReachedAnything();
  }, 120_000);

  it('asks for --yes before a real run, even for a proven, eligible candidate', () => {
    proveInStore('claudeCLI', 'claude-opus-5');
    const result = cernum('develop', 'real', '--candidates', 'claudeCLI:claude-opus-5:high');
    expect(result.status).toBe(3);
    expect(result.output).toContain('Re-run with --yes');
    expect(fs.existsSync(path.join(campaigns, 'real'))).toBe(false);
    nothingReachedAnything();
  }, 120_000);

  it('refuses a synthetic script outside --synthetic', () => {
    const result = cernum('develop', 'real', '--candidates', 'claudeCLI:claude-opus-5', '--synthetic-script', referenceScript());
    expect(result.status).toBe(2);
    expect(fs.existsSync(path.join(campaigns, 'real'))).toBe(false);
    nothingReachedAnything();
  }, 120_000);
});

describe('develop, develop-status, develop-resume: a synthetic campaign interrupted and finished', () => {
  it('runs part, reports the gap, resumes without re-running anything, and reports complete coverage', () => {
    const script = referenceScript();
    const total = TOTAL_TASKS * 2;
    const first = cernum('develop', 'synth', '--synthetic', '--synthetic-script', script, '--repeats', '2', '--max-attempts', '3');
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain('Stopped before the end at --max-attempts 3');

    const results = path.join(campaigns, 'synth', 'results.jsonl');
    const partialBytes = fs.readFileSync(results);
    expect(partialBytes.toString('utf8').trim().split('\n')).toHaveLength(3);

    const partial = cernum('develop-status', 'synth');
    expect(partial.status).toBe(0);
    expect(partial.output).toContain('COVERAGE INCOMPLETE');
    expect(partial.output).toContain(`attempts          3 of ${total} terminal`);
    expect(partial.output).toContain('INCOMPLETE');
    expect(partial.output).toContain('measurementIncomplete');

    const preview = cernum('develop-resume', 'synth', '--synthetic-script', script, '--dry-run');
    expect(preview.status).toBe(0);
    expect(preview.output).toContain(`3 of ${total} attempt(s) already recorded; ${total - 3} would run`);
    expect(fs.readFileSync(results).equals(partialBytes)).toBe(true);

    const wrongScript = path.join(scratch, 'other-script.json');
    fs.writeFileSync(wrongScript, JSON.stringify({ format: SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, tasks: {} }));
    const refused = cernum('develop-resume', 'synth', '--synthetic-script', wrongScript);
    expect(refused.status).toBe(2);
    expect(refused.output).toContain('Resuming would join two experiments');
    expect(fs.readFileSync(results).equals(partialBytes)).toBe(true);

    const resumed = cernum('develop-resume', 'synth', '--synthetic-script', script);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain(`${total - 3} attempt(s) run this time, 3 already recorded before it`);

    // THE FIRST THREE ROWS ARE BYTE-FOR-BYTE WHAT THEY WERE. Resume appended; it rewrote nothing.
    const finalBytes = fs.readFileSync(results);
    expect(finalBytes.subarray(0, partialBytes.length).equals(partialBytes)).toBe(true);
    const rows = finalBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.slotKey)).size).toBe(total);
    expect(new Set(rows.map((row) => row.runID)).size).toBe(total);

    // Every workspace was disposable, under the temp root, and is gone.
    const artefacts = fs.readdirSync(path.join(campaigns, 'synth', 'development-attempts'));
    expect(artefacts).toHaveLength(total);
    for (const file of artefacts) {
      const artefact = JSON.parse(fs.readFileSync(path.join(campaigns, 'synth', 'development-attempts', file), 'utf8'));
      expect(fs.realpathSync(path.dirname(artefact.workspaceRoot))).toBe(fs.realpathSync(os.tmpdir()));
      expect(path.basename(artefact.workspaceRoot)).toMatch(/^cernum-development-/);
      expect(fs.existsSync(artefact.workspaceRoot)).toBe(false);
    }

    const done = cernum('develop-status', 'synth');
    expect(done.output).toContain('COVERAGE COMPLETE');
    expect(done.output).toContain('provider spend    NONE');
    const report = JSON.parse(cernum('develop-status', 'synth', '--json').stdout);
    const candidate = report.candidates[0];
    expect(report.complete).toBe(true);
    expect(candidate.pendingAttempts).toBe(0);
    for (const dimension of candidate.evidence.dimensions) {
      expect(dimension.state).toBe('measured');
      expect(dimension.gradedRepeatCount).toBe(dimension.plannedTaskCount * 2);
    }
    // Reference answers and reference edits: every question at full structural credit, every edit at
    // full structural credit and — because nothing was executed — only PARTIAL overall.
    expect(candidate.statusCounts.fail).toBe(0);
    expect(candidate.statusCounts.partial).toBeGreaterThanOrEqual(6);
    expect(candidate.roles.find((role: { role: string }) => role.role === 'multi-file editor').qualified).toBe(false);

    const again = cernum('develop', 'synth', '--synthetic', '--synthetic-script', script, '--repeats', '2');
    expect(again.status).toBe(2);
    expect(again.output).toContain('develop-resume');
    expect(fs.readFileSync(results).equals(finalBytes)).toBe(true);

    // The text benchmark's status command does not mistake a development campaign for one of its own.
    const textStatus = cernum('status', 'synth');
    expect(textStatus.status).not.toBe(0);
    nothingReachedAnything();
  }, 600_000);
});

describe('develop-reinterpret: an edit campaign re-graded from its retained bytes, offline', () => {
  it('re-grades every edit row from its evidence, touches no provider or network, and moves no recorded byte', () => {
    const script = referenceScript();
    const suite = developmentSuites.find((entry) => entry.tasks.some((task) => task.kind === 'repositoryEdit'))!;
    const run = cernum('develop', 'edits', '--synthetic', '--synthetic-script', script, '--suites', suite.id, '--repeats', '1');
    expect(run.status, run.output).toBe(0);
    const directory = path.join(campaigns, 'edits');
    const rows = fs.readFileSync(path.join(directory, 'results.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(suite.tasks.length);
    for (const row of rows) expect(row.editEvidence.state, row.taskID).toBe('byteExact');
    const before = new Map(campaignFiles().map((file) => [file, fs.readFileSync(path.join(campaigns, file))]));

    const dry = cernum('develop-reinterpret', 'edits', '--dry-run');
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain(`re-graded edits   ${suite.tasks.length} edit(s)`);
    expect(dry.output).toContain('DRY RUN');
    expect(campaignFiles().sort()).toEqual([...before.keys()].sort());

    const written = cernum('develop-reinterpret', 'edits');
    expect(written.status, written.output).toBe(0);
    expect(written.output).toContain('the campaign\'s own files are unchanged');
    const added = campaignFiles().filter((file) => !before.has(file));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^edits\/reinterpretations\/mldri1_[0-9a-f]+\.json$/);
    for (const [file, bytes] of before) expect(fs.readFileSync(path.join(campaigns, file)).equals(bytes), file).toBe(true);
    const document = JSON.parse(fs.readFileSync(path.join(campaigns, added[0]), 'utf8'));
    expect(document.editRows).toHaveLength(suite.tasks.length);
    expect(document.editRows.every((row: { reproducedUnderOriginalContract: boolean }) => row.reproducedUnderOriginalContract)).toBe(true);
    nothingReachedAnything();
  }, 300_000);
});

describe('the synthetic candidate and the execution gate, in process', () => {
  it('refuses a script path that leaves the workspace', async () => {
    const task = developmentSuites[0].tasks[0];
    const script = parseSyntheticDevelopmentScript(JSON.stringify({
      format: SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, tasks: { [task.id]: { files: { '../escaped.txt': 'x' } } },
    }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-synthetic-fence-'));
    try {
      await expect(new SyntheticDevelopmentAdapter(script).complete({
        binding: {} as never, promptText: task.prompt.user, developmentWorkspace: { root, writable: true },
      })).rejects.toThrow(/outside the workspace/);
      expect(fs.existsSync(path.join(path.dirname(root), 'escaped.txt'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the answer file where the grader reads it, and nothing when it has no script', async () => {
    const task = developmentSuites.flatMap((suite) => suite.tasks).find((entry) => entry.kind === 'repositoryQuestion')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-synthetic-answer-'));
    try {
      const script = parseSyntheticDevelopmentScript(JSON.stringify({
        format: SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, tasks: { [task.id]: { answerFile: '{"a":1}' } },
      }));
      await new SyntheticDevelopmentAdapter(script).complete({
        binding: { requestedModelID: 'synthetic-x' } as never, promptText: task.prompt.user, developmentWorkspace: { root, writable: false },
      });
      expect(fs.readFileSync(path.join(root, DEVELOPMENT_ANSWER_PATH), 'utf8')).toBe('{"a":1}');
      fs.rmSync(path.join(root, DEVELOPMENT_ANSWER_PATH));
      const response = await new SyntheticDevelopmentAdapter().complete({
        binding: { requestedModelID: 'synthetic-x' } as never, promptText: task.prompt.user, developmentWorkspace: { root, writable: false },
      });
      expect(fs.readdirSync(root)).toEqual([]);
      expect(response.answerText).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a script that names a task nobody registered', () => {
    expect(() => parseSyntheticDevelopmentScript(JSON.stringify({
      format: SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT, tasks: { 'task.dev.nope': {} },
    }))).toThrow(DevelopmentEligibilityError);
  });

  it('lets exactly a proven claudeCLI candidate through the execution gate', () => {
    const base = {
      label: 'gate', repeats: 1, benchmarkVersion: '0.2.4', createdAt: '2026-09-21T00:00:00Z',
      machine: { machineIdentifier: 'm', platform: 'p' }, benchmarkCommit: 'e'.repeat(40), workingTreeDirty: false,
    };
    const proven = buildDevelopmentPlan({ ...base, candidates: [{
      name: 'claudeCLI:claude-opus-5', provider: 'claudeCLI', modelID: 'claude-opus-5', verifiedModelID: 'claude-opus-5',
      retry: DEFAULT_RETRY,
    }] });
    expect(() => assertDevelopmentExecutable(proven)).not.toThrow();
    const unproven = buildDevelopmentPlan({ ...base, candidates: [{ name: 'claudeCLI:claude-opus-5', provider: 'claudeCLI', modelID: 'claude-opus-5' }] });
    expect(() => assertDevelopmentExecutable(unproven)).toThrow(/identity is unverifiable/);
  });
});

// MARK: - The existing benchmark path

/** The command table as it stood before Pass D: name, effect, every accepted option. */
const PRE_PASS_D_COMMANDS: [string, string, string][] = [
  ['providers', 'readOnly', 'help,root,endpoint'], ['discover', 'invokesLocalTool', 'dry-run,help,root,endpoint'],
  ['smoke', 'spendsAllowance', 'models,all-ladder,max-attempts,evidence,pricing,authorize-metered,authorize-unpriced-metered,otlp-observer,yes,dry-run,help,root,endpoint'],
  ['credentials', 'readOnly', 'help,root,endpoint'], ['models', 'readOnly', 'help,root,endpoint'],
  ['suites', 'readOnly', 'help,root,endpoint'], ['cost', 'readOnly', 'help,root,endpoint'],
  ['authorize', 'writesLocal', 'ceiling,yes,help,root,endpoint'],
  ['create', 'writesLocal', 'models,frontier,suites,repeats,label,runtime-version,pricing,synthetic,observe-only,thinking,admit-identity-unverifiable,yes-identity-unverifiable,help,root,endpoint'],
  ['run', 'spendsAllowance', 'max-attempts,synthetic,observe-only,thinking,otlp-observer,dry-run,help,root,endpoint'],
  ['resume', 'spendsAllowance', 'max-attempts,synthetic,observe-only,thinking,otlp-observer,dry-run,help,root,endpoint'],
  ['status', 'readOnly', 'help,root,endpoint'], ['verify', 'readOnly', 'help,root,endpoint'],
  ['finalize', 'writesLocal', 'secret,help,root,endpoint'], ['retest', 'writesLocal', 'reason,runtime-version,help,root,endpoint'],
  ['prepare', 'writesLocal', 'out,suites,exclude-suites,frontier,repeats,reason,help,root,endpoint'],
  ['record-rulings', 'writesLocal', 'out,rulings,help,root,endpoint'],
  ['adjudicate', 'writesLocal', 'out,batch,key-out,secret,help,root,endpoint'],
  ['reinterpret', 'writesLocal', 'out,help,root,endpoint'], ['lock', 'writesLocal', 'help,root,endpoint'],
  ['unlock', 'writesLocal', 'force,help,root,endpoint'], ['endpoints', 'readOnly', 'help,root,endpoint'],
  ['where', 'readOnly', 'help,root,endpoint'], ['install-command', 'writesLocal', 'help,root,endpoint'],
  ['uninstall-command', 'writesLocal', 'help,root,endpoint'], ['help', 'readOnly', 'help,root,endpoint'],
];

describe('the text benchmark path is unchanged', () => {
  it('keeps every pre-existing command exactly as it was declared, and adds only the development commands', () => {
    const current = COMMAND_SPECS.map((spec): [string, string, string] =>
      [spec.name, spec.effect, acceptedOptions(spec).map((option) => option.name).join(',')]);
    // The workspace commands arrived on the parallel qualification line, and their options are pinned
    // by that line's own tests (`cli-argument-safety`, the workspace suites). Here they are only
    // required to exist with their effects, so neither line's addition can hide inside the other's.
    const isAddition = (name: string) => name.startsWith('develop') || name.startsWith('workspace');
    expect(current.filter(([name]) => !isAddition(name))).toEqual(PRE_PASS_D_COMMANDS);
    expect(current.filter(([name]) => name.startsWith('develop')).map(([name, effect]) => [name, effect])).toEqual([
      ['develop', 'spendsAllowance'], ['develop-resume', 'spendsAllowance'], ['develop-status', 'readOnly'],
      ['develop-reinterpret', 'writesLocal'],
    ]);
    expect(current.filter(([name]) => name.startsWith('workspace')).map(([name, effect]) => [name, effect])).toEqual([
      ['workspace', 'spendsAllowance'], ['workspace-benchmark', 'spendsAllowance'], ['workspace-report', 'writesLocal'],
    ]);
    expect(spendingCommands().sort()).toEqual([
      'develop', 'develop-resume', 'resume', 'run', 'smoke', 'workspace', 'workspace-benchmark',
    ]);
  });

  it('keeps the sealed 14-suite registry and its policies free of development entries', () => {
    const before = JSON.stringify([registeredSuites.map((suite) => suite.id.raw), canonicalPolicies.map((policy) => policy.id)]);
    // Build a development plan in this process: nothing it touches may reach the text registry.
    buildDevelopmentPlan({
      label: 'isolation', repeats: 2, benchmarkVersion: '0.2.4', createdAt: '2026-09-21T00:00:00Z',
      machine: { machineIdentifier: 'm', platform: 'p' }, benchmarkCommit: 'e'.repeat(40), workingTreeDirty: false,
      candidates: [{ name: 'synthetic:x', provider: 'ollama', modelID: 'synthetic-x', verifiedModelID: 'synthetic-x', authorizationMode: 'none' }],
    });
    expect(registeredSuites).toHaveLength(14);
    expect(JSON.stringify([registeredSuites.map((suite) => suite.id.raw), canonicalPolicies.map((policy) => policy.id)])).toBe(before);
    expect(allGovernedSuites.some((suite) => suite.id.raw.includes('development'))).toBe(false);
  });

  it('leaves every ranked candidate without a development campaign at NOT MEASURED', () => {
    const outcomes = ['claudeCLI:claude-opus-5', 'codexCLI:gpt-6-astra@max'].flatMap((candidate) => [
      { candidate, dimension: 'instructionFollowing', status: 'pass' },
      { candidate, dimension: 'structuredOutput', status: 'fail' },
    ]);
    const rankings = rankCandidates({ outcomes: outcomes as never, derivedAt: '2026-09-21T00:00:00Z' } as never);
    expect(rankings.rankings.length).toBe(2);
    for (const row of rankings.rankings) {
      expect(row.development.evidence.dimensions.every((entry) => entry.state === 'notMeasured')).toBe(true);
      expect(row.development.eligibility.verdict).toBe('notMeasured');
      expect(row.development.evidence.dimensions.every((entry) => 'unavailableReason' in entry.structuralPassRateMilli)).toBe(true);
    }
  });

  it('prints the same text suites it always did, with no development suite among them', () => {
    const result = cernum('suites');
    expect(result.status).toBe(0);
    expect(result.output).not.toMatch(/development/);
    for (const suite of registeredSuites.filter((entry) => !entry.id.raw.includes('foundation'))) {
      expect(result.output).toContain(suite.id.raw);
    }
    nothingReachedAnything();
  }, 120_000);
});
