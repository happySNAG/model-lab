// Model description schema cmd2 — lifecycle, aliases, one canonical id — and the discovery delta (cdd1)
// that reports which models are new, changed or gone between two discovery snapshots.
//
// FIXTURES ONLY. The two snapshots and the alias statement are files under fixtures/model-lifecycle; the
// descriptions are built by the engine's own constructors from hand-written discovery rows. The command
// is spawned with --root in a temporary directory and the network tripwire preloaded, so nothing reads
// this Mac's campaign root and any connection is refused.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveredFrontierModel } from '../../src/engine/discovery';
import { DiscoverySnapshot } from '../../src/engine/discovery-refresh';
import {
  AliasResolutionError, AliasStatement, CMD1_HAS_NO_LIFECYCLE, LIFECYCLE_STATES, MODEL_DESCRIPTION_SCHEMA,
  MODEL_DESCRIPTION_SCHEMA_V2, ModelDescriptionV2, buildAliasTable, dedupByCanonicalID, describeDiscoveredRoute,
  lifecycleFromField, readModelDescription, resolveAlias, upgradeToCmd2, withLifecycle,
} from '../../src/engine/model-description';
import {
  DISCOVERY_DELTA_SCHEMA, DiscoveryDeltaError, DiscoveryDeltaReport, deriveDiscoveryDelta, describeDiscoveryDelta,
} from '../../src/engine/discovery-delta';
import { appendObservations, discoverySnapshotObservation } from '../../src/engine/observation-store';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPOSITORY, 'fixtures', 'model-lifecycle');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const BEFORE_FILE = path.join(FIXTURES, 'snapshot-2026-10-20.json');
const AFTER_FILE = path.join(FIXTURES, 'snapshot-2026-10-25.json');
const ALIASES_FILE = path.join(FIXTURES, 'aliases.json');
const BEFORE = JSON.parse(fs.readFileSync(BEFORE_FILE, 'utf8')) as DiscoverySnapshot;
const AFTER = JSON.parse(fs.readFileSync(AFTER_FILE, 'utf8')) as DiscoverySnapshot;
const ALIASES = (JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) as { aliases: AliasStatement[] }).aliases;
const MACHINE = BEFORE.machineKey;
const WEEK = 7 * 24 * 60 * 60 * 1_000;

