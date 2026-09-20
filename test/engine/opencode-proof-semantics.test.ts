// Cernum · v0.2.2 — discovery is not proof, and no amount of discovery becomes proof.
//
// THE DEFECT THIS PINS. v0.2.1 recorded every model `opencode models` returned as `proven`, the one
// availability state a campaign builder will select. So the chain ran: OpenCode is installed → a
// credential is configured → a listing names 70 models → all 70 are selectable for a scored,
// billed campaign. Not one link in that chain is a model having answered anything.
//
// WHERE THE LISTING ACTUALLY COMES FROM, checked on the machine rather than assumed:
// `~/.cache/opencode/models.json`, a cached catalogue holding 7,850 models across 221 providers —
// a description of the world. `opencode models opencode` narrows it to one provider and printed 70
// of the 103 entries the catalogue carries there. Some filtering happens; none of it is a per-model
// entitlement check, and none of it is a reply from a model.
//
// This engine already refuses exactly this inference for Codex — `codex debug models` renders a
// catalogue, the service refuses models that appear in it, so the listing proves nothing about the
// account. OpenCode was given the opposite treatment by accident. These tests are the fence.

import { describe, expect, it } from 'vitest';
import {
  discoverOpenCodeCLI, discoverProvider, selectableModels, DESIRED_CANDIDATE_LADDER,
} from '../../src/engine/discovery';
import {
  UNION_ALPHA_MODEL_ID, OPENCODE_LISTING_IS_A_CATALOGUE, OPENCODE_PROOF_PATH,
  OPENCODE_SUPPORT_MATURITY, OPENCODE_FIRST_LIVE_REQUEST_AT, OPENCODE_FIRST_LIVE_REQUEST_MODEL,
} from '../../src/engine/opencode-cli';

const ESC = '\x1b';
const VERSION = '1.18.31\n';
const CREDENTIALS = [
  `${ESC}[0m`,
  `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`,
  `◗  OpenCode Zen ${ESC}[90mapi`,
  '└  1 credentials',
  '',
].join('\n');
const MODELS = [
  'opencode/big-pickle', 'opencode/claude-opus-5', 'opencode/gpt-5.6-terra',
  'opencode/union-alpha', 'opencode/gemini-3.1-pro', '',
].join('\n');

function fakeRun(byArgs: Record<string, string>) {
  return async ({ args }: { args: string[] }) => ({
    stdout: byArgs[args.join(' ')] ?? '', stderr: '', exitCode: 0, signal: null,
    elapsedMilliseconds: 1, firstByteMilliseconds: 1, failure: undefined,
  }) as any;
}
const READY = fakeRun({ '--version': VERSION, 'providers list': CREDENTIALS, models: MODELS });
const here = () => '/usr/local/bin/opencode';
const NOW = () => new Date('2026-09-17T12:00:00Z');

describe('v0.2.2 · a listing is a catalogue, and a catalogue is not permission', () => {
  // COUNTED AGAINST THE FIXTURE, NOT AGAINST A LITERAL. This read `toBe(5)` while the ladder named
  // one OpenCode model; the free pool added six more, so the result now also carries the refused
  // rows for the pool members this fixture does not list, and a hard 5 failed on a correct answer.
  // Deriving the count keeps the assertion about the SEMANTICS — every listed row unproven, every
  // unlisted ladder row refused, nothing proven either way — instead of about the ladder's length.
  it('records every listed model as unproven, with an empty verifiedModelID', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    const listed = MODELS.split('\n').filter((line) => line.length > 0);

    expect(status.models.filter((model) => listed.includes(model.modelID))).toHaveLength(listed.length);
    for (const model of status.models) {
      expect(model.availability).not.toBe('proven');
      expect(model.availability).toBe(listed.includes(model.modelID) ? 'unproven' : 'refused');
      // A verified identifier is what a PROVIDER RETURNED. Nothing returned anything here.
      expect(model.verifiedModelID).toBe('');
    }
  });

  it('makes nothing selectable, so nothing can enter a campaign manifest', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(selectableModels([status])).toEqual([]);
  });

  it('holds the line for Union Alpha specifically', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID)!;

    expect(union.availability).toBe('unproven');
    expect(union.verifiedModelID).toBe('');
    expect(selectableModels([status]).map((model) => model.modelID)).not.toContain(UNION_ALPHA_MODEL_ID);
  });

  it('says WHY in the evidence, so a reader is not left to infer it', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID)!;

    expect(union.evidence).toContain('DISCOVERED, NOT PROVEN');
    expect(union.evidence).toContain('cached model catalogue');
    expect(union.evidence).toContain('not evidence that this credential may call it');
  });

  it('names the command that WOULD establish it, and what that command costs', async () => {
    // CORRECTED IN v0.2.4. Until v0.2.3 there was no OpenCode execution adapter and this text said
    // so; the adapter shipped and the sentence did not change, so discovery kept writing a claim the
    // same build could disprove. The honest version names the route and the fact that it is billed.
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(status.detail).not.toContain('no OpenCode execution adapter');
    expect(status.detail).toContain('cernum smoke opencodeCLI');
    expect(OPENCODE_PROOF_PATH).toContain('AUTHORIZED request');
    expect(OPENCODE_PROOF_PATH).toContain('billed per token');
    expect(OPENCODE_PROOF_PATH).toContain('--authorize-metered');
    expect(OPENCODE_LISTING_IS_A_CATALOGUE).toContain('DISCOVERED and UNPROVEN');
  });

  it('still refuses to call discovery a proof, now that a proof path exists', async () => {
    // The risk of naming a route is that a reader takes the route's existence for its outcome.
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(status.models.every((model) => model.availability !== 'proven')).toBe(true);
    expect(OPENCODE_PROOF_PATH).toContain('proves EXECUTION');
    expect(OPENCODE_PROOF_PATH).toContain('names no model leaves the candidate unproven');
  });
});

