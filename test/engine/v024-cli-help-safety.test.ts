// Cernum · v0.2.4 — every way of asking a question, and none of them costs anything.
//
// WHAT v0.2.3 FIXED AND WHAT IT LEFT. v0.2.3 made `cernum smoke --help` print help instead of
// sending six live requests. It did not touch `cernum help smoke`, which parsed the topic into the
// positional list and then called a function that took no arguments — so the most-typed spelling of
// "tell me about this command" printed the general index, in which `smoke` had a two-line entry
// naming `--evidence` and nothing else. --models, --dry-run and --all-ladder were all implemented at
// the time and none of them appeared. A person looking for the safe way to preview a spending
// command was shown the least informative page the program has, which is how somebody ends up
// typing the command to find out what it does.
//
// EVERY TEST SPAWNS THE REAL COMMAND AS A SUBPROCESS, with fake `claude`, `codex` and `opencode`
// executables FIRST on PATH that record every invocation. The assertions are that the recordings
// stay empty: a test that accidentally sent a request would be the failure it is looking for.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_SPECS, acceptedOptions } from '../../src/cli/command-spec';

const root = path.resolve(__dirname, '..', '..');
let campaigns: string;
let fakeBin: string;

function installRecordingCLI(name: string): void {
  const log = path.join(fakeBin, `${name}.invocations`);
  fs.writeFileSync(path.join(fakeBin, name), [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fixture)"; exit 0; fi',
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

function nothingWasSent(): void {
  expect(invocations('claude')).toEqual([]);
  expect(invocations('codex')).toEqual([]);
  expect(invocations('opencode')).toEqual([]);
}

const NODE_DIRECTORY = path.dirname(process.execPath);

function cernum(...args: string[]) {
  const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin` },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeEach(() => {
  campaigns = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-v024-help-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-v024-bin-'));
  installRecordingCLI('claude');
  installRecordingCLI('codex');
  installRecordingCLI('opencode');
});
afterEach(() => {
  fs.rmSync(campaigns, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

describe('v0.2.4 · `cernum help smoke` answers about SMOKE', () => {
  it('prints the smoke page, not the general index', () => {
    const result = cernum('help', 'smoke');

    expect(result.status).toBe(0);
    expect(result.output).toContain('cernum smoke <provider>');
    expect(result.output).toContain('SENDS REAL REQUESTS TO A MODEL');
    nothingWasSent();
  }, 120_000);

  it('documents the provider, the scope flags and the preview — the ones it used to omit', () => {
    const output = cernum('help', 'smoke').output;

    expect(output).toContain('--models');
    expect(output).toContain('--all-ladder');
    expect(output).toContain('--dry-run');
    expect(output).toContain('--max-attempts');
    expect(output).toContain('one of the providers Cernum can execute');
    nothingWasSent();
  }, 120_000);

  it('documents metered authorization, including the unpriced acknowledgement', () => {
    const output = cernum('help', 'smoke').output;

    expect(output).toContain('--authorize-metered');
    expect(output).toContain('--authorize-unpriced-metered');
    expect(output).toContain('--pricing');
    expect(output).toContain('MAY BILL YOU AN AMOUNT CERNUM CANNOT STATE');
    expect(output).toContain('EXACTLY ONE request');
    nothingWasSent();
  }, 120_000);

  it('documents telemetry and identity admission', () => {
    const output = cernum('help', 'smoke').output;

    expect(output).toContain('--otlp-observer');
    expect(output).toContain('codexCLI only');
    expect(output).toContain('requestAcceptedIdentityUnverifiable');
    expect(output).toContain('--admit-identity-unverifiable');
    nothingWasSent();
  }, 120_000);

  it('is byte-for-byte the page `smoke --help` prints, so the two spellings cannot drift', () => {
    const viaTopic = cernum('help', 'smoke').stdout;
    const viaFlag = cernum('smoke', '--help').stdout;
    expect(viaTopic).toBe(viaFlag);
    nothingWasSent();
  }, 240_000);
});

describe('v0.2.4 · every help path, for every command, sends nothing', () => {
  it('answers `help <command>` for every command in the table', () => {
    for (const spec of COMMAND_SPECS) {
      const result = cernum('help', spec.name);
      expect(result.status, `help ${spec.name} should exit 0`).toBe(0);
      if (spec.name === 'help') {
        // `help help` prints the general index, which is what a person typing it means.
        expect(result.output).toContain('benchmark engine');
        continue;
      }
      expect(result.output, `help ${spec.name} should describe itself`).toContain(spec.summary);
    }
    nothingWasSent();
  }, 900_000);

  it('answers -h on smoke, and prints the same page', () => {
    const viaShort = cernum('smoke', '-h').stdout;
    const viaLong = cernum('smoke', '--help').stdout;
    expect(viaShort).toBe(viaLong);
    expect(viaShort).toContain('--authorize-metered');
    nothingWasSent();
  }, 240_000);

  it('answers bare `help` with the index, which points at the per-command pages', () => {
    const output = cernum('help').output;
    expect(output).toContain('benchmark engine');
    expect(output).toContain('cernum help smoke');
    expect(output).toContain('help <command>');
    nothingWasSent();
  }, 120_000);

  it('refuses a topic that is not a command, rather than printing the index and hoping', () => {
    const result = cernum('help', 'smok');
    expect(result.status).toBe(2);
    expect(result.output).toContain("no command named 'smok'");
    expect(result.output).toContain('Nothing was run');
    nothingWasSent();
  }, 120_000);

  it('refuses two topics at once', () => {
    const result = cernum('help', 'smoke', 'run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('one topic at a time');
    nothingWasSent();
  }, 120_000);
});

describe('v0.2.4 · an option this build cannot read stops the program', () => {
  it('refuses an unknown option even when --help is also present', () => {
    // Printing help would be safe and would also be an answer to a question nobody asked: the flag
    // it could not read may be the one carrying the scope or the ceiling.
    const result = cernum('smoke', 'claudeCLI', '--help', '--modles', 'claude-haiku-4-5');
    expect(result.status).toBe(2);
    expect(result.output).toContain('unknown option --modles');
    nothingWasSent();
  }, 120_000);

  it('refuses a value-taking option given no value', () => {
    const result = cernum('smoke', 'claudeCLI', '--models', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('--models needs a value');
    expect(result.output).toContain('nothing was run');
    nothingWasSent();
  }, 120_000);

  it('refuses a bare flag given a value', () => {
    const result = cernum('smoke', 'claudeCLI', '--all-ladder=please', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('takes no value');
    nothingWasSent();
  }, 120_000);

  it('refuses a count that is not a count, instead of silently not applying it', () => {
    // `Number('banana')` is NaN, `NaN > 0` is false, and the cap silently did not apply — on the one
    // command whose reason for having a cap is to keep a spending run small.
    const result = cernum('smoke', 'claudeCLI', '--all-ladder', '--max-attempts', 'banana', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('--max-attempts');
    expect(result.output).toContain('whole number');
    nothingWasSent();
  }, 120_000);

  it('refuses a ceiling that is not an amount', () => {
    const result = cernum('smoke', 'opencodeCLI', '--models', 'opencode/union-alpha',
      '--authorize-metered', 'lots', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('--authorize-metered');
    nothingWasSent();
  }, 120_000);

  it('refuses an empty value', () => {
    const result = cernum('smoke', 'claudeCLI', '--models=', '--dry-run');
    expect(result.status).toBe(2);
    expect(result.output).toContain('empty value');
    nothingWasSent();
  }, 120_000);
});

describe('v0.2.4 · the table still is the contract', () => {
  it('declares --help on every command, including the ones added this pass', () => {
    for (const spec of COMMAND_SPECS) {
      expect(acceptedOptions(spec).map((option) => option.name), spec.name).toContain('help');
    }
  });

  it('declares every option `smoke` actually reads', () => {
    const declared = acceptedOptions(COMMAND_SPECS.find((spec) => spec.name === 'smoke')!)
      .map((option) => option.name);
    for (const name of ['models', 'all-ladder', 'max-attempts', 'evidence', 'pricing',
      'authorize-metered', 'authorize-unpriced-metered', 'otlp-observer', 'dry-run', 'root']) {
      expect(declared, name).toContain(name);
    }
  });
});
