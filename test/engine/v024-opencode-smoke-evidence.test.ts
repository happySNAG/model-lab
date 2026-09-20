// Cernum · v0.2.4 — what an OpenCode smoke may claim, and what it must not.
//
// TWO DEFECTS THIS FILE PINS.
//
//   THE STALE SENTENCE. `OPENCODE_NO_PROOF_PATH` said Cernum "has no OpenCode execution adapter, so
//   there is no authorized request it could make and record". That was true in v0.2.2 and stopped
//   being true in v0.2.3, when the adapter shipped. The sentence stayed — and it is a DISCOVERY
//   string, written into `discovered.json` beside every OpenCode model on every run, so the store
//   filled with a claim the same build could disprove.
//
//   THE COST. A live OpenCode smoke would have recorded `subscriptionIncluded` and a $0 marginal
//   charge for a request billed per token. See `v024-smoke-binding-invariants.test.ts`.
//
// EVERY EXECUTION TEST HERE DRIVES A FAKE `opencode` WRITTEN TO A TEMPORARY DIRECTORY. No request
// reaches OpenCode, OpenCode Zen, or anything else: the executable is a shell script that replays
// fixtures shaped from the generated types the tool ships. The fixtures cover a success, a reply
// that names nobody, a substitution, a refusal, a timeout, unreadable output, and a secret in an
// error message.
//
// -- v0.2.5: WHICH FRAMING THESE FIXTURES ARE, WHICH IS NOT THE ONE OPENCODE WRITES ------------
//
// The `message.updated` / `message.part.updated` fixtures below are the SERVER event framing. A real
// `opencode run --format json` writes `{type, timestamp, sessionID, part|error}` with underscored
// type names and NO assistant message, so the `proven` verdicts in this file describe a reply that
// names its model — which that mode never sends. They are kept because the verdict LOGIC they pin is
// framing-independent and still correct, and because the mismatch and identity branches have no other
// coverage. `opencode-run-json-envelope.test.ts` drives the captured bytes and records the real
// outcome: the answer parses, and identity is unverifiable.
//
// The one thing this file therefore must NOT be read as: evidence that a live OpenCode smoke reaches
// `proven`. On the path Cernum invokes, it reaches `unverifiable`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeAdapter } from '../../src/engine/opencode-adapter';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import { modelsFromSmokes, supersedeStaleOpenCodeEvidence } from '../../src/engine/discovery-store';
import {
  OPENCODE_PROOF_PATH, OPENCODE_SUPERSEDED_NO_PROOF_PATH, UNION_ALPHA_MODEL_ID,
} from '../../src/engine/opencode-cli';
import { DiscoveredFrontierModel } from '../../src/engine/discovery';
import { registerSecret } from '../../src/engine/redaction';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-v024-opencode-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

/** A fake `opencode` that prints the given body for `run` and records that it was asked. */
function fakeOpenCode(body: string): string {
  const executable = path.join(directory, 'opencode');
  fs.writeFileSync(executable, ['#!/bin/sh', 'cat > /dev/null', body, ''].join('\n'), { mode: 0o755 });
  return executable;
}

const textPart = (text: string) =>
  JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_1', type: 'text', text } } });

/** SERVER framing. `run --format json` emits no assistant message; see the header. */
const assistant = (modelID: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'message.updated',
  properties: {
    info: {
      id: 'm', sessionID: 's', role: 'assistant', providerID: 'opencode', modelID,
      time: { created: 1_000, completed: 1_400 },
      tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop', ...extra,
    },
  },
});

async function smoke(body: string, modelID = UNION_ALPHA_MODEL_ID, timeoutMilliseconds?: number) {
  const binding = buildSmokeBinding({ provider: 'opencodeCLI', modelID, effort: 'none' });
  const adapter = new OpenCodeAdapter({ executablePath: fakeOpenCode(body) });
  const frozen = timeoutMilliseconds === undefined ? binding : { ...binding, timeoutMilliseconds };
  return identitySmokeTest(frozen, adapter);
}

