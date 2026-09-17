// Cernum · OpenCode provider support.
//
// EVERY FIXTURE BELOW IS VERBATIM OUTPUT from `opencode-ai@1.18.31` on macOS 15.7.7, captured with
// `cat -v` before the parsers were written. Nothing here is a plausible-looking invention of what the
// tool might print, because the one time this engine wrote a CLI adapter from assumption -- Pass 4B's
// `claude models list --json`, against a CLI with no `models` command -- discovery returned `unknown`
// on every run and no test noticed, since the test used the assumed shape too.

import { describe, expect, it } from 'vitest';
import {
  OPENCODE_EXECUTABLE, UNION_ALPHA_MODEL_ID, OPENCODE_COST_PROVENANCE,
  parseOpenCodeVersion, parseOpenCodeModels, parseOpenCodeCredentials,
  opencodeHasCredential, opencodeCredentialDisclosure,
} from '../../src/engine/opencode-cli';
import { discoverOpenCodeCLI, offlineProviderStatuses, DESIRED_CANDIDATE_LADDER, selectableModels } from '../../src/engine/discovery';
import { PROVIDER_IDS, executionClassOf, billingBasisOf, PROVIDER_LABELS } from '../../src/engine/provider';

const ESC = '\x1b';
const REAL_VERSION = '1.18.31\n';
const REAL_CREDENTIALS = [
  `${ESC}[0m`,
  `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`,
  '│',
  `◗  OpenCode Zen ${ESC}[90mapi`,
  '│',
  '└  1 credentials',
  '',
].join('\n');
const REAL_MODELS = [
  'opencode/big-pickle', 'opencode/claude-opus-5', 'opencode/gpt-5.4',
  'opencode/union-alpha', 'opencode/gemini-3.1-pro', '',
].join('\n');

/** The help screen `opencode models --json` actually prints, and exits 0 while printing it. */
const HELP_SCREEN = [
  'opencode models [provider]', '', 'list all available models', '',
  'Positionals:', '  provider  path to start opencode in                    [string]', '',
].join('\n');

function fakeRun(byArgs: Record<string, string>) {
  return async ({ args }: { args: string[] }) => ({
    stdout: byArgs[args.join(' ')] ?? '', stderr: '', exitCode: 0, signal: null,
    elapsedMilliseconds: 1, firstByteMilliseconds: 1, failure: undefined,
  }) as any;
}
const READY = fakeRun({ '--version': REAL_VERSION, 'providers list': REAL_CREDENTIALS, models: REAL_MODELS });
const here = () => '/usr/local/bin/opencode';
const NOW = () => new Date('2026-09-16T12:00:00Z');

describe('OpenCode · the provider is registered as what it actually is', () => {
  it('is a known provider', () => {
    expect(PROVIDER_IDS).toContain('opencodeCLI');
    expect(PROVIDER_LABELS.opencodeCLI).toBeTruthy();
  });

  it('is METERED, not a subscription — the credential it carries is an API key', () => {
    expect(executionClassOf('opencodeCLI')).toBe('meteredAPI');
    expect(billingBasisOf(executionClassOf('opencodeCLI'))).toBe('meteredAPI');
    // The failure this guards: `subscriptionIncluded` would stamp a zero marginal charge on a
    // per-token bill, which is the misreport `codexCLI` already refuses by hand.
    expect(billingBasisOf(executionClassOf('opencodeCLI'))).not.toBe('subscriptionIncluded');
  });

  it('never claims a cost it cannot know', () => {
    expect(OPENCODE_COST_PROVENANCE).toBe('unavailable');
  });

  it('carries Union Alpha at OpenCode\'s own provider/model address, born unproven', () => {
    const entry = DESIRED_CANDIDATE_LADDER.find((e) => e.modelID === UNION_ALPHA_MODEL_ID);
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('opencodeCLI');
    expect(UNION_ALPHA_MODEL_ID).toBe('opencode/union-alpha');
  });
});

describe('OpenCode · the parsers refuse what they do not recognise', () => {
  it('reads the bare version OpenCode prints', () => {
    expect(parseOpenCodeVersion(REAL_VERSION)).toBe('1.18.31');
  });

  it('records no version rather than recording a help screen as one', () => {
    expect(parseOpenCodeVersion(HELP_SCREEN)).toBeUndefined();
    expect(parseOpenCodeVersion('command not found')).toBeUndefined();
  });

  it('reads provider/model lines', () => {
    expect(parseOpenCodeModels(REAL_MODELS)).toContain(UNION_ALPHA_MODEL_ID);
    expect(parseOpenCodeModels(REAL_MODELS)).toHaveLength(5);
  });

  it('reads NOTHING out of the help screen `models --json` prints', () => {
    // `opencode models --json` prints this and exits 0. A tolerant parser reads `Positionals:`
    // or `provider  path to start opencode in` as a model identifier.
    expect(parseOpenCodeModels(HELP_SCREEN)).toEqual([]);
  });

  it('reads the credential kind across the colour escape that delimits it', () => {
    const parsed = parseOpenCodeCredentials(REAL_CREDENTIALS);
    expect(parsed.reportedCount).toBe(1);
    expect(parsed.credentials).toEqual([{ service: 'OpenCode Zen', kind: 'api' }]);
    expect(opencodeHasCredential(parsed)).toBe(true);
  });

  it('never reads the box-drawing header as a service', () => {
    const services = parseOpenCodeCredentials(REAL_CREDENTIALS).credentials.map((c) => c.service);
    expect(services).not.toContain('Credentials');
  });

  it('keeps no account identifier, and claims no validity', () => {
    const disclosure = opencodeCredentialDisclosure(parseOpenCodeCredentials(REAL_CREDENTIALS));
    expect(disclosure).toContain('OpenCode Zen');
    expect(disclosure).toContain('api');
    expect(disclosure).toContain('not a claim that it is valid');
    expect(disclosure).not.toContain('auth.json');
  });

  it('says so when nothing is configured', () => {
    const empty = parseOpenCodeCredentials('┌  Credentials\n└  0 credentials\n');
    expect(opencodeHasCredential(empty)).toBe(false);
    expect(opencodeCredentialDisclosure(empty)).toContain('no configured credential');
  });
});

