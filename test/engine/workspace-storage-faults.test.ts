// STORAGE FAULTS AND TORN WRITES (IO-2 P3, G-24301 C2). A disconnected or full drive must produce a
// controlled failure, never a corrupt run, and an incomplete write must never be read as a result.
//
//   (a) a campaign or sandbox root removed before start is refused, naming the root; no driver call;
//   (b) a record root removed mid-run: one cell fault carrying the original ENOENT, every later cell
//       `storageUnavailable`, zero further driver calls — and a faulted-event write that fails too
//       cannot replace the cell's original error;
//   (c) an ENOSPC that writes half a row and then throws: the next append and a fresh load succeed, and
//       the half row is not a result;
//   (d) a failing atomic write leaves no .tmp file, and temporary names are unique in the same directory;
//   (e) a cell fault that is not a storage fault still lets every later cell run.
//
// FAKE DRIVERS AND AN INJECTED FS SEAM ONLY. No model, no provider, no process: the model is a scripted
// driver, every sealed command goes through an injected `runCommand`, and a full or failing disk is the
// `LedgerFileSystem` seam. Every directory is under os.tmpdir() and is removed in afterEach.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceRunOptions } from '../../src/engine/workspace-execution';
import { CLIResult } from '../../src/engine/cli-process';
import {
  Ledger, LedgerFileSystem, PlannableCatalog, atomicWriteJSON, repairTornTail, slotKey,
} from '../../src/engine/ledger';
import {
  WorkspaceMatrixError, WorkspaceMatrixRequest, WorkspaceMatrixRunOptions, buildWorkspaceMatrixPlan, runWorkspaceMatrix,
  storageFaultOf,
} from '../../src/engine/workspace-matrix';
import { CHANGES_NOTHING, DISCOVERY, RUN_OPTIONS, request } from './workspace-continuation-harness';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

/** An errno exactly as node:fs shapes one. `path` absent is how write(2) reports a full disk. */
function errno(code: string, message: string, at?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(at === undefined ? `${code}: ${message}` : `${code}: ${message}, '${at}'`),
    { code, syscall: at === undefined ? 'write' : 'open', ...(at === undefined ? {} : { path: at }) });
}

/** A sealed command that never starts a process. Verification fails, so every run seals as a failure. */
const FAKE_COMMANDS: WorkspaceRunOptions['runCommand'] = async () => {
  const result: CLIResult = { stdout: '', stderr: '', exitCode: 1, signal: null, elapsedMilliseconds: 1 };
  return result;
};

/** A scripted Claude stand-in. `calls` is the witness for "no further driver call". */
function scriptedClaude(calls: string[], during?: (call: number) => void): NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding) => {
    if (binding.provider !== 'claudeCLI') return undefined;
    const driver: WorkspaceAgentDriver = {
      driverID: 'driver.scripted.claude',
      provider: 'claudeCLI',
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(agentRequest: WorkspaceAgentRequest) {
        calls.push(`${binding.requestedModelID}|${agentRequest.caseID}`);
        during?.(calls.length);
        const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(agentRequest);
        return { ...result, reportedModelID: binding.requestedModelID };
      },
    };
    return driver;
  };
}

/** Two cases, three repeats, one Claude model: six cells, every one runnable. */
function matrixOf(roots: { campaignRoot: string; sandboxRoot?: string; fixtureRoot?: string }, calls: string[],
                  during?: (call: number) => void) {
  const matrix = request({
    campaignRoot: roots.campaignRoot,
    ...(roots.sandboxRoot === undefined ? {} : { sandboxRoot: roots.sandboxRoot }),
    ...(roots.fixtureRoot === undefined ? {} : { fixtureRoot: roots.fixtureRoot }),
    runLabel: 'storage-faults', provider: 'claudeCLI', effort: 'none', modelIDs: ['claude-haiku-4-5'],
    driverFactory: scriptedClaude(calls, during), discovery: DISCOVERY,
  });
  const plan = buildWorkspaceMatrixPlan(matrix);
  expect(plan.runnableRunCount).toBe(6);
  return { matrix, plan };
}

function runOptions(extra: Partial<WorkspaceMatrixRunOptions> = {}): WorkspaceMatrixRunOptions {
  return { ...RUN_OPTIONS, runCommand: FAKE_COMMANDS, ...extra };
}