describe('v0.2.4 · Union Alpha, driven through a fake executable, verdict by verdict (server framing)', () => {
  it('SUCCESS — the reply names the model that was asked for, so identity is proven', async () => {
    const result = await smoke(`echo '${textPart('ok')}'; echo '${assistant('union-alpha')}'`);

    expect(result.verdict).toBe('proven');
    expect(result.identityState).toBe('verified');
    expect(result.reportedModelID).toBe(UNION_ALPHA_MODEL_ID);
    expect(result.answerText).toBe('ok');
    // Execution proven AND identity proven — and still billed per token, recorded as such.
    expect(result.billingBasis).toBe('meteredAPI');
    expect(result.marginalAPIChargeMicroUSD.provenance).toBe('unavailable');
  });

  it('MISSING IDENTITY — a reply that names nobody stays unproven and is never filled in', async () => {
    // An assistant message with no modelID: the adapter must not copy the request into the answer.
    const info = JSON.stringify({
      type: 'message.updated',
      properties: { info: { id: 'm', role: 'assistant', providerID: 'opencode', tokens: { input: 1, output: 1 } } },
    });
    const result = await smoke(`echo '${textPart('ok')}'; echo '${info}'`);

    expect(result.verdict).toBe('unverifiable');
    expect(result.reportedModelID).toBe('');
    expect(result.requestedModelID).toBe(UNION_ALPHA_MODEL_ID);
    // PASS 7 CHANGED THIS LINE, and the reason it changed is the whole decision. It used to read
    // `unverifiable`, on the premise that OpenCode "DOES report identity, so a silence here is a
    // different problem from Codex's". The captured envelope disproved the premise: `run --format json`
    // emits no assistant message, so the silence is structural and identical in kind to Codex's. An
    // accepted, answered OpenCode request therefore lands on the admission state.
    //
    // WHAT THAT STATE IS NOT: proven, selectable, promotable or routable. The verdict above is still
    // `unverifiable` and the returned model is still empty — see the Pass 7 governance tests.
    expect(result.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(result.verdict).not.toBe('proven');
    expect(result.evidence).toMatch(/rather than assumed to be the model that was requested/);
    expect(result.evidence).toMatch(/emits no assistant message/);
  });

  it('MODEL MISMATCH — a real answer from a different model is refused, not accepted', async () => {
    const result = await smoke(`echo '${textPart('ok')}'; echo '${assistant('big-pickle')}'`);

    // The adapter refuses at `modelMismatch` before the answer is ever treated as a result.
    expect(result.verdict).toBe('unverifiable');
    expect(result.reportedModelID).toBe('opencode/big-pickle');
    expect(result.evidence).toMatch(/opencode\/big-pickle/);
    expect(result.answerText).toBe('');
    // And the store row is not `proven` on any reading of it.
    expect(modelsFromSmokes([result])[0].availability).not.toBe('proven');
  });

  it('REFUSAL — an auth error is a fact about access, recorded rather than retried away', async () => {
    const failed = JSON.stringify({
      type: 'message.updated',
      properties: {
        info: {
          id: 'm', role: 'assistant', providerID: 'opencode', modelID: 'union-alpha',
          error: { name: 'ProviderAuthError', data: { message: 'no credential configured for opencode' } },
        },
      },
    });
    const result = await smoke(`echo '${failed}'; exit 1`);

    expect(result.verdict).toBe('refused');
    expect(result.identityState).toBe('unverifiable');
    expect(result.evidence).toMatch(/notAuthenticated/);
    expect(result.retryCount).toBe(0);
    expect(modelsFromSmokes([result])[0].availability).toBe('refused');
  });

  it('TIMEOUT — a request that never completed established nothing, and says so', async () => {
    const result = await smoke('sleep 5', UNION_ALPHA_MODEL_ID, 150);

    expect(result.verdict).toBe('unverifiable');
    expect(result.identityState).toBe('unverifiable');
    expect(result.evidence).toMatch(/did not complete \(timeout\)/);
    expect(result.evidence).toMatch(/nothing was established about who would have answered/);
  }, 30_000);

  it('MALFORMED JSON — unreadable output is an unreadable reply, not a model that said nothing', async () => {
    const result = await smoke("echo 'not json at all'; echo '{ broken'");

    expect(result.verdict).toBe('unverifiable');
    expect(result.evidence).toMatch(/malformedResponse/);
    expect(result.answerText).toBe('');
  });

  it('SECRET REDACTION — a key echoed in an error never reaches the evidence', async () => {
    const secret = 'sk-live-v024-should-never-appear-anywhere';
    registerSecret(secret);
    const leaked = JSON.stringify({
      type: 'message.updated',
      properties: {
        info: {
          id: 'm', role: 'assistant', providerID: 'opencode', modelID: 'union-alpha',
          error: { name: 'APIError', data: { statusCode: 401, message: `rejected key ${secret}` } },
        },
      },
    });
    const result = await smoke(`echo '${leaked}'; exit 1`);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(secret);
    expect(result.evidence).toMatch(/REDACTED|\[redacted/i);
    // And the store row built from it carries the same redacted text, not a second copy of the raw one.
    expect(JSON.stringify(modelsFromSmokes([result]))).not.toContain(secret);
  });
});

describe('v0.2.4 · a proof is recorded with what it cost to obtain', () => {
  it('says on the row that the request was billed, and that the amount is unavailable', async () => {
    const result = await smoke(`echo '${textPart('ok')}'; echo '${assistant('union-alpha')}'`);
    const [row] = modelsFromSmokes([result]);

    expect(row.availability).toBe('proven');
    expect(row.verifiedModelID).toBe(UNION_ALPHA_MODEL_ID);
    expect(row.evidence).toContain('meteredAPI');
    expect(row.evidence).toContain('billed per token');
    expect(row.evidence).toContain('UNAVAILABLE — not zero');
  });
});

describe('v0.2.4 · contaminated discovery evidence is superseded, never deleted', () => {
  const contaminated = (): DiscoveredFrontierModel => ({
    provider: 'opencodeCLI',
    modelID: UNION_ALPHA_MODEL_ID,
    displayName: 'Union Alpha',
    availability: 'unproven',
    evidence: `\`opencode models\` named ${UNION_ALPHA_MODEL_ID} at 2026-09-10T00:00:00Z: DISCOVERED, NOT PROVEN. `
      + OPENCODE_SUPERSEDED_NO_PROOF_PATH,
    verifiedModelID: '',
    desiredEfforts: ['none'],
    discoveredAt: '2026-09-10T00:00:00Z',
  });

  it('keeps the original text verbatim, and stamps what corrected it', () => {
    const before = contaminated();
    const { models, supersededCount } = supersedeStaleOpenCodeEvidence([before], new Date('2026-09-17T12:00:00Z'));

    expect(supersededCount).toBe(1);
    expect(models[0].supersededEvidence).toBe(before.evidence);
    expect(models[0].evidenceCorrectedBy).toBe('v0.2.4');
    expect(models[0].evidenceCorrectedAt).toBe('2026-09-17T12:00:00Z');
    // Nothing was dropped: the row is still there and the old claim is still readable.
    expect(models).toHaveLength(1);
    expect(models[0].supersededEvidence).toContain('no OpenCode execution adapter');
  });

  it('replaces the claim with the v0.2.4 statement of what a proof actually takes', () => {
    const { models } = supersedeStaleOpenCodeEvidence([contaminated()]);
    expect(models[0].evidence).not.toContain('no OpenCode execution adapter');
    expect(models[0].evidence).toContain('SUPERSEDED BY v0.2.4');
    expect(models[0].evidence).toContain(OPENCODE_PROOF_PATH);
  });

  it('PROMOTES NOTHING. Correcting a sentence is not evidence about a model', () => {
    const { models } = supersedeStaleOpenCodeEvidence([contaminated()]);
    expect(models[0].availability).toBe('unproven');
    expect(models[0].verifiedModelID).toBe('');
    // And it does not backdate freshness: a correction is not a re-observation.
    expect(models[0].discoveredAt).toBe('2026-09-10T00:00:00Z');
  });

  it('is idempotent — reading the store a hundred times corrects once', () => {
    let models = [contaminated()];
    let total = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      const applied = supersedeStaleOpenCodeEvidence(models);
      models = applied.models;
      total += applied.supersededCount;
    }
    expect(total).toBe(1);
    expect(models[0].supersededEvidence).toContain('no OpenCode execution adapter');
  });

  it('leaves rows it has no business touching exactly as they were', () => {
    const claude: DiscoveredFrontierModel = {
      provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5',
      availability: 'proven', evidence: 'identity smoke test at 2026-09-16T00:00:00Z: proven',
      verifiedModelID: 'claude-haiku-4-5', desiredEfforts: ['none'], discoveredAt: '2026-09-16T00:00:00Z',
    };
    const clean: DiscoveredFrontierModel = { ...contaminated(), evidence: 'written after the correction' };
    const { models, supersededCount } = supersedeStaleOpenCodeEvidence([claude, clean]);
    expect(supersededCount).toBe(0);
    expect(models[0]).toEqual(claude);
    expect(models[1]).toEqual(clean);
  });
});

describe('v0.2.4 · a discovery that reached nothing retracts nothing', () => {
  // THE DEFECT: `commandDiscover` dropped every row for each named provider and wrote back only what
  // came out of THIS run. On a machine where OpenCode is not installed — or is signed out, or
  // answered nothing — `cernum discover opencodeCLI` therefore deleted the entire record for that
  // provider, INCLUDING a `proven` row a metered smoke had paid for. Nothing warned, and the store
  // is the evidence, so nothing could recover it. It is also the one route by which a superseded
  // evidence string would ever have been rewritten to disk, so the correction above had no way to
  // persist that did not destroy what it was correcting.
  //
  // The merge is exercised here directly, in the shape the command uses.
  const proven: DiscoveredFrontierModel = {
    provider: 'opencodeCLI', modelID: UNION_ALPHA_MODEL_ID, displayName: 'Union Alpha',
    availability: 'proven', evidence: 'identity smoke test at 2026-09-16T00:00:00Z: the provider named it',
    verifiedModelID: UNION_ALPHA_MODEL_ID, desiredEfforts: ['none'], discoveredAt: '2026-09-16T00:00:00Z',
  };

  /** The merge `commandDiscover` performs, as a function, so the rule can be asserted on. */
  function merge(existing: DiscoveredFrontierModel[], provider: string,
                 fresh: DiscoveredFrontierModel[]): DiscoveredFrontierModel[] {
    const kept = existing.filter((model) => model.provider !== provider);
    if (fresh.length > 0) return [...kept, ...fresh];
    return [...kept, ...existing.filter((model) => model.provider === provider)];
  }

  it('keeps a paid-for proof when the tool could not be reached', () => {
    const after = merge([proven], 'opencodeCLI', []);
    expect(after).toHaveLength(1);
    expect(after[0].availability).toBe('proven');
    expect(after[0].verifiedModelID).toBe(UNION_ALPHA_MODEL_ID);
  });

  it('does not refresh what it did not observe', () => {
    const after = merge([proven], 'opencodeCLI', []);
    // A run that learned nothing does not get to renew anybody's freshness. The row ages out on its
    // own schedule, which is the honest way for a stale proof to stop being selectable.
    expect(after[0].discoveredAt).toBe('2026-09-16T00:00:00Z');
  });

  it('still replaces the rows when the tool DID answer', () => {
    const fresh: DiscoveredFrontierModel = { ...proven, availability: 'unproven', verifiedModelID: '',
      evidence: 'a fresh listing', discoveredAt: '2026-09-17T00:00:00Z' };
    const after = merge([proven], 'opencodeCLI', [fresh]);
    expect(after).toHaveLength(1);
    expect(after[0].evidence).toBe('a fresh listing');
  });

  it('gives the correction a route to disk that does not delete what it corrects', () => {
    // Read corrects; this merge preserves; the write persists. Before the merge fix, the only
    // command that rewrote the store erased the rows instead of saving their correction.
    const { models } = supersedeStaleOpenCodeEvidence([{
      ...proven, availability: 'unproven', verifiedModelID: '',
      evidence: `DISCOVERED, NOT PROVEN. ${OPENCODE_SUPERSEDED_NO_PROOF_PATH}`,
    }]);
    const after = merge(models, 'opencodeCLI', []);
    expect(after[0].evidenceCorrectedBy).toBe('v0.2.4');
    expect(after[0].supersededEvidence).toContain('no OpenCode execution adapter');
    expect(after[0].evidence).not.toContain('no OpenCode execution adapter');
  });
});
