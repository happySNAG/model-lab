// Credentials: where they come from, how a missing one fails, and everywhere a present one must not
// appear.
//
// The second half of this file is the one that matters. It is easy to test that a key can be read.
// What is worth testing is that a key which HAS been read cannot then escape into a ledger row, an
// event, a report, a terminal line or a test fixture — including by the indirect routes, where a
// provider echoes an Authorization header into an error and the engine dutifully records the error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CredentialError, allCredentialStatuses, authorizationModeFor, credentialStatus,
  credentialVariableNames, environmentVariableFor, isMeteredProvider, requireCredential, resolveCredential,
} from '../../src/engine/credentials';
import {
  environmentWithoutCredentials, forgetRegisteredSecrets, maskCredential, redactSecrets, redactValue,
  registerSecret, scanForSecrets,
} from '../../src/engine/redaction';
import { Campaign } from '../../src/engine/campaign';
import { configurationFor, envelopeOf, meteredBinding, routingHost, scriptedAdapter, temporaryRoot } from './frontier-harness';
import { authorizeSpending, estimateSpending } from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { plannedWorkFor } from '../../src/engine/campaign-builder';
import { catalogue } from './frontier-harness';
import {
  FIXTURE_ANTHROPIC_KEY, FIXTURE_BEARER_HEADER, FIXTURE_GITHUB_TOKEN, FIXTURE_JWT,
  FIXTURE_OPENAI_PROJECT_KEY, FIXTURE_PRIVATE_KEY_BLOCK, FIXTURE_WORDLIKE_SECRET,
} from '../secret-fixtures';

// Assembled at run time by `test/secret-fixtures.ts`, so no credential-shaped literal exists in any
// committed file and a repository-wide secret scan comes back genuinely clean.
const A_KEY = FIXTURE_ANTHROPIC_KEY;
const AN_OPENAI_KEY = FIXTURE_OPENAI_PROJECT_KEY;

afterEach(() => forgetRegisteredSecrets());

describe('where a key comes from', () => {
  it('reads the environment first', () => {
    const resolved = resolveCredential('anthropicAPI', { environment: { ANTHROPIC_API_KEY: A_KEY } });
    expect(resolved.source).toBe('environment');
    expect(resolved.value).toBe(A_KEY);
  });

  it('falls back to the Keychain when the environment has nothing', () => {
    const resolved = resolveCredential('anthropicAPI', {
      environment: {},
      readKeychain: (service, account) => (service === 'cernum.anthropicAPI' && account === 'tester' ? A_KEY : undefined),
      account: 'tester',
    });
    expect(resolved.source).toBe('keychain');
    expect(authorizationModeFor(resolved.source)).toBe('apiKeyKeychain');
  });

  it('reports absence as an answer rather than an error', () => {
    const resolved = resolveCredential('anthropicAPI', { environment: {}, readKeychain: () => undefined });
    expect(resolved.source).toBe('absent');
    expect(resolved.value).toBeUndefined();
  });

  it('knows that a local runtime and a subscription CLI have no key to read', () => {
    expect(isMeteredProvider('ollama')).toBe(false);
    expect(isMeteredProvider('claudeCLI')).toBe(false);
    expect(isMeteredProvider('anthropicAPI')).toBe(true);
    expect(() => environmentVariableFor('claudeCLI')).toThrow(/authenticates itself/);
    expect(() => credentialStatus('claudeCLI')).toThrow(CredentialError);
  });

  it('names the variables without ever naming a value', () => {
    expect(credentialVariableNames()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });
});

describe('a missing credential fails cleanly, before anything is sent', () => {
  it('refuses with a message naming exactly what to set', () => {
    expect(() => requireCredential('anthropicAPI', { environment: {}, readKeychain: () => undefined }))
      .toThrow(/Export ANTHROPIC_API_KEY/);
    expect(() => requireCredential('anthropicAPI', { environment: {}, readKeychain: () => undefined }))
      .toThrow(/Nothing was sent, and no charge was incurred/);
  });

  it('says so in the status rather than leaving a screen to guess', () => {
    const status = credentialStatus('openaiAPI', { environment: {}, readKeychain: () => undefined });
    expect(status.present).toBe(false);
    expect(status.masked).toBe('not set');
    expect(status.remedy).toMatch(/Export OPENAI_API_KEY/);
    expect(status.remedy).toMatch(/never writes it to disk itself/);
  });

  it('reports both metered providers at once for a settings screen', () => {
    const statuses = allCredentialStatuses({ environment: { ANTHROPIC_API_KEY: A_KEY }, readKeychain: () => undefined });
    expect(statuses.map((status) => status.provider)).toEqual(['anthropicAPI', 'openaiAPI']);
    expect(statuses[0].present).toBe(true);
    expect(statuses[1].present).toBe(false);
  });
});

describe('a masked credential shows that something is there and nothing else', () => {
  it('carries no prefix, no suffix and no fragment of the value', () => {
    const masked = maskCredential(A_KEY);
    expect(masked).toMatch(/^set · \d+ characters/);
    expect(masked).not.toContain('sk-');
    expect(masked).not.toContain(A_KEY.slice(0, 4));
    expect(masked).not.toContain(A_KEY.slice(-4));
  });

  it('reports the absence of one plainly', () => {
    expect(maskCredential(undefined)).toBe('not set');
  });
});

describe('the scrubber recognises credential SHAPES, not just values it was told about', () => {
  it('removes a key it has never seen', () => {
    const text = `the provider said: invalid x-api-key ${A_KEY}`;
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain(A_KEY);
    expect(redacted).toMatch(/\[redacted:/);
  });

  it('removes an OpenAI project key, a bearer token, a JWT and a private key block', () => {
    const samples = [AN_OPENAI_KEY, FIXTURE_BEARER_HEADER, FIXTURE_JWT, FIXTURE_PRIVATE_KEY_BLOCK];
    for (const sample of samples) {
      const redacted = redactSecrets(`error: ${sample}`);
      expect(redacted, sample).not.toContain(sample);
    }
  });

  it('removes a token carried in a URL query string', () => {
    const redacted = redactSecrets('GET https://api.example/v1?api_key=abcdefghijklmnop&x=1 failed');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).toContain('api_key=');
  });

  it('removes a value it was TOLD about, even when the value looks like an ordinary word', () => {
    registerSecret(FIXTURE_WORDLIKE_SECRET);
    expect(redactSecrets(`the key is ${FIXTURE_WORDLIKE_SECRET}`)).not.toContain(FIXTURE_WORDLIKE_SECRET);
  });

  it('leaves digests, manifest ids and slot keys alone: those are meant to be readable', () => {
    const readable = 'manifest:14a0ccfb566ef74e · alpha:1b|suite.model-lab.foundation|1|case:foundation:json-shape '
      + '· 14a0ccfb566ef74e13460a5fcc67d1e33cc25c70bb89ca02f381ac30148180c6';
    expect(redactSecrets(readable)).toBe(readable);
  });

  it('is idempotent, because these strings pass through several layers on their way to disk', () => {
    const once = redactSecrets(`key ${A_KEY}`);
    expect(redactSecrets(once)).toBe(once);
  });

  it('walks a structure without changing its shape', () => {
    const value = { a: [{ b: FIXTURE_BEARER_HEADER }], c: 12, d: null };
    const redacted = redactValue(value);
    expect(redacted.c).toBe(12);
    expect(redacted.d).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_BEARER_HEADER.split(' ').pop()!);
  });

  it('scans a finished artefact and names what it found', () => {
    expect(scanForSecrets('nothing here')).toEqual([]);
    const found = scanForSecrets(`a file containing ${A_KEY}`);
    expect(found.map((entry) => entry.kind)).toContain('anthropicKey');
  });
});

