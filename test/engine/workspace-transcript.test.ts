// The execution transcript, audited against what an agentic attempt has to be able to say.
//
// Three of these pin facts that were NOT representable before the audit: the agent's answer of
// record as distinct from its narration, why an attempt stopped as a closed value rather than a
// sentence, and the boundary between an initial attempt and a retry. The fourth pins the rule that
// makes the whole provenance split worth having.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ENGINE_ONLY_EVENT_KINDS, TranscriptBuilder, summariseTranscript, terminationReasonFor,
} from '../../src/engine/workspace-transcript';
import { ScriptedWorkspaceAgent } from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const sandboxes: string[] = [];
afterEach(() => { for (const directory of sandboxes.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-sandbox-'));
  sandboxes.push(directory);
  return directory;
}

const CORRECT_STATS = `'use strict';
function sum(values) { let t = 0; for (const v of values) t += v; return t; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;

async function run(attempts: ConstructorParameters<typeof ScriptedWorkspaceAgent>[0]) {
  return runWorkspaceCase({
    case: BROKEN_SUM_MEAN,
    driver: new ScriptedWorkspaceAgent(attempts),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: sandbox(),
  });
}

describe('the final response is its own event, not the last message', () => {
  it('is recorded distinctly even when narration follows the answer', async () => {
    const result = await run([{
      steps: [
        { do: 'say', text: 'I will start with the test.' },
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
        // A tool that keeps talking after it answers is exactly the case "take the last message" gets wrong.
        { do: 'say', text: 'One more thought: the empty-list case was the subtle half.' },
      ],
      finalMessage: 'Fixed: the divisor was values.length + 1.',
    }]);

    const events = result.attempts[0].transcript.events;
    const final = events.filter((event) => event.kind === 'finalResponse');
    expect(final).toHaveLength(1);
    expect(final[0].detail).toContain('the divisor was values.length + 1');
    expect(final[0].provenance).toBe('agentReported');

    // The naive reading disagrees with the real one, which is why this event has to exist.
    const lastMessage = [...events].reverse().find((event) => event.kind === 'message');
    expect(lastMessage?.detail).toContain('One more thought');
    expect(result.attempts[0].transcript.summary.finalResponseCount).toBe(1);
  });

  it('is absent, rather than invented, when the tool stopped without answering', async () => {
    const result = await run([{ steps: [{ do: 'fail', kind: 'timeout', detail: 'ran out of time' }] }]);
    expect(result.attempts[0].transcript.summary.finalResponseCount).toBe(0);
  });
});

describe('termination reason is a value, not a sentence', () => {
  it('maps every driver failure kind through one pure function', () => {
    expect(terminationReasonFor(undefined)).toBe('agentCompleted');
    expect(terminationReasonFor('timeout')).toBe('deadlineExceeded');
    expect(terminationReasonFor('cancelled')).toBe('cancelled');
    expect(terminationReasonFor('rateLimited')).toBe('providerDeclined');
    expect(terminationReasonFor('notAuthenticated')).toBe('providerDeclined');
    expect(terminationReasonFor('notInstalled')).toBe('driverUnavailable');
    expect(terminationReasonFor('spawnFailure')).toBe('driverUnavailable');
    expect(terminationReasonFor('policyNotExpressible')).toBe('policyNotExpressible');
    expect(terminationReasonFor('exitFailure')).toBe('agentFailed');
    expect(terminationReasonFor('malformedOutput')).toBe('agentFailed');
  });

  it('is on the ending event, on the summary and on the attempt record', async () => {
    const result = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }]);
    const record = result.attempts[0];
    const finished = record.transcript.events.find((event) => event.kind === 'attemptFinished');
    expect(finished?.terminationReason).toBe('agentCompleted');
    expect(record.transcript.summary.terminationReason).toBe('agentCompleted');
    expect(record.terminationReason).toBe('agentCompleted');
  });

  it('distinguishes a deadline from a provider declining, without reading the prose', async () => {
    const timedOut = await run([{ steps: [{ do: 'fail', kind: 'timeout', detail: 'ran out of time' }] }]);
    const declined = await run([{ steps: [{ do: 'fail', kind: 'rateLimited', detail: 'allowance exhausted' }] }]);
    expect(timedOut.attempts[0].terminationReason).toBe('deadlineExceeded');
    expect(declined.attempts[0].terminationReason).toBe('providerDeclined');
  });

  it('records a harness fault under its own reason rather than as an agent outcome', async () => {
    const result = await runWorkspaceCase({
      case: { ...BROKEN_SUM_MEAN, source: { ...BROKEN_SUM_MEAN.source, expectedTreeDigest: 'f'.repeat(64) } },
      driver: new ScriptedWorkspaceAgent([{ steps: [] }]),
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: sandbox(),
    });
    expect(result.attempts[0].terminationReason).toBe('harnessFault');
    expect(result.attempts[0].transcript.summary.terminationReason).toBe('harnessFault');
  });
});

describe('stdout and stderr are preserved apart', () => {
  it('carries a digest, a byte count and a tail for each stream, separately', async () => {
    const result = await run([{ steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] }]);
    const verification = result.attempts[0].transcript.events.filter((event) => event.kind === 'verificationRan');
    expect(verification.length).toBeGreaterThan(0);
    for (const event of verification) {
      expect(event.stdoutDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(event.stderrDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(event.stdoutDigest).not.toBe(event.stderrDigest);
      expect(typeof event.stdoutByteCount).toBe('number');
      expect(typeof event.stderrByteCount).toBe('number');
    }
    // The fixture's test writes its results to stdout and nothing to stderr, so the two are visibly
    // different readings rather than one merged log.
    const after = verification.find((event) => event.reason === 'afterChange');
    expect(after?.stdoutTail).toContain('5/5 passed');
    expect(after?.stderrTail).toBe('');

    const outcome = result.attempts[0].verificationOutcomes[0];
    expect(outcome.stdoutTail).toContain('ok - mean divides by the count');
    expect(outcome.stderrTail).toBe('');
  });
});

describe('the boundary between an initial attempt and a retry', () => {
  it('marks a retry explicitly, and carries what it is recovering from', async () => {
    const result = await run([
      { steps: [{ do: 'write', path: 'src/stats.js', contents: 'module.exports = {};' }] },
      { steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }] },
    ]);
    expect(result.attemptsUsed).toBe(2);

    // The initial attempt opens with a start and NO retry boundary.
    const first = result.attempts[0].transcript;
    expect(first.events.filter((event) => event.kind === 'retryStarted')).toHaveLength(0);
    expect(first.events.filter((event) => event.kind === 'attemptStarted')).toHaveLength(1);
    expect(first.summary.retryCount).toBe(0);

    // The retry opens with one, before its own start, naming the attempt it follows and why.
    const second = result.attempts[1].transcript;
    const retry = second.events.filter((event) => event.kind === 'retryStarted');
    expect(retry).toHaveLength(1);
    expect(retry[0].priorAttemptIndex).toBe(0);
    expect(retry[0].terminationReason).toBe('agentCompleted');
    expect(retry[0].patchDigest).toBe(result.attempts[0].patch.patchDigest);
    expect(retry[0].seq).toBeLessThan(second.events.find((event) => event.kind === 'attemptStarted')!.seq);
    expect(second.summary.retryCount).toBe(1);

    // Each attempt ends with exactly one ending, so "retry end" is that attempt's attemptFinished.
    for (const attempt of result.attempts) {
      expect(attempt.transcript.events.filter((event) => event.kind === 'attemptFinished')).toHaveLength(1);
    }
  });
});

describe('provenance cannot be claimed', () => {
  it('names the kinds only this engine may emit', () => {
    expect(ENGINE_ONLY_EVENT_KINDS).toEqual(
      ['attemptStarted', 'attemptFinished', 'retryStarted', 'verificationRan', 'harnessFault', 'boundaryRefusal'],
    );
  });

  it('drops a driver-claimed verification result and records the attempt to forge it', () => {
    const builder = new TranscriptBuilder(0, () => 0);
    builder.emit('verificationRan', 'agentReported', 0, 'all tests passed, honestly', { ok: true, exitCode: 0 });

    const transcript = builder.build();
    expect(transcript.events.filter((event) => event.kind === 'verificationRan')).toHaveLength(0);
    const faults = transcript.events.filter((event) => event.kind === 'harnessFault');
    expect(faults).toHaveLength(1);
    expect(faults[0].reason).toBe('forgedEngineEvent');
    expect(faults[0].provenance).toBe('engineObserved');
    // The forged claim did not reach the summary the scorer reads.
    expect(transcript.summary.verificationRunCount).toBe(0);
  });

  it('still lets a driver report the kinds that are genuinely its own', () => {
    const builder = new TranscriptBuilder(0, () => 0);
    builder.emit('message', 'agentReported', 0, 'thinking about it');
    builder.emit('toolCall', 'agentReported', 0, 'readFile', { toolName: 'readFile' });
    builder.emit('toolResult', 'agentReported', 0, 'got the file', { ok: true });
    builder.emit('commandExecuted', 'agentReported', 0, 'npm test', { executable: 'npm' });
    const summary = builder.build().summary;
    expect(summary.reportedEventCount).toBe(4);
    expect(summary.harnessFaultCount).toBe(0);
    // A command the AGENT says it ran is not counted among the ones this engine watched exit.
    expect(summary.observedCommandCount).toBe(0);
    expect(summary.commandCount).toBe(1);
  });

  it('keeps every engine-observed event distinguishable from testimony in the summary', async () => {
    const result = await run([{
      steps: [
        { do: 'say', text: 'looking now' },
        { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
      ],
      finalMessage: 'done',
    }]);
    const events = result.attempts[0].transcript.events;
    const byKind = (kind: string) => events.filter((event) => event.kind === kind);

    expect(byKind('message').every((event) => event.provenance === 'agentReported')).toBe(true);
    expect(byKind('toolCall').every((event) => event.provenance === 'agentReported')).toBe(true);
    expect(byKind('finalResponse').every((event) => event.provenance === 'agentReported')).toBe(true);
    for (const kind of ENGINE_ONLY_EVENT_KINDS) {
      expect(byKind(kind).every((event) => event.provenance === 'engineObserved')).toBe(true);
    }
    // Every event carries one or the other; none is silent about where it came from.
    expect(events.every((event) => event.provenance === 'engineObserved' || event.provenance === 'agentReported')).toBe(true);
  });

  it('summarises an empty transcript without inventing a termination reason', () => {
    expect(summariseTranscript([]).terminationReason).toBeUndefined();
  });
});
