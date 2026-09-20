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
import { allWorkspaceCases, foundationFourPack } from '../../src/engine/workspace-catalog';
import { workspacePackDigest } from '../../src/engine/workspace-pack';
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

    // EVERY CASE, WITH ITS OWN DIGEST AND ITS OWN FIXTURE SEAL.
    for (const workspaceCase of allWorkspaceCases()) {
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

    // AND THE POINT OF ALL OF IT: not one request.
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('reports a model this machine has never proven as refused, and still plans the rest', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5,claude-opus-5', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/runnable\s+12/);
    expect(result.output).toMatch(/refused\s+12/);
    expect(result.output).toContain('REFUSED       unprovenRoute');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('says when the operator changed the sample count rather than the pack', () => {
    proveLineup(['claude-haiku-4-5']);
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-haiku-4-5', '--repeats', '1', '--max-attempts', '1', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain('repeats         1 per case (set by the operator');
    expect(result.output).toContain('1 models x 4 cases x 1 repeats = 4 independent runs');
    // An operator cap narrows what a case allows, and the preview says whose ceiling it is.
    expect(result.output).toContain('(operator cap; the case allows 2)');
    expect(result.output).toMatch(/max attempts\s+4/);
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
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a matrix in which every cell was refused, rather than running an empty one', () => {
    const result = cernum('workspace-benchmark', PACK, '--provider', 'claudeCLI',
      '--models', 'claude-nothing-proved-this', '--yes');
    expect(result.status).toBe(6);
    expect(result.output).toContain('every cell of this matrix was refused');
    expect(invocations()).toEqual([]);
  }, 120_000);
});