describe('v0.2.2 · no combination of discovery signals adds up to proof', () => {
  it('a credential plus a listing is still not proof', async () => {
    // Authenticated, reachable, listing the model by name: the strongest state discovery can reach.
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(status.reachability).toBe('ready');
    expect(status.detail).toContain('1 configured credential');
    expect(status.models.some((model) => model.availability === 'proven')).toBe(false);
  });

  it('running discovery repeatedly never promotes anything', async () => {
    // Nothing accumulates. A second and third look at the same catalogue is the same catalogue.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
      expect(selectableModels([status])).toEqual([]);
    }
  });

  it('does not invoke a model while establishing any of this', async () => {
    const asked: string[] = [];
    await discoverOpenCodeCLI({
      findExecutable: here, now: NOW,
      run: async ({ args }: { args: string[] }) => {
        asked.push(args.join(' '));
        return { stdout: args[0] === '--version' ? VERSION : args[0] === 'providers' ? CREDENTIALS : MODELS,
                 stderr: '', exitCode: 0, signal: null, elapsedMilliseconds: 1, failure: undefined } as any;
      },
    });
    expect(asked).toEqual(['--version', 'providers list', 'models']);
    expect(asked.some((call) => call.startsWith('run'))).toBe(false);
  });

  it('routes through the shared router to the same answer', async () => {
    // The router is what both the terminal and the application call, so the semantics cannot differ
    // by surface — which is the mistake v0.2.1 made about routing itself.
    const viaRouter = await discoverProvider('opencodeCLI', { findExecutable: here, now: NOW, run: READY });
    expect(selectableModels([viaRouter])).toEqual([]);
  });
});

describe('v0.2.2 · the plan is still visible, and still just a plan', () => {
  it('keeps Union Alpha on the intended ladder without that implying availability', () => {
    const planned = DESIRED_CANDIDATE_LADDER.find((entry) => entry.modelID === UNION_ALPHA_MODEL_ID);
    expect(planned).toBeDefined();
    expect(planned!.provider).toBe('opencodeCLI');
  });

  it('records an identifier OpenCode does not know as refused, and still not as absent', async () => {
    const withoutUnion = fakeRun({
      '--version': VERSION, 'providers list': CREDENTIALS,
      models: 'opencode/big-pickle\nopencode/gpt-5.6-terra\n',
    });
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: withoutUnion });
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID)!;

    expect(union.availability).toBe('refused');
    expect(union.evidence).toContain('does not know this identifier');
    // And the correction that matters: being named would not have been proof either.
    expect(union.evidence).toContain('Being named would not have proven it either');
  });
});

