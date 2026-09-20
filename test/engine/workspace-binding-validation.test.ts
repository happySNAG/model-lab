// The binding a WORKSPACE run executes under: what the contract relaxes, and everything it does not.
//
// THE DEFECT THIS PINS. The first live workspace proof executed a binding that `validateBinding`
// itself refused. A workspace case legitimately carries no provider-side token ceiling — the
// installed `claude` documents no output budget that applies to a subscription session — so its
// binding named `maxInputTokens: 0, maxOutputTokens: 0`, and a rule written for PROSE requests read
// that as `emptyBudget` and said no. The proof therefore ran outside the one check every other
// binding in this engine passes through.
//
// THE FIX HAD TO BE NARROW OR IT WOULD BE WORSE THAN THE DEFECT. Reinterpreting a zero budget
// globally would have made a prose binding nobody configured indistinguishable from one that cannot
// be configured, which is the exact confusion the rule exists to prevent. So the budget rule now
// follows a DECLARED contract, the declaration costs the binding the right to name a ceiling, and
// every other refusal in `validateBinding` is untouched. The tests below are in two halves: the
// exception works, and the exception buys nothing else.

import { describe, expect, it } from 'vitest';
import {
  ProviderBinding, ProviderBindingError, executionContractOf, isWorkspaceBinding, tokenCeilingOf,
  validateBinding,
} from '../../src/engine/provider';
import {
  WorkspaceBindingError, buildWorkspaceBinding, preRunIdentityFrom, resolvePreRunIdentity,
  workspaceTimeoutFor,
} from '../../src/engine/workspace-binding';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import { subscriptionBinding, meteredBinding, provenModel } from './frontier-harness';

/** A workspace binding shaped exactly as `buildWorkspaceBinding` produces one, for the negative cases. */
function workspaceBinding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    ...subscriptionBinding('claude-haiku:claude-haiku-4-5'),
    executionContract: 'workspaceTask',
    tokenCeiling: 'notExpressibleByContract',
    maxInputTokens: 0,
    maxOutputTokens: 0,
    ...overrides,
  };
}

const PROVEN_HAIKU = [provenModel('claudeCLI', 'claude-haiku-4-5')];

describe('the workspace execution contract, and the one rule it relaxes', () => {
  it('validates a workspace binding whose contract carries no token ceiling', () => {
    expect(() => validateBinding(workspaceBinding())).not.toThrow();
  });

  it('still refuses a PROSE binding with an empty budget, on exactly the old terms', () => {
    expect(() => validateBinding({ ...subscriptionBinding('x:y'), maxOutputTokens: 0 }))
      .toThrow(/input and output budgets must both be positive/);
    expect(() => validateBinding({ ...subscriptionBinding('x:y'), maxInputTokens: 0 }))
      .toThrow(/input and output budgets must both be positive/);
  });

  it('defaults an undeclared binding to the prose contract, so nothing already frozen moves', () => {
    const prose = subscriptionBinding('x:y');
    expect(executionContractOf(prose)).toBe('proseCompletion');
    expect(tokenCeilingOf(prose)).toBe('boundedByBinding');
    expect(isWorkspaceBinding(prose)).toBe(false);
    // An undeclared binding is byte-identical to what it always was: `canonicalJSON` drops an
    // undefined key, so the envelope digest of a campaign frozen before this pass cannot move.
    expect(Object.prototype.hasOwnProperty.call(prose, 'executionContract')).toBe(false);
  });

  it('refuses the unexpressed-ceiling declaration on a prose contract', () => {
    expect(() => validateBinding({ ...subscriptionBinding('x:y'), tokenCeiling: 'notExpressibleByContract', maxInputTokens: 0, maxOutputTokens: 0 }))
      .toThrow(/only a workspaceTask binding may declare/);
  });

  it('refuses a binding that declares no ceiling AND names one — the two readings of a zero, kept apart', () => {
    expect(() => validateBinding(workspaceBinding({ maxOutputTokens: 4_096 })))
      .toThrow(/declares that its execution contract cannot carry a token ceiling AND\s+names one/);
    expect(() => validateBinding(workspaceBinding({ maxInputTokens: 200_000 })))
      .toThrow(ProviderBindingError);
  });

  it('fails closed on a METERED workspace binding, because a ceiling against zero is not a ceiling', () => {
    // `worstCaseAttemptMicroUSD` bounds a metered attempt from the frozen budgets. With no budgets it
    // would bound every attempt at zero, and the spending ceiling would silently stop working.
    expect(() => validateBinding({
      ...meteredBinding('gpt:gpt-6-astra', 'openaiAPI'),
      executionContract: 'workspaceTask', tokenCeiling: 'notExpressibleByContract',
      maxInputTokens: 0, maxOutputTokens: 0,
    })).toThrow(/the worst case for one attempt cannot be computed/);
  });
});