describe('OpenCode · availability is detected, never assumed', () => {
  it('reports notInstalled without running anything when it is not on PATH', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: () => undefined, now: NOW, run: async () => { throw new Error('nothing should run'); } });
    expect(status.reachability).toBe('notInstalled');
    expect(status.probe).toBe('offline');
    expect(status.models).toEqual([]);
    expect(status.detail).toContain(OPENCODE_EXECUTABLE);
  });

  it('DISCOVERS a model OpenCode named, and refuses to call that proof', async () => {
    // v0.2.1 wrote `proven` here, on the strength of a listing OpenCode reads out of a cached
    // catalogue of thousands of models it has never called. `proven` is the state a campaign may
    // select, so that turned a file on disk into permission to spend.
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(status.reachability).toBe('ready');
    expect(status.version).toBe('1.18.31');
    const union = status.models.find((m) => m.modelID === UNION_ALPHA_MODEL_ID)!;
    expect(union.availability).toBe('unproven');
    // Nothing came back from a model, so there is no identifier a provider returned.
    expect(union.verifiedModelID).toBe('');
    expect(union.evidence).toContain('DISCOVERED, NOT PROVEN');
    expect(selectableModels([status]).map((m) => m.modelID)).not.toContain(UNION_ALPHA_MODEL_ID);
  });

  it('proves NOTHING at all from a successful, authenticated, fully-listed discovery', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    // OpenCode ran, held a credential and named five models. Not one of them is selectable.
    expect(status.reachability).toBe('ready');
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.some((m) => m.availability === 'proven')).toBe(false);
    expect(selectableModels([status])).toEqual([]);
  });

  it('records a planned model OpenCode did NOT list as refused, never as quietly absent', async () => {
    const withoutUnion = fakeRun({
      '--version': REAL_VERSION, 'providers list': REAL_CREDENTIALS,
      models: 'opencode/big-pickle\nopencode/gpt-5.4\n',
    });
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: withoutUnion });
    const union = status.models.find((m) => m.modelID === UNION_ALPHA_MODEL_ID)!;
    expect(union.availability).toBe('refused');
    expect(selectableModels([status]).map((m) => m.modelID)).not.toContain(UNION_ALPHA_MODEL_ID);
    expect(status.detail).toContain('NOT named');
  });

  it('stops at noCredential before asking for a model listing', async () => {
    const asked: string[] = [];
    const noCredential = async ({ args }: { args: string[] }) => {
      asked.push(args.join(' '));
      return { stdout: args[0] === '--version' ? REAL_VERSION : '└  0 credentials\n',
               stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 1, failure: undefined } as any;
    };
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: noCredential });
    expect(status.reachability).toBe('noCredential');
    expect(asked).not.toContain('models');
  });

  it('reports an empty listing as a question unanswered, not as "no models exist"', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW,
      run: fakeRun({ '--version': REAL_VERSION, 'providers list': REAL_CREDENTIALS, models: HELP_SCREEN }) });
    expect(status.reachability).toBe('unreachable');
    expect(status.models).toEqual([]);
  });

  it('spends nothing: discovery never invokes a model', async () => {
    const asked: string[] = [];
    await discoverOpenCodeCLI({ findExecutable: here, now: NOW,
      run: async ({ args }: { args: string[] }) => {
        asked.push(args.join(' '));
        return { stdout: args[0] === '--version' ? REAL_VERSION : args[0] === 'providers' ? REAL_CREDENTIALS : REAL_MODELS,
                 stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 1, failure: undefined } as any;
      } });
    expect(asked).toEqual(['--version', 'providers list', 'models']);
    expect(asked.some((a) => a.startsWith('run'))).toBe(false);
  });
});

describe('OpenCode · the offline status view does not throw and does not guess', () => {
  it('reports it by PATH lookup, without reading any API-key environment variable', () => {
    // The trap this covers: OpenCode is `meteredAPI`, and the API branch calls `credentialStatus`,
    // which THROWS for a provider that has no environment variable to read.
    const statuses = offlineProviderStatuses({ findExecutable: () => undefined, now: NOW });
    const opencode = statuses.find((s) => s.provider === 'opencodeCLI')!;
    expect(opencode.reachability).toBe('notInstalled');
    expect(opencode.probe).toBe('offline');
    expect(opencode.credential).toBeUndefined();
  });

  it('says a request is billed per token when the CLI is present', () => {
    const statuses = offlineProviderStatuses({ findExecutable: here, now: NOW });
    const opencode = statuses.find((s) => s.provider === 'opencodeCLI')!;
    expect(opencode.reachability).toBe('unknown');
    expect(opencode.detail).toContain('billed per token');
  });

  it('still reports every other provider', () => {
    const statuses = offlineProviderStatuses({ findExecutable: () => undefined, now: NOW });
    expect(statuses.map((s) => s.provider).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});
