// The V1 execution policy, asserted by running REAL children under the Cernum Seatbelt profile.
//
// Every claim in `SEATBELT_PROFILE_GUARANTEES` is checked here against the kernel, not against the
// profile's text: a process under it cannot open a socket, cannot write outside the workspace and
// scratch, cannot read the home directory — and CAN read a workspace that lives under the home
// directory, because the later allow wins. Nothing here reaches a network: the network test proves
// the connection is refused before it could leave. macOS only, as the sandbox is.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCLI } from '../../src/engine/cli-process';
import {
  EXECUTION_POLICY_RULE, EXECUTION_SANDBOX_UNAVAILABLE, SEATBELT_PROFILE_VERSION, probeExecutionSandbox,
  seatbeltProfile, seatbeltProfileDigest,
} from '../../src/engine/execution-sandbox';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { ScriptedWorkspaceAgent } from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { scoreWorkspaceRun } from '../../src/engine/workspace-scoring';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const darwin = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const onDarwin = darwin ? describe : describe.skip;

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string, parent = os.tmpdir()): string {
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  temporaries.push(directory);
  return directory;
}

const node = process.execPath;
const environment = { PATH: `${path.dirname(node)}:/usr/bin:/bin` };

async function underProfile(workRoot: string, scratch: string, script: string) {
  const profile = seatbeltProfile({ writableRoots: [workRoot, scratch], homeDirectories: [os.homedir()],
    readableRoots: [path.dirname(node), path.dirname(path.dirname(node))] });
  return runCLI({ executable: node, args: ['-e', script], workingDirectory: workRoot, timeoutMilliseconds: 20_000,
    replaceEnvironment: environment, sandboxProfile: profile });
}

onDarwin('C · a sealed command on a model\'s tree runs under Seatbelt, and the profile holds against a real child', () => {
  it('denies every socket', async () => {
    const work = temporary('cernum-sb-work-');
    const result = await underProfile(work, temporary('cernum-sb-tmp-'),
      "require('net').connect(80,'1.1.1.1').on('error',e=>{console.log('refused',e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(3)})");
    expect(result.stdout).toContain('refused');
    expect(result.stdout).not.toContain('CONNECTED');
  });

  it('allows writes to the workspace and scratch, and refuses them anywhere else', async () => {
    const work = temporary('cernum-sb-work-');
    const scratch = temporary('cernum-sb-tmp-');
    const outside = temporary('cernum-sb-outside-');
    const result = await underProfile(work, scratch, [
      "const fs=require('fs');",
      `fs.writeFileSync(${JSON.stringify(path.join(work, 'ok.txt'))},'x');`,
      `fs.writeFileSync(${JSON.stringify(path.join(scratch, 'ok.txt'))},'x');`,
      `try{fs.writeFileSync(${JSON.stringify(path.join(outside, 'no.txt'))},'x');console.log('WROTE')}catch(e){console.log('denied',e.code)}`,
    ].join(''));
    expect(result.stdout).toContain('denied EPERM');
    expect(fs.existsSync(path.join(work, 'ok.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outside, 'no.txt'))).toBe(false);
  });

  it('makes the home directory unreadable, yet reads a workspace that lives under it', async () => {
    const underHome = temporary('.cernum-sb-probe-', os.homedir());
    const secret = path.join(temporary('.cernum-sb-secret-', os.homedir()), 'secret.txt');
    fs.writeFileSync(secret, 'not for the model');
    fs.writeFileSync(path.join(underHome, 'module.js'), 'module.exports = 42;');
    const result = await underProfile(underHome, temporary('cernum-sb-tmp-'), [
      "const fs=require('fs');",
      "console.log('workspace', require('./module.js'), process.cwd().length > 0);",
      `try{fs.readFileSync(${JSON.stringify(secret)});console.log('READ SECRET')}catch(e){console.log('home',e.code)}`,
    ].join(''));
    expect(result.stdout).toContain('workspace 42 true');
    expect(result.stdout).toContain('home EPERM');
    expect(result.stdout).not.toContain('READ SECRET');
  });

  it('keeps a missing verifier reading as notInstalled, exactly as it did unsandboxed', async () => {
    const work = temporary('cernum-sb-work-');
    const result = await runCLI({ executable: 'cernum-no-such-verifier', args: [], workingDirectory: work, timeoutMilliseconds: 5_000,
      replaceEnvironment: environment, sandboxProfile: seatbeltProfile({ writableRoots: [work], homeDirectories: [os.homedir()] }) });
    expect(result.failure?.kind).toBe('notInstalled');
  });

  it('runs every workspace verification command under the profile and records which one', async () => {
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN, driver: new ScriptedWorkspaceAgent([{ steps: [{ do: 'say', text: 'nothing' }] }]),
      fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-sb-ws-'),
      environmentSource: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
    });
    expect(result.executionSandbox).toMatchObject({ kind: 'macosSeatbelt', rule: EXECUTION_POLICY_RULE });
    const outcomes = [...result.attempts[0].baselineOutcomes, ...result.attempts[0].verificationOutcomes, ...result.attempts[0].hiddenOutcomes];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect(outcome.executionSandbox).toMatch(new RegExp(`^${SEATBELT_PROFILE_VERSION}:`));
  });
});

describe('the policy refuses rather than running unsandboxed', () => {
  it('refuses a run before any attempt when no OS sandbox is available, and spends nothing', async () => {
    let driverRan = false;
    const driver = new ScriptedWorkspaceAgent([{ steps: [{ do: 'say', text: 'x' }] }]);
    const original = driver.run.bind(driver);
    driver.run = async (request) => { driverRan = true; return original(request); };
    const result = await runWorkspaceCase({
      case: BROKEN_SUM_MEAN, driver, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary('cernum-sb-ws-'),
      executionSandbox: { kind: 'unavailable', detail: 'platform linux' },
    });
    expect(result.attempts).toHaveLength(0);
    expect(driverRan).toBe(false);
    expect(result.refusedBecause[0]).toContain(EXECUTION_SANDBOX_UNAVAILABLE.slice(0, 60));
    expect(scoreWorkspaceRun(BROKEN_SUM_MEAN, result).status).toBe('envelopeFailure');
  });

  it('establishes availability with a canary, and says unavailable off macOS', async () => {
    expect((await probeExecutionSandbox({ platform: 'linux' })).kind).toBe('unavailable');
    expect((await probeExecutionSandbox({ platform: 'darwin', exists: () => false })).kind).toBe('unavailable');
    const refusing = await probeExecutionSandbox({ platform: 'darwin', exists: () => true,
      run: async () => ({ stdout: '', stderr: 'denied', exitCode: 65, signal: null, elapsedMilliseconds: 1, failure: { kind: 'exitFailure', detail: 'exit 65' } }) });
    expect(refusing.kind).toBe('unavailable');
  });

  it('writes a profile that denies first and re-admits narrowly, and refuses one with no home to deny', () => {
    const profile = seatbeltProfile({ writableRoots: ['/private/var/folders/x/work'], homeDirectories: ['/Users/someone'] });
    const lines = profile.split('\n');
    expect(lines.indexOf('(deny network*)')).toBeGreaterThan(0);
    expect(lines.findIndex((line) => line.startsWith('(deny file-read*'))).toBeLessThan(lines.findIndex((line) => line.startsWith('(allow file-read*')));
    expect(profile).not.toContain('(allow network');
    expect(seatbeltProfileDigest(profile)).toMatch(/^cernum-seatbelt-1:[0-9a-f]{16}$/);
    expect(() => seatbeltProfile({ writableRoots: ['/w'], homeDirectories: [] })).toThrow(/home directory/);
  });
});
