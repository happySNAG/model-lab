// Shared harness for the frontier tests.
//
// EVERY TEST IN THIS DIRECTORY REACHES NOTHING. There is no network call, no real CLI invocation and
// no provider request anywhere in the frontier suite: subscription CLIs are fake executables written
// into a temporary directory, metered APIs are a loopback HTTP server this process owns, and the
// default adapter is scripted. That is not a convenience — it is the requirement, because the code
// paths under test are the ones that spend money.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { CampaignConfiguration } from '../../src/engine/campaign';
import { EngineCatalogue, buildEngineCatalogue } from '../../src/engine/catalogue';
import { RoutingHost } from '../../src/engine/frontier-host';
import { FrontierAdapter, ScriptedFrontierAdapter, ScriptedFrontierAnswer } from '../../src/engine/frontier-adapter';
import {
  DEFAULT_RETRY, NO_RETRY, OperationalEnvelope, PricingSnapshot, ProviderBinding, ProviderID,
  buildOperationalEnvelope, localOllamaBinding,
} from '../../src/engine/provider';
import { SpendTracker, SpendingAuthorization } from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SyntheticHost, SyntheticScript, steppingClock, syntheticCandidate } from '../../src/engine/synthetic';
import { guardPolicyForFrontierOnly } from '../../src/engine/guards';
import { DiscoveredFrontierModel } from '../../src/engine/discovery';

export const SUITES = ['suite.model-lab.foundation'];

/** Prices somebody wrote down, with where they came from. Never fetched, in the tests or in life. */
export const TEST_PRICING: PricingSnapshot = {
  source: 'a fixture, not a provider: these are not real prices and are never fetched',
  capturedAt: '2026-01-01T00:00:00Z',
  currency: 'USD',
  inputMicroUSDPerMillionTokens: 3_000_000,
  outputMicroUSDPerMillionTokens: 15_000_000,
  reasoningMicroUSDPerMillionTokens: null,
};

export function catalogue(repeats = 1): EngineCatalogue {
  return buildEngineCatalogue(SUITES, repeats);
}

export function localBinding(name: string): ProviderBinding {
  return localOllamaBinding({
    candidate: name,
    modelID: name,
    runtimeDigest: `digest-${name}`,
    thinkingMode: 'disabled',
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    timeoutMilliseconds: 60_000,
  });
}

export function subscriptionBinding(name: string, provider: ProviderID = 'claudeCLI',
                                    overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    candidate: name,
    provider,
    executionClass: 'subscriptionCLI',
    requestedModelID: name.includes(':') ? name.split(':').slice(1).join(':') : name,
    identityState: 'verified',
    verifiedModelID: name.includes(':') ? name.split(':').slice(1).join(':') : name,
    identityEvidence: 'a fixture: the fake CLI listed this model',
    effort: 'none',
    thinkingMode: 'disabled',
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    timeoutMilliseconds: 30_000,
    retry: NO_RETRY,
    billingBasis: 'subscriptionIncluded',
    pricing: null,
    authorizationMode: 'subscriptionCLISession',
    ...overrides,
  };
}

export function meteredBinding(name: string, provider: ProviderID = 'anthropicAPI',
                               overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    candidate: name,
    provider,
    executionClass: 'meteredAPI',
    requestedModelID: name.includes(':') ? name.split(':').slice(1).join(':') : name,
    identityState: 'verified',
    verifiedModelID: name.includes(':') ? name.split(':').slice(1).join(':') : name,
    identityEvidence: 'a fixture: the mock provider listed this model',
    effort: 'none',
    thinkingMode: 'disabled',
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    timeoutMilliseconds: 30_000,
    retry: DEFAULT_RETRY,
    billingBasis: 'meteredAPI',
    pricing: TEST_PRICING,
    authorizationMode: 'apiKeyEnvironment',
    ...overrides,
  };
}

export function envelopeOf(...bindings: ProviderBinding[]): OperationalEnvelope {
  return buildOperationalEnvelope(bindings);
}

/** The candidate list a manifest pins, derived from an envelope so the two always agree. */
export function candidatesFor(envelope: OperationalEnvelope) {
  return envelope.bindings.map((binding) => (binding.executionClass === 'localRuntime'
    ? syntheticCandidate(binding.candidate)
    : { name: binding.candidate, modelID: binding.requestedModelID, runtimeDigest: '', parameterSize: '', quantization: '' }));
}

export function configurationFor(envelope: OperationalEnvelope, overrides: Partial<CampaignConfiguration> = {}): CampaignConfiguration {
  const hasLocal = envelope.bindings.some((binding) => binding.executionClass === 'localRuntime');
  return {
    label: 'a frontier cohort',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    candidates: candidatesFor(envelope),
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'synthetic-runtime-1.0',
    storeBaseline: hasLocal ? SYNTHETIC_STORE_BASELINE : undefined,
    residencyDelayMilliseconds: 0,
    operationalEnvelope: envelope,
    // A frontier-only campaign has no benchmark lane on this machine and no model store to drift.
    // The synthetic reading satisfies the local policy, so the local case needs no override.
    guardPolicy: hasLocal ? undefined : guardPolicyForFrontierOnly(),
    ...overrides,
  };
}

/** A healthy machine, so a frontier-only campaign's guards are about the orchestration and not this disk. */
export const HEALTHY_MACHINE = {
  freeDiskBytes: 200 * 1024 ** 3,
  swapUsedBytes: 0,
  freeMemoryBytes: 16 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
  listeners: {} as Record<string, number>,
};