// MARK: - (a)

describe('(a) a root that is missing before start is refused, and nothing is asked', () => {
  it('a removed campaign (record) root: storageRootUnavailable naming it, no driver call, nothing created', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot }, calls);
    fs.rmSync(campaignRoot, { recursive: true, force: true });

    const run = runWorkspaceMatrix(plan, matrix, runOptions());
    await expect(run).rejects.toBeInstanceOf(WorkspaceMatrixError);
    await expect(run).rejects.toMatchObject({ code: 'storageRootUnavailable' });
    await expect(run).rejects.toThrow(campaignRoot);
    await expect(run).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(campaignRoot)).toBe(false);
  });

  it('a removed sandbox root: refused naming the sandbox root, no driver call, nothing created', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    const sandboxRoot = temporary('cernum-storage-sandbox-');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot, sandboxRoot }, calls);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });

    const run = runWorkspaceMatrix(plan, matrix, runOptions());
    await expect(run).rejects.toMatchObject({ code: 'storageRootUnavailable' });
    await expect(run).rejects.toThrow(`sandbox root ${sandboxRoot}`);
    expect(calls).toEqual([]);
    expect(fs.existsSync(sandboxRoot)).toBe(false);
    expect(fs.readdirSync(campaignRoot)).toEqual([]);
  });

  it('a root that is a file, not a directory, is refused the same way', async () => {
    const holder = temporary('cernum-storage-holder-');
    const campaignRoot = path.join(holder, 'campaign-is-a-file');
    fs.writeFileSync(campaignRoot, 'not a directory\n');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot }, calls);
    await expect(runWorkspaceMatrix(plan, matrix, runOptions())).rejects.toMatchObject({ code: 'storageRootUnavailable' });
    expect(calls).toEqual([]);
  });

  it('a writable pair of roots passes, and the probe leaves nothing behind in either', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    const sandboxRoot = temporary('cernum-storage-sandbox-');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot, sandboxRoot }, calls);
    const result = await runWorkspaceMatrix(plan, matrix, runOptions());
    expect(result.executedRunCount).toBe(6);
    expect(result.storageFault).toBeUndefined();
    expect(calls).toHaveLength(6);
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
    expect(fs.readdirSync(campaignRoot).filter((name) => name.includes('probe'))).toEqual([]);
  }, 60_000);
});

// MARK: - (b)