describe('a subscription CLI never inherits this process\'s API keys', () => {
  it('strips every credential-bearing variable from the child environment', () => {
    const child = environmentWithoutCredentials({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: A_KEY,
      OPENAI_API_KEY: AN_OPENAI_KEY,
      SOME_ACCESS_TOKEN: 'abcdefghijklmnop',
      GITHUB_TOKEN: FIXTURE_GITHUB_TOKEN,
      MY_PASSWORD: 'hunter2hunter2',
    });
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/someone');
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.SOME_ACCESS_TOKEN).toBeUndefined();
    expect(child.GITHUB_TOKEN).toBeUndefined();
    expect(child.MY_PASSWORD).toBeUndefined();
    // A run the person authorised as subscription-included must not be able to bill their card.
    expect(Object.values(child)).not.toContain(A_KEY);
  });
});

describe('a credential cannot reach a campaign\'s artefacts, even by the indirect routes', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => {
    campaignRoot = temporaryRoot('frontier-secrets-');
    root = path.join(campaignRoot, 'run');
  });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  it('scrubs a key a provider echoed back inside an error, out of every file the run wrote', async () => {
    // The key is loaded the way a real run loads one, which is what registers it with the scrubber.
    const key = requireCredential('anthropicAPI', { environment: { ANTHROPIC_API_KEY: A_KEY } });
    expect(key).toBe(A_KEY);

    const envelope = envelopeOf(meteredBinding('anthropicAPI:m'));
    // A provider that echoes the request's own Authorization header back in its 401 body. This is
    // not hypothetical; it is how a key ends up in a log nobody meant to write it to.
    const adapter = scriptedAdapter('anthropicAPI', {}, {
      failure: { kind: 'refused', detail: `401 unauthorized: {"error":"bad key","x-api-key":"${A_KEY}"}` },
      usage: { inputTokens: 10, visibleOutputTokens: 0 },
      usageProvenance: 'providerReported',
      // The model itself repeats the key back in its answer, which the ledger stores verbatim.
      answerText: `your key is ${A_KEY}`,
    });
    const authorization = authorizeSpending(estimateSpending(envelope, plannedWorkFor(catalogue(1), ['anthropicAPI:m'], 1)), {
      campaignID: 'c', authorizedAt: 'now', authorizedBy: 'the test',
      hardCeilingMicroUSD: 1_000_000_000, operationalEnvelopeDigest: operationalEnvelopeDigest(envelope),
    });
    const { host } = routingHost({ envelope, adapters: { anthropicAPI: adapter }, authorization });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    campaign.writeAuthorization(authorization);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    campaign.finalize({ blindingSecret: 'a-blinding-secret-long-enough', authorization });

    // EVERY file the campaign wrote, read back off disk.
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full); else files.push(full);
      }
    };
    walk(campaignRoot);
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents, file).not.toContain(A_KEY);
      expect(scanForSecrets(contents), file).toEqual([]);
    }
    // And the redaction left a marker, so a reader can see something WAS removed rather than
    // wondering whether the field was simply empty.
    const results = fs.readFileSync(path.join(root, 'ledger/results.jsonl'), 'utf8');
    expect(results).toMatch(/\[redacted:/);
  });
});
