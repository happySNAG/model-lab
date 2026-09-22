// Cernum · v0.2.3 — asking a question must never cost money.
//
// THE INCIDENT THIS FILE PINS. On a MacBook Pro, `cernum smoke --help` did not print help. It sent
// six live requests to Claude and spent roughly $0.127 of subscription allowance at list value. No
// evidence was saved and no proof state was recorded, so the spend bought nothing at all. Three
// ordinary decisions in one argument parser combined to do it:
//
//   1. `--help` was honoured only in the COMMAND position, never as a flag on a subcommand.
//   2. `smoke` defaulted to a live provider and the whole ladder when it saw no positional argument
//      — and `--help` produces no positionals.
//   3. Unknown options were accepted and silently ignored, so nothing could refuse what it did not
//      understand.
//
// Every test here spawns the REAL command as a subprocess. An in-process call would prove that a
// function returns early; what has to be proved is that a person typing this at a prompt is not
// charged, and that is a property of the whole program including its dispatch.
//
// NOTHING HERE SENDS A PROVIDER REQUEST. The assertions are that zero requests happen, so a test
// that accidentally sent one would be the failure it is looking for.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_SPECS, acceptedOptions, commandSpec, spendingCommands } from '../../src/cli/command-spec';

const root = path.resolve(__dirname, '..', '..');
let campaigns: string;
let fakeBin: string;

/**
 * A `claude` that RECORDS every invocation instead of answering one.
 *
 * The point of the whole suite: if any command below reaches a provider, this file gets a line, and
 * the assertion `invocations()` is empty fails. A stub that merely returned a canned answer would
 * hide exactly the bug being tested.
 */
function installRecordingCLI(name: string): void {
  const log = path.join(fakeBin, `${name}.invocations`);
  fs.writeFileSync(path.join(fakeBin, name), [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fixture)"; exit 0; fi',
    `if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi`,
    'cat > /dev/null',
    `printf '{"result":"THIS SHOULD NEVER BE REACHED","modelUsage":{},"usage":{},"is_error":false}\\n'`,
    '',
  ].join('\n'), { mode: 0o755 });
}

