// Cernum · the product is Cernum, and stays Cernum.
//
// The rename from Model Lab left branding behind for several releases after v0.2.0: a sidebar mark
// reading `ML`, a macOS smoke script asserting the old bundle name, a Windows smoke script looking
// for `Model Lab.exe`, sealed suite titles printed raw by `cernum suites`. None of them was caught,
// because nothing was looking. This test looks.
//
// Policy: docs/NAMING.md. Inventory: docs/NAMING-AUDIT-2026-09-24.md.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

/** Any spelling of the old name: Model Lab, Model-Lab, model-lab, MODEL_LAB, ModelLab, modelLab, modellab. */
const LEGACY = /model[ _-]?lab|modellab/i;

/**
 * Whole paths that are sealed evidence or historical record. Their bytes are digested or published,
 * and rewriting them would falsify history or orphan evidence.
 */
const SEALED_PATHS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^fixtures\/parity\//, reason: 'sealed parity corpus (docs/PARITY.md); every byte is digested' },
  { pattern: /^docs\/campaigns\//, reason: 'sealed, hash-chained campaign evidence' },
  { pattern: /^docs\/RELEASE-NOTES-v\d/, reason: 'historical release records' },
  { pattern: /^scripts\/releases\/install-cernum-v/, reason: 'published install scripts, pinned by commit SHA; they recover data from the legacy folder' },
  { pattern: /^docs\/NAMING(-AUDIT-\d{4}-\d{2}-\d{2})?\.md$/, reason: 'the naming policy and audit themselves' },
  { pattern: /^test\/engine\/naming-guard\.test\.ts$/, reason: 'this guard, which must name what it looks for' },
];

/**
 * Identifiers that are part of the persisted evaluation contract, or names this repository does not
 * own. They are removed from a line before it is checked, so they are allowed wherever they appear.
 */
const SEALED_IDENTIFIERS: RegExp[] = [
  /suite\.model-lab\.[a-z0-9-]*/g,                       // suite IDs
  /policy\.model-lab\.[a-z0-9.-]*/g,                      // rule / policy IDs
  /policy\.scoring\.model-lab-foundation[a-z0-9.-]*/g,    // scoring policy IDs
  /model-lab-fake/g,                                      // the reference candidate's provider
  /synthetic:model-lab-c\d-[a-z-]*/g,                     // fixture origins
  /budget\.resource\.model-lab-c\d-unmetered/g,           // resource budgets
  /model-lab-campaign-\d/g,                               // suite provenance
  /model-lab-foundation(-v2)?/g,                          // suite provenance / canonical vectors
  /model-lab-results/g,                                   // the external evidence directory
  /model-lab-v2/g,                                        // the external reference harness
  /(github|githubusercontent)\.com\/happySNAG\/model-lab/g, // the GitHub repository slug
  /SkippyModelLab\w*/g,                                   // external Swift targets
  /`ModelLab[\w*]*`/g,                                    // Swift type names cited in port comments
];

/**
 * Files still allowed to name the old product outside a sealed identifier, with the EXACT number of
 * lines that do. An exact count, not a ceiling: a new mention fails, and so does a removed one, so
 * this list can never drift into a blanket exemption.
 */
