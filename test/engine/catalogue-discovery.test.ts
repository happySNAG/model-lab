// Catalogue discovery (ccd1): codexCLI's catalogue recorded as listed and unproven, claudeCLI's missing
// listing recorded as a value, anthropicAPI's listing consulted only behind an already-configured
// credential, and discovered, reachable and qualified kept apart on every row.
//
// FIXTURES AND FAKES ONLY. The Codex catalogue and the Anthropic listing are files under
// fixtures/catalogue-discovery. No CLI is run: the Codex reader is driven through an injected `run` and
// `findExecutable`. No request is made: the Anthropic listing goes through `discoverMeteredProvider` with
// an injected fetch, credentials come from an injected environment and Keychain reader, and the global
// `fetch` is replaced by a tripwire that fails the test if anything reaches it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CATALOGUE_DISCOVERY_SCHEMA, CLAUDE_CLI_CANNOT_LIST_MODELS, CODEX_CATALOGUE_ARGUMENTS, CatalogueDiscoveryOptions,
  CatalogueDiscoveryReport, CatalogueReaders, LISTING_DOES_NOT_QUALIFY, LISTING_DOES_NOT_REACH, catalogueDiscoveryProbe,
  codexCatalogueReader, discoverCatalogues,
} from '../../src/engine/catalogue-discovery';
import { CLIResult } from '../../src/engine/cli-process';
import { discoverMeteredProvider } from '../../src/engine/discovery';
import { refreshDiscovery } from '../../src/engine/discovery-refresh';
import { overrideProviderAllowlist } from '../../src/engine/provider-allowlist';

const FIXTURES = path.resolve(__dirname, '../../fixtures/catalogue-discovery');
const CODEX_CATALOGUE = fs.readFileSync(path.join(FIXTURES, 'codex-debug-models.json'), 'utf8');
const ANTHROPIC_LISTING = fs.readFileSync(path.join(FIXTURES, 'anthropic-v1-models.json'), 'utf8');
const NOW = new Date('2026-10-26T09:00:00Z');
const AT = '2026-10-26T09:00:00Z';
const FAKE_KEY = 'sk-ant-fixture-not-a-real-key-0000000000';

let tripwire: ReturnType<typeof vi.fn>;
beforeEach(() => {
  tripwire = vi.fn(() => { throw new Error('the global fetch was reached: catalogue discovery tests make no request'); });
  vi.stubGlobal('fetch', tripwire);
});
afterEach(() => {
  expect(tripwire).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** A credential lookup that touches neither the real environment nor the real Keychain. */
function noCredential() {
  const environment: NodeJS.ProcessEnv = {};
  const readKeychain = vi.fn((_service: string, _account: string): string | undefined => undefined);
  return { environment, readKeychain, account: 'fixture' };
}

function environmentCredential() {
  const environment: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: FAKE_KEY };
  const readKeychain = vi.fn((_service: string, _account: string): string | undefined => undefined);
  return { environment, readKeychain, account: 'fixture' };
}

/** A fake fetch serving the recorded listing, and recording what it was asked. */
function fakeListingFetch(status = 200, body = ANTHROPIC_LISTING) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImplementation, calls };
}

function readers(overrides: Partial<CatalogueReaders> = {}): CatalogueReaders & {
  readCodexCatalogue: ReturnType<typeof vi.fn>; listAnthropicModels: ReturnType<typeof vi.fn>;
} {
  return {
    readCodexCatalogue: vi.fn(overrides.readCodexCatalogue ?? (async () => ({ ok: true as const, text: CODEX_CATALOGUE }))),
    listAnthropicModels: vi.fn(overrides.listAnthropicModels ?? (async () => {
      throw new Error('listAnthropicModels must not be called in this test');
    })),
  };
}

async function discover(options: Partial<CatalogueDiscoveryOptions> & { readers: CatalogueReaders }): Promise<CatalogueDiscoveryReport> {
  return discoverCatalogues({ now: NOW, credentials: noCredential(), ...options });
}

