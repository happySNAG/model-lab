// WHERE THE MATRIX RUNNER'S DISPOSABLE TREES LIVE: under the OS temp directory, and the OS temp directory
// on the internal disk.
//
// Measured at bbadb36, test 21 of workspace-cell-selection.test.ts took 7.6-8.2 s with temp on the internal
// SSD and 24.6 s with temp on a USB volume. Every attempt copies a fixture, inits a Git baseline and writes
// a ledger, so the disk under the sandbox decides the runner's cost. This file pins two facts:
//   (a) the temp directory this process resolves is not on a mounted external volume (/Volumes/…), and
//   (b) the matrix runner's sandbox root, every attempt tree and every attempt's scratch directory, and the
//       campaign (record) root a test hands it, are created under os.tmpdir() — never under this worktree
//       or the fixture volume.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED: the one run below uses a scripted driver that starts
// no process. Every directory this file makes is removed by this file.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_SANDBOX_NAME, assertSandboxRootIsSafe, defaultWorkspaceSandboxRoot,
} from '../../src/engine/workspace-execution';
import { buildWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import { parseWorkspaceCellList } from '../../src/engine/workspace-cell-selection';
import { ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest } from '../../src/engine/workspace-agent';
import { WorkspaceMatrixRequest } from '../../src/engine/workspace-matrix';
import { collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { B, CHANGES_NOTHING, DISCOVERY, FIXTURE_ROOT, PACK, RUN_OPTIONS, repositoryRoot, request } from './workspace-continuation-harness';

const ownTemporaries: string[] = [];
afterEach(() => { for (const directory of ownTemporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function ownTemporary(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  ownTemporaries.push(directory);
  return directory;
}

const realTmp = (): string => fs.realpathSync(os.tmpdir());
const isInside = (outer: string, inner: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
/** realpath of the deepest existing ancestor, joined with the rest — for a path that may not exist yet. */
function realOrResolved(candidate: string): string {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, absolute));
}
const realRepository = (): string => fs.realpathSync(repositoryRoot);
const realFixtures = (): string => fs.realpathSync(FIXTURE_ROOT);

function expectUnderTmpOnly(directory: string, what: string): void {
  const real = realOrResolved(directory);
  expect(isInside(realTmp(), real), `${what} ${real} is under ${realTmp()}`).toBe(true);
  expect(isInside(realRepository(), real), `${what} ${real} is not under the worktree`).toBe(false);
  expect(isInside(realFixtures(), real), `${what} ${real} is not under the fixture root`).toBe(false);
  expect(real.startsWith('/Volumes/'), `${what} ${real} is not on a /Volumes/ mount`).toBe(false);
}

describe('the matrix runner\'s temp location', () => {
  it('(a) the OS temp directory this process resolves is not on a /Volumes/ mount', () => {
    const resolved = realTmp();
    expect(resolved.startsWith('/Volumes/'), `fs.realpathSync(os.tmpdir()) is ${resolved}`).toBe(false);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('(b) the default sandbox root derives from os.tmpdir(), outside the worktree and the fixture volume, and is a sandbox the engine accepts', () => {
    const root = defaultWorkspaceSandboxRoot();
    expect(root).toBe(path.join(os.tmpdir(), DEFAULT_WORKSPACE_SANDBOX_NAME));
    expectUnderTmpOnly(root, 'the default sandbox root');
    // Accepted by the runner's own refusal check (not inside a Git working tree, not overlapping fixtures).
    // Called on the path as named; nothing is created.
    expect(() => assertSandboxRootIsSafe(root, FIXTURE_ROOT)).not.toThrow();
    // And the engine refuses the worktree itself, so a sandbox can never silently land there.
    expect(() => assertSandboxRootIsSafe(repositoryRoot, FIXTURE_ROOT)).toThrow();
  });

  it('(b) a matrix run creates its attempt trees and scratch directories under the sandbox, and its records under the campaign root, all under os.tmpdir()', async () => {
    const campaignRoot = ownTemporary('cernum-tmploc-campaign-');
    const sandboxRoot = ownTemporary('cernum-tmploc-sandbox-');
    const seen: { workspaceRoot: string; temporaryDirectory: string }[] = [];
    const driverFactory: NonNullable<WorkspaceMatrixRequest['driverFactory']> = (binding) => {
      if (binding.provider !== 'claudeCLI') return undefined;
      const driver: WorkspaceAgentDriver = {
        driverID: 'driver.scripted.claude',
        provider: 'claudeCLI',
        capabilities: new ScriptedWorkspaceAgent([]).capabilities,
        async run(agentRequest: WorkspaceAgentRequest) {
          // The attempt's scratch directory reaches the agent as its TMPDIR (the runner's `scratchRoot`).
          seen.push({ workspaceRoot: agentRequest.workspaceRoot, temporaryDirectory: agentRequest.environment.TMPDIR });
          expect(fs.existsSync(agentRequest.workspaceRoot)).toBe(true);
          expect(typeof agentRequest.environment.TMPDIR).toBe('string');
          expect(fs.existsSync(agentRequest.environment.TMPDIR)).toBe(true);
          const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(agentRequest);
          return { ...result, reportedModelID: binding.requestedModelID };
        },
      };
      return driver;
    };
    const matrix = request({
      campaignRoot, sandboxRoot, runLabel: 'tmploc-test', provider: 'claudeCLI', effort: 'none',
      modelIDs: ['claude-haiku-4-5'], driverFactory, discovery: DISCOVERY,
      cellSelection: { mode: 'explicit', selectors: parseWorkspaceCellList(`${B}@1`, PACK.caseIDs) },
    });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.runnableRunCount).toBe(1);
    expectUnderTmpOnly(plan.sandboxRoot, 'the plan\'s sandbox root');
    const result = await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
    expect(result.executedRunCount).toBe(1);

    expect(seen.length).toBeGreaterThan(0);
    for (const { workspaceRoot, temporaryDirectory } of seen) {
      expect(isInside(sandboxRoot, workspaceRoot), `attempt tree ${workspaceRoot} is under the sandbox`).toBe(true);
      expect(isInside(sandboxRoot, temporaryDirectory), `scratch ${temporaryDirectory} is under the sandbox`).toBe(true);
      expectUnderTmpOnly(workspaceRoot, 'the attempt tree');
      expectUnderTmpOnly(temporaryDirectory, 'the attempt scratch directory');
    }
    const records = collectWorkspaceRunRows(campaignRoot);
    expect(records).toHaveLength(1);
    for (const { recordRoot } of records) {
      expect(isInside(campaignRoot, fs.realpathSync(recordRoot))).toBe(true);
      expectUnderTmpOnly(recordRoot, 'the record root');
    }
    // The runner removes its passing attempt trees itself; nothing is left in the sandbox to clean.
    expect(fs.readdirSync(sandboxRoot)).toEqual([]);
  });
});
