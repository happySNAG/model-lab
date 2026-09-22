// Cernum · the free OpenCode candidate pool — added to the plan, and inert in every other respect.
//
// WHAT THIS CHANGE WAS, AND THEREFORE WHAT THESE TESTS HAVE TO PROVE. Six OpenCode models whose
// catalogue list price is $0 were added to `DESIRED_CANDIDATE_LADDER` so Cernum can NAME them,
// discover them, and be pointed at them by a smoke test. That is a candidate-cohort change. It is
// not a routing change, and the danger in it is not that it fails — it is that it succeeds slightly
// too far, and a model that nothing has ever called ends up selectable because somebody added a line
// to a list and the engine agreed.
//
// So the assertions below are mostly NEGATIVE, and deliberately so. Being on the ladder must not
// qualify a model. Being DISCOVERED must not qualify it either — that is the specific mistake
// v0.2.1 made for the whole OpenCode provider, and six new rows are six new chances to make it
// again. A free price must not read as a measured cost. And `opencode/union-alpha`, which OpenCode
// stopped listing, must remain un-selectable while its row remains on the record.
//
// NOTHING HERE CONTACTS OPENCODE. Every listing below is a fixture.

import { describe, expect, it } from 'vitest';
import {
  DESIRED_CANDIDATE_LADDER, FREE_OPENCODE_DEVELOPMENT_POOL, LadderEntry,
  desiredCandidates, discoverOpenCodeCLI, discoverProvider, selectableModels,
} from '../../src/engine/discovery';
import {
  OPENCODE_CATALOGUE_OBSERVED_AT, OPENCODE_COST_PROVENANCE, UNION_ALPHA_MODEL_ID,
  UNION_ALPHA_NOT_LISTED_SINCE, parseOpenCodeModels,
} from '../../src/engine/opencode-cli';
import {
  AUTHORIZED_COHORT, CERNUM_V2_ADDITIONS, FREE_OPENCODE_POOL_ADDITIONS, OPENAI_API_IDENTITY_ADDITIONS, REQUESTED_COHORT,
  configurationKey, ladderConfigurations, reconcileCohort,
} from '../../src/engine/reconciliation';
import { billingBasisOf, executionClassOf } from '../../src/engine/provider';
import { buildCampaignPlan } from '../../src/engine/campaign-builder';

/** The six identifiers this pass added, written out rather than derived, so a silent drop is red. */
const ADDED = [
  'opencode/big-pickle',
  'opencode/mimo-v2.5-free',
  'opencode/muse-spark-1.2-contributor-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
];

const ESC = '\x1b';
const VERSION = '1.18.31\n';
const CREDENTIALS = [
  `${ESC}[0m`, `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`, '│',
  `◗  OpenCode Zen ${ESC}[90mapi`, '│', '└  1 credentials', '',
].join('\n');

/**
 * THE LISTING AS IT ACTUALLY IS ON 2026-09-20: the six free models present, Union Alpha absent.
 *
 * Union Alpha's absence is the fixture's whole point and is not an oversight in it. OpenCode listed
 * 71 models that day and this identifier was not one of them.
 */
const LIVE_MODELS = [...ADDED, 'opencode/claude-opus-5', 'opencode/gpt-5.6-terra', ''].join('\n');

function fakeRun(byArgs: Record<string, string>) {
  return async ({ args }: { args: string[] }) => ({
    stdout: byArgs[args.join(' ')] ?? '', stderr: '', exitCode: 0, signal: null,
    elapsedMilliseconds: 1, firstByteMilliseconds: 1, failure: undefined,
  }) as any;
}
const LIVE = fakeRun({ '--version': VERSION, 'providers list': CREDENTIALS, models: LIVE_MODELS });
const here = () => '/usr/local/bin/opencode';
const NOW = () => new Date('2026-09-20T12:00:00Z');