function outcomeOf(report: CatalogueDiscoveryReport, provider: string) {
  const outcome = report.providers.find((entry) => entry.provider === provider);
  if (outcome === undefined) throw new Error(`no outcome for ${provider}`);
  return outcome;
}

describe('codexCLI: the catalogue is recorded as a listed, unproven source', () => {
  it('records every listed catalogue entry with source catalogue, discovered and nothing more', async () => {
    const report = await discover({ readers: readers(), providers: ['codexCLI'] });
    expect(report.schema).toBe(CATALOGUE_DISCOVERY_SCHEMA);
    expect(report.takenAt).toBe(AT);
    const outcome = outcomeOf(report, 'codexCLI');
    expect(outcome.state).toBe('listed');
    if (outcome.state !== 'listed') return;
    expect(outcome.source).toBe('catalogue');
    expect(outcome.probe).toBe('invoked');
    expect(outcome.routeKeys).toEqual(['codexCLI:gpt-5.6-luna', 'codexCLI:gpt-5.6-sol', 'codexCLI:gpt-5.6-terra', 'codexCLI:gpt-6-astra']);
    expect(report.rows.map((row) => row.routeKey)).toEqual(outcome.routeKeys);
    for (const row of report.rows) {
      expect(row.source).toBe('catalogue');
      expect(row.discovered).toMatchObject({ state: 'listed', source: 'catalogue', observedAt: AT });
      expect(row.discovered.detail).toContain('not this account\'s entitlement');
      expect(row.reachable).toEqual({ state: 'unproven', reason: LISTING_DOES_NOT_REACH });
      expect(row.qualified).toEqual({ state: 'notEvaluated', reason: LISTING_DOES_NOT_QUALIFY });
    }
  });

  it('omits a hidden internal entry, and says why, rather than recording it as a candidate', async () => {
    const report = await discover({ readers: readers(), providers: ['codexCLI'] });
    const outcome = outcomeOf(report, 'codexCLI');
    if (outcome.state !== 'listed') throw new Error('expected listed');
    expect(outcome.omitted).toEqual([{ modelID: 'codex-auto-review', reason: expect.stringContaining('visibility: hide') }]);
    expect(report.rows.some((row) => row.modelID === 'codex-auto-review')).toBe(false);
  });

  it('keeps what the catalogue published as its claim, and leaves what it did not publish unknown', async () => {
    const report = await discover({ readers: readers(), providers: ['codexCLI'] });
    const luna = report.rows.find((row) => row.modelID === 'gpt-5.6-luna')!;
    expect(luna.displayName).toEqual({ state: 'known', value: 'GPT-5.6-Luna', source: 'catalogue', observedAt: AT });
    expect(luna.declaredEfforts).toEqual({ state: 'known', value: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'the Codex catalogue', observedAt: AT });
    // gpt-5.6-sol is listed with no display name and no effort levels: neither is made up from its id.
    const sol = report.rows.find((row) => row.modelID === 'gpt-5.6-sol')!;
    expect(sol.displayName.state).toBe('unknown');
    expect(sol.declaredEfforts.state).toBe('unknown');
  });

  it('reads the catalogue with `codex debug models` through the injected runner, and only that', async () => {
    const calls: { executable: string; args: string[] }[] = [];
    const run = vi.fn(async (options: { executable: string; args: string[] }): Promise<CLIResult> => {
      calls.push({ executable: options.executable, args: options.args });
      return { stdout: CODEX_CATALOGUE, stderr: '', exitCode: 0, wallClockMilliseconds: 1 } as unknown as CLIResult;
    });
    const reader = codexCatalogueReader({ findExecutable: () => '/fake/bin/codex', run });
    const report = await discover({ readers: readers({ readCodexCatalogue: reader }), providers: ['codexCLI'] });
    expect(calls).toEqual([{ executable: '/fake/bin/codex', args: [...CODEX_CATALOGUE_ARGUMENTS] }]);
    expect(CODEX_CATALOGUE_ARGUMENTS).toEqual(['debug', 'models']);
    expect(report.rows).toHaveLength(4);
  });

  it('runs nothing when codex is not installed, and records it as not answered', async () => {
    const run = vi.fn();
    const reader = codexCatalogueReader({ findExecutable: () => undefined, run: run as never });
    const report = await discover({ readers: readers({ readCodexCatalogue: reader }), providers: ['codexCLI'] });
    expect(run).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'codexCLI')).toMatchObject({ state: 'notAnswered', detail: expect.stringContaining('not installed') });
    expect(report.rows).toEqual([]);
  });

  it('records a failed, throwing or unreadable catalogue as not answered, with no rows and no exception', async () => {
    const failing = [
      async () => ({ ok: false as const, detail: 'timed out' }),
      async () => { throw new Error('spawn failed'); },
      async () => ({ ok: true as const, text: 'not json at all' }),
      async () => ({ ok: true as const, text: '{"models": []}' }),
    ];
    for (const readCodexCatalogue of failing) {
      const report = await discover({ readers: readers({ readCodexCatalogue }), providers: ['codexCLI'] });
      expect(outcomeOf(report, 'codexCLI').state).toBe('notAnswered');
      expect(report.rows).toEqual([]);
    }
  });
});

