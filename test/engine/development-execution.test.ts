// Cernum development runner · Pass B — the isolated execution driver.
//
// The properties proven here are the ones a development benchmark is worthless without. A fixture
// must run ONLY in a disposable workspace; the real checkout must be unreachable rather than merely
// unvisited; and a request that never reached a model must not come back looking like a model that
// answered badly.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_NEVER_MEASURED_FAILURES, DEVELOPMENT_WORKSPACE_PREFIX, developmentPromptFor,
  executeDevelopmentAttempt,
} from '../../src/engine/development-execution';
import {
  DEVELOPMENT_EDIT_TOOLS, DEVELOPMENT_READ_ONLY_TOOLS, DEVELOPMENT_WORKSPACE_UNVERIFIED,
  FrontierAdapter, FrontierRequest, FrontierResponse, SubscriptionCLIAdapter, buildCLIArguments,
} from '../../src/engine/frontier-adapter';
import { DEVELOPMENT_ANSWER_PATH } from '../../src/core/development-benchmark';
import { developmentTaskByID, developmentSuites } from '../../src/core/development-catalog';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { IsolationError } from '../../src/engine/isolation';
import { DEFAULT_RETRY, ProviderBinding } from '../../src/engine/provider';
import { multiFileEditSuite } from '../../src/core/development-suites/multi-file-edit';
import { repositoryUnderstandingSuite } from '../../src/core/development-suites/repo-understanding';

const QUESTION_TASK = repositoryUnderstandingSuite.tasks[0];
const EDIT_TASK = multiFileEditSuite.tasks[0];

function binding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    candidate: 'claudeCLI:test', provider: 'claudeCLI', executionClass: 'subscriptionCLI',
    requestedModelID: 'test-model', identityState: 'unverifiable', verifiedModelID: '',
    identityEvidence: 'nothing established it', effort: 'none', thinkingMode: 'runtimeDefault',
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: 1_000, maxOutputTokens: 1_000, timeoutMilliseconds: 10_000,
    retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    billingBasis: 'subscriptionIncluded', pricing: null, authorizationMode: 'subscriptionCLISession',
    ...overrides,
  };
}

/** An adapter that does whatever the test asks with the workspace it is handed. */
function adapterThat(
  act: (request: FrontierRequest) => Partial<FrontierResponse> | void,
): FrontierAdapter & { seen: FrontierRequest[] } {
  const seen: FrontierRequest[] = [];
  return {
    provider: 'claudeCLI',
    seen,
    async complete(request: FrontierRequest): Promise<FrontierResponse> {
      seen.push(request);
      const overrides = act(request) ?? {};
      return {
        answerText: '{}', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
        totalElapsedMilliseconds: 5, retryCount: 0, wastedTokens: 0, ...overrides,
      };
    },
  };
}

function run(task = QUESTION_TASK, adapter: FrontierAdapter = adapterThat(() => undefined), overrides = {}) {
  return executeDevelopmentAttempt({
    task, repo: ledgerlite, binding: binding(), adapter,
    runID: 'mldrun1:test', slotKey: 'c|s|1|t', sleep: async () => undefined, ...overrides,
  });
}