function poolRow(modelID: string): LadderEntry {
  const row = FREE_OPENCODE_DEVELOPMENT_POOL.find((entry) => entry.modelID === modelID);
  expect(row, `${modelID} is not in the free pool`).toBeDefined();
  return row!;
}

describe('the free OpenCode pool is on the plan, addressed the way OpenCode addresses it', () => {
  it('adds exactly the six models that were proposed, under their exact identifiers', () => {
    expect(FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => entry.modelID).sort()).toEqual([...ADDED].sort());
    for (const modelID of ADDED) {
      expect(DESIRED_CANDIDATE_LADDER.some((entry) => entry.modelID === modelID)).toBe(true);
    }
  });

  it('keeps OpenCode\'s own `provider/model` addressing, byte for byte', () => {
    for (const row of FREE_OPENCODE_DEVELOPMENT_POOL) {
      expect(row.provider).toBe('opencodeCLI');
      expect(row.modelID.startsWith('opencode/')).toBe(true);
      // The identifier Cernum would send must survive the parser that reads OpenCode's own listing.
      expect(parseOpenCodeModels(`${row.modelID}\n`)).toEqual([row.modelID]);
    }
  });

  // THE FINANCE MODEL WAS LEFT OUT ON PURPOSE. `opencode/ling-3.0-flash-fin-free` is free and
  // tool-capable and is a finance-domain model, so it is not a development candidate. Asserting its
  // absence makes that a decision on the record rather than a gap somebody later fills by guessing.
  it('does not quietly pick up the free model that is not a development model', () => {
    expect(DESIRED_CANDIDATE_LADDER.some((entry) => entry.modelID === 'opencode/ling-3.0-flash-fin-free'))
      .toBe(false);
  });

  // EVERY ROW AT `none`, INCLUDING THE TWO THE CATALOGUE GIVES EFFORT LEVELS FOR. Asking for a
  // setting the provider turns out not to accept is how Pass 5 read a correct refusal as a fact
  // about a model.
  it('asks for no effort level, because nothing has established which ones OpenCode accepts', () => {
    for (const row of FREE_OPENCODE_DEVELOPMENT_POOL) expect(row.desiredEfforts).toEqual(['none']);
  });
});

describe('every new candidate begins untested, and stays that way', () => {
  it('is born unproven on the plan, with no identifier any provider returned', () => {
    const planned = desiredCandidates('2026-09-20T12:00:00Z')
      .filter((model) => ADDED.includes(model.modelID));
    expect(planned).toHaveLength(ADDED.length);
    for (const model of planned) {
      expect(model.availability).toBe('unproven');
      expect(model.verifiedModelID).toBe('');
      // The caveat comes FIRST and the provenance after it, so the sentence that reads like
      // availability is never the one a reader meets first.
      expect(model.evidence).toMatch(/A model identifier is not a capability claim/);
    }
  });

  it('is not selectable from the plan', () => {
    expect(selectableModels([{
      provider: 'opencodeCLI', label: '', executionClass: 'meteredAPI', billingBasis: 'meteredAPI',
      reachability: 'unknown', detail: '', probe: 'offline',
      models: desiredCandidates('now'), checkedAt: 'now',
    }])).toEqual([]);
  });

  it('carries no benchmark result, no score and no qualification anywhere on the row', () => {
    for (const row of FREE_OPENCODE_DEVELOPMENT_POOL) {
      expect(Object.keys(row).sort()).toEqual(['desiredEfforts', 'displayName', 'modelID', 'provenance', 'provider']);
    }
  });
});