describe('(b) a record root that fails mid-run stops the matrix', () => {
  it('removed during a run: that cell keeps the original ENOENT, the rest are storageUnavailable, no further call', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    const calls: string[] = [];
    // The drive goes away while the first run is in flight.
    const { matrix, plan } = matrixOf({ campaignRoot }, calls,
      (call) => { if (call === 1) fs.rmSync(campaignRoot, { recursive: true, force: true }); });
    const faults: unknown[] = [];
    const result = await runWorkspaceMatrix(plan, matrix, runOptions({ onStorageFault: (fault) => faults.push(fault) }));

    expect(calls).toHaveLength(1);
    expect(result.executedRunCount).toBe(0);
    expect(result.skipped).toHaveLength(6);
    const [first, ...rest] = result.skipped;
    expect(first.disposition).toBe('harnessFault');
    expect(first.cell.recordRoot).toBe(plan.cells[0].recordRoot);
    expect(first.reasons).toHaveLength(1);
    expect(first.reasons[0]).toMatch(/^ENOENT: /);
    expect(rest.map((entry) => entry.disposition)).toEqual(Array(5).fill('storageUnavailable'));
    for (const entry of rest) expect(entry.reasons[0]).toContain('ENOENT');
    expect(result.storageFault).toMatchObject({ code: 'ENOENT', detail: first.reasons[0], recordRoot: plan.cells[0].recordRoot });
    expect(result.storageFault?.path?.startsWith(campaignRoot)).toBe(true);
    expect(faults).toEqual([result.storageFault]);
    expect(result.notExecutedForOtherReasonCount).toBe(6);
  }, 60_000);

  it('removed between runs: the next cell meets the ENOENT before its driver exists, and nothing after it starts', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot }, calls);
    const result = await runWorkspaceMatrix(plan, matrix, runOptions({
      onCellFinished: () => fs.rmSync(campaignRoot, { recursive: true, force: true }),
    }));

    expect(calls).toHaveLength(1);
    expect(result.executedRunCount).toBe(1);
    expect(result.skipped[0].disposition).toBe('harnessFault');
    expect(result.skipped[0].reasons[0]).toMatch(/^ENOENT: /);
    expect(result.skipped.slice(1).map((entry) => entry.disposition)).toEqual(Array(4).fill('storageUnavailable'));
    expect(result.storageFault).toMatchObject({ code: 'ENOENT', recordRoot: plan.cells[1].recordRoot });
    // The root is NOT re-created on whatever now sits at that path.
    expect(fs.existsSync(campaignRoot)).toBe(false);
  }, 60_000);

  it('a faulted-event write that fails too cannot replace the original error, and still stops the matrix', async () => {
    const campaignRoot = temporary('cernum-storage-campaign-');
    // An empty fixture root: every run throws `fixtureMissing` out of the host — an ordinary, non-storage
    // fault — before any driver call.
    const fixtureRoot = temporary('cernum-storage-no-fixtures-');
    const calls: string[] = [];
    const { matrix, plan } = matrixOf({ campaignRoot, fixtureRoot }, calls);

    // The record disk starts failing with EIO once `workspaceRunStarted` is on disk: the next append to
    // events.jsonl is `workspaceRunFaulted` — the guarded one.
    const failing: LedgerFileSystem = {
      ...fs,
      openSync: ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(target).endsWith('events.jsonl') && flags === 'a' && fs.existsSync(target)
          && fs.readFileSync(target, 'utf8').includes('"workspaceRunStarted"')) {
          throw errno('EIO', 'i/o error, open', String(target));
        }
        return fs.openSync(target, flags, mode);
      }) as typeof fs.openSync,
    };
    const result = await runWorkspaceMatrix(plan, matrix, runOptions({ recordFileSystem: failing }));

    expect(calls).toEqual([]);
    const [first, ...rest] = result.skipped;
    expect(first.disposition).toBe('harnessFault');
    // THE ORIGINAL: the missing fixture, not the EIO of the event that tried to record it.
    expect(first.reasons).toHaveLength(1);
    expect(first.reasons[0]).toMatch(/names the fixture/);
    expect(first.reasons[0]).not.toMatch(/EIO/);
    // The second failure was on the record root, so the matrix stopped there.
    expect(result.storageFault).toMatchObject({ code: 'EIO', detail: first.reasons[0] });
    expect(rest.map((entry) => entry.disposition)).toEqual(Array(5).fill('storageUnavailable'));
  }, 60_000);

  it('only ENOENT, EIO, ENOSPC and EROFS on the record root (or naming no path) count as storage faults', () => {
    const root = '/volumes/records';
    for (const code of ['ENOENT', 'EIO', 'ENOSPC', 'EROFS']) {
      expect(storageFaultOf(errno(code, 'x', `${root}/workspace/r/ledger/results.jsonl`), [root])).toEqual({
        code, path: `${root}/workspace/r/ledger/results.jsonl` });
    }
    expect(storageFaultOf(errno('ENOSPC', 'no space left on device'), [root])).toEqual({ code: 'ENOSPC' });
    expect(storageFaultOf(errno('ENOENT', 'x', '/elsewhere/fixtures/case/src'), [root])).toBeUndefined();
    expect(storageFaultOf(errno('EACCES', 'x', `${root}/workspace/r/manifest.json`), [root])).toBeUndefined();
    expect(storageFaultOf(new Error('the model failed'), [root])).toBeUndefined();
    const wrapped = new Error('evidence write failed', { cause: errno('EROFS', 'read-only file system', `${root}/e`) });
    expect(storageFaultOf(wrapped, [root])).toEqual({ code: 'EROFS', path: `${root}/e` });
  });
});

// MARK: - (c)

const CATALOG: PlannableCatalog = {
  catalogDigest: 'test:storage-faults', caseCount: 2, repeatsPerCase: 1,
  suites: [{
    slug: 'suite', block: 'block', executionOrdinal: 0,
    cases: ['first', 'second'].map((caseID, executionOrdinal) => ({
      caseID, caseDigest: `digest:${caseID}`, comparabilityKey: 'key', scoringMode: 'exact', maxOutputTokens: 1,
      inputBudgetTokens: 1, executionOrdinal,
    })),
  }],
};
const CANDIDATES = [{ name: 'model', modelID: 'model' }];
const FIRST = slotKey('model', 'suite', 1, 'first');
const SECOND = slotKey('model', 'suite', 1, 'second');
const clock = () => '2026-11-07T00:00:00Z';