export interface HarnessOptions {
  envelope: OperationalEnvelope;
  /**
   * Give the synthetic local host a runtime identity, so a mixed campaign takes an endpoint lease.
   *
   * Off by default because a synthetic host deliberately reaches nothing and therefore contends for
   * nothing; a test about leasing has to opt in to being a host that reaches something.
   */
  localReachesARuntime?: boolean;
  adapters?: Partial<Record<ProviderID, FrontierAdapter>>;
  script?: SyntheticScript;
  authorization?: SpendingAuthorization;
  spend?: SpendTracker;
  shouldCancel?: () => boolean;
  repeats?: number;
  /** Prior ledger rows, for a resumed campaign's spend total. */
  priorRows?: Record<string, unknown>[];
}

/** A routing host whose local half is the deterministic synthetic host and whose frontier half is scripted. */
export function routingHost(options: HarnessOptions): { host: RoutingHost; spend: SpendTracker; adapters: Partial<Record<ProviderID, FrontierAdapter>> } {
  const hasLocal = options.envelope.bindings.some((binding) => binding.executionClass === 'localRuntime');
  const pinned = Object.fromEntries(candidatesFor(options.envelope).map((candidate) => [candidate.name, candidate]));
  let localHost: SyntheticHost | undefined = hasLocal ? new SyntheticHost(options.script ?? {}, steppingClock(), pinned) : undefined;
  if (localHost && options.localReachesARuntime) {
    // A host that genuinely reaches a runtime is the only kind that takes a lease on one.
    (localHost as SyntheticHost & { runtimeIdentity?: unknown }).runtimeIdentity = async () => ({
      endpoint: 'http://127.0.0.1:11434', modelStoreListingDigest: 'store-baseline-digest', modelStoreCount: 8,
    });
  }

  const adapters: Partial<Record<ProviderID, FrontierAdapter>> = { ...options.adapters };
  for (const binding of options.envelope.bindings) {
    if (binding.executionClass === 'localRuntime') continue;
    if (!adapters[binding.provider]) adapters[binding.provider] = new ScriptedFrontierAdapter(binding.provider);
  }

  const spend = options.spend ?? new SpendTracker(options.authorization, operationalEnvelopeDigest(options.envelope));
  return {
    host: new RoutingHost({
      envelope: options.envelope,
      catalogue: catalogue(options.repeats ?? 1),
      adapters,
      localHost,
      spend,
      now: steppingClock(),
      shouldCancel: options.shouldCancel,
      sleep: async () => undefined,
      readMachine: async () => HEALTHY_MACHINE,
    }),
    spend,
    adapters,
  };
}

export function scriptedAdapter(provider: ProviderID, byCandidate: Record<string, ScriptedFrontierAnswer> = {},
                                fallback?: ScriptedFrontierAnswer): ScriptedFrontierAdapter {
  return new ScriptedFrontierAdapter(provider, { byCandidate, fallback });
}

/** A model discovery has "proven", so the builder will accept it. Fixtures only; nothing was asked. */
export function provenModel(provider: ProviderID, modelID: string, efforts: string[] = ['none']): DiscoveredFrontierModel {
  return {
    provider,
    modelID,
    displayName: modelID,
    availability: 'proven',
    evidence: 'a fixture: this stands in for a discovery listing, and no provider was contacted to produce it',
    verifiedModelID: modelID,
    desiredEfforts: efforts,
    discoveredAt: '2026-01-01T00:00:00Z',
  };
}

export function temporaryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// MARK: - Fake executables, for the subscription-CLI paths

export interface FakeCLI {
  directory: string;
  executablePath: string;
  /** Where every invocation records its argv and stdin, so a test can assert what was actually sent. */
  logPath: string;
  invocations(): { args: string[]; stdin: string; env: Record<string, string> }[];
  cleanup(): void;
}

/**
 * Write a fake `claude`/`codex` onto disk.
 *
 * A shell script, not a mock object, because the thing under test is the CHILD PROCESS machinery:
 * the process group, the signal, the grace period and the kill. None of that is exercised by a stub
 * that resolves a promise.
 */
export function writeFakeCLI(name: string, body: string): FakeCLI {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-'));
  const executablePath = path.join(directory, name);
  const logPath = path.join(directory, 'invocations.jsonl');
  fs.writeFileSync(executablePath, `#!/bin/sh\nLOG='${logPath}'\n${body}\n`, 'utf8');
  fs.chmodSync(executablePath, 0o755);
  return {
    directory,
    executablePath,
    logPath,
    invocations() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; stdin: string; env: Record<string, string> });
    },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

// MARK: - A mock metered provider, on loopback

export interface MockProvider {
  baseURL: string;
  requests: { url: string; headers: Record<string, string>; body: string }[];
  /** Set to make the next request answer with this status and body. */
  respondWith(status: number, body: string, contentType?: string): void;
  /** Stream these SSE frames instead of a single body. */
  streamFrames(frames: string[]): void;
  close(): Promise<void>;
}

export async function startMockProvider(defaultBody: string): Promise<MockProvider> {
  let status = 200;
  let body = defaultBody;
  let contentType = 'application/json';
  let frames: string[] | undefined;
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];

  const server = http.createServer((request, response) => {
    let received = '';
    request.on('data', (chunk) => { received += chunk; });
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
        body: received,
      });
      if (frames) {
        response.writeHead(status, { 'content-type': 'text/event-stream' });
        for (const frame of frames) response.write(`data: ${frame}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(status, { 'content-type': contentType });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    respondWith(nextStatus, nextBody, nextContentType = 'application/json') {
      status = nextStatus; body = nextBody; contentType = nextContentType; frames = undefined;
    },
    streamFrames(nextFrames) { frames = nextFrames; status = 200; },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