const ALLOWED: Record<string, { lines: number; reason: string }> = {
  // Migration: how an old install is found and carried across.
  'src/main/user-data-migration.ts': { lines: 5, reason: 'LEGACY_PRODUCT_NAME, the legacy log name, and the history of the v0.2.1 defect' },
  'test/engine/user-data-migration.test.ts': { lines: 26, reason: 'exercises the legacy directory and log by name' },
  // Compatibility aliases.
  'src/shared/product.ts': { lines: 3, reason: 'MODEL_LAB_* environment fallback and its history' },
  'test/engine/product-identity.test.ts': { lines: 6, reason: 'tests the MODEL_LAB_* alias' },
  'test/engine/installed-command.test.ts': { lines: 4, reason: 'tests the MODEL_LAB_CAMPAIGN_ROOT alias; a space-in-name launcher case' },
  'test/e2e/packaged-mac.spec.ts': { lines: 2, reason: 'MODEL_LAB_APP alias' },
  'scripts/regenerate-ledger-plan-vectors.py': { lines: 2, reason: 'MODEL_LAB_HARNESS alias' },
  'src/shared/ipc.ts': { lines: 2, reason: 'displaySuiteTitle removes the sealed "Model Lab " title prefix' },
  // Sealed wording inside the evaluation contract.
  'src/core/foundation.ts': { lines: 4, reason: 'sealed system prompt and suite titles, and the note saying so' },
  'src/core/catalog.ts': { lines: 2, reason: 'sealed system prompt, and the note saying so' },
  'src/core/file-store.ts': { lines: 1, reason: 'sealed store-manifest description' },
  'src/engine/reconciliation.ts': { lines: 1, reason: 'provenance citation of an external evidence file' },
  'test/engine/fixtures/pass06-captured.ts': { lines: 1, reason: 'captured model output quoting the sealed prompt' },
  // History that is still accurate.
  'README.md': { lines: 3, reason: '"Upgrading from Model Lab?" migration guidance' },
  'CONTRIBUTING.md': { lines: 1, reason: 'points contributors at this policy by naming the old product' },
  'scripts/releases/README.md': { lines: 5, reason: 'what the published install scripts do to the legacy folder' },
  'scripts/macos-smoke.sh': { lines: 1, reason: 'records why the name is read rather than typed' },
  'scripts/windows-smoke.ps1': { lines: 1, reason: 'records that the script used to look for the old name' },
  'test/e2e/settings-and-menu.spec.ts': { lines: 1, reason: 'explains that the legacy log is kept beside cernum.log' },
};

function repositoryFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return listed.split('\0').filter((file) => file.length > 0 && fs.existsSync(path.join(root, file)));
}

function legacyLineCount(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    let rest = line;
    for (const identifier of SEALED_IDENTIFIERS) rest = rest.replace(identifier, '');
    if (LEGACY.test(rest)) count += 1;
  }
  return count;
}

describe('no legacy branding outside the documented exceptions', () => {
  const found = new Map<string, number>();
  for (const file of repositoryFiles()) {
    if (SEALED_PATHS.some(({ pattern }) => pattern.test(file))) continue;
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue; // binary
    const lines = legacyLineCount(bytes.toString('utf8'));
    if (lines > 0) found.set(file, lines);
  }

  it('finds the old name only in allowlisted files', () => {
    const unexpected = [...found.keys()].filter((file) => !(file in ALLOWED));
    expect(unexpected, 'new "Model Lab" branding; the product is Cernum (docs/NAMING.md)').toEqual([]);
  });

  it('matches each allowlisted file exactly, so the list stays narrow and true', () => {
    const actual = Object.fromEntries(Object.keys(ALLOWED).map((file) => [file, found.get(file) ?? 0]));
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, { lines }]) => [file, lines]));
    expect(actual).toEqual(expected);
  });

  it('gives every exception a reason', () => {
    for (const { reason } of [...SEALED_PATHS, ...Object.values(ALLOWED)]) expect(reason.length).toBeGreaterThan(10);
  });
});

describe('the surfaces a person sees are named Cernum', () => {
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

  it('packages as Cernum', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string; productName: string };
    expect(pkg.productName).toBe('Cernum');
    expect(pkg.name).toBe('cernum');
    const builder = read('electron-builder.yml');
    expect(builder).toMatch(/^appId: org\.cernum\.desktop$/m);
    expect(builder).toMatch(/^productName: Cernum$/m);
    for (const [, name] of builder.matchAll(/artifactName: (\S+)/g)) expect(name).toMatch(/^(Cernum-|\$\{productName\}-)/);
    expect(builder).toMatch(/shortcutName: Cernum$/m);
    expect(builder).toMatch(/uninstallDisplayName: Cernum$/m);
    expect(builder).toMatch(/title: Cernum \$\{version\}$/m);
  });

  it('titles the window Cernum', () => {
    expect(read('src/renderer/index.html')).toContain('<title>Cernum</title>');
  });

  it('keeps the old name out of everything the renderer and the terminal command show', () => {
    const shown = repositoryFiles().filter((file) => /^src\/(renderer|cli)\//.test(file));
    expect(shown.length).toBeGreaterThan(10);
    for (const file of shown) expect(legacyLineCount(read(file)), file).toBe(0);
  });
});
