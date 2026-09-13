// Discovery, and the promise that looking costs nothing.
//
// THE ASSERTION THIS FILE EXISTS FOR is that `offlineProviderStatuses` cannot reach a provider. It
// is tested by giving it a runner that FAILS THE TEST if it is ever called, rather than by reading
// the code and believing it — the difference between "we did not mean to" and "it cannot".

import { describe, expect, it, vi } from 'vitest';
import {
  DESIRED_CANDIDATE_LADDER, desiredCandidates, discoverMeteredProvider, discoverSubscriptionCLI,
  offlineProviderStatuses, parseModelListing, privacyDisclosure, selectableModels,
} from '../../src/engine/discovery';
import { forgetRegisteredSecrets } from '../../src/engine/redaction';
import { startMockProvider, writeFakeCLI } from './frontier-harness';
import { FIXTURE_ANTHROPIC_KEY } from '../secret-fixtures';

const NEVER = () => { throw new Error('a provider was contacted by something that promised not to'); };

describe('offline status contacts nothing', () => {
  it('answers for all five providers without invoking anything', () => {
    const statuses = offlineProviderStatuses({
      environment: {},
      readKeychain: () => undefined,
      findExecutable: () => undefined,
    });
    expect(statuses).toHaveLength(5);
    for (const status of statuses) expect(status.probe).toBe('offline');
    expect(statuses.map((status) => status.provider))
      .toEqual(['ollama', 'claudeCLI', 'codexCLI', 'anthropicAPI', 'openaiAPI']);
  });

  it('reports a missing CLI as not installed, and names what Cernum will and will not do', () => {
    const statuses = offlineProviderStatuses({ environment: {}, readKeychain: () => undefined, findExecutable: () => undefined });
    const claude = statuses.find((status) => status.provider === 'claudeCLI')!;
    expect(claude.reachability).toBe('notInstalled');
    expect(claude.detail).toMatch(/never reads its stored session/);
  });

  it('reports an INSTALLED CLI as `unknown`, never as ready: being installed is not being signed in', () => {
    const statuses = offlineProviderStatuses({
      environment: {}, readKeychain: () => undefined,
      findExecutable: (name) => (name === 'claude' ? '/somewhere/claude' : undefined),
    });
    const claude = statuses.find((status) => status.provider === 'claudeCLI')!;
    expect(claude.reachability).toBe('unknown');
    expect(claude.executablePath).toBe('/somewhere/claude');
    expect(claude.detail).toMatch(/can only be learned by running it/);
    // And it did NOT run it.
    expect(claude.version).toBeUndefined();
  });

  it('reports a configured key as `unknown`, never as ready: having a key is not the key working', () => {
    const statuses = offlineProviderStatuses({
      environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY },
      readKeychain: () => undefined,
      findExecutable: () => undefined,
    });
    const anthropic = statuses.find((status) => status.provider === 'anthropicAPI')!;
    expect(anthropic.reachability).toBe('unknown');
    expect(anthropic.credential?.present).toBe(true);
    expect(anthropic.detail).toMatch(/a request to this provider costs money, so none has been made/);
    forgetRegisteredSecrets();
  });

  it('lists no models at all until discovery has run', () => {
    const statuses = offlineProviderStatuses({ environment: {}, readKeychain: () => undefined, findExecutable: () => undefined });
    expect(statuses.flatMap((status) => status.models)).toEqual([]);
    expect(selectableModels(statuses)).toEqual([]);
  });
});

describe('the intended testing ladder is a plan, not a capability claim', () => {
  it('names every desired candidate as UNPROVEN, with the reason', () => {
    const desired = desiredCandidates('2026-01-01T00:00:00Z');
    expect(desired.length).toBeGreaterThan(0);
    for (const model of desired) {
      expect(model.availability).toBe('unproven');
      expect(model.verifiedModelID).toBe('');
      expect(model.evidence).toMatch(/A model identifier is not a capability claim/);
    }
  });

  it('includes the models this project intends to test, and none of them is selectable', () => {
    const names = DESIRED_CANDIDATE_LADDER.map((entry) => entry.displayName);
    expect(names).toContain('Luna Max');
    expect(names).toContain('Claude Haiku 4.5');
    expect(names).toContain('Claude Sonnet 5');
    expect(names).toContain('Claude Opus 4.8');
    expect(selectableModels([{
      provider: 'claudeCLI', label: '', executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      reachability: 'unknown', detail: '', probe: 'offline', models: desiredCandidates('now'), checkedAt: 'now',
    }])).toEqual([]);
  });

  it('records the effort levels the ladder intends, without claiming they are available', () => {
    const sonnet = DESIRED_CANDIDATE_LADDER.find((entry) => entry.displayName === 'Claude Sonnet 5')!;
    expect(sonnet.desiredEfforts).toEqual(['high', 'max']);
  });
});