describe('claudeCLI: that the CLI cannot list models is recorded as a value', () => {
  it('records cannotList with its reason, runs nothing and produces no rows', async () => {
    const fakes = readers();
    const report = await discover({ readers: fakes, providers: ['claudeCLI'] });
    expect(outcomeOf(report, 'claudeCLI')).toEqual({
      provider: 'claudeCLI', state: 'cannotList', probe: 'offline', detail: CLAUDE_CLI_CANNOT_LIST_MODELS,
    });
    expect(CLAUDE_CLI_CANNOT_LIST_MODELS).toContain('not an empty listing');
    expect(report.rows).toEqual([]);
    expect(fakes.readCodexCatalogue).not.toHaveBeenCalled();
    expect(fakes.listAnthropicModels).not.toHaveBeenCalled();
  });
});

describe('anthropicAPI: the model list is used only behind an already-configured credential', () => {
  it('does not consult the listing when no credential is configured, and changes nothing', async () => {
    const credentials = noCredential();
    const fakes = readers();
    const report = await discover({ readers: fakes, providers: ['anthropicAPI'], credentials });
    const outcome = outcomeOf(report, 'anthropicAPI');
    expect(outcome.state).toBe('notConsulted');
    expect(outcome.probe).toBe('offline');
    expect(outcome.detail).toContain('ANTHROPIC_API_KEY');
    expect(outcome.detail).toContain('Nothing was sent');
    expect(fakes.listAnthropicModels).not.toHaveBeenCalled();
    expect(report.rows).toEqual([]);
    // The lookup only read: the environment is untouched and the Keychain was only asked.
    expect(credentials.environment).toEqual({});
    expect(credentials.readKeychain).toHaveBeenCalledWith('cernum.anthropicAPI', 'fixture');
  });

  it('lists through discovery\'s own metered reader when an environment credential is configured', async () => {
    const credentials = environmentCredential();
    const before = { ...credentials.environment };
    const { fetchImplementation, calls } = fakeListingFetch();
    const listAnthropicModels = () => discoverMeteredProvider('anthropicAPI', {
      baseURL: 'https://api.anthropic.invalid', credentials, fetchImplementation, now: () => NOW,
    });
    const report = await discover({ readers: readers({ listAnthropicModels }), providers: ['anthropicAPI'], credentials });
    const outcome = outcomeOf(report, 'anthropicAPI');
    expect(outcome).toMatchObject({ state: 'listed', source: 'accountListing', probe: 'invoked', credentialSource: 'environment' });
    expect(calls.map((call) => call.url)).toEqual(['https://api.anthropic.invalid/v1/models']);
    expect(report.rows.map((row) => row.routeKey)).toEqual([
      'anthropicAPI:claude-fable-5-1', 'anthropicAPI:claude-opus-5-5', 'anthropicAPI:claude-sonnet-5',
    ]);
    for (const row of report.rows) {
      expect(row.source).toBe('accountListing');
      expect(row.discovered).toMatchObject({ state: 'listed', source: 'accountListing', observedAt: AT });
      expect(row.reachable.state).toBe('unproven');
      expect(row.qualified.state).toBe('notEvaluated');
      expect(row.declaredEfforts.state).toBe('unknown');
    }
    expect(report.rows.find((row) => row.modelID === 'claude-opus-5-5')!.displayName)
      .toEqual({ state: 'known', value: 'Claude Opus 5.5', source: 'accountListing', observedAt: AT });
    expect(report.rows.find((row) => row.modelID === 'claude-sonnet-5')!.displayName.state).toBe('unknown');
    // No credential change, and the value appears nowhere in what was recorded.
    expect(credentials.environment).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
  });

  it('records a Keychain credential by where it was found, never by its value', async () => {
    const credentials = { environment: {} as NodeJS.ProcessEnv, readKeychain: vi.fn(() => FAKE_KEY), account: 'fixture' };
    const { fetchImplementation } = fakeListingFetch();
    const listAnthropicModels = () => discoverMeteredProvider('anthropicAPI', {
      baseURL: 'https://api.anthropic.invalid', credentials, fetchImplementation, now: () => NOW,
    });
    const report = await discover({ readers: readers({ listAnthropicModels }), providers: ['anthropicAPI'], credentials });
    expect(outcomeOf(report, 'anthropicAPI')).toMatchObject({ state: 'listed', credentialSource: 'keychain' });
    expect(credentials.environment).toEqual({});
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
  });

  it('records a refused listing as not answered, with no rows', async () => {
    const credentials = environmentCredential();
    const { fetchImplementation } = fakeListingFetch(401, '{"error":{"type":"authentication_error"}}');
    const listAnthropicModels = () => discoverMeteredProvider('anthropicAPI', {
      baseURL: 'https://api.anthropic.invalid', credentials, fetchImplementation, now: () => NOW,
    });
    const report = await discover({ readers: readers({ listAnthropicModels }), providers: ['anthropicAPI'], credentials });
    expect(outcomeOf(report, 'anthropicAPI')).toMatchObject({ state: 'notAnswered', detail: expect.stringContaining('notAuthenticated') });
    expect(report.rows).toEqual([]);
  });
});