function invocations(name: string): string[] {
  const log = path.join(fakeBin, `${name}.invocations`);
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

const NODE_DIRECTORY = path.dirname(process.execPath);

function cernum(...args: string[]) {
  const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
    cwd: root, encoding: 'utf8',
    // The fake CLIs come FIRST so a provider call would find them rather than a real tool.
    env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin` },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeEach(() => {
  campaigns = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-cli-safety-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-cli-bin-'));
  installRecordingCLI('claude');
  installRecordingCLI('codex');
  installRecordingCLI('opencode');
});
afterEach(() => {
  fs.rmSync(campaigns, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

describe('v0.2.3 · `smoke --help` prints help and sends nothing', () => {
  it('answers --help without sending a single request', () => {
    const result = cernum('smoke', '--help');

    expect(result.status).toBe(0);
    expect(result.output).toContain('prove a model by asking it once');
    // THE WHOLE INCIDENT, IN ONE ASSERTION.
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('answers -h the same way — a single dash is an option, not a positional', () => {
    const result = cernum('smoke', '-h');

    expect(result.status).toBe(0);
    expect(result.output).toContain('SENDS REAL REQUESTS');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('says in its own help what the old default was, so the incident is documented where it happened', () => {
    expect(cernum('smoke', '--help').output).toContain('sent six live requests');
  }, 120_000);

  it('prints help for every command without running any of them', () => {
    for (const spec of COMMAND_SPECS) {
      const result = cernum(spec.name, '--help');
      expect(result.status, `${spec.name} --help should exit 0`).toBe(0);
      if (spec.name === 'help') {
        // `help --help` is the one that prints the GENERAL help rather than a page about itself,
        // which is what a person typing it means. It still must not run anything.
        expect(result.output).toContain('benchmark engine');
        continue;
      }
      expect(result.output, `${spec.name} --help should describe itself`).toContain(spec.summary);
      expect(result.output, `${spec.name} --help should say what it costs`).toMatch(/Reads local state|Writes files|read-only subcommands|SENDS REAL REQUESTS/);
    }
    expect(invocations('claude')).toEqual([]);
    expect(invocations('codex')).toEqual([]);
    expect(invocations('opencode')).toEqual([]);
  }, 600_000);
});

describe('v0.2.3 · a missing or wrong provider refuses instead of defaulting', () => {
  it('refuses with no provider, and names no default', () => {
    const result = cernum('smoke');

    expect(result.status).toBe(2);
    expect(result.output).toContain('no provider named');
    expect(result.output).toContain('this command has no default');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('refuses an unknown provider', () => {
    const result = cernum('smoke', 'notAProvider', '--all-ladder');

    expect(result.status).toBe(2);
    expect(result.output).toContain('cannot be smoke tested');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('refuses a provider with no candidate scope, even a real one', () => {
    // Naming claudeCLI is not consent to six requests. The scope is a second, separate decision.
    const result = cernum('smoke', 'claudeCLI');

    expect(result.status).toBe(2);
    expect(result.output).toContain('no candidate scope given');
    expect(result.output).toContain('--all-ladder');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('refuses a model that is not on the ladder rather than inventing an identifier', () => {
    const result = cernum('smoke', 'claudeCLI', '--models', 'claude-imaginary-9');

    expect(result.status).toBe(2);
    expect(result.output).toContain('never invents an identifier');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('refuses more than one provider at a time', () => {
    const result = cernum('smoke', 'claudeCLI', 'codexCLI', '--all-ladder');
    expect(result.status).toBe(2);
    expect(invocations('claude')).toEqual([]);
  }, 120_000);
});

describe('v0.2.3 · unknown options stop the program', () => {
  it('refuses a misspelled option with a nonzero exit, and runs nothing', () => {
    const result = cernum('smoke', 'claudeCLI', '--modles', 'claude-haiku-4-5');

    expect(result.status).toBe(2);
    expect(result.output).toContain('unknown option --modles');
    expect(result.output).toContain('nothing was run');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('lists what it WOULD have accepted, so the fix is in the error', () => {
    const result = cernum('smoke', 'claudeCLI', '--nope');
    expect(result.output).toContain('--all-ladder');
    expect(result.output).toContain('--dry-run');
  }, 120_000);

  it('refuses an unknown option on a read-only command too', () => {
    const result = cernum('providers', '--verbose');
    expect(result.status).toBe(2);
    expect(result.output).toContain('unknown option');
  }, 120_000);

  it('refuses an unknown COMMAND', () => {
    const result = cernum('smok', '--help');
    expect(result.status).toBe(1);
    expect(result.output).toContain("unknown command 'smok'");
  }, 120_000);
});

describe('v0.2.3 · --dry-run shows the requests and sends none', () => {
  it('lists every request the whole Claude ladder would send, and sends zero', () => {
    const result = cernum('smoke', 'claudeCLI', '--all-ladder', '--dry-run');

    expect(result.status).toBe(0);
    expect(result.output).toContain('DRY RUN');
    // The six requests the incident actually paid for, named before any are sent.
    expect(result.output).toContain('requests to be sent   6');
    expect(result.output).toContain('claude-haiku-4-5');
    expect(result.output).toContain('No request was sent');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('states the authorization class before anything could be spent', () => {
    const result = cernum('smoke', 'claudeCLI', '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.output).toContain('subscriptionIncluded');
    expect(result.output).toContain('Not free');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('narrows to exactly the models named, so a scope is a scope', () => {
    const result = cernum('smoke', 'claudeCLI', '--models', 'claude-haiku-4-5', '--dry-run');
    expect(result.output).toContain('requests to be sent   1');
    expect(result.output).not.toContain('claude-opus-5');
    expect(invocations('claude')).toEqual([]);
  }, 120_000);

  it('dry-runs discovery without running the tool', () => {
    const result = cernum('discover', 'opencodeCLI', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.output).toContain('DRY RUN');
    expect(invocations('opencode')).toEqual([]);
  }, 120_000);
});

describe('v0.2.3 · the command table is the contract', () => {
  it('declares an effect class for every command, and marks the spenders', () => {
    // `workspace` joined this list in the workspace-entry-point pass, and `workspace-benchmark` in the
    // benchmark-pack pass. Both belong here for exactly the reason the other three do: they send real
    // requests to a model. The list is asserted rather than derived so that a command gaining a
    // spending effect is a deliberate edit to a test — and `workspace-benchmark` is the one that most
    // needed the deliberation, because one careless invocation of it is forty-eight runs rather than one.
    // Pass D added the development runner's two spenders; both are gated by --dry-run and --yes.
    expect(spendingCommands().sort()).toEqual([
      'develop', 'develop-resume', 'resume', 'run', 'smoke', 'workspace', 'workspace-benchmark',
    ]);
  });

  it('gives every command --help, so none can be built without one', () => {
    for (const spec of COMMAND_SPECS) {
      expect(acceptedOptions(spec).map((option) => option.name), spec.name).toContain('help');
    }
  });

  it('offers --dry-run on every command that spends', () => {
    // A command that can spend money must have a way to show what it would spend it on.
    for (const name of spendingCommands()) {
      expect(commandSpec(name)!.supportsDryRun, name).toBe(true);
    }
  });

  it('names no option twice within a command', () => {
    for (const spec of COMMAND_SPECS) {
      const names = acceptedOptions(spec).map((option) => option.name);
      expect(new Set(names).size, spec.name).toBe(names.length);
    }
  });
});