describe('the fixture runs only inside a disposable workspace', () => {
  it('materializes the sealed fixture into a fresh temp directory and makes it the model\'s cwd', async () => {
    let observedRoot = '';
    let fileCountInside = 0;
    const adapter = adapterThat((request) => {
      observedRoot = request.developmentWorkspace!.root;
      fileCountInside = fs.readdirSync(observedRoot).length;
    });
    const outcome = await run(QUESTION_TASK, adapter);

    expect(outcome.workspaceRoot).toBe(observedRoot);
    expect(path.basename(observedRoot).startsWith(DEVELOPMENT_WORKSPACE_PREFIX)).toBe(true);
    expect(fs.realpathSync(path.dirname(observedRoot))).toBe(fs.realpathSync(os.tmpdir()));
    expect(fileCountInside).toBeGreaterThan(0);
    // Every sealed file reached it, and the reading found them all.
    expect(outcome.reading.fileCount).toBe(ledgerlite.files.length);
  });

  it('is not the Cernum checkout, and is not any ancestor of it', async () => {
    const outcome = await run();
    const root = fs.realpathSync(os.tmpdir());
    expect(outcome.workspaceRoot.startsWith(root)).toBe(true);
    expect(fs.realpathSync(process.cwd()).startsWith(outcome.workspaceRoot)).toBe(false);
    expect(outcome.workspaceRoot).not.toBe(fs.realpathSync(process.cwd()));
  });

  it('deletes the workspace when the attempt succeeds', async () => {
    const outcome = await run();
    expect(fs.existsSync(outcome.workspaceRoot)).toBe(false);
  });

  it('deletes the workspace when the attempt fails, and still reads the repository back first', async () => {
    const adapter = adapterThat((request) => {
      fs.writeFileSync(path.join(request.developmentWorkspace!.root, 'scratch.txt'), 'written before failing');
      return { failure: { kind: 'transport', detail: 'the socket closed' }, answerText: '' };
    });
    const outcome = await run(EDIT_TASK, adapter);
    expect(outcome.reading.snapshot.get('scratch.txt')).toBe('written before failing');
    expect(fs.existsSync(outcome.workspaceRoot)).toBe(false);
  });

  it('deletes the workspace even when the adapter throws', async () => {
    let root = '';
    const adapter: FrontierAdapter = {
      provider: 'claudeCLI',
      async complete(request) {
        root = request.developmentWorkspace!.root;
        throw new Error('the adapter exploded');
      },
    };
    await expect(run(QUESTION_TASK, adapter)).rejects.toThrow('the adapter exploded');
    expect(root.length).toBeGreaterThan(0);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('the real repository cannot be edited', () => {
  it('refuses an absolute path through the workspace fence', async () => {
    const target = path.join(process.cwd(), 'package.json');
    const before = fs.readFileSync(target, 'utf8');
    let refusal: unknown;
    await run(EDIT_TASK, adapterThat((request) => {
      try {
        (request as { workspaceHandle?: never });
      } catch { /* unreachable */ }
    }), {
      inspectWorkspace: (workspace: { resolve: (relative: string) => string }) => {
        try { workspace.resolve(target); } catch (error) { refusal = error; }
      },
    });
    expect(refusal).toBeInstanceOf(IsolationError);
    expect((refusal as Error).message).toMatch(/refusing an absolute path/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a traversal out of the workspace, and the checkout is unchanged', async () => {
    const before = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
    let refusal: unknown;
    await run(EDIT_TASK, adapterThat(() => undefined), {
      inspectWorkspace: (workspace: { resolve: (relative: string) => string }) => {
        try { workspace.resolve('../../../../package.json'); } catch (error) { refusal = error; }
      },
    });
    expect(refusal).toBeInstanceOf(IsolationError);
    expect((refusal as Error).message).toMatch(/resolves outside the workspace/);
    expect(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).toBe(before);
  });

  it('takes no repository path, so there is no parameter a checkout could arrive through', () => {
    // Read with the prose stripped out: the module's header DESCRIBES the defaults it does not have,
    // and a check that could not tell a comment from a call would be satisfied by deleting the
    // explanation. What must be absent is the code.
    const code = fs.readFileSync('src/engine/development-execution.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/process\.cwd\(\)/);
    expect(code).not.toMatch(/repositoryPath|checkoutPath|projectRoot/);
    expect(code).not.toMatch(/readFileSync|readdirSync/);
  });
});

describe('what the attempt left behind', () => {
  it('reads an edit back out of the workspace', async () => {
    const adapter = adapterThat((request) => {
      const root = request.developmentWorkspace!.root;
      fs.writeFileSync(path.join(root, 'src', 'config', 'rates.json'), '{"changed":true}\n');
      fs.mkdirSync(path.join(root, 'src', 'core', 'stages'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'core', 'stages', 'surcharge.js'), '// new\n');
    });
    const outcome = await run(EDIT_TASK, adapter);
    expect(outcome.reading.snapshot.get('src/config/rates.json')).toBe('{"changed":true}\n');
    expect(outcome.reading.snapshot.get('src/core/stages/surcharge.js')).toBe('// new\n');
    expect(outcome.reading.bounded).toBe(false);
  });

  it('reports paths with forward slashes whatever the platform separator is', async () => {
    const outcome = await run();
    for (const key of outcome.reading.snapshot.keys()) expect(key).not.toContain('\\');
    expect([...outcome.reading.snapshot.keys()]).toContain('src/core/charge-pipeline.js');
  });
});

describe('the prompt a development attempt is sent', () => {
  it('names the working directory on a read-only task, forbids modification, and asks for the answer as the reply', () => {
    const prompt = developmentPromptFor(QUESTION_TASK);
    expect(prompt.user).not.toContain(DEVELOPMENT_ANSWER_PATH);
    expect(prompt.user).toContain('Do not modify it');
    expect(prompt.user).toContain('ONLY the required JSON object');
    expect(prompt.system).toBe(QUESTION_TASK.prompt.system);
  });

  it('asks an edit task to change the repository in place', () => {
    expect(developmentPromptFor(EDIT_TASK).user).toContain('Make the change in place');
    expect(developmentPromptFor(EDIT_TASK).user).not.toContain(DEVELOPMENT_ANSWER_PATH);
  });

  it('does not carry the fixture text, which would measure the prompt rather than the repository', () => {
    const prompt = developmentPromptFor(QUESTION_TASK);
    const someSource = ledgerlite.files.find((file) => file.role === 'source')!;
    expect(prompt.user).not.toContain(someSource.contents);
  });
});

describe('the tools a development turn is given', () => {
  it('leaves the text benchmark\'s arguments byte-for-byte unchanged', () => {
    const args = buildCLIArguments(binding()).args;
    expect(args).toEqual([
      '-p', '--output-format', 'json',
      '--tools', '',
      '--disable-slash-commands', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence',
      '--model', 'test-model',
    ]);
    expect(args).not.toContain('--restricted');
    expect(args).not.toContain('--permission-mode');
  });

  it('gives a read-only task reading tools, no editing tool and no edit permission', () => {
    const args = buildCLIArguments(binding(), { developmentWorkspace: { root: '/tmp/w', writable: false } }).args;
    expect(args).toContain(DEVELOPMENT_READ_ONLY_TOOLS);
    expect(args).toContain('--restricted');
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain(DEVELOPMENT_EDIT_TOOLS);
  });

  it('gives an edit task editing tools and accepts its edits', () => {
    const args = buildCLIArguments(binding(), { developmentWorkspace: { root: '/tmp/w', writable: true } }).args;
    expect(args).toContain(DEVELOPMENT_EDIT_TOOLS);
    expect(args).toContain('--restricted');
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
  });

  it('never gives a development turn a shell, on either task kind', () => {
    for (const writable of [false, true]) {
      const tools = buildCLIArguments(binding(), { developmentWorkspace: { root: '/tmp/w', writable } })
        .args.join(' ');
      expect(tools).not.toContain('Bash');
    }
    expect(DEVELOPMENT_READ_ONLY_TOOLS).not.toContain('Bash');
    expect(DEVELOPMENT_EDIT_TOOLS).not.toContain('Bash');
  });

  it('refuses a development workspace on a provider whose shape nobody has verified', () => {
    const codex = buildCLIArguments(binding({ provider: 'codexCLI', executionClass: 'subscriptionCLI' }),
      { developmentWorkspace: { root: '/tmp/w', writable: true } });
    expect(codex.unexpressed.join(' ')).toContain(DEVELOPMENT_WORKSPACE_UNVERIFIED);
  });

  it('refuses to SEND a development request on an unverified provider, rather than sending it anyway', async () => {
    const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: '/nonexistent/codex' });
    const response = await adapter.complete({
      binding: binding({ provider: 'codexCLI' }),
      promptText: 'x',
      developmentWorkspace: { root: os.tmpdir(), writable: true },
    });
    expect(response.failure?.kind).toBe('budgetRefused');
    expect(response.failure?.detail).toContain('was not sent');
  });
});

describe('a transport failure is never a model failure', () => {
  const cases = [
    { kind: 'transport' as const, detail: 'the socket closed', disposition: 'transportFailed' },
    { kind: 'notInstalled' as const, detail: 'the claude command is not on this PATH', disposition: 'transportFailed' },
    { kind: 'notAuthenticated' as const, detail: 'not logged in', disposition: 'providerUnauthenticated' },
    { kind: 'rateLimited' as const, detail: '429 too many requests', disposition: 'providerCapacityExhausted' },
    { kind: 'refused' as const, detail: 'HTTP 404 unknown model', disposition: 'providerRejectedRequest' },
    { kind: 'contentFiltered' as const, detail: 'the response was flagged by content filters', disposition: 'providerRefusedContent' },
  ];

  for (const entry of cases) {
    it(`records ${entry.kind} as ${entry.disposition} and refuses to grade it`, async () => {
      const outcome = await run(QUESTION_TASK, adapterThat(() => ({
        failure: { kind: entry.kind, detail: entry.detail }, answerText: '',
      })));
      expect(outcome.disposition).toBe(entry.disposition);
      expect(outcome.evaluable).toBe(false);
      expect(outcome.notEvaluableBecause).toContain('NOT MEASURED');
      expect(outcome.failure?.kind).toBe(entry.kind);
    });
  }

  it('reads an exhausted allowance out of the MESSAGE even when the adapter labelled it transport', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      failure: { kind: 'transport', detail: "You've hit your usage limit. Try again at Sep 21st, 2026 1:55 AM" },
      answerText: '',
    })));
    expect(outcome.disposition).toBe('providerCapacityExhausted');
    expect(outcome.evaluable).toBe(false);
  });

  it('leaves a timeout gradeable, because a model that cannot finish in budget is a capability outcome', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      failure: { kind: 'timeout', detail: 'the request exceeded its budget' }, answerText: '',
    })));
    expect(outcome.disposition).toBe('modelAnswered');
    // Graded against whatever the workspace holds, exactly as a timeout is scoreable in the text
    // benchmark. It is a failure of the model, not an absence of evidence.
    expect(outcome.evaluable).toBe(true);
  });

  it('leaves an unparseable answer gradeable, because that is a format outcome of this path', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      failure: { kind: 'malformedResponse', detail: 'the output is not the documented JSON form' }, answerText: '',
    })));
    expect(outcome.evaluable).toBe(true);
  });

  it('refuses to grade a request that was never sent, or one a different model answered', async () => {
    for (const kind of DEVELOPMENT_NEVER_MEASURED_FAILURES) {
      const outcome = await run(QUESTION_TASK, adapterThat(() => ({
        failure: { kind, detail: `refused as ${kind}` }, answerText: '',
      })));
      expect(outcome.evaluable).toBe(false);
      expect(outcome.notEvaluableBecause).toContain('before any model answered it');
    }
  });

  it('marks a clean answer evaluable', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({ answerText: '{"ok":true}' })));
    expect(outcome.disposition).toBe('modelAnswered');
    expect(outcome.evaluable).toBe(true);
    expect(outcome.notEvaluableBecause).toBeUndefined();
    expect(outcome.answerText).toBe('{"ok":true}');
  });

  it('redacts a secret a provider echoed into its own error', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      failure: { kind: 'transport', detail: 'Authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF' },
      answerText: '',
    })));
    expect(outcome.failure?.detail).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF');
  });
});