describe('v0.2.5 · the maturity label says what the one live request did and did not establish', () => {
  // WHY THIS BLOCK EXISTS. `OPENCODE_SUPPORT_MATURITY` said "no live OpenCode request has been made by
  // this engine". That was true when written and stopped being true the first time one was sent. It is
  // a DISCOVERY string, interpolated beside every OpenCode row on every run, so a stale sentence here
  // fills the store with a claim the same build disproves — which is precisely the defect
  // `OPENCODE_SUPERSEDED_NO_PROOF_PATH` is kept around to record having made once already.
  //
  // The four distinctions below are the whole point of the correction, and each is asserted separately
  // so that half-updating the sentence fails rather than passes.

  it('no longer claims that no live request has been made', () => {
    expect(OPENCODE_SUPPORT_MATURITY).not.toContain('no live OpenCode');
    expect(OPENCODE_SUPPORT_MATURITY).not.toContain('UNTESTED METERED API');
  });

  it('SAYS a live request occurred, with a date and a subject that can be checked', () => {
    expect(OPENCODE_SUPPORT_MATURITY).toContain('has now been sent and came back');
    expect(OPENCODE_SUPPORT_MATURITY).toContain(OPENCODE_FIRST_LIVE_REQUEST_AT);
    expect(OPENCODE_SUPPORT_MATURITY).toContain(OPENCODE_FIRST_LIVE_REQUEST_MODEL);
  });

  it('SAYS the reply is now readable, and names that as a fact about the envelope', () => {
    expect(OPENCODE_SUPPORT_MATURITY).toContain('opencode run --format json');
    expect(OPENCODE_SUPPORT_MATURITY).toMatch(/read the answer, the token counts/);
  });

  it('SAYS identity is still unverifiable, and why it is structural rather than incidental', () => {
    expect(OPENCODE_SUPPORT_MATURITY).toContain('named NO MODEL');
    expect(OPENCODE_SUPPORT_MATURITY).toContain('identity-unverifiable');
    // The consequence, stated rather than left to be discovered: nothing catches a substitution here.
    expect(OPENCODE_SUPPORT_MATURITY).toMatch(/substituted model would be indistinguishable/);
  });

  it('SAYS governance did not move, which is the claim a reader is most likely to get wrong', () => {
    expect(OPENCODE_SUPPORT_MATURITY).toContain('NOTHING ABOUT QUALIFICATION OR ROUTING CHANGED');
    expect(OPENCODE_SUPPORT_MATURITY).toMatch(/no OpenCode model is proven, promotable or selectable/);
    expect(OPENCODE_SUPPORT_MATURITY).toContain('no scored Cernum campaign has been run through OpenCode');
  });

  it('does not let one executed request read as a measurement', () => {
    // A request that came back is not a benchmark, and the published capture is a fixture rather than
    // a finding about any model. Both had to survive the rewrite.
    expect(OPENCODE_SUPPORT_MATURITY).toContain('UNBENCHMARKED');
    expect(OPENCODE_SUPPORT_MATURITY).toMatch(/a fixture, not a result about any model/);
  });

  it('still reaches every discovery surface that carried the old sentence', async () => {
    // Not installed, no credential, and ready: three different early returns, all of which append the
    // maturity string. A correction that only reached one of them would leave the other two stale.
    const notInstalled = await discoverOpenCodeCLI({ findExecutable: () => undefined, run: READY, now: NOW });
    expect(notInstalled.detail).toContain(OPENCODE_SUPPORT_MATURITY);

    const noCredential = await discoverOpenCodeCLI({
      findExecutable: here, now: NOW,
      run: fakeRun({ '--version': VERSION, 'providers list': '└  0 credentials\n', models: MODELS }),
    });
    expect(noCredential.reachability).toBe('noCredential');
    expect(noCredential.detail).toContain(OPENCODE_SUPPORT_MATURITY);

    const ready = await discoverOpenCodeCLI({ findExecutable: here, run: READY, now: NOW });
    expect(ready.reachability).toBe('ready');
    expect(ready.detail).toContain(OPENCODE_SUPPORT_MATURITY);
  });

  it('PROMOTES NOTHING. Correcting a sentence is not evidence about a model', async () => {
    // The rule this repository already applies to superseded evidence, applied to its own edit.
    const discovered = await discoverOpenCodeCLI({ findExecutable: here, run: READY, now: NOW });

    expect(discovered.models.every((model) => model.availability !== 'proven')).toBe(true);
    expect(discovered.models.every((model) => model.verifiedModelID === '')).toBe(true);
    expect(selectableModels([discovered])).toHaveLength(0);
  });
});
