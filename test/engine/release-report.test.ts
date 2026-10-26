// The release report (crl1): the models a discovery snapshot lists that no earlier report recorded, each
// reported once, against a sealed, hash-chained, append-only ledger.
//
// FIXTURES ONLY. The snapshots and the alias statement are files under fixtures/model-lifecycle; every
// ledger lives in a temporary directory. The command is spawned with --machine and --root and with the
// network tripwire preloaded, so nothing reads this Mac's identity or campaign root and any connection
// is refused.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoverySnapshot } from '../../src/engine/discovery-refresh';
import { AliasStatement } from '../../src/engine/model-description';
import {
  RELEASE_REPORT_SCHEMA, ReleaseLedgerError, ReleaseReport, deriveReleaseReport, describeReleaseReport,
  readReleaseLedger, recordReleaseReport, releaseLedgerPath, sealReleaseRecord, verifyReleaseRecord,
} from '../../src/engine/release-report';
import { appendObservations, discoverySnapshotObservation } from '../../src/engine/observation-store';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPOSITORY, 'fixtures', 'model-lifecycle');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const BEFORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot-2026-10-20.json'), 'utf8')) as DiscoverySnapshot;
const AFTER = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot-2026-10-25.json'), 'utf8')) as DiscoverySnapshot;
const ALIASES_FILE = path.join(FIXTURES, 'aliases.json');
const ALIASES = (JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) as { aliases: AliasStatement[] }).aliases;
const MACHINE = BEFORE.machineKey;

const temporaries: string[] = [];
afterAll(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

function report(root: string, snapshot: DiscoverySnapshot, extra: Partial<Parameters<typeof deriveReleaseReport>[0]> = {}): ReleaseReport {
  return deriveReleaseReport({ snapshot, ledger: readReleaseLedger(root), aliases: ALIASES, ...extra });
}
const newKeys = (value: ReleaseReport) => value.newModels.map((model) => model.canonicalRouteKey);

function cernum(networkLog: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CERNUM_NETWORK_LOG: networkLog },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const networkUse = (log: string): string[] => (!fs.existsSync(log) ? []
  : fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0 && !/ ipc /.test(line)));

// ------------------------------------------------------------------ deciding and recording

