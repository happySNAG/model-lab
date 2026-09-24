// Cernum · the v0.2.1 regression suite: an installed OpenCode is reported as installed.
//
// WHAT v0.2.0 SHIPPED, AND WHY NO TEST CAUGHT IT. Two defects, one visible symptom.
//
//   1. `findExecutable` read `process.env.PATH` and stopped. A macOS application launched from
//      Finder, the Dock or `open` inherits `launchd`'s PATH -- `/usr/bin:/bin:/usr/sbin:/sbin` --
//      and reads no shell profile. OpenCode installs to `~/.opencode/bin` and puts that directory
//      in the profile, so the application could not see a CLI that was installed and authenticated.
//
//   2. `cernum discover opencodeCLI` answered "'opencodeCLI' is not a provider". The routing
//      decision was written out twice, and the terminal's copy had no OpenCode branch -- while the
//      same build's `cernum providers` listed OpenCode as a provider two commands earlier.
//
// Every existing OpenCode test passed throughout, because each one injected `findExecutable` and
// called `discoverOpenCodeCLI` directly: they tested the destination and never the route. So the
// tests here deliberately do NOT inject the lookup. They install a real executable in a real
// directory and let discovery find it the way it must find one on a real machine, and they go
// through `discoverProvider` -- the router both surfaces now share -- rather than around it.
//
// The fixtures are the bytes `opencode-ai@1.18.31` produced on the Mac mini on 2026-09-17, where
// `opencode models` listed 70 models including `opencode/union-alpha`.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverProvider, discoverOpenCodeCLI, DISCOVERABLE_PROVIDERS, isDiscoverableProvider,
  refuseToDiscover, selectableModels,
} from '../../src/engine/discovery';
import { overrideSystemExecutableDirectories } from '../../src/engine/cli-process';
import { UNION_ALPHA_MODEL_ID } from '../../src/engine/opencode-cli';
import { PROVIDER_IDS } from '../../src/engine/provider';

/** The PATH a macOS application inherits from `launchd`. Nothing a CLI installer wrote is on it. */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ESC = '\x1b';

/** `opencode providers list`, verbatim, colour escapes and box-drawing included. */
const CREDENTIALS = [
  `${ESC}[0m`,
  `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`,
  '│',
  `◗  OpenCode Zen ${ESC}[90mapi`,
  '│',
  '└  1 credentials',
].join('\n');

/** A faithful slice of the 70 lines `opencode models` printed, Union Alpha among them. */
const MODELS_WITH_UNION = [
  'opencode/big-pickle', 'opencode/claude-opus-5', 'opencode/gemini-3.1-pro',
  'opencode/gpt-5.6-terra', 'opencode/grok-4.6', 'opencode/union-alpha',
].join('\n');

/** The same listing on a day OpenCode does not carry Union Alpha. Nothing else differs. */
const MODELS_WITHOUT_UNION = MODELS_WITH_UNION.split('\n').filter((line) => !line.includes('union')).join('\n');

let home = '';
let environment: NodeJS.ProcessEnv;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };

/**
 * Write an executable that answers OpenCode's three read-only subcommands.
 *
 * A real file, spawned by the real `runCLI`, because the bug lived in the step between deciding
 * where to look and running what was found -- the one step a stubbed lookup skips.
 */