describe('discovered, reachable and qualified stay separate on every row', () => {
  it('a smoke result moves only reachable, and a qualification verdict moves only qualified', async () => {
    const report = await discover({
      readers: readers(), providers: ['codexCLI'],
      reachability: (routeKey) => (routeKey === 'codexCLI:gpt-5.6-luna'
        ? { state: 'proven', source: 'identity smoke fixture', observedAt: '2026-10-25T00:00:00Z' } : undefined),
      qualification: (routeKey) => (routeKey === 'codexCLI:gpt-5.6-terra'
        ? { state: 'qualified', source: 'cqp1 qualification fixture' } : undefined),
    });
    const byModel = new Map(report.rows.map((row) => [row.modelID, row]));
    const luna = byModel.get('gpt-5.6-luna')!;
    expect(luna.discovered.state).toBe('listed');
    expect(luna.reachable).toEqual({ state: 'proven', source: 'identity smoke fixture', observedAt: '2026-10-25T00:00:00Z' });
    expect(luna.qualified.state).toBe('notEvaluated');
    const terra = byModel.get('gpt-5.6-terra')!;
    expect(terra.discovered.state).toBe('listed');
    expect(terra.reachable.state).toBe('unproven');
    expect(terra.qualified).toEqual({ state: 'qualified', source: 'cqp1 qualification fixture' });
    const astra = byModel.get('gpt-6-astra')!;
    expect([astra.discovered.state, astra.reachable.state, astra.qualified.state]).toEqual(['listed', 'unproven', 'notEvaluated']);
    for (const row of report.rows) {
      expect(Object.keys(row)).toEqual(expect.arrayContaining(['discovered', 'reachable', 'qualified']));
    }
  });

  it('every provider together: one outcome each, rows from the two that list, none from the one that cannot', async () => {
    const credentials = environmentCredential();
    const { fetchImplementation } = fakeListingFetch();
    const listAnthropicModels = () => discoverMeteredProvider('anthropicAPI', {
      baseURL: 'https://api.anthropic.invalid', credentials, fetchImplementation, now: () => NOW,
    });
    const report = await discover({ readers: readers({ listAnthropicModels }), credentials });
    expect(report.providerAllowlist).toBe('cpa1');
    expect(report.providers.map((entry) => [entry.provider, entry.state])).toEqual([
      ['anthropicAPI', 'listed'], ['claudeCLI', 'cannotList'], ['codexCLI', 'listed'],
    ]);
    expect(report.rows.filter((row) => row.provider === 'claudeCLI')).toEqual([]);
    expect(report.rows).toHaveLength(7);
    expect(report.rows.every((row) => row.reachable.state === 'unproven' && row.qualified.state === 'notEvaluated')).toBe(true);
    expect(report.rows.some((row) => (row.provider as string) === 'ollama')).toBe(false);
  });
});

