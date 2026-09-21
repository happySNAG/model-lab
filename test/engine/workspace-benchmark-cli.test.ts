// `cernum workspace-benchmark` — the comparative matrix command, and the refusals that make it
// safe to type.
//
// WHY THE REAL COMMAND IS SPAWNED. What has to be proved is that a person typing this at a prompt
// gets what the help says, and that is a property of the whole program including its dispatch and
// its argument table — the same reason `cli-argument-safety.test.ts` and `workspace-cli.test.ts`
// spawn it. A fake `claude` is installed first on PATH and RECORDS every invocation, so a test that
// accidentally reached a provider fails on the assertion that it did not.
//
// THE STAKES ARE HIGHER HERE THAN ON THE SINGLE-CASE COMMAND. `cernum workspace <case>` spends one
// run's allowance by mistake; this one spends forty-eight. Every guard the single-case command has
// — help without running, unknown options refused, a preview that sends nothing, `--yes` required —
// is therefore asserted again on this surface rather than assumed to be inherited.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allWorkspaceCases, discriminatorOnePack, foundationFourPack } from '../../src/engine/workspace-catalog';
import { resolveWorkspacePack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { workspaceCaseDigest } from '../../src/engine/workspace-case';
import { discoveryStorePath } from '../../src/engine/discovery-store';
import { provenModel } from './frontier-harness';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const NODE_DIRECTORY = path.dirname(process.execPath);
const PACK = foundationFourPack.id;
const CLAUDE_LINEUP = 'claude-haiku-4-5,claude-sonnet-5,claude-fable-5-1,claude-opus-5';

let campaigns: string;
let fakeBin: string;

/** A `claude` that records every invocation instead of answering one. Nothing here may reach it. */
function installRecordingCLI(): void {
  const log = path.join(fakeBin, 'claude.invocations');
  fs.writeFileSync(path.join(fakeBin, 'claude'), [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fixture)"; exit 0; fi',
    'cat > /dev/null',
    `printf '{"result":"THIS SHOULD NEVER BE REACHED","modelUsage":{},"usage":{},"is_error":false}\\n'`,
    '',
  ].join('\n'), { mode: 0o755 });
}

function invocations(): string[] {
  const log = path.join(fakeBin, 'claude.invocations');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

/**
 * The frozen NON-MODEL probes this command is allowed to run before it plans anything.
 *
 * `cernum workspace-benchmark` now asks the installed CLI about its own SESSION before it prints a
 * plan — `claude auth status --json`, a credential read that starts no session, sends no prompt and
 * consumes no allowance. It is a process, so `invocations()` sees it, and a test asserting that
 * NOTHING ran would now fail for a reason that has nothing to do with reaching a model.
 *
 * So the assertion is sharpened rather than relaxed: the probe is allowed by exact string, and
 * `modelInvocations` is what must stay empty. An invocation that carried a prompt, resumed a
 * conversation or named a model would appear there and fail the test exactly as before.
 */
const ALLOWED_NON_MODEL_PROBES = ['auth status --json'];

function modelInvocations(): string[] {
  return invocations().filter((line) => !ALLOWED_NON_MODEL_PROBES.includes(line.trim()));
}

/** Nothing that could have reached a model ran, whatever else did. */
function expectNoModelRequest(): void {
  expect(modelInvocations()).toEqual([]);
  for (const line of invocations()) {
    for (const forbidden of ['-p', '--print', '--prompt', '--resume', '--continue', '--model']) {
      expect(line.split(/\s+/)).not.toContain(forbidden);
    }
  }
}

/** The discovery store the whole lineup is proven in. Written by hand; no provider was contacted. */
function proveLineup(modelIDs: string[]): void {
  const file = discoveryStorePath(campaigns);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    writtenAt: new Date().toISOString(),
    models: modelIDs.map((modelID) => ({
      ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString(),
    })),
  }, null, 2), 'utf8');
}