function installOpenCode(directory: string, options: { models: string; failOn?: string } = { models: MODELS_WITH_UNION }): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'opencode');
  // The fixtures go beside the script and are `cat`ed out byte for byte. Embedding them in the
  // script would put them through a shell quoting pass, and the colour escape that delimits the
  // credential kind is exactly the byte such a pass would eat.
  fs.writeFileSync(`${file}.credentials`, `${CREDENTIALS}\n`);
  fs.writeFileSync(`${file}.models`, `${options.models}\n`);
  const fail = options.failOn ?? '\u0000never';
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `if [ "$1" = "${fail}" ]; then echo "opencode: unable to reach the service" >&2; exit 1; fi`,
    'case "$1" in',
    '  --version) echo "1.18.31" ;;',
    `  providers) cat "$0.credentials" ;;`,
    `  models) cat "$0.models" ;;`,
    '  *) echo "usage: opencode"; exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-discovery-'));
  // The real lookup reads the real environment, so the environment is what the test controls.
  process.env.HOME = home;
  process.env.PATH = FINDER_PATH;
  // `/opt/homebrew/bin` and `/usr/local/bin` are absolute, so HOME cannot fence them off. Point
  // them at an empty directory of this test's own, or "nothing is installed" becomes a claim about
  // whichever Mac runs the suite -- and false on any that installed OpenCode through Homebrew.
  overrideSystemExecutableDirectories([path.join(home, 'system', 'bin')]);
  environment = process.env;
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
  overrideSystemExecutableDirectories();
  fs.rmSync(home, { recursive: true, force: true });
  void environment;
});

describe('v0.2.1 · an OpenCode the person installed is reported as installed', () => {
  it('finds, runs and reports an authenticated OpenCode under the PATH an app is launched with', async () => {
    // THE SHIPPED FAILURE, END TO END. Nothing is injected: this is the lookup, the spawn and the
    // three parsers, under the exact PATH that made v0.2.0 say `notInstalled`.
    const installed = installOpenCode(path.join(home, '.opencode', 'bin'));

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('ready');
    expect(status.executablePath).toBe(installed);
    expect(status.version).toBe('1.18.31');
    expect(status.probe).toBe('invoked');
    // Authenticated, in OpenCode's own words, and still not claimed to be valid or funded.
    expect(status.detail).toContain('OpenCode Zen');
    expect(status.detail).toContain('api');
    expect(status.detail).toContain('not a claim that it is valid');
  });

  it('reports Union Alpha as DISCOVERED and unproven — found, and not thereby permitted', async () => {
    installOpenCode(path.join(home, '.opencode', 'bin'));

    const status = await discoverProvider('opencodeCLI');
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID);

    expect(union).toBeDefined();
    expect(union!.availability).toBe('unproven');
    expect(union!.verifiedModelID).toBe('');
    expect(union!.evidence).toContain('DISCOVERED, NOT PROVEN');
    expect(selectableModels([status]).map((model) => model.modelID)).not.toContain(UNION_ALPHA_MODEL_ID);
    expect(status.detail).toContain(`${UNION_ALPHA_MODEL_ID} was DISCOVERED (unproven)`);
  });

  it('says NOT listed, and refuses to make it selectable, when OpenCode does not carry Union Alpha', async () => {
    // The opposite error to the shipped one, and the more dangerous of the two: a model reported as
    // available because it was planned would put an unavailable candidate into a scored campaign.
    installOpenCode(path.join(home, '.opencode', 'bin'), { models: MODELS_WITHOUT_UNION });

    const status = await discoverProvider('opencodeCLI');
    const union = status.models.find((model) => model.modelID === UNION_ALPHA_MODEL_ID);

    expect(status.reachability).toBe('ready');
    expect(union!.availability).toBe('refused');
    expect(union!.verifiedModelID).toBe('');
    expect(selectableModels([status]).map((model) => model.modelID)).not.toContain(UNION_ALPHA_MODEL_ID);
    expect(status.detail).toContain(`${UNION_ALPHA_MODEL_ID} was NOT named`);
  });

  it('finds an OpenCode installed somewhere non-default, and prints where it found it', async () => {
    // `~/.local/bin` is where most `curl | sh` installers put a binary, and a person who moved
    // OpenCode there has not made it uninstalled. The absolute path is reported either way, so a
    // find outside PATH is always visible as the unusual location it came from.
    const installed = installOpenCode(path.join(home, '.local', 'bin'));

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('ready');
    expect(status.executablePath).toBe(installed);
  });

  it('finds an OpenCode installed machine-wide, the way Homebrew installs one', async () => {
    const installed = installOpenCode(path.join(home, 'system', 'bin'));

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('ready');
    expect(status.executablePath).toBe(installed);
  });

  it('runs the copy on PATH when there is one, so a deliberate choice of build is honoured', async () => {
    const chosen = installOpenCode(path.join(home, 'chosen'));
    installOpenCode(path.join(home, '.opencode', 'bin'), { models: MODELS_WITHOUT_UNION });
    process.env.PATH = `${path.join(home, 'chosen')}:${FINDER_PATH}`;

    const status = await discoverProvider('opencodeCLI');

    expect(status.executablePath).toBe(chosen);
    expect(status.detail).toContain(`${UNION_ALPHA_MODEL_ID} was DISCOVERED (unproven)`);
  });

  it('still reports notInstalled when nothing is installed — the search widened, not the claim', async () => {
    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('notInstalled');
    expect(status.probe).toBe('offline');
    expect(status.models).toEqual([]);
    // And it no longer blames PATH for a search that is no longer only PATH.
    expect(status.detail).toContain('was not found on PATH, nor in the directories CLI installers write to');
  });
});

