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
  UNION_ALPHA_MODEL_ID, OPENCODE_LISTING_IS_A_CATALOGUE, OPENCODE_NO_PROOF_PATH,
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
  it('records every listed model as unproven, with an empty verifiedModelID', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });

    expect(status.models.length).toBe(5);
    for (const model of status.models) {
      expect(model.availability).not.toBe('proven');
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

  it('tells a reader there is no command that would fix it, rather than implying one', async () => {
    // The cruelty of a bare `unproven` is that it reads like a chore. There is no OpenCode execution
    // adapter, so there is no request Cernum could make — and the status says so.
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: READY });
    expect(status.detail).toContain('no OpenCode execution adapter');
    expect(OPENCODE_NO_PROOF_PATH).toContain('no OpenCode execution adapter');
    expect(OPENCODE_LISTING_IS_A_CATALOGUE).toContain('DISCOVERED and UNPROVEN');
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
