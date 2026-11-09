// Cernum · Claude Sonnet 5.5 and Claude Haiku 5.5 — authorised as candidates, born unproven.
//
// WHAT THIS FILE PINS. The owner's 2026-11-08 written authorisation adds two claudeCLI identifiers
// as a separate Cernum candidate list, `CLAUDE_SONNET_HAIKU_5_5_ADDITIONS`, with no routing change.
// The identifiers are the owner's and are confirmed only by a later identity smoke test, so this
// file asserts the rows exist as a PLAN and nothing more: present in the authorised cohort and the
// ladder, absent from the frozen Pass 5C request, unproven everywhere, and never selectable.
//
// It also asserts the addition disturbed nothing else: every other ladder row equals its literal
// value at base 4b705c8.
//
// NOTHING IN THIS FILE CONTACTS A PROVIDER. Discovery is driven by a fake `claude` under
// os.tmpdir() that answers `--version` and `auth status` and nothing else.

import { describe, expect, it } from 'vitest';
import {
  DESIRED_CANDIDATE_LADDER, ProviderStatus, desiredCandidates, discoverSubscriptionCLI, selectableModels,
} from '../../src/engine/discovery';
import {
  AUTHORIZED_COHORT, CLAUDE_SONNET_HAIKU_5_5_ADDITIONS, REQUESTED_COHORT, configurationKey,
} from '../../src/engine/reconciliation';
import { writeFakeCLI } from './frontier-harness';

const NEW_IDS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

/** Every ladder row at base 4b705c8, in ladder order, written out as literals. */
const BASE_LADDER: { provider: string; modelID: string; displayName: string; desiredEfforts: string[] }[] = [
  { provider: 'claudeCLI', modelID: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-opus-5', displayName: 'Claude Opus 5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', desiredEfforts: ['high'] },
  { provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', desiredEfforts: ['high', 'max'] },
  { provider: 'claudeCLI', modelID: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', desiredEfforts: ['none'] },
  { provider: 'codexCLI', modelID: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', desiredEfforts: ['max'] },
  { provider: 'codexCLI', modelID: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', desiredEfforts: ['medium'] },
  { provider: 'codexCLI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', desiredEfforts: ['medium', 'max'] },
  { provider: 'codexCLI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', desiredEfforts: ['medium', 'max'] },
  { provider: 'openaiAPI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', desiredEfforts: ['low'] },
  { provider: 'opencodeCLI', modelID: 'opencode/union-alpha', displayName: 'Union Alpha', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/big-pickle', displayName: 'Big Pickle', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/mimo-v2.5-free', displayName: 'MiMo V2.5 Free', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/muse-spark-1.2-contributor-free', displayName: 'Muse Spark 1.2 Free', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/nemotron-3-ultra-free', displayName: 'Nemotron 3 Ultra Free', desiredEfforts: ['none'] },
  { provider: 'opencodeCLI', modelID: 'opencode/nemotron-3.5-lightning-free', displayName: 'Nemotron 3.5 Lightning Free', desiredEfforts: ['none'] },
];

const shape = (entry: { provider: string; modelID: string; displayName: string; desiredEfforts: readonly string[] }) => ({
  provider: entry.provider, modelID: entry.modelID, displayName: entry.displayName, desiredEfforts: [...entry.desiredEfforts],
});

describe('(a) the authorisation list is exactly the two, and the cohort admits them', () => {
  it('is claudeCLI claude-sonnet-5-5 and claude-haiku-5-5 at effort none, and nothing else', () => {
    expect(CLAUDE_SONNET_HAIKU_5_5_ADDITIONS).toEqual([
      { provider: 'claudeCLI', modelID: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', effort: 'none' },
      { provider: 'claudeCLI', modelID: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', effort: 'none' },
    ]);
  });

  it('puts every entry in AUTHORIZED_COHORT', () => {
    const authorised = AUTHORIZED_COHORT.map(configurationKey);
    for (const entry of CLAUDE_SONNET_HAIKU_5_5_ADDITIONS) {
      expect(authorised).toContain(configurationKey(entry));
    }
  });
});

describe('(b) the frozen Pass 5C request is untouched', () => {
  it('still has 12 entries and names neither identifier', () => {
    expect(REQUESTED_COHORT).toHaveLength(12);
    for (const modelID of NEW_IDS) {
      expect(REQUESTED_COHORT.some((entry) => entry.modelID === modelID), modelID).toBe(false);
    }
  });
});

describe('(c) the ladder has one claudeCLI row for each', () => {
  it('has exactly one row per identifier, on claudeCLI', () => {
    for (const modelID of NEW_IDS) {
      const rows = DESIRED_CANDIDATE_LADDER.filter((entry) => entry.modelID === modelID);
      expect(rows, modelID).toHaveLength(1);
      expect(rows[0].provider, modelID).toBe('claudeCLI');
      expect(rows[0].desiredEfforts, modelID).toEqual(['none']);
    }
  });
});

describe('(d) both rows are unproven and never selectable', () => {
  it('is unproven in the ladder-as-unproven view, and selectableModels drops it', () => {
    const planned = desiredCandidates('2026-11-08T00:00:00Z');
    for (const modelID of NEW_IDS) {
      const rows = planned.filter((model) => model.modelID === modelID);
      expect(rows, modelID).toHaveLength(1);
      expect(rows[0].availability, modelID).toBe('unproven');
      expect(rows[0].verifiedModelID, modelID).toBe('');
    }
    const status: ProviderStatus = {
      provider: 'claudeCLI', label: 'Claude', executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      reachability: 'ready', detail: '', probe: 'offline', models: planned, checkedAt: 'now',
    };
    const selectable = selectableModels([status]).map((model) => model.modelID);
    for (const modelID of NEW_IDS) expect(selectable, modelID).not.toContain(modelID);
  });

  it('is unproven in discovery output when nothing has proved it, and selectableModels drops it', async () => {
    const fake = writeFakeCLI('claude', `
      if [ "$1" = "--version" ]; then echo "2.1.251 (Claude Code)"; exit 0; fi
      if [ "$1" = "auth" ]; then
        echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'
        exit 0
      fi
      echo "unknown command" >&2; exit 1
    `);
    try {
      const status = await discoverSubscriptionCLI('claudeCLI', { findExecutable: () => fake.executablePath });
      for (const modelID of NEW_IDS) {
        const rows = status.models.filter((model) => model.modelID === modelID);
        expect(rows, modelID).toHaveLength(1);
        expect(rows[0].availability, modelID).toBe('unproven');
      }
      const selectable = selectableModels([status]).map((model) => model.modelID);
      for (const modelID of NEW_IDS) expect(selectable, modelID).not.toContain(modelID);
    } finally { fake.cleanup(); }
  });
});

describe('(e) nothing else in the ladder changed', () => {
  it('leaves every other row, of every provider, equal to its literal value at the base', () => {
    const others = DESIRED_CANDIDATE_LADDER.filter((entry) => !NEW_IDS.includes(entry.modelID)).map(shape);
    expect(others).toEqual(BASE_LADDER);
  });

  it('places the two directly after claude-opus-5-5', () => {
    const ids = DESIRED_CANDIDATE_LADDER.map((entry) => entry.modelID);
    const opus = ids.indexOf('claude-opus-5-5');
    expect(ids.slice(opus, opus + 3)).toEqual(['claude-opus-5-5', ...NEW_IDS]);
  });
});