describe('release report crl1 · each new model is reported once', () => {
  it('on an empty ledger, lists every listed model once — an alias folded into its canonical model', () => {
    const root = temporary('cernum-release-first-');
    const first = report(root, AFTER);
    expect(first.schema).toBe(RELEASE_REPORT_SCHEMA);
    expect(first.firstReport).toBe(true);
    expect(newKeys(first)).toEqual([
      'claudeCLI:claude-haiku-4-5', 'claudeCLI:claude-opus-5', 'claudeCLI:claude-sonnet-4-5',
      'codexCLI:gpt-5-codex', 'codexCLI:gpt-5.1-codex', 'opencodeCLI:opencode/big-pickle',
    ]);
    // claude-opus-4-1 is no longer listed, so it is not a release.
    expect(newKeys(first)).not.toContain('claudeCLI:claude-opus-4-1');
    const sonnet = first.newModels.find((model) => model.canonicalRouteKey === 'claudeCLI:claude-sonnet-4-5')!;
    expect(sonnet.routeKeys).toEqual(['claudeCLI:claude-sonnet-4-5', 'claudeCLI:sonnet']);
    expect(sonnet.availability).toEqual([
      { routeKey: 'claudeCLI:claude-sonnet-4-5', availability: 'proven' }, { routeKey: 'claudeCLI:sonnet', availability: 'unproven' },
    ]);
    expect(new Set(newKeys(first)).size).toBe(first.newModels.length);
  });

  it('deciding writes nothing: asked twice without recording, it lists the same models', () => {
    const root = temporary('cernum-release-pure-');
    expect(report(root, AFTER)).toEqual(report(root, AFTER));
    expect(fs.existsSync(releaseLedgerPath(root))).toBe(false);
  });

  it('never repeats an already-reported model, and reports only what is new since', () => {
    const root = temporary('cernum-release-once-');
    const first = report(root, BEFORE);
    expect(newKeys(first)).toEqual(['claudeCLI:claude-haiku-4-5', 'claudeCLI:claude-opus-4-1', 'claudeCLI:claude-sonnet-4-5',
      'codexCLI:gpt-5-codex', 'opencodeCLI:opencode/big-pickle']);
    const written = recordReleaseReport(root, first, { reportedAt: '2026-10-20T00:05:00Z' }).written!;
    expect(written.sequence).toBe(1);
    expect(written.previousRecordID).toBeUndefined();

    const again = report(root, BEFORE);
    expect(again.newModels).toEqual([]);
    expect(again.firstReport).toBe(false);
    expect(again.alreadyReported).toEqual(newKeys(first));

    // The later snapshot: only the two releases. The newly listed alias `sonnet` is a model already told.
    const second = report(root, AFTER);
    expect(newKeys(second)).toEqual(['claudeCLI:claude-opus-5', 'codexCLI:gpt-5.1-codex']);
    expect(second.alreadyReported).toContain('claudeCLI:claude-sonnet-4-5');
    const next = recordReleaseReport(root, second, { reportedAt: '2026-10-25T00:05:00Z' }).written!;
    expect(next.sequence).toBe(2);
    expect(next.previousRecordID).toBe(written.recordID);
    expect(report(root, AFTER).newModels).toEqual([]);

    const ledger = readReleaseLedger(root);
    const everyReported = ledger.records.flatMap((record) => record.models.map((model) => model.canonicalRouteKey));
    expect(new Set(everyReported).size).toBe(everyReported.length);
    expect(ledger.corrupt).toEqual([]);
  });

  it('a model first reported under an alias is not reported again under its canonical id', () => {
    const root = temporary('cernum-release-alias-');
    const aliasOnly: DiscoverySnapshot = { ...BEFORE, routes: [{ ...AFTER.routes.find((route) => route.modelID === 'sonnet')!, observedAt: BEFORE.takenAt }] };
    const first = deriveReleaseReport({ snapshot: aliasOnly, ledger: readReleaseLedger(root) });
    expect(newKeys(first)).toEqual(['claudeCLI:sonnet']);
    recordReleaseReport(root, first, { reportedAt: '2026-10-20T00:05:00Z' });
    expect(newKeys(report(root, AFTER))).not.toContain('claudeCLI:claude-sonnet-4-5');
  });

  it('recording re-decides against the ledger as it is now: a stale report cannot repeat a model', () => {
    const root = temporary('cernum-release-stale-');
    const stale = report(root, AFTER);
    recordReleaseReport(root, report(root, AFTER), { reportedAt: '2026-10-25T00:05:00Z' });
    const outcome = recordReleaseReport(root, stale, { reportedAt: '2026-10-25T00:06:00Z' });
    expect(outcome.written).toBeUndefined();
    expect(outcome.droppedAlreadyReported).toEqual(newKeys(stale));
    expect(readReleaseLedger(root).records).toHaveLength(1);
  });

  it('narrows to the providers asked about', () => {
    const root = temporary('cernum-release-providers-');
    const codex = report(root, AFTER, { providers: ['codexCLI'] });
    expect(codex.providers).toEqual(['codexCLI']);
    expect(newKeys(codex)).toEqual(['codexCLI:gpt-5-codex', 'codexCLI:gpt-5.1-codex']);
  });

  it('describes itself, and says the report is discovery, not qualification', () => {
    const text = describeReleaseReport(report(temporary('cernum-release-text-'), AFTER)).join('\n');
    expect(text).toContain('6 new · 0 already reported · first report');
    expect(text).toContain('claudeCLI:claude-sonnet-4-5  (also claudeCLI:sonnet)');
    expect(report(temporary('cernum-release-text-'), AFTER).disclosure).toMatch(/discovered, not reachable, and reachable is not qualified/);
  });
});