describe('telemetry, through the existing frontier-metrics infrastructure', () => {
  it('records every input token including the cached ones, not the fresh remainder', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      usage: { inputTokens: 2, cacheCreationInputTokens: 6_551, cacheReadInputTokens: 100, visibleOutputTokens: 40 },
      usageProvenance: 'providerReported',
    })));
    expect(outcome.record.inputTokens).toBe(6_653);
    expect(outcome.record.freshInputTokens).toBe(2);
    expect(outcome.record.cacheCreationInputTokens).toBe(6_551);
    expect(outcome.record.visibleOutputTokens).toBe(40);
    expect(outcome.record.usageProvenance).toBe('providerReported');
  });

  it('records a subscription\'s allowance as spent rather than as free', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      usage: { inputTokens: 10, visibleOutputTokens: 5 }, usageProvenance: 'providerReported',
      subscriptionIncludedUsageMicroUSD: 35_257,
    })));
    expect(outcome.record.costMicroUSD).toBe(0);
    expect(outcome.record.subscriptionIncludedUsageMicroUSD).toBe(35_257);
    expect(outcome.record.subscriptionAllowanceState).toBe('reported');
    expect(outcome.record.subscriptionAllowanceExplanation).toContain('NOT a charge');
  });

  it('says the allowance is unknown, never zero, when the provider valued nothing', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({
      usage: { inputTokens: 10, visibleOutputTokens: 5 }, usageProvenance: 'providerReported',
    })));
    expect(outcome.record.subscriptionAllowanceState).toBe('unavailable');
    expect(outcome.record.subscriptionIncludedUsageMicroUSD).toBeUndefined();
    expect(outcome.record.subscriptionAllowanceExplanation).toContain('It is NOT zero');
  });

  it('carries the provider, the requested model and what the provider named', async () => {
    const outcome = await run(QUESTION_TASK, adapterThat(() => ({ reportedModelID: 'test-model-20260101' })));
    expect(outcome.record.provider).toBe('claudeCLI');
    expect(outcome.record.requestedModelID).toBe('test-model');
    expect(outcome.record.reportedModelID).toBe('test-model-20260101');
    expect(outcome.record.billingBasis).toBe('subscriptionIncluded');
  });

  it('records a retry history on every attempt, so "none" is distinct from "nobody looked"', async () => {
    const clean = await run(QUESTION_TASK, adapterThat(() => undefined));
    expect(clean.retryCount).toBe(0);
    expect(clean.retryDetail).toContain('was not retried');

    let calls = 0;
    const flaky = adapterThat(() => {
      calls += 1;
      return calls === 1
        ? { failure: { kind: 'transport' as const, detail: 'reset' }, usage: { inputTokens: 9, visibleOutputTokens: 1 } }
        : { answerText: '{"ok":true}' };
    });
    const retried = await run(QUESTION_TASK, flaky, {
      binding: binding({ retry: { ...DEFAULT_RETRY, maxRetries: 2, backoffMilliseconds: 0 } }),
    });
    expect(retried.retryCount).toBe(1);
    expect(retried.retryDetail).toContain('retried 1 time');
    expect(retried.record.wastedTokens).toBe(10);
    expect(retried.evaluable).toBe(true);
  });
});

describe('every registered task can be driven through the driver', () => {
  it('runs each one in its own workspace and reads each one back', async () => {
    for (const suite of developmentSuites) {
      for (const task of suite.tasks) {
        expect(developmentTaskByID(task.id)).toBeDefined();
        const outcome = await run(task, adapterThat(() => ({ answerText: '{}' })));
        expect(outcome.taskID).toBe(task.id);
        expect(outcome.reading.fileCount).toBe(ledgerlite.files.length);
        expect(fs.existsSync(outcome.workspaceRoot)).toBe(false);
      }
    }
  });
});