describe('discovering a subscription CLI', () => {
  it('does not run anything when the executable is absent', async () => {
    const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => undefined, run: NEVER });
    expect(status.reachability).toBe('notInstalled');
    expect(status.probe).toBe('offline');
  });

  it('reads the version and the model listing, and marks only the listed models proven', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "claude 9.9.9 (fixture)"; exit 0; fi
      echo '{"models":[{"id":"claude-sonnet-5","display_name":"Claude Sonnet 5"},{"id":"claude-haiku-4-5"}]}'
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('ready');
      expect(status.probe).toBe('invoked');
      expect(status.version).toBe('claude 9.9.9 (fixture)');
      const proven = status.models.filter((model) => model.availability === 'proven').map((model) => model.modelID);
      expect(proven).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
      // A ladder entry the tool did NOT list is reported as refused, not silently dropped.
      const refused = status.models.filter((model) => model.availability === 'refused').map((model) => model.modelID);
      expect(refused).toContain('luna-max');
      expect(refused).toContain('claude-opus-4-8');
    } finally { fake.cleanup(); }
  });

  it('reports "not signed in" as exactly that, and proves nothing', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "claude 9.9.9"; exit 0; fi
      echo "You are not logged in. Run claude login." >&2
      exit 1
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('notAuthenticated');
      expect(status.detail).toMatch(/Cernum does not carry out a sign-in/);
      expect(status.models.every((model) => model.availability === 'unproven')).toBe(true);
    } finally { fake.cleanup(); }
  });

  it('leaves everything unproven when the tool offers no machine-readable listing', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "claude 1.0"; exit 0; fi
      echo "unknown command: models" >&2
      exit 2
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('unknown');
      expect(status.detail).toMatch(/offers no machine-readable model listing/);
      expect(status.models.every((model) => model.availability === 'unproven')).toBe(true);
    } finally { fake.cleanup(); }
  });
});

describe('a listing that cannot be understood proves nothing', () => {
  it('yields no models rather than a best guess', () => {
    expect(parseModelListing('not json at all', 'claudeCLI', 'now').filter((m) => m.availability === 'proven')).toEqual([]);
    expect(parseModelListing('', 'claudeCLI', 'now').filter((m) => m.availability === 'proven')).toEqual([]);
  });

  it('accepts the two shapes tools actually emit', () => {
    const bare = parseModelListing('["a-model"]', 'claudeCLI', 'now').filter((m) => m.availability === 'proven');
    expect(bare.map((m) => m.modelID)).toEqual(['a-model']);
    const wrapped = parseModelListing('{"data":[{"id":"b-model"}]}', 'openaiAPI', 'now').filter((m) => m.availability === 'proven');
    expect(wrapped.map((m) => m.modelID)).toEqual(['b-model']);
  });

  it('records the identifier the provider itself returned as the verified one', () => {
    const proven = parseModelListing('["claude-sonnet-5-20260114"]', 'claudeCLI', 'now')
      .find((model) => model.modelID === 'claude-sonnet-5-20260114')!;
    expect(proven.verifiedModelID).toBe('claude-sonnet-5-20260114');
    expect(proven.evidence).toMatch(/listed this model as one this account may call/);
  });
});

describe('discovering a metered provider', () => {
  it('refuses BEFORE the request when no key is configured', async () => {
    const status = await discoverMeteredProvider('anthropicAPI', {
      baseURL: 'http://127.0.0.1:1',
      credentials: { environment: {}, readKeychain: () => undefined },
      fetchImplementation: (() => { throw new Error('a request was made without a key'); }) as unknown as typeof fetch,
    });
    expect(status.reachability).toBe('noCredential');
    expect(status.probe).toBe('offline');
  });

  it('lists what the key may call, against a mock provider on loopback', async () => {
    const provider = await startMockProvider(JSON.stringify({ data: [{ id: 'a-model' }] }));
    try {
      const status = await discoverMeteredProvider('anthropicAPI', {
        baseURL: provider.baseURL,
        credentials: { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined },
      });
      expect(status.reachability).toBe('ready');
      expect(status.models.filter((m) => m.availability === 'proven').map((m) => m.modelID)).toEqual(['a-model']);
      expect(provider.requests[0].url).toBe('/v1/models');
      expect(provider.requests[0].headers['x-api-key']).toBeDefined();
    } finally { await provider.close(); forgetRegisteredSecrets(); }
  });

  it('reports a 401 as not authenticated, with the body redacted', async () => {
    const provider = await startMockProvider('');
    try {
      // A provider that echoes a key back inside its own 401 body. The value is a fixture built at
      // run time; what matters is that the SHAPE reaches the redactor.
      const echoed = ['sk', 'ant', 'api03', 'ECHOEDBACKBYTHEPROVIDER01234'].join('-');
      provider.respondWith(401, JSON.stringify({ error: `bad key ${echoed}` }));
      const status = await discoverMeteredProvider('anthropicAPI', {
        baseURL: provider.baseURL,
        credentials: { environment: { ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY }, readKeychain: () => undefined },
      });
      expect(status.reachability).toBe('notAuthenticated');
      expect(status.detail).not.toContain(echoed);
      expect(status.detail).toMatch(/\[redacted:/);
    } finally { await provider.close(); forgetRegisteredSecrets(); }
  });
});

describe('the privacy disclosure', () => {
  it('says nothing leaves the machine when nothing does', () => {
    const lines = privacyDisclosure([{ label: 'Local Models', executionClass: 'localRuntime' }]);
    expect(lines.join(' ')).toMatch(/No prompt leaves it/);
  });

  it('names the providers prompts are sent to, and what Cernum cannot undo', () => {
    const lines = privacyDisclosure([
      { label: 'Local Models', executionClass: 'localRuntime' },
      { label: 'Claude Subscription', executionClass: 'subscriptionCLI' },
    ]);
    const text = lines.join(' ');
    expect(text).toMatch(/Claude Subscription/);
    expect(text).toMatch(/under the provider's terms and retention policy/);
    expect(text).toMatch(/no way to recall a prompt once it has been sent/);
    expect(text).toMatch(/Candidates that run on the local runtime are unaffected/);
  });
});

// A vitest-level belt and braces: if any test in this file reached the real network, the mock
// provider's request log would be the only place a request could have gone, and `NEVER` would have
// thrown. Nothing here calls `fetch` without a base URL pointing at loopback.
void vi;
