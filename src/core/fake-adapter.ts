// Model Lab core · deterministic fake adapter (port of `ModelLabDeterministicFakeAdapter`).
// Pure function of the request; scripted behaviours exercise every failure class without a network.

import { AttemptRequest, CancellationToken, EvaluationAdapter, requestDigest } from './adapter';
import { CandidateDescriptor, ExecutionClass, configurationID } from './candidate';
import { Observation, Timing } from './run';

export type FakeScript =
  | 'succeed' | 'succeedStructured' | 'produceMalformedOutput' | 'simulateTimeout'
  | 'reportWrongIdentity' | 'succeedWithoutUsage' | 'observeCancellation' | 'failInternally';

export class DeterministicFakeAdapter implements EvaluationAdapter {
  readonly adapterID = 'adapter:fake:deterministic';
  readonly supportedExecutionClasses: ExecutionClass[] = ['inProcess'];
  constructor(public readonly script: FakeScript = 'succeed', private readonly delayMilliseconds = 0) {}

  async invoke(request: AttemptRequest, candidate: CandidateDescriptor, cancellation: CancellationToken): Promise<Observation> {
    const digest = requestDigest(request);
    const runtimeConfigurationID = configurationID(candidate.runtimeConfiguration);
    if (this.delayMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));

    const cancelledObservation = (): Observation => ({
      toolCallObservationsRaw: [],
      terminalStatus: 'cancelled',
      providerReportedUsage: { unavailableReason: 'cancelled before generation' },
      timing: {
        totalElapsedMilliseconds: { unavailableReason: 'cancelled before generation' },
        firstTokenMilliseconds: { unavailableReason: 'cancelled before generation' },
      },
      warnings: [],
      errors: [{ code: 'adapter.cancelled', detail: 'cancellation observed before generation' }],
      identityVerification: { state: 'unverifiable', reason: 'cancelled before generation' },
      runtimeConfigurationID,
      requestDigest: digest,
    });
    if (cancellation.isCancelled) return cancelledObservation();

    // Swift `String.count` counts Characters (grapheme clusters); these fixtures are ASCII/BMP so code points suffice.
    const promptCharacterCount = request.messages.reduce((n, m) => n + Array.from(m.content).length, 0)
      + (request.syntheticContext ? Array.from(request.syntheticContext).length : 0);
    const deterministicTiming: Timing = { totalElapsedMilliseconds: { measured: 1 }, firstTokenMilliseconds: { unavailableReason: 'fake runtime does not stream' } };
    const verified = { state: 'verifiedMatch', reported: candidate.exactModelIdentity } as const;

    switch (this.script) {
      case 'succeed':
      case 'succeedWithoutUsage': {
        const text = `deterministic-completion:${digest}`;
        return {
          outputText: text, toolCallObservationsRaw: [], terminalStatus: 'completed',
          providerReportedUsage: this.script === 'succeedWithoutUsage'
            ? { unavailableReason: 'fake runtime configured to report no usage' }
            : { measured: { promptTokens: promptCharacterCount, completionTokens: text.length } },
          timing: deterministicTiming, warnings: [], errors: [], identityVerification: verified, runtimeConfigurationID, requestDigest: digest,
        };
      }
      case 'succeedStructured': {
        const json = `{"answer":"deterministic","requestDigest":"${digest}"}`;
        return {
          structuredOutputRaw: json, toolCallObservationsRaw: [], terminalStatus: 'completed',
          providerReportedUsage: { measured: { promptTokens: promptCharacterCount, completionTokens: json.length } },
          timing: deterministicTiming, warnings: [], errors: [], identityVerification: verified, runtimeConfigurationID, requestDigest: digest,
        };
      }
      case 'produceMalformedOutput':
        return {
          outputText: 'this is prose, not the requested JSON', toolCallObservationsRaw: [],
          terminalStatus: request.responseFormat === 'json' ? 'malformedOutput' : 'completed',
          providerReportedUsage: { measured: { promptTokens: promptCharacterCount, completionTokens: 38 } },
          timing: deterministicTiming, warnings: [],
          errors: request.responseFormat === 'json' ? [{ code: 'output.notJSON', detail: 'requested JSON; received unparseable prose' }] : [],
          identityVerification: verified, runtimeConfigurationID, requestDigest: digest,
        };
      case 'simulateTimeout':
        return {
          toolCallObservationsRaw: [], terminalStatus: 'timedOut',
          providerReportedUsage: { unavailableReason: 'no output before budget elapsed' },
          timing: { totalElapsedMilliseconds: { measured: request.executionBudgetMilliseconds }, firstTokenMilliseconds: { unavailableReason: 'no token before budget elapsed' } },
          warnings: [], errors: [{ code: 'adapter.timeout', detail: `execution budget of ${request.executionBudgetMilliseconds}ms elapsed` }],
          identityVerification: { state: 'unverifiable', reason: 'no response arrived' }, runtimeConfigurationID, requestDigest: digest,
        };
      case 'reportWrongIdentity':
        return {
          outputText: `deterministic-completion:${digest}`, toolCallObservationsRaw: [], terminalStatus: 'completed',
          providerReportedUsage: { measured: { promptTokens: promptCharacterCount, completionTokens: 24 } },
          timing: deterministicTiming, warnings: [], errors: [],
          identityVerification: { state: 'mismatch', reported: 'some-other-model:v0', declared: candidate.exactModelIdentity },
          runtimeConfigurationID, requestDigest: digest,
        };
      case 'failInternally':
        return {
          toolCallObservationsRaw: [], terminalStatus: 'failed',
          providerReportedUsage: { unavailableReason: 'runtime failed before reporting usage' },
          timing: { totalElapsedMilliseconds: { unavailableReason: 'runtime failed before completion' }, firstTokenMilliseconds: { unavailableReason: 'runtime failed before completion' } },
          warnings: [], errors: [{ code: 'adapter.internalFailure', detail: 'scripted internal failure' }],
          identityVerification: { state: 'unverifiable', reason: 'runtime failed before reporting identity' }, runtimeConfigurationID, requestDigest: digest,
        };
      case 'observeCancellation':
        return cancelledObservation();
    }
  }
}
