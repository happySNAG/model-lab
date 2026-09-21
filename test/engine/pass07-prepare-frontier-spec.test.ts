// Cernum · `prepare --frontier` refuses what it cannot represent, instead of absorbing it.
//
// THE DEFECT THIS FILE PINS. `cernum prepare --frontier` destructured `spec.split(':')` into three
// names and checked only that the first two were non-empty. `create` splits `--frontier` on commas;
// `prepare` never did — so a comma-separated cohort was not rejected, it was SWALLOWED. This:
//
//   --frontier codexCLI:gpt-5.6-luna:max,codexCLI:gpt-5.6-terra:medium,codexCLI:gpt-5.6-sol:medium
//
// prepared exactly ONE candidate, whose effort was the string `max,codexCLI`, and wrote it into a
// document whose entire purpose is to be read and approved by a person before anything runs. No
// effort validation existed on this path at all, so the invalid value survived into the artefact and
// into its rendered table as `| Effort | max,codexCLI |`.
//
// WHAT IS AND IS NOT BEING FIXED. `prepare` accepts ONE candidate — its name, its candidate block
// and its attempt count are each shaped for one — so the fix is to REFUSE a list, not to start
// accepting one. Teaching it multi-spec support here would invent a contract rather than enforce the
// one that exists. `create`, which genuinely takes a cohort, is not touched and is held to that by
// the last block in this file.
//
// NOTHING HERE SENDS A PROVIDER REQUEST. `prepare` reaches no provider by design, and the
// subprocess tests assert on refusals that happen before any work at all.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSoleFrontierSpec } from '../../src/cli/cernum';
import { EFFORT_LEVELS, PROVIDER_IDS } from '../../src/engine/provider';

const root = path.resolve(__dirname, '..', '..');
let out: string;

beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-prepare-spec-')); });
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

function cernum(...args: string[]) {
  const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args], { cwd: root, encoding: 'utf8' });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function preparedManifest(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(out, `CERNUM-PASS-09-PREPARED-MANIFEST-${name}.json`), 'utf8'));
}

describe('a valid single spec still works', () => {
  it('accepts provider:model and defaults the effort to none', () => {
    expect(parseSoleFrontierSpec('codexCLI:gpt-6-astra'))
      .toEqual({ provider: 'codexCLI', requestedModelID: 'gpt-6-astra', effort: 'none' });
  });

  it('accepts provider:model:effort', () => {
    expect(parseSoleFrontierSpec('codexCLI:gpt-6-astra:max'))
      .toEqual({ provider: 'codexCLI', requestedModelID: 'gpt-6-astra', effort: 'max' });
  });

  it('accepts every canonical effort level, so the parser cannot drift from the engine', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(parseSoleFrontierSpec(`claudeCLI:claude-sonnet-5:${effort}`).effort).toBe(effort);
    }
  });

  it('accepts every provider Cernum has', () => {
    for (const provider of PROVIDER_IDS) {
      expect(parseSoleFrontierSpec(`${provider}:some-model`).provider).toBe(provider);
    }
  });

  it('keeps a model id containing hyphens and dots intact', () => {
    expect(parseSoleFrontierSpec('codexCLI:gpt-5.6-luna:max').requestedModelID).toBe('gpt-5.6-luna');
  });

  it('names the candidate without an @ suffix when the effort is none', () => {
    // The old code wrote `p:m@none` for an explicit `:none`, because it tested the string's
    // truthiness rather than its value. `create` has always written `p:m`; these now agree.
    expect(cernum('prepare', 'spec-none', '--frontier', 'codexCLI:gpt-6-astra:none', '--out', out).status).toBe(0);
    expect((preparedManifest('spec-none').candidate as Record<string, unknown>).name).toBe('codexCLI:gpt-6-astra');
  }, 120_000);

  it('writes a document end to end, with the effort it was actually given', () => {
    const result = cernum('prepare', 'spec-ok', '--frontier', 'codexCLI:gpt-6-astra:max', '--out', out);
    expect(result.status).toBe(0);
    const candidate = preparedManifest('spec-ok').candidate as Record<string, unknown>;
    expect(candidate).toMatchObject({ provider: 'codexCLI', requestedModelID: 'gpt-6-astra', effort: 'max' });
    expect(candidate.name).toBe('codexCLI:gpt-6-astra@max');
  }, 120_000);
});