describe('DISCOVERY DOES NOT QUALIFY THEM — the v0.2.1 mistake, six new chances to repeat it', () => {
  it('discovers all six from a live listing and proves not one of them', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: LIVE });
    expect(status.reachability).toBe('ready');
    for (const modelID of ADDED) {
      const row = status.models.find((model) => model.modelID === modelID)!;
      expect(row, `${modelID} was not discovered`).toBeDefined();
      expect(row.availability).toBe('unproven');
      expect(row.verifiedModelID).toBe('');
      expect(row.evidence).toContain('DISCOVERED, NOT PROVEN');
    }
    // `ready` describes OPENCODE, which answered. It has never described a model.
    expect(selectableModels([status])).toEqual([]);
  });

  it('is still not selectable through the shared router, which both surfaces call', async () => {
    const viaRouter = await discoverProvider('opencodeCLI', { findExecutable: here, now: NOW, run: LIVE });
    expect(selectableModels([viaRouter])).toEqual([]);
  });

  // THE CAMPAIGN GATE, ASSERTED RATHER THAN ASSUMED. A discovered-but-unproven row is the exact
  // input that must be refused, so it is the input this test supplies.
  it('refuses to plan a campaign around a discovered free model', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: LIVE });
    expect(() => buildCampaignPlan({
      label: 'attempted', suiteIDs: ['suite.model-lab.foundation'], repeatsPerCase: 1,
      local: [], endpoint: 'http://127.0.0.1:11434',
      hardware: { machine: 't', cpu: 't', cores: 1, memoryBytes: 1, os: 't', arch: 't' },
      runtimeVersion: 'test',
      frontier: [{
        name: 'spark', provider: 'opencodeCLI', modelID: 'opencode/muse-spark-1.3-contributor-free',
        effort: 'none', thinkingMode: 'runtimeDefault',
      }],
      // Everything discovery established, handed over in full. None of it is proof.
      provenModels: status.models,
    } as never)).toThrow(/has not been proven callable/);
  });
});

describe('union-alpha is unavailable, preserved, and unselectable', () => {
  it('keeps the row rather than deleting the evidence that the question was asked', () => {
    const row = DESIRED_CANDIDATE_LADDER.find((entry) => entry.modelID === UNION_ALPHA_MODEL_ID)!;
    expect(row).toBeDefined();
    expect(row.provider).toBe('opencodeCLI');
    expect(CERNUM_V2_ADDITIONS.map((entry) => entry.modelID)).toEqual([UNION_ALPHA_MODEL_ID]);
  });

  it('marks it NOT LISTED, with the date and the command that established it', () => {
    const row = DESIRED_CANDIDATE_LADDER.find((entry) => entry.modelID === UNION_ALPHA_MODEL_ID)!;
    expect(row.provenance!.catalogueStatus).toBe('notListed');
    expect(row.provenance!.observedAt).toBe(UNION_ALPHA_NOT_LISTED_SINCE);
    expect(row.provenance!.source).toContain('opencode models');
    // UNKNOWN, not `paid`: a catalogue that no longer carries a model no longer carries its price.
    expect(row.provenance!.cataloguedCost).toBe('unknown');
  });

  it('is recorded REFUSED against a listing that does not name it, and cannot be selected', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: LIVE });
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID)!;
    expect(union.availability).toBe('refused');
    expect(union.evidence).toContain('does not know this identifier');
    expect(selectableModels([status]).some((model) => model.modelID === UNION_ALPHA_MODEL_ID)).toBe(false);
  });

  it('cannot be planned into a campaign even with the whole discovery result in hand', async () => {
    const status = await discoverOpenCodeCLI({ findExecutable: here, now: NOW, run: LIVE });
    expect(() => buildCampaignPlan({
      label: 'attempted', suiteIDs: ['suite.model-lab.foundation'], repeatsPerCase: 1,
      local: [], endpoint: 'http://127.0.0.1:11434',
      hardware: { machine: 't', cpu: 't', cores: 1, memoryBytes: 1, os: 't', arch: 't' },
      runtimeVersion: 'test',
      frontier: [{
        name: 'union', provider: 'opencodeCLI', modelID: UNION_ALPHA_MODEL_ID,
        effort: 'none', thinkingMode: 'runtimeDefault',
      }],
      provenModels: status.models,
    } as never)).toThrow(/has not been proven callable/);
  });
});

