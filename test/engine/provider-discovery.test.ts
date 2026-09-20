// Discovery, and the promise that looking costs nothing.
//
// THE ASSERTION THIS FILE EXISTS FOR is that `offlineProviderStatuses` cannot reach a provider. It
// is tested by giving it a runner that FAILS THE TEST if it is ever called, rather than by reading
// the code and believing it — the difference between "we did not mean to" and "it cannot".

import { describe, expect, it, vi } from 'vitest';
import {
  DESIRED_CANDIDATE_LADDER, desiredCandidates, discoverMeteredProvider, discoverSubscriptionCLI,
  offlineProviderStatuses, parseModelListing, privacyDisclosure, ProviderStatus, selectableModels,
} from '../../src/engine/discovery';
import { forgetRegisteredSecrets } from '../../src/engine/redaction';
import { startMockProvider, writeFakeCLI } from './frontier-harness';
import { FIXTURE_ANTHROPIC_KEY } from '../secret-fixtures';

const NEVER = () => { throw new Error('a provider was contacted by something that promised not to'); };

describe('offline status contacts nothing', () => {
  it('answers for all six providers without invoking anything', () => {
    const statuses = offlineProviderStatuses({
      environment: {},
      readKeychain: () => undefined,
      findExecutable: () => undefined,
    });
    expect(statuses).toHaveLength(6);
    for (const status of statuses) expect(status.probe).toBe('offline');
    expect(statuses.map((status) => status.provider))
      .toEqual(['ollama', 'claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI']);
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

  // REWRITTEN IN PASS 5B, NOT DELETED. This test used to assert that the ladder contained a
  // `claudeCLI` entry called "Luna Max", which is how the mistake survived long enough to be written
  // into a report: Luna is an OpenAI model, the Claude CLI could only ever 404 on it, and the test
  // agreed with the defect. It now asserts the corrected classification, so a future attempt to put
  // a Codex model back under the Claude provider fails here.
  it('includes the models this project intends to test, and none of them is selectable', () => {
    const names = DESIRED_CANDIDATE_LADDER.map((entry) => entry.displayName);
    expect(names).toContain('GPT-5.6 Luna');
    expect(names).not.toContain('Luna Max');
    expect(DESIRED_CANDIDATE_LADDER.find((entry) => entry.displayName === 'GPT-5.6 Luna')!.provider)
      .toBe('codexCLI');
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

  it('reads the version and the AUTH STATUS, and still proves no model — because the tool lists none', async () => {
    // The real `claude` 2.1.251 shape, with the account identifiers removed. Pass 4B asked this tool
    // for `models list --json`; it has no `models` command at all, and this is what it does have.
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "2.1.251 (Claude Code)"; exit 0; fi
      if [ "$1" = "auth" ]; then
        echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'
        exit 0
      fi
      echo "unknown command" >&2; exit 1
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('ready');
      expect(status.probe).toBe('invoked');
      expect(status.version).toBe('2.1.251 (Claude Code)');
      expect(status.session).toEqual({
        loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max',
      });
      // SIGNED IN IS NOT PROVEN. The tool cannot list models, so nothing here may claim one works.
      expect(status.models.every((model) => model.availability === 'unproven')).toBe(true);
      expect(status.detail).toMatch(/offers NO model-listing command/);
      expect(status.detail).toMatch(/identity smoke test/);
    } finally { fake.cleanup(); }
  });

  it('keeps no account identifier out of a status, even when the tool volunteers one', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "2.1.251 (Claude Code)"; exit 0; fi
      echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"someone@example.test","orgId":"00000000-0000-0000-0000-000000000000","orgName":"Someone Org","projectsDirectory":"/somewhere/projects"}'
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      const serialised = JSON.stringify(status);
      for (const leak of ['someone@example.test', '00000000-0000-0000-0000-000000000000', 'Someone Org', '/somewhere/projects']) {
        expect(serialised).not.toContain(leak);
      }
      expect(status.session?.subscriptionType).toBe('max');
    } finally { fake.cleanup(); }
  });

  it('reports "not signed in" from the tool\'s own boolean, not from its prose', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "2.1.251 (Claude Code)"; exit 0; fi
      echo '{"loggedIn":false,"authMethod":"","apiProvider":"","subscriptionType":""}'
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('notAuthenticated');
      expect(status.detail).toMatch(/Cernum does not carry out a sign-in/);
      expect(status.models.every((model) => model.availability === 'unproven')).toBe(true);
    } finally { fake.cleanup(); }
  });

  it('refuses to guess from prose when the status is not machine-readable', async () => {
    // Pass 4B matched phrases like "not logged in" against stdout and stderr. A tool that prints
    // prose now gets `unknown`, because a benchmark that reads sentences changes its mind whenever
    // somebody edits one.
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "claude 1.0"; exit 0; fi
      echo "You are not logged in. Run claude login." >&2
      exit 2
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      expect(status.reachability).toBe('unknown');
      expect(status.detail).toMatch(/could not be read in a machine-readable form/);
      expect(status.detail).toMatch(/will not guess from prose|Nothing here will guess from prose/);
      expect(status.models.every((model) => model.availability === 'unproven')).toBe(true);
    } finally { fake.cleanup(); }
  });
});