describe('v0.2.1 · a discovery command that fails is reported as unanswered, never as an absence', () => {
  it('reports unreachable when `opencode models` fails, and proves no model at all', async () => {
    installOpenCode(path.join(home, '.opencode', 'bin'), { models: MODELS_WITH_UNION, failOn: 'models' });

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('unreachable');
    expect(status.version).toBe('1.18.31');
    expect(status.models).toEqual([]);
    // The distinction this pins: a question that did not get an answer is not the answer "no".
    expect(status.reachability).not.toBe('notInstalled');
    expect(status.detail).toContain('did not answer');
  });

  it('reports unreachable when `opencode --version` fails, without going on to ask for models', async () => {
    installOpenCode(path.join(home, '.opencode', 'bin'), { models: MODELS_WITH_UNION, failOn: '--version' });

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('unreachable');
    expect(status.version).toBeUndefined();
    expect(status.models).toEqual([]);
  });

  it('records no version rather than recording an error line as one', async () => {
    const directory = path.join(home, '.opencode', 'bin');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'opencode'), '#!/bin/sh\necho "opencode: command not found"\n');
    fs.chmodSync(path.join(directory, 'opencode'), 0o755);

    const status = await discoverProvider('opencodeCLI');

    expect(status.reachability).toBe('unreachable');
    expect(status.version).toBeUndefined();
  });

  it('reports a spawn failure as unreachable rather than throwing out of a status read', async () => {
    // A file that exists, is executable, and cannot be run. Discovery is called from status views;
    // one that throws takes the whole view down with it.
    const directory = path.join(home, '.opencode', 'bin');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'opencode'), '\x7fELF not really\n');
    fs.chmodSync(path.join(directory, 'opencode'), 0o755);

    const status = await discoverOpenCodeCLI();

    expect(status.reachability).toBe('unreachable');
    expect(status.models).toEqual([]);
  });
});

describe('v0.2.1 · one router, so no surface can deny a provider another surface supports', () => {
  it('routes every provider that is not the local runtime', async () => {
    // THE SHAPE THAT CAUSED THE DEFECT, not just the instance of it. `cernum discover opencodeCLI`
    // failed because one of two hand-written copies of this decision was missing a branch. This
    // walks every declared provider, so a provider added later is routed or is caught here.
    for (const provider of PROVIDER_IDS) {
      if (provider === 'ollama') {
        expect(isDiscoverableProvider(provider)).toBe(false);
        continue;
      }
      expect(isDiscoverableProvider(provider)).toBe(true);
      expect(DISCOVERABLE_PROVIDERS).toContain(provider);
    }
    expect(DISCOVERABLE_PROVIDERS).toContain('opencodeCLI');
  });

  it('names OpenCode when it refuses something else, so the list a person is shown is the real one', () => {
    expect(refuseToDiscover('opencode')).toContain('opencodeCLI');
    expect(refuseToDiscover('nonsense')).toContain('opencodeCLI');
  });

  it('sends a person asking about the local runtime to the command that answers, not to a refusal', () => {
    expect(refuseToDiscover('ollama')).toContain('cernum models');
  });

  it('refuses an unknown provider by throwing, rather than discovering something else', async () => {
    await expect(discoverProvider('nonsense' as never)).rejects.toThrow('not a provider Cernum can discover');
  });
});

