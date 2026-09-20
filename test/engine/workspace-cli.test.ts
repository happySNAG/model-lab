// `cernum workspace` — the supported entry point, and the refusals that make it safe to type.
//
// WHY THIS COMMAND EXISTS. The first live workspace execution was driven by a scratchpad TypeScript
// file. It proved the architecture; it proved nothing repeatable. The binding it ran was one the
// engine's own validator refused, no manifest was frozen, no ledger row was written, and the only
// account of what happened was console output. Every one of those is a property of the ENTRY POINT.
//
// EVERY TEST HERE SPAWNS THE REAL COMMAND, for the reason `cli-argument-safety.test.ts` does: what
// has to be proved is that a person typing this at a prompt gets what the help says, and that is a
// property of the whole program including its dispatch. A fake `claude` is installed first on PATH
// and RECORDS its invocations, so a test that accidentally reached a provider fails on the
// assertion that it did not.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { workspaceCaseDigest } from '../../src/engine/workspace-case';
import { discoveryStorePath } from '../../src/engine/discovery-store';
import { provenModel } from './frontier-harness';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const NODE_DIRECTORY = path.dirname(process.execPath);

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

/** The discovery store a proven route lives in. Written by hand here; no provider was contacted. */
function proveHaiku(): void {
  const file = discoveryStorePath(campaigns);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    writtenAt: new Date().toISOString(),
    models: [{ ...provenModel('claudeCLI', 'claude-haiku-4-5'), discoveredAt: new Date().toISOString() }],
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
  campaigns = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-cli-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-bin-'));
  installRecordingCLI();
});
afterEach(() => {
  fs.rmSync(campaigns, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

describe('the dry run shows everything and does none of it', () => {
  it('prints the case, the fixture, the route, the driver and where the record would go', () => {
    proveHaiku();
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--max-attempts', '1', '--dry-run');
    expect(result.status).toBe(0);

    // THE CASE, EXACTLY. Its version, its sealed digest and its comparability key.
    expect(result.output).toContain('ws.broken-sum.mean@3');
    expect(result.output).toContain(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(result.output).toContain('cwk1:');
    expect(result.output).toContain(BROKEN_SUM_MEAN.source.expectedTreeDigest!);

    // THE ROUTE AND ITS BILLING BASIS, before a person can be surprised by either.
    expect(result.output).toContain('claude-haiku-4-5');
    expect(result.output).toContain('subscriptionIncluded');
    expect(result.output).toMatch(/marginal API charge \$0/);

    // THE BINDING PASSES VALIDATION — the defect this whole pass exists to close.
    expect(result.output).toContain('validation      PASS');
    expect(result.output).not.toContain('REFUSED');

    // PRE-RUN IDENTITY, RESOLVED BEFORE THE REQUEST, and labelled as being about the past.
    expect(result.output).toMatch(/pre-run identity\s+verified as claude-haiku-4-5/);
    expect(result.output).toContain('resolved from the discovery store');
    expect(result.output).toContain('What the request itself establishes is recorded');

    // THE DRIVER, ITS EXECUTABLE, THE VERSION ITS FLAGS WERE READ FROM, AND THE EXACT ARGV.
    expect(result.output).toContain('driver.claude-cli.workspace');
    expect(result.output).toContain(path.join(fakeBin, 'claude'));
    expect(result.output).toContain('flags verified  against 2.1.278');
    expect(result.output).toContain('--permission-mode dontAsk');
    expect(result.output).toContain('--restricted');
    expect(result.output).toContain('stdin           the case instruction (never argv)');
    expect(result.output).toContain('Read, Glob, Grep, Write, Edit, Bash');

    // THE ENVIRONMENT, NAMED, AND WHETHER EACH NAME IS ACTUALLY SET ON THIS MACHINE.
    expect(result.output).toContain('allow-list HOME, USER');
    expect(result.output).toMatch(/HOME\s+disclosed to the child/);

    // WHAT IS NOT ENFORCEABLE, said plainly rather than left for somebody to assume.
    expect(result.output).toContain('NOT ENFORCED');
    expect(result.output).toMatch(/does not\s+confine Bash/);
    expect(result.output).toMatch(/documents no network switch/);

    // THE CHECKS THIS ENGINE WILL RUN ITSELF, the deadline, and the ceiling the operator asked for.
    expect(result.output).toContain('node test/stats.test.js');
    expect(result.output).toContain('600000 ms per attempt');
    expect(result.output).toContain('1 (operator cap; the case allows 2)');
    expect(result.output).toContain('invariant        src/stats.js');

    // WHERE THE EVIDENCE WOULD GO.
    expect(result.output).toContain(path.join(campaigns, 'workspace'));
    expect(result.output).toContain('manifest.json');
    expect(result.output).toContain('ledger');

    // AND NONE OF IT HAPPENED.
    expect(result.output).toContain('No request was sent, no manifest was frozen and no directory was made.');
    expect(invocations()).toEqual([]);
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);
  }, 120_000);

  it('sends nothing and writes nothing even when the route is proven and everything is valid', () => {
    proveHaiku();
    cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI', '--model', 'claude-haiku-4-5', '--dry-run');
    expect(invocations()).toEqual([]);
    expect(fs.readdirSync(campaigns).filter((entry) => entry !== '.providers')).toEqual([]);
  }, 120_000);
});

describe('the refusals, each of which happens before anything is sent', () => {
  it('refuses a provider with no WORKSPACE driver, rather than falling through to prose execution', () => {
    proveHaiku();
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'codexCLI',
      '--model', 'gpt-6-astra', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('workspace driver unavailable');
    expect(result.output).toContain('claudeCLI');
    // The reason, not just the refusal: an answer about describing a fix is not an answer about making one.
    expect(result.output).toMatch(/does not fall back to prose execution/);
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a case this build does not know, and names the ones it does', () => {
    const result = cernum('workspace', 'ws.not.a.case', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('is not a workspace case this build knows');
    expect(result.output).toContain('ws.broken-sum.mean@3');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a route nothing has proven, and says what would prove it', () => {
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-opus-5', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('unprovenRoute');
    expect(result.output).toContain('identity smoke test');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('requires both halves of the route to be named, with no default for either', () => {
    expect(cernum('workspace', 'ws.broken-sum.mean', '--dry-run').output).toContain('--provider is required');
    expect(cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI', '--dry-run').output)
      .toContain('--model is required');
    expect(cernum('workspace', '--dry-run').output).toContain('no workspace case named');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('parses the attempt ceiling strictly, and refuses a value that is not one', () => {
    proveHaiku();
    const bad = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--max-attempts', 'two', '--dry-run');
    expect(bad.status).toBe(2);
    expect(bad.output).toContain('--max-attempts');
    expect(bad.output).toContain('nothing was run');

    // A ceiling ABOVE the case's own is narrowed to the case's, never raised past it.
    const high = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--max-attempts', '9', '--dry-run');
    expect(high.status).toBe(0);
    expect(high.output).toContain('2 (operator cap; the case allows 2)');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses an unknown option rather than ignoring it', () => {
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--modles', 'x', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('unknown option');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('refuses a sandbox inside a Git working tree, in the DRY RUN as well as the live one', () => {
    proveHaiku();
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--sandbox', repositoryRoot, '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('Git working tree');
    expect(invocations()).toEqual([]);
  }, 120_000);

  it('will not run live without --yes, and sends nothing while refusing', () => {
    proveHaiku();
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--max-attempts', '1');
    expect(result.status).toBe(3);
    expect(result.output).toContain('Nothing was run.');
    expect(invocations()).toEqual([]);
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);
  }, 120_000);

  it('answers --help without sending anything, whatever else is on the line', () => {
    const result = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'claudeCLI',
      '--model', 'claude-haiku-4-5', '--help');
    expect(result.status).toBe(0);
    expect(result.output).toContain('SENDS REAL REQUESTS TO A MODEL');
    expect(result.output).toContain('--dry-run');
    expect(invocations()).toEqual([]);
  }, 120_000);
});