describe('free is a LIST PRICE, and the engine never lets it become a measured cost', () => {
  it('records every pool row as catalogued-free, with the source and the day it was read', () => {
    for (const modelID of ADDED) {
      const row = poolRow(modelID);
      expect(row.provenance!.cataloguedCost).toBe('free');
      expect(row.provenance!.catalogueStatus).toBe('listed');
      expect(row.provenance!.observedAt).toBe(OPENCODE_CATALOGUE_OBSERVED_AT);
      expect(row.provenance!.source).toContain('opencode models');
    }
  });

  // THE DISTINCTION THIS WHOLE FIELD EXISTS FOR. A $0 list price is what OpenCode says it charges.
  // The cost provenance is what Cernum observed. They are not the same answer and one must never
  // silently become the other.
  it('leaves the OpenCode cost provenance UNAVAILABLE, free models included', () => {
    expect(OPENCODE_COST_PROVENANCE).toBe('unavailable');
    for (const modelID of ADDED) {
      expect(poolRow(modelID).provenance!.detail).toContain('cost provenance');
      expect(poolRow(modelID).provenance!.detail).toContain('UNAVAILABLE');
      expect(poolRow(modelID).provenance!.detail).not.toMatch(/\bcosts nothing\b/);
    }
  });

  // FREE DOES NOT MEAN UNMETERED. The provider is still reached as a metered API, so a campaign that
  // selected one would still cross the metered-authorization gate.
  it('does not reclassify OpenCode as subscription-included because some of its models are free', () => {
    expect(executionClassOf('opencodeCLI')).toBe('meteredAPI');
    expect(billingBasisOf(executionClassOf('opencodeCLI'))).toBe('meteredAPI');
    expect(billingBasisOf(executionClassOf('opencodeCLI'))).not.toBe('subscriptionIncluded');
  });

  it('never writes a price onto a row nothing looked up', () => {
    for (const entry of DESIRED_CANDIDATE_LADDER) {
      if (!entry.provenance) continue;
      expect(['free', 'paid', 'unknown']).toContain(entry.provenance.cataloguedCost);
      // A `free` claim requires a listing that actually named the model.
      if (entry.provenance.cataloguedCost === 'free') expect(entry.provenance.catalogueStatus).toBe('listed');
    }
  });
});

describe('the existing cohort invariants still hold, unchanged by the addition', () => {
  it('leaves the frozen Pass 5C request at 12, with no OpenCode row in it', () => {
    expect(REQUESTED_COHORT).toHaveLength(12);
    expect(REQUESTED_COHORT.some((entry) => entry.provider === 'opencodeCLI')).toBe(false);
  });

  it('authorises the six under their own list, not by editing either earlier one', () => {
    expect(FREE_OPENCODE_POOL_ADDITIONS.map((entry) => entry.modelID).sort()).toEqual([...ADDED].sort());
    expect(AUTHORIZED_COHORT).toHaveLength(
      REQUESTED_COHORT.length + CERNUM_V2_ADDITIONS.length + OPENAI_API_IDENTITY_ADDITIONS.length
      + FREE_OPENCODE_POOL_ADDITIONS.length);
  });

  it('reconciles with nothing missing and nothing extra', () => {
    const result = reconcileCohort();
    expect(result.missingFromLadder).toEqual([]);
    expect(result.extraInLadder).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.requestedCount).toBe(12);
  });

  it('still reports a ladder entry nobody authorised as extra', () => {
    const authorized = new Set(AUTHORIZED_COHORT.map(configurationKey));
    expect(authorized.has(configurationKey({
      provider: 'opencodeCLI', modelID: 'opencode/ling-3.0-flash-fin-free', effort: 'none',
    }))).toBe(false);
    expect(new Set(ladderConfigurations().map(configurationKey)))
      .toEqual(new Set(AUTHORIZED_COHORT.map(configurationKey)));
  });
});