const temporaries: string[] = [];
afterAll(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

function row(modelID: string, overrides: Partial<DiscoveredFrontierModel> = {}): DiscoveredFrontierModel {
  return {
    provider: 'claudeCLI', modelID, displayName: modelID, availability: 'proven', evidence: 'fixture smoke',
    verifiedModelID: modelID, desiredEfforts: [], discoveredAt: '2026-10-20T00:00:00Z', ...overrides,
  };
}

function cmd2(modelID: string, overrides: Partial<DiscoveredFrontierModel> = {}): ModelDescriptionV2 {
  return upgradeToCmd2(describeDiscoveredRoute(row(modelID, overrides), { evidenceMaxAgeMilliseconds: WEEK }));
}

/** Every file under a directory and its bytes, so "wrote nothing" is a comparison, not a hope. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

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

// ------------------------------------------------------------------ cmd2: lifecycle

describe('cmd2 · lifecycle is a Known value with its source', () => {
  it('reads each of active, deprecated and retired from a structured field, with the source', () => {
    for (const state of LIFECYCLE_STATES) {
      const field = lifecycleFromField(state, 'fixture: provider catalogue `status` field', '2026-10-25T00:00:00Z');
      expect(field).toEqual({ state: 'known', value: state, source: 'fixture: provider catalogue `status` field',
        observedAt: '2026-10-25T00:00:00Z' });
    }
  });

  it('leaves the lifecycle unknown, with a reason, when no source says or the word is not one of the three', () => {
    const absent = lifecycleFromField(undefined, 'fixture catalogue');
    expect(absent.state).toBe('unknown');
    expect(absent.state === 'unknown' && absent.reason).toMatch(/published no lifecycle field/);
    const vague = lifecycleFromField('sunsetting', 'fixture catalogue');
    expect(vague.state).toBe('unknown');
    expect(vague.state === 'unknown' && vague.reason).toMatch(/"sunsetting".*not one of active, deprecated, retired/);
  });

  it('never infers a lifecycle from a refused smoke, a preview name, or a model missing from a listing', () => {
    const refused = cmd2('claude-opus-4-1-preview', { availability: 'refused', verifiedModelID: '' });
    expect(refused.lifecycle.state).toBe('unknown');
    expect(refused.lifecycle.state === 'unknown' && refused.lifecycle.reason).toBe(CMD1_HAS_NO_LIFECYCLE);
  });

  it('records a stated lifecycle with its source on the description and in its provenance', () => {
    const description = withLifecycle(cmd2('claude-opus-4-1'), 'deprecated', 'fixture: provider deprecation notice', '2026-10-22T00:00:00Z');
    expect(description.schema).toBe(MODEL_DESCRIPTION_SCHEMA_V2);
    expect(description.lifecycle).toEqual({ state: 'known', value: 'deprecated', source: 'fixture: provider deprecation notice',
      observedAt: '2026-10-22T00:00:00Z' });
    expect(description.provenance.at(-1)).toContain('lifecycle deprecated: fixture: provider deprecation notice');
  });
});

// ------------------------------------------------------------------ cmd2: cmd1 stays readable

describe('cmd2 · a cmd1 document stays readable', () => {
  it('reads a stored cmd1 description as cmd2 with no lifecycle, no aliases and its own id as canonical', () => {
    const stored = JSON.parse(JSON.stringify(describeDiscoveredRoute(row('claude-haiku-4-5'), { evidenceMaxAgeMilliseconds: WEEK })));
    expect(stored.schema).toBe(MODEL_DESCRIPTION_SCHEMA);
    expect(MODEL_DESCRIPTION_SCHEMA).toBe('cmd1');
    const read = readModelDescription(stored);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.readFrom).toBe('cmd1');
    expect(read.description.schema).toBe('cmd2');
    expect(read.description.canonicalModelID).toBe('claude-haiku-4-5');
    expect(read.description.canonicalRouteKey).toBe('claudeCLI:claude-haiku-4-5');
    expect(read.description.aliases).toEqual([]);
    expect(read.description.lifecycle).toEqual({ state: 'unknown', reason: CMD1_HAS_NO_LIFECYCLE });
    // Every cmd1 field survives unchanged.
    expect(read.description.availability).toEqual(stored.availability);
    expect(read.description.identityConfidence).toBe(stored.identityConfidence);
    expect(read.description.provenance).toEqual(stored.provenance);
  });

  it('round-trips a cmd2 document and refuses one with a lifecycle outside the vocabulary or an unknown schema', () => {
    const description = withLifecycle(cmd2('claude-opus-4-1'), 'retired', 'fixture: retirement notice');
    const read = readModelDescription(JSON.parse(JSON.stringify(description)));
    expect(read.ok && read.readFrom).toBe('cmd2');
    expect(read.ok && read.description.lifecycle).toEqual(description.lifecycle);

    const bad = { ...JSON.parse(JSON.stringify(description)), lifecycle: { state: 'known', value: 'gone', source: 'x' } };
    expect(readModelDescription(bad)).toEqual({ ok: false, reason: "lifecycle 'gone' is not one of active, deprecated, retired" });
    const noLifecycle = { ...JSON.parse(JSON.stringify(description)), lifecycle: undefined };
    expect(readModelDescription(noLifecycle).ok).toBe(false);
    expect(readModelDescription({ ...description, schema: 'cmd9' })).toEqual({ ok: false, reason: "schema is 'cmd9', not cmd1 or cmd2" });
    expect(readModelDescription([]).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ cmd2: aliases

describe('cmd2 · aliases resolve to one canonical id, and only where a source stated them', () => {
  it('resolves an alias, a chain, and an identifier nobody named', () => {
    const table = buildAliasTable([
      ...ALIASES,
      { provider: 'claudeCLI', alias: 'claude-sonnet', canonicalModelID: 'sonnet', source: 'fixture: chain' },
    ]);
    expect(resolveAlias(table, 'claudeCLI', 'claude-sonnet-4-5')).toMatchObject({ state: 'canonical', canonicalRouteKey: 'claudeCLI:claude-sonnet-4-5' });
    const alias = resolveAlias(table, 'claudeCLI', 'sonnet');
    expect(alias).toMatchObject({ state: 'alias', canonicalRouteKey: 'claudeCLI:claude-sonnet-4-5' });
    expect(alias.state === 'alias' && alias.via[0]).toContain(ALIASES[0].source);
    expect(resolveAlias(table, 'claudeCLI', 'claude-sonnet')).toMatchObject({ state: 'alias', canonicalRouteKey: 'claudeCLI:claude-sonnet-4-5' });
    // The same identifier at another provider is another route: aliases are per provider.
    expect(resolveAlias(table, 'codexCLI', 'sonnet')).toMatchObject({ state: 'canonical', canonicalRouteKey: 'codexCLI:sonnet' });
  });

  it('reports disagreeing statements and cycles as ambiguous, never picking one', () => {
    const disagree = buildAliasTable([
      { provider: 'claudeCLI', alias: 'opus', canonicalModelID: 'claude-opus-4-1', source: 'fixture: old table' },
      { provider: 'claudeCLI', alias: 'opus', canonicalModelID: 'claude-opus-5', source: 'fixture: new table' },
    ]);
    expect(disagree.conflicts).toHaveLength(1);
    expect(disagree.conflicts[0].sources).toEqual(['fixture: new table', 'fixture: old table']);
    expect(resolveAlias(disagree, 'claudeCLI', 'opus')).toMatchObject({ state: 'ambiguous', candidates: ['claudeCLI:claude-opus-4-1', 'claudeCLI:claude-opus-5'] });
    const cycle = buildAliasTable([
      { provider: 'claudeCLI', alias: 'a', canonicalModelID: 'b', source: 'fixture' },
      { provider: 'claudeCLI', alias: 'b', canonicalModelID: 'a', source: 'fixture' },
    ]);
    expect(resolveAlias(cycle, 'claudeCLI', 'a').state).toBe('ambiguous');
  });

  it('refuses an alias statement with no source, or one naming a model its own alias', () => {
    expect(() => buildAliasTable([{ provider: 'claudeCLI', alias: 'sonnet', canonicalModelID: 'claude-sonnet-4-5', source: ' ' }]))
      .toThrow(AliasResolutionError);
    expect(() => buildAliasTable([{ provider: 'claudeCLI', alias: 'x', canonicalModelID: 'x', source: 'fixture' }])).toThrow(/alias of itself/);
  });

  it('dedups by canonical id: one description, the alias recorded with its source, the lifecycle carried', () => {
    const canonical = withLifecycle(cmd2('claude-sonnet-4-5'), 'active', 'fixture: provider catalogue');
    const alias = cmd2('sonnet');
    const other = cmd2('claude-haiku-4-5');
    const outcome = dedupByCanonicalID([alias, canonical, other], ALIASES);
    expect(outcome.descriptions.map((entry) => entry.canonicalRouteKey)).toEqual(['claudeCLI:claude-haiku-4-5', 'claudeCLI:claude-sonnet-4-5']);
    const sonnet = outcome.descriptions[1];
    expect(sonnet.modelID).toBe('claude-sonnet-4-5');
    expect(sonnet.aliases).toEqual([{ alias: 'sonnet', source: ALIASES[0].source, observedAt: ALIASES[0].observedAt }]);
    expect(sonnet.lifecycle).toMatchObject({ state: 'known', value: 'active' });
    expect(outcome.merged).toEqual([{ canonicalRouteKey: 'claudeCLI:claude-sonnet-4-5', fromRouteKeys: ['claudeCLI:claude-sonnet-4-5', 'claudeCLI:sonnet'] }]);
    // cmd1 input is accepted too.
    const fromCmd1 = dedupByCanonicalID([describeDiscoveredRoute(row('sonnet'), { evidenceMaxAgeMilliseconds: WEEK })], ALIASES);
    expect(fromCmd1.descriptions[0]).toMatchObject({ schema: 'cmd2', canonicalRouteKey: 'claudeCLI:claude-sonnet-4-5' });
  });

  it('does not merge two identifiers that merely look alike', () => {
    const outcome = dedupByCanonicalID([cmd2('claude-sonnet-4-5'), cmd2('sonnet'), cmd2('claude-sonnet-4-5-latest')]);
    expect(outcome.descriptions).toHaveLength(3);
    expect(outcome.merged).toEqual([]);
  });

  it('leaves the lifecycle unknown, naming both, when members of one model disagree', () => {
    const outcome = dedupByCanonicalID([
      withLifecycle(cmd2('claude-sonnet-4-5'), 'active', 'fixture: catalogue A'),
      withLifecycle(cmd2('sonnet'), 'deprecated', 'fixture: catalogue B'),
    ], ALIASES);
    expect(outcome.descriptions).toHaveLength(1);
    expect(outcome.descriptions[0].lifecycle.state).toBe('unknown');
    expect(outcome.lifecycleConflicts).toHaveLength(1);
    expect(outcome.lifecycleConflicts[0].reason).toMatch(/active per fixture: catalogue A.*deprecated per fixture: catalogue B/);
  });
});

// ------------------------------------------------------------------ the discovery delta

const keysOf = (models: DiscoveryDeltaReport['new']) => models.map((model) => model.canonicalRouteKey);

describe('discovery delta cdd1 · new, changed and disappeared between two snapshots', () => {
  it('reports each model once, with what changed', () => {
    const report = deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES });
    expect(report.schema).toBe(DISCOVERY_DELTA_SCHEMA);
    expect(report.beforeTakenAt).toBe('2026-10-20T00:00:00Z');
    expect(report.afterTakenAt).toBe('2026-10-25T00:00:00Z');
    expect(keysOf(report.new)).toEqual(['claudeCLI:claude-opus-5', 'codexCLI:gpt-5.1-codex']);
    expect(keysOf(report.disappeared)).toEqual(['claudeCLI:claude-opus-4-1']);
    expect(keysOf(report.changed)).toEqual(['claudeCLI:claude-sonnet-4-5', 'codexCLI:gpt-5-codex']);
    expect(keysOf(report.notRefreshed)).toEqual(['opencodeCLI:opencode/big-pickle']);
    expect(report.unchangedCount).toBe(1);

    const codex = report.changed.find((model) => model.canonicalRouteKey === 'codexCLI:gpt-5-codex')!;
    expect(codex.changes).toEqual([{ routeKey: 'codexCLI:gpt-5-codex', field: 'runtimeVersion', before: '0.40.0', after: '0.41.0' }]);
    expect(codex.qualificationNowStale).toBe(true);
    // A newly listed ALIAS of a listed model is a change to that model, not a release.
    const sonnet = report.changed.find((model) => model.canonicalRouteKey === 'claudeCLI:claude-sonnet-4-5')!;
    expect(sonnet.routeKeys).toEqual(['claudeCLI:claude-sonnet-4-5', 'claudeCLI:sonnet']);
    expect(sonnet.kinds).toContain('newlyDiscovered');
    const gone = report.disappeared[0];
    expect(gone.changes).toEqual([{ routeKey: 'claudeCLI:claude-opus-4-1', field: 'listed', before: true, after: false }]);
    expect(report.disclosure).toMatch(/not a statement that it was retired/);
  });

  it('without the alias statement, the alias is its own new model: nothing is merged on a name', () => {
    const report = deriveDiscoveryDelta(BEFORE, AFTER);
    expect(keysOf(report.new)).toEqual(['claudeCLI:claude-opus-5', 'claudeCLI:sonnet', 'codexCLI:gpt-5.1-codex']);
  });

  it('a provider that did not answer contributes no disappearance', () => {
    const report = deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES });
    expect(keysOf(report.disappeared)).not.toContain('opencodeCLI:opencode/big-pickle');
    expect(report.notRefreshed[0].kinds).toEqual(['notRefreshed']);
  });

  it('with no earlier snapshot, every listed model is new', () => {
    const report = deriveDiscoveryDelta(undefined, BEFORE);
    expect(report.beforeTakenAt).toBeUndefined();
    expect(report.new).toHaveLength(5);
    expect(report.changed.length + report.disappeared.length).toBe(0);
  });

  it('is deterministic, and the same snapshot against itself changes nothing', () => {
    expect(deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES })).toEqual(deriveDiscoveryDelta(BEFORE, {
      ...AFTER, routes: [...AFTER.routes].reverse(), providers: [...AFTER.providers].reverse(),
    }, { aliases: ALIASES }));
    const same = deriveDiscoveryDelta(BEFORE, BEFORE);
    expect(same.new.length + same.changed.length + same.disappeared.length).toBe(0);
    expect(same.unchangedCount).toBe(5);
  });

  it('refuses snapshots from two machines, or named newest first', () => {
    expect(() => deriveDiscoveryDelta({ ...BEFORE, machineKey: 'cmk1:other' }, AFTER)).toThrow(DiscoveryDeltaError);
    expect(() => deriveDiscoveryDelta(AFTER, BEFORE)).toThrow(/Name them oldest first/);
  });

  it('describes itself in lines that name every section and every changed field', () => {
    const text = describeDiscoveryDelta(deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES })).join('\n');
    expect(text).toContain('2 new · 2 changed · 1 disappeared · 1 not refreshed · 1 unchanged');
    expect(text).toContain('codexCLI:gpt-5-codex runtimeVersion: "0.40.0" → "0.41.0"');
    expect(text).toContain('claudeCLI:claude-sonnet-4-5  (also claudeCLI:sonnet)');
  });
});

// ------------------------------------------------------------------ the command

describe('cernum discovery-delta', () => {
  it('is declared read-only with --json, --before, --after, --aliases and --machine', () => {
    const spec = commandSpec('discovery-delta')!;
    expect(spec.effect).toBe('readOnly');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(
      expect.arrayContaining(['json', 'before', 'after', 'aliases', 'machine', 'root', 'help']));
  });

  it('compares two snapshot files as JSON, writing nothing and contacting nothing', async () => {
    const root = temporary('cernum-delta-files-');
    const networkLog = path.join(temporary('cernum-delta-net-'), 'network.log');
    const result = await cernum(networkLog, 'discovery-delta', '--json', '--root', root,
      '--before', BEFORE_FILE, '--after', AFTER_FILE, '--aliases', ALIASES_FILE);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as DiscoveryDeltaReport;
    expect(report).toEqual(deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES }));
    expect(treeOf(root)).toEqual({});
    expect(networkUse(networkLog)).toEqual([]);
  }, 120_000);

  it('by default compares the two newest snapshots recorded on the machine, and leaves the store as it was', async () => {
    const root = temporary('cernum-delta-store-');
    appendObservations(root, [
      discoverySnapshotObservation(BEFORE, 'fixture-mac', 'fixture snapshot'),
      discoverySnapshotObservation(AFTER, 'fixture-mac', 'fixture snapshot'),
    ], { origin: 'observedHere', receivedAt: '2026-10-25T00:00:01Z' });
    const before = treeOf(root);
    const networkLog = path.join(temporary('cernum-delta-net-'), 'network.log');
    const result = await cernum(networkLog, 'discovery-delta', '--json', '--machine', MACHINE, '--root', root);
    expect(result.status).toBe(0);
    expect(keysOf((JSON.parse(result.stdout) as DiscoveryDeltaReport).new))
      .toEqual(['claudeCLI:claude-opus-5', 'claudeCLI:sonnet', 'codexCLI:gpt-5.1-codex']);
    expect(treeOf(root)).toEqual(before);
    expect(networkUse(networkLog)).toEqual([]);

    const text = await cernum(networkLog, 'discovery-delta', '--machine', MACHINE, '--root', root, '--aliases', ALIASES_FILE);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('DISAPPEARED (from the listing; not a statement of retirement)');
  }, 120_000);

  it('refuses a machine with no snapshot, an unreadable alias file and a positional, with exit 2', async () => {
    const root = temporary('cernum-delta-empty-');
    const networkLog = path.join(temporary('cernum-delta-net-'), 'network.log');
    const empty = await cernum(networkLog, 'discovery-delta', '--machine', MACHINE, '--root', root);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('no discovery snapshot was recorded');
    const unsourced = path.join(root, 'aliases.json');
    fs.writeFileSync(unsourced, JSON.stringify([{ provider: 'claudeCLI', alias: 'sonnet', canonicalModelID: 'claude-sonnet-4-5', source: '' }]));
    const refused = await cernum(networkLog, 'discovery-delta', '--before', BEFORE_FILE, '--after', AFTER_FILE, '--aliases', unsourced);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('names no source');
    const positional = await cernum(networkLog, 'discovery-delta', 'extra', '--root', root);
    expect(positional.status).toBe(2);
  }, 120_000);
});