describe('a comma-separated list is refused, not absorbed', () => {
  // THE EXACT STRING FROM THE INCIDENT. The six Tier B Codex configurations, passed as one value.
  const SIX = 'codexCLI:gpt-5.6-luna:max,codexCLI:gpt-5.6-terra:medium,codexCLI:gpt-5.6-sol:medium,'
    + 'codexCLI:gpt-5.6-sol:max,codexCLI:gpt-6-astra:medium,codexCLI:gpt-6-astra:max';

  it('throws on the six-candidate value that used to prepare one candidate', () => {
    expect(() => parseSoleFrontierSpec(SIX)).toThrow(/more than one candidate/);
  });

  it('never produces the invalid effort the defect produced', () => {
    // The regression in one assertion: `max,codexCLI` was a real effort value in a real artefact.
    // The claim is about what the parser RETURNS — the refusal message quotes the offending spec
    // back, so the substring legitimately appears there and asserting on the text would test the
    // wrong thing.
    let parsed: ReturnType<typeof parseSoleFrontierSpec> | undefined;
    try { parsed = parseSoleFrontierSpec(SIX); } catch { /* refusing is the correct outcome */ }
    expect(parsed).toBeUndefined();
  });

  it('writes no artefact carrying the invalid effort, end to end', () => {
    cernum('prepare', 'spec-effort-leak', '--frontier', SIX, '--out', out);
    for (const file of fs.readdirSync(out)) {
      expect(fs.readFileSync(path.join(out, file), 'utf8')).not.toContain('max,codexCLI');
    }
  }, 120_000);

  it('refuses two candidates just as firmly as six', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra,claudeCLI:claude-sonnet-5'))
      .toThrow(/more than one candidate/);
  });

  it('refuses a trailing comma, which is a list with one empty member', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:max,')).toThrow(/more than one candidate/);
  });

  it('points at `create`, which is the command that does take a cohort', () => {
    expect(() => parseSoleFrontierSpec(SIX)).toThrow(/create --frontier a,b,c/);
  });

  it('exits non-zero and writes no document', () => {
    const result = cernum('prepare', 'spec-list', '--frontier', SIX, '--out', out);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('more than one candidate');
    expect(fs.readdirSync(out)).toEqual([]);
  }, 120_000);
});

describe('a malformed effort is refused', () => {
  it('refuses an effort that is not a level', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:turbo')).toThrow(/not an effort level/);
  });

  it('refuses an empty effort after a trailing colon', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:')).toThrow(/empty or padded effort/);
  });

  it('refuses a padded effort rather than trimming it into validity', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra: max')).toThrow(/empty or padded effort/);
  });

  it('is case-sensitive: MAX is not max', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:MAX')).toThrow(/not an effort level/);
  });

  it('exits non-zero and writes no document', () => {
    const result = cernum('prepare', 'spec-effort', '--frontier', 'codexCLI:gpt-6-astra:turbo', '--out', out);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not an effort level');
    expect(fs.readdirSync(out)).toEqual([]);
  }, 120_000);
});

describe('malformed provider and model fields are refused', () => {
  it('refuses a provider Cernum does not have', () => {
    expect(() => parseSoleFrontierSpec('gpt5CLI:gpt-6-astra:max')).toThrow(/is not a provider Cernum has/);
  });

  it('refuses an empty provider', () => {
    expect(() => parseSoleFrontierSpec(':gpt-6-astra:max')).toThrow(/empty provider/);
  });

  it('refuses an empty model', () => {
    expect(() => parseSoleFrontierSpec('codexCLI::max')).toThrow(/empty model/);
  });

  it('refuses a padded provider or model rather than trimming it into validity', () => {
    expect(() => parseSoleFrontierSpec(' codexCLI:gpt-6-astra')).toThrow(/whitespace around the provider/);
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra ')).toThrow(/whitespace around the model/);
  });

  it('refuses a bare model with no provider at all', () => {
    expect(() => parseSoleFrontierSpec('gpt-6-astra')).toThrow(/colon-separated part/);
  });
});

describe('trailing and embedded garbage is refused rather than dropped', () => {
  it('refuses a fourth colon-separated part instead of silently discarding it', () => {
    // The other half of the original defect: destructuring three names from an N-part split threw
    // everything past the third away without a word.
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:max:extra')).toThrow(/colon-separated part/);
  });

  it('says how many parts it actually saw, so the message is diagnostic', () => {
    expect(() => parseSoleFrontierSpec('a:b:c:d:e')).toThrow(/5 colon-separated part/);
  });

  it('states that nothing is dropped silently', () => {
    expect(() => parseSoleFrontierSpec('codexCLI:gpt-6-astra:max:extra'))
      .toThrow(/refused rather than folded into the effort/);
  });

  it('exits non-zero and writes no document', () => {
    const result = cernum('prepare', 'spec-garbage', '--frontier', 'codexCLI:gpt-6-astra:max:extra', '--out', out);
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(out)).toEqual([]);
  }, 120_000);
});

describe('`create` is unchanged: it still takes a cohort', () => {
  it('still splits --frontier on commas, which is the contract prepare does not have', () => {
    // Read from the source rather than run a campaign: `create` freezes a manifest and costs a
    // request per configuration, which is exactly what this suite must never do.
    const source = fs.readFileSync(path.join(root, 'src', 'cli', 'cernum.ts'), 'utf8');
    expect(source).toContain("String(options.frontier).split(',')");
  });

  it('still parses each member with parseFrontierSpec, which this fix did not touch', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'cli', 'cernum.ts'), 'utf8');
    expect(source).toContain('frontierSpecs.map((spec) => parseFrontierSpec(spec');
  });

  it('accepts a multi-candidate --frontier without complaining that it names more than one', () => {
    // `create` needs a live runtime and a real campaign root, so this asserts only that the cohort
    // value itself is not what stops it — the refusal prepare now raises must not have leaked here.
    const result = cernum('create', 'cohort-check', '--frontier',
      'codexCLI:gpt-6-astra:max,claudeCLI:claude-sonnet-5:high', '--root', out);
    expect(result.output).not.toContain('more than one candidate');
  }, 120_000);
});