// ------------------------------------------------------------------ the sealed ledger

describe('release ledger · sealed, hash-chained and append-only', () => {
  function twoLines(): string {
    const root = temporary('cernum-release-ledger-');
    recordReleaseReport(root, report(root, BEFORE), { reportedAt: '2026-10-20T00:05:00Z' });
    recordReleaseReport(root, report(root, AFTER), { reportedAt: '2026-10-25T00:05:00Z' });
    return root;
  }

  it('only ever appends: the earlier bytes are a prefix of the later file', () => {
    const root = temporary('cernum-release-append-');
    recordReleaseReport(root, report(root, BEFORE), { reportedAt: '2026-10-20T00:05:00Z' });
    const first = fs.readFileSync(releaseLedgerPath(root), 'utf8');
    recordReleaseReport(root, report(root, AFTER), { reportedAt: '2026-10-25T00:05:00Z' });
    const second = fs.readFileSync(releaseLedgerPath(root), 'utf8');
    expect(second.startsWith(first)).toBe(true);
    expect(second.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
    // A report with nothing new writes nothing at all.
    recordReleaseReport(root, report(root, AFTER), { reportedAt: '2026-10-25T00:06:00Z' });
    expect(fs.readFileSync(releaseLedgerPath(root), 'utf8')).toBe(second);
  });

  it('seals each record by its content', () => {
    const record = sealReleaseRecord({ sequence: 1, reportedAt: '2026-10-25T00:00:00Z', machineKey: MACHINE,
      snapshotTakenAt: AFTER.takenAt, models: [], provenance: 'fixture' });
    expect(verifyReleaseRecord(record).intact).toBe(true);
    expect(verifyReleaseRecord({ ...record, machineKey: 'cmk1:other' }).intact).toBe(false);
  });

  it('refuses a doctored line and every line after it, and will not append to a tampered ledger', () => {
    const root = twoLines();
    const file = releaseLedgerPath(root);
    const [first, second] = fs.readFileSync(file, 'utf8').split('\n');
    const doctored = JSON.parse(first) as { models: { canonicalRouteKey: string }[] };
    doctored.models = doctored.models.filter((model) => model.canonicalRouteKey !== 'claudeCLI:claude-haiku-4-5');
    fs.writeFileSync(file, `${JSON.stringify(doctored)}\n${second}\n`);
    const ledger = readReleaseLedger(root);
    expect(ledger.records).toEqual([]);
    expect(ledger.corrupt.map((entry) => entry.line)).toEqual([1, 2]);
    expect(ledger.corrupt[0].reason).toMatch(/digests to/);
    expect(ledger.corrupt[1].reason).toMatch(/follows line 1/);

    const bytes = fs.readFileSync(file, 'utf8');
    const stale = deriveReleaseReport({ snapshot: AFTER, ledger, aliases: ALIASES });
    expect(stale.corrupt).toHaveLength(2);
    expect(() => recordReleaseReport(root, stale, { reportedAt: '2026-10-26T00:00:00Z' })).toThrow(ReleaseLedgerError);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('refuses a ledger whose first line was removed: the chain no longer starts at one', () => {
    const root = twoLines();
    const file = releaseLedgerPath(root);
    const [, second] = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, `${second}\n`);
    const ledger = readReleaseLedger(root);
    expect(ledger.records).toEqual([]);
    expect(ledger.corrupt[0].reason).toMatch(/number 2, but it is number 1/);
  });

  it('refuses reordered lines and an unreadable line', () => {
    const root = twoLines();
    const file = releaseLedgerPath(root);
    const [first, second] = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, `${second}\n${first}\n`);
    expect(readReleaseLedger(root).corrupt).toHaveLength(2);
    fs.writeFileSync(file, `${first}\nnot json\n`);
    const ledger = readReleaseLedger(root);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.corrupt).toEqual([{ line: 2, reason: expect.stringMatching(/not readable JSON/) }]);
  });
});