describe('a listing that cannot be understood proves nothing', () => {
  it('yields no models rather than a best guess', () => {
    expect(parseModelListing('not json at all', 'claudeCLI', 'now')).toEqual([]);
    expect(parseModelListing('', 'claudeCLI', 'now')).toEqual([]);
  });

  it('accepts the two shapes tools actually emit', () => {
    const bare = parseModelListing('["a-model"]', 'claudeCLI', 'now').filter((m) => m.availability === 'unproven');
    expect(bare.map((m) => m.modelID)).toEqual(['a-model']);
    const wrapped = parseModelListing('{"data":[{"id":"b-model"}]}', 'openaiAPI', 'now').filter((m) => m.availability === 'unproven');
    expect(wrapped.map((m) => m.modelID)).toEqual(['b-model']);
  });
});

// THE INVARIANT M-1 RESTORED, ASSERTED ON THE PARSER THAT BROKE IT.
//
// A listing can establish that an identifier was advertised or visible to this account. It must
// never establish that a model ANSWERED — so no row it returns may be `proven`, and none may carry a
// `verifiedModelID`, which is the field a campaign freezes as the identity that replied. v0.2.4's
// parser wrote both from an OpenAI `/v1/models` response and made 130 models selectable, among them
// embedding and moderation endpoints that cannot answer an identity prompt at all.
describe('a listing is visibility, never execution', () => {
  it('records a listed model as DISCOVERED and UNPROVEN, with no verified identity', () => {
    const listed = parseModelListing('["claude-sonnet-5-20260114"]', 'claudeCLI', 'now')
      .find((model) => model.modelID === 'claude-sonnet-5-20260114')!;
    expect(listed.availability).toBe('unproven');
    expect(listed.verifiedModelID).toBe('');
    expect(listed.evidence).toMatch(/DISCOVERED, NOT PROVEN/);
    expect(listed.evidence).toMatch(/not a reply from a model/);
    expect(listed.evidence).toMatch(/identity smoke test/);
  });

  it('proves nothing from a metered API listing either, however many models it names', () => {
    const body = JSON.stringify({ data: [{ id: 'gpt-5.4' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }] });
    const rows = parseModelListing(body, 'openaiAPI', 'now');
    const listed = rows.filter((model) => ['gpt-5.4', 'text-embedding-3-small', 'whisper-1'].includes(model.modelID));
    expect(listed).toHaveLength(3);
    expect(rows.filter((model) => model.availability === 'proven')).toEqual([]);
    expect(rows.filter((model) => model.verifiedModelID !== '')).toEqual([]);
    // The four identifiers the OpenAI API identity ladder plans to ask for were NOT in this listing,
    // and are reported as absent rather than quietly dropped. An embedding or a speech endpoint that
    // WAS listed gets no such standing: it is one more unproven catalogue row.
    const planned = rows.filter((model) => !listed.includes(model));
    expect(planned.map((model) => model.modelID).sort())
      .toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra']);
    expect(planned.every((model) => model.availability === 'refused')).toBe(true);
  });

  it('never returns a selectable model, whatever the listing said', () => {
    const status: ProviderStatus = {
      provider: 'openaiAPI', label: 'OpenAI API', executionClass: 'meteredAPI', billingBasis: 'perToken',
      reachability: 'ready', detail: '', probe: 'invoked', checkedAt: 'now',
      models: parseModelListing('{"data":[{"id":"gpt-5.4"}]}', 'openaiAPI', 'now'),
    };
    expect(selectableModels([status])).toEqual([]);
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
      // LISTED, AND THEREFORE UNPROVEN. Reaching a key-scoped `/v1/models` says what the provider
      // advertises to this account; it is not a request to a model and does not make one selectable.
      expect(status.models.filter((m) => m.availability === 'unproven').map((m) => m.modelID)).toEqual(['a-model']);
      expect(status.models.every((m) => m.verifiedModelID === '')).toBe(true);
      expect(status.detail).toMatch(/advertises to this account/);
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