/** A seam that, once armed, writes the first half of the next write and then fails as a full disk does. */
function halfThenENOSPC(): { fileSystem: LedgerFileSystem; arm: () => void } {
  let armed = false;
  const fileSystem: LedgerFileSystem = {
    ...fs,
    writeFileSync: ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (!armed) return fs.writeFileSync(target, data, options);
      armed = false;
      const text = typeof data === 'string' ? data : Buffer.from(data.buffer).toString('utf8');
      const half = text.slice(0, Math.floor(text.length / 2));
      if (typeof target === 'number') fs.writeSync(target, half);
      else fs.writeFileSync(target, half);
      throw errno('ENOSPC', 'no space left on device');
    }) as typeof fs.writeFileSync,
  };
  return { fileSystem, arm: () => { armed = true; } };
}

describe('(c) a half-written row never becomes a result, and the ledger stays loadable', () => {
  it('ENOSPC mid-append: the next append and a fresh load succeed, and the half row is not a result', () => {
    const root = path.join(temporary('cernum-storage-ledger-'), 'ledger');
    const seam = halfThenENOSPC();
    const ledger = Ledger.create(root, CATALOG, CANDIDATES, {}, clock, seam.fileSystem);

    seam.arm();
    expect(() => ledger.appendResult({ slotKey: FIRST, status: 'pass', detail: 'the first result' })).toThrow(/ENOSPC/);
    const torn = fs.readFileSync(ledger.resultsPath, 'utf8');
    expect(torn.length).toBeGreaterThan(0);
    expect(torn.endsWith('\n')).toBe(false);
    expect(ledger.isTerminal(FIRST)).toBe(false);

    // THE NEXT APPEND: the torn tail is cut first, so the half row is never followed by a whole one.
    ledger.appendResult({ slotKey: SECOND, status: 'fail', detail: 'the second result' });
    expect(ledger.anomalies.some((anomaly) => anomaly.kind === 'repairedTornWrite')).toBe(true);
    const lines = fs.readFileSync(ledger.resultsPath, 'utf8').split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    // A FRESH LOAD succeeds, and the half row is nowhere among the results.
    const reopened = Ledger.open(root, clock);
    expect([...reopened.results.keys()]).toEqual([SECOND]);
    expect(reopened.isTerminal(FIRST)).toBe(false);
    expect(reopened.pending().map((slot) => slot.slotKey)).toEqual([FIRST]);
    expect(reopened.reconcile().balances).toBe(true);

    // And the slot whose row was torn can still be recorded, once, as a whole row.
    reopened.appendResult({ slotKey: FIRST, status: 'pass', detail: 'the first result, written whole' });
    expect(Ledger.open(root, clock).results.size).toBe(2);
  });

  it('the same holds for events.jsonl: a torn event is not read, and the next event repairs it', () => {
    const root = path.join(temporary('cernum-storage-ledger-'), 'ledger');
    const seam = halfThenENOSPC();
    const ledger = Ledger.create(root, CATALOG, CANDIDATES, {}, clock, seam.fileSystem);
    ledger.event('before');
    seam.arm();
    expect(() => ledger.event('torn', { detail: 'this event is never completely written' })).toThrow(/ENOSPC/);
    expect(ledger.events().map((event) => event.kind)).toEqual(['before']);
    ledger.event('after');
    expect(ledger.events().map((event) => event.kind)).toEqual(['before', 'after']);
    expect(fs.readFileSync(ledger.eventsPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('repairTornTail truncates to the last newline, to empty when there is none, and leaves a whole file alone', () => {
    const directory = temporary('cernum-storage-tail-');
    const file = path.join(directory, 'rows.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":');
    expect(repairTornTail(file)).toMatchObject({ truncatedBytes: 5, at: 8 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(repairTornTail(file)).toBeUndefined();
    fs.writeFileSync(file, '{"only":');
    expect(repairTornTail(file)).toMatchObject({ truncatedBytes: 8, at: 0 });
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(repairTornTail(path.join(directory, 'absent.jsonl'))).toBeUndefined();
  });
});

// MARK: - (d)

describe('(d) a failing atomic write leaves no temporary file', () => {
  const temporariesIn = (directory: string) => fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));

  it('ENOSPC mid-write, EIO on fsync and EIO on rename each leave no .tmp and the previous file intact', () => {
    const directory = temporary('cernum-storage-atomic-');
    const file = path.join(directory, 'checkpoint.json');
    atomicWriteJSON(file, { version: 1 });
    const failures: Array<[string, Partial<LedgerFileSystem>]> = [
      ['ENOSPC', halfThenENOSPC().fileSystem],
      ['EIO', { fsyncSync: (() => { throw errno('EIO', 'i/o error, fsync'); }) as typeof fs.fsyncSync }],
      ['EIO', { renameSync: (() => { throw errno('EIO', 'i/o error, rename', file); }) as typeof fs.renameSync }],
    ];
    for (const [code, override] of failures) {
      let seam: LedgerFileSystem = { ...fs, ...override };
      if (code === 'ENOSPC') { const half = halfThenENOSPC(); half.arm(); seam = half.fileSystem; }
      expect(() => atomicWriteJSON(file, { version: 2 }, seam)).toThrow(new RegExp(code));
      expect(temporariesIn(directory)).toEqual([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    }
  });

  it('a checkpoint rewrite through the ledger that fails leaves no .tmp beside it', () => {
    const root = path.join(temporary('cernum-storage-ledger-'), 'ledger');
    const seam = halfThenENOSPC();
    const ledger = Ledger.create(root, CATALOG, CANDIDATES, {}, clock, seam.fileSystem);
    seam.arm();
    expect(() => ledger.writeCheckpoint()).toThrow(/ENOSPC/);
    expect(temporariesIn(root)).toEqual([]);
    expect(Ledger.open(root, clock).results.size).toBe(0);
  });

  it('every temporary name is unique and sits in the target\'s own directory', () => {
    const directory = temporary('cernum-storage-atomic-');
    const file = path.join(directory, 'record.json');
    const opened: string[] = [];
    const watching: LedgerFileSystem = {
      ...fs,
      openSync: ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(target).endsWith('.tmp')) opened.push(String(target));
        return fs.openSync(target, flags, mode);
      }) as typeof fs.openSync,
    };
    atomicWriteJSON(file, { n: 1 }, watching);
    atomicWriteJSON(file, { n: 2 }, watching);
    expect(opened).toHaveLength(2);
    expect(new Set(opened).size).toBe(2);
    for (const name of opened) {
      expect(path.dirname(name)).toBe(directory);
      expect(path.basename(name).startsWith('record.json.')).toBe(true);
    }
    expect(temporariesIn(directory)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 2 });
  });
});

// MARK: - (e)

describe('(e) a cell fault that is not a storage fault keeps today\'s behaviour', () => {
  /** A seam that fails the FIRST record's manifest write once, with the given error, and never again. */
  function failFirstManifest(make: (target: string) => NodeJS.ErrnoException): LedgerFileSystem {
    let failed = false;
    return {
      ...fs,
      openSync: ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (!failed && path.basename(String(target)).startsWith('manifest.json.') && String(target).endsWith('.tmp')) {
          failed = true;
          throw make(String(target));
        }
        return fs.openSync(target, flags, mode);
      }) as typeof fs.openSync,
    };
  }

  for (const [label, make] of [
    ['an EACCES on the record root', (target: string) => errno('EACCES', 'permission denied, open', target)],
    ['an ENOENT outside the record root', () => errno('ENOENT', 'no such file or directory, open', '/nonexistent/fixtures/src/stats.js')],
  ] as const) {
    it(`${label}: that cell is a harnessFault, every later cell runs`, async () => {
      const campaignRoot = temporary('cernum-storage-campaign-');
      const calls: string[] = [];
      const { matrix, plan } = matrixOf({ campaignRoot }, calls);
      const result = await runWorkspaceMatrix(plan, matrix, runOptions({ recordFileSystem: failFirstManifest(make) }));

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].disposition).toBe('harnessFault');
      expect(result.skipped[0].cell.recordRoot).toBe(plan.cells[0].recordRoot);
      expect(result.storageFault).toBeUndefined();
      expect('storageFault' in result).toBe(false);
      expect(result.executedRunCount).toBe(5);
      expect(calls).toHaveLength(5);
    }, 60_000);
  }
});