// ------------------------------------------------------------------ the command

describe('cernum release-report', () => {
  function storeWith(...snapshots: DiscoverySnapshot[]): string {
    const root = temporary('cernum-release-cli-');
    appendObservations(root, snapshots.map((snapshot) => discoverySnapshotObservation(snapshot, 'fixture-mac', 'fixture snapshot')),
      { origin: 'observedHere', receivedAt: '2026-10-25T00:00:01Z' });
    return root;
  }

  it('is declared with --json, --record, --providers, --aliases and --machine', () => {
    const spec = commandSpec('release-report')!;
    expect(spec.effect).toBe('writesLocal');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(
      expect.arrayContaining(['json', 'record', 'providers', 'aliases', 'machine', 'root', 'help']));
  });

  it('without --record reads the newest snapshot and writes nothing; with it, records each model once', async () => {
    const root = storeWith(BEFORE, AFTER);
    const networkLog = path.join(temporary('cernum-release-net-'), 'network.log');
    const preview = await cernum(networkLog, 'release-report', '--json', '--machine', MACHINE, '--root', root, '--aliases', ALIASES_FILE);
    expect(preview.stderr).toBe('');
    expect(preview.status).toBe(0);
    const shown = JSON.parse(preview.stdout) as ReleaseReport;
    expect(shown.snapshotTakenAt).toBe(AFTER.takenAt);
    expect(newKeys(shown)).toHaveLength(6);
    expect(fs.existsSync(releaseLedgerPath(root))).toBe(false);

    const recorded = await cernum(networkLog, 'release-report', '--json', '--record', '--machine', MACHINE, '--root', root,
      '--aliases', ALIASES_FILE, '--providers', 'claudeCLI,codexCLI');
    expect(recorded.status).toBe(0);
    const first = JSON.parse(recorded.stdout) as ReleaseReport & { recorded: { sequence: number } };
    expect(newKeys(first)).toEqual(['claudeCLI:claude-haiku-4-5', 'claudeCLI:claude-opus-5', 'claudeCLI:claude-sonnet-4-5',
      'codexCLI:gpt-5-codex', 'codexCLI:gpt-5.1-codex']);
    expect(first.recorded.sequence).toBe(1);

    const again = await cernum(networkLog, 'release-report', '--record', '--machine', MACHINE, '--root', root,
      '--aliases', ALIASES_FILE, '--providers', 'claudeCLI,codexCLI');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('0 new · 5 already reported');
    expect(again.stdout).toContain('Nothing new to record; the ledger is unchanged.');
    expect(readReleaseLedger(root).records).toHaveLength(1);
    expect(networkUse(networkLog)).toEqual([]);
  }, 120_000);

  it('exits 4 on a tampered ledger and appends nothing; refuses an unknown provider and a missing snapshot with 2', async () => {
    const root = storeWith(AFTER);
    recordReleaseReport(root, report(root, BEFORE), { reportedAt: '2026-10-20T00:05:00Z' });
    const file = releaseLedgerPath(root);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('claude-haiku-4-5', 'claude-haiku-9'));
    const bytes = fs.readFileSync(file, 'utf8');
    const networkLog = path.join(temporary('cernum-release-net-'), 'network.log');
    const tampered = await cernum(networkLog, 'release-report', '--record', '--machine', MACHINE, '--root', root);
    expect(tampered.status).toBe(4);
    expect(tampered.stderr).toContain('did not verify');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);

    const unknownProvider = await cernum(networkLog, 'release-report', '--providers', 'claudeCLI,nope', '--machine', MACHINE, '--root', root);
    expect(unknownProvider.status).toBe(2);
    const empty = await cernum(networkLog, 'release-report', '--machine', MACHINE, '--root', temporary('cernum-release-empty-'));
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('no discovery snapshot was recorded');
    expect(networkUse(networkLog)).toEqual([]);
  }, 120_000);
});
