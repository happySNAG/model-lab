// The workspace host seam: what it shares with the prose host, and what it deliberately does not.
//
// The point of every test below is the same one: a workspace row and a prose row must answer the
// SAME operational questions — who answered, what it cost, how much allowance it spent, whether it
// was authorised — out of the SAME record, while the verdict comes from somewhere a prose row has no
// way to look.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { ScriptedWorkspaceAgent, ScriptedAttempt, WorkspaceAgentDriver } from '../../src/engine/workspace-agent';
import {
  WorkspaceAgentUsage, WorkspaceRoutingHost, describeWorkspaceRequest, wastedTokensOf,
} from '../../src/engine/workspace-host';
import { workspaceCaseDigest, workspaceComparabilityKey } from '../../src/engine/workspace-case';
import { SpendTracker } from '../../src/engine/spending';
import { buildWorkspaceDriver, providersWithWorkspaceDriver } from '../../src/engine/host-factory';
import { CLAUDE_WORKSPACE_DRIVER_ID } from '../../src/engine/workspace-claude-driver';
import { CODEX_WORKSPACE_DRIVER_ID } from '../../src/engine/workspace-codex-driver';
import { meteredBinding, subscriptionBinding } from './frontier-harness';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');

const sandboxes: string[] = [];
afterEach(() => { for (const directory of sandboxes.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-host-'));
  sandboxes.push(directory);
  return directory;
}

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;

/** A scripted driver that also reports usage, so the shared record has something to be built from. */
function reportingDriver(attempts: ScriptedAttempt[], usagePerAttempt: WorkspaceAgentUsage[]): WorkspaceAgentDriver {
  const scripted = new ScriptedWorkspaceAgent(attempts);
  let index = 0;
  return {
    driverID: scripted.driverID,
    provider: scripted.provider,
    capabilities: scripted.capabilities,
    async run(request: Parameters<typeof scripted.run>[0]) {
      const result = await scripted.run(request);
      const usage = usagePerAttempt[Math.min(index, usagePerAttempt.length - 1)];
      index += 1;
      return { ...result, usage };
    },
  };
}

const FIXING_ATTEMPT: ScriptedAttempt = {
  steps: [
    { do: 'read', path: 'src/stats.js' },
    { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
    { do: 'runCommand', executable: 'node', args: ['test/stats.test.js'], exitCode: 0 },
  ],
  finalMessage: 'Fixed the divisor.',
};

const IDLE_ATTEMPT: ScriptedAttempt = { steps: [{ do: 'say', text: 'thinking about it' }], finalMessage: 'No change.' };

describe('the host answers the same operational questions a prose attempt does', () => {
  it('builds ONE frontier record, with the subscription allowance stated rather than zeroed', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const outcome = await host.run({
      case: BROKEN_SUM_MEAN,
      binding: subscriptionBinding('claude-haiku:claude-haiku-4-5'),
      driver: reportingDriver([FIXING_ATTEMPT], [{
        inputTokens: 6_686, freshInputTokens: 7, cacheCreationInputTokens: 6_551, cacheReadInputTokens: 128,
        visibleOutputTokens: 452, reasoningTokens: 81, subscriptionIncludedUsageMicroUSD: 12_345,
        identityState: 'verified',
      }]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
    });

    expect(outcome.scorecard.status).toBe('pass');
    // THE MARGINAL CHARGE IS A TRUE ZERO on a subscription, and the allowance beside it is not.
    expect(outcome.frontier.costMicroUSD).toBe(0);
    expect(outcome.frontier.costProvenance).toBe('measured');
    expect(outcome.frontier.subscriptionIncludedUsageMicroUSD).toBe(12_345);
    expect(outcome.frontier.subscriptionAllowanceState).toBe('reported');
    expect(outcome.frontier.subscriptionAllowanceExplanation).toContain('NOT a charge');
    expect(outcome.frontier.inputTokens).toBe(6_686);
    expect(outcome.frontier.freshInputTokens).toBe(7);
    expect(outcome.frontier.totalTokens).toBe(6_686 + 452 + 81);
    expect(outcome.frontier.usageProvenance).toBe('providerReported');
    expect(outcome.frontier.billingBasis).toBe('subscriptionIncluded');
  });

  it('records an unreported allowance as unavailable WITH ITS REASON, never as zero', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const outcome = await host.run({
      case: BROKEN_SUM_MEAN,
      binding: subscriptionBinding('claude-haiku:claude-haiku-4-5'),
      driver: reportingDriver([FIXING_ATTEMPT], [{ visibleOutputTokens: 10 }]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
    });
    expect(outcome.frontier.subscriptionIncludedUsageMicroUSD).toBeUndefined();
    expect(outcome.frontier.subscriptionAllowanceState).toBe('unavailable');
    expect(outcome.frontier.subscriptionAllowanceExplanation).toContain('It is NOT zero');
  });

  it('sums tokens across attempts and counts the losing ones as waste', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const outcome = await host.run({
      case: BROKEN_SUM_MEAN, // allows two attempts
      binding: subscriptionBinding('claude-haiku:claude-haiku-4-5'),
      driver: reportingDriver([IDLE_ATTEMPT, FIXING_ATTEMPT], [
        { inputTokens: 100, visibleOutputTokens: 20 },
        { inputTokens: 300, visibleOutputTokens: 40 },
      ]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
    });
    expect(outcome.run.attemptsUsed).toBe(2);
    expect(outcome.frontier.inputTokens).toBe(400);
    expect(outcome.frontier.visibleOutputTokens).toBe(60);
    expect(outcome.frontier.retryCount).toBe(1);
    // Only the attempt that did not decide the outcome is waste.
    expect(outcome.frontier.wastedTokens).toBe(120);
    expect(outcome.scorecard.wastedMilliseconds).toBeGreaterThan(0);
  });

  it('is the same spend tracker the prose host uses, and it refuses past the ceiling', async () => {
    const spend = new SpendTracker({
      version: 1, approvedAt: new Date().toISOString(), approvedBy: 'a test',
      hardCeilingMicroUSD: 1, estimateDigest: '', envelopeDigest: '', disclosure: [],
    } as never);
    const host = new WorkspaceRoutingHost({ spend });

    // A subscription binding spends no money, so it is always allowed.
    expect((await host.authorizeAttempt({ case: BROKEN_SUM_MEAN, binding: subscriptionBinding('c:m') })).allowed).toBe(true);

    // A metered one is checked with the worst case it could cost, and refused before anything runs.
    const refusal = await host.authorizeAttempt({ case: BROKEN_SUM_MEAN, binding: meteredBinding('c:m') });
    expect(refusal.allowed).toBe(false);
    if (!refusal.allowed) expect(refusal.code).toContain('spending.');
  });
});

describe('the attempt ceiling belongs to the operator, not to the case', () => {
  it('stops after one attempt without moving the case digest', async () => {
    const digestBefore = workspaceCaseDigest(BROKEN_SUM_MEAN);
    const keyBefore = workspaceComparabilityKey(BROKEN_SUM_MEAN);

    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const outcome = await host.run({
      case: BROKEN_SUM_MEAN,
      binding: subscriptionBinding('claude-haiku:claude-haiku-4-5'),
      // Two idle attempts are scripted; the case allows two; the operator allows one.
      driver: reportingDriver([IDLE_ATTEMPT, IDLE_ATTEMPT], [{}]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
      attemptCeiling: 1,
    });

    expect(outcome.run.attemptsUsed).toBe(1);
    expect(outcome.attemptCeilingApplied).toEqual({ ceiling: 1, caseAllows: 2 });
    // THE CASE IS UNTOUCHED. A run capped by an operator is still a run of this task version.
    expect(workspaceCaseDigest(BROKEN_SUM_MEAN)).toBe(digestBefore);
    expect(workspaceComparabilityKey(BROKEN_SUM_MEAN)).toBe(keyBefore);
    expect(outcome.run.caseDigest).toBe(digestBefore);
  });

  it('never raises the case\'s own ceiling', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const outcome = await host.run({
      case: BROKEN_SUM_MEAN,
      binding: subscriptionBinding('c:m'),
      driver: reportingDriver([IDLE_ATTEMPT, IDLE_ATTEMPT, IDLE_ATTEMPT], [{}]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
      attemptCeiling: 10,
    });
    expect(outcome.run.attemptsUsed).toBe(2);
    expect(outcome.attemptCeilingApplied).toBeUndefined();
  });

  it('refuses a ceiling of zero rather than recording a row for a case it never ran', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    await expect(host.run({
      case: BROKEN_SUM_MEAN, binding: subscriptionBinding('c:m'),
      driver: reportingDriver([IDLE_ATTEMPT], [{}]),
      fixtureRoot: FIXTURE_ROOT, sandboxRoot: sandbox(), attemptCeiling: 0,
    })).rejects.toThrow(/would run nothing/);
  });

  it('counts nothing as wasted when there was only one attempt', () => {
    expect(wastedTokensOf([{ inputTokens: 5 }], 1)).toBe(0);
    expect(wastedTokensOf([{ inputTokens: 5 }, { inputTokens: 9 }], 2)).toBe(5);
  });
});

describe('a driver that cannot do what the case requires is refused before anything is spent', () => {
  it('reports the shortfall without making a workspace', async () => {
    const host = new WorkspaceRoutingHost({ spend: new SpendTracker(undefined) });
    const noShell = new ScriptedWorkspaceAgent([IDLE_ATTEMPT], { capabilities: { canExecuteCommands: false } });
    expect(host.shortfallsFor({ case: BROKEN_SUM_MEAN, driver: noShell })).toHaveLength(1);

    const outcome = await host.run({
      case: BROKEN_SUM_MEAN, binding: subscriptionBinding('c:m'), driver: noShell,
      fixtureRoot: FIXTURE_ROOT, sandboxRoot: sandbox(),
    });
    expect(outcome.run.attemptsUsed).toBe(0);
    expect(outcome.run.refusedBecause).toHaveLength(1);
    expect(outcome.scorecard.status).toBe('envelopeFailure');
  });
});

describe('the registry names only the providers a workspace driver has actually been written for', () => {
  it('builds the Claude and Codex workspace drivers and nothing else', () => {
    const claude = buildWorkspaceDriver({ provider: 'claudeCLI', requestedModelID: 'claude-haiku-4-5', effort: 'none' });
    expect(claude?.driverID).toBe(CLAUDE_WORKSPACE_DRIVER_ID);
    expect(claude?.provider).toBe('claudeCLI');
    const codex = buildWorkspaceDriver({ provider: 'codexCLI', requestedModelID: 'gpt-5.6-sol', effort: 'medium' });
    expect(codex?.driverID).toBe(CODEX_WORKSPACE_DRIVER_ID);
    expect(codex?.provider).toBe('codexCLI');
    // The metered OpenAI API is NOT a workspace route: nothing in this build runs an agent loop for it.
    for (const provider of ['opencodeCLI', 'anthropicAPI', 'openaiAPI', 'ollama'] as const) {
      expect(buildWorkspaceDriver({ provider, requestedModelID: 'm', effort: 'none' })).toBeUndefined();
    }
    expect(providersWithWorkspaceDriver()).toEqual(['claudeCLI', 'codexCLI']);
  });
});

describe('the preflight description states the run before any of it happens', () => {
  it('names the case, its digest, the candidate and the attempt ceiling', () => {
    const lines = describeWorkspaceRequest({
      case: BROKEN_SUM_MEAN,
      binding: subscriptionBinding('claude-haiku:claude-haiku-4-5'),
      attemptCeiling: 1,
    }).join('\n');
    expect(lines).toContain('ws.broken-sum.mean@3');
    expect(lines).toContain(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(lines).toContain(workspaceComparabilityKey(BROKEN_SUM_MEAN));
    expect(lines).toContain('operator cap; the case allows 2');
    expect(lines).toContain('subscriptionIncluded');
    expect(lines).toContain('HOME');
  });
});