function cernum(...args: string[]) {
  const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
    cwd: repositoryRoot, encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin` },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeEach(() => {
  campaigns = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-wsb-cli-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-wsb-bin-'));
  installRecordingCLI();
});
afterEach(() => {
  fs.rmSync(campaigns, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

describe('the dry run shows the whole matrix and runs none of it', () => {
  it('prints the pack, every case, every model and the two counts that are not the same number', () => {
    proveLineup(CLAUDE_LINEUP.split(','));
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', CLAUDE_LINEUP, '--dry-run');
    expect(result.status).toBe(0);

    // THE PACK, SEALED.
    expect(result.output).toContain(`${PACK}@1`);
    expect(result.output).toContain(workspacePackDigest(foundationFourPack, allWorkspaceCases()));

    // EVERY CASE OF THIS PACK, WITH ITS OWN DIGEST AND ITS OWN FIXTURE SEAL. The pack's members,
    // not the catalogue's — a preview that printed cases the pack does not name would be describing
    // a different experiment from the one it is about to run.
    for (const workspaceCase of resolveWorkspacePack(foundationFourPack, allWorkspaceCases())) {
      expect(result.output).toContain(`${workspaceCase.id}@${workspaceCase.version}`);
      expect(result.output).toContain(workspaceCaseDigest(workspaceCase));
      expect(result.output).toContain(workspaceCase.source.expectedTreeDigest!);
    }

    // THE TWO COUNTS, KEPT APART. Forty-eight independent runs; at most seventy-two attempts,
    // because two of the four cases allow a retry after a reported failure.
    expect(result.output).toContain('4 models x 4 cases x 3 repeats = 48 independent runs');
    expect(result.output).toMatch(/runnable\s+48/);
    expect(result.output).toMatch(/max attempts\s+72/);
    expect(result.output).toContain('A REPEAT is a fresh independent run');

    // EVERY MODEL, ITS IDENTITY STATE AND ITS BILLING BASIS, before anything is spent.
    for (const modelID of CLAUDE_LINEUP.split(',')) {
      expect(result.output).toContain(`claudeCLI:${modelID}`);
      expect(result.output).toContain(`--model ${modelID}`);
    }
    expect(result.output).toContain('subscriptionIncluded (subscriptionCLI)');
    expect(result.output).toContain('validation    PASS');
    expect(result.output).toContain('resolved from discoveryStore');

    // THE DRIVER, ITS EXECUTABLE AND WHAT IT CANNOT ENFORCE.
    expect(result.output).toContain('driver.claude-cli.workspace');
    expect(result.output).toContain(path.join(fakeBin, 'claude'));
    expect(result.output).toContain('stdin         the case instruction (never argv)');
    expect(result.output).toContain('NOT ENFORCED');

    // WHAT CAN AND CANNOT BE SAID ABOUT MONEY BEFOREHAND.
    expect(result.output).toContain('a TRUE zero');
    expect(result.output).toContain('NOT ESTIMABLE — and not zero');
    expect(result.output).toContain('no prior run — no estimate');

    // WHERE EVERY RECORD WOULD GO, and that nothing was made there.
    expect(result.output).toContain(path.join(campaigns, 'workspace'));
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);

    // AND THE POINT OF ALL OF IT: not one model request. The session preflight's credential read
    // is the only process this command is allowed to start before it has printed a plan.
    expectNoModelRequest();
    expect(invocations()).toEqual(['auth status --json']);
  }, 120_000);

  it('reports a model this machine has never proven as refused, and still plans the rest', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5,claude-opus-5', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/runnable\s+12/);
    expect(result.output).toMatch(/refused\s+12/);
    expect(result.output).toContain('REFUSED       unprovenRoute');
    expectNoModelRequest();
  }, 120_000);

  it('says when the operator changed the sample count rather than the pack', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--repeats', '1', '--max-attempts', '1', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain('repeats         1 per case (set by the operator');
    // A REAL override, so it is named as one and the pack's own number is printed beside it.
    expect(result.output).toContain('OVERRIDING the sealed pack, which asks for 3');
    expect(result.output).toContain('1 models x 4 cases x 1 repeats = 4 independent runs');
    // An operator cap narrows what a case allows, and the preview says whose ceiling it is.
    expect(result.output).toContain('(operator cap; the case allows 2)');
    expect(result.output).toMatch(/max attempts\s+4/);
  }, 120_000);

  it('does NOT call it an override when the operator names the pack\'s own number', () => {
    proveLineup(['claude-haiku-4-5']);
    // The foundation pack's own `repeatsPerCase` is 3, and the operator asked for 3. Nothing was
    // changed, so the preview must not say the pack wanted something different — which is what it
    // used to say, for every operator who passed the number they had read off the pack.
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--repeats', '3', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain('the same number the pack asks for (3)');
    expect(result.output).toContain('this is not an override');
    expect(result.output).not.toContain('OVERRIDING');
    expect(result.output).not.toContain('different number');
  }, 120_000);

  it('asks the CLI about its session without anything that could carry a prompt', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.status).toBe(0);
    // The probe ran, it is the frozen one, and it is the ONLY process this dry run started.
    expect(invocations()).toEqual(['auth status --json']);
    expect(result.output).toContain('session probe   claude auth status --json');
    // And it refuses to claim a remaining allowance the tool does not report.
    expect(result.output).toContain('allowance     NOT KNOWN');
    expect(result.output).toContain('no remaining-allowance figure');
    expectNoModelRequest();
  }, 120_000);
});

describe('the discriminator pack previews as 72 runs and sends nothing', () => {
  const DISCRIMINATOR = discriminatorOnePack.id;

  it('prints the pack, every case, the untiered structure, the recovery design and the two counts', () => {
    proveLineup(CLAUDE_LINEUP.split(','));
    const result = cernum('workspace-benchmark', DISCRIMINATOR, '--provider', 'claudeCLI',
      '--models', CLAUDE_LINEUP, '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`${DISCRIMINATOR}@1`);
    expect(result.output).toContain(workspacePackDigest(discriminatorOnePack, allWorkspaceCases()));
    for (const workspaceCase of resolveWorkspacePack(discriminatorOnePack, allWorkspaceCases())) {
      expect(result.output).toContain(`${workspaceCase.id}@${workspaceCase.version}`);
      expect(result.output).toContain(workspaceCaseDigest(workspaceCase));
      expect(result.output).toContain(workspaceCase.source.expectedTreeDigest!);
    }
    // SIX CASES, THREE REPEATS, FOUR MODELS: 72 runs. Four one-attempt cases and two two-attempt
    // cases: 4 x 3 x 8 = 96 attempts at most — which the plan summed from the sealed cases.
    expect(result.output).toContain('4 models x 6 cases x 3 repeats = 72 independent runs');
    expect(result.output).toMatch(/runnable\s+72/);
    expect(result.output).toMatch(/max attempts\s+96/);
    expect(result.output).toContain('recovery design 2 case(s) allow a retry: 24 runnable run(s)');
    // NO TIER, AND WHY. Structure is described, not banded.
    expect(result.output).toContain('NO TIER — empirical discriminator family');
    expect(result.output).toContain('structure dig.  cwx1:');
    expect(result.output).toContain('declared intent, not evidence');
    // THE SAFETY LINES AN OPERATOR NEEDS BEFORE SEVENTY-TWO RUNS.
    expect(result.output).toContain('throttle guard  ARMED');
    expect(result.output).toContain('allowance     NOT KNOWN');
    expect(result.output).toContain('a TRUE zero');
    // NOT ONE MODEL REQUEST. The session credential read is the only process it started.
    expectNoModelRequest();
    expect(invocations()).toEqual(['auth status --json']);
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);
  }, 120_000);

  it('accepts a pack named the way the refusal message lists it, as id@version', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', `${DISCRIMINATOR}@1`, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain('1 models x 6 cases x 3 repeats = 18 independent runs');
    expectNoModelRequest();
  }, 120_000);

  it('refuses a version this build does not carry, and says both spellings are accepted', () => {
    const result = cernum('workspace-benchmark', `${DISCRIMINATOR}@9`, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('is not a benchmark pack this build knows');
    expect(result.output).toContain('name one by id, or by id@version');
    expect(result.output).toContain(`${DISCRIMINATOR}@1`);
    expect(invocations()).toEqual([]);
  }, 120_000);
});

describe('the refusals that make a forty-eight-run command safe to type', () => {
  it('prints help without planning or running anything', () => {
    const result = cernum('workspace-benchmark', '--help');
    expect(result.status).toBe(0);
    expect(result.output).toContain('SENDS REAL REQUESTS');
    expect(result.output).toContain('A REPEAT IS NOT A RETRY');
    expect(result.output).toContain('--repeats');
    expect(result.output).toContain('--max-attempts');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('appears in the command index with its effect class', () => {
    const result = cernum('help');
    expect(result.output).toContain('workspace-benchmark');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses an unknown option rather than ignoring it', () => {
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--repaets', '3', '--dry-run');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('repaets');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a pack it does not know, and names the ones it does', () => {
    const result = cernum('workspace-benchmark', 'pack.not.here', '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('is not a benchmark pack this build knows');
    expect(result.output).toContain(PACK);
  }, 120_000);

  it('refuses to guess a provider or a lineup', () => {
    const noProvider = cernum('workspace-benchmark', PACK, '--models', 'claude-haiku-4-5', '--dry-run');
    expect(noProvider.status).not.toBe(0);
    expect(noProvider.output).toContain('--provider is required');

    const noModels = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI', '--dry-run');
    expect(noModels.status).not.toBe(0);
    expect(noModels.output).toContain('--models is required');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a live matrix without --yes, having sent nothing', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI', '--models', 'claude-haiku-4-5');
    expect(result.status).toBe(3);
    expect(result.output).toContain('Re-run with --yes');
    expect(result.output).toContain('12 run(s)');
    // The disclosure was printed, and the matrix was not run.
    expect(result.output).toContain('About to hand models a repository');
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);
    expectNoModelRequest();
  }, 120_000);

  it('refuses a matrix in which every cell was refused, rather than running an empty one', () => {
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-nothing-proved-this', '--yes');
    expect(result.status).toBe(6);
    expect(result.output).toContain('every cell of this matrix was refused');
    expectNoModelRequest();
  }, 120_000);
});