describe('the provider allowlist and discovery refresh', () => {
  it('does not consult a provider the allowlist leaves out', async () => {
    const fakes = readers();
    const report = await discover({ readers: fakes, providers: ['codexCLI'], allowlist: overrideProviderAllowlist(['claudeCLI']) });
    expect(outcomeOf(report, 'codexCLI')).toMatchObject({ state: 'notConsulted', refusedByAllowlist: 'cpa1-override[claudeCLI]' });
    expect(fakes.readCodexCatalogue).not.toHaveBeenCalled();
  });

  it('feeds refreshDiscovery: listed rows arrive unproven, and a provider that cannot list re-observes nothing', async () => {
    const report = await discover({ readers: readers(), providers: ['claudeCLI', 'codexCLI'] });
    const previous = {
      schema: 'cds1' as const, machineKey: 'cmk1:fixture', takenAt: '2026-10-20T00:00:00Z', providerAllowlist: 'cpa1',
      providers: [{ provider: 'claudeCLI' as const, refreshed: true, detail: 'fixture' }],
      routes: [{ routeKey: 'claudeCLI:claude-opus-5-5', provider: 'claudeCLI' as const, modelID: 'claude-opus-5-5',
        listed: true, availability: 'unproven' as const, observedAt: '2026-10-20T00:00:00Z' }],
    };
    const { snapshot, deltas } = await refreshDiscovery({
      previous, machineKey: 'cmk1:fixture', now: NOW,
      probes: { claudeCLI: catalogueDiscoveryProbe(report, 'claudeCLI'), codexCLI: catalogueDiscoveryProbe(report, 'codexCLI') },
    });
    expect(snapshot.providers.find((entry) => entry.provider === 'claudeCLI')).toMatchObject({ refreshed: false, detail: CLAUDE_CLI_CANNOT_LIST_MODELS });
    expect(snapshot.routes.filter((route) => route.provider === 'codexCLI').every((route) => route.availability === 'unproven' && route.listed)).toBe(true);
    expect(deltas.find((delta) => delta.routeKey === 'claudeCLI:claude-opus-5-5')!.kinds).toEqual(['notRefreshed']);
    expect(deltas.filter((delta) => delta.kinds.includes('newlyDiscovered')).map((delta) => delta.routeKey))
      .toEqual(['codexCLI:gpt-5.6-luna', 'codexCLI:gpt-5.6-sol', 'codexCLI:gpt-5.6-terra', 'codexCLI:gpt-6-astra']);
  });
});