describe('the workspace exception buys nothing but the budget rule', () => {
  it('cannot bypass the identity rules', () => {
    // A binding claiming a verified identity it cannot name is refused on the same terms as a prose one.
    expect(() => validateBinding(workspaceBinding({ identityState: 'verified', verifiedModelID: '' })))
      .toThrow(/not verified/);
    // The Pass 6 admission state is still admissible on one provider only.
    expect(() => validateBinding(workspaceBinding({
      identityState: 'requestAcceptedIdentityUnverifiable', verifiedModelID: '',
    }))).toThrow(/applies only to codexCLI/);
  });

  it('cannot bypass the provider registry: the execution class is still a property of the provider', () => {
    expect(() => validateBinding(workspaceBinding({ provider: 'openaiAPI' })))
      .toThrow(/is reached as meteredAPI/);
    expect(() => validateBinding(workspaceBinding({ authorizationMode: 'apiKeyEnvironment' })))
      .toThrow(/authorised by the user's own already-authenticated CLI session/);
  });

  it('cannot bypass the remaining fail-closed rules', () => {
    expect(() => validateBinding(workspaceBinding({ requestedModelID: '' }))).toThrow(/asks for nothing/);
    expect(() => validateBinding(workspaceBinding({ timeoutMilliseconds: 0 }))).toThrow(/no timeout/);
    expect(() => validateBinding(workspaceBinding({ pricing: { source: 's', capturedAt: 'c', currency: 'USD', inputMicroUSDPerMillionTokens: 1, outputMicroUSDPerMillionTokens: 1, reasoningMicroUSDPerMillionTokens: null } })))
      .toThrow(/not billed per token/);
  });
});

describe('the builder produces one validated binding, and refuses an unproven route', () => {
  it('builds a valid workspace binding from a proven route', () => {
    // A moment just after the fixture's own `discoveredAt`, so the proof is fresh rather than
    // seven-day expired. The expiry rule is the store's and is exercised for real in `discovery-store`.
    const identity = preRunIdentityFrom(PROVEN_HAIKU, '2026-01-01T00:00:00Z', 'claudeCLI', 'claude-haiku-4-5',
      new Date('2026-01-01T01:00:00Z'));
    const binding = buildWorkspaceBinding({
      candidate: 'claudeCLI:claude-haiku-4-5', provider: 'claudeCLI', modelID: 'claude-haiku-4-5',
      effort: 'none', timeoutMilliseconds: 600_000, identity,
    });
    expect(binding.executionContract).toBe('workspaceTask');
    expect(binding.tokenCeiling).toBe('notExpressibleByContract');
    expect(binding.maxInputTokens).toBe(0);
    expect(binding.maxOutputTokens).toBe(0);
    expect(binding.identityState).toBe('verified');
    expect(binding.verifiedModelID).toBe('claude-haiku-4-5');
    // Validated where it is built, so a preview cannot describe a binding other than the one that runs.
    expect(() => validateBinding(binding)).not.toThrow();
  });

  it('refuses a route nothing has proven, exactly as a campaign does', () => {
    const identity = resolvePreRunIdentity({ writtenAt: '', models: [] }, 'claudeCLI', 'claude-opus-5');
    expect(identity.resolvedFrom).toBe('nothing');
    expect(() => buildWorkspaceBinding({
      candidate: 'c', provider: 'claudeCLI', modelID: 'claude-opus-5', effort: 'none',
      timeoutMilliseconds: 1_000, identity,
    })).toThrow(WorkspaceBindingError);
  });

  it('refuses a metered provider before it can reach the budget rule at all', () => {
    const identity = preRunIdentityFrom([provenModel('openaiAPI', 'gpt-6-astra')], '', 'openaiAPI', 'gpt-6-astra',
      new Date(Date.parse('2026-01-01T00:00:00Z') + 1_000));
    expect(() => buildWorkspaceBinding({
      candidate: 'c', provider: 'openaiAPI', modelID: 'gpt-6-astra', effort: 'none',
      timeoutMilliseconds: 1_000, identity,
    })).toThrow(ProviderBindingError);
  });
});

describe('an operator may narrow a frozen case and never widen it', () => {
  it('takes the case timeout when the operator names none', () => {
    expect(workspaceTimeoutFor(BROKEN_SUM_MEAN)).toBe(BROKEN_SUM_MEAN.execution.timeoutMilliseconds);
  });

  it('narrows to the operator value, and refuses to raise the case ceiling', () => {
    expect(workspaceTimeoutFor(BROKEN_SUM_MEAN, 60_000)).toBe(60_000);
    expect(workspaceTimeoutFor(BROKEN_SUM_MEAN, 999_999_999)).toBe(BROKEN_SUM_MEAN.execution.timeoutMilliseconds);
  });

  it('refuses a timeout that would stop every attempt before it started', () => {
    expect(() => workspaceTimeoutFor(BROKEN_SUM_MEAN, 0)).toThrow(WorkspaceBindingError);
  });
});