describe('v0.2.1 · `cernum discover opencodeCLI`, run as a person runs it', () => {
  // The defect was in the terminal, so the test is the terminal: the real command, in a real
  // process, under the PATH a shell that never sourced a profile would hand it. Calling the engine
  // in-process is what every OpenCode test already did, and it is how a whole broken surface passed
  // a full suite. Slow on purpose.
  //
  // The child's PATH is the launchd one PLUS the directory Node itself lives in, because the runner
  // has to be able to start `npx`. That addition cannot mask the defect: the executable under test
  // is installed in a temporary HOME, and no directory on this PATH contains it.
  const NODE_DIRECTORY = path.dirname(process.execPath);
  const cernum = (args: string[], environment: NodeJS.ProcessEnv) => {
    const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, ...environment, PATH: `${NODE_DIRECTORY}:${FINDER_PATH}` },
    });
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  it('discovers OpenCode and records Union Alpha unproven, instead of denying the provider exists', () => {
    installOpenCode(path.join(home, '.opencode', 'bin'));
    const root = path.join(home, 'campaigns');

    const result = cernum(['discover', 'opencodeCLI', '--root', root], { HOME: home });

    // v0.2.0 exited 1 here with "'opencodeCLI' is not a provider."
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('is not a provider');
    expect(result.output).toContain('[ready]');
    expect(result.output).toContain('1.18.31');
    expect(result.output).toContain(UNION_ALPHA_MODEL_ID);
    // The terminal answers, and what it records is "unproven" — the model was found, and finding it
    // is not permission to spend on it.
    expect(result.output).toContain('unproven');
    // The renderer wraps the detail sentence at 76 columns, so compare on collapsed whitespace
    // rather than on where the terminal happened to break the line.
    expect(result.output.replace(/\s+/g, ' ')).toContain('none of them proven');
    const store = fs.readFileSync(path.join(root, '.providers', 'discovered.json'), 'utf8');
    expect(store).toContain(UNION_ALPHA_MODEL_ID);
    const recorded = JSON.parse(store).models.find((model: { modelID: string }) => model.modelID === UNION_ALPHA_MODEL_ID);
    expect(recorded.availability).toBe('unproven');
    expect(recorded.verifiedModelID).toBe('');
    // Nothing OpenCode offers may be selected off the back of a discovery run.
    expect(JSON.parse(store).models
      .filter((model: { provider: string }) => model.provider === 'opencodeCLI')
      .some((model: { availability: string }) => model.availability === 'proven')).toBe(false);
  }, 120_000);

  it('offers OpenCode by name in the list `cernum providers` prints', () => {
    const result = cernum(['providers', '--root', path.join(home, 'campaigns')], { HOME: home });

    expect(result.status).toBe(0);
    // The line that told people which providers `discover` accepts used to omit the one that was
    // broken, so the command nobody could run was also the command nobody was told to run.
    expect(result.output).toContain('opencodeCLI');
  }, 120_000);

  it('refuses an unknown provider name before running anything, and lists the real ones', () => {
    const result = cernum(['discover', 'opencode', '--root', path.join(home, 'campaigns')], { HOME: home });

    expect(result.status).toBe(1);
    expect(result.output).toContain('opencodeCLI');
  }, 120_000);
});
